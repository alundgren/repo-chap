import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCases, verifyRepair, verifyDelivery, verifyProgress } from '../deploy/pilot/workflow-tests.mjs';

const initialHead = 'a'.repeat(40), baseSha = 'b'.repeat(40), head = 'c'.repeat(40);
const repository = 'example-team/pilot-test';

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


test('pilot stops on a suppressed repair but keeps waiting for active or stale work', () => {
  const { item, details } = example();
  Object.assign(details.run, { headSha: initialHead, status: 'waiting', nextAction: '$wait', owner: null, control: { memory: { repairSuppressed: true } } });
  assert.throws(() => verifyProgress(details, item), /cannot continue automatically/);
  for (const change of [{ owner: 'worker' }, { nextAction: 'handoff' }, { headSha: head }, { baseSha: head }, { evidenceAvailable: false }]) {
    const copy = structuredClone(details); Object.assign(copy.run, change);
    assert.doesNotThrow(() => verifyProgress(copy, item));
  }
});
