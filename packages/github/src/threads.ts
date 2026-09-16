import { canonicalJson, digest } from '@repo-chap/workflow';
import type { PullRequestWriteCredentials } from './auth.js';
import { GitHubReader, object } from './client.js';
import { GitHubReadError } from './errors.js';
import { responseText } from './http.js';
import type { CommentEvidence, ThreadEvidence } from './inspect.js';
import { validatePushRequest, type PushReceipt, type PushRequest } from './push.js';

export interface ThreadResolutionRequest {
  schemaVersion: 1; pushEffectId: string; push: PushRequest; threadId: string; threadDigest: string;
  disposition: 'addressed' | 'declined' | 'blocked';
}
export interface ThreadTarget {
  repositoryId: string; repository: string; pullRequestId: string; number: number; headRepositoryId: string | null;
  headSha: string; baseSha: string; headRef: string; lifecycle: string; draft: boolean;
  thread: ThreadEvidence; canResolve: boolean;
}
export interface ThreadReceipt {
  status: 'confirmed' | 'rejected' | 'unknown'; threadId: string; candidateSha: string;
  remoteResolved: boolean | null; evidenceCurrent: boolean | null; observedHeadSha: string | null; observedThreadDigest: string | null;
  reason: string; retryable: boolean; reconcileAfter?: number;
}
export interface ThreadTransport {
  repository: string;
  resolve(threadId: string, beforeSend: () => Promise<boolean>): Promise<'accepted' | 'unknown'>;
}
// GitHub moves locations and marks threads outdated after a push. Neither changes the concern.
export function threadContentDigest(thread: ThreadEvidence): string {
  if (thread.comments.coverage.status !== 'complete' || !thread.comments.items.length ||
    new Set(thread.comments.items.map(comment => comment.id)).size !== thread.comments.items.length) throw new GitHubReadError('invalid_response');
  return digest(canonicalJson({ id: thread.id, path: thread.path, comments: thread.comments.items.map(comment => ({ ...comment, createdAt: new Date(comment.createdAt).toISOString() })) }));
}
function validRequest(request: ThreadResolutionRequest, push: PushReceipt): boolean {
  try { validatePushRequest(request.push); } catch { return false; }
  return request.schemaVersion === 1 && !!request.pushEffectId && !!request.threadId && /^sha256:[a-f0-9]{64}$/.test(request.threadDigest) &&
    request.disposition === 'addressed' && push.status === 'confirmed' && push.repository.toLowerCase() === request.push.repository.toLowerCase() &&
    push.targetRef === request.push.targetRef && push.expectedHeadSha === request.push.expectedHeadSha &&
    push.candidateSha === request.push.candidateSha && push.observedSha === request.push.candidateSha;
}
function sameIdentity(request: ThreadResolutionRequest, target: ThreadTarget): boolean {
  const push = request.push;
  return target.repositoryId === push.repositoryId && target.repository.toLowerCase() === push.repository.toLowerCase() &&
    target.pullRequestId === push.pullRequestId && target.number === push.number && target.thread.id === request.threadId;
}
function current(request: ThreadResolutionRequest, target: ThreadTarget): boolean {
  const push = request.push;
  return sameIdentity(request, target) && target.headRepositoryId === push.repositoryId &&
    target.headSha === push.candidateSha && target.baseSha === push.baseSha && target.headRef === push.targetRef &&
    target.lifecycle === 'open' && target.draft === false && target.thread.id === request.threadId && threadContentDigest(target.thread) === request.threadDigest;
}
const receipt = (request: ThreadResolutionRequest, status: ThreadReceipt['status'], reason: string, target?: ThreadTarget, evidenceCurrent: boolean | null = null, retryable = false): ThreadReceipt =>
  ({ status, threadId: request.threadId, candidateSha: request.push.candidateSha, remoteResolved: target?.thread.resolved ?? null,
    evidenceCurrent, observedHeadSha: target?.headSha ?? null, observedThreadDigest: target ? threadContentDigest(target.thread) : null, reason, retryable });

export async function resolveThread(request: ThreadResolutionRequest, options: {
  pushReceipt: PushReceipt; transport: ThreadTransport; readTarget: () => Promise<ThreadTarget>; authorize: () => boolean | Promise<boolean>;
}): Promise<ThreadReceipt> {
  request = structuredClone(request);
  if (!validRequest(request, options.pushReceipt) || options.transport.repository.toLowerCase() !== request.push.repository.toLowerCase())
    return receipt(request, 'rejected', 'Only an addressed concern with its matching confirmed tested push can be resolved.');
  let sending = false, before: ThreadReceipt | undefined;
  try {
    await options.transport.resolve(request.threadId, async () => {
      const target = await options.readTarget();
      if (!current(request, target)) { before = receipt(request, 'rejected', 'The PR head, thread identity or concern changed. No resolution was sent.', target, false); return false; }
      let authorized = false;
      try { authorized = await options.authorize(); } catch { /* Missing or unreadable authority does not authorize a write. */ }
      if (!authorized) { before = receipt(request, 'rejected', 'Ownership or current policy no longer permits thread resolution. No resolution was sent.', target, true); return false; }
      if (target.thread.resolved) { before = receipt(request, 'confirmed', 'The unchanged thread is already resolved. No resolution was sent.', target, true); return false; }
      if (!target.canResolve) { before = receipt(request, 'rejected', 'GitHub does not permit this account to resolve the thread. No resolution was sent.', target, true); return false; }
      sending = true; return true;
    });
  } catch { /* Once sent, a transport failure cannot prove the remote outcome. */ }
  if (before) return before;
  if (!sending) return receipt(request, 'rejected', 'Cannot obtain credentials or read current thread evidence. No resolution was sent; retry can reuse the retained repair.', undefined, null, true);
  return reconcileThread(request, options.readTarget);
}

export async function reconcileThread(request: ThreadResolutionRequest, readTarget: () => Promise<ThreadTarget>): Promise<ThreadReceipt> {
  try {
    const target = await readTarget(), unchanged = current(request, target);
    if (!sameIdentity(request, target)) return receipt(request, 'unknown', 'The returned thread does not belong to the retained request. Inspect identity before any further resolution.');
    if (target.thread.resolved) return receipt(request, 'confirmed', unchanged ? 'The unchanged thread is resolved on the confirmed pushed commit.' :
      'The thread is now resolved, but the PR head or concern changed. Inspect the new concern; this receipt does not confirm that it was addressed.', target, unchanged);
    return receipt(request, 'unknown', unchanged ? 'The thread is open after an uncertain send. The request may still complete or the thread may have been reopened. No duplicate resolution was sent.' :
      'The PR head or concern changed after an uncertain send. The current thread remains open; inspect before any further resolution.', target, unchanged);
  } catch { return receipt(request, 'unknown', 'Cannot read the current thread. The remote result remains unknown; no duplicate resolution was sent.'); }
}

const text = (value: unknown): string => { if (typeof value !== 'string' || !value) throw new GitHubReadError('invalid_response'); return value; };
const bool = (value: unknown): boolean => { if (typeof value !== 'boolean') throw new GitHubReadError('invalid_response'); return value; };
export async function readThreadTarget(reader: GitHubReader, threadId: string): Promise<ThreadTarget> {
  const comments: CommentEvidence[] = [], cursors = new Set<string>(); let cursor: string | null = null, initial: ThreadTarget | undefined, count = 0;
  for (let page = 0; page < 100; page++) {
    const response = await reader.query(`query ThreadTarget($id:ID!, $cursor:String) {
      node(id:$id) { ... on PullRequestReviewThread { id isResolved isOutdated path line viewerCanResolve
        pullRequest { id number state isDraft headRefOid baseRefOid headRefName repository { id nameWithOwner } headRepository { id } }
        comments(first:100,after:$cursor) { totalCount pageInfo { hasNextPage endCursor } nodes { id author { login } body createdAt commit { oid } } }
      } }
    }`, { id: threadId, cursor });
    if (response.incomplete) throw new GitHubReadError('graphql');
    const thread = object(object(response.data).node), pr = object(thread.pullRequest), repo = object(pr.repository), connection = object(thread.comments);
    if (thread.id !== threadId || !Number.isSafeInteger(pr.number) || !Number.isSafeInteger(connection.totalCount) || !Array.isArray(connection.nodes) ||
      thread.line !== null && !Number.isSafeInteger(thread.line) || !['OPEN', 'CLOSED', 'MERGED'].includes(String(pr.state)) ||
      !/^[a-f0-9]{40}$/.test(String(pr.headRefOid)) || !/^[a-f0-9]{40}$/.test(String(pr.baseRefOid))) throw new GitHubReadError('invalid_response');
    const target: ThreadTarget = { repositoryId: text(repo.id), repository: text(repo.nameWithOwner), pullRequestId: text(pr.id), number: Number(pr.number),
      headRepositoryId: pr.headRepository === null ? null : text(object(pr.headRepository).id), headSha: text(pr.headRefOid), baseSha: text(pr.baseRefOid),
      headRef: `refs/heads/${text(pr.headRefName)}`, lifecycle: String(pr.state).toLowerCase(), draft: bool(pr.isDraft), canResolve: bool(thread.viewerCanResolve),
      thread: { id: text(thread.id), resolved: bool(thread.isResolved), outdated: bool(thread.isOutdated), path: text(thread.path), line: thread.line as number | null,
        comments: { items: [], coverage: { status: 'complete', pages: 0 } } } };
    if (initial && canonicalJson(initial) !== canonicalJson(target) || initial && count !== connection.totalCount) throw new GitHubReadError('changed');
    initial = target; count = Number(connection.totalCount);
    for (const value of connection.nodes) {
      const comment = object(value);
      if (typeof comment.body !== 'string' || !Number.isFinite(Date.parse(String(comment.createdAt)))) throw new GitHubReadError('invalid_response');
      const headSha = comment.commit === null ? null : text(object(comment.commit).oid);
      if (headSha !== null && !/^[a-f0-9]{40}$/.test(headSha)) throw new GitHubReadError('invalid_response');
      comments.push({ id: text(comment.id), author: comment.author === null ? null : text(object(comment.author).login), body: comment.body,
        createdAt: new Date(String(comment.createdAt)).toISOString(), headSha });
    }
    const info = object(connection.pageInfo);
    if (!bool(info.hasNextPage)) {
      if (comments.length !== count) throw new GitHubReadError('changed');
      target.thread.comments = { items: comments, coverage: { status: 'complete', pages: page + 1 } }; threadContentDigest(target.thread); return target;
    }
    cursor = text(info.endCursor); if (cursors.has(cursor)) throw new GitHubReadError('invalid_response'); cursors.add(cursor);
  }
  throw new GitHubReadError('limit');
}

export function githubThreadTransport(repository: string, credentials: PullRequestWriteCredentials, options: {
  fetch?: typeof globalThis.fetch; signal?: AbortSignal; now?: () => number; cooldown?: { read(): number; extend(until: number): void };
} = {}): ThreadTransport {
  if (credentials.permission !== 'pull_requests:write' || credentials.repository.toLowerCase() !== repository.toLowerCase()) throw new GitHubReadError('credentials');
  return { repository, async resolve(threadId, beforeSend) {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    const token = await credentials.token(signal), now = options.now ?? Date.now;
    if (signal.aborted || (options.cooldown?.read() ?? 0) > now() || !await beforeSend() || signal.aborted) return 'unknown';
    const response = await (options.fetch ?? globalThis.fetch)('https://api.github.com/graphql', {
      method: 'POST', redirect: 'error', signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'mutation ResolveThread($id:ID!) { resolveReviewThread(input:{threadId:$id}) { thread { id isResolved } } }', variables: { id: threadId } }),
    });
    const guide = response.headers.get('retry-after'), reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    if (response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0' || guide !== null) {
      const retry = guide && /^\d+$/.test(guide) ? now() + Number(guide) * 1000 : Date.parse(guide ?? '');
      options.cooldown?.extend(Math.max(now() + 60_000, Number.isFinite(retry) ? retry : 0, Number.isFinite(reset) ? reset + 1000 : 0));
    }
    const body = object(JSON.parse(await responseText(response, 65_536)));
    if (!response.ok || body.errors) return 'unknown';
    const thread = object(object(object(body.data).resolveReviewThread).thread);
    return thread.id === threadId && thread.isResolved === true ? 'accepted' : 'unknown';
  } };
}
