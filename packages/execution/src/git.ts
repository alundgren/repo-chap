import { runProcess, type ProcessResult } from '@repo-chap/providers';
import { ExecutionError } from './policy.js';

export function gitEnvironment(): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Repo Chap', GIT_AUTHOR_EMAIL: 'repo-chap@example.invalid', GIT_COMMITTER_NAME: 'Repo Chap', GIT_COMMITTER_EMAIL: 'repo-chap@example.invalid' };
}
export class ExecutionFailure extends ExecutionError {
  constructor(readonly status: 'blocked' | 'timeout' | 'cancelled' | 'superseded' | 'invalid_output', message: string) { super(message); }
}
export async function gitProcess(cwd: string, args: string[], deadline: number, signal?: AbortSignal, maxBytes = 2 * 1024 * 1024, input?: string): Promise<ProcessResult> {
  return runProcess('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', ...args],
    { cwd, env: gitEnvironment(), timeoutMs: Math.max(0, Math.min(30_000, deadline - Date.now())), maxBytes, input, signal });
}
export async function git(cwd: string, args: string[], deadline: number, signal?: AbortSignal, maxBytes?: number, input?: string): Promise<string> {
  const result = await gitProcess(cwd, args, deadline, signal, maxBytes, input);
  if (result.status !== 'exited' || result.exitCode !== 0) {
    const status = ['timeout', 'cancelled', 'superseded'].includes(result.status) ? result.status as 'timeout' | 'cancelled' | 'superseded' : 'blocked';
    throw new ExecutionFailure(status, `Local Git ${args[0]} failed or exceeded its limit. Check pinned commits, disk space, and repository access.`);
  }
  return result.stdout.toString('utf8').trimEnd();
}
export async function initializeCheckout(directory: string, source: string, head: string, base: string, deadline: number, signal?: AbortSignal): Promise<void> {
  await git(directory, ['init', '--quiet', '--template='], deadline, signal);
  await git(directory, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', source, head, base], deadline, signal);
  await git(directory, ['checkout', '--quiet', '--detach', head], deadline, signal);
}
