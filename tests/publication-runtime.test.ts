import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { buildPackage, type WorkflowPackage } from '@repo-chap/workflow';
import { collectSources } from '@repo-chap/providers';
import { tokenCredentials, type PublicationCapability, type PublicationReceipt } from '@repo-chap/github';
import { RuntimeStore, type AnalysisJob, type ApplyPolicy } from '@repo-chap/runtime';
import { DaemonService, type DaemonDependencies } from '@repo-chap/daemon';
import { setup } from './helpers/provider-fixture.ts';
import { completed } from './helpers/daemon-remote.ts';
import { publicationRemote, publicationState } from './helpers/publication-remote.ts';

export function publicationWorkflow(pkg: WorkflowPackage, kind: PublicationCapability = 'review.publish'): WorkflowPackage {
  const files = Object.fromEntries(pkg.files.map(file => [file.path, file.text])), workflow = structuredClone(pkg.workflow);
  const analysisId = kind === 'review.publish' ? 'review' : 'classify';
  const analysis = workflow.actions[analysisId]!;
  analysis.onSuccess = 'publish'; analysis.onFailure = '$blocked';
  workflow.actions = { [analysisId]: analysis, publish: { uses: kind === 'review.publish' ? 'github.publish_review' : 'github.set_labels', execution: 'code',
    capabilities: [kind], onSuccess: '$wait', onFailure: '$blocked' } };
  workflow.rules = [{ id: 'analyze', when: { field: 'facts.lifecycle', op: 'eq', value: 'open' }, action: analysisId }]; workflow.otherwise = analysisId;
  workflow.requestedCapabilities = ['workspace.read', kind];
  workflow.settings.newPrDelaySeconds = 0; workflow.settings.headDebounceSeconds = 0;
  return buildPackage(pkg.workflowPath, { ...files, [pkg.workflowPath]: JSON.stringify(workflow) });
}
async function fixture(kind: PublicationCapability = 'review.publish', source = false) {
  const s = await setup(), pkg = publicationWorkflow(s.pkg, kind), directory = join(s.temporary, 'publication-runtime');
  s.inspection.packageDigest = pkg.digest;
  const remote = publicationRemote(s.inspection), jobs: AnalysisJob[] = [];
  const policy: ApplyPolicy = { schemaVersion: 1, repository: 'reef-labs/paperboat', capabilities: [kind], maxRepairsPerLifecycle: 1, maxPushAttempts: 1 };
  let now = Date.parse('2026-09-16T12:00:00Z'), store = await RuntimeStore.open(directory), enabled = true, onToken = async () => {};
  const dependencies: DaemonDependencies = { directory, now: () => now, credentials: tokenCredentials('fictional-read-token'), profile: async () => s.profile,
    applyPolicy: async () => enabled ? policy : null, readOptions: { fetch: async (url, init) => {
      if (source && new URL(String(url)).pathname === '/graphql' && String(init?.body).includes('query WorkflowSource')) {
        const target = { oid: store.repository('R_paperboat').source!.observedRevision };
        return Response.json({ data: { repository: { id: 'R_paperboat', defaultBranchRef: { name: 'main', target }, ref: { name: 'main', target } } } });
      }
      return remote.fetch(url, init);
    } },
    publicationCredentials: async (repository, capability) => ({ repository, capability, permission: capability === 'review.publish' ? 'pull_requests:write' : 'issues:write',
      redact: value => value, token: async () => { await onToken(); return 'fictional-write-token'; } }),
    sources: async (_repo, inspection) => collectSources(s.repository, inspection.evidence.pullRequest!.headSha, inspection.evidence.pullRequest!.baseSha),
    execute: async job => { jobs.push(job); const result = completed(job); if (kind === 'labels.set') (result.provider.payload as any).labels = [
      { name: 'tests', reason: 'The value needs a test.', evidence: [{ path: 'src/value.js', side: 'head', startLine: 1, endLine: 1, explanation: 'The value changes.' }] }]; return result; },
  };
  let service = new DaemonService(store, dependencies);
  let repo;
  if (source) {
    repo = store.registerSource({ id: 'R_paperboat', name: policy.repository, profile: s.profile.name, reviewers: [], workflowPath: pkg.workflowPath, branch: 'main', maximumCapabilities: s.profile.maximumCapabilities }, now);
    await store.activateSource(repo.id, 'a'.repeat(40), 'main', pkg, now);
    repo = store.repository(repo.id);
  } else repo = await service.register({ name: policy.repository, package: pkg, profile: s.profile.name, reviewers: [] });
  return { ...s, pkg, directory, repo, remote, policy, dependencies, jobs,
    get store() { return store; }, get service() { return service; }, get now() { return now; },
    advance: (ms = 61_000) => { now += ms; }, revoke: () => { enabled = false; }, onToken: (callback: () => Promise<void>) => { onToken = callback; },
    tick: async () => { await service.tick(); await service.idle(); },
    restart: async () => { await service.stop(); store.close(); store = await RuntimeStore.open(directory); service = new DaemonService(store, dependencies); },
    cleanup: async () => { await service.stop(); store.close(); await s.cleanup(); },
  };
}

test('daemon publication uses one accepted analysis and independent durable effect receipts with only its own capability', async () => {
  for (const kind of ['review.publish', 'labels.set'] as const) {
    const s = await fixture(kind);
    try {
      await s.tick(); await s.tick(); await s.tick();
      const run = s.store.runs()[0]!, details = s.store.inspect(run.id), effect = details.effects[0]!;
      assert.equal(effect.state, 'confirmed', run.reason); assert.equal(effect.kind, kind);
      assert.equal(details.effectAttempts.length, 1); assert.equal(details.effectAttempts[0]!.state, 'confirmed');
      assert.equal(details.reservations.length, 1); assert.equal(s.jobs.length, 1); assert.equal(s.remote.state.writes, 1);
      assert.equal((effect.receipt as PublicationReceipt).freshness, 'current');
      if (kind === 'labels.set') assert.deepEqual(s.remote.state.labels, ['human-choice', 'auth', 'tests']);
      await s.restart(); assert.equal(s.store.effects(run.id)[0]!.id, effect.id); assert.equal(s.store.run(run.id).nextAction, '$wait');
    } finally { await s.cleanup(); }
  }
});

test('policy and provider permission revocation after credentials prevents the first publication write', async () => {
  for (const kind of ['review.publish', 'labels.set'] as const) for (const revoke of ['policy', 'profile'] as const) {
    const s = await fixture(kind);
    try {
      await s.tick(); s.onToken(async () => { if (revoke === 'policy') s.revoke(); else s.profile.maximumCapabilities = ['workspace.read']; });
      await s.tick(); const run = s.store.runs()[0]!, effect = s.store.effects(run.id)[0]!;
      assert.equal(effect.state, 'rejected', run.reason); assert.match((effect.receipt as PublicationReceipt).reason, /policy/i);
      assert.equal(s.remote.state.writes, 0); assert.equal(s.jobs.length, 1); assert.equal(s.store.inspect(run.id).notes.length, 1);
    } finally { await s.cleanup(); }
  }
});

test('independent publication lease remains current after the analysis claim is parked', async () => {
  const s = await fixture();
  let release!: () => void, arrived!: () => void;
  const ready = new Promise<void>(done => { arrived = done; }), hold = new Promise<void>(done => { release = done; });
  try {
    await s.tick(); s.onToken(async () => { arrived(); await hold; });
    await s.service.tick(); await ready;
    const run = s.store.runs()[0]!; assert.equal(s.store.effects(run.id)[0]!.state, 'sending');
    s.store.recover(s.now); assert.equal(s.store.effects(run.id)[0]!.state, 'sending');
    s.service.abortStale(); release(); await s.service.idle();
    assert.equal(s.store.effects(run.id)[0]!.state, 'confirmed'); assert.equal(s.remote.state.writes, 1);
  } finally { release?.(); await s.cleanup(); }
});

test('current evidence changes after credential retrieval reject publication and invalidate analysis', async () => {
  for (const changed of ['head', 'body'] as const) {
    const s = await fixture();
    try {
      await s.tick(); s.onToken(async () => { if (changed === 'head') s.inspection.evidence.pullRequest!.headSha = 'e'.repeat(40); else s.inspection.evidence.pullRequest!.body = 'New review context.'; });
      await s.tick(); const run = s.store.runs()[0]!, effect = s.store.effects(run.id)[0]!;
      assert.equal(effect.state, 'rejected'); assert.equal((effect.receipt as PublicationReceipt).freshness, 'stale');
      assert.equal(run.control.memory?.reviewCurrent, false); assert.equal(run.evidenceAvailable, false);
      assert.equal(s.remote.state.writes, 0); assert.equal(s.store.inspect(run.id).notes.length, 1);
    } finally { await s.cleanup(); }
  }
});

test('restart reconciles an accepted publication without another provider call or send', async () => {
  const s = await fixture();
  try {
    await s.tick(); s.remote.state.loseResponse = true; await s.tick();
    const run = s.store.runs()[0]!, effect = s.store.effects(run.id)[0]!;
    assert.equal(effect.state, 'unknown'); assert.equal(s.remote.state.writes, 1);
    await s.restart(); s.remote.state.loseResponse = false; s.advance(); await s.tick();
    assert.equal(s.store.effects(run.id)[0]!.id, effect.id); assert.equal(s.store.effects(run.id)[0]!.state, 'confirmed');
    assert.equal(s.remote.state.writes, 1); assert.equal(s.jobs.length, 1); assert.equal(s.store.inspect(run.id).effectAttempts.length, 1);
  } finally { await s.cleanup(); }
});

test('unknown publication without proof remains blocked across polls and restarts', async () => {
  const s = await fixture();
  try {
    s.remote.state.accept = false; s.remote.state.loseResponse = true; await s.tick(); await s.tick();
    const run = s.store.runs()[0]!; await s.restart(); s.advance(); await s.tick(); await s.tick();
    assert.equal(s.store.effects(run.id)[0]!.state, 'unknown'); assert.equal(s.jobs.length, 1); assert.equal(s.remote.state.writes, 1);
    assert.equal(s.store.run(run.id).control.memory?.reviewCurrent, true);
  } finally { await s.cleanup(); }
});

test('confirmed publication with unreadable current head recovers freshness using reads only', async () => {
  const s = await fixture();
  try {
    s.remote.state.failAfterWrite = true; await s.tick(); await s.tick();
    const run = s.store.runs()[0]!, effect = s.store.effects(run.id)[0]!;
    assert.equal(effect.state, 'confirmed'); assert.equal((effect.receipt as PublicationReceipt).freshness, 'unverified');
    await s.restart(); s.remote.state.failAfterWrite = false; s.advance(); await s.tick();
    const refreshed = s.store.effects(run.id)[0]!; assert.equal(refreshed.state, 'confirmed'); assert.equal((refreshed.receipt as PublicationReceipt).freshness, 'current');
    assert.equal(s.jobs.length, 1); assert.equal(s.remote.state.writes, 1); assert.equal(s.store.inspect(run.id).effectAttempts.length, 1);
    assert.equal((s.store.inspect(run.id).effectAttempts[0]!.receipt as PublicationReceipt).freshness, 'unverified');
  } finally { await s.cleanup(); }
});

test('actual prompt-only migration invalidates analysis and retains the same publication and send receipt', async () => {
  const s = await fixture('review.publish', true);
  try {
    await s.tick(); await s.tick(); await s.tick();
    const run = s.store.runs()[0]!, first = s.store.effects(run.id)[0]!, files = Object.fromEntries(s.pkg.files.map(file => [file.path, file.text]));
    files['docs/pr-workflows/examples/team-pr/prompts/review.md'] += '\nKeep findings specific.\n';
    const changed = buildPackage(s.pkg.workflowPath, files);
    await s.store.activateSource(s.repo.id, 'b'.repeat(40), 'main', changed, s.now);
    await s.store.migrate(run.id, s.store.repository(s.repo.id).activeVersionId!, s.now);
    assert.equal(s.store.run(run.id).control.memory?.reviewCurrent, false);
    await s.restart(); s.advance(); await s.tick(); await s.tick();
    const effects = s.store.effects(run.id); assert.equal(s.jobs.length, 2); assert.equal(effects.length, 1);
    assert.equal(effects[0]!.id, first.id); assert.equal(effects[0]!.state, 'confirmed'); assert.equal(s.remote.state.writes, 1);
    assert.equal(s.store.inspect(run.id).effectAttempts.length, 1); assert.equal(s.store.inspect(run.id).migrations.length, 1);
  } finally { await s.cleanup(); }
});

test('built CLI with publication-only policy plans, inspects offline, and reconciles SIGKILL after review acceptance', async () => {
  const s = await setup(), pkg = publicationWorkflow(s.pkg), workflowRoot = join(s.temporary, 'workflow'), state = join(s.temporary, 'local-state');
  const policyPath = join(s.temporary, 'apply.json'), fixturePath = join(s.temporary, 'publication-fixture.json'), remoteState = join(s.temporary, 'remote-state.json'), requests = join(s.temporary, 'requests.jsonl');
  for (const file of pkg.files) { const path = join(workflowRoot, file.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.text); }
  await writeFile(policyPath, JSON.stringify({ schemaVersion: 1, repository: 'reef-labs/paperboat', capabilities: ['review.publish'], maxRepairsPerLifecycle: 1, maxPushAttempts: 1 }), { mode: 0o600 });
  await writeFile(remoteState, JSON.stringify(publicationState()));
  const mode = (value?: string) => writeFile(fixturePath, JSON.stringify({ inspection: s.inspection, remote: s.repository, state: remoteState, requests, mode: value }), { mode: 0o600 });
  const args = ['apply', join(workflowRoot, pkg.workflowPath), '--repo-root', workflowRoot, '--repo', 'reef-labs/paperboat', '--pr', '42', '--state-dir', state,
    '--policy', policyPath, '--provider-config', s.settings, '--profile', 'pilot'];
  const invoke = (command: string[], token = 'fictional-local-token') => {
    const result = spawnSync(process.execPath, ['--import', resolve('tests/helpers/publication-cli-preload.ts'), resolve('apps/cli/dist/cli.js'), ...command], {
      env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: '', REPO_CHAP_PUBLICATION_FIXTURE: fixturePath }, encoding: 'utf8', timeout: 30_000,
    });
    return { ...result, value: result.stdout?.startsWith('{') ? JSON.parse(result.stdout) : null };
  };
  const providerCalls = async () => (await readFile(s.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]).filter(argv => argv.includes('exec') && !argv.includes('--help')).length;
  try {
    await mode(); const planned = invoke([...args, '--plan', '--json']); assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    const id = planned.value.run.id, effectId = planned.value.effects[0].id;
    assert.equal(planned.value.effects[0].state, 'planned'); assert.equal(planned.value.effectAttempts.length, 0); assert.equal(await providerCalls(), 1);
    assert.equal(JSON.parse(await readFile(remoteState, 'utf8')).writes, 0);
    const before = await readFile(requests, 'utf8'); await mode('offline');
    const inspected = invoke(['apply', 'inspect', id, '--state-dir', state, '--json'], ''); assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
    assert.equal(inspected.value.effects[0].id, effectId); assert.equal(await readFile(requests, 'utf8'), before);
    await mode('crash'); const crashed = invoke([...args, '--json']); assert.equal(crashed.signal, 'SIGKILL', crashed.stderr || crashed.stdout);
    assert.equal(JSON.parse(await readFile(remoteState, 'utf8')).writes, 1); assert.equal(await providerCalls(), 1);
    await mode(); const recovered = invoke(['apply', 'reconcile', id, '--state-dir', state, '--json']); assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    assert.equal(recovered.value.effects[0].id, effectId); assert.equal(recovered.value.effects[0].state, 'confirmed');
    assert.equal(recovered.value.effects[0].receipt.freshness, 'current'); assert.equal(recovered.value.effectAttempts.length, 1); assert.equal(await providerCalls(), 1);
    const printed = invoke(['apply', 'inspect', id, '--state-dir', state]); assert.equal(printed.status, 0, printed.stderr || printed.stdout);
    assert.match(printed.stdout, /confirmed, current.*review.publish/); assert.match(printed.stdout, /pullrequestreview-1/);
  } finally { await s.cleanup(); }
});
