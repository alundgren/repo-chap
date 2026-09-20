import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PilotError } from './io.mjs';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const workflowPath = '.github/workflows/pilot.yml';
const failingBranch = 'pilot-failing';
const repairedBranch = 'pilot-repaired';

function blobSha(content) {
  return createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex');
}

async function blob(accounts, repository, content) {
  const result = await accounts.gh(`repos/${repository}/git/blobs`, 'POST', { content, encoding: 'utf-8' });
  if (!/^[a-f0-9]{40}$/.test(result.sha)) throw new PilotError('GitHub did not return a blob ID');
  return result.sha;
}

async function tree(accounts, repository, base, entries) {
  const result = await accounts.gh(`repos/${repository}/git/trees`, 'POST', { base_tree: base, tree: entries });
  if (!/^[a-f0-9]{40}$/.test(result.sha)) throw new PilotError('GitHub did not return a tree ID');
  return result.sha;
}

async function commit(accounts, repository, message, treeSha, parent) {
  const result = await accounts.gh(`repos/${repository}/git/commits`, 'POST', { message, tree: treeSha, parents: [parent] });
  if (!/^[a-f0-9]{40}$/.test(result.sha)) throw new PilotError('GitHub did not return a commit ID');
  return result;
}

async function updateBranch(accounts, repository, name, sha, existing) {
  if (existing) await accounts.gh(`repos/${repository}/git/refs/heads/${name}`, 'PATCH', { sha, force: true });
  else await accounts.gh(`repos/${repository}/git/refs`, 'POST', { ref: `refs/heads/${name}`, sha });
}

export async function prepareRepository(accounts, repository, output, confirm) {
  const info = await accounts.gh(`repos/${repository}`);
  if (!info.private || !info.permissions?.admin || !/^[A-Za-z0-9_.-]+$/.test(info.default_branch))
    throw new PilotError('Repository preparation requires admin access to one private repository');
  const defaultBranch = info.default_branch;
  const defaultRef = await accounts.gh(`repos/${repository}/git/ref/heads/${defaultBranch}`);
  const defaultHead = defaultRef.object?.sha;
  if (!/^[a-f0-9]{40}$/.test(defaultHead)) throw new PilotError('Cannot resolve the default branch');
  const baseCommit = await accounts.gh(`repos/${repository}/git/commits/${defaultHead}`);
  if (!/^[a-f0-9]{40}$/.test(baseCommit.tree?.sha)) throw new PilotError('Cannot resolve the default branch tree');
  const baseTree = await accounts.gh(`repos/${repository}/git/trees/${baseCommit.tree.sha}?recursive=1`);
  if (!Array.isArray(baseTree.tree) || baseTree.truncated) throw new PilotError('Cannot safely inspect the complete default branch tree');
  const refs = await accounts.gh(`repos/${repository}/git/matching-refs/heads/pilot-`);
  if (!Array.isArray(refs)) throw new PilotError('Cannot inspect existing pilot branches');
  const heads = Object.fromEntries(refs
    .filter(ref => [failingBranch, repairedBranch].includes(ref.ref?.replace('refs/heads/', '')))
    .map(ref => [ref.ref.replace('refs/heads/', ''), ref.object?.sha]));
  const plan = { repository, defaultBranch, defaultHead, failingHead: heads[failingBranch] ?? null, repairedHead: heads[repairedBranch] ?? null };
  if (!await confirm(plan, output)) { output('Repository preparation cancelled.'); return false; }

  const workflow = await readFile(join(moduleDirectory, 'trusted-workflow.yml'), 'utf8');
  const failingCheck = '#!/usr/bin/env bash\nexit 1\n';
  const repairedCheck = '#!/usr/bin/env bash\nexit 0\n';
  let fixtureBase = baseCommit.tree.sha;
  let fixtureParent = defaultHead;
  const currentWorkflow = baseTree.tree.find(entry => entry.path === workflowPath);
  if (currentWorkflow?.sha !== blobSha(workflow)) {
    const workflowBlob = await blob(accounts, repository, workflow);
    fixtureBase = await tree(accounts, repository, baseCommit.tree.sha, [{ path: workflowPath, mode: '100644', type: 'blob', sha: workflowBlob }]);
    const workflowCommit = await commit(accounts, repository, 'Install the pilot test workflow', fixtureBase, defaultHead);
    await accounts.gh(`repos/${repository}/git/refs/heads/${defaultBranch}`, 'PATCH', { sha: workflowCommit.sha, force: false });
    fixtureParent = workflowCommit.sha;
  }
  const failingBlob = await blob(accounts, repository, failingCheck);
  const failingTree = await tree(accounts, repository, fixtureBase, [{ path: 'pilot-check.sh', mode: '100755', type: 'blob', sha: failingBlob }]);
  const failingCommit = await commit(accounts, repository, 'Create the failing pilot fixture', failingTree, fixtureParent);
  const repairedBlob = await blob(accounts, repository, repairedCheck);
  const repairedTree = await tree(accounts, repository, failingTree, [{ path: 'pilot-check.sh', mode: '100755', type: 'blob', sha: repairedBlob }]);
  const repairedCommit = await commit(accounts, repository, 'Create the repaired pilot fixture', repairedTree, failingCommit.sha);
  await updateBranch(accounts, repository, failingBranch, failingCommit.sha, Boolean(heads[failingBranch]));
  await updateBranch(accounts, repository, repairedBranch, repairedCommit.sha, Boolean(heads[repairedBranch]));
  output(`Prepared ${repository}:`);
  output(`  ${failingBranch} ${failingCommit.sha}`);
  output(`  ${repairedBranch} ${repairedCommit.sha}`);
  return true;
}

export const repositoryFixtures = { workflowPath, failingBranch, repairedBranch };
