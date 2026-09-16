import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildPackage, loadWorkflow, supportedCapabilities, type WorkflowPackage } from '@repo-chap/workflow';
import { saveCapture, tokenCredentials, type Inspection } from '@repo-chap/github';
import { collectSources } from '@repo-chap/providers';
import { RuntimeStore, type AnalysisJob, type RuntimeLimits } from '@repo-chap/runtime';
import { DaemonService, fetchWorkflowCommit, readWorkflowCommit, serveControl, type DaemonDependencies } from '@repo-chap/daemon';
import { git, setup } from './helpers/provider-fixture.ts';
import { completed, remote } from './helpers/daemon-remote.ts';

const cli = resolve('apps/cli/dist/cli.js');
async function fixture(options: { invalid?: boolean; hold?: boolean; limits?: Partial<RuntimeLimits>; branch?: string; reviewers?: string[]; blockedPermissions?: boolean } = {}) {
  const s = await setup(), directory = join(s.temporary, 'state');
  const files: Record<string, string> = Object.fromEntries(s.pkg.files.map(file => [file.path, file.text]));
  const write = async (changes: Record<string, string | null>) => {
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) await rm(join(s.repository, path), { force: true });
      else { await mkdir(dirname(join(s.repository, path)), { recursive: true }); await writeFile(join(s.repository, path), text); }
    }
    git(s.repository, 'add', '-A'); git(s.repository, 'commit', '--allow-empty', '-qm', 'Update workflow files');
    revision = git(s.repository, 'rev-parse', 'HEAD'); return revision;
  };
  let revision = '', now = Date.parse('2026-09-16T12:00:00Z');
  await write({ ...files, ...(options.invalid ? { [s.pkg.workflowPath]: '{broken' } : {}) });
  const firstRevision = revision, fake = remote(s.inspection), reads: string[] = [], branches: string[] = [], jobs: AnalysisJob[] = [], signals: AbortSignal[] = [];
  const healthy = structuredClone(s.inspection);
  healthy.evidence.repository = { id: 'R_healthy', name: 'reef-labs/healthy', private: true };
  healthy.evidence.requested.repository = 'reef-labs/healthy';
  healthy.evidence.pullRequest!.headRepository = { id: 'R_healthy', name: 'reef-labs/healthy' };
  const other = remote(healthy);
  const releases: (() => void)[] = [];
  let metadataGate: { number: number; started: () => void; wait: Promise<void> } | null = null;
  let blockedPermissions = options.blockedPermissions ?? false, profileReads = 0;
  let store = await RuntimeStore.open(directory, options.limits);
  const sources = await collectSources(s.repository, s.head, s.base);
  const deps: DaemonDependencies = { directory, credentials: tokenCredentials('fictional-source-token'), profile: async () => ({ ...s.profile, maximumCapabilities: blockedPermissions && ++profileReads > 1 ? [] : s.profile.maximumCapabilities }), now: () => now,
    readOptions: { sleep: async () => {}, fetch: async (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.query.includes('query WorkflowSource')) {
        branches.push(request.variables.ref);
        return Response.json({ data: { repository: { id: 'R_paperboat', defaultBranchRef: { name: 'main', target: { oid: revision } },
          ref: { name: request.variables.ref.slice('refs/heads/'.length), target: { oid: revision } } } } });
      }
      if (request.query.includes('query InspectMetadata') && metadataGate && metadataGate.number === request.variables.number) {
        const gate = metadataGate; metadataGate = null; gate.started(); await gate.wait;
      }
      return request.variables.name === 'healthy' ? other.fetch(url, init) : fake.fetch(url, init);
    } },
    workflowSource: async (_repo, sha, path, maximum, signal) => { reads.push(sha); return readWorkflowCommit(s.repository, sha, path, maximum, signal); },
    sources: async () => sources,
    execute: async (job, _profile, signal) => { jobs.push(job); signals.push(signal); if (options.hold && !signal.aborted) await new Promise<void>(done => releases.push(done)); return completed(job); } };
  let service = new DaemonService(store, deps);
  const repo = await service.registerSource({ name: 'reef-labs/paperboat', profile: 'pilot', reviewers: options.reviewers ?? [], workflowPath: s.pkg.workflowPath, branch: options.branch ?? null });
  return { ...s, directory, files, firstRevision, fake, other, reads, branches, jobs, signals, repo, deps, write,
    get revision() { return revision; }, get now() { return now; }, get store() { return store; }, get service() { return service; },
    advance: (ms = 61_000) => { now += ms; }, release: () => { for (const done of releases.splice(0)) done(); },
    permissions: (allowed: boolean) => { blockedPermissions = !allowed; },
    gatePoll: (number: number) => {
      let started!: () => void, release!: () => void;
      const signal = new Promise<void>(done => { started = done; }), wait = new Promise<void>(done => { release = done; });
      metadataGate = { number, started, wait }; return { started: signal, release };
    },
    tick: async () => { await service.tick(); await service.idle(); },
    restart: async () => { await service.stop(); store.close(); store = await RuntimeStore.open(directory, options.limits); service = new DaemonService(store, deps); },
    cleanup: async () => { for (const done of releases.splice(0)) done(); await service.stop(); store.close(); await s.cleanup(); } };
}
async function call(directory: string, args: string[], json = true) {
  const child = spawn(process.execPath, [cli, 'daemon', ...args, '--state-dir', directory, ...(json ? ['--json'] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  const code = await new Promise<number | null>(done => child.once('exit', done));
  return { code, stdout, stderr, output: json ? JSON.parse(stdout) : null };
}
async function waitForJob(jobs: AnalysisJob[], total = 1): Promise<void> {
  for (let count = 0; jobs.length < total && count < 1000; count++) await new Promise(done => setTimeout(done, 1));
  assert.equal(jobs.length, total, 'The expected analysis jobs were not dispatched.');
}

test('workflow Git reader pins all referenced bytes including review.md to one commit', async () => {
  const s = await fixture();
  try {
    const prompt = s.pkg.files.find(file => file.path.endsWith('review.md'))!; assert.ok(prompt);
    const second = await s.write({ [prompt.path]: `${prompt.text}\nSecond revision.\n` });
    await writeFile(join(s.repository, prompt.path), 'Uncommitted instructions.');
    const old = await readWorkflowCommit(s.repository, s.firstRevision, s.pkg.workflowPath, supportedCapabilities);
    const next = await readWorkflowCommit(s.repository, second, s.pkg.workflowPath, supportedCapabilities);
    assert.equal(old.digest, s.pkg.digest); assert.notEqual(next.digest, old.digest);
    assert.ok(next.files.find(file => file.path === prompt.path)!.text.endsWith('Second revision.\n'));
    assert.ok(!JSON.stringify(old).includes('Uncommitted')); assert.equal(git(s.repository, 'rev-parse', 'HEAD'), second);
    await rm(join(s.repository, prompt.path)); await symlink('missing.md', join(s.repository, prompt.path));
    git(s.repository, 'add', '-A'); git(s.repository, 'commit', '-qm', 'Invalid reference');
    await assert.rejects(readWorkflowCommit(s.repository, git(s.repository, 'rev-parse', 'HEAD'), s.pkg.workflowPath, supportedCapabilities), /regular file/);
  } finally { await s.cleanup(); }
});
test('invalid source updates retain the last valid package and retry only changed invalid commits', async () => {
  const s = await fixture({ branch: 'team/workflows' });
  try {
    assert.equal(s.store.repository(s.repo.id).source!.resolvedBranch, 'team/workflows');
    assert.equal(s.branches[0], 'refs/heads/team/workflows');
    const prompt = s.pkg.files.find(file => file.path.endsWith('.md'))!.path;
    for (const changes of [{ [prompt]: null }, { [s.pkg.workflowPath]: '{invalid' }, { [s.pkg.workflowPath]: JSON.stringify({ ...s.pkg.workflow, schemaVersion: 99 }) }]) {
      await s.write({ ...s.files, ...changes }); s.advance(); await s.tick();
      const repo = s.store.repository(s.repo.id);
      assert.equal(repo.source!.status, 'invalid'); assert.equal(repo.packageDigest, s.pkg.digest);
      assert.equal(repo.source!.observedRevision, s.revision); assert.ok(repo.source!.diagnostics.length);
      const count = s.reads.length; s.advance(); await s.tick(); assert.equal(s.reads.length, count);
    }
    await s.write({ ...s.files, [prompt]: `${s.files[prompt]}\nNew guidance.\n` }); s.advance(); await s.tick();
    assert.equal(s.store.repository(s.repo.id).source!.status, 'valid'); assert.notEqual(s.store.repository(s.repo.id).packageDigest, s.pkg.digest);
    assert.equal(s.store.versions(s.repo.id).versions.length, 2);
  } finally { await s.cleanup(); }
});
test('a first invalid workflow blocks only its repository and a changed valid commit recovers it', async () => {
  const s = await fixture({ invalid: true });
  try {
    assert.equal(s.repo.package, null); assert.equal(s.repo.source!.status, 'invalid');
    await s.service.register({ name: 'reef-labs/healthy', package: s.pkg, profile: 'pilot', reviewers: [] });
    await s.tick(); s.advance(31_000); await s.tick();
    assert.equal(s.store.runs(s.repo.id).length, 0); assert.equal(s.jobs.length, 1); assert.equal(s.jobs[0]!.repositoryId, 'R_healthy');
    await s.write(s.files); s.advance(); await s.tick();
    assert.equal(s.store.repository(s.repo.id).packageDigest, s.pkg.digest); assert.equal(s.store.runs(s.repo.id).length, 1);
    assert.ok(s.branches.every(branch => branch === 'refs/heads/'));
  } finally { await s.cleanup(); }
});
test('automatic activation leaves active attempts and existing runs pinned while new runs use the source version', async () => {
  const s = await fixture({ hold: true });
  try {
    await s.tick(); s.advance(31_000); await s.service.tick();
    await waitForJob(s.jobs);
    const run = s.store.runs()[0]!, job = s.jobs[0]!, before = s.store.inspect(run.id);
    const prompt = s.pkg.files.find(file => file.path.endsWith('.md'))!.path;
    await s.write({ [prompt]: `${s.files[prompt]}\nUpdated prompt.\n` }); s.advance(); await s.service.tick();
    assert.notEqual(s.store.repository(s.repo.id).packageDigest, job.packageDigest);
    assert.equal(s.store.run(run.id).workflowVersionId, run.workflowVersionId); assert.equal(s.store.run(run.id).token, run.token);
    assert.deepEqual(s.store.inspect(run.id).attempts, before.attempts); assert.deepEqual(s.store.inspect(run.id).reservations, before.reservations);
    assert.equal(s.signals[0]!.aborted, false); s.release(); await s.service.idle();
    assert.equal((s.store.inspect(run.id).attempts[0] as any).state, 'completed');
    s.fake.pullRequests(2); s.advance(); await s.service.tick();
    assert.equal(s.store.runs().find(value => value.number === 43)!.packageDigest, s.store.repository(s.repo.id).packageDigest);
    assert.equal((await s.store.artifacts.get<Inspection>(s.store.run(run.id).inspection)).packageDigest, job.packageDigest);
  } finally { await s.cleanup(); }
});
test('explicit migration checkpoints a running attempt, cancels its process signal and rejects its late completion', async () => {
  const s = await fixture({ hold: true });
  try {
    await s.tick(); s.advance(31_000); await s.service.tick();
    await waitForJob(s.jobs);
    const run = s.store.runs()[0]!, oldJob = structuredClone(s.jobs[0]!);
    const prompt = s.pkg.files.find(file => file.path.endsWith('.md'))!.path;
    await s.write({ [prompt]: `${s.files[prompt]}\nNew instructions.\n` }); s.advance(); await s.service.tick();
    const server = await serveControl(s.directory, s.service);
    try {
      const result = await call(s.directory, ['migrate', run.id, '--version', s.store.repository(s.repo.id).activeVersionId!]);
      assert.equal(result.code, 0); assert.equal(result.output.result.checkpoint.invalidatedResults, true);
      assert.ok(result.output.result.checkpoint.ownershipToken > oldJob.ownershipToken);
      assert.equal(s.signals[0]!.aborted, true); s.release(); await s.service.idle();
      const details = s.store.inspect(run.id); assert.equal((details.attempts[0] as any).state, 'superseded');
      assert.deepEqual((details.attempts[0] as any).job, oldJob); assert.equal(details.reservations.length, 1); assert.equal(details.notes.length, 0);
      assert.equal(details.migrations.length, 1); assert.equal(details.run.control.memory?.classificationCurrent, false);
    } finally { await server.close(); }
  } finally { await s.cleanup(); }
});
test('rollback hold persists across restart, polls retain newer versions and resume-auto does not resume dispatch', async () => {
  const s = await fixture(); let server = await serveControl(s.directory, s.service);
  try {
    assert.equal((await call(s.directory, ['register-source', s.pkg.workflowPath, '--repo', s.repo.name, '--profile', 'pilot'])).code, 0);
    const first = s.repo.activeVersionId!, prompt = s.pkg.files.find(file => file.path.endsWith('.md'))!.path;
    await s.write({ [prompt]: `${s.files[prompt]}\nSecond version.\n` }); s.advance(); await s.tick();
    const second = s.store.repository(s.repo.id).activeVersionId!;
    const listing = await call(s.directory, ['versions', '--repo', s.repo.name], false);
    assert.match(listing.stdout, /ACTIVE/); assert.ok(listing.stdout.includes(s.firstRevision)); assert.ok(listing.stdout.includes(s.revision));
    assert.equal((await call(s.directory, ['rollback', 'unknown-version', '--repo', s.repo.name])).code, 7);
    assert.equal((await call(s.directory, ['rollback', first, '--repo', s.repo.name])).output.result.source.held, true);
    await server.close(); await s.restart(); server = await serveControl(s.directory, s.service);
    s.advance(); await s.tick(); assert.equal(s.store.repository(s.repo.id).activeVersionId, first);
    assert.equal(s.store.repository(s.repo.id).source!.observedRevision, s.revision);
    await s.write({ [prompt]: `${s.files[prompt]}\nThird version.\n` }); s.advance(); await s.tick();
    assert.equal(s.store.versions(s.repo.id).versions.length, 3); assert.equal(s.store.repository(s.repo.id).activeVersionId, first);
    await call(s.directory, ['pause', '--repo', s.repo.name]);
    const resumed = await call(s.directory, ['resume-auto', '--repo', s.repo.name]); assert.equal(resumed.output.result.paused, true);
    await s.tick(); const repo = s.store.repository(s.repo.id); assert.equal(repo.paused, true); assert.notEqual(repo.activeVersionId, first); assert.notEqual(repo.activeVersionId, second);
    const status = await call(s.directory, ['status'], false); assert.match(status.stdout, /paused/); assert.match(status.stdout, /automatic activation enabled/);
    const run = s.store.runs()[0]!; const inspected = await call(s.directory, ['inspect', run.id], false);
    assert.ok(inspected.stdout.includes(s.firstRevision) || inspected.stdout.includes(s.store.version(repo.id, run.workflowVersionId).sourceRevision!));
  } finally { await server.close(); await s.cleanup(); }
});
test('waiting migration retains receipts, suppression, failure continuation, backoff, counters and original deadlines', async () => {
  const s = await fixture({ reviewers: ['willow-bot'] });
  try {
    s.fake.reviewer(); await s.tick(); s.advance(31_000); await s.tick(); const run = s.store.runs()[0]!;
    const inspection = await s.store.artifacts.get<Inspection>(run.inspection), started = inspection.fixture.observations[0]!.externalReviewStartedAt!;
    s.store.retry(run.id, s.now); const claim = s.store.claim(run.id, 'fixture-worker', s.now, 300)!;
    const sources = await s.store.artifacts.put(await collectSources(s.repository, s.head, s.base));
    const job = s.store.reserve(claim, { actionId: 'classify', sources, package: s.pkg, profile: 'pilot', profileDigest: 'fixture-profile' }, s.now);
    const request = { kind: 'notice', destination: 'fictional-team', evidenceKey: claim.evidenceKey, expectedRevision: s.head, payload: await s.store.artifacts.put({ message: 'Please review.' }) };
    const effect = s.store.planEffect(claim, request, s.now); s.store.transitionEffect(claim, effect, 'planned', 'sending', null, s.now);
    s.store.transitionEffect(claim, effect, 'sending', 'confirmed', { remoteId: 'fictional-receipt' }, s.now);
    const uncertain = s.store.planEffect(claim, { ...request, destination: 'fictional-other' }, s.now); s.store.transitionEffect(claim, uncertain, 'planned', 'sending', null, s.now);
    const failed = completed(job); failed.provider.outcome = 'provider_error'; delete failed.provider.payload;
    await s.store.complete(claim, failed, s.now); const next = s.store.claim(run.id, 'checkpoint-owner', s.now, 300)!;
    const control = { ...s.store.run(run.id).control, refreshAttempts: 5 };
    s.store.park(next, 'waiting', 'Wait at failure continuation.', s.now + 61_000, control, 'handoff', s.now, true);
    const before = s.store.inspect(run.id), document = structuredClone(s.pkg.workflow); document.settings.reviewDeadlineSeconds *= 2;
    await s.write({ [s.pkg.workflowPath]: JSON.stringify(document) }); s.advance(); await s.service.poll(s.store.repository(s.repo.id));
    const version = s.store.repository(s.repo.id).activeVersionId!;
    await s.store.migrate(run.id, version, s.now);
    const after = s.store.inspect(run.id); assert.deepEqual(after.reservations, before.reservations); assert.deepEqual(after.notes, before.notes);
    assert.equal(after.run.dueAt, before.run.dueAt); assert.equal(after.run.control.refreshAttempts, 5); assert.equal(after.run.nextAction, 'handoff');
    assert.equal(after.run.suppression, before.run.suppression); assert.deepEqual(after.run.failedActions, before.run.failedActions); assert.equal(after.run.retries, before.run.retries);
    assert.equal(after.run.waitTiming!.reviewer!.until, Date.parse(started) + s.pkg.workflow.settings.reviewDeadlineSeconds * 1000);
    assert.equal(after.effects.find(value => value.id === effect)!.state, 'confirmed'); assert.equal(after.effects.find(value => value.id === uncertain)!.state, 'unknown');
    await s.restart(); s.advance(); const owner = s.store.claim(run.id, 'effect-check', s.now, 300)!;
    assert.equal(s.store.planEffect(owner, request, s.now), effect); assert.equal(s.store.effects(run.id).length, 2);
    assert.throws(() => s.store.transitionEffect(owner, uncertain, 'unknown', 'sending', null, s.now), /Invalid effect/);
    const migrated = await s.store.artifacts.get<WorkflowPackage>(s.store.run(run.id).package);
    assert.throws(() => s.store.reserve(owner, { actionId: 'classify', sources, package: migrated, profile: 'pilot', profileDigest: 'fixture' }, s.now), /suppressed/);
  } finally { await s.cleanup(); }
});
test('a migrated reviewer wait still expires at its original deadline after restart', async () => {
  const s = await fixture({ reviewers: ['willow-bot'] });
  try {
    s.fake.reviewer(); await s.tick(); s.advance(31_000); await s.tick(); const run = s.store.runs()[0]!;
    const document = structuredClone(s.pkg.workflow); document.settings.reviewDeadlineSeconds *= 2;
    await s.write({ [s.pkg.workflowPath]: JSON.stringify(document) }); await s.service.poll(s.store.repository(s.repo.id));
    await s.store.migrate(run.id, s.store.repository(s.repo.id).activeVersionId!, s.now);
    const wake = s.store.run(run.id).dueAt; await s.restart(); assert.equal(s.store.run(run.id).dueAt, wake);
    s.advance(s.pkg.workflow.settings.reviewDeadlineSeconds * 1000); await s.tick();
    assert.equal(s.jobs.length, 1); assert.equal(s.jobs[0]!.actionId, 'classify');
  } finally { await s.cleanup(); }
});
test('migration retains per-head, lifecycle, repository lifetime and UTC-day charges', async () => {
  for (const limits of [{ maxAttemptsPerLifecycle: 1 }, { repositoryCostUnits: 1 }, { dailyCostUnits: 1 }, {}]) {
    const s = await fixture({ limits });
    try {
      const run = (await s.store.observe(s.repo.id, s.inspection, s.now))!;
      const source = await s.store.artifacts.put(await collectSources(s.repository, s.head, s.base)), owner = s.store.claim(run.id, 'first', s.now, 300)!;
      const job = s.store.reserve(owner, { actionId: 'classify', sources: source, package: s.pkg, profile: 'pilot', profileDigest: 'fixture' }, s.now);
      await s.store.complete(owner, completed(job), s.now);
      const doc = structuredClone(s.pkg.workflow); if (!Object.keys(limits).length) doc.limits.maxAttemptsPerHead = 1; else doc.version = '2.0.0';
      await s.write({ [s.pkg.workflowPath]: JSON.stringify(doc) }); await s.service.poll(s.store.repository(s.repo.id));
      await s.store.migrate(run.id, s.store.repository(s.repo.id).activeVersionId!, s.now); await s.restart();
      s.store.retry(run.id, s.now); const next = s.store.claim(run.id, 'second', s.now, 300)!;
      const pkg = await s.store.artifacts.get<WorkflowPackage>(s.store.run(run.id).package);
      assert.throws(() => s.store.reserve(next, { actionId: 'classify', sources: source, package: pkg, profile: 'pilot', profileDigest: 'fixture' }, s.now), 'repositoryCostUnits' in limits ? /Repository cost-unit/ : 'dailyCostUnits' in limits ? /Daily cost-unit/ : /limit reached/);
      assert.equal(s.store.inspect(run.id).reservations.length, 1);
    } finally { await s.cleanup(); }
  }
});
test('source capability ceilings remain operator-owned and failed explicit re-registration changes nothing', async () => {
  const s = await fixture();
  try {
    const before = s.store.repository(s.repo.id);
    await assert.rejects(s.service.register({ name: s.repo.name, package: s.pkg, profile: 'pilot', reviewers: [] }), /immutable settings/);
    await assert.rejects(s.service.registerSource({ name: s.repo.name, profile: 'pilot', reviewers: [], workflowPath: s.pkg.workflowPath, branch: 'different' }), /immutable settings/);
    assert.deepEqual(s.store.repository(s.repo.id), before);
    s.profile.maximumCapabilities = [];
    const prompt = s.pkg.files.find(file => file.path.endsWith('.md'))!.path;
    await s.write({ [prompt]: `${s.files[prompt]}\nMore instructions.\n` }); s.advance(); await s.service.poll(s.store.repository(s.repo.id));
    assert.equal(s.store.repository(s.repo.id).source!.status, 'unavailable'); assert.equal(s.store.repository(s.repo.id).packageDigest, s.pkg.digest);
    assert.deepEqual(s.store.repository(s.repo.id).source!.maximumCapabilities, before.source!.maximumCapabilities);
  } finally { await s.cleanup(); }
});
test('schema-v1 stores upgrade explicit packages and runs without changing charges, receipts or ownership', async () => {
  const s = await setup(), directory = join(s.temporary, 'state'); let store = await RuntimeStore.open(directory);
  try {
    const now = Date.now(), repo = await store.register({ id: 'R_paperboat', name: 'reef-labs/paperboat', package: s.pkg, profile: 'pilot', reviewers: [] }, now);
    const run = (await store.observe(repo.id, s.inspection, now))!, claim = store.claim(run.id, 'fixture', now, 300)!;
    const source = await store.artifacts.put(await collectSources(s.repository, s.head, s.base));
    store.reserve(claim, { actionId: 'classify', sources: source, package: s.pkg, profile: 'pilot', profileDigest: 'fixture' }, now);
    const before = store.inspect(run.id); store.close();
    const db = new DatabaseSync(join(directory, 'runtime.sqlite'));
    db.exec("UPDATE metadata SET value='1' WHERE key='schema'; UPDATE repositories SET data=json_remove(data,'$.source','$.activeVersionId'); UPDATE runs SET data=json_remove(data,'$.workflowVersionId','$.waitTiming'); DROP TABLE workflow_versions; DROP TABLE migrations;"); db.close();
    store = await RuntimeStore.open(directory); const after = store.inspect(run.id);
    assert.equal(store.repository(repo.id).source, null); assert.equal(after.version.sourceRevision, null); assert.equal(after.run.token, before.run.token);
    assert.deepEqual(after.reservations, before.reservations); assert.deepEqual(after.attempts, before.attempts); assert.deepEqual(after.effects, before.effects);
    store.close(); store = await RuntimeStore.open(directory); assert.equal(store.versions(repo.id).versions.length, 1);
  } finally { store.close(); await s.cleanup(); }
});
test('repository source cannot raise the capability ceiling retained at registration', async () => {
  const s = await fixture();
  try {
    const doc = structuredClone(s.pkg.workflow);
    doc.requestedCapabilities = []; doc.actions = { park: doc.actions.park! }; doc.rules = [{ ...doc.rules[0]!, action: 'park' }]; doc.otherwise = 'park';
    const pkg = buildPackage(s.pkg.workflowPath, { [s.pkg.workflowPath]: JSON.stringify(doc) });
    const repo = s.store.registerSource({ id: 'R_restricted', name: 'reef-labs/restricted', profile: 'pilot', reviewers: [], workflowPath: pkg.workflowPath, branch: null, maximumCapabilities: [] }, s.now);
    await s.store.activateSource(repo.id, s.firstRevision, 'main', pkg, s.now);
    await assert.rejects(s.store.activateSource(repo.id, 'b'.repeat(40), 'main', s.pkg, s.now), /ceiling|capabilit|permission/i);
    assert.equal(s.store.repository(repo.id).packageDigest, pkg.digest);
  } finally { await s.cleanup(); }
});
test('configuration-PR local analysis uses its proposed pinned Markdown without activating it', async () => {
  const s = await fixture();
  try {
    const prompt = s.pkg.files.find(file => file.path.endsWith('review.md'))!.path;
    const proposed = await s.write({ [prompt]: `${s.files[prompt]}\nReview the proposed configuration.\n` });
    const pkg = await loadWorkflow(join(s.repository, s.pkg.workflowPath));
    const capture = await saveCapture(join(s.temporary, 'trial-capture'), { ...s.inspection, packageDigest: pkg.digest });
    const result = spawnSync(process.execPath, [cli, 'analyze', join(s.repository, pkg.workflowPath), '--capture', capture.directory, '--source-repo', s.repository,
      '--output-dir', join(s.temporary, 'trial-output'), '--provider-config', s.settings, '--profile', 'pilot', '--json'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr); const output = JSON.parse(result.stdout);
    assert.equal(output.packageDigest, pkg.digest); assert.equal(output.headSha, s.head); assert.notEqual(proposed, s.head);
    assert.equal(s.store.repository(s.repo.id).packageDigest, s.pkg.digest); assert.equal(git(s.repository, 'status', '--porcelain'), '');
  } finally { await s.cleanup(); }
});
test('workflow fetch uses one exact commit, keeps credentials out of arguments and removes temporary Git data', async () => {
  const s = await fixture(), bin = join(s.temporary, 'bin'), record = join(s.temporary, 'git-calls.jsonl'); await mkdir(bin);
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim(), oldPath = process.env.PATH;
  await writeFile(join(bin, 'git'), `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),args=process.argv.slice(2);
if(args.includes('fetch')) { if(!process.env.GIT_CONFIG_VALUE_0?.startsWith('Authorization: Basic '))process.exit(90); args[args.findIndex(x=>x.startsWith('https://github.com/'))]=${JSON.stringify(s.repository)}; }
fs.appendFileSync(${JSON.stringify(record)},JSON.stringify(args)+'\\n');
const result=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit',env:process.env});process.exit(result.status??1);
`, { mode: 0o700 });
  try {
    process.env.PATH = `${bin}:${oldPath}`;
    const cache = join(s.directory, 'workflow-cache');
    const pkg = await fetchWorkflowCommit(cache, s.repo.name, s.firstRevision, s.pkg.workflowPath, supportedCapabilities, tokenCredentials('fictional-workflow-token'), new AbortController().signal);
    assert.equal(pkg.digest, s.pkg.digest); assert.deepEqual(await readdir(cache), []);
    const calls = await readFile(record, 'utf8'); assert.ok(calls.includes(s.firstRevision)); assert.ok(!calls.includes('fictional-workflow-token')); assert.ok(!calls.includes('Authorization:'));
    await assert.rejects(fetchWorkflowCommit(cache, s.repo.name, s.firstRevision, s.pkg.workflowPath, supportedCapabilities, tokenCredentials('fictional-workflow-token'), new AbortController().signal, () => false), /cooldown/);
    assert.deepEqual(await readdir(cache), []);
  } finally { process.env.PATH = oldPath; await s.cleanup(); }
});
test('shortening a migrated reviewer deadline preserves the current hint until its original deadline or removal', async () => {
  const s = await fixture({ reviewers: ['willow-bot'] });
  try {
    s.fake.reviewer(); await s.tick(); s.advance(31_000); await s.tick(); const run = s.store.runs()[0]!;
    const document = structuredClone(s.pkg.workflow); document.settings.reviewDeadlineSeconds = 60;
    await s.write({ [s.pkg.workflowPath]: JSON.stringify(document) }); await s.service.poll(s.store.repository(s.repo.id));
    await s.store.migrate(run.id, s.store.repository(s.repo.id).activeVersionId!, s.now);
    await s.restart(); s.advance(400_000); await s.tick();
    assert.equal(s.jobs.length, 0); assert.equal(s.store.run(run.id).status, 'waiting');
    assert.equal((await s.store.artifacts.get<Inspection>(s.store.run(run.id).inspection)).fixture.observations[0]!.facts.externalReviewPending, true);
    s.fake.reviewer(false); s.advance(); await s.tick(); assert.equal(s.jobs.length, 1);
    assert.equal((await s.store.artifacts.get<Inspection>(s.store.run(run.id).inspection)).fixture.observations[0]!.facts.externalReviewPending, false);
  } finally { await s.cleanup(); }
});
test('migration during polling discards only its stale observation and preserves a second active run', async () => {
  const s = await fixture({ hold: true, limits: { repositoryConcurrency: 2 } }); let releasePoll: (() => void) | undefined;
  try {
    s.fake.pullRequests(2); await s.tick(); s.advance(31_000); await s.service.tick(); await waitForJob(s.jobs, 2);
    const migrating = s.store.runs().find(run => run.number === 42)!, untouched = s.store.runs().find(run => run.number === 43)!;
    const before = s.store.inspect(untouched.id), prompt = s.pkg.files.find(file => file.path.endsWith('.md'))!.path;
    await s.write({ [prompt]: `${s.files[prompt]}\nNew source.\n` });
    await s.service.registerSource({ name: s.repo.name, profile: 'pilot', reviewers: [], workflowPath: s.pkg.workflowPath, branch: null });
    const gate = s.gatePoll(42); releasePoll = gate.release;
    const poll = s.service.poll(s.store.repository(s.repo.id)); await gate.started;
    await s.store.migrate(migrating.id, s.store.repository(s.repo.id).activeVersionId!, s.now); s.service.abortStale();
    gate.release(); await poll;
    const after = s.store.inspect(untouched.id);
    assert.equal(after.run.evidenceAvailable, true); assert.equal(after.run.owner, before.run.owner); assert.equal(after.run.token, before.run.token);
    assert.deepEqual(after.attempts, before.attempts); assert.deepEqual(after.reservations, before.reservations);
    assert.equal(s.signals[s.jobs.findIndex(job => job.runId === untouched.id)]!.aborted, false);
    assert.match(s.store.repository(s.repo.id).diagnostic!, /workflow changed during PR collection/);
    s.release(); await s.service.idle();
    assert.equal(s.store.inspect(untouched.id).notes.length, 1); assert.equal(s.store.run(untouched.id).control.memory?.classificationCurrent, true);
    assert.equal(s.store.inspect(migrating.id).notes.length, 0);
  } finally { releasePoll?.(); await s.cleanup(); }
});
test('restored live permissions activate a first valid source without a new commit', async () => {
  const s = await fixture({ blockedPermissions: true });
  try {
    const blocked = s.store.repository(s.repo.id);
    assert.equal(blocked.package, null); assert.equal(blocked.source!.status, 'unavailable'); assert.equal(s.reads.length, 1);
    await s.restart(); s.permissions(true); s.advance(); await s.tick();
    const recovered = s.store.repository(s.repo.id);
    assert.equal(recovered.source!.observedRevision, blocked.source!.observedRevision); assert.equal(recovered.source!.status, 'valid');
    assert.equal(recovered.packageDigest, s.pkg.digest); assert.equal(s.reads.length, 2);
    assert.deepEqual(recovered.source!.maximumCapabilities, blocked.source!.maximumCapabilities);
  } finally { await s.cleanup(); }
});
