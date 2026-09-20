import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PilotError } from './io.mjs';
import { privateRead } from './store.mjs';
import { findDispatch } from './integration.mjs';

const validSha = value => /^[a-f0-9]{40}$/.test(value ?? '');
export const workflowPath = '.repo-chap/pilot/workflow.json';
const api = run => `repos/${run.repository}`;

export async function refs(pilot, run) {
  const result = await pilot.accounts.gh(`${api(run)}/git/matching-refs/heads/`);
  if (!Array.isArray(result)) throw new PilotError('Cannot inventory repository branches');
  return Object.fromEntries(result.map(ref => [ref.ref.replace('refs/heads/', ''), ref.object.sha]));
}

// Git's lease makes both installation and deletion conditional on the exact
// recorded commit. The REST ref deletion endpoint has no equivalent condition.
export async function changeRef(pilot, run, name, before, after) {
  const directory = join(pilot.store.directory(run.id), 'git');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const command = (...args) => pilot.accounts.io.command('git', ['-C', directory,
    '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...args], { signal: pilot.signal });
  await command('init', '--bare', '--quiet');
  const url = `https://github.com/${run.repository}.git`;
  if (after) await command('fetch', '--quiet', url, after);
  await command('push', '--porcelain', `--force-with-lease=refs/heads/${name}:${before ?? ''}`, url, `${after ?? ''}:refs/heads/${name}`);
}

async function makeCommit(pilot, run, key, parent, files) {
  const state = run.fixtures;
  if (state.commits[key]) return state.commits[key];
  const base = await pilot.accounts.gh(`${api(run)}/git/commits/${parent}`);
  const entries = Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content }));
  const tree = await pilot.accounts.gh(`${api(run)}/git/trees`, 'POST', { base_tree: base.tree.sha, tree: entries });
  const identity = { name: 'Repo Chap pilot', email: 'pilot@example.invalid', date: new Date(run.created * 1000).toISOString() };
  const commit = await pilot.accounts.gh(`${api(run)}/git/commits`, 'POST', {
    message: `${run.name}: ${key}`, tree: tree.sha, parents: [parent], author: identity, committer: identity,
  });
  if (!validSha(commit.sha)) throw new PilotError('GitHub returned an invalid commit');
  state.commits[key] = commit.sha;
  await pilot.store.save(run);
  return commit.sha;
}

async function branch(pilot, run, name, sha, original = null) {
  let record = run.fixtures.branches[name];
  if (!record) {
    const current = (await refs(pilot, run))[name] ?? null;
    if (current !== original) throw new PilotError(`Refusing existing or changed branch ${name}`);
    record = run.fixtures.branches[name] = { original, sha, attempted: true };
    await pilot.store.save(run);
  }
  if (record.sha !== sha) throw new PilotError('Fixture commit changed');
  const current = (await refs(pilot, run))[name] ?? null;
  if (current === sha) return;
  if (current !== original) throw new PilotError(`Fixture branch changed: ${name}`);
  await changeRef(pilot, run, name, original, sha);
}

async function workflowFiles(run) {
  const root = new URL('../../docs/pr-workflows/', import.meta.url);
  const workflow = JSON.parse(await readFile(new URL('examples/team-pr/workflow.json', root), 'utf8'));
  workflow.id = 'pilot';
  workflow.settings.newPrDelaySeconds = 0;
  workflow.settings.headDebounceSeconds = 0;
  workflow.limits.maxAttemptsPerHead = 4;
  workflow.actions.review.onSuccess = 'address';
  workflow.actions.push_candidate.onSuccess = 'handoff';
  delete workflow.actions.resolve_threads;
  workflow.requestedCapabilities = workflow.requestedCapabilities.filter(cap => cap !== 'review.resolve');
  const { workspaceId, channelId } = run.pilotConfig;
  workflow.slack = { workspaceId, users: {}, channels: { pilot: channelId }, defaultChannel: 'pilot', routes: {
    needs_author: 'author_dm', needs_team: 'pilot', ready_for_human_merge: 'pilot', blocked_execution: 'pilot',
  } };
  const files = {};
  for (const action of Object.values(workflow.actions)) {
    if (action.outputSchema) action.outputSchema = 'results.schema.json' + action.outputSchema.slice(action.outputSchema.indexOf('#'));
    for (const path of [action.prompt, ...(action.contextFiles ?? [])].filter(Boolean))
      files[`.repo-chap/pilot/${path}`] = await readFile(new URL(`examples/team-pr/${path}`, root), 'utf8');
  }
  files[`${workflowPath.slice(0, -'workflow.json'.length)}results.schema.json`] = await readFile(new URL('schemas/results.schema.json', root), 'utf8');
  const requirement = '\nPilot requirements: price(amount, percent) returns amount * (1 - percent / 100). In a greeting conflict preserve both changes: greeting(name) returns `Welcome, ${name}`. Only change src. Never weaken tests. Return no_change when already correct.\n';
  for (const name of ['review', 'address', 'resolve-conflict']) files[`.repo-chap/pilot/prompts/${name}.md`] += requirement;
  files[workflowPath] = JSON.stringify(workflow, null, 2) + '\n';
  files['.node-version'] = '24.21.0\n';
  files['pilot-check.sh'] = '#!/usr/bin/env bash\nexit 0\n';
  files['src/greeting.mjs'] = "export const greeting = () => 'Hello';\n";
  files['.github/workflows/pilot.yml'] = await readFile(new URL('trusted-workflow.yml', import.meta.url), 'utf8');
  return files;
}

async function pull(pilot, run, name, head, base) {
  const state = run.fixtures;
  const marker = `Repo Chap pilot ${run.id} ${name}`;
  let record = state.pulls[name];
  if (!record) {
    record = state.pulls[name] = { head, base, marker, initialHead: state.branches[head].sha, baseSha: state.branches[base].sha };
    await pilot.store.save(run);
  }
  const list = await pilot.accounts.gh(`${api(run)}/pulls?state=all&head=${encodeURIComponent(run.repository.split('/')[0] + ':' + head)}&per_page=100`);
  if (!Array.isArray(list) || list.length > 1) throw new PilotError('Ambiguous pilot PR inventory');
  if (list.length) {
    const pr = list[0];
    if (pr.body !== marker || pr.head.ref !== head || pr.base.ref !== base || pr.head.repo?.id !== run.repositoryId || pr.base.repo?.id !== run.repositoryId)
      throw new PilotError('Pilot PR ownership does not match');
    record.number = pr.number;
  } else {
    // An uncertain create cannot be retried merely because a list read is empty.
    if (record.attempted) throw new PilotError('PR creation outcome unknown; rerun after GitHub exposes the recorded PR');
    record.attempted = true;
    await pilot.store.save(run);
    const pr = await pilot.accounts.gh(`${api(run)}/pulls`, 'POST', { title: marker, body: marker, head, base, draft: true });
    record.number = pr.number;
  }
  await pilot.store.save(run);
}

export async function prepareRepository(pilot, run) {
  const info = await pilot.accounts.gh(api(run));
  if (info.id !== run.repositoryId || !info.private || !info.permissions?.admin || !/^[A-Za-z0-9_.-]+$/.test(info.default_branch))
    throw new PilotError('Select the recorded private repository with admin access');
  if (!run.fixtures) {
    const heads = await refs(pilot, run);
    if (!validSha(heads[info.default_branch])) throw new PilotError('Pilot repository needs an initial commit');
    run.fixtures = { version: 1, defaultBranch: info.default_branch, original: heads[info.default_branch], commits: {}, branches: {}, pulls: {} };
    await pilot.store.save(run);
  }
  const state = run.fixtures;
  if (state.repositoryPrepared) return;
  const root = await makeCommit(pilot, run, 'workflow', state.original, await workflowFiles(run));
  await branch(pilot, run, state.defaultBranch, root, state.original);
  const prefix = run.name;
  for (const [kind, exit] of [['failing', 1], ['repaired', 0]]) {
    const sha = await makeCommit(pilot, run, kind, root, { 'pilot-check.sh': `#!/usr/bin/env bash\nexit ${exit}\n` });
    await branch(pilot, run, `${prefix}-${kind}`, sha);
  }
  state.repositoryPrepared = true;
  await pilot.store.save(run);
}

export async function prepareWorkflowFixtures(pilot, run) {
  const state = run.fixtures;
  if (state.prepared) return;
  const root = state.commits.workflow;
  const prefix = run.name;
  const review = await makeCommit(pilot, run, 'review', root, {
    'src/price.mjs': 'export const price = (amount, percent) => amount - percent;\n',
    'tests/pilot-regression.mjs': "import assert from 'node:assert/strict';\nimport { price } from '../src/price.mjs';\nassert.equal(price(200, 10), 180);\nassert.equal(price(80, 25), 60);\nassert.equal(price(200, 0), 200);\n",
  });
  const conflictBase = await makeCommit(pilot, run, 'conflict-base', root, { 'src/greeting.mjs': "export const greeting = () => 'Welcome';\n" });
  const conflict = await makeCommit(pilot, run, 'conflict', root, {
    'src/greeting.mjs': 'export const greeting = name => `Hello, ${name}`;\n',
    'tests/pilot-regression.mjs': "import assert from 'node:assert/strict';\nimport { greeting } from '../src/greeting.mjs';\nassert.equal(greeting('Mira'), 'Welcome, Mira');\nassert.equal(greeting('Rowan'), 'Welcome, Rowan');\n",
  });
  await branch(pilot, run, `${prefix}-review`, review);
  await branch(pilot, run, `${prefix}-conflict-base`, conflictBase);
  await branch(pilot, run, `${prefix}-conflict`, conflict);
  await pull(pilot, run, 'review', `${prefix}-review`, state.defaultBranch);
  await pull(pilot, run, 'conflict', `${prefix}-conflict`, `${prefix}-conflict-base`);
  state.prepared = true;
  await pilot.store.save(run);
}

export async function cleanupRepository(pilot, run) {
  const state = run.fixtures;
  if (!state) return true;
  const info = await pilot.accounts.gh(api(run));
  if (info.id !== run.repositoryId || !info.private || !info.permissions?.admin) throw new PilotError('Repository ownership changed; cleanup refused');
  const refused = [];
  let smoke;
  try { smoke = JSON.parse(await privateRead(join(pilot.store.directory(run.id), 'test.json'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (smoke) {
    if (smoke.runId !== run.id) throw new PilotError('Runner evidence belongs to another environment');
    state.dispatchCleanup ??= {};
    for (const job of smoke.jobs) {
      const current = await findDispatch(pilot, run, smoke.selection.workflow, job);
      if (!current) {
        if (job.attempted && !job.workflowRunId && !state.dispatchCleanup[job.correlation]) refused.push(job.correlation);
        continue;
      }
      if (current.head_sha !== job.head || current.run_attempt !== 1 || current.status !== 'completed' ||
          job.workflowRunId && current.id !== job.workflowRunId) { refused.push(job.correlation); continue; }
      state.dispatchCleanup[job.correlation] = { id: current.id, head: job.head };
      await pilot.store.save(run);
      await pilot.accounts.gh(`${api(run)}/actions/runs/${current.id}`, 'DELETE');
      if (await findDispatch(pilot, run, smoke.selection.workflow, job)) refused.push(job.correlation);
    }
  }
  // Close only exact recorded PRs. Confirmed repair heads are recorded by the
  // observer; an interrupted observer conservatively retains unknown heads.
  for (const item of Object.values(state.pulls)) {
    if (!item.number) { if (item.attempted) refused.push(item.head, item.base); continue; }
    const pr = await pilot.accounts.gh(`${api(run)}/pulls/${item.number}`);
    const expected = state.branches[item.head].repairedSha ?? item.initialHead;
    if (item.closed && pr.state === 'closed' && !pr.merged) continue;
    if (pr.body !== item.marker || pr.head.ref !== item.head || pr.base.ref !== item.base || pr.head.sha !== expected ||
        pr.base.sha !== item.baseSha || pr.head.repo?.id !== run.repositoryId || pr.base.repo?.id !== run.repositoryId || pr.merged) {
      refused.push(item.head, item.base); continue;
    }
    if (pr.state === 'open') await pilot.accounts.gh(`${api(run)}/pulls/${item.number}`, 'PATCH', { state: 'closed' });
    item.closed = true;
    await pilot.store.save(run);
  }
  for (const [name, record] of Object.entries(state.branches).reverse()) {
    if (refused.includes(name)) continue;
    const current = (await refs(pilot, run))[name] ?? null;
    if (current === record.original) continue;
    const expected = record.repairedSha ?? record.sha;
    if (current !== expected) { refused.push(name); continue; }
    try { await changeRef(pilot, run, name, expected, record.original); }
    catch { refused.push(name); }
  }
  const remaining = await refs(pilot, run);
  for (const [name, record] of Object.entries(state.branches)) {
    if ((remaining[name] ?? null) !== record.original) refused.push(name);
  }
  for (const item of Object.values(state.pulls)) {
    if (item.number && (await pilot.accounts.gh(`${api(run)}/pulls/${item.number}`)).state !== 'closed') refused.push(item.head);
  }
  state.cleanupRefused = [...new Set(refused)];
  await pilot.store.save(run);
  if (refused.length) pilot.output('Repository cleanup unresolved: recorded artifacts changed or have unknown outcomes. See the private manifest.');
  return refused.length === 0;
}
