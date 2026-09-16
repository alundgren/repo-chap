import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watch, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadWorkflow } from '@repo-chap/workflow';
import { DocumentSession } from '../apps/desktop/src/documents.ts';

const workflowPath = 'docs/pr-workflows/examples/team-pr/workflow.json';
const reviewPath = 'docs/pr-workflows/examples/team-pr/review.md';
const original = await loadWorkflow(resolve(workflowPath));
async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<{ root: string; session: DocumentSession }> {
  const root = await mkdtemp(join(tmpdir(), 'repo-chap-documents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of original.files) {
    await mkdir(dirname(join(root, file.path)), { recursive: true });
    await writeFile(join(root, file.path), file.text);
  }
  return { root, session: await DocumentSession.open(join(root, workflowPath), root) };
}
const fileText = (session: DocumentSession, path: string): string => session.snapshot().files.find(file => file.path === path)!.text;

test('desktop captures explicit references, validates unsaved Markdown, and saves exact source and stable IDs', async t => {
  const { root, session } = await fixture(t);
  const before = session.snapshot();
  assert.equal(before.files.length, original.files.length);
  assert.equal(before.packageDigest, original.digest);
  const workflow = JSON.parse(fileText(session, workflowPath));
  workflow.layout = { unknownFutureEditorData: { note: 'keep this', coordinates: [3, 9] } };
  const text = JSON.stringify(workflow, null, 4) + '\n\n';
  await session.edit(before, workflowPath, text);
  const markdown = '# Local review\n\nKeep fictional source. [Text only](missing.md)\n';
  await session.edit(session.snapshot(), reviewPath, markdown);
  assert.equal(session.snapshot().files.length, original.files.length);
  assert.notEqual(session.snapshot().packageDigest, original.digest);
  await session.save(session.snapshot());
  assert.equal(await readFile(join(root, workflowPath), 'utf8'), text);
  assert.equal(await readFile(join(root, reviewPath), 'utf8'), markdown);
  assert.deepEqual(JSON.parse(text).rules.map((rule: { id: string }) => rule.id), original.workflow.rules.map(rule => rule.id));
  assert.equal(session.dirty, false);
  const reopened = await DocumentSession.open(join(root, workflowPath), root);
  assert.equal(fileText(reopened, workflowPath), text);
  assert.equal(reopened.snapshot().packageDigest, session.snapshot().packageDigest);
});

test('invalid JSON is editable, blocks all writes, and discard restores the loaded text', async t => {
  const { root, session } = await fixture(t);
  await session.edit(session.snapshot(), reviewPath, '# Unsaved review\n');
  await session.edit(session.snapshot(), workflowPath, '{ broken');
  const snapshot = session.snapshot();
  assert.equal(snapshot.diagnostics[0]?.file, workflowPath);
  assert.equal(snapshot.diagnostics[0]?.code, 'invalid_json');
  await assert.rejects(session.save(snapshot), /validation errors/);
  assert.equal(await readFile(join(root, reviewPath), 'utf8'), original.files.find(file => file.path === reviewPath)!.text);
  await session.discard(snapshot, workflowPath);
  assert.equal(session.snapshot().diagnostics.length, 0);
  assert.equal(fileText(session, reviewPath), '# Unsaved review\n');
});

test('opening malformed JSON preserves it for repair', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, workflowPath), '{ broken');
  const session = await DocumentSession.open(join(root, workflowPath), root);
  assert.equal(session.snapshot().readOnlyReason, null);
  assert.equal(fileText(session, workflowPath), '{ broken');
  await session.edit(session.snapshot(), workflowPath, original.files.find(file => file.path === workflowPath)!.text);
  assert.equal(session.snapshot().diagnostics.length, 0);
  await session.save(session.snapshot());
});

test('desktop accepts current publication actions and reports shared prerequisite errors offline', async t => {
  const { root } = await fixture(t);
  const value = structuredClone(original.workflow);
  value.requestedCapabilities = [...new Set([...value.requestedCapabilities, 'review.publish' as const, 'labels.set' as const])];
  value.actions.review!.onSuccess = 'publish_review';
  value.actions.classify!.onSuccess = 'set_labels';
  value.actions.publish_review = { execution: 'code', uses: 'github.publish_review', capabilities: ['review.publish'], onSuccess: '$observe', onFailure: 'handoff' };
  value.actions.set_labels = { execution: 'code', uses: 'github.set_labels', capabilities: ['labels.set'], onSuccess: '$observe', onFailure: 'handoff' };
  const text = JSON.stringify(value, null, 2) + '\n';
  await writeFile(join(root, workflowPath), text);
  const session = await DocumentSession.open(join(root, workflowPath), root);
  assert.equal(session.snapshot().readOnlyReason, null);
  assert.equal(session.snapshot().diagnostics.length, 0);
  await session.edit(session.snapshot(), workflowPath, text + '\n');
  await session.save(session.snapshot());
  assert.equal(await readFile(join(root, workflowPath), 'utf8'), text + '\n');
  value.rules[0]!.action = 'publish_review';
  await session.edit(session.snapshot(), workflowPath, JSON.stringify(value));
  assert.ok(session.snapshot().diagnostics.some(diagnostic => diagnostic.file === workflowPath && diagnostic.code === 'action_input' && diagnostic.path === '/actions/publish_review'));
  await assert.rejects(session.save(session.snapshot()), /validation errors/);
});

for (const unsupported of ['version', 'action'] as const) test(`unsupported ${unsupported} stays read-only without rewriting source`, async t => {
  const { root } = await fixture(t);
  const value = structuredClone(original.workflow);
  if (unsupported === 'version') (value as { schemaVersion: number }).schemaVersion = 999;
  else value.actions.review!.uses = 'future.review';
  const text = JSON.stringify({ ...value, unknownField: { content: 'keep me' } }, null, 3) + '\n';
  await writeFile(join(root, workflowPath), text);
  const session = await DocumentSession.open(join(root, workflowPath), root);
  assert.match(session.snapshot().readOnlyReason!, /read-only/);
  assert.ok(session.snapshot().files.some(file => file.path === reviewPath));
  await assert.rejects(session.edit(session.snapshot(), workflowPath, '{}'), /read-only/);
  await assert.rejects(session.save(session.snapshot()), /read-only/);
  assert.equal(await readFile(join(root, workflowPath), 'utf8'), text);
});

test('unknown runtime fields remain intact in source and failed validation never deletes them', async t => {
  const { root, session } = await fixture(t);
  const value = JSON.parse(fileText(session, workflowPath));
  value.futureMetadata = { key: 'untouched' };
  const text = JSON.stringify(value, null, 2);
  await session.edit(session.snapshot(), workflowPath, text);
  await assert.rejects(session.save(session.snapshot()), /validation/);
  assert.equal(fileText(session, workflowPath), text);
  assert.equal(await readFile(join(root, workflowPath), 'utf8'), original.files.find(file => file.path === workflowPath)!.text);
});

test('external changes block all writes; explicit reload and discard preserve other drafts', async t => {
  const { root, session } = await fixture(t);
  await session.edit(session.snapshot(), workflowPath, fileText(session, workflowPath) + '\n');
  await session.edit(session.snapshot(), reviewPath, '# My draft\n');
  await writeFile(join(root, reviewPath), '# External edit\n');
  await assert.rejects(session.save(session.snapshot()), /changed on disk/);
  assert.equal(fileText(session, reviewPath), '# My draft\n');
  assert.equal(await readFile(join(root, workflowPath), 'utf8'), original.files.find(file => file.path === workflowPath)!.text);
  await session.discard(session.snapshot(), reviewPath);
  assert.equal(session.snapshot().files.find(file => file.path === reviewPath)!.external, true);
  await session.reload(session.snapshot(), reviewPath);
  assert.equal(fileText(session, reviewPath), '# External edit\n');
  assert.equal(session.snapshot().files.find(file => file.path === workflowPath)!.dirty, true);
  await session.save(session.snapshot());
});

test('stale revisions reject edits, reloads and saves without overwriting a newer draft', async t => {
  const { session } = await fixture(t);
  const stale = session.snapshot();
  await session.edit(stale, reviewPath, '# Newer revision\n');
  await assert.rejects(session.edit(stale, reviewPath, '# Stale response\n'), /revision changed/);
  await assert.rejects(session.reload(stale, reviewPath), /revision changed/);
  await assert.rejects(session.save(stale), /revision changed/);
  assert.equal(fileText(session, reviewPath), '# Newer revision\n');
});

test('references removed from JSON keep their unsaved buffers visible', async t => {
  const { session } = await fixture(t);
  await session.edit(session.snapshot(), reviewPath, '# Keep this draft\n');
  const value = JSON.parse(fileText(session, workflowPath));
  delete value.actions.review.contextFiles;
  await session.edit(session.snapshot(), workflowPath, JSON.stringify(value));
  assert.equal(fileText(session, reviewPath), '# Keep this draft\n');
  assert.equal(session.snapshot().files.find(file => file.path === reviewPath)!.dirty, true);
});

test('missing references are file-specific and reload recovers after the file is restored', async t => {
  const { root, session } = await fixture(t);
  const value = JSON.parse(fileText(session, workflowPath));
  value.actions.review.contextFiles.push('another-review.md');
  await session.edit(session.snapshot(), workflowPath, JSON.stringify(value));
  const path = 'docs/pr-workflows/examples/team-pr/another-review.md';
  assert.ok(session.snapshot().diagnostics.some(diagnostic => diagnostic.file === path));
  await writeFile(join(root, path), '# Added locally\n');
  await session.reload(session.snapshot(), path);
  assert.equal(session.snapshot().diagnostics.length, 0);
});

test('removing a missing reference allows a valid save and discarding source restores original references', async t => {
  const { root, session } = await fixture(t);
  const value = JSON.parse(fileText(session, workflowPath));
  value.actions.review.contextFiles = ['missing.md'];
  await session.edit(session.snapshot(), workflowPath, JSON.stringify(value));
  assert.ok(session.snapshot().diagnostics.length);
  await session.discard(session.snapshot(), workflowPath);
  assert.ok(session.snapshot().files.some(file => file.path === reviewPath));
  assert.equal(session.snapshot().diagnostics.length, 0);
  delete value.actions.review.contextFiles;
  await session.edit(session.snapshot(), workflowPath, JSON.stringify(value));
  await rm(join(root, reviewPath));
  await session.save(session.snapshot());
  assert.equal(session.dirty, false);
  assert.equal(session.snapshot().files.some(file => file.path.endsWith('missing.md') || file.path === reviewPath), false);
});

test('out-of-root symlinks remain unreadable and cannot be saved', async t => {
  const { root, session } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'repo-chap-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'review.md'), '# Outside\n');
  const path = 'docs/pr-workflows/examples/team-pr/outside.md';
  await symlink(join(outside, 'review.md'), join(root, path));
  const value = JSON.parse(fileText(session, workflowPath));
  value.actions.review.contextFiles.push('outside.md');
  await session.edit(session.snapshot(), workflowPath, JSON.stringify(value));
  assert.ok(session.snapshot().files.find(file => file.path === path)!.error?.includes('outside'));
  await assert.rejects(session.save(session.snapshot()), /validation/);
});

test('a staging I/O failure leaves every draft and source file unchanged', { skip: process.getuid?.() === 0 }, async t => {
  const { root, session } = await fixture(t);
  const folder = dirname(join(root, workflowPath));
  await session.edit(session.snapshot(), reviewPath, '# Unsaved\n');
  await chmod(folder, 0o555);
  try {
    await assert.rejects(session.save(session.snapshot()), /Remaining drafts have been kept/);
    assert.equal(session.dirty, true);
    assert.equal(await readFile(join(root, reviewPath), 'utf8'), original.files.find(file => file.path === reviewPath)!.text);
  } finally { await chmod(folder, 0o755); }
});

test('an external edit between file commits reports a partial save and retains the remaining draft', async t => {
  const { root, session } = await fixture(t);
  const workflowDraft = fileText(session, workflowPath) + '\n';
  await session.edit(session.snapshot(), reviewPath, '# Saved first\n');
  await session.edit(session.snapshot(), workflowPath, workflowDraft);
  let changed = false;
  const watcher = watch(dirname(join(root, reviewPath)), (_event, name) => {
    if (!changed && name === 'review.md') {
      changed = true;
      writeFileSync(join(root, workflowPath), original.files.find(file => file.path === workflowPath)!.text + '\n\n');
    }
  });
  try {
    await assert.rejects(session.save(session.snapshot()), /Saved 1 of 2 files/);
    assert.equal(changed, true);
    assert.equal(session.snapshot().files.find(file => file.path === reviewPath)!.dirty, false);
    assert.equal(fileText(session, workflowPath), workflowDraft);
    assert.equal(session.snapshot().files.find(file => file.path === workflowPath)!.dirty, true);
    assert.equal((await readdir(dirname(join(root, reviewPath)))).some(name => name.endsWith('.tmp')), false);
  } finally { watcher.close(); }
});
