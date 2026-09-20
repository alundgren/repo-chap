import { join } from 'node:path';
import { PilotError } from './io.mjs';
import { privateRead, writePrivate } from './store.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const names = ['review', 'conflict'];

export function validateCases(config) {
  if (config?.version !== 1 || !/^T[A-Z0-9]+$/.test(config.workspaceId ?? '') || !/^[CG][A-Z0-9]+$/.test(config.channelId ?? ''))
    throw new PilotError('Configure the dedicated Slack workspace and channel in workflow-cases.json');
  for (const name of names) {
    const item = config[name];
    if (!item || !Number.isSafeInteger(item.pr) || item.pr < 1 || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.runId ?? '') ||
        !sha(item.initialHead) || !sha(item.baseSha) || typeof item.repairAction !== 'string' || !item.repairAction || !Array.isArray(item.requiredChecks) ||
        !item.requiredChecks.length || item.requiredChecks.some(id => typeof id !== 'string' || !id))
      throw new PilotError('Each workflow case needs a PR, run ID, original head, base, repair action, and required check IDs');
  }
  if (typeof config.review.reviewAction !== 'string' || !config.review.reviewAction || config.review.pr === config.conflict.pr || config.review.runId === config.conflict.runId)
    throw new PilotError('Use distinct review and conflict PRs and name the review action');
  return config;
}

export function verifyRepair(name, item, details, pr, repository) {
  if (details?.run?.id !== item.runId || details.run.number !== item.pr || details.inspection?.evidence?.repository?.name !== repository)
    throw new PilotError('Daemon evidence belongs to another PR');
  if (pr.state !== 'OPEN' || pr.baseRefOid !== item.baseSha || details.run.baseSha !== item.baseSha)
    throw new PilotError('The test PR closed or its base changed');
  if (details.effects?.some(effect => effect.kind === 'github.push_candidate' && ['unknown', 'sending'].includes(effect.state))) return null;
  const results = (details.results ?? []).map(note => note.result);
  const repair = results.find(result => result.job?.actionId === item.repairAction && result.job.headSha === item.initialHead &&
    result.job.baseSha === item.baseSha && result.repair?.status === 'candidate' && result.repair.requiredChecksPassed &&
    sha(result.repair.candidate?.sha) && result.repair.candidate.sha !== item.initialHead &&
    result.repair.candidate.sha === pr.headRefOid);
  if (!repair || details.run.headSha !== pr.headRefOid || !details.run.evidenceAvailable) return null;
  const candidate = repair.repair.candidate.sha;
  const checks = repair.repair.checks;
  if (!Array.isArray(checks) || !checks.length || checks.some(check => check.status !== 'passed' || check.candidateSha !== candidate) ||
      item.requiredChecks.some(id => !checks.some(check => check.id === id))) return null;
  const push = (details.effects ?? []).find(effect => effect.kind === 'github.push_candidate' && effect.state === 'confirmed' &&
    effect.expectedRevision === item.initialHead && effect.receipt?.status === 'confirmed' && effect.receipt.repository === repository &&
    effect.receipt.expectedHeadSha === item.initialHead && effect.receipt.candidateSha === candidate && effect.receipt.observedSha === candidate);
  if (!push) return null;
  if (name === 'conflict' && (pr.mergeable !== 'MERGEABLE' || !repair.repair.candidate.parents?.includes(item.baseSha))) return null;
  if (name === 'review' && !results.some(result => result.job?.actionId === item.reviewAction && result.job.headSha === item.initialHead &&
      result.job.baseSha === item.baseSha && result.provider?.outcome === 'completed' &&
      result.provider.payload?.coverage === 'complete' && ['concerns', 'blocking'].includes(result.provider.payload?.verdict) && result.provider.payload?.findings?.length)) return null;
  return { head: candidate, pushId: push.id, checks: checks.map(check => check.id) };
}

export function verifyDelivery(details, item, head, config, repository) {
  const requests = details.slack ?? [];
  if (requests.some(request => request.deliveries?.some(delivery => ['unknown', 'sending'].includes(delivery.state)))) return null;
  const request = requests.find(request => request.status === 'open' && request.runId === item.runId &&
    request.packet?.repository === repository && request.packet.prNumber === item.pr && request.packet.headSha === head &&
    request.receipt?.workspaceId === config.workspaceId && request.receipt.channelId === config.channelId &&
    /^\d+\.\d+$/.test(request.receipt.timestamp ?? '') && request.deliveries?.some(delivery =>
      ['post', 'update'].includes(delivery.operation) && delivery.state === 'confirmed' &&
      (delivery.activation ?? 0) === (request.activation ?? 0)));
  return request ? { requestId: request.id, ...request.receipt } : null;
}

async function readPr(pilot, run, item) {
  return JSON.parse(await pilot.accounts.io.command('gh', ['pr', 'view', String(item.pr), '--repo', run.repository,
    '--json', 'number,state,headRefOid,baseRefOid,mergeable'], { signal: pilot.signal }));
}

export async function runWorkflowTests(pilot, run) {
  let scenario = 'workflow prerequisites';
  let record;
  const path = join(pilot.store.directory(run.id), 'workflow-test.json');
  try {
    if (run.stage !== 'running') throw new PilotError('The environment must be running');
    const config = validateCases(JSON.parse(await privateRead(join(pilot.store.root, 'workflow-cases.json'))));
    try { record = JSON.parse(await privateRead(path)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (record && (record.environment !== run.id || record.repository !== run.repository || JSON.stringify(record.config) !== JSON.stringify(config)))
      throw new PilotError('The workflow case selection changed; retain its evidence and use a new environment');
    record ??= { version: 1, environment: run.id, repository: run.repository, config, baselines: {}, results: {} };
    const save = () => writePrivate(path, JSON.stringify(record, null, 2) + '\n');
    // Capture both original heads before waiting for either repair. A rerun only reads effects.
    for (const name of names) {
      if (record.baselines[name]) continue;
      const pr = await readPr(pilot, run, config[name]);
      if (pr.state !== 'OPEN' || pr.headRefOid !== config[name].initialHead || pr.baseRefOid !== config[name].baseSha ||
          (name === 'conflict' && pr.mergeable !== 'CONFLICTING')) throw new PilotError('Original PR state does not match the selected case');
      record.baselines[name] = pr;
      await save();
    }
    pilot.output(`${scenario}: pass`);
    await pilot.ssh(run, `sudo -u repo-chap -H /opt/repo-chap/current/repo-chap daemon resume --repo ${run.repository} --state-dir /var/lib/repo-chap --json`);
    const inspect = async item => {
      const response = JSON.parse(await pilot.ssh(run,
        `sudo -u repo-chap -H /opt/repo-chap/current/repo-chap daemon inspect ${item.runId} --state-dir /var/lib/repo-chap --json`));
      if (!response.ok) throw new PilotError('Cannot inspect the selected daemon run');
      return response.result;
    };
    for (const name of names) {
      scenario = name === 'review' ? 'code review and fix' : 'merge conflict and resolve';
      const item = config[name];
      let passed = false;
      for (let poll = 0; poll < 120; poll++) {
        pilot.signal?.throwIfAborted();
        const details = await inspect(item);
        const pr = await readPr(pilot, run, item);
        record.results[name] = { observedAt: new Date().toISOString(), details, pr };
        const repair = verifyRepair(name, item, details, pr, run.repository);
        await save();
        if (repair) { passed = true; break; }
        await pilot.pause(10000);
      }
      if (!passed) throw new PilotError('Timed out waiting for tested repair and confirmed push');
      pilot.output(`${scenario}: pass`);
    }
    scenario = 'Slack message sending';
    let receipts;
    for (let poll = 0; poll < 120; poll++) {
      pilot.signal?.throwIfAborted();
      receipts = [];
      for (const name of names) {
        const item = config[name];
        const details = await inspect(item);
        const pr = await readPr(pilot, run, item);
        record.results[name] = { observedAt: new Date().toISOString(), details, pr };
        const repair = verifyRepair(name, item, details, pr, run.repository);
        receipts.push(repair && verifyDelivery(details, item, repair.head, config, run.repository));
      }
      await save();
      if (receipts.every(Boolean)) break;
      await pilot.pause(10000);
    }
    if (receipts.some(receipt => !receipt) || receipts[0].timestamp === receipts[1].timestamp)
      throw new PilotError('Expected distinct current Slack messages for both repaired PRs');
    record.receipts = receipts;
    record.status = 'passed';
    delete record.failedScenario;
    delete record.reason;
    await save();
    pilot.output(`${scenario}: pass`);
    return true;
  } catch (error) {
    if (record) {
      record.status = 'failed';
      record.failedScenario = scenario;
      record.reason = error instanceof PilotError ? error.message : 'Cannot read workflow evidence';
      await writePrivate(path, JSON.stringify(record, null, 2) + '\n');
    }
    pilot.output(`${scenario}: fail`);
    return false;
  }
}
