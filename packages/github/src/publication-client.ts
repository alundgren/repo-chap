import type { CredentialSource, PublicationCapability, PublicationCredentials } from './auth.js';
import { responseText } from './http.js';
import { validateTarget } from './inspect.js';
import { PublicationRemoteError, type BeforePublicationSend, type PublicationRemote, type PublicationTarget, type PublishedReview, type RemotePublicationTarget, type ReviewPublication } from './publication.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid GitHub publication response.');
  return value as Record<string, unknown>;
}
function string(value: unknown): string { if (typeof value !== 'string' || !value) throw new Error('Invalid GitHub publication response.'); return value; }
function sha(value: unknown): string { const text = string(value); if (!/^[a-f0-9]{40}$/.test(text)) throw new Error('Invalid Git revision.'); return text; }
function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Invalid label response.');
  const names = value.map(item => string(object(item).name));
  if (new Set(names).size !== names.length) throw new Error('Duplicate remote labels.');
  return names;
}
function review(value: unknown, target: PublicationTarget): PublishedReview {
  const data = object(value), id = data.id, url = string(data.html_url), body = data.body;
  if (!Number.isSafeInteger(id) || Number(id) <= 0 || typeof body !== 'string' ||
    !url.startsWith(`https://github.com/${target.repository}/pull/${target.number}#`)) throw new Error('Invalid review identity.');
  return { id: String(id), url, headSha: sha(data.commit_id), body, state: string(data.state) };
}
export interface PublicationClientOptions {
  fetch?: typeof globalThis.fetch; signal?: AbortSignal; now?: () => number;
  maxRequests?: number; maxDurationMs?: number;
  cooldown?: { read(): number; extend(until: number): void };
  writeCredentials?: (repository: string, capability: PublicationCapability) => Promise<PublicationCredentials>;
}
/** Named operations only. The dispatcher owns authorization and durable send records. */
export class GitHubPublicationClient implements PublicationRemote {
  private requests = 0;
  private bytes = 0;
  private readonly deadline: number;
  private readonly now: () => number;
  constructor(private readonly credentials: CredentialSource, private readonly options: PublicationClientOptions = {}) {
    this.now = options.now ?? Date.now;
    const duration = options.maxDurationMs ?? 120_000, requests = options.maxRequests ?? 200;
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 300_000 || !Number.isSafeInteger(requests) || requests < 1 || requests > 1000) throw new Error('Invalid publication request limits.');
    this.deadline = this.now() + duration;
  }
  private path(target: PublicationTarget): string {
    validateTarget(target.repository, target.number);
    return `/repos/${target.repository}`;
  }
  private check(): void {
    if (this.options.signal?.aborted || this.now() >= this.deadline || this.requests >= (this.options.maxRequests ?? 200) || this.bytes >= 16 * 1024 * 1024)
      throw new PublicationRemoteError('rejected', 'The publication request limit or deadline was reached.', true);
    if ((this.options.cooldown?.read() ?? 0) > this.now()) throw new PublicationRemoteError('rejected', 'GitHub requests are waiting for the installation cooldown.', true);
  }
  private async request(method: 'GET' | 'POST', path: string, body?: unknown,
    write?: { target: PublicationTarget; capability: PublicationCapability; beforeSend: BeforePublicationSend }, readCredentials?: CredentialSource): Promise<unknown> {
    this.check();
    const signal = this.options.signal ? AbortSignal.any([this.options.signal, AbortSignal.timeout(Math.max(1, this.deadline - this.now()))]) : AbortSignal.timeout(Math.max(1, this.deadline - this.now()));
    let dispatched = false;
    try {
      let credentials = readCredentials ?? this.credentials;
      if (method === 'POST') {
        if (!write || !this.options.writeCredentials) throw new PublicationRemoteError('rejected', 'Publication requires explicit write credentials for this capability.', true);
        const scoped = await this.options.writeCredentials(write.target.repository, write.capability);
        if (scoped.repository.toLowerCase() !== write.target.repository.toLowerCase() || scoped.capability !== write.capability ||
          scoped.permission !== (write.capability === 'review.publish' ? 'pull_requests:write' : 'issues:write')) throw new PublicationRemoteError('rejected', 'Publication credentials do not match this repository and capability.', true);
        credentials = scoped;
      }
      const token = await credentials.token(signal); this.check();
      if (write && !await write.beforeSend(() => this.targetUsing(write.target, { ...credentials, token: async () => token })))
        throw new PublicationRemoteError('rejected', 'Publication no longer has current permission or ownership.', true);
      this.check();
      this.requests++; dispatched = true;
      const response = await (this.options.fetch ?? globalThis.fetch)(`https://api.github.com${path}`, {
        method, redirect: 'error', signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const retry = response.headers.get('retry-after'), remaining = response.headers.get('x-ratelimit-remaining');
      if (response.status === 429 || remaining === '0' || retry !== null) {
        const guidance = retry && /^\d+(\.\d+)?$/.test(retry) ? this.now() + Number(retry) * 1000 : Date.parse(retry ?? '');
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        this.options.cooldown?.extend(Math.max(this.now() + 60_000, Number.isFinite(guidance) ? guidance : 0, Number.isFinite(reset) ? reset + 1000 : 0));
      }
      if (!response.ok) {
        await response.body?.cancel();
        const known = [400, 401, 403, 404, 405, 409, 422, 429].includes(response.status);
        throw new PublicationRemoteError(known ? 'rejected' : 'unknown', known
          ? 'GitHub rejected the publication request. Check permissions, configured labels, and rate guidance.'
          : 'GitHub did not confirm the publication request. Reconcile before any retry.', [401, 403, 429].includes(response.status));
      }
      const text = await responseText(response, 2 * 1024 * 1024); this.bytes += Buffer.byteLength(text);
      if (this.bytes > 16 * 1024 * 1024) throw new Error('Publication response limit exceeded.');
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof PublicationRemoteError) throw error;
      throw new PublicationRemoteError(method === 'POST' && dispatched ? 'unknown' : 'rejected', 'GitHub publication communication failed. Refresh evidence and reconcile any uncertain request.', !dispatched);
    }
  }
  private async pages(path: string): Promise<unknown[]> {
    const values: unknown[] = [];
    for (let page = 1; page <= 100; page++) {
      const data = await this.request('GET', `${path}?per_page=100&page=${page}`);
      if (!Array.isArray(data) || data.length > 100) throw new Error('Invalid GitHub publication page.');
      values.push(...data);
      if (data.length < 100) return values;
    }
    throw new Error('GitHub publication pagination limit reached.');
  }
  async target(target: PublicationTarget): Promise<RemotePublicationTarget> {
    return this.targetUsing(target, this.credentials);
  }
  private async targetUsing(target: PublicationTarget, credentials: CredentialSource): Promise<RemotePublicationTarget> {
    const data = object(await this.request('GET', `${this.path(target)}/pulls/${target.number}`, undefined, undefined, credentials));
    const head = object(data.head), base = object(data.base), repository = object(base.repo);
    if (data.number !== target.number || typeof data.draft !== 'boolean' || !['open', 'closed'].includes(String(data.state))) throw new Error('Invalid pull request publication target.');
    return { repository: string(repository.full_name), repositoryId: string(repository.node_id), pullRequestId: string(data.node_id), number: data.number as number,
      headSha: sha(head.sha), baseSha: sha(base.sha), lifecycle: data.state as 'open' | 'closed', draft: data.draft };
  }
  async reviews(target: PublicationTarget): Promise<PublishedReview[]> {
    return (await this.pages(`${this.path(target)}/pulls/${target.number}/reviews`)).map(value => review(value, target));
  }
  async labels(target: PublicationTarget): Promise<string[]> {
    return labelNames(await this.pages(`${this.path(target)}/issues/${target.number}/labels`));
  }
  async publishReview(publication: ReviewPublication, beforeSend: BeforePublicationSend): Promise<PublishedReview> {
    const data = await this.request('POST', `${this.path(publication.target)}/pulls/${publication.target.number}/reviews`,
      { commit_id: publication.target.headSha, event: 'COMMENT', body: publication.body }, { target: publication.target, capability: 'review.publish', beforeSend });
    try { return review(data, publication.target); }
    catch { throw new PublicationRemoteError('unknown', 'GitHub accepted the review request but returned an unreadable receipt. Reconcile its marker.'); }
  }
  async addLabels(target: PublicationTarget, labels: string[], beforeSend: BeforePublicationSend): Promise<string[]> {
    const data = await this.request('POST', `${this.path(target)}/issues/${target.number}/labels`, { labels }, { target, capability: 'labels.set', beforeSend });
    try { return labelNames(data); }
    catch { throw new PublicationRemoteError('unknown', 'GitHub accepted the label request but returned an unreadable receipt. Reconcile the requested labels.'); }
  }
}
