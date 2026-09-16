import { setTimeout as sleep } from 'node:timers/promises';
import type { CredentialSource } from './auth.js';
import { GitHubReadError } from './errors.js';
import { responseText } from './http.js';

export interface ReadOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  maxRequests?: number;
  maxDurationMs?: number;
  maxResponseBytes?: number;
  cooldown?: { read(): number; extend(until: number): void };
}
export interface QueryResult { data: unknown; incomplete: boolean }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GitHubReadError('invalid_response');
  return value as Record<string, unknown>;
}
export class GitHubReader {
  readonly credentials: CredentialSource;
  readonly now: () => number;
  readonly signal?: AbortSignal;
  private readonly options: Required<Pick<ReadOptions, 'maxRequests' | 'maxDurationMs' | 'maxResponseBytes'>> & ReadOptions;
  private readonly deadline: number;
  private requests = 0;
  private bytes = 0;
  private retryAt = 0;
  private rateLimited = true;
  get nextRequestAt(): number { return this.retryAt; }
  constructor(credentials: CredentialSource, options: ReadOptions = {}) {
    this.credentials = credentials; this.now = options.now ?? Date.now; this.signal = options.signal;
    this.options = { ...options, maxRequests: options.maxRequests ?? 200, maxDurationMs: options.maxDurationMs ?? 120_000, maxResponseBytes: options.maxResponseBytes ?? 2_097_152 };
    for (const [value, max] of [[this.options.maxRequests, 1000], [this.options.maxDurationMs, 300_000], [this.options.maxResponseBytes, 8_388_608]])
      if (!Number.isSafeInteger(value) || value! < 1 || value! > max!) throw new GitHubReadError('limit');
    this.deadline = this.now() + this.options.maxDurationMs;
  }
  private check(): void {
    if (this.signal?.aborted) throw new GitHubReadError('cancelled');
    if (this.now() >= this.deadline) throw new GitHubReadError('timeout');
    if (this.requests >= this.options.maxRequests) throw new GitHubReadError('limit');
    if (this.bytes >= 16 * 1024 * 1024) throw new GitHubReadError('limit');
  }
  private async pause(until: number, rateLimited: boolean): Promise<void> {
    for (;;) {
      this.check();
      const shared = this.options.cooldown?.read() ?? 0;
      if (shared > until) { until = shared; rateLimited = true; }
      const delay = Math.max(0, until - this.now());
      if (until >= this.deadline) throw new GitHubReadError(rateLimited ? 'rate_limit' : 'timeout', new Date(until).toISOString());
      if (delay) {
        try { await (this.options.sleep ?? ((ms, signal) => sleep(ms, undefined, { signal })))(delay, this.signal); }
        catch { throw new GitHubReadError(this.signal?.aborted ? 'cancelled' : 'timeout'); }
      }
      this.check();
      if ((this.options.cooldown?.read() ?? 0) <= until) return;
    }
  }
  async query(query: string, variables: Record<string, unknown>): Promise<QueryResult> {
    if (!/^query\s/.test(query)) throw new GitHubReadError('invalid_response');
    let refreshed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      this.check(); await this.pause(Math.max(this.retryAt, this.options.cooldown?.read() ?? 0), this.rateLimited);
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(15_000, this.deadline - this.now())));
      const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
      try {
        const token = await this.credentials.token(signal); this.check();
        // New guidance during credential lookup must wait without consuming a request attempt.
        if (Math.max(this.retryAt, this.options.cooldown?.read() ?? 0) > this.now()) { attempt--; continue; }
        this.requests++;
        const response = await (this.options.fetch ?? globalThis.fetch)('https://api.github.com/graphql', {
          method: 'POST', redirect: 'error', signal,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables }),
        });
        if (response.status === 401 && this.credentials.invalidate && !refreshed) {
          await response.body?.cancel(); this.credentials.invalidate(); refreshed = true; continue;
        }
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        const remaining = response.headers.get('x-ratelimit-remaining');
        const guidance = response.headers.get('retry-after');
        const guidedTime = guidance == null ? 0 : /^\d+(\.\d+)?$/.test(guidance) ? this.now() + Number(guidance) * 1000 : Date.parse(guidance);
        const primaryLimit = remaining === '0';
        const text = await responseText(response, this.options.maxResponseBytes);
        this.bytes += Buffer.byteLength(text);
        if (this.bytes > 16 * 1024 * 1024) throw new GitHubReadError('limit');
        let body: Record<string, unknown> = {};
        try { body = object(JSON.parse(text)); } catch { if (response.ok) throw new GitHubReadError('invalid_response'); }
        const errors = Array.isArray(body.errors) ? body.errors : [];
        const graphRate = errors.some(e => object(e).type === 'RATE_LIMITED');
        const limited = response.status === 429 || graphRate || response.status === 403 && (primaryLimit || guidance != null || /rate limit/i.test(String(body.message)));
        if (primaryLimit || limited) {
          this.rateLimited = true;
          this.retryAt = Math.max(this.retryAt, Number.isFinite(guidedTime) ? guidedTime : 0,
            primaryLimit && Number.isFinite(reset) ? reset + 1000 : 0, this.now() + (limited && !guidance && !primaryLimit ? 60_000 * 2 ** attempt : 1000));
          this.options.cooldown?.extend(this.retryAt);
        }
        if (limited) {
          if (body.data != null) return { data: body.data, incomplete: true };
          if (attempt === 2) throw new GitHubReadError('rate_limit', new Date(this.retryAt).toISOString());
          await this.pause(this.retryAt, true); continue;
        }
        if (response.status === 401) throw new GitHubReadError('credentials');
        if (response.status === 403 || response.status === 404) throw new GitHubReadError('access');
        if (response.status >= 500) {
          if (Number.isFinite(guidedTime) && guidedTime > this.now()) {
            if (guidedTime > this.retryAt) { this.retryAt = guidedTime; this.rateLimited = false; }
            this.options.cooldown?.extend(this.retryAt);
            await this.pause(this.retryAt, this.rateLimited);
          }
          throw new GitHubReadError('network');
        }
        if (!response.ok) throw new GitHubReadError('invalid_response');
        return { data: body.data, incomplete: errors.length > 0 };
      } catch (error) {
        if (this.signal?.aborted) throw new GitHubReadError('cancelled');
        if (timeout.aborted) throw new GitHubReadError('timeout');
        if (error instanceof GitHubReadError && error.failure.code !== 'network') throw error;
        if (attempt === 2) throw new GitHubReadError('network');
        await this.pause(this.now() + 500 * 2 ** attempt, false);
      }
    }
    throw new GitHubReadError('credentials');
  }
}
