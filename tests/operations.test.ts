import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore, backupState, restoreState } from '@repo-chap/runtime';
import { DaemonService, serveControl, deliverSlack } from '@repo-chap/daemon';
import { tokenCredentials } from '@repo-chap/github';
import { SlackApi } from '@repo-chap/slack/web-api';
import { buildPackage } from '@repo-chap/workflow';
import { setup } from './helpers/provider-fixture.ts';
import { decisionPacket, slackConfig } from './helpers/slack-fixture.ts';

const execute = promisify(execFile), cli = resolve('apps/cli/dist/cli.js'), preload = resolve('tests/helpers/operations-preload.mjs');
async function installation() {
  const root = await mkdtemp(join(tmpdir(), 'chap-ops-')), configRoot = join(root, 'config'), state = join(root, 'state'), provider = join(root, 'provider');
  await execute(process.execPath, [resolve('tests/helpers/operations-setup.mjs'), configRoot, provider]);
  const config = join(configRoot, 'installation.json'), env = { ...process.env, NODE_OPTIONS: `--import=${preload}` };
  const command = async (...args: string[]) => {
    try { const value = await execute(process.execPath, [cli, 'daemon', ...args, '--json'], { env, timeout: 30_000 }); return { code: 0, output: JSON.parse(value.stdout), stderr: value.stderr }; }
    catch (error) { const value = error as { code: number; stdout: string; stderr: string }; return { code: value.code, output: JSON.parse(value.stdout), stderr: value.stderr }; }
  };
  let child: ChildProcess | undefined;
  const stop = async () => { if (!child) return; const current = child; child = undefined; if (current.exitCode !== null || current.signalCode !== null) return; const exited = new Promise<void>(done => current.once('exit', () => done())); current.kill('SIGTERM'); await exited; };
  const start = async (directory: string) => {
    child = spawn(process.execPath, [cli, 'daemon', 'start', '--state-dir', directory, '--config', config, '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.resume(); child.stderr?.resume();
    for (let i = 0; i < 40; i++) { const result = await command('status', '--state-dir', directory); if (!result.code) return result.output.result; await delay(25); }
    throw new Error('Fictional daemon did not start.');
  };
  return { root, state, config, configRoot, provider, command, start, stop, cleanup: async () => { await stop(); await rm(root, { recursive: true, force: true }); } };
}

test('built CLI restore uses saved limits when omitted before and after release, and accepts later explicit settings', async () => {
  const s = await installation(), restored = join(s.root, 'restored'), backup = join(s.root, 'backup');
  try {
    await s.start(s.state); await s.stop();
    assert.equal((await s.command('backup', backup, '--state-dir', s.state, '--config', s.config)).code, 0);
    assert.equal((await s.command('restore', backup, '--state-dir', restored)).code, 0);
    const config = JSON.parse(await readFile(s.config, 'utf8')); delete config.limits; await writeFile(s.config, JSON.stringify(config));
    let status = await s.start(restored); assert.equal(status.recovery.paused, true); assert.equal(status.limits.repositoryCostUnits, 5);
    assert.equal((await s.command('resume-restored', '--state-dir', restored)).code, 7);
    assert.equal((await s.command('reconcile', '--state-dir', restored)).code, 0);
    assert.equal((await s.command('resume-restored', '--state-dir', restored)).code, 0);
    await s.stop(); status = await s.start(restored); assert.equal(status.limits.repositoryCostUnits, 5); assert.equal(status.recovery.paused, false);
    await s.stop(); config.limits = { repositoryCostUnits: 8 }; await writeFile(s.config, JSON.stringify(config));
    status = await s.start(restored); assert.equal(status.limits.repositoryCostUnits, 8);
    await s.stop(); delete config.limits; await writeFile(s.config, JSON.stringify(config)); status = await s.start(restored); assert.equal(status.limits.repositoryCostUnits, 8);
  } finally { await s.cleanup(); }
});

test('account diagnostics exercise provider/App access and keep live ownership and private data intact', async () => {
  const s = await installation();
  try {
    await s.start(s.state);
    const database = new DatabaseSync(join(s.state, 'runtime.sqlite'));
    const before = database.prepare("SELECT value FROM metadata WHERE key='daemon_owner'").get();
    const diagnosed = await s.command('diagnose', '--state-dir', s.state, '--config', s.config);
    assert.equal(diagnosed.code, 0, JSON.stringify(diagnosed.output));
    assert.equal(diagnosed.output.account.uid, process.getuid!());
    assert.ok(diagnosed.output.checks.some((value: any) => value.check === 'provider:pilot' && value.ok));
    assert.ok(diagnosed.output.checks.some((value: any) => value.check === 'github-app' && value.ok));
    assert.deepEqual(database.prepare("SELECT value FROM metadata WHERE key='daemon_owner'").get(), before); database.close();
    assert.ok(!JSON.stringify(diagnosed.output).includes('fictional-installation-token'));
    await writeFile(s.provider, '#!/usr/bin/env node\nconsole.error("private-provider-secret");process.exit(1);\n');
    const failed = await s.command('diagnose', '--state-dir', s.state, '--config', s.config);
    assert.equal(failed.code, 7); assert.ok(!JSON.stringify(failed).includes('private-provider-secret')); assert.match(JSON.stringify(failed.output), /executable|installation|profile/);
    await chmod(s.config, 0o644); const invalid = await s.command('diagnose', '--state-dir', s.state, '--config', s.config);
    assert.equal(invalid.code, 7); assert.match(JSON.stringify(invalid.output), /0600/);
  } finally { await s.cleanup(); }
});

test('restored Slack CLI recovery separates logical delivery from historical attempts and never grants sends', async () => {
  const s = await setup(), state = join(s.temporary, 'state'), restored = join(s.temporary, 'restored'), now = Date.now();
  let store = await RuntimeStore.open(state), control: Awaited<ReturnType<typeof serveControl>> | undefined, service: DaemonService | undefined;
  try {
    const repo = await store.register({ id: 'R_paperboat', name: 'reef-labs/paperboat', package: s.pkg, profile: 'pilot', reviewers: [] }, now);
    const run = (await store.observe(repo.id, s.inspection, now))!, claim = store.claim(run.id, 'packet', now, 300)!;
    const request = await store.slack.queue(claim, { ...decisionPacket, headSha: s.head }, slackConfig, now);
    store.park(claim, 'waiting', 'Retained handoff.', now + 3600_000, run.control, '$wait', now);
    const original = store.slack.deliveries()[0]!, lease = store.slack.begin(original.id, 'GENGINEERS', 'sender', now)!;
    store.slack.finish(lease, { status: 'unknown', reason: 'Fictional response lost.' }, now);
    const next = store.slack.reconcile(original.id, { action: 'resend' }, now + 1); assert.ok(store.slack.begin(next.id, 'GENGINEERS', 'sender', now + 1));
    store.slack.dm('TFOREST', 'UWILLOW', 'DWILLOW'); store.slack.rate('workspace:TFOREST', now + 7200_000);
    await backupState(state, join(s.temporary, 'backup')); store.close(); await restoreState(join(s.temporary, 'backup'), restored); store = await RuntimeStore.open(restored);
    assert.equal(store.slack.request(request.id).resends, 1); assert.equal(store.slack.dm('TFOREST', 'UWILLOW'), 'DWILLOW'); assert.equal(store.slack.rate('workspace:TFOREST'), now + 7200_000);
    assert.equal(store.claimForEffect(next.id, 'unexpected', now + 2, 30), null);
    let sends = 0;
    const api = new SlackApi({ workspaceId: 'TFOREST', token: async () => { sends++; throw new Error(); }, rates: { read: () => 0, extend: () => {} } });
    await deliverSlack(store, api, Date.now, new AbortController().signal, async () => true); assert.equal(sends, 0);
    service = new DaemonService(store, { directory: restored, credentials: tokenCredentials('fictional-token'), profile: async () => s.profile });
    control = await serveControl(restored, service);
    const command = async (...args: string[]) => JSON.parse((await execute(process.execPath, [cli, 'daemon', ...args, '--state-dir', restored, '--json'])).stdout);
    let status = (await command('status')).result; assert.equal(status.recovery.unknownEffects, 1); assert.equal(status.recovery.historicalUnknownAttempts, 1);
    await command('reconcile'); await command('resume-restored', '--keep-unknown');
    assert.equal(store.slack.delivery(next.id).state, 'unknown'); assert.equal(store.slack.request(request.id).resends, 1);
    await command('slack-reconcile', next.id, '--delivered', '--workspace', 'TFOREST', '--channel', 'GENGINEERS', '--timestamp', '123456.000001');
    status = (await command('status')).result; assert.equal(status.recovery.unknownEffects, 0); assert.equal(status.recovery.historicalUnknownAttempts, 2);
    assert.equal(store.slack.delivery(next.id).state, 'confirmed'); assert.equal(store.slack.delivery(next.id).attempts[0]!.state, 'unknown');
    assert.equal((await command('inbox')).result[0].resends, 1); assert.equal(store.inspect(run.id).reservations.length, 0); assert.equal(sends, 0);
  } finally { await control?.close(); await service?.stop(); store.close(); await s.cleanup(); }
});

test('restored planned Slack work cannot claim or prepare delivery until recovery is released', async () => {
  const s = await setup(), state = join(s.temporary, 'state'), restored = join(s.temporary, 'restored'), now = Date.now();
  let store = await RuntimeStore.open(state);
  try {
    const repo = await store.register({ id: 'R_paperboat', name: 'reef-labs/paperboat', package: s.pkg, profile: 'pilot', reviewers: [] }, now);
    const run = (await store.observe(repo.id, s.inspection, now))!, claim = store.claim(run.id, 'packet', now, 300)!;
    await store.slack.queue(claim, { ...decisionPacket, headSha: s.head }, slackConfig, now);
    store.park(claim, 'waiting', 'Retained handoff.', now + 3600_000, run.control, '$wait', now);
    const pending = store.slack.deliveries()[0]!;
    await backupState(state, join(s.temporary, 'backup')); store.close(); await restoreState(join(s.temporary, 'backup'), restored); store = await RuntimeStore.open(restored);
    assert.equal(store.slack.delivery(pending.id).state, 'planned');
    assert.equal(store.claimForEffect(pending.id, 'sender', now + 1, 30), null);
    let requests = 0;
    const api = new SlackApi({ workspaceId: 'TFOREST', token: async () => { requests++; throw new Error(); }, rates: { read: () => 0, extend: () => {} } });
    await deliverSlack(store, api, () => now + 1, new AbortController().signal, async () => true);
    assert.equal(requests, 0); assert.deepEqual(store.slack.delivery(pending.id), pending);
    store.recordRecoveryReconciliation(now + 2); store.resumeRestoredState(false);
    assert.ok(store.claimForEffect(pending.id, 'sender', now + 2, 30));
    assert.equal(store.inspect(run.id).reservations.length, 0);
  } finally { store.close(); await s.cleanup(); }
});

test('backup validates known reference fields without treating ordinary workflow data as artifacts', async () => {
  const s = await setup(), directory = join(s.temporary, 'state'), store = await RuntimeStore.open(directory);
  try {
    const layout = { id: 'not-an-artifact', digest: 'ordinary-user-data', bytes: 123 };
    const files = Object.fromEntries(s.pkg.files.map(file => [file.path, file.text]));
    files[s.pkg.workflowPath] = JSON.stringify({ ...s.pkg.workflow, layout });
    const pkg = buildPackage(s.pkg.workflowPath, files);
    const repo = await store.register({ id: 'R_paperboat', name: 'reef-labs/paperboat', package: pkg, profile: 'pilot', reviewers: [] }, Date.now());
    const db = new DatabaseSync(join(directory, 'runtime.sqlite')); db.exec('CREATE TABLE retained_extra(data TEXT)'); db.prepare('INSERT INTO retained_extra VALUES (?)').run(JSON.stringify(layout)); db.close();
    await backupState(directory, join(s.temporary, 'backup'));
    await rm(join(directory, 'artifacts'), { recursive: true }); await mkdir(join(s.temporary, 'elsewhere'), { mode: 0o700 }); await symlink(join(s.temporary, 'elsewhere'), join(directory, 'artifacts'));
    await assert.rejects(backupState(directory, join(s.temporary, 'linked')), /directories/);
    assert.ok(repo.package!.id);
  } finally { store.close(); await s.cleanup(); }
});
