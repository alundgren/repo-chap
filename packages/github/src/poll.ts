import { GitHubReader, object } from './client.js';
import { GitHubReadError, readFailure } from './errors.js';
import { validateTarget, type Coverage, type RepositoryIdentity } from './inspect.js';

export interface PullRequestListing { repository: RepositoryIdentity | null; numbers: number[]; coverage: Coverage }
export async function listOpenPullRequests(reader: GitHubReader, repository: string): Promise<PullRequestListing> {
  validateTarget(repository, 1);
  const [owner, name] = repository.split('/'), result: PullRequestListing = { repository: null, numbers: [], coverage: { status: 'unknown', pages: 0 } };
  const cursors = new Set<string>(); let cursor: string | null = null;
  try {
    for (let page = 0; page < 100; page++) {
      const response = await reader.query(`query PollPullRequests($owner:String!, $name:String!, $cursor:String) {
        repository(owner:$owner, name:$name) { id nameWithOwner isPrivate pullRequests(states:OPEN, first:100, after:$cursor, orderBy:{field:CREATED_AT,direction:ASC}) {
          nodes { number } pageInfo { hasNextPage endCursor }
        } }
      }`, { owner, name, cursor });
      const data = object(response.data);
      if (data.repository === null) throw new GitHubReadError('access');
      const repo = object(data.repository), connection = object(repo.pullRequests);
      if (typeof repo.id !== 'string' || typeof repo.nameWithOwner !== 'string' || typeof repo.isPrivate !== 'boolean' || !Array.isArray(connection.nodes)) throw new GitHubReadError('invalid_response');
      if (result.repository && result.repository.id !== repo.id) throw new GitHubReadError('changed');
      result.repository = { id: repo.id, name: repo.nameWithOwner, private: repo.isPrivate };
      for (const node of connection.nodes) {
        const number = object(node).number;
        if (!Number.isSafeInteger(number) || Number(number) < 1) throw new GitHubReadError('invalid_response');
        if (!result.numbers.includes(Number(number))) result.numbers.push(Number(number));
      }
      result.coverage.pages++;
      if (response.incomplete) throw new GitHubReadError('graphql');
      const info = object(connection.pageInfo);
      if (typeof info.hasNextPage !== 'boolean') throw new GitHubReadError('invalid_response');
      if (!info.hasNextPage) { result.coverage.status = 'complete'; return result; }
      if (typeof info.endCursor !== 'string' || !info.endCursor || cursors.has(info.endCursor)) throw new GitHubReadError('invalid_response');
      cursor = info.endCursor; cursors.add(cursor);
    }
    throw new GitHubReadError('limit');
  } catch (error) { result.coverage.status = result.coverage.pages ? 'partial' : 'unknown'; result.coverage.failure = readFailure(error); return result; }
}
