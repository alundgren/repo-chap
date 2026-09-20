import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { PilotError } from './io.mjs';
import { privateRead, writePrivate } from './store.mjs';
import { validateInputs } from './remote.mjs';
import { prepareRepository, prepareWorkflowFixtures, workflowPath } from './repository.mjs';

export async function confirmPilot(message, output) {
  output(message);
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(?:es)?$/i.test((await prompt.question('Confirm? [y/N] ')).trim()); }
  finally { prompt.close(); }
}

export function validateSelection(config) {
  if (!config || !/^T[A-Z0-9]+$/.test(config.workspaceId ?? '') || !/^[CG][A-Z0-9]+$/.test(config.channelId ?? '') ||
      !/^[A-Za-z0-9_-]+$/.test(config.profile ?? ''))
    throw new PilotError('Select pilotConfig.workspaceId, channelId and provider profile in operator.json before create');
  return config;
}

export async function daemon(pilot, run, command) {
  const result = JSON.parse(await pilot.ssh(run,
    `sudo -u repo-chap -H /opt/repo-chap/current/repo-chap daemon ${command} --state-dir /var/lib/repo-chap --json`));
  if (!result.ok) throw new PilotError('Daemon control operation failed');
  return result.result;
}
const selectedRepo = (status, run) => status.repositories.find(repo => repo.name === run.repository);

export async function preflight(pilot, run) {
  if (run.stage !== 'running') throw new PilotError('The environment must be running');
  validateSelection(run.pilotConfig);
  await validateInputs(run);
  const info = await pilot.accounts.gh(`repos/${run.repository}`);
  if (info.id !== run.repositoryId || !info.private || !info.permissions?.admin) throw new PilotError('Repository access or identity changed');
  const open = await pilot.accounts.gh(`repos/${run.repository}/pulls?state=open&per_page=100`);
  if (!Array.isArray(open) || open.length === 100 || open.some(pr => !Object.values(run.fixtures?.pulls ?? {}).some(item => item.marker === pr.body && item.head === pr.head.ref)))
    throw new PilotError('The dedicated pilot repository contains unrelated open PRs');
  const account = await pilot.accounts.do('account');
  if (account.account?.uuid !== run.digitaloceanAccount || account.account.status !== 'active') throw new PilotError('DigitalOcean account changed or is inactive');
  const installation = JSON.parse(await privateRead(join(run.configDirectory, 'installation.json')));
  if (!installation.slack?.enabled || installation.slack.workspaceId !== run.pilotConfig.workspaceId) throw new PilotError('Slack installation does not match the selected workspace');
  const token = String(await privateRead(join(run.configDirectory, installation.slack.tokenFile.slice('/etc/repo-chap/'.length)))).trim();
  const auth = await pilot.accounts.io.request('https://slack.com/api/auth.test', { method: 'POST', token });
  const channel = await pilot.accounts.io.request(`https://slack.com/api/conversations.info?channel=${run.pilotConfig.channelId}`, { token });
  if (!auth.ok || auth.team_id !== run.pilotConfig.workspaceId || !channel.ok || !channel.channel?.is_member || channel.channel.is_archived)
    throw new PilotError('Slack bot must belong to the selected workspace and channel');
  await pilot.ssh(run, 'sudo -u repo-chap -H env CODEX_HOME=/var/lib/repo-chap-home/pilot-codex /opt/repo-chap/current/repo-chap daemon diagnose --state-dir /var/lib/repo-chap --config /etc/repo-chap/installation.json --json >/dev/null');
  const status = await daemon(pilot, run, 'status');
  if (status.mode !== 'apply' || !status.slackEnabled || status.recovery?.paused) throw new PilotError('Daemon must have apply and Slack delivery enabled and recovery released');
  const existing = selectedRepo(status, run);
  if (existing && (existing.source?.workflowPath !== workflowPath || existing.source.branch !== run.fixtures?.defaultBranch || existing.profile !== run.pilotConfig.profile))
    throw new PilotError('Repository already has a different daemon registration');
}

async function waitFor(pilot, read, accept, description) {
  for (let poll = 0; poll < 120; poll++) {
    pilot.signal?.throwIfAborted();
    const value = await read();
    if (accept(value)) return value;
    await pilot.pause(10000);
  }
  throw new PilotError(`Timed out waiting for ${description}`);
}

export async function prepareTests(pilot, run) {
  await preflight(pilot, run);
  if (!run.testApproval) {
    const approved = await pilot.confirm(`Pilot ${run.id} will install fixtures in ${run.repository}, create two PRs, run paid provider repairs, push tested commits, and send two handoffs to ${run.pilotConfig.workspaceId}/${run.pilotConfig.channelId}.`, pilot.output);
    if (!approved) throw new PilotError('Pilot mutation approval is required');
    run.testApproval = new Date().toISOString();
    await pilot.store.save(run);
  }
  await prepareRepository(pilot, run);
  const state = run.fixtures;
  if (state.resumed) return;
  let status = await daemon(pilot, run, 'status');
  if (!selectedRepo(status, run)) {
    state.registrationAttempted = true;
    await pilot.store.save(run);
    await daemon(pilot, run, `register-source ${workflowPath} --repo ${run.repository} --profile ${run.pilotConfig.profile} --branch ${state.defaultBranch}`);
  }
  await prepareWorkflowFixtures(pilot, run);
  if (state.resumeAttempted && selectedRepo(status, run)?.paused === false) {
    state.resumed = true;
    await pilot.store.save(run);
    return;
  }
  status = await waitFor(pilot, () => daemon(pilot, run, 'status'), value => {
    const repo = selectedRepo(value, run);
    return repo?.source?.status === 'valid' && repo.source.observedRevision === state.commits.workflow &&
      Object.values(state.pulls).every(pr => value.runs.some(item => item.repositoryId === repo.id && item.number === pr.number && item.headSha === pr.initialHead && item.baseSha === pr.baseSha));
  }, 'workflow activation and draft PR discovery');
  let repo = selectedRepo(status, run);
  // If resume reached the daemon but its response was lost, do not pause again
  // or try to recapture heads that may already have been repaired.
  if (state.resumeAttempted && !repo.paused) {
    state.resumed = true;
    await pilot.store.save(run);
    return;
  }
  if (!repo.paused) {
    state.pauseAttempted = true;
    await pilot.store.save(run);
    await daemon(pilot, run, `pause --repo ${run.repository}`);
  }
  if (!state.cases) {
    const config = { version: 1, workspaceId: run.pilotConfig.workspaceId, channelId: run.pilotConfig.channelId };
    const baselines = {};
    for (const name of ['review', 'conflict']) {
      const item = state.pulls[name];
      const pr = await waitFor(pilot, () => pilot.accounts.gh(`repos/${run.repository}/pulls/${item.number}`),
        value => value.mergeable !== null, 'GitHub mergeability');
      if (!pr.draft || pr.state !== 'open' || pr.head.sha !== item.initialHead || pr.base.sha !== item.baseSha || (name === 'conflict' && pr.mergeable !== false))
        throw new PilotError('Draft fixture changed before baseline capture');
      const runs = status.runs.filter(value => value.repositoryId === repo.id && value.number === item.number && value.headSha === item.initialHead && value.baseSha === item.baseSha);
      if (runs.length !== 1) throw new PilotError('Daemon run discovery is ambiguous');
      config[name] = { pr: item.number, runId: runs[0].id, initialHead: item.initialHead, baseSha: item.baseSha,
        ...(name === 'review' ? { reviewAction: 'review' } : {}), repairAction: name === 'review' ? 'address' : 'resolve_conflict', requiredChecks: ['pilot-regression'] };
      baselines[name] = { state: 'OPEN', headRefOid: pr.head.sha, baseRefOid: pr.base.sha, mergeable: pr.mergeable ? 'MERGEABLE' : 'CONFLICTING' };
    }
    state.cases = config;
    state.baselines = baselines;
    await pilot.store.save(run);
  }
  // Record observer baselines before releasing either draft. A crash between
  // these writes is recovered using the authoritative manifest.
  const path = join(pilot.store.directory(run.id), 'workflow-test.json');
  try { await privateRead(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writePrivate(path, JSON.stringify({ version: 1, environment: run.id, repository: run.repository,
      config: state.cases, baselines: state.baselines, results: {} }, null, 2) + '\n');
  }
  for (const item of Object.values(state.pulls)) {
    const pr = await pilot.accounts.gh(`repos/${run.repository}/pulls/${item.number}`);
    if (pr.head.sha !== item.initialHead || pr.base.sha !== item.baseSha || pr.state !== 'open') throw new PilotError('Paused PR changed before ready conversion');
    if (pr.draft) {
      item.readyAttempted = true;
      await pilot.store.save(run);
      await pilot.accounts.io.command('gh', ['pr', 'ready', String(item.number), '--repo', run.repository], { signal: pilot.signal });
    }
  }
  status = await daemon(pilot, run, 'status');
  repo = selectedRepo(status, run);
  if (!repo?.paused) throw new PilotError('Repository pause was released outside this pilot');
  state.resumeAttempted = true;
  await pilot.store.save(run);
  await daemon(pilot, run, `resume --repo ${run.repository}`);
  state.resumed = true;
  await pilot.store.save(run);
}
