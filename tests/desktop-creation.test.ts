import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPackage, replay } from '@repo-chap/workflow';
import { DocumentSession } from '../apps/desktop/src/documents.ts';
import { captureConversationContext } from '../apps/desktop/src/conversation-context.ts';

const path = '.repo-chap/workflow.json';
async function directory(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'repo-chap-create-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function restoreMocks(t: TestContext) { t.mock.restoreAll(); syncBuiltinESMExports(); }
function trackMocks(t: TestContext) { syncBuiltinESMExports(); t.after(() => restoreMocks(t)); }

test('new workflow validates, edits, simulates and supplies discussion context without writes or remote calls', async t => {
  const root = await directory(t);
  const writes = ['mkdir', 'writeFile', 'open', 'rename', 'link'].map(name => t.mock.method(fs, name as 'mkdir'));
  const spawn = t.mock.method(childProcess, 'spawn');
  const network = t.mock.method(globalThis, 'fetch');
  trackMocks(t);
  const session = await DocumentSession.create(root);
  const initial = session.snapshot();
  assert.equal(initial.isNewWorkflow, true);
  assert.equal(initial.files.length, 1);
  assert.equal(initial.files[0]!.dirty, true);
  assert.deepEqual(initial.diagnostics, []);
  assert.equal(initial.semanticError, null);
  const pkg = buildPackage(path, { [path]: initial.files[0]!.text });
  assert.deepEqual(pkg.workflow.requestedCapabilities, []);
  assert.deepEqual(pkg.workflow.labels, []);
  assert.equal(pkg.workflow.slack, undefined);
  assert.equal(pkg.files.length, 1);
  assert.deepEqual(Object.values(pkg.workflow.actions).map(a => a.uses), ['control.close', 'control.wait_signal']);
  for (const lifecycle of ['open', 'closed', 'merged'] as const) {
    const fixture = { schemaVersion: 1 as const, now: '2026-05-01T12:00:00Z', observations: [{ facts: { lifecycle } }] };
    const result = replay(pkg, fixture);
    assert.equal(result.status, lifecycle === 'open' ? 'waiting' : 'closed');
    assert.deepEqual(result.proposedEffects, []);
  }
  await session.visualEdit(initial, { kind: 'setting', field: 'newPrDelaySeconds', value: 180 });
  await assert.rejects(session.edit(initial, path, '{}'), /revision changed/);
  const fixture = JSON.stringify({ schemaVersion: 1, now: '2026-05-01T12:00:00Z', observations: [{ facts: { lifecycle: 'open' } }] });
  session.setSimulationInput(session.snapshot(), 'fixture', fixture, 'fictional-pr.json');
  session.simulate(session.snapshot());
  const context = captureConversationContext(session.snapshot(), { ruleId: null, markdownPaths: [], includeSimulation: true });
  assert.match(JSON.stringify(context), /repository-pr/);
  assert.equal(session.snapshot().simulation!.result.status, 'waiting');
  for (const write of writes) assert.equal(write.mock.callCount(), 0);
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(network.mock.callCount(), 0);
  assert.deepEqual(await fs.readdir(root), []);
});

test('first explicit save publishes exact text, reopens, and subsequent saves use the usual file contract', async t => {
  const root = await directory(t), session = await DocumentSession.create(root);
  const text = session.snapshot().files[0]!.text + '\n';
  await session.edit(session.snapshot(), path, text);
  await session.save(session.snapshot());
  assert.equal(await fs.readFile(join(root, path), 'utf8'), text);
  assert.deepEqual(await fs.readdir(join(root, '.repo-chap')), ['workflow.json']);
  assert.equal(session.isNewWorkflow, false);
  assert.equal(session.dirty, false);
  const opened = await DocumentSession.open(join(root, path), root);
  assert.equal(opened.snapshot().packageDigest, session.snapshot().packageDigest);
  await session.edit(session.snapshot(), path, text + '\n');
  await session.save(session.snapshot());
  assert.equal(await fs.readFile(join(root, path), 'utf8'), text + '\n');
});

test('discarding a never-saved workflow removes its draft without writing files', async t => {
  const root = await directory(t), session = await DocumentSession.create(root);
  await session.edit(session.snapshot(), path, '{ invalid');
  await assert.rejects(session.save(session.snapshot()), /validation/);
  await session.discard(session.snapshot(), path);
  assert.equal(session.dirty, false);
  assert.deepEqual(await fs.readdir(root), []);
});

for (const conflict of ['file', 'directory', 'symlink', 'parent-file', 'parent-symlink'] as const) test(`first save rejects a ${conflict} collision and permits retry after removal`, async t => {
  const root = await directory(t), outside = await directory(t);
  const session = await DocumentSession.create(root);
  if (conflict === 'parent-file') await fs.writeFile(join(root, '.repo-chap'), 'keep');
  else if (conflict === 'parent-symlink') await fs.symlink(outside, join(root, '.repo-chap'));
  else {
    await fs.mkdir(join(root, '.repo-chap'));
    if (conflict === 'file') await fs.writeFile(join(root, path), 'keep');
    else if (conflict === 'directory') await fs.mkdir(join(root, path));
    else await fs.symlink(join(outside, 'absent.json'), join(root, path));
  }
  await assert.rejects(session.save(session.snapshot()), /destination changed|already exists/);
  assert.equal(session.dirty, true);
  assert.deepEqual(await fs.readdir(outside), []);
  if (conflict === 'file') assert.equal(await fs.readFile(join(root, path), 'utf8'), 'keep');
  await fs.rm(join(root, '.repo-chap'), { recursive: true, force: true });
  await session.save(session.snapshot());
  assert.equal(session.dirty, false);
});

test('pre-existing metadata directory is usable but its replacement is rejected', async t => {
  const root = await directory(t);
  await fs.mkdir(join(root, '.repo-chap'));
  await fs.writeFile(join(root, '.repo-chap/keep.txt'), 'keep');
  const session = await DocumentSession.create(root);
  await fs.rename(join(root, '.repo-chap'), join(root, 'original'));
  await fs.mkdir(join(root, '.repo-chap'));
  await assert.rejects(session.save(session.snapshot()), /destination changed/);
  await fs.rmdir(join(root, '.repo-chap'));
  await fs.rename(join(root, 'original'), join(root, '.repo-chap'));
  await session.save(session.snapshot());
  assert.equal(await fs.readFile(join(root, '.repo-chap/keep.txt'), 'utf8'), 'keep');
});

test('replaced repository root rejects save without touching either directory', async t => {
  const parent = await directory(t), root = join(parent, 'repository');
  await fs.mkdir(root);
  const session = await DocumentSession.create(root);
  await fs.rename(root, join(parent, 'original'));
  await fs.mkdir(root);
  await assert.rejects(session.save(session.snapshot()), /repository directory changed/);
  assert.deepEqual(await fs.readdir(root), []);
  assert.deepEqual(await fs.readdir(join(parent, 'original')), []);
});

for (const failure of ['mkdir', 'open', 'link'] as const) test(`failed ${failure} keeps the draft, cleans its empty directory and can retry`, async t => {
  const root = await directory(t), session = await DocumentSession.create(root);
  t.mock.method(fs, failure, async () => { throw new Error(`injected ${failure} failure`); });
  trackMocks(t);
  await assert.rejects(session.save(session.snapshot()), /injected/);
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal(session.dirty, true);
  restoreMocks(t);
  await session.save(session.snapshot());
  assert.equal(session.dirty, false);
});

for (const existing of [true, false]) test(`failed staging preserves ${existing ? 'pre-existing' : 'new but nonempty'} metadata directory`, async t => {
  const root = await directory(t);
  if (existing) await fs.mkdir(join(root, '.repo-chap'));
  const session = await DocumentSession.create(root);
  t.mock.method(fs, 'open', async () => {
    if (!existing) await fs.writeFile(join(root, '.repo-chap/keep.txt'), 'external');
    throw new Error('staging failed');
  });
  trackMocks(t);
  await assert.rejects(session.save(session.snapshot()), /staging failed/);
  assert.deepEqual(await fs.readdir(join(root, '.repo-chap')), existing ? [] : ['keep.txt']);
  assert.equal(session.dirty, true);
});

test('a customized starter reports a saved reference when workflow publication then fails', async t => {
  const root = await directory(t), session = await DocumentSession.create(root);
  await fs.writeFile(join(root, 'review.md'), '# Original\n');
  const workflow = JSON.parse(session.snapshot().files[0]!.text);
  await fs.writeFile(join(root, 'result.json'), JSON.stringify({ '$schema': 'https://json-schema.org/draft/2020-12/schema', type: 'object' }));
  workflow.requestedCapabilities = ['workspace.read'];
  workflow.otherwise = 'review';
  workflow.actions.review = { uses: 'agent.review', execution: 'agent', capabilities: ['workspace.read'], prompt: '../review.md', outputSchema: '../result.json', onSuccess: 'park', onFailure: '$blocked' };
  await session.edit(session.snapshot(), path, JSON.stringify(workflow));
  await session.edit(session.snapshot(), 'review.md', '# Saved first\n');
  assert.deepEqual(session.snapshot().diagnostics, []);
  t.mock.method(fs, 'link', async () => { throw new Error('workflow publication failed'); });
  trackMocks(t);
  await assert.rejects(session.save(session.snapshot()), /Saved 1 of 2 files.*workflow publication failed/);
  assert.equal(await fs.readFile(join(root, 'review.md'), 'utf8'), '# Saved first\n');
  assert.equal(session.snapshot().files.find(f => f.path === 'review.md')!.dirty, false);
  assert.equal(session.snapshot().files.find(f => f.path === path)!.dirty, true);
  assert.deepEqual((await fs.readdir(root)).sort(), ['result.json', 'review.md']);
  restoreMocks(t);
  await session.save(session.snapshot());
  assert.equal(session.dirty, false);
});

test('creation rejects existing workflow files and metadata symlinks without overwriting them', async t => {
  const root = await directory(t), outside = await directory(t);
  await fs.mkdir(join(root, '.repo-chap'));
  await fs.writeFile(join(root, path), 'existing workflow');
  await assert.rejects(DocumentSession.create(root), /already exists/);
  assert.equal(await fs.readFile(join(root, path), 'utf8'), 'existing workflow');
  await fs.rm(join(root, '.repo-chap'), { recursive: true });
  await fs.symlink(outside, join(root, '.repo-chap'));
  await assert.rejects(DocumentSession.create(root), /must be a directory/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('a late destination collision cannot be overwritten by atomic publication', async t => {
  const root = await directory(t), session = await DocumentSession.create(root);
  const link = fs.link;
  t.mock.method(fs, 'link', async (source: Parameters<typeof fs.link>[0], destination: Parameters<typeof fs.link>[1]) => {
    await fs.writeFile(destination, 'concurrent file');
    return link(source, destination);
  });
  trackMocks(t);
  await assert.rejects(session.save(session.snapshot()), /EEXIST/);
  assert.equal(await fs.readFile(join(root, path), 'utf8'), 'concurrent file');
  assert.deepEqual(await fs.readdir(join(root, '.repo-chap')), ['workflow.json']);
  assert.equal(session.dirty, true);
});

test('cleanup never removes a replacement metadata directory after staging failure', async t => {
  const root = await directory(t), session = await DocumentSession.create(root);
  t.mock.method(fs, 'open', async () => {
    await fs.rename(join(root, '.repo-chap'), join(root, 'moved-metadata'));
    await fs.mkdir(join(root, '.repo-chap'));
    throw new Error('directory replaced while staging');
  });
  trackMocks(t);
  await assert.rejects(session.save(session.snapshot()), /directory replaced/);
  assert.deepEqual((await fs.readdir(root)).sort(), ['.repo-chap', 'moved-metadata']);
  assert.equal(session.dirty, true);
});
