import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './pilot-fixture.mjs';
import { writePrivate } from '../deploy/pilot/store.mjs';
import { runWorkflowTests, validateCases, verifyRepair, verifyDelivery } from '../deploy/pilot/workflow-tests.mjs';
import { runAllTests } from '../deploy/pilot/tests.mjs';

const initialHead = 'a'.repeat(40), baseSha = 'b'.repeat(40), head = 'c'.repeat(40);
const repository = 'example-team/pilot-test';

test('the pilot test command has one ordered list of every suite', async () => {
  const calls = [];
  const saved = [];
  const pilot = { output: text => calls.push(text), store: { save: async run => saved.push(run.test?.status ?? 'setup') } };
  const run = {};
  const first = async () => { calls.push('runner'); return true; };
  const second = async () => { calls.push('workflows'); return true; };
  const setup = async () => { calls.push('setup'); return true; };
  assert.equal(await runAllTests(pilot, run, [first, second], setup), true);
  assert.deepEqual(calls, ['setup', 'repository setup: pass', 'runner', 'workflows']);
  assert.equal(run.test.status, 'passed');
  calls.length = 0;
  assert.equal(await runAllTests(pilot, run, [async () => { calls.push('failed'); return false; }, second], setup), false);
  assert.deepEqual(calls, ['setup', 'repository setup: pass', 'failed']);
  assert.equal(run.test.status, 'failed');
  assert.deepEqual(saved, ['passed', 'failed']);
});
function example() {
  const item = { pr: 1, runId: 'run-review', initialHead, baseSha, reviewAction: 'review', repairAction: 'address', requiredChecks: ['regression'] };
  const config = { version: 1, workspaceId: 'TFOREST', channelId: 'CPAPERBOAT', review: item,
    conflict: { ...item, pr: 2, runId: 'run-conflict', repairAction: 'resolve_conflict' } };
  const pr = { state: 'OPEN', headRefOid: head, baseRefOid: baseSha, mergeable: 'MERGEABLE' };
  const details = {
    run: { id: item.runId, number: item.pr, headSha: head, baseSha, evidenceAvailable: true },
    inspection: { evidence: { repository: { name: repository } } },
    results: [
      { result: { job: { actionId: 'review', headSha: initialHead, baseSha }, provider: { outcome: 'completed', payload: { coverage: 'complete', verdict: 'concerns', findings: [{ title: 'Incorrect discount' }] } } } },
      { result: { job: { actionId: 'address', headSha: initialHead, baseSha }, repair: { status: 'candidate', requiredChecksPassed: true,
        candidate: { sha: head, parents: [initialHead, baseSha] }, checks: [{ id: 'regression', candidateSha: head, status: 'passed' }] } } },
    ],
    effects: [{ id: 'push-1', kind: 'github.push_candidate', state: 'confirmed', expectedRevision: initialHead,
      receipt: { status: 'confirmed', repository, expectedHeadSha: initialHead, candidateSha: head, observedSha: head } }],
    slack: [{ id: 'request-1', runId: item.runId, status: 'open', packet: { repository, prNumber: 1, headSha: head },
      receipt: { workspaceId: config.workspaceId, channelId: config.channelId, timestamp: '123456.000001' },
      deliveries: [{ operation: 'post', state: 'confirmed' }] }],
  };
  return { item, config, pr, details };
}

test('review repair requires a finding, tested candidate and matching confirmed push', () => {
  const { item, pr, details } = example();
  assert.equal(verifyRepair('review', item, details, pr, repository).head, head);
  for (const mutate of [
    d => { d.results[0].result.provider.payload.findings = []; },
    d => { d.results[0].result.job.headSha = head; },
    d => { d.results[1].result.repair.checks[0].candidateSha = initialHead; },
    d => { d.results[1].result.repair.checks = []; },
    d => { d.results[1].result.repair.checks[0].status = 'failed'; },
    d => { d.effects[0].state = 'unknown'; },
    d => { d.effects[0].receipt.observedSha = initialHead; },
    d => { d.run.headSha = initialHead; },
  ]) {
    const copy = structuredClone(details); mutate(copy);
    assert.equal(verifyRepair('review', item, copy, pr, repository), null);
  }
  assert.equal(verifyRepair('review', item, details, { ...pr, headRefOid: 'd'.repeat(40) }, repository), null);
  assert.throws(() => verifyRepair('review', item, details, { ...pr, baseRefOid: head }, repository));
});

test('conflict repair requires a mergeable head incorporating the captured base', () => {
  const { item, pr, details } = example();
  assert.ok(verifyRepair('conflict', item, details, pr, repository));
  assert.equal(verifyRepair('conflict', item, details, { ...pr, mergeable: 'CONFLICTING' }, repository), null);
  details.results[1].result.repair.candidate.parents = [initialHead];
  assert.equal(verifyRepair('conflict', item, details, pr, repository), null);
});

test('Slack evidence requires the current PR, channel, workspace and confirmed activation', () => {
  const { item, config, details } = example();
  assert.ok(verifyDelivery(details, item, head, config, repository));
  for (const mutate of [
    r => { r.status = 'superseded'; }, r => { r.packet.headSha = initialHead; },
    r => { r.receipt.channelId = 'COTHER'; }, r => { r.receipt.workspaceId = 'TOTHER'; },
    r => { r.deliveries[0].state = 'unknown'; }, r => { r.deliveries[0].operation = 'supersede'; },
    r => { r.activation = 1; }, r => { r.receipt.timestamp = ''; },
  ]) {
    const copy = structuredClone(details); mutate(copy.slack[0]);
    assert.equal(verifyDelivery(copy, item, head, config, repository), null);
  }
});

test('case configuration rejects unsafe run IDs and reused PRs', () => {
  const { config } = example();
  assert.equal(validateCases(config), config);
  assert.throws(() => validateCases({ ...config, conflict: config.review }));
  config.review.runId = 'run; unexpected';
  assert.throws(() => validateCases(config));
});

async function workflowFixture(t) {
  const f = await fixture(t);
  f.run.stage = 'running';
  const { config, details, pr } = example();
  await writePrivate(join(f.root, 'workflow-cases.json'), JSON.stringify(config));
  let repaired = false;
  const snapshots = {};
  for (const name of ['review', 'conflict']) {
    const item = config[name], snapshot = structuredClone(details);
    Object.assign(snapshot.run, { id: item.runId, number: item.pr });
    snapshot.results[1].result.job.actionId = item.repairAction;
    snapshot.slack[0].runId = item.runId;
    snapshot.slack[0].packet.prNumber = item.pr;
    snapshot.slack[0].receipt.timestamp = `123456.00000${item.pr}`;
    snapshots[name] = snapshot;
  }
  f.accounts.io.command = async (file, args) => {
    assert.equal(file, 'gh'); assert.equal(args[0], 'pr'); assert.equal(args[1], 'view');
    return JSON.stringify(repaired ? pr : { ...pr, headRefOid: initialHead, mergeable: args[2] === '2' ? 'CONFLICTING' : 'MERGEABLE' });
  };
  f.pilot.ssh = async (run, command) => {
    repaired = true;
    return JSON.stringify({ ok: true, result: snapshots[command.includes('run-conflict') ? 'conflict' : 'review'] });
  };
  return { ...f, config, snapshots };
}

test('workflow suite captures baselines, checks both repairs and Slack, and resumes with reads only', async t => {
  const f = await workflowFixture(t);
  assert.equal(await runWorkflowTests(f.pilot, f.run), true);
  assert.deepEqual(f.state.output, ['workflow prerequisites: pass', 'code review and fix: pass', 'merge conflict and resolve: pass', 'Slack message sending: pass']);
  assert.equal(await runWorkflowTests(f.pilot, f.run), true);
  const record = JSON.parse(await readFile(join(f.store.directory(f.run.id), 'workflow-test.json'), 'utf8'));
  assert.equal(record.baselines.conflict.mergeable, 'CONFLICTING');
  assert.equal(record.receipts.length, 2);
  assert.equal(record.status, 'passed');
});

test('missing Slack delivery fails its own scenario and retains repair evidence', async t => {
  const f = await workflowFixture(t);
  f.snapshots.conflict.slack[0].deliveries[0].state = 'rejected';
  assert.equal(await runWorkflowTests(f.pilot, f.run), false);
  assert.equal(f.state.output.at(-1), 'Slack message sending: fail');
  const record = JSON.parse(await readFile(join(f.store.directory(f.run.id), 'workflow-test.json'), 'utf8'));
  assert.ok(record.results.review.details.effects.length);
  f.snapshots.conflict.slack[0].deliveries[0].state = 'confirmed';
  assert.equal(await runWorkflowTests(f.pilot, f.run), true);
});


test('baseline mismatch fails without accepting a pre-repaired branch', async t => {
  const f = await workflowFixture(t);
  f.accounts.io.command = async () => JSON.stringify({ state: 'OPEN', headRefOid: head, baseRefOid: baseSha, mergeable: 'MERGEABLE' });
  assert.equal(await runWorkflowTests(f.pilot, f.run), false);
  assert.deepEqual(f.state.output, ['workflow prerequisites: fail']);
});

test('unknown Slack outcome remains a delivery failure without hiding a successful repair', async t => {
  const f = await workflowFixture(t);
  f.snapshots.review.slack[0].deliveries[0].state = 'unknown';
  f.snapshots.review.effects.push({ kind: 'slack.post', state: 'unknown' });
  assert.equal(await runWorkflowTests(f.pilot, f.run), false);
  assert.deepEqual(f.state.output, ['workflow prerequisites: pass', 'code review and fix: pass', 'merge conflict and resolve: pass', 'Slack message sending: fail']);
});
