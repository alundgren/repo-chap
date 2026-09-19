import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadWorkflow, parseFixture, replay } from '@repo-chap/workflow';
import { readCapture, readCapturedInspection } from '@repo-chap/github';
import type { CompanionCommand, CompanionResponse } from '@repo-chap/companion';
import { CompanionSession } from '../apps/desktop/src/companion.ts';
import { companionFixture } from './helpers/companion-fixture.ts';
import { decisionPacket } from './helpers/slack-fixture.ts';

function successful(response: CompanionResponse) { if (!response.ok) assert.fail(response.error); return response.state; }
const execute = async (session: CompanionSession, command: CompanionCommand) => successful(await session.execute({ schemaVersion: 1, command }));

test('companion discovers and switches workflows, observes file edits and clears prior workflow tests', async t => {
  const f = await companionFixture(); t.after(f.cleanup);
  const session = new CompanionSession();
  let state = await execute(session, { kind: 'open', repositoryRoot: f.repository });
  assert.equal(state.workflowPath, f.pkg.workflowPath); assert.equal(state.workflow?.id, 'team-pr'); assert.equal(state.workflows.length, 1);
  const nextPath = join(f.repository, 'alternate.workflow.json');
  await writeFile(nextPath, await readFile('skills/repo-chap-workflows/assets/workflow.json', 'utf8'));
  state = successful(await session.refresh()); assert.equal(state.workflows.length, 2);
  await execute(session, { kind: 'simulate', mode: 'tests', path: f.fixturePath });
  state = await execute(session, { kind: 'select', workflowPath: 'alternate.workflow.json' });
  assert.equal(state.workflow?.id, 'repository-pr'); assert.equal(state.simulation, null); assert.equal(state.input, null);
  const malformed = '{ invalid JSON'; await writeFile(nextPath, malformed);
  state = successful(await session.refresh()); assert.equal(state.workflow, null); assert.ok(state.diagnostics.length);
  assert.equal(state.workflows.length, 2); assert.equal(await readFile(nextPath, 'utf8'), malformed);
  await writeFile(nextPath, await readFile('skills/repo-chap-workflows/assets/workflow.json', 'utf8'));
  state = successful(await session.refresh()); assert.equal(state.diagnostics.length, 0); assert.equal(state.workflow?.id, 'repository-pr');
});

test('disk changes invalidate replay, invalid source blocks simulation, and prompt repair recovers without overwriting files', async t => {
  const f = await companionFixture(); t.after(f.cleanup);
  const session = new CompanionSession(); await execute(session, { kind: 'open', repositoryRoot: f.repository });
  let state = await execute(session, { kind: 'simulate', mode: 'tests', path: f.fixturePath });
  assert.deepEqual(state.simulation!.result, replay(f.pkg, parseFixture(JSON.parse(await readFile(f.fixturePath, 'utf8')))));
  assert.equal(state.simulation!.comparison!.passed, true); assert.equal(state.simulationCurrent, true);
  const prompt = f.pkg.files.find(file => file.path.endsWith('/review.md'))!;
  await writeFile(join(f.repository, prompt.path), prompt.text + '\nCheck the fictional boundary.\n');
  state = successful(await session.refresh()); assert.equal(state.simulationCurrent, false); assert.deepEqual(state.changedPaths, [prompt.path]);
  const prior = state.simulation;
  await rm(join(f.repository, prompt.path)); state = successful(await session.refresh());
  assert.equal(state.workflow, null); assert.equal(state.packageDigest, null); assert.equal(state.simulationCurrent, false);
  const rejected = await session.execute({ schemaVersion: 1, command: { kind: 'simulate' } }); assert.equal(rejected.ok, false);
  assert.deepEqual(session.snapshot().simulation, prior);
  await writeFile(join(f.repository, prompt.path), prompt.text);
  state = successful(await session.refresh()); assert.equal(state.diagnostics.length, 0); assert.equal(state.simulationCurrent, true);
  await writeFile(f.fixturePath, '{'); state = successful(await session.refresh());
  assert.equal(state.simulationCurrent, false); assert.ok(state.input!.error); assert.equal(state.input!.fixture, null);
  assert.equal((await session.execute({ schemaVersion: 1, command: { kind: 'simulate' } })).ok, false);
});

test('captured PR replay retains identity, works against revised workflow and keeps analysis package checks strict', async t => {
  const f = await companionFixture(); t.after(f.cleanup);
  const session = new CompanionSession(); await execute(session, { kind: 'open', repositoryRoot: f.repository });
  let state = await execute(session, { kind: 'simulate', mode: 'pr', path: f.capture.directory });
  assert.equal(state.mode, 'pr'); assert.equal(state.input!.capture!.pr, 42); assert.equal(state.input!.capture!.headSha, 'a'.repeat(40));
  assert.equal(state.simulationCurrent, true); assert.equal(state.simulation!.result.status, 'waiting');
  await writeFile(f.workflow, JSON.stringify({ ...f.pkg.workflow, settings: { ...f.pkg.workflow.settings, reviewWaitSeconds: 45 } }));
  state = successful(await session.refresh()); assert.equal(state.simulationCurrent, false);
  state = await execute(session, { kind: 'simulate' }); assert.equal(state.simulationCurrent, true);
  assert.notEqual(state.input!.capture!.packageDigest, state.packageDigest);
  assert.notEqual(state.simulation!.result.nextWakeAt, replay(f.pkg, f.inspection.fixture).nextWakeAt);
  await assert.rejects(readCapture(f.capture.directory, await loadWorkflow(f.workflow, { repositoryRoot: f.repository })), /digests do not match/);
  assert.equal((await readCapturedInspection(f.capture.directory)).evidence.pullRequest!.headSha, 'a'.repeat(40));
  const changedFixture = structuredClone(f.inspection.fixture); changedFixture.observations[0]!.headSha = 'c'.repeat(40);
  await writeFile(f.capture.fixture, JSON.stringify(changedFixture));
  state = successful(await session.refresh()); assert.ok(state.input!.error); assert.equal(state.simulationCurrent, false);
  assert.equal((await session.execute({ schemaVersion: 1, command: { kind: 'simulate' } })).ok, false);
});

test('test and real PR selections remain separate and changed expectations report an actual failure', async t => {
  const f = await companionFixture(); t.after(f.cleanup);
  const session = new CompanionSession(); await execute(session, { kind: 'open', repositoryRoot: f.repository });
  await execute(session, { kind: 'simulate', mode: 'tests', path: f.fixturePath });
  await execute(session, { kind: 'simulate', mode: 'pr', path: f.capture.directory });
  let state = await execute(session, { kind: 'show', mode: 'tests' });
  assert.equal(state.input!.path, f.fixturePath); assert.equal(state.simulation!.comparison!.passed, true);
  const fixture = JSON.parse(await readFile(f.fixturePath, 'utf8')); fixture.expected.status = 'closed';
  await writeFile(f.fixturePath, JSON.stringify(fixture));
  state = successful(await session.refresh()); assert.equal(state.simulationCurrent, false);
  state = await execute(session, { kind: 'simulate' }); assert.equal(state.simulation!.comparison!.passed, false);
  state = await execute(session, { kind: 'show', mode: 'pr' }); assert.equal(state.input!.path, f.capture.directory); assert.equal(state.simulationCurrent, true);
});

test('Slack previews use the shared packet renderer and changed or invalid packets invalidate their result', async t => {
  const f = await companionFixture(); t.after(f.cleanup);
  const session = new CompanionSession(); await execute(session, { kind: 'open', repositoryRoot: f.repository });
  const fixture = join(f.temporary, 'handoff.json'), packets = join(f.temporary, 'packets.json');
  await writeFile(fixture, await readFile('fixtures/replay/handoff.json', 'utf8'));
  const packet = { ...decisionPacket, headSha: 'a'.repeat(40) };
  await writeFile(packets, JSON.stringify(packet));
  let state = await execute(session, { kind: 'simulate', mode: 'tests', path: fixture, packetsPath: packets });
  assert.equal(state.simulation!.previewError, null); assert.equal(state.simulation!.handoffs.length, 1);
  assert.match(state.simulation!.handoffs[0]!.preview.message.text, /Ready for human merge/);
  await writeFile(packets, JSON.stringify({ ...packet, reason: 'A different fictional reason.' }));
  state = successful(await session.refresh()); assert.equal(state.simulationCurrent, false);
  state = await execute(session, { kind: 'simulate' }); assert.match(state.simulation!.handoffs[0]!.preview.message.text, /different fictional reason/);
  await writeFile(packets, '{}'); state = successful(await session.refresh());
  assert.ok(state.packetsError); assert.equal(state.simulationCurrent, false);
  assert.equal((await session.execute({ schemaVersion: 1, command: { kind: 'simulate' } })).ok, false);
});

test('navigation validates targets, expires guidance and rejects commands for a different repository or workflow', async t => {
  const f = await companionFixture(); t.after(f.cleanup);
  const session = new CompanionSession(); await execute(session, { kind: 'open', repositoryRoot: f.repository });
  let state = await execute(session, { kind: 'highlight', target: 'action:review', text: '<script>plain text</script>', style: 'arrow', seconds: 1 });
  assert.equal(state.view, 'overview'); assert.equal(state.guidance!.text, '<script>plain text</script>');
  assert.equal((await session.execute({ schemaVersion: 1, command: { kind: 'highlight', target: '#arbitrary-selector' } })).ok, false);
  const before = session.snapshot();
  assert.equal((await session.execute({ schemaVersion: 1, repositoryRoot: f.temporary, command: { kind: 'clear' } })).ok, false);
  assert.deepEqual(session.snapshot(), before);
  assert.equal((await session.execute({ schemaVersion: 1, repositoryRoot: f.repository, workflowPath: 'another.json', command: { kind: 'clear' } })).ok, false);
  await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(session.snapshot().guidance, null);
  state = await execute(session, { kind: 'show', target: 'action:review' }); assert.equal(state.guidance!.target, 'action:review');
  state = await execute(session, { kind: 'clear' }); assert.equal(state.guidance, null);
  for (const command of [{ kind: 'highlight', target: 'rules', seconds: 0 }, { kind: 'highlight', target: 'rules', seconds: 121 }, { kind: 'show', view: 'source' }, { kind: 'eval', script: 'x' }, { kind: 'status', extra: true }]) {
    assert.equal((await session.execute({ schemaVersion: 1, command })).ok, false);
  }
});

test('discovery respects Git ignores and outside symlinks, retains deleted selected files and notices new files in an empty repository', async t => {
  const f = await companionFixture(); t.after(f.cleanup);
  const empty = join(f.temporary, 'empty'); await mkdir(empty);
  execFileSync('git', ['init', '-q', empty]);
  const session = new CompanionSession(); let state = await execute(session, { kind: 'open', repositoryRoot: empty });
  assert.equal(state.workflowPath, null); assert.equal(state.workflows.length, 0);
  const text = await readFile('skills/repo-chap-workflows/assets/workflow.json', 'utf8');
  await writeFile(join(empty, '.gitignore'), 'ignored/\n'); await mkdir(join(empty, 'ignored'));
  await writeFile(join(empty, 'ignored/workflow.json'), text);
  await mkdir(join(empty, '.repo-chap')); await writeFile(join(empty, '.repo-chap/workflow.json'), text);
  state = successful(await session.refresh()); assert.equal(state.workflows.length, 1); assert.equal(state.workflow!.id, 'repository-pr');
  await rm(join(empty, '.repo-chap/workflow.json')); state = successful(await session.refresh());
  assert.equal(state.workflow, null); assert.equal(state.workflowPath, '.repo-chap/workflow.json'); assert.ok(state.diagnostics.length);
  await symlink(f.workflow, join(empty, '.repo-chap/workflow.json')); state = successful(await session.refresh());
  assert.equal(state.workflow, null); assert.match(state.diagnostics.map(item => item.message).join(), /outside/);
  assert.equal((await session.execute({ schemaVersion: 1, command: { kind: 'select', workflowPath: f.workflow } })).ok, false);
});
