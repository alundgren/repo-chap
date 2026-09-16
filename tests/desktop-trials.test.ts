import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalJson, digest, parseFixture } from '@repo-chap/workflow';
import { GitHubReadError } from '@repo-chap/github';
import type { Inspection } from '@repo-chap/github';
import { DocumentSession } from '../apps/desktop/src/documents.ts';
import { AuthoringTools } from '../apps/desktop/src/authoring-tools.ts';
import { prepareLiveTrialTool } from '../apps/desktop/src/trial-tool.ts';
import { TrialController, trialLimits } from '../apps/desktop/src/trials.ts';
import { captureConversationContext } from '../apps/desktop/src/conversation-context.ts';
import { setup, git } from './helpers/provider-fixture.ts';

async function fixture(t: { after(callback: () => Promise<void>): void }, mode = 'valid', provider: 'codex' | 'claude' = 'codex', deadlineMs?: number) {
  const source = await setup(mode, { provider, timeoutMs: 10_000 }); t.after(source.cleanup);
  for (const file of source.pkg.files) { await mkdir(dirname(join(source.repository, file.path)), { recursive: true }); await writeFile(join(source.repository, file.path), file.text); }
  const document = await DocumentSession.open(join(source.repository, source.pkg.workflowPath), source.repository);
  const directory = join(source.temporary, 'desktop-trials'); let reads = 0, current = structuredClone(source.inspection), auth = true;
  const snapshots: ReturnType<TrialController['snapshot']>[] = [];
  const options = { directory, getDocument: () => document.snapshot(), onChange: (snapshot: ReturnType<TrialController['snapshot']>) => snapshots.push(snapshot), deadlineMs,
    inspect: async (pkg: typeof source.pkg, _selection: unknown, signal: AbortSignal): Promise<Inspection> => {
      reads++; if (!auth) throw new GitHubReadError('credentials');
      const result = structuredClone(current); result.packageDigest = pkg.digest;
      if (signal.aborted) result.evidence.revision.status = 'unknown';
      result.evidenceDigest = digest(canonicalJson(result.evidence)); result.fixture.observations[0]!.evidenceDigest = result.evidenceDigest;
      result.fixture.observations[0]!.headSha = result.evidence.pullRequest?.headSha; result.fixture.observations[0]!.baseSha = result.evidence.pullRequest?.baseSha;
      return result;
    },
  };
  const trials = new TrialController(options); await trials.restore();
  const selection = { repository: 'reef-labs/paperboat', pr: 42, sourceRepository: source.repository, profile: source.profile.name };
  const calls = async () => (await readFile(source.log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
  const start = async () => { trials.start(document.snapshot(), selection, source.profile); await trials.settled(); return trials.snapshot().records[0]!; };
  return { source, document, trials, selection, options, snapshots, calls, start, reads: () => reads, mutate: (fn: (inspection: Inspection) => void) => fn(current), auth: (enabled: boolean) => { auth = enabled; } };
}
async function waitFor(check: () => Promise<boolean>): Promise<void> { for (let index = 0; index < 150; index++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('The expected provider activity did not start.'); }

test('assistant proposals require a successful current capture and stay within the host receipt limit', async t => {
  const f = await fixture(t); let mode = 'current';
  const token = () => ({ sessionId: f.document.sessionId, revision: f.document.snapshot().revision });
  const authoring = new AuthoringTools(() => f.document, id => {
    void (async () => {
      if (mode === 'pending') { authoring.reject(id, [{ field: 'reviewWaitSeconds', value: '' }]); return; }
      if (mode === 'changed') await f.document.edit(f.document.snapshot(), f.document.workflowPath, f.document.snapshot().files.find(file => file.path === f.document.workflowPath)!.text + '\n');
      await authoring.apply(id, f.document.snapshot()); authoring.confirm(id);
    })();
  });
  const invoke = async () => {
    const tool = prepareLiveTrialTool(token(), authoring.tools(f.document)[0]!, async (token, input) => {
      f.document.assertCurrent(token); f.trials.prepare(f.document.snapshot(), { ...f.selection, ...input }, f.source.profile, 'assistant'); return f.trials.snapshot().proposal!;
    });
    return tool.execute({ repository: f.selection.repository, pr: 42, profile: f.selection.profile }, { id: 'fictional-tool-call', signal: new AbortController().signal });
  };
  mode = 'pending'; let response = await invoke(); assert.equal(response.isError, true); assert.equal(JSON.parse(response.text).prepared, false); assert.equal(f.trials.snapshot().proposal, null);
  mode = 'changed'; response = await invoke(); assert.equal(response.isError, true); assert.equal(JSON.parse(response.text).prepared, false); assert.equal(f.trials.snapshot().proposal, null);
  mode = 'current'; response = await invoke(); assert.equal(response.isError, undefined); assert.equal(JSON.parse(response.text).prepared, true); assert.equal(JSON.parse(response.text).started, false);
  const prepared = f.trials.snapshot().proposal;
  for (let index = f.document.snapshot().authoringReceipts.length; index < 128; index++) await f.document.author({ operationId: `fictional-read-${index}`, expected: token(), action: { kind: 'read', paths: [] } });
  // The capture handler reports the host limit failure through the same renderer rejection path.
  const limited = new AuthoringTools(() => f.document, id => { void authoringLimit(id); });
  const authoringLimit = async (id: string) => { try { await limited.apply(id, f.document.snapshot()); limited.confirm(id); } catch { limited.reject(id, []); } };
  const tool = prepareLiveTrialTool(token(), limited.tools(f.document)[0]!, async () => { throw new Error('Rejected capture must never prepare.'); });
  response = await tool.execute({ repository: f.selection.repository, pr: 42, profile: f.selection.profile }, { id: 'fictional-limit-call', signal: new AbortController().signal });
  assert.equal(response.isError, true); assert.match(response.text, /128 authoring receipts/); assert.equal(JSON.parse(response.text).prepared, false);
  assert.deepEqual(f.trials.snapshot().proposal, prepared); assert.equal(f.reads(), 0); assert.equal((await f.calls()).length, 0);
});

for (const provider of ['codex', 'claude'] as const) test(`${provider} trial waits for explicit Start, pins unsaved content and retains actual read-only evidence`, async t => {
  const f = await fixture(t, 'valid', provider);
  const reviewPath = f.source.pkg.files.find(file => file.path.endsWith('/review.md'))!.path;
  await f.document.edit(f.document.snapshot(), reviewPath, '# Unsaved review instructions\nRetain real findings.\n');
  f.trials.prepare(f.document.snapshot(), f.selection, f.source.profile, 'assistant');
  assert.equal(f.reads(), 0); assert.equal((await f.calls()).length, 0); assert.equal(f.trials.snapshot().activeId, null);
  assert.equal(f.trials.snapshot().proposal!.preparedBy, 'assistant');
  const before = git(f.source.repository, 'status', '--porcelain'), record = await f.start();
  assert.equal(record.status, 'completed'); assert.equal(record.analysis!.decision, 'analysis_acceptable'); assert.equal(record.remote.status, 'current');
  assert.equal(record.inspection!.headSha, f.source.head); assert.equal(record.analysis!.baseSha, f.source.base);
  assert.equal(record.analysis!.comparisonBaseSha, f.source.base);
  assert.equal(git(f.source.repository, 'status', '--porcelain'), before); assert.equal(git(f.source.repository, 'rev-parse', 'HEAD'), f.source.head);
  const pinned = JSON.parse(await readFile(join(dirname(record.recordPath), 'package.json'), 'utf8'));
  assert.equal(pinned.files.find((file: any) => file.path === reviewPath).text, '# Unsaved review instructions\nRetain real findings.\n');
  assert.notEqual(await readFile(join(f.source.repository, reviewPath), 'utf8'), pinned.files.find((file: any) => file.path === reviewPath).text);
  assert.equal((await stat(record.recordPath)).mode & 0o777, 0o600);
  assert.ok(f.snapshots.some(item => item.records[0]?.phase === 'classify')); assert.ok(f.snapshots.some(item => item.records[0]?.phase === 'review'));
  const requests = await f.calls();
  if (provider === 'codex') assert.ok(requests.filter(args => args.includes('exec') && !args.includes('--help')).every(args => args.includes('read-only') && args.includes('never')));
  else assert.ok(requests.filter(args => args.includes('--print')).every(args => args.includes('--tools') && args[args.indexOf('--tools') + 1] === ''));
  assert.deepEqual(Object.keys(record.analysis!.results), ['classify', 'review']);
  const context = JSON.parse(captureConversationContext(f.document.snapshot(), { ruleId: null, markdownPaths: [], includeSimulation: true }, f.trials.snapshot()).text);
  assert.equal(context.liveTrial.record.id, record.id); assert.equal(context.liveTrial.record.analysis.results.review.payload.summary, 'Reviewed the pinned value change.');
  assert.equal(context.simulation.status, 'none');
  const exported = await f.trials.fixture(record.id); assert.ok(parseFixture(JSON.parse(exported.text)).results!.review![0]!.payload);
  assert.equal(JSON.parse(exported.provenance).kind, 'explicit-live-trial-fixture-export');
  f.trials.prepare(f.document.snapshot(), { ...f.selection, pr: 43 }, f.source.profile, 'assistant');
  assert.equal(f.trials.snapshot().currentIds.length, 0); assert.equal(f.trials.snapshot().activeId, null);
  await f.trials.close(); const restored = new TrialController(f.options); await restored.restore(); assert.equal(restored.snapshot().records[0]!.id, record.id);
});

test('partial metadata stays incomplete while Refresh detects a newer head without a provider call', async t => {
  const f = await fixture(t);
  f.mutate(inspection => { inspection.status = 'partial'; inspection.evidence.reviews.coverage.status = 'partial'; inspection.fixture.observations[0]!.facts.evidenceComplete = false; });
  const record = await f.start(); assert.equal(record.status, 'completed'); assert.equal(record.analysis!.decision, 'incomplete');
  assert.equal((record.analysis!.results.review!.payload as any).verdict, 'inconclusive'); assert.ok(record.analysis!.missingEvidence.length);
  const before = (await f.calls()).length;
  f.mutate(inspection => { inspection.evidence.pullRequest!.headSha = 'b'.repeat(40); inspection.evidence.revision.headSha = 'b'.repeat(40); });
  await f.trials.refresh(record.id);
  assert.equal(f.trials.snapshot().records[0]!.remote.status, 'stale'); assert.equal(f.trials.snapshot().records[0]!.inspection!.headSha, f.source.head);
  assert.equal(f.trials.snapshot().currentIds.length, 0); assert.equal((await f.calls()).length, before);
});

test('changed draft cancels a running analysis and keeps the new unsaved bytes', async t => {
  const f = await fixture(t, 'hang_review');
  f.trials.start(f.document.snapshot(), f.selection, f.source.profile);
  await waitFor(async () => await readFile(f.source.marker, 'utf8').catch(() => '') === 'review');
  const path = f.source.pkg.files.find(file => file.path.endsWith('/review.md'))!.path;
  await f.document.edit(f.document.snapshot(), path, '# Newer draft\n'); f.trials.documentChanged(); await f.trials.settled();
  const record = f.trials.snapshot().records[0]!;
  assert.equal(record.status, 'superseded'); assert.equal(record.analysis!.decision, 'incomplete'); assert.equal(record.analysis!.control.memory!.reviewCurrent, false);
  assert.equal(f.document.snapshot().files.find(file => file.path === path)!.text, '# Newer draft\n');
  assert.equal(JSON.parse(await readFile(record.recordPath, 'utf8')).status, 'superseded');
});

for (const action of ['cancel', 'selection', 'close'] as const) test(`${action} stops the active trial and preserves its private result`, async t => {
  const f = await fixture(t, 'hang'); f.trials.start(f.document.snapshot(), f.selection, f.source.profile);
  await waitFor(async () => !!await readFile(f.source.childPid, 'utf8').catch(() => ''));
  const id = f.trials.snapshot().activeId!;
  if (action === 'cancel') await f.trials.cancel(id); else if (action === 'selection') { f.trials.invalidate(); await f.trials.settled(); } else await f.trials.close();
  const record = f.trials.snapshot().records[0]!;
  assert.equal(record.status, action === 'selection' ? 'superseded' : 'cancelled');
  assert.equal(JSON.parse(await readFile(record.recordPath, 'utf8')).status, record.status);
});

test('missing authentication, provider failure and timeout are explicit retained failures', async t => {
  const missing = await fixture(t); missing.auth(false);
  const auth = await missing.start(); assert.equal(auth.status, 'blocked'); assert.match(auth.diagnostic, /credentials/); assert.equal((await missing.calls()).length, 0);
  const failed = await fixture(t, 'error'); const provider = await failed.start(); assert.equal(provider.status, 'provider_error'); assert.equal(provider.analysis!.decision, 'incomplete');
  assert.ok(!JSON.stringify(provider).includes('credential-example-must-not-leak'));
  const timed = await fixture(t, 'hang', 'codex', 500); const timeout = await timed.start(); assert.equal(timeout.status, 'timeout');
});

test('source history and profile ceiling failures stop before model dispatch', async t => {
  const f = await fixture(t);
  assert.throws(() => f.trials.start(f.document.snapshot(), f.selection, { ...f.source.profile, maximumCapabilities: ['workspace.read'] }), /capability/i);
  f.mutate(inspection => { inspection.evidence.pullRequest!.headSha = 'b'.repeat(40); inspection.evidence.revision.headSha = 'b'.repeat(40); });
  const record = await f.start(); assert.equal(record.status, 'blocked'); assert.ok(record.analysis!.missingEvidence.length); assert.equal((await f.calls()).length, 0);
});

test('private retention is bounded and interrupted records never resume automatically', async t => {
  const f = await fixture(t); f.auth(false);
  for (let index = 0; index <= trialLimits.retained; index++) await f.start();
  assert.equal((await readdir(f.options.directory)).filter(name => name.startsWith('trial-')).length, trialLimits.retained);
  const record = f.trials.snapshot().records[0]!; await writeFile(record.recordPath, JSON.stringify({ ...record, status: 'running' }));
  const restored = new TrialController(f.options); await restored.restore();
  assert.equal(restored.snapshot().records[0]!.status, 'blocked'); assert.match(restored.snapshot().records[0]!.diagnostic, /never resumed/);
  assert.equal((await f.calls()).length, 0);
});


test('failed Refresh clears remote knowledge and changed named settings invalidate retained evidence', async t => {
  const f = await fixture(t); const record = await f.start();
  assert.equal(f.trials.snapshot().currentIds.length, 1);
  const calls = (await f.calls()).length; f.auth(false); await f.trials.refresh(record.id);
  const refreshed = f.trials.snapshot().records[0]!;
  assert.equal(refreshed.remote.status, 'unknown'); assert.equal(refreshed.status, 'completed');
  assert.equal(f.trials.snapshot().currentIds.length, 0); assert.equal((await f.calls()).length, calls);
  f.auth(true); await f.trials.refresh(record.id); assert.equal(f.trials.snapshot().currentIds.length, 1);
  f.trials.profilesChanged([{ ...f.source.profile, model: 'another-fictional-model' }]);
  assert.equal(f.trials.snapshot().currentIds.length, 0);
  assert.equal(f.trials.snapshot().records[0]!.provider.model, f.source.profile.model);
});

test('Refresh can be cancelled without discarding the completed provider result', async t => {
  const f = await fixture(t); const record = await f.start();
  const controller = new TrialController({ ...f.options, inspect: async (_pkg, _selection, signal) => { await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); }); throw new GitHubReadError('cancelled'); } });
  await controller.restore(); const refresh = controller.refresh(record.id);
  assert.equal(controller.snapshot().refreshingId, record.id);
  await controller.cancel(record.id); await refresh;
  assert.equal(controller.snapshot().records[0]!.status, 'completed'); assert.equal(controller.snapshot().records[0]!.remote.status, 'unknown');
});
