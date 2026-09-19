import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { RuntimeStore, type EffectState } from '@repo-chap/runtime';
import { packetForRun } from '@repo-chap/daemon';
import { canonicalJson, digest } from '@repo-chap/workflow';
import { validatePacket } from '@repo-chap/slack';
import { setup } from './helpers/provider-fixture.ts';
import { completed } from './helpers/daemon-remote.ts';

async function fixture(partial = false) {
  const s = await setup(), store = await RuntimeStore.open(join(s.temporary, 'state')), now = Date.now();
  s.inspection.evidence.checks.items.push({ id: 'CHECK_value', kind: 'CheckRun', name: 'value', status: 'COMPLETED', conclusion: 'SUCCESS', url: null });
  s.inspection.evidenceDigest = digest(canonicalJson(s.inspection.evidence)); s.inspection.fixture.observations[0]!.evidenceDigest = s.inspection.evidenceDigest;
  const repo = await store.register({ id: 'R_paperboat', name: 'reef-labs/paperboat', package: s.pkg, profile: 'pilot', reviewers: [] }, now), run = (await store.observe(repo.id, s.inspection, now))!;
  for (const actionId of ['classify', 'review']) {
    const claim = store.claim(run.id, 'packet-test', now, 300)!, job = store.reserve(claim, { actionId, sources: await store.artifacts.put({ fixture: true }), profile: 'pilot', profileDigest: digest('fixture'), package: s.pkg }, now);
    const result = completed(job);
    if (partial && actionId === 'review') Object.assign(result.provider.payload!, { coverage: 'partial', verdict: 'inconclusive', missingEvidence: ['The caller is unavailable.'] });
    await store.complete(claim, result, now);
  }
  const packet = () => packetForRun(store, store.run(run.id), s.pkg, s.inspection, now);
  const publication = async (kind: 'review.publish' | 'labels.set', state: Exclude<EffectState, 'planned' | 'sending'>) => {
    const claim = store.claim(run.id, 'publication', now, 300)!, current = store.run(run.id);
    const id = store.planEffect(claim, { kind, destination: repo.name, expectedRevision: s.head, evidenceKey: current.evidenceKey, payload: await store.artifacts.put({ kind }) }, now);
    const lease = store.beginEffect(claim, id, 1, now);
    store.finishEffect(lease, state, { schemaVersion: 1, kind, marker: id, outcome: state, freshness: 'current', reason: `${kind} ${state}.`, expectedHeadSha: s.head, observedHeadSha: s.head, expectedBaseSha: s.base, observedBaseSha: s.base, reobserve: false, retryable: false, remote: null,
      ...(kind === 'review.publish' ? { analysis: { coverage: partial ? 'partial' : 'complete', verdict: partial ? 'inconclusive' : 'acceptable', missingEvidence: partial ? ['The caller is unavailable.'] : [] } } : {}) }, now);
    store.park(claim, 'ready', 'Retained publication.', now, current.control, 'handoff', now); return id;
  };
  return { ...s, store, now, repo, run, packet, publication, cleanup: async () => { store.close(); await s.cleanup(); } };
}
test('host readiness requires accepted current review, classification and checks and respects current action failures', async () => {
  const s = await fixture();
  try {
    assert.equal(validatePacket(await s.packet()).outcome, 'ready_for_human_merge');
    await s.publication('review.publish', 'confirmed'); assert.equal((await s.packet()).outcome, 'ready_for_human_merge');
    const claim = s.store.claim(s.run.id, 'publication-failure', s.now, 300)!;
    s.store.continuePublication(claim, 'publish_review', 'handoff', 'Citation is outside the pinned diff.', false, s.now);
    const failed = await s.packet(); assert.equal(failed.outcome, 'blocked_execution'); assert.match(failed.reason, /publish_review/); assert.match(failed.uncertainty.join(' '), /failed for current evidence/);
    assert.match(failed.findings.join(' '), /Review publication.*confirmed/);
    s.inspection.evidence.pullRequest!.body = 'New human evidence'; s.inspection.evidenceDigest = digest(canonicalJson(s.inspection.evidence)); s.inspection.fixture.observations[0]!.evidenceDigest = s.inspection.evidenceDigest;
    await s.store.observe(s.repo.id, s.inspection, s.now + 1000);
    const stale = await s.packet(); assert.equal(stale.outcome, 'blocked_execution'); assert.match(stale.findings.join(' '), /current freshness stale.*historically current/); assert.match(stale.uncertainty.join(' '), /No accepted review/);
  } finally { await s.cleanup(); }
});
test('partial, rejected and unknown publications stay distinct in the complete packet', async () => {
  const s = await fixture(true);
  try {
    await s.publication('review.publish', 'confirmed'); await s.publication('labels.set', 'unknown');
    const packet = await s.packet(); assert.equal(packet.outcome, 'blocked_execution'); assert.match(packet.findings.join(' '), /Published review: partial, inconclusive/); assert.match(packet.findings.join(' '), /Label publication.*unknown/); assert.ok(packet.uncertainty.includes('The caller is unavailable.'));
  } finally { await s.cleanup(); }
  const rejected = await fixture();
  try {
    await rejected.publication('review.publish', 'rejected'); const packet = await rejected.packet();
    assert.equal(packet.outcome, 'blocked_execution'); assert.match(packet.findings.join(' '), /Review publication.*rejected/);
  } finally { await rejected.cleanup(); }
});


test('CI handoffs identify failures and never recommend merge with pending or unknown checks', async () => {
  const s = await fixture();
  try {
    const check = s.inspection.evidence.checks.items[0]!;
    check.conclusion = 'FAILURE';
    let packet = await s.packet();
    assert.equal(packet.outcome, 'needs_author'); assert.match(packet.reason, /failed CI/);
    check.status = 'IN_PROGRESS'; check.conclusion = null;
    packet = await s.packet(); assert.equal(packet.outcome, 'blocked_execution'); assert.equal(packet.checks[0]!.status, 'pending');
    check.status = 'COMPLETED'; check.conclusion = 'UNRECOGNIZED';
    packet = await s.packet(); assert.equal(packet.outcome, 'blocked_execution'); assert.equal(packet.checks[0]!.status, 'not_run');
    s.inspection.evidence.checks.items = [];
    assert.equal((await s.packet()).outcome, 'blocked_execution');
  } finally { await s.cleanup(); }
});
