import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { loadWorkflow, replay } from '@repo-chap/workflow';
import type { ReplayFixture } from '@repo-chap/workflow';
import { previewReplayHandoffs } from '@repo-chap/slack';
import { DocumentSession } from '../apps/desktop/src/documents.ts';
import { decisionPacket } from './helpers/slack-fixture.ts';

const workflowPath = 'docs/pr-workflows/examples/team-pr/workflow.json';
const reviewPath = 'docs/pr-workflows/examples/team-pr/review.md';
const pkg = await loadWorkflow(resolve(workflowPath));
const handoff = JSON.parse(await readFile('fixtures/replay/handoff.json', 'utf8')) as ReplayFixture;
const conflict = JSON.parse(await readFile('fixtures/replay/conflict.json', 'utf8')) as ReplayFixture;
async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<{ root: string; session: DocumentSession }> {
  const root = await mkdtemp(join(tmpdir(), 'repo-chap-simulation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of pkg.files) { await mkdir(dirname(join(root, file.path)), { recursive: true }); await writeFile(join(root, file.path), file.text); }
  return { root, session: await DocumentSession.open(join(root, workflowPath), root) };
}
const text = (session: DocumentSession): string => session.snapshot().files.find(file => file.path === workflowPath)!.text;
function input(session: DocumentSession, value: ReplayFixture): void { session.setSimulationInput(session.snapshot(), 'fixture', JSON.stringify(value), 'fictional-fixture.json'); }

test('visual priority edits preserve IDs, unknown layout data and saved source, then change replay and save', async t => {
  const { session, root } = await fixture(t);
  const workflow = JSON.parse(text(session)); workflow.layout = { futureData: { coordinates: [1, 2], custom: 'keep' } };
  await session.edit(session.snapshot(), workflowPath, JSON.stringify(workflow, null, 4));
  await session.save(session.snapshot());
  const savedText = text(session), savedDigest = session.snapshot().packageDigest;
  const both = structuredClone(conflict); both.observations[0]!.facts.unaddressedReview = true; both.results = {};
  input(session, both); session.simulate(session.snapshot());
  assert.equal(session.snapshot().simulation!.result.decisions[0]!.actionId, 'resolve_conflict');
  const reviewIndex = workflow.rules.findIndex((rule: { action: string }) => rule.action === 'address');
  const conflictIndex = workflow.rules.findIndex((rule: { id: string }) => rule.id === 'conflict');
  const reviewId = workflow.rules[reviewIndex].id;
  await session.visualEdit(session.snapshot(), { kind: 'moveRule', ruleId: reviewId, toIndex: conflictIndex });
  assert.equal(session.snapshot().simulationCurrent, false);
  assert.deepEqual(JSON.parse(text(session)).rules.map((r: { id: string }) => r.id).sort(), workflow.rules.map((r: { id: string }) => r.id).sort());
  assert.deepEqual(JSON.parse(text(session)).layout, workflow.layout);
  assert.equal(await readFile(join(root, workflowPath), 'utf8'), savedText);
  assert.notEqual(session.snapshot().packageDigest, savedDigest);
  assert.ok(session.snapshot().semanticChanges.some(change => change.path === '/rules/order'));
  session.simulate(session.snapshot()); assert.equal(session.snapshot().simulation!.result.decisions[0]!.actionId, 'address');
  await session.save(session.snapshot()); assert.equal(session.snapshot().semanticChanges.length, 0);
  assert.equal(session.snapshot().simulationCurrent, true);
  const reopened = await DocumentSession.open(join(root, workflowPath), root);
  input(reopened, both); reopened.simulate(reopened.snapshot());
  assert.deepEqual(reopened.snapshot().simulation!.result, session.snapshot().simulation!.result);
});

test('timing and action references use shared validation with context changes, reset and unsupported-data recovery', async t => {
  const { session, root } = await fixture(t);
  await session.visualEdit(session.snapshot(), { kind: 'setting', field: 'reviewWaitSeconds', value: 60 });
  assert.equal(session.snapshot().workflow!.settings.reviewWaitSeconds, 60);
  assert.ok(session.snapshot().semanticChanges.some(change => change.path === '/settings/reviewWaitSeconds'));
  await session.edit(session.snapshot(), reviewPath, '# Changed review context\n');
  assert.ok(session.snapshot().semanticChanges.some(change => change.path === reviewPath));
  await session.visualEdit(session.snapshot(), { kind: 'context', actionId: 'review', value: ['missing.md'] });
  assert.ok(session.snapshot().diagnostics.length);
  assert.throws(() => session.simulate(session.snapshot()), /validation errors/);
  assert.throws(() => session.exportText(session.snapshot()), /validation errors/);
  await session.reset(session.snapshot());
  assert.equal(session.snapshot().packageDigest, pkg.digest);
  assert.equal(session.snapshot().semanticChanges.length, 0);
  assert.equal(session.dirty, false);
  await session.visualEdit(session.snapshot(), { kind: 'action', actionId: 'review', field: 'onSuccess', value: 'missing_action' });
  assert.ok(session.snapshot().diagnostics.some(d => d.code === 'action_reference'));
  await session.reset(session.snapshot());
  const unsupported = { ...JSON.parse(text(session)), futureRuntimeData: { exact: ['keep', 5] } };
  await session.edit(session.snapshot(), workflowPath, JSON.stringify(unsupported));
  await session.visualEdit(session.snapshot(), { kind: 'moveRule', ruleId: 'conflict', toIndex: 0 });
  assert.deepEqual(JSON.parse(text(session)).futureRuntimeData, unsupported.futureRuntimeData);
  assert.ok(session.snapshot().diagnostics.length);
  assert.throws(() => session.exportText(session.snapshot()), /validation errors/);
  await session.reset(session.snapshot());
  await session.edit(session.snapshot(), workflowPath, '{ broken');
  assert.throws(() => session.exportText(session.snapshot()), /validation errors/);
  assert.equal(await readFile(join(root, workflowPath), 'utf8'), pkg.files.find(file => file.path === workflowPath)!.text);
  await session.reset(session.snapshot());
  assert.equal(session.exportText(session.snapshot()), text(session));
});

test('layout and formatting leave execution identity current; source, context, fixture, packet changes make it stale', async t => {
  const { session } = await fixture(t); input(session, handoff); session.simulate(session.snapshot());
  const first = session.snapshot().simulation!;
  const workflow = JSON.parse(text(session)); workflow.layout = { nodes: { conflict: [150, 200] } };
  await session.edit(session.snapshot(), workflowPath, JSON.stringify(workflow, null, 4));
  assert.equal(session.snapshot().simulationCurrent, true); assert.equal(session.snapshot().semanticChanges.length, 0);
  assert.notEqual(session.snapshot().revision, first.token.revision);
  await session.edit(session.snapshot(), reviewPath, '# Different context\n');
  assert.equal(session.snapshot().simulationCurrent, false);
  session.simulate(session.snapshot()); assert.equal(session.snapshot().simulationCurrent, true);
  session.setClock(session.snapshot(), '2026-05-01T12:05:00Z'); assert.equal(session.snapshot().simulationCurrent, false);
  session.resetSimulationInput(session.snapshot(), 'fixture'); assert.equal(session.snapshot().simulationCurrent, true);
  session.setSimulationInput(session.snapshot(), 'packets', JSON.stringify({ ...decisionPacket, headSha: handoff.observations[0]!.headSha }), 'packet.json');
  assert.equal(session.snapshot().simulationCurrent, false);
  session.simulate(session.snapshot()); assert.equal(session.snapshot().simulationCurrent, true);
});

test('replay exposes waits, unknown facts, missing stubs/observations and retained limits without adapters', async t => {
  const { session } = await fixture(t);
  const cases: [ReplayFixture, RegExp][] = [];
  const pending = structuredClone(handoff); pending.observations[0]!.facts.externalReviewPending = true; pending.observations[0]!.externalReviewStartedAt = '2026-05-01T11:55:00Z'; cases.push([pending, /reviewer/i]);
  const incomplete = structuredClone(handoff); incomplete.observations[0]!.facts.evidenceComplete = false; cases.push([incomplete, /refresh|evidence/i]);
  const unknown = structuredClone(conflict); delete unknown.observations[0]!.facts.conflict; cases.push([unknown, /fixture.results.handoff/]);
  const missing = structuredClone(conflict); missing.results = {}; cases.push([missing, /fixture.results.resolve_conflict/]);
  const budget = structuredClone(conflict); budget.control!.repairsThisLifecycle = 99; cases.push([budget, /budget is exhausted/]);
  cases.push([conflict, /another observation/]);
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Network forbidden'); });
  for (const [value, reason] of cases) {
    input(session, value); session.simulate(session.snapshot());
    const actual = session.snapshot().simulation!.result;
    assert.deepEqual(actual, replay(pkg, value)); assert.match(actual.reason, reason);
    if (value === pending) assert.equal(actual.nextWakeAt, '2026-05-01T12:05:00.000Z');
    if (value === unknown) { assert.ok(actual.decisions[0]!.rules.some(rule => rule.condition.value === 'unknown')); assert.equal(actual.proposedEffects.at(-1)?.outcome, 'blocked_execution'); }
    assert.ok(actual.decisions[0]!.rules.length);
  }
  assert.equal(fetch.mock.callCount(), 0);
  const bundled = await build({ entryPoints: ['apps/desktop/src/documents.ts'], bundle: true, platform: 'node', write: false, metafile: true });
  assert.deepEqual(Object.keys(bundled.metafile!.inputs).filter(path => /packages\/(providers|github|execution|runtime|daemon)\/|slack\/.*web-api/.test(path)), []);
});

test('exact fixture/package/clock and complete packet produce built CLI parity with long unmapped Slack preview', async t => {
  const { session, root } = await fixture(t);
  const value = structuredClone(handoff); value.observations[0]!.facts.conflict = true; value.control!.memory!.repairSuppressed = false;
  const workflow = JSON.parse(text(session));
  workflow.rules.unshift({ id: 'fixture_handoff', when: { field: 'facts.conflict', op: 'eq', value: true }, action: 'handoff' });
  await session.edit(session.snapshot(), workflowPath, JSON.stringify(workflow)); await session.save(session.snapshot());
  const packet = { ...decisionPacket, authorLogin: 'unmapped-cedar', outcome: 'needs_author' as const, headSha: value.observations[0]!.headSha!, findings: ['A long finding. '.repeat(1600)] };
  input(session, value); session.setSimulationInput(session.snapshot(), 'packets', JSON.stringify(packet), 'packet.json'); session.simulate(session.snapshot());
  const result = session.snapshot().simulation!;
  assert.equal(result.previewError, null); assert.equal(result.handoffs[0]!.preview.route.fallback, true);
  assert.ok(result.handoffs[0]!.preview.omissions.length); assert.equal(result.handoffs[0]!.packet.findings[0], packet.findings[0]);
  const fixturePath = join(root, 'fixture.json'), packetPath = join(root, 'packet.json');
  await writeFile(fixturePath, JSON.stringify(value)); await writeFile(packetPath, JSON.stringify(packet));
  const cli = JSON.parse(execFileSync(process.execPath, [resolve('apps/cli/dist/cli.js'), 'replay', join(root, workflowPath), '--repo-root', root, '--fixture', fixturePath, '--packet', packetPath, '--json'], { encoding: 'utf8' }));
  assert.deepEqual(cli, { ...result.result, handoffs: result.handoffs });
  const active = await loadWorkflow(join(root, workflowPath), { repositoryRoot: root });
  assert.deepEqual(result.handoffs, previewReplayHandoffs(result.result, [packet], active.workflow.slack));
  session.setSimulationInput(session.snapshot(), 'packets', '[]'); session.simulate(session.snapshot());
  assert.match(session.snapshot().simulation!.previewError!, /exactly one packet/);
  assert.equal(session.snapshot().simulation!.handoffs.length, 0);
});

test('stale tokens reject visual, fixture, clock, reset, simulate and export without overwriting newer input', async t => {
  const { session } = await fixture(t); const old = session.snapshot(); input(session, handoff);
  await assert.rejects(session.visualEdit(old, { kind: 'moveRule', ruleId: 'conflict', toIndex: 0 }), /revision changed/);
  await assert.rejects(session.reset(old), /revision changed/);
  assert.throws(() => session.setClock(old, handoff.now), /revision changed/);
  assert.throws(() => session.setSimulationInput(old, 'fixture', '{}'), /revision changed/);
  assert.throws(() => session.resetSimulationInput(old, 'fixture'), /revision changed/);
  assert.throws(() => session.simulate(old), /revision changed/);
  assert.throws(() => session.exportText(old), /revision changed/);
  const current = session.snapshot(); assert.throws(() => session.setClock(current, '2026-02-30T12:00:00Z'));
  assert.deepEqual(session.snapshot(), current);
});
