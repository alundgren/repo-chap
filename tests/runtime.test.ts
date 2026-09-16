import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { chmod, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, digest, buildPackage, type Workflow } from '@repo-chap/workflow';
import { collectSources } from '@repo-chap/providers';
import { RuntimeStore, type AnalysisJob, type AnalysisResult, type RuntimeLimits } from '@repo-chap/runtime';
import { executeAnalysis, profileDigest } from '@repo-chap/daemon';
import { setup } from './helpers/provider-fixture.ts';

async function fixture(limits: Partial<RuntimeLimits> = {}, mode = 'valid') {
  const s = await setup(mode, { maxAttempts: 2 }), directory = join(s.temporary, 'state');
  let store = await RuntimeStore.open(directory, limits);
  const now = Date.now(), repo = await store.register({ id: 'R_paperboat', name: 'reef-labs/paperboat', package: s.pkg, profile: s.profile.name, reviewers: [] }, now);
  const run = (await store.observe(repo.id, s.inspection, now))!;
  const sources = await collectSources(s.repository, s.head, s.base), sourceRef = await store.artifacts.put(sources);
  const reserve = (time = now, owner = 'worker-one') => {
    const claim = store.claim(run.id, owner, time, 300)!; assert.ok(claim);
    const job = store.reserve(claim, { actionId: 'classify', sources: sourceRef, profile: s.profile.name, profileDigest: profileDigest(s.profile), package: s.pkg }, time);
    return { claim, job };
  };
  return { ...s, directory, repo, run, sourceRef, now, reserve, get store() { return store; },
    reopen: async () => { store.close(); store = await RuntimeStore.open(directory, limits); },
    cleanup: async () => { store.close(); await s.cleanup(); } };
}
function result(job: AnalysisJob): AnalysisResult {
  return { schemaVersion: 1, job, provider: { schemaVersion: 1, provider: 'codex', providerVersion: 'fixture', profile: 'pilot', providerDigest: null, inputDigest: job.evidenceKey,
    outcome: 'completed', diagnostic: 'Validated fixture result.', payload: { schemaVersion: 1, headSha: job.headSha, labels: [], uncertain: false }, attempts: [] } };
}
function revise(s: Awaited<ReturnType<typeof fixture>>, change: (pr: NonNullable<typeof s.inspection.evidence.pullRequest>) => void) {
  const inspection = structuredClone(s.inspection); change(inspection.evidence.pullRequest!);
  const pr = inspection.evidence.pullRequest!;
  inspection.evidence.revision = { status: 'stable', headSha: pr.headSha, baseSha: pr.baseSha };
  inspection.evidenceDigest = digest(canonicalJson(inspection.evidence));
  const observation = inspection.fixture.observations[0]!;
  Object.assign(observation, { headSha: pr.headSha, baseSha: pr.baseSha, evidenceDigest: inspection.evidenceDigest });
  Object.assign(observation.facts, { lifecycle: pr.lifecycle, draft: pr.draft }); return inspection;
}
test('runtime keeps private SQLite and digest-checked artifacts outside Git', async () => {
  const s = await fixture();
  try {
    assert.equal((await stat(s.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(s.directory, 'runtime.sqlite'))).mode & 0o777, 0o600);
    const ref = await s.store.artifacts.put({ text: 'private fixture' });
    await writeFile(join(s.directory, 'artifacts', ref.id), 'changed');
    await assert.rejects(s.store.artifacts.get(ref));
    await assert.rejects(RuntimeStore.open(join(s.repository, 'state')), /outside every Git/);
    await symlink(s.directory, join(s.temporary, 'linked-state')); await assert.rejects(RuntimeStore.open(join(s.temporary, 'linked-state')));
  } finally { await s.cleanup(); }
});
test('duplicate polls and registration keep one run, pinned package and durable result', async () => {
  const s = await fixture();
  try {
    const { claim, job } = s.reserve(); assert.equal(await s.store.complete(claim, result(job), s.now + 1), true);
    await s.store.observe(s.repo.id, s.inspection, s.now + 2); await s.reopen();
    assert.equal(s.store.runs().length, 1); assert.equal(s.store.run(s.run.id).control.memory?.classificationCurrent, true);
    assert.equal(s.store.inspect(s.run.id).reservations.length, 1);
    await assert.rejects(s.store.register({ id: s.repo.id, name: s.repo.name, package: { ...s.pkg, digest: 'changed' }, profile: 'pilot', reviewers: [] }, s.now));
    assert.equal(s.store.repository(s.repo.id).packageDigest, s.pkg.digest);
  } finally { await s.cleanup(); }
});
test('claims serialize across connections and reservations cannot be duplicated', async () => {
  const s = await fixture(), other = await RuntimeStore.open(s.directory);
  try {
    const { claim, job } = s.reserve();
    assert.equal(other.claim(s.run.id, 'worker-two', s.now, 300), null);
    assert.throws(() => s.store.reserve(claim, { actionId: job.actionId, sources: job.sources, profile: job.profile, profileDigest: job.profileDigest, package: s.pkg }, s.now), /already/);
    assert.equal(await s.store.complete(claim, result(job), s.now + 1), true);
    assert.equal(await other.complete(claim, result(job), s.now + 2), false);
    assert.equal(s.store.inspect(s.run.id).notes.length, 1);
  } finally { other.close(); await s.cleanup(); }
});
test('restart recovers expired attempts, increments ownership and rejects stale worker completion', async () => {
  const s = await fixture();
  try {
    const old = s.reserve(); await s.reopen();
    assert.equal(s.store.recover(s.now + 300_001), 1);
    const fresh = s.reserve(s.now + 300_002, 'replacement'); assert.ok(fresh.claim.token > old.claim.token);
    assert.equal(await s.store.complete(old.claim, result(old.job), s.now + 300_003), false);
    assert.equal(await s.store.complete(fresh.claim, result(fresh.job), s.now + 300_004), true);
    assert.equal(s.store.inspect(s.run.id).reservations.length, 2);
    assert.deepEqual(s.store.inspect(s.run.id).attempts.map(a => (a as any).state), ['abandoned', 'completed']);
  } finally { await s.cleanup(); }
});
test('SIGKILL after a committed reservation preserves recovery and consumption', async () => {
  const s = await fixture();
  try {
    const input = join(s.temporary, 'crash-input.json');
    await writeFile(input, JSON.stringify({ directory: s.directory, runId: s.run.id, sourceRef: s.sourceRef, pkg: s.pkg, profile: s.profile, now: s.now }), { mode: 0o600 });
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { readFile } from 'node:fs/promises'; import { RuntimeStore } from '@repo-chap/runtime'; import { profileDigest } from '@repo-chap/daemon';
      const p=JSON.parse(await readFile(process.argv[1],'utf8')); const store=await RuntimeStore.open(p.directory);
      const c=store.claim(p.runId,'crash-worker',p.now,1); const job=store.reserve(c,{actionId:'classify',sources:p.sourceRef,profile:p.profile.name,profileDigest:profileDigest(p.profile),package:p.pkg},p.now);
      process.stdout.write(JSON.stringify(job)+'\\n'); setInterval(()=>{},1000);
    `, input], { stdio: ['ignore', 'pipe', 'pipe'] });
    const job = await new Promise<AnalysisJob>((resolve, reject) => { child.stdout.once('data', data => resolve(JSON.parse(String(data)))); child.once('error', reject); child.once('exit', () => reject(new Error('Worker exited before reservation.'))); });
    const exit = new Promise(done => child.once('exit', done)); child.kill('SIGKILL'); await exit;
    await s.reopen(); assert.equal(s.store.recover(s.now + 1001), 1);
    assert.equal((s.store.inspect(s.run.id).attempts[0] as any).id, job.attemptId);
    assert.equal(s.store.inspect(s.run.id).reservations.length, 1);
  } finally { await s.cleanup(); }
});
test('new heads, draft and closure invalidate claims while retaining lifetime charges', async () => {
  for (const change of [(pr: any) => { pr.headSha = 'c'.repeat(40); }, (pr: any) => { pr.draft = true; }, (pr: any) => { pr.lifecycle = 'closed'; }]) {
    const s = await fixture();
    try {
      const { claim, job } = s.reserve(); await s.store.observe(s.repo.id, revise(s, change), s.now + 1);
      assert.equal(await s.store.complete(claim, result(job), s.now + 2), false);
      assert.equal(s.store.inspect(s.run.id).reservations.length, 1); assert.equal(s.store.run(s.run.id).control.memory?.classificationCurrent, false);
    } finally { await s.cleanup(); }
  }
});
test('per-head and lifecycle limits survive explicit retries, own head changes and restarts', async () => {
  const s = await fixture({ maxAttemptsPerLifecycle: 2 });
  try {
    const first = s.reserve(); await s.store.complete(first.claim, result(first.job), s.now + 1);
    s.store.retry(s.run.id, s.now + 2); const second = s.reserve(s.now + 2); await s.store.complete(second.claim, result(second.job), s.now + 3);
    await s.store.observe(s.repo.id, revise(s, pr => { pr.headSha = 'd'.repeat(40); }), s.now + 4); await s.reopen();
    assert.throws(() => s.reserve(s.now + 5), /Lifecycle/); assert.equal(s.store.inspect(s.run.id).reservations.length, 2);
  } finally { await s.cleanup(); }
});
test('repository and daily budgets conservatively retain charges without reported usage', async () => {
  for (const limits of [{ repositoryCostUnits: 1 }, { dailyCostUnits: 1 }]) {
    const s = await fixture(limits);
    try {
      const first = s.reserve(); await s.store.complete(first.claim, result(first.job), s.now + 1); await s.reopen();
      assert.throws(() => s.reserve(s.now + 2), /cost-unit budget exhausted/); assert.equal(s.store.inspect(s.run.id).reservations.length, 1);
    } finally { await s.cleanup(); }
  }
});
test('cancel fences active work and bounded retries never reset attempt records', async () => {
  const s = await fixture({ maxRetries: 1 });
  try {
    const { claim, job } = s.reserve(); s.store.cancel(s.run.id);
    assert.equal(await s.store.complete(claim, result(job), s.now + 1), false);
    s.store.retry(s.run.id, s.now + 2); assert.equal(s.store.inspect(s.run.id).reservations.length, 1);
    assert.throws(() => s.store.retry(s.run.id, s.now + 3), /remaining operator retries/);
  } finally { await s.cleanup(); }
});
test('atomic outbox identities survive duplicate planning, restart, and unknown sending outcomes', async () => {
  const s = await fixture();
  try {
    const claim = s.store.claim(s.run.id, 'effect-owner', s.now, 1)!;
    const request = { kind: 'fictional_notice', destination: 'fictional-team', evidenceKey: claim.evidenceKey, expectedRevision: s.head, payload: await s.store.artifacts.put({ message: 'Human review needed.' }) };
    const id = s.store.planEffect(claim, request, s.now); assert.equal(s.store.planEffect(claim, request, s.now), id);
    assert.equal(s.store.transitionEffect(claim, id, 'planned', 'sending', null, s.now), true);
    await s.reopen(); s.store.recover(s.now + 1001);
    assert.equal(s.store.effects(s.run.id)[0]?.state, 'unknown');
    const next = s.store.claim(s.run.id, 'reconciler', s.now + 1002, 10)!;
    assert.throws(() => s.store.transitionEffect(next, id, 'unknown', 'sending', null, s.now + 1002), /Invalid/);
    assert.equal(s.store.transitionEffect(next, id, 'unknown', 'confirmed', { remoteId: 'fictional-receipt' }, s.now + 1003), true);
    assert.equal(s.store.planEffect(next, request, s.now + 1004), id); assert.equal(s.store.effects(s.run.id).length, 1);
  } finally { await s.cleanup(); }
});
test('worker jobs and results survive JSON transport and loss of source/worker caches', async () => {
  const s = await fixture();
  try {
    const { claim, job } = s.reserve();
    assert.ok(!JSON.stringify(job).includes(s.temporary));
    const jobCopy = JSON.parse(JSON.stringify(job)); await rm(s.repository, { recursive: true });
    const actual = await executeAnalysis(jobCopy, { artifacts: s.store.artifacts, profile: s.profile, workerDirectory: join(s.directory, 'workers'), isCurrent: () => s.store.isCurrent(claim, Date.now()) });
    assert.equal(actual.provider.outcome, 'completed'); assert.equal(actual.provider.attempts.length, 1);
    assert.equal(await s.store.complete(claim, JSON.parse(JSON.stringify(actual)), Date.now()), true);
    await rm(join(s.directory, 'workers'), { recursive: true }); await s.reopen();
    const note = s.store.inspect(s.run.id).notes[0] as { artifact: any };
    const retained = await s.store.artifacts.get<AnalysisResult>(note.artifact); assert.equal(retained.provider.outcome, 'completed'); assert.ok(!JSON.stringify(retained).includes(s.temporary));
  } finally { await s.cleanup(); }
});
test('one durable daemon attempt makes one provider invocation even when its profile permits correction', async () => {
  const s = await fixture({}, 'invalid');
  try {
    const { claim, job } = s.reserve();
    const actual = await executeAnalysis(job, { artifacts: s.store.artifacts, profile: s.profile, workerDirectory: join(s.directory, 'workers'), isCurrent: () => s.store.isCurrent(claim, Date.now()) });
    assert.equal(actual.provider.outcome, 'invalid_output'); assert.equal(actual.provider.attempts.length, 1);
    await s.store.complete(claim, actual, Date.now()); assert.equal(s.store.inspect(s.run.id).reservations.length, 1);
    assert.equal(s.store.run(s.run.id).nextAction, 'handoff');
    assert.equal(s.store.run(s.run.id).failedActions.classify, job.evidenceKey);
  } finally { await s.cleanup(); }
});
test('result, notes and planned effects commit together or roll back together', async () => {
  const s = await fixture();
  try {
    const { claim, job } = s.reserve(), payload = await s.store.artifacts.put({ notice: 'Fictional handoff.' });
    const request = { kind: 'notice', destination: 'fictional-team', evidenceKey: 'stale', expectedRevision: s.head, payload };
    await assert.rejects(s.store.complete(claim, result(job), s.now + 1, [request]), /stale/);
    assert.equal(s.store.inspect(s.run.id).notes.length, 0); assert.equal((s.store.inspect(s.run.id).attempts[0] as any).state, 'running');
    await s.store.complete(claim, result(job), s.now + 2, [{ ...request, evidenceKey: claim.evidenceKey }]);
    await s.reopen(); assert.equal(s.store.inspect(s.run.id).notes.length, 1); assert.equal(s.store.effects(s.run.id)[0]!.state, 'planned');
    const next = s.store.claim(s.run.id, 'rejector', s.now + 3, 30)!;
    assert.equal(s.store.transitionEffect(next, s.store.effects(s.run.id)[0]!.id, 'planned', 'rejected', { reason: 'Operator policy blocks delivery.' }, s.now + 4), true);
    assert.equal(s.store.effects(s.run.id)[0]!.state, 'rejected');
  } finally { await s.cleanup(); }
});
test('installation and repository concurrency ceilings count durable claims', async () => {
  const s = await fixture({ concurrency: 2, repositoryConcurrency: 1 });
  try {
    const secondInspection = revise(s, pr => { pr.id = 'PR_43'; pr.number = 43; }); secondInspection.evidence.requested.pr = 43;
    secondInspection.evidenceDigest = digest(canonicalJson(secondInspection.evidence)); secondInspection.fixture.observations[0]!.evidenceDigest = secondInspection.evidenceDigest;
    const second = (await s.store.observe(s.repo.id, secondInspection, s.now))!;
    const first = s.store.claim(s.run.id, 'one', s.now, 30)!; assert.ok(first);
    assert.equal(s.store.claim(second.id, 'two', s.now, 30), null);
    await s.store.register({ id: 'R_sailboat', name: 'reef-labs/sailboat', package: s.pkg, profile: 'pilot', reviewers: [] }, s.now);
    const foreign = structuredClone(s.inspection); foreign.evidence.repository = { id: 'R_sailboat', name: 'reef-labs/sailboat', private: true }; foreign.evidence.requested.repository = 'reef-labs/sailboat';
    foreign.evidenceDigest = digest(canonicalJson(foreign.evidence)); foreign.fixture.observations[0]!.evidenceDigest = foreign.evidenceDigest;
    const third = (await s.store.observe('R_sailboat', foreign, s.now))!; assert.ok(s.store.claim(third.id, 'three', s.now, 30));
    assert.equal(s.store.claim(second.id, 'four', s.now, 30), null); s.store.cancel(s.run.id);
    assert.ok(s.store.claim(second.id, 'four', s.now + 1, 30));
  } finally { await s.cleanup(); }
});
test('daemon ownership is claimed transactionally and released only by its recorded token', async () => {
  const s = await fixture(), other = await RuntimeStore.open(s.directory);
  try {
    const token = s.store.claimDaemon(); assert.throws(() => other.claimDaemon(), /already owns/);
    other.releaseDaemon('not-the-owner'); assert.throws(() => other.claimDaemon(), /already owns/);
    s.store.releaseDaemon(token); const next = other.claimDaemon(); assert.notEqual(next, token); other.releaseDaemon(next);
  } finally { other.close(); await s.cleanup(); }
});
