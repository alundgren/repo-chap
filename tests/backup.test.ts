import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupState, restoreState, inspectStoredConfiguration, RuntimeStore, type ApplyPolicy } from '@repo-chap/runtime';
import { captureRepairSource, restoreCandidate, readRepairAttempt, readArtifact } from '@repo-chap/execution';
import { executeRepair, profileDigest } from '@repo-chap/daemon';
import { repairFixture } from './helpers/repair-fixture.ts';
import { git, setup } from './helpers/provider-fixture.ts';
import { completed } from './helpers/daemon-remote.ts';
import { decisionPacket, slackConfig } from './helpers/slack-fixture.ts';

test('backup retains tested candidate, source, check artifacts, waits, holds, limits and uncertain send history', async () => {
  const s = await repairFixture(), directory = join(s.temporary, 'state'), destination = join(s.temporary, 'backup'), restored = join(s.temporary, 'restored-state');
  let store = await RuntimeStore.open(directory, { repositoryCostUnits: 2 });
  try {
    const now = Date.now(), repo = store.registerSource({ id: 'R_paperboat', name: 'reef-labs/paperboat', profile: 'pilot', reviewers: [], workflowPath: s.pkg.workflowPath, branch: null, maximumCapabilities: s.profile.maximumCapabilities }, now);
    const version = await store.activateSource(repo.id, 'a'.repeat(40), 'main', s.pkg, now); store.rollback(repo.id, version.id);
    const run = (await store.observe(repo.id, s.inspection, now))!, claim = store.claim(run.id, 'worker', now, 300)!;
    const source = await captureRepairSource(s.repository, s.head, s.base, join(directory, 'repairs'));
    const policy: ApplyPolicy = { schemaVersion: 1, repository: repo.name, capabilities: ['workspace.write', 'checks.run', 'pr.push'], maxRepairsPerLifecycle: 2, maxPushAttempts: 2, execution: s.policy };
    const job = store.reserveRepair(claim, { actionId: 'address', sources: source, package: s.pkg, profile: 'pilot', profileDigest: profileDigest(s.profile), applyPolicy: policy }, now);
    const result = await executeRepair(job, { artifacts: store.artifacts, profile: s.profile, artifactDirectory: join(directory, 'repairs'), workerDirectory: join(directory, 'workers'), isCurrent: () => store.isCurrent(claim, Date.now()) });
    assert.equal(result.repair.status, 'candidate'); assert.equal(await store.completeRepair(claim, result, now + 10), true);
    const effectClaim = store.claim(run.id, 'sender', now + 1000, 300)!;
    const payload = await store.artifacts.put({ source, candidate: result.reference });
    const id = store.planEffect(effectClaim, { kind: 'fictional.notice', destination: 'C_FICTIONAL', expectedRevision: s.head, evidenceKey: effectClaim.evidenceKey, payload }, now + 1000);
    const lease = store.beginEffect(effectClaim, id, 2, now + 1000);
    store.park(effectClaim, 'waiting', 'Waiting for a human reviewer.', now + 3600_000, store.run(run.id).control, '$wait', now + 1001);
    store.pause(repo.id, true, now + 1002);
    const before = store.inspect(run.id), owner = store.claimDaemon();
    await assert.rejects(backupState(directory, destination, store.limits), /already owns/);
    store.releaseDaemon(owner);
    const manifest = await backupState(directory, destination, store.limits);
    assert.equal(manifest.runtimeSchema, '4'); assert.equal(manifest.limits.repositoryCostUnits, 2);
    assert.ok(manifest.files.some(file => file.path === `repairs/attempt-${job.attemptId}.json`));
    assert.ok(!manifest.files.some(file => /workers|git-cache/.test(file.path)));
    await rm(s.repository, { recursive: true }); await rm(join(directory, 'workers'), { recursive: true, force: true });
    store.close(); await rm(directory, { recursive: true }); await restoreState(destination, restored);
    store = await RuntimeStore.open(restored, manifest.limits);
    const after = store.inspect(run.id);
    assert.deepEqual(after.reservations, before.reservations); assert.deepEqual(after.attempts, before.attempts); assert.deepEqual(after.notes, before.notes);
    assert.equal(after.run.dueAt, before.run.dueAt); assert.equal(after.run.nextAction, before.run.nextAction); assert.deepEqual(after.version, before.version);
    assert.equal(store.repository(repo.id).paused, true); assert.equal(store.repository(repo.id).source?.held, true);
    assert.equal(store.effects(run.id)[0]!.state, 'unknown'); assert.equal(store.effectAttempts(id)[0]!.state, 'unknown');
    assert.equal(store.effectCurrent(lease, now + 2000), false); assert.equal(store.recovery().paused, true);
    assert.equal(store.claim(run.id, 'unexpected', now + 4000_000, 300), null);
    assert.throws(() => store.resumeRestoredState(true), /reconcile/);
    store.recordRecoveryReconciliation(now + 2000); assert.throws(() => store.resumeRestoredState(false), /Uncertain/);
    store.resumeRestoredState(true); assert.equal(store.repository(repo.id).paused, true); assert.equal(store.repository(repo.id).source?.held, true);
    assert.equal(store.effects(run.id)[0]!.state, 'unknown'); assert.equal(store.effectAttempts(id).length, 1);
    const candidate = join(s.temporary, 'candidate'); await restoreCandidate(join(restored, 'repairs'), result.reference, candidate);
    assert.equal(git(candidate, 'rev-parse', 'HEAD'), result.repair.candidate!.sha);
    assert.equal((await readArtifact(join(restored, 'repairs'), result.repair.checks[0]!.log!)).length >= 0, true);
    assert.equal((await readRepairAttempt(join(restored, 'repairs'), job.attemptId)).state, 'completed');
  } finally { store.close(); await s.cleanup(); }
});

test('empty restored installations keep a global dispatch pause across registration and restart', async () => {
  const s = await setup(), directory = join(s.temporary, 'state'), destination = join(s.temporary, 'backup'), restored = join(s.temporary, 'restored');
  let store = await RuntimeStore.open(directory);
  try {
    store.close(); await backupState(directory, destination); await restoreState(destination, restored); store = await RuntimeStore.open(restored);
    const now = Date.now(), repo = await store.register({ id: 'R_paperboat', name: 'reef-labs/paperboat', package: s.pkg, profile: 'pilot', reviewers: [] }, now);
    const run = (await store.observe(repo.id, s.inspection, now))!;
    assert.equal(store.claim(run.id, 'worker', now, 300), null); store.close(); store = await RuntimeStore.open(restored);
    assert.equal(store.recovery().paused, true); store.recordRecoveryReconciliation(now); store.resumeRestoredState(false);
    assert.ok(store.claim(run.id, 'worker', now, 300));
  } finally { store.close(); await s.cleanup(); }
});

test('schema 3 upgrade rejects a live prior owner and retains jobs, charges, holds and every effect state', async () => {
  const s = await setup(), directory = join(s.temporary, 'state'); let store = await RuntimeStore.open(directory);
  try {
    const now = Date.now(), repo = store.registerSource({ id: 'R_paperboat', name: 'reef-labs/paperboat', profile: 'pilot', reviewers: [], workflowPath: s.pkg.workflowPath, branch: null, maximumCapabilities: s.profile.maximumCapabilities }, now);
    const version = await store.activateSource(repo.id, 'a'.repeat(40), 'main', s.pkg, now); store.rollback(repo.id, version.id);
    const run = (await store.observe(repo.id, s.inspection, now))!, claim = store.claim(run.id, 'analysis', now, 300)!;
    const job = store.reserve(claim, { actionId: 'classify', package: s.pkg, sources: await store.artifacts.put({ fixture: 'source' }), profile: 'pilot', profileDigest: profileDigest(s.profile) }, now);
    await store.complete(claim, completed(job), now + 1);
    const sender = store.claim(run.id, 'sender', now + 2, 300)!;
    for (const state of ['confirmed', 'unknown', 'sending'] as const) {
      const id = store.planEffect(sender, { kind: `fictional.${state}`, destination: 'C_FICTIONAL', expectedRevision: s.head, evidenceKey: sender.evidenceKey, payload: await store.artifacts.put({ state }) }, now + 2);
      const lease = store.beginEffect(sender, id, 2, now + 2);
      if (state !== 'sending') store.finishEffect(lease, state, { reason: `Retained ${state}.` }, now + 3);
    }
    await store.slack.queue(sender, { ...decisionPacket, headSha: s.head }, slackConfig, now + 3);
    store.slack.rate('workspace:TFOREST', now + 3600_000); store.slack.dm('TFOREST', 'UWILLOW', 'DWILLOW');
    store.park(sender, 'waiting', 'Waiting for human input.', now + 3600_000, store.run(run.id).control, '$wait', now + 4); store.pause(repo.id, true, now + 4);
    const owner = store.claimDaemon(), before = store.inspect(run.id), requests = store.slack.requests(), deliveries = store.slack.deliveries(), repository = store.repository(repo.id);
    const attempts = before.effects.map(effect => store.effectAttempts(effect.id)); store.close();
    const db = new DatabaseSync(join(directory, 'runtime.sqlite')); db.prepare("UPDATE metadata SET value='3' WHERE key='schema'").run();
    assert.equal((await inspectStoredConfiguration(directory)).schema, '3');
    await assert.rejects(RuntimeStore.open(directory), /already owns/);
    await assert.rejects(backupState(directory, join(s.temporary, 'blocked-backup')), /already owns/);
    assert.equal(db.prepare("SELECT value FROM metadata WHERE key='schema'").get()!.value, '3');
    assert.match(String(db.prepare("SELECT value FROM metadata WHERE key='daemon_owner'").get()!.value), new RegExp(owner));
    db.prepare("DELETE FROM metadata WHERE key='daemon_owner'").run(); db.close();
    store = await RuntimeStore.open(directory); assert.deepEqual(store.inspect(run.id), before);
    assert.deepEqual(store.repository(repo.id), repository); assert.deepEqual(store.slack.requests(), requests); assert.deepEqual(store.slack.deliveries(), deliveries);
    assert.deepEqual(before.effects.map(effect => store.effectAttempts(effect.id)), attempts);
    assert.equal(store.slack.rate('workspace:TFOREST'), now + 3600_000); assert.equal(store.slack.dm('TFOREST', 'UWILLOW'), 'DWILLOW');
    const check = new DatabaseSync(join(directory, 'runtime.sqlite')); assert.equal(check.prepare("SELECT value FROM metadata WHERE key='schema'").get()!.value, '4'); check.close();
  } finally { store.close(); await s.cleanup(); }
});

test('backup captures committed WAL data and future table rows without rebuilding the database', async () => {
  const s = await setup(), directory = join(s.temporary, 'state'), destination = join(s.temporary, 'backup'), restored = join(s.temporary, 'restored');
  const store = await RuntimeStore.open(directory);
  try {
    const db = new DatabaseSync(join(directory, 'runtime.sqlite')); db.exec('PRAGMA wal_autocheckpoint=0; CREATE TABLE retained_history (value TEXT NOT NULL);');
    db.prepare('INSERT INTO retained_history VALUES (?)').run(JSON.stringify({ receipt: 'fictional-accepted', attempts: [1, 2] }));
    const manifest = await backupState(directory, destination); assert.ok((await readdir(directory)).includes('runtime.sqlite-wal'));
    db.close(); await restoreState(destination, restored);
    const result = new DatabaseSync(join(restored, 'runtime.sqlite')); assert.equal(JSON.parse(String(result.prepare('SELECT value FROM retained_history').get()!.value)).receipt, 'fictional-accepted'); result.close();
    assert.ok(manifest.files.every(file => !file.path.endsWith('-wal') && !file.path.endsWith('-shm')));
  } finally { store.close(); await s.cleanup(); }
});

test('backup and restore reject contained destinations, corruption and incomplete durable data', async () => {
  const s = await setup(), directory = join(s.temporary, 'state'), destination = join(s.temporary, 'backup'), restored = join(s.temporary, 'restored');
  const store = await RuntimeStore.open(directory);
  try {
    const repo = await store.register({ id: 'R_paperboat', name: 'reef-labs/paperboat', package: s.pkg, profile: 'pilot', reviewers: [] }, Date.now());
    await assert.rejects(backupState(directory, join(directory, '..backup')), /outside its source/);
    await assert.rejects(readdir(join(directory, '..backup')), { code: 'ENOENT' });
    assert.deepEqual(store.repository(repo.id), repo);
    const manifest = await backupState(directory, destination);
    const snapshot = await readFile(join(destination, 'runtime.sqlite'));
    await assert.rejects(restoreState(destination, join(destination, '..restore')), /outside its source/);
    await assert.rejects(readdir(join(destination, '..restore')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(destination, 'runtime.sqlite')), snapshot);
    assert.equal(await readFile(join(destination, 'manifest.json'), 'utf8'), JSON.stringify(manifest));
    const validDestination = join(s.temporary, 'valid-restored'); await restoreState(destination, validDestination);
    const valid = await RuntimeStore.open(validDestination);
    try { assert.deepEqual(valid.repository(repo.id), repo); } finally { valid.close(); }
    await writeFile(join(destination, 'manifest.json'), JSON.stringify({ ...manifest, runtimeSchema: '3' }));
    await assert.rejects(restoreState(destination, join(s.temporary, 'wrong-schema')), /schema/);
    await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest));
    await mkdir(restored, { mode: 0o700 }); await writeFile(join(restored, 'preserved'), 'existing state');
    await assert.rejects(restoreState(destination, restored), /new destination/); assert.equal(await readFile(join(restored, 'preserved'), 'utf8'), 'existing state');
    const saved = manifest.files.find(file => file.path.startsWith('artifacts/'))!; await writeFile(join(destination, saved.path), 'corrupt');
    await assert.rejects(restoreState(destination, join(s.temporary, 'corrupt')), /integrity/);
    await rm(join(directory, 'artifacts', repo.package!.id));
    await assert.rejects(backupState(directory, join(s.temporary, 'missing')), /missing or corrupt/);
  } finally { store.close(); await s.cleanup(); }
});
