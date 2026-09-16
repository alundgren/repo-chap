import { GitHubReader, object } from './client.js';
import { GitHubReadError } from './errors.js';
import { validateTarget } from './inspect.js';

export async function resolveWorkflowSource(reader: GitHubReader, repository: string, branch: string | null): Promise<{ repositoryId: string; branch: string; revision: string }> {
  validateTarget(repository, 1);
  const [owner, name] = repository.split('/');
  const response = await reader.query(`query WorkflowSource($owner:String!, $name:String!, $ref:String!) {
    repository(owner:$owner, name:$name) { id defaultBranchRef { name target { oid } } ref(qualifiedName:$ref) { name target { oid } } }
  }`, { owner, name, ref: `refs/heads/${branch ?? ''}` });
  if (response.incomplete) throw new GitHubReadError('graphql');
  const data = object(response.data);
  if (data.repository === null) throw new GitHubReadError('access');
  const repo = object(data.repository), ref = object(branch === null ? repo.defaultBranchRef : repo.ref), revision = object(ref.target).oid;
  if (typeof repo.id !== 'string' || typeof ref.name !== 'string' || !ref.name || typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision) || branch !== null && ref.name !== branch) throw new GitHubReadError('invalid_response');
  return { repositoryId: repo.id, branch: ref.name, revision };
}
