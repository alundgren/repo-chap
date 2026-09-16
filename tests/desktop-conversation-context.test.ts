import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadWorkflow } from '@repo-chap/workflow';
import { readProfile, readProfiles } from '@repo-chap/providers';
import { DocumentSession } from '../apps/desktop/src/documents.ts';
import { captureConversationContext } from '../apps/desktop/src/conversation-context.ts';

const workflowPath = 'docs/pr-workflows/examples/team-pr/workflow.json';
const reviewPath = 'docs/pr-workflows/examples/team-pr/review.md';
const pkg = await loadWorkflow(resolve(workflowPath));
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'repo-chap-chat-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of pkg.files) { await mkdir(dirname(join(root, file.path)), { recursive: true }); await writeFile(join(root, file.path), file.text); }
  return { root, session: await DocumentSession.open(join(root, workflowPath), root) };
}

test('conversation context captures actual unsaved source and only selected loaded Markdown', async t => {
  const { session, root } = await fixture(t);
  await session.edit(session.snapshot(), reviewPath, '# Unsaved fictional review guidance\n');
  const snapshot = session.snapshot(), ruleId = snapshot.workflow!.rules[0]!.id;
  const capture = captureConversationContext(snapshot, { ruleId, markdownPaths: [reviewPath], includeSimulation: true });
  const context = JSON.parse(capture.text);
  assert.deepEqual(context.document.token, { sessionId: snapshot.sessionId, revision: snapshot.revision });
  assert.equal(context.document.packageDigest, snapshot.packageDigest);
  assert.deepEqual(context.selectedRule, snapshot.workflow!.rules[0]);
  assert.deepEqual(context.markdown.map((file: { path: string }) => file.path), [reviewPath]);
  assert.equal(context.markdown[0].text, '# Unsaved fictional review guidance\n');
  assert.equal(context.markdown[0].dirty, true);
  assert.equal(context.simulation.status, 'none');
  assert.match(capture.provenance, /No completed simulation/);
  assert.doesNotMatch(capture.text, new RegExp(root));
  await session.edit(session.snapshot(), reviewPath, '# Later source\n');
  assert.equal(JSON.parse(capture.text).markdown[0].text, '# Unsaved fictional review guidance\n');
  assert.equal(await readFile(join(root, reviewPath), 'utf8'), pkg.files.find(file => file.path === reviewPath)!.text);
});

test('retained simulation context keeps its tested revision and changes current status without inventing a new run', async t => {
  const { session } = await fixture(t);
  session.setSimulationInput(session.snapshot(), 'fixture', await readFile('fixtures/replay/conflict.json', 'utf8'), 'fictional-conflict.json');
  session.simulate(session.snapshot());
  const tested = session.snapshot(), selection = { ruleId: null, markdownPaths: [reviewPath], includeSimulation: true };
  const first = JSON.parse(captureConversationContext(tested, selection).text);
  assert.equal(first.simulation.status, 'current');
  assert.deepEqual(first.simulation.record, tested.simulation);
  await session.edit(session.snapshot(), workflowPath, session.snapshot().files.find(file => file.path === workflowPath)!.text + '\n');
  const formatted = session.snapshot(), equivalent = JSON.parse(captureConversationContext(formatted, selection).text);
  assert.notEqual(equivalent.document.token.revision, equivalent.simulation.record.token.revision);
  assert.equal(equivalent.simulation.status, 'current');
  assert.deepEqual(equivalent.simulation.record, tested.simulation);
  await session.edit(session.snapshot(), reviewPath, '# Changed model context\n');
  const stale = JSON.parse(captureConversationContext(session.snapshot(), selection).text);
  assert.equal(stale.simulation.status, 'stale');
  assert.deepEqual(stale.simulation.record.token, tested.simulation!.token);
  assert.equal(stale.simulation.record.fixtureDigest, tested.simulation!.fixtureDigest);
  assert.deepEqual(stale.simulation.record.result, tested.simulation!.result);
  const excluded = JSON.parse(captureConversationContext(session.snapshot(), { ...selection, includeSimulation: false }).text);
  assert.deepEqual(excluded.simulation, { status: 'excluded' });
  assert.deepEqual(session.snapshot().simulation, tested.simulation);
});

test('invalid workflow source remains discussable and unavailable selections fail visibly', async t => {
  const { session } = await fixture(t);
  await session.edit(session.snapshot(), workflowPath, '{ invalid draft');
  const selection = { ruleId: null, markdownPaths: [], includeSimulation: true };
  const captured = captureConversationContext(session.snapshot(), selection), context = JSON.parse(captured.text);
  assert.equal(context.workflow.text, '{ invalid draft');
  assert.equal(context.document.packageDigest, null);
  assert.ok(context.document.diagnostics.length > 0);
  assert.equal(context.selectedRule, null);
  assert.match(captured.provenance, /needs repair/);
  assert.throws(() => captureConversationContext(session.snapshot(), { ...selection, ruleId: 'old-rule' }), /no longer available/);
  assert.throws(() => captureConversationContext(session.snapshot(), { ...selection, markdownPaths: ['unloaded.md'] }), /cannot be read/);
  assert.throws(() => captureConversationContext(session.snapshot(), { ...selection, markdownPaths: [workflowPath] }), /Markdown references/);
  assert.throws(() => captureConversationContext(session.snapshot(), { ...selection, markdownPaths: [reviewPath, reviewPath] }), /Choose the rule/);
});

test('oversized selected source is rejected without truncating workflow or simulation evidence', async t => {
  const { session } = await fixture(t);
  await session.edit(session.snapshot(), reviewPath, 'x'.repeat(256 * 1024));
  assert.throws(() => captureConversationContext(session.snapshot(), { ruleId: null, markdownPaths: [reviewPath], includeSimulation: true }), /exceeds 256 KiB/);
  const capture = captureConversationContext(session.snapshot(), { ruleId: null, markdownPaths: [], includeSimulation: false });
  assert.equal(JSON.parse(capture.text).markdown.length, 0);
  assert.equal(session.snapshot().files.find(file => file.path === reviewPath)!.text.length, 256 * 1024);
});

test('desktop profile selection reads explicit private settings and preserves each configured model', async t => {
  const { root } = await fixture(t), path = join(root, 'providers.json');
  const document = { schemaVersion: 1, profiles: {
    codex_author: { provider: 'codex', model: 'fictional-codex-model', maximumCapabilities: [] },
    claude_author: { provider: 'claude', model: 'fictional-claude-model', effort: 'medium', maximumCapabilities: [] },
  } };
  await writeFile(path, JSON.stringify(document), { mode: 0o600 });
  const profiles = await readProfiles(path);
  assert.deepEqual(profiles.map(profile => [profile.name, profile.provider, profile.model]), [['codex_author', 'codex', 'fictional-codex-model'], ['claude_author', 'claude', 'fictional-claude-model']]);
  assert.deepEqual(await readProfile(path, 'codex_author'), profiles[0]);
  await assert.rejects(readProfile(path, 'toString'), /missing/);
  await chmod(path, 0o644); await assert.rejects(readProfiles(path), /private regular file/);
  await chmod(path, 0o600); await mkdir(join(root, '.git')); await assert.rejects(readProfiles(path), /outside Git/);
});

test('profile lists reject empty, excessive or invalid settings instead of selecting a replacement', async t => {
  const { root } = await fixture(t), path = join(root, 'providers.json');
  const write = (profiles: unknown) => writeFile(path, JSON.stringify({ schemaVersion: 1, profiles }), { mode: 0o600 });
  await write({}); await assert.rejects(readProfiles(path), /between 1 and 32/);
  await write(Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`p${index}`, { provider: 'codex', model: 'fictional-model', maximumCapabilities: [] }])));
  await assert.rejects(readProfiles(path), /between 1 and 32/);
  await write({ invalid: { provider: 'other', model: 'fictional-model', maximumCapabilities: [] } });
  await assert.rejects(readProfiles(path), /Codex or Claude/);
  await write([]); await assert.rejects(readProfiles(path), /schemaVersion 1 and profiles/);
});
