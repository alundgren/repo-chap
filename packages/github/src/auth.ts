import { execFile } from 'node:child_process';
import { sign } from 'node:crypto';
import { promisify } from 'node:util';
import { GitHubReadError } from './errors.js';
import { responseText } from './http.js';

export interface CredentialSource {
  token(signal?: AbortSignal): Promise<string>;
  invalidate?(): void;
  redact(text: string): string;
}
function secrets() {
  const values = new Set<string>();
  return {
    add(value: string): string { if (value) values.add(value); return value; },
    redact(text: string): string {
      for (const value of values) text = text.split(value).join('[redacted]');
      return text;
    },
  };
}
export function tokenCredentials(token: string): CredentialSource {
  if (!token.trim() || /\s/.test(token)) throw new GitHubReadError('credentials');
  const vault = secrets(); vault.add(token);
  return { token: async () => token, redact: vault.redact };
}
export async function localCredentials(options: {
  env?: NodeJS.ProcessEnv;
  runGh?: () => Promise<string>;
} = {}): Promise<CredentialSource> {
  const env = options.env ?? process.env;
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (token) return tokenCredentials(token);
  try {
    const text = await (options.runGh ?? (async () => (await promisify(execFile)('gh',
      ['auth', 'token', '--hostname', 'github.com'], { env, timeout: 10_000, maxBuffer: 16_384, encoding: 'utf8' })).stdout))();
    return tokenCredentials(text.trim());
  } catch { throw new GitHubReadError('credentials'); }
}

export interface InstallationOptions {
  appId: string;
  installationId: number;
  privateKey: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}
export interface PushCredentials extends CredentialSource { repository: string; permission: 'contents:write' }
export interface PullRequestWriteCredentials extends CredentialSource { repository: string; permission: 'pull_requests:write' }
export async function localPullRequestWriteCredentials(repository: string, options: Parameters<typeof localCredentials>[0] = {}): Promise<PullRequestWriteCredentials> {
  validateRepository(repository);
  return { ...await localCredentials(options), repository, permission: 'pull_requests:write' };
}
export function installationPullRequestWriteCredentials(options: InstallationOptions, repository: string): PullRequestWriteCredentials {
  validateRepository(repository);
  return { ...installationToken(options, { contents: 'read', pull_requests: 'write' }, [repository.split('/')[1]!]), repository, permission: 'pull_requests:write' };
}
export async function localPushCredentials(repository: string, options: Parameters<typeof localCredentials>[0] = {}): Promise<PushCredentials> {
  validateRepository(repository);
  return { ...await localCredentials(options), repository, permission: 'contents:write' };
}
export function installationPushCredentials(options: InstallationOptions, repository: string): PushCredentials {
  validateRepository(repository);
  return { ...installationToken(options, { contents: 'write', pull_requests: 'read' }, [repository.split('/')[1]!]), repository, permission: 'contents:write' };
}
export type PublicationCapability = 'review.publish' | 'labels.set';
export interface PublicationCredentials extends CredentialSource {
  repository: string; capability: PublicationCapability; permission: 'pull_requests:write' | 'issues:write';
}
export async function localPublicationCredentials(repository: string, capability: PublicationCapability,
  options: Parameters<typeof localCredentials>[0] = {}): Promise<PublicationCredentials> {
  validateRepository(repository);
  if (!['review.publish', 'labels.set'].includes(capability)) throw new GitHubReadError('credentials');
  return { ...await localCredentials(options), repository, capability, permission: capability === 'review.publish' ? 'pull_requests:write' : 'issues:write' };
}
export function installationPublicationCredentials(options: InstallationOptions, repository: string, capability: PublicationCapability): PublicationCredentials {
  validateRepository(repository);
  if (!['review.publish', 'labels.set'].includes(capability)) throw new GitHubReadError('credentials');
  const permission = capability === 'review.publish' ? 'pull_requests' : 'issues';
  return { ...installationToken(options, { contents: 'read', pull_requests: 'read', [permission]: 'write' }, [repository.split('/')[1]!]), repository, capability, permission: `${permission}:write` };
}
function validateRepository(repository: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(repository)) throw new GitHubReadError('credentials');
}
export function installationCredentials(options: InstallationOptions): CredentialSource {
  return installationToken(options, { contents: 'read', pull_requests: 'read', checks: 'read', statuses: 'read' });
}
function installationToken(options: InstallationOptions, permissions: Record<string, string>, repositories?: string[]): CredentialSource {
  if (!options.appId || !Number.isSafeInteger(options.installationId) || options.installationId < 1)
    throw new GitHubReadError('credentials');
  const vault = secrets(); vault.add(options.privateKey);
  const now = options.now ?? Date.now;
  const request = options.fetch ?? globalThis.fetch;
  let cached: { token: string; expires: number } | undefined;
  let pending: Promise<string> | undefined;
  let failed: { until: number; error: GitHubReadError } | undefined;
  async function refresh(signal?: AbortSignal): Promise<string> {
    try {
      const seconds = Math.floor(now() / 1000);
      const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const unsigned = `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({ iat: seconds - 60, exp: seconds + 540, iss: options.appId })}`;
      const jwt = vault.add(`${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), options.privateKey).toString('base64url')}`);
      const response = await request(`https://api.github.com/app/installations/${options.installationId}/access_tokens`, {
        method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: JSON.stringify({ permissions, ...(repositories ? { repositories } : {}) }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429 || response.status === 403 && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0')) {
          const guide = response.headers.get('retry-after');
          const wait = guide && /^\d+$/.test(guide) ? now() + Number(guide) * 1000 : guide ? Date.parse(guide) : 0;
          const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
          const until = Math.max(now() + 60_000, Number.isFinite(wait) ? wait : 0, Number.isFinite(reset) ? reset + 1000 : 0);
          const error = new GitHubReadError('rate_limit', new Date(until).toISOString());
          failed = { until, error }; throw error;
        }
        throw new GitHubReadError('credentials');
      }
      const text = await responseText(response, 65_536);
      const data = JSON.parse(text) as { token?: unknown; expires_at?: unknown; permissions?: Record<string, unknown> };
      if (typeof data.token !== 'string' || !data.token || typeof data.expires_at !== 'string' || Date.parse(data.expires_at) <= now() + 60_000 || !Number.isFinite(Date.parse(data.expires_at)))
        throw new GitHubReadError('credentials');
      if (Object.entries(permissions).some(([name, value]) => value === 'write' && data.permissions?.[name] !== 'write')) throw new GitHubReadError('credentials');
      cached = { token: vault.add(data.token), expires: Date.parse(data.expires_at) };
      return cached.token;
    } catch (error) {
      const safe = signal?.aborted ? new GitHubReadError('cancelled') : error instanceof GitHubReadError ? error : new GitHubReadError('credentials');
      if (!signal?.aborted) failed ??= { until: now() + 60_000, error: safe };
      throw safe;
    }
  }
  return {
    async token(signal) {
      if (cached && cached.expires > now() + 60_000) return cached.token;
      if (failed && now() < failed.until) throw failed.error;
      failed = undefined;
      if (!pending) pending = refresh(signal).finally(() => { pending = undefined; });
      return pending;
    },
    invalidate() { cached = undefined; },
    redact: vault.redact,
  };
}
