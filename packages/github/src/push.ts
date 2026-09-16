import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { CredentialSource, PushCredentials } from './auth.js';
import { GitHubReader, object } from './client.js';
import { GitHubReadError } from './errors.js';
import { validateTarget } from './inspect.js';

export interface PushRequest {
  schemaVersion: 1; repositoryId: string; repository: string; pullRequestId: string; number: number;
  targetRef: string; expectedHeadSha: string; baseSha: string; candidateSha: string; tree: string; parents: string[];
}
export interface PushTarget {
  repositoryId: string; repository: string; pullRequestId: string; number: number;
  headRepositoryId: string | null; headRepository: string | null; headRef: string; baseRef: string; defaultRef: string;
  headSha: string; baseSha: string; lifecycle: 'open' | 'closed' | 'merged'; draft: boolean;
}
export interface PushReceipt {
  status: 'confirmed' | 'rejected' | 'unknown'; repository: string; targetRef: string;
  expectedHeadSha: string; candidateSha: string; observedSha: string | null; retryable: boolean; reason: string;
  reconcileAfter?: number;
}
export interface PushTransport {
  repository: string;
  candidate(sha: string): Promise<{ tree: string; parents: string[] }>;
  isAncestor(old: string, candidate: string): Promise<boolean>;
  push(ref: string, old: string, candidate: string, beforeSend: () => Promise<boolean>): Promise<'accepted' | 'rejected' | 'unknown'>;
  readRef(ref: string): Promise<string | null>;
}
export class PushError extends Error {}
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const branch = (value: unknown): value is string => typeof value === 'string' && value.startsWith('refs/heads/') &&
  value.length > 11 && !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{') &&
  value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock') && !part.endsWith('.'));
export function validatePushRequest(request: PushRequest): void {
  validateTarget(request.repository, request.number);
  if (request.schemaVersion !== 1 || !request.repositoryId || !request.pullRequestId || !branch(request.targetRef) ||
    ![request.expectedHeadSha, request.baseSha, request.candidateSha, request.tree, ...request.parents].every(sha) ||
    request.expectedHeadSha === request.candidateSha || request.parents[0] !== request.expectedHeadSha ||
    request.parents.length !== 1 && !(request.parents.length === 2 && request.parents[1] === request.baseSha))
    throw new PushError('Push requires a full tested commit, its parents, and one non-deleting branch update.');
}
export function validatePushTarget(request: PushRequest, current: PushTarget): void {
  validatePushRequest(request);
  if (current.repositoryId !== request.repositoryId || current.repository.toLowerCase() !== request.repository.toLowerCase() ||
    current.pullRequestId !== request.pullRequestId || current.number !== request.number ||
    current.headRepositoryId !== current.repositoryId || current.headRepository?.toLowerCase() !== current.repository.toLowerCase() ||
    current.lifecycle !== 'open' || current.draft !== false || current.headSha !== request.expectedHeadSha || current.baseSha !== request.baseSha ||
    !branch(current.defaultRef) || !branch(current.baseRef) || current.headRef !== request.targetRef ||
    request.targetRef === current.baseRef || request.targetRef === current.defaultRef)
    throw new PushError('The current PR, branch, head, base, lifecycle or repository no longer permits this push. Forks and base/default branches cannot be repaired automatically.');
}
export async function readPushTarget(reader: GitHubReader, repository: string, number: number): Promise<PushTarget> {
  validateTarget(repository, number);
  const [owner, name] = repository.split('/');
  const response = await reader.query(`query PushTarget($owner:String!, $name:String!, $number:Int!) {
    repository(owner:$owner,name:$name) { id nameWithOwner defaultBranchRef { name }
      pullRequest(number:$number) { id number state isDraft headRefOid baseRefOid headRefName baseRefName headRepository { id nameWithOwner } }
    }
  }`, { owner, name, number });
  if (response.incomplete) throw new GitHubReadError('graphql');
  const repo = object(object(response.data).repository), pr = object(repo.pullRequest), head = pr.headRepository === null ? null : object(pr.headRepository);
  const text = (v: unknown) => { if (typeof v !== 'string' || !v) throw new GitHubReadError('invalid_response'); return v; };
  if (pr.number !== number || typeof pr.isDraft !== 'boolean' || !['OPEN', 'CLOSED', 'MERGED'].includes(String(pr.state)) || !sha(pr.headRefOid) || !sha(pr.baseRefOid)) throw new GitHubReadError('invalid_response');
  return { repositoryId: text(repo.id), repository: text(repo.nameWithOwner), pullRequestId: text(pr.id), number,
    headRepositoryId: head && text(head.id), headRepository: head && text(head.nameWithOwner),
    headRef: `refs/heads/${text(pr.headRefName)}`, baseRef: `refs/heads/${text(pr.baseRefName)}`, defaultRef: `refs/heads/${text(object(repo.defaultBranchRef).name)}`,
    headSha: pr.headRefOid, baseSha: pr.baseRefOid, lifecycle: String(pr.state).toLowerCase() as PushTarget['lifecycle'], draft: pr.isDraft };
}
const receipt = (request: PushRequest, status: PushReceipt['status'], observedSha: string | null, retryable: boolean, reason: string): PushReceipt =>
  ({ status, repository: request.repository, targetRef: request.targetRef, expectedHeadSha: request.expectedHeadSha, candidateSha: request.candidateSha, observedSha, retryable, reason });

export async function conditionalPush(input: PushRequest, options: {
  transport: PushTransport; readTarget: () => Promise<PushTarget>; authorize: () => boolean | Promise<boolean>;
}): Promise<PushReceipt> {
  const request = structuredClone(input);
  try {
    validatePushRequest(request);
    if (options.transport.repository.toLowerCase() !== request.repository.toLowerCase()) throw new PushError('The Git transport targets a different repository.');
    const actual = await options.transport.candidate(request.candidateSha);
    if (actual.tree !== request.tree || JSON.stringify(actual.parents) !== JSON.stringify(request.parents) ||
      !await options.transport.isAncestor(request.expectedHeadSha, request.candidateSha)) throw new PushError('The tested object is missing, changed, or does not preserve the published PR history.');
  } catch (error) {
    return receipt(request, 'rejected', null, false, error instanceof PushError ? error.message : 'Cannot validate the current push target and tested object. Refresh evidence and inspect the retained candidate.');
  }
  let outcome: 'accepted' | 'rejected' | 'unknown';
  let sending = false, rejection = 'Cannot validate current permissions or the remote target. No push was sent.';
  try {
    outcome = await options.transport.push(request.targetRef, request.expectedHeadSha, request.candidateSha, async () => {
      try {
        validatePushTarget(request, await options.readTarget());
        if (!await options.authorize()) throw new PushError('Push ownership, policy, checks or remaining limits changed before dispatch.');
        sending = true; return true;
      } catch (error) { rejection = error instanceof PushError ? error.message : 'Cannot validate the current PR evidence and apply policy. No push was sent.'; return false; }
    });
  } catch { outcome = 'unknown'; }
  if (!sending) return receipt(request, 'rejected', null, false, rejection);
  return outcome === 'accepted' ? receipt(request, 'confirmed', request.candidateSha, false, 'The exact tested commit was accepted by the PR branch.') :
    receipt(request, 'unknown', null, false, 'The Git push outcome needs remote-ref reconciliation before another write.');
}
export async function reconcilePush(request: PushRequest, transport: Pick<PushTransport, 'repository' | 'readRef'>): Promise<PushReceipt> {
  validatePushRequest(request);
  if (transport.repository.toLowerCase() !== request.repository.toLowerCase()) throw new PushError('The Git transport targets a different repository.');
  try {
    const observed = await transport.readRef(request.targetRef);
    if (observed === request.candidateSha) return receipt(request, 'confirmed', observed, false, 'The remote branch contains the exact tested commit.');
    if (observed === request.expectedHeadSha) return receipt(request, 'rejected', observed, true, 'The remote branch still has the expected old commit. A bounded retry can reuse the tested candidate.');
    return receipt(request, 'unknown', observed, false, 'The remote branch is missing or has an unexpected commit. Inspect the retained outcome before any further push.');
  } catch { return receipt(request, 'unknown', null, false, 'Cannot read the remote branch. The push remains unknown; no write was retried.'); }
}

async function git(directory: string, args: string[], environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ code: number | null; output: string; stopped: boolean }> {
  if (signal?.aborted) return { code: null, output: '', stopped: true };
  return new Promise(resolve => {
    const child = spawn('git', ['--no-replace-objects', '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', '-c', 'push.followTags=false', ...args], { cwd: directory, env: environment, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', stopped = false, settled = false;
    const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const finish = (code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); kill(); resolve({ code, output, stopped }); };
    const stop = () => { stopped = true; kill(); finish(null); };
    const timer = setTimeout(stop, 30_000); signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', bytes => { if (Buffer.byteLength(output) + bytes.length > 2_097_152) stop(); else output += bytes.toString('utf8'); });
    child.once('error', () => { stopped = true; finish(null); }); child.once('close', finish);
    if (signal?.aborted) stop();
  });
}
function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env)) if (/^GIT_(CONFIG_(COUNT|KEY_|VALUE_|PARAMETERS)|DIR$|WORK_TREE$|INDEX_FILE$|OBJECT_DIRECTORY$|ALTERNATE_OBJECT_DIRECTORIES$)/.test(key)) delete env[key];
  return env;
}
function transport(repository: string, checkout: string, remote: string, authorize: () => Promise<NodeJS.ProcessEnv>, signal?: AbortSignal): PushTransport {
  const local = async (args: string[]) => {
    const result = await git(checkout, args, environment(), signal);
    if (result.stopped || result.code !== 0) throw new PushError('Cannot validate the local candidate Git objects.');
    return result.output.trim();
  };
  return { repository,
    async candidate(commit) { if (!sha(commit)) throw new PushError('Invalid candidate commit.'); const [tree, parents] = (await local(['show', '-s', '--format=%T%n%P', commit])).split('\n'); return { tree: tree!, parents: parents ? parents.split(' ') : [] }; },
    async isAncestor(old, candidate) { if (![old, candidate].every(sha)) return false; const result = await git(checkout, ['merge-base', '--is-ancestor', old, candidate], environment(), signal); return !result.stopped && result.code === 0; },
    async push(ref, old, candidate, beforeSend) {
      if (!branch(ref) || ![old, candidate].every(sha)) throw new PushError('Invalid push ref or commits.');
      const env = await authorize();
      if (!await beforeSend() || signal?.aborted) return 'rejected';
      const result = await git(checkout, ['push', '--porcelain', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', `--force-with-lease=${ref}:${old}`, '--', remote, `${candidate}:${ref}`], env, signal);
      return result.stopped ? 'unknown' : result.code === 0 ? 'accepted' : 'rejected';
    },
    async readRef(ref) {
      if (!branch(ref)) throw new PushError('Invalid branch ref.');
      const result = await git(checkout, ['ls-remote', '--refs', '--', remote, ref], await authorize(), signal);
      if (result.stopped || result.code !== 0) throw new PushError('Cannot read the remote ref.');
      const lines = result.output.trim().split('\n').filter(Boolean);
      if (!lines.length) return null;
      const [commit, found] = lines[0]!.split('\t');
      if (lines.length !== 1 || found !== ref || !sha(commit)) throw new PushError('The remote ref response is invalid.');
      return commit;
    },
  };
}
export function githubPushTransport(repository: string, checkout: string, credentials: PushCredentials, signal?: AbortSignal): PushTransport {
  validateTarget(repository, 1);
  if (credentials.permission !== 'contents:write' || credentials.repository.toLowerCase() !== repository.toLowerCase()) throw new PushError('Use explicit contents-write credentials scoped to the target repository.');
  return transport(repository, checkout, `https://github.com/${repository}.git`, async () => ({ ...environment(), GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${await credentials.token(signal)}`).toString('base64')}` }), signal);
}
export function githubRefReader(repository: string, directory: string, credentials: CredentialSource, signal?: AbortSignal): Pick<PushTransport, 'repository' | 'readRef'> {
  validateTarget(repository, 1);
  const reader = transport(repository, directory, `https://github.com/${repository}.git`, async () => ({ ...environment(), GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${await credentials.token(signal)}`).toString('base64')}` }), signal);
  return { repository: reader.repository, readRef: reader.readRef };
}
/** Local repositories exercise the same Git commands without credentials or network writes. */
export function localPushTransport(repository: string, checkout: string, remoteDirectory: string, signal?: AbortSignal): PushTransport {
  validateTarget(repository, 1);
  if (!isAbsolute(remoteDirectory)) throw new PushError('A local push transport requires an absolute repository directory.');
  return transport(repository, checkout, remoteDirectory, async () => environment(), signal);
}
