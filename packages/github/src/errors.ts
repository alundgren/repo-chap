export type ReadCode = 'credentials' | 'access' | 'rate_limit' | 'network' | 'timeout' |
  'cancelled' | 'limit' | 'invalid_response' | 'graphql' | 'changed';
const messages: Record<ReadCode, string> = {
  credentials: 'GitHub credentials are unavailable or rejected. Check the local login or installation settings.',
  access: 'GitHub did not grant access to this repository or PR. Check repository access and read permissions.',
  rate_limit: 'GitHub reads paused for a rate limit. Retry after the recorded time.',
  network: 'A GitHub read failed. Retry the inspection.',
  timeout: 'The GitHub read deadline expired. Collected evidence was retained.',
  cancelled: 'Inspection was cancelled. Collected evidence was retained.',
  limit: 'The bounded read limit was reached. Collected evidence is incomplete.',
  invalid_response: 'GitHub returned missing or invalid evidence. Retry the inspection.',
  graphql: 'GitHub could not return all requested evidence. Check read permissions and retry.',
  changed: 'The PR changed during inspection. Inspect the new revision before using this evidence.',
};
export interface ReadFailure { code: ReadCode; message: string; retryAt?: string }
export class GitHubReadError extends Error {
  readonly failure: ReadFailure;
  constructor(code: ReadCode, retryAt?: string) {
    super(messages[code]); this.name = 'GitHubReadError';
    this.failure = { code, message: messages[code], ...(retryAt ? { retryAt } : {}) };
  }
}
export function readFailure(error: unknown): ReadFailure {
  return error instanceof GitHubReadError ? error.failure : new GitHubReadError('invalid_response').failure;
}
