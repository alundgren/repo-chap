import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { compareReplay, loadWorkflow, parseFixture, replay } from '@repo-chap/workflow';
import { DocumentSession } from '../apps/desktop/src/documents.ts';
import { AuthoringTools } from '../apps/desktop/src/authoring-tools.ts';
import type { AuthoringAction, AuthoringOperation } from '../apps/desktop/src/authoring-protocol.ts';

const workflowPath = 'docs/pr-workflows/examples/team-pr/workflow.json';
const markdownPath = 'docs/pr-workflows/examples/team-pr/review.md';
const pkg = await loadWorkflow(resolve(workflowPath));
const fixtureText = JSON.stringify({ schemaVersion: 1, now: '2026-05-01T12:00:00Z', observations: [{ facts: { lifecycle: 'open', draft: true } }], expected: { status: 'waiting', selectedRuleIds: ['draft'], proposedEffects: [] } }, null, 2) + '\n';
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'repo-chap-authoring-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of pkg.files) { await mkdir(dirname(join(root, file.path)), { recursive: true }); await writeFile(join(root, file.path), file.text); }
  const source = await DocumentSession.open(join(root, workflowPath), root);
  let next = 0;
  const operation = (action: AuthoringAction): AuthoringOperation => ({ operationId: `operation-${++next}`, expected: { sessionId: source.sessionId, revision: source.revision }, action });
  const author = (action: AuthoringAction) => source.author(operation(action));
  return { root, source, operation, author };
}
const text = (source: DocumentSession, path = workflowPath) => source.snapshot().files.find(file => file.path === path)!.text;

test('typed authoring keeps atomic drafts, stale context, duplicate receipts, one undo group and explicit save/discard', async t => {
  const f = await setup(t), initial = text(f.source);
  const edit = f.operation({ kind: 'edit', changes: [{ path: workflowPath, text: '{ broken JSON' }, { path: markdownPath, text: '# Fictional staged review\n' }] });
  const result = await f.source.author(edit);
  assert.equal(result.receipt.status, 'applied'); assert.equal(f.source.snapshot().undoCount, 1);
  assert.ok(f.source.snapshot().diagnostics.length); assert.equal(text(f.source), '{ broken JSON');
  assert.equal(await readFile(join(f.root, workflowPath), 'utf8'), initial);
  const duplicate = await f.source.author(edit);
  assert.deepEqual(duplicate.receipt, result.receipt); assert.equal(f.source.snapshot().undoCount, 1);
  const stale = await f.source.author({ ...edit, operationId: 'stale' });
  assert.equal(stale.receipt.status, 'rejected'); assert.equal(stale.context.token.revision, f.source.revision);
  await f.source.undo(f.source.snapshot());
  assert.equal(text(f.source), initial); assert.equal(f.source.snapshot().files.some(file => file.dirty), false);
  const rejectedBatch = await f.author({ kind: 'edit', changes: [{ path: markdownPath, text: 'must not apply' }, { path: 'missing.md', text: 'not loaded' }] });
  assert.equal(rejectedBatch.receipt.status, 'rejected'); assert.notEqual(text(f.source, markdownPath), 'must not apply');
  await f.author({ kind: 'createFixture', path: 'case.json', text: fixtureText });
  await assert.rejects(readFile(join(f.root, 'case.json')));
  await f.source.save(f.source.snapshot());
  assert.equal(await readFile(join(f.root, 'case.json'), 'utf8'), fixtureText); assert.equal(f.source.snapshot().undoCount, 0);
  await f.source.edit(f.source.snapshot(), 'case.json', '{ invalid');
  assert.ok(f.source.snapshot().diagnostics.some(item => item.file === 'case.json'));
  await f.source.discard(f.source.snapshot(), 'case.json'); assert.equal(text(f.source, 'case.json'), fixtureText);
  const reopened = await DocumentSession.open(join(f.root, workflowPath), f.root);
  await reopened.openTestFixture(reopened.snapshot(), join(f.root, 'case.json'));
  assert.equal(text(reopened, 'case.json'), fixtureText);
});

test('actual expectation failures, revisions and CLI parity stay distinct from successful replay', async t => {
  const f = await setup(t);
  const initial = parseFixture(JSON.parse(fixtureText));
  const actual = replay(pkg, initial);
  initial.expected!.selectedRuleIds = actual.decisions.map(item => item.ruleId);
  initial.expected!.status = 'closed';
  await f.author({ kind: 'createFixture', path: 'case.json', text: JSON.stringify(initial) });
  const first = await f.author({ kind: 'test', fixturePath: 'case.json' });
  assert.equal(first.receipt.status, 'completed'); assert.equal(f.source.snapshot().simulation!.comparison!.passed, false);
  const evidence = f.source.snapshot().simulation!;
  initial.expected!.status = actual.status;
  await f.author({ kind: 'edit', changes: [{ path: 'case.json', text: JSON.stringify(initial) }] });
  assert.equal(f.source.snapshot().simulationCurrent, false); assert.deepEqual(f.source.snapshot().simulation, evidence);
  await f.author({ kind: 'test', fixturePath: 'case.json' });
  const record = f.source.snapshot().simulation!;
  assert.equal(record.comparison!.passed, true); assert.equal(f.source.snapshot().files.find(file => file.path === 'case.json')!.dirty, true);
  await f.source.save(f.source.snapshot()); assert.equal(f.source.snapshot().simulationCurrent, true);
  const cli = JSON.parse(execFileSync(process.execPath, [resolve('apps/cli/dist/cli.js'), 'replay', join(f.root, workflowPath), '--repo-root', f.root, '--fixture', join(f.root, 'case.json'), '--json'], { encoding: 'utf8' }));
  assert.deepEqual(cli, { ...record.result, comparison: record.comparison });
  const incomplete = { ...actual, status: 'needs_result' as const };
  assert.equal(compareReplay(incomplete, { ...initial.expected!, status: 'needs_result' }).passed, false);
  delete initial.expected;
  await f.source.edit(f.source.snapshot(), 'case.json', JSON.stringify(initial));
  assert.equal((await f.author({ kind: 'test', fixturePath: 'case.json' })).receipt.status, 'rejected');
});

test('renderer acknowledgment is separate from mutation, cancellation and later provider failure', async t => {
  const f = await setup(t); let requestId = '';
  const host = new AuthoringTools(() => f.source, id => { requestId = id; });
  const tool = host.tools(f.source)[0]!;
  const signal = new AbortController();
  const edit = f.operation({ kind: 'edit', changes: [{ path: markdownPath, text: '# Applied before provider failure\n' }] });
  const response = tool.execute(edit, { id: 'provider-call-1', signal: signal.signal });
  await host.apply(requestId, f.source.snapshot());
  signal.abort();
  const applied = JSON.parse((await response).text);
  assert.equal(applied.receipt.status, 'applied'); assert.equal(applied.receipt.display, 'unconfirmed');
  assert.equal(text(f.source, markdownPath), '# Applied before provider failure\n');
  const repeated = JSON.parse((await tool.execute(edit, { id: 'duplicate-call', signal: new AbortController().signal })).text);
  assert.deepEqual(repeated.receipt, applied.receipt); assert.equal(f.source.snapshot().undoCount, 1);
  await f.source.undo(f.source.snapshot()); assert.notEqual(text(f.source, markdownPath), '# Applied before provider failure\n');
  const next = f.operation({ kind: 'edit', changes: [{ path: markdownPath, text: 'pending' }] }), cancel = new AbortController();
  const pending = tool.execute(next, { id: 'provider-call-2', signal: cancel.signal });
  cancel.abort(); assert.equal(JSON.parse((await pending).text).receipt.status, 'cancelled');
  await assert.rejects(host.apply(requestId, f.source.snapshot()), /no longer pending/);
  assert.notEqual(text(f.source, markdownPath), 'pending');
});

test('capture rejects newer human fields with current context and validation/replay dispatch no adapters', async t => {
  const f = await setup(t); let requestId = '';
  const host = new AuthoringTools(() => f.source, id => { requestId = id; });
  const tool = host.tools(f.source)[0]!;
  const old = f.operation({ kind: 'visual', edit: { kind: 'setting', field: 'reviewWaitSeconds', value: 100 } });
  const result = tool.execute(old, { id: 'call', signal: new AbortController().signal });
  await f.source.visualEdit(f.source.snapshot(), { kind: 'setting', field: 'reviewWaitSeconds', value: 60 });
  host.reject(requestId, [{ field: 'setting-reviewDeadlineSeconds', value: '' }]);
  const rejected = JSON.parse((await result).text);
  assert.equal(rejected.receipt.status, 'rejected'); assert.equal(rejected.context.token.revision, f.source.revision);
  assert.equal(rejected.context.pendingHumanInput[0].value, ''); assert.equal(f.source.snapshot().workflow!.settings.reviewWaitSeconds, 60);
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Offline execution cannot use the network'); });
  await f.author({ kind: 'createFixture', path: 'case.json', text: fixtureText });
  await f.author({ kind: 'validate' }); await f.author({ kind: 'test', fixturePath: 'case.json' });
  assert.equal(fetch.mock.callCount(), 0);
  const bundle = await build({ entryPoints: ['apps/desktop/src/documents.ts'], bundle: true, platform: 'node', write: false, metafile: true });
  assert.deepEqual(Object.keys(bundle.metafile!.inputs).filter(path => /packages\/(providers|github|execution|runtime)\/|slack\/.*web-api/.test(path)), []);
  const forbidden = await tool.execute({ ...f.operation({ kind: 'validate' }), action: { kind: 'startLiveTrial' } }, { id: 'bad', signal: new AbortController().signal });
  assert.equal(forbidden.isError, true);
});
