import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { RuntimeStore } from '@repo-chap/runtime';
import { buildPackage, canonicalJson, digest } from '@repo-chap/workflow';
import { DaemonService, deliverSlack, serveControl } from '@repo-chap/daemon';
import { tokenCredentials } from '@repo-chap/github';
import { SlackApi, type SlackReceipt } from '@repo-chap/slack/web-api';
import type { DecisionPacket, SlackConfiguration } from '@repo-chap/slack';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setup } from './helpers/provider-fixture.ts';
import { decisionPacket, slackConfig } from './helpers/slack-fixture.ts';

async function fixture(options: { source?: boolean } = {}) {
  const source = await setup(), directory = join(source.temporary, 'slack-state');
  let store = await RuntimeStore.open(directory), now = Date.now();
  const repo = options.source ? store.registerSource({ id: 'R_paperboat', name: 'reef-labs/paperboat', workflowPath: source.pkg.workflowPath, branch: 'main', profile: source.profile.name, reviewers: [], maximumCapabilities: source.profile.maximumCapabilities }, now) : await store.register({ id: 'R_paperboat', name: 'reef-labs/paperboat', package: source.pkg, profile: source.profile.name, reviewers: [] }, now);
  if (options.source) await store.activateSource(repo.id, '1'.repeat(40), 'main', source.pkg, now);
  let inspection = source.inspection;
  const run = (await store.observe(repo.id, inspection, now))!;
  const calls: { method: string; body: Record<string, any> }[] = [];
  let fail: 'lost' | 'access' | 'rate' | null = null;
  const createApi = () => new SlackApi({ workspaceId: slackConfig.workspaceId, token: async () => 'fictional-token', now: () => now, rates: { read: key => store.slack.rate(key), extend: (key, until) => { store.slack.rate(key, until); } }, transport: async (url, options) => {
    const method = String(url).split('/').at(-1)!, body = JSON.parse(String(options?.body)); calls.push({ method, body });
    if (method === 'auth.test') return new Response(JSON.stringify({ ok: true, team_id: slackConfig.workspaceId }));
    if (method === 'conversations.open') return new Response(JSON.stringify({ ok: true, channel: { id: 'DWILLOW' } }));
    if (fail === 'lost') throw new Error('accepted but lost response');
    if (fail === 'access') return new Response(JSON.stringify({ ok: false, error: 'not_in_channel' }));
    if (fail === 'rate') return new Response('', { status: 429, headers: { 'retry-after': '2' } });
    return new Response(JSON.stringify({ ok: true, channel: body.channel, ts: body.ts ?? `${calls.length}.000001` }));
  } });
  let api = createApi();
  const queue = async (input: Partial<DecisionPacket> = {}, config: SlackConfiguration | undefined = slackConfig) => {
    const current = store.run(run.id), claim = store.claim(run.id, 'packet-worker', now, 300)!; assert.ok(claim);
    const request = await store.slack.queue(claim, { ...decisionPacket, headSha: current.headSha!, ...input }, config, now);
    store.park(claim, 'waiting', 'Packet queued.', now, current.control, null, now); return request;
  };
  const deliver = async (cycles = 8) => { for (let i = 0; i < cycles; i++) { await deliverSlack(store, api, () => now, new AbortController().signal, async () => true); now += 1500; } };
  const revise = async (head = false) => {
    inspection = structuredClone(inspection); inspection.evidence.pullRequest!.body += '\nNew evidence.';
    if (head) { inspection.evidence.pullRequest!.headSha = 'd'.repeat(40); inspection.evidence.revision.headSha = 'd'.repeat(40); inspection.fixture.observations[0]!.headSha = 'd'.repeat(40); }
    inspection.evidenceDigest = digest(canonicalJson(inspection.evidence)); inspection.fixture.observations[0]!.evidenceDigest = inspection.evidenceDigest;
    await store.observe(repo.id, inspection, now);
  };
  return { ...source, directory, run, repo, calls, queue, deliver, revise, get api() { return api; }, advance: (milliseconds: number) => { now += milliseconds; }, get store() { return store; }, get now() { return now; }, failure: (mode: typeof fail) => { fail = mode; },
    reopen: async () => { store.close(); store = await RuntimeStore.open(directory); now += 31_000; store.slack.recover(now); api = createApi(); },
    cleanup: async () => { store.close(); await source.cleanup(); } };
}
test('receipts survive restart and unchanged packets reuse one message without provider attempts', async () => {
  const s = await fixture();
  try {
    const first = await s.queue(); await s.deliver(); const receipt = s.store.slack.request(first.id).receipt; assert.ok(receipt);
    await s.reopen(); const repeated = await s.queue(); assert.equal(repeated.id, first.id); await s.deliver();
    assert.deepEqual(s.store.slack.request(first.id).receipt, receipt); assert.equal(s.calls.filter(call => call.method === 'chat.postMessage').length, 1);
    assert.equal(s.store.inspect(s.run.id).attempts.length, 0); assert.equal(s.store.inspect(s.run.id).reservations.length, 0);
  } finally { await s.cleanup(); }
});
test('changed evidence updates an open request and a new head supersedes its old message', async () => {
  const s = await fixture();
  try {
    const first = await s.queue(); await s.deliver(); const receipt = s.store.slack.request(first.id).receipt!;
    await s.revise(); const second = await s.queue({ reason: 'New review evidence on the same head.' }); await s.deliver();
    assert.equal(s.store.slack.request(first.id).status, 'superseded'); assert.deepEqual(s.store.slack.request(second.id).receipt, receipt);
    assert.equal(s.calls.filter(call => call.method === 'chat.postMessage').length, 1); assert.equal(s.calls.filter(call => call.method === 'chat.update').length, 1);
    await s.revise(true); s.store.slack.supersedeStale(s.now); await s.deliver();
    assert.match(String(s.calls.at(-1)?.body.text), /Superseded request/);
    await s.queue({ reason: 'Fresh review on the new commit.' }); await s.deliver();
    assert.equal(s.calls.filter(call => call.method === 'chat.postMessage').length, 2);
  } finally { await s.cleanup(); }
});
test('mapped DM conversation is persisted and reused across restart and later heads', async () => {
  const s = await fixture();
  try {
    await s.queue({ outcome: 'needs_author' }); await s.deliver(); assert.equal(s.store.slack.dm('TFOREST', 'UWILLOW'), 'DWILLOW');
    await s.reopen(); await s.revise(true); await s.queue({ outcome: 'needs_author' }); await s.deliver();
    assert.equal(s.calls.filter(call => call.method === 'conversations.open').length, 1);
    assert.ok(s.calls.filter(call => call.method === 'chat.postMessage').every(call => call.body.channel === 'DWILLOW'));
  } finally { await s.cleanup(); }
});
test('acceptance before a crash remains unknown and explicit receipt reconciliation does not send again', async () => {
  const s = await fixture();
  try {
    const request = await s.queue(); const planned = s.store.slack.deliveries()[0]!;
    assert.ok(s.store.slack.begin(planned.id, 'GENGINEERS', 'crash-owner', s.now));
    await s.reopen(); assert.equal(s.store.slack.delivery(planned.id).state, 'unknown'); await s.deliver(); assert.equal(s.calls.length, 0);
    const receipt: SlackReceipt = { workspaceId: 'TFOREST', channelId: 'GENGINEERS', timestamp: '123456.000001' };
    s.store.slack.reconcile(planned.id, { action: 'delivered', receipt }, s.now); await s.deliver();
    assert.deepEqual(s.store.slack.request(request.id).receipt, receipt); assert.equal(s.calls.length, 0);
    assert.equal(s.store.slack.delivery(planned.id).attempts[0]?.status, 'unknown');
  } finally { await s.cleanup(); }
});
test('unknown delivery blocks repeated sends until explicit bounded resend and retains history', async () => {
  const s = await fixture();
  try {
    await s.queue(); s.failure('lost'); await s.deliver(); const unknown = s.store.slack.deliveries()[0]!; assert.equal(unknown.state, 'unknown');
    await s.reopen(); await s.deliver(); assert.equal(s.calls.filter(call => call.method === 'chat.postMessage').length, 1);
    const next = s.store.slack.reconcile(unknown.id, { action: 'resend' }, s.now); assert.notEqual(next.id, unknown.id);
    s.failure(null); await s.deliver(); assert.equal(s.store.slack.delivery(next.id).state, 'confirmed');
    assert.equal(s.store.slack.delivery(unknown.id).state, 'rejected'); assert.equal(s.store.slack.delivery(unknown.id).attempts[0]?.status, 'unknown');
    assert.equal(s.store.inspect(s.run.id).attempts.length, 0);
  } finally { await s.cleanup(); }
});
test('missing membership and bounded rate retries retain the complete request in the inbox', async () => {
  const s = await fixture();
  try {
    await s.queue({ findings: ['A complete finding '.repeat(1000)] }); s.failure('access'); await s.deliver();
    const failed = s.store.slack.deliveries()[0]!; assert.equal(failed.state, 'rejected');
    const inbox = await s.store.slack.inbox(s.run.id) as { packet: DecisionPacket }[]; assert.ok(inbox[0]!.packet.findings[0]!.length > 4000);
    const retry = s.store.slack.reconcile(failed.id, { action: 'resend' }, s.now); s.failure('rate'); await s.deliver(16);
    assert.equal(s.store.slack.delivery(retry.id).state, 'rejected'); assert.equal(s.store.slack.delivery(retry.id).attempts.length, 3);
    assert.equal(s.store.inspect(s.run.id).attempts.length, 0);
  } finally { await s.cleanup(); }
});
test('no route, revoked permission and paused repository cannot dispatch a message', async () => {
  const s = await fixture();
  try {
    const request = await s.queue({}, { ...slackConfig, channels: {} }); await s.deliver();
    assert.equal(s.calls.length, 0); assert.equal(s.store.slack.deliveries()[0]!.state, 'rejected'); assert.ok((await s.store.slack.inbox()).length);
    await s.revise(); await s.queue(); s.store.pause(s.repo.id, true, s.now); await s.deliver(); assert.equal(s.calls.length, 0);
    s.store.pause(s.repo.id, false, s.now);
    const api = new SlackApi({ workspaceId: 'TFOREST', token: async () => 'fictional-token', rates: { read: () => 0, extend: () => {} }, transport: async () => { throw new Error('Must not dispatch'); } });
    await deliverSlack(s.store, api, () => s.now, new AbortController().signal, async () => false); assert.equal(s.calls.length, 0);
    assert.equal(s.store.slack.request(request.id).status, 'superseded');
  } finally { await s.cleanup(); }
});
test('prompt-only source migration reuses the request and receipt without another send', async () => {
  const s = await fixture({ source: true });
  try {
    const request = await s.queue(); await s.deliver();
    const receipt = s.store.slack.request(request.id).receipt, before = s.store.inspect(s.run.id);
    const files = Object.fromEntries(s.pkg.files.map(file => [file.path, file.text]));
    const prompt = s.pkg.files.find(file => file.path.endsWith('classify.md'))!;
    files[prompt.path] += '\nExplain uncertainty in plain language.\n';
    const next = buildPackage(s.pkg.workflowPath, files); assert.notEqual(next.digest, s.pkg.digest);
    const version = await s.store.activateSource(s.repo.id, '2'.repeat(40), 'main', next, s.now);
    await s.store.migrate(s.run.id, version.id, s.now); await s.reopen();
    const repeated = await s.queue(); assert.equal(repeated.id, request.id); await s.deliver();
    assert.deepEqual(s.store.slack.request(request.id).receipt, receipt);
    assert.equal(s.calls.filter(call => call.method === 'chat.postMessage').length, 1);
    assert.deepEqual(s.store.inspect(s.run.id).reservations, before.reservations);
    assert.equal(s.store.inspect(s.run.id).migrations.length, 1);
  } finally { await s.cleanup(); }
});
test('migration during a send rejects late completion and retains the unknown attempt for reconciliation', async () => {
  const s = await fixture({ source: true });
  try {
    await s.queue(); const delivery = s.store.slack.deliveries()[0]!;
    const oldLease = s.store.slack.begin(delivery.id, 'GENGINEERS', 'old-worker', s.now)!;
    const files = Object.fromEntries(s.pkg.files.map(file => [file.path, file.text]));
    const prompt = s.pkg.files.find(file => file.path.endsWith('classify.md'))!; files[prompt.path] += '\nCheck the captured head.\n';
    const version = await s.store.activateSource(s.repo.id, '2'.repeat(40), 'main', buildPackage(s.pkg.workflowPath, files), s.now);
    await s.store.migrate(s.run.id, version.id, s.now);
    const receipt = { workspaceId: 'TFOREST', channelId: 'GENGINEERS', timestamp: '123456.000001' };
    assert.equal(s.store.slack.finish(oldLease, { status: 'confirmed', value: receipt }, s.now), false);
    await s.deliver(); assert.equal(s.calls.length, 0);
    assert.equal(s.store.slack.delivery(delivery.id).state, 'unknown');
    assert.equal(s.store.slack.delivery(delivery.id).attempts[0]?.status, 'unknown');
    s.store.slack.reconcile(delivery.id, { action: 'delivered', receipt }, s.now);
    await s.deliver(); assert.equal(s.calls.length, 0);
  } finally { await s.cleanup(); }
});
test('configuration and permission errors reject one delivery and never start a provider attempt', async () => {
  const s = await fixture();
  try {
    await s.queue();
    await deliverSlack(s.store, s.api, () => s.now, new AbortController().signal, async () => { throw new Error('private profile diagnostic must not escape'); });
    const delivery = s.store.slack.deliveries()[0]!; assert.equal(delivery.state, 'rejected');
    assert.match(delivery.reason, /private configuration or packet/); assert.ok(!delivery.reason.includes('private profile diagnostic'));
    await s.deliver(); assert.equal(s.calls.length, 0); assert.equal(s.store.inspect(s.run.id).attempts.length, 0);
  } finally { await s.cleanup(); }
});
test('permission revoked while preparing a message rejects delivery before the message call', async () => {
  const s = await fixture();
  try {
    await s.queue(); let permissions = 0;
    await deliverSlack(s.store, s.api, () => s.now, new AbortController().signal, async () => ++permissions === 1);
    assert.equal(s.store.slack.deliveries()[0]!.state, 'rejected');
    assert.ok(s.calls.every(call => call.method === 'auth.test')); assert.equal(s.store.inspect(s.run.id).attempts.length, 0);
  } finally { await s.cleanup(); }
});
test('receipt persistence failure after acceptance becomes unknown and processing never repeats the send', async () => {
  const s = await fixture();
  try {
    await s.queue(); const db = new DatabaseSync(join(s.directory, 'runtime.sqlite'));
    db.exec("CREATE TRIGGER fail_slack_receipt BEFORE UPDATE ON slack_requests WHEN json_extract(NEW.data,'$.receipt') IS NOT NULL BEGIN SELECT RAISE(FAIL,'Fictional receipt write failure after acceptance'); END;"); db.close();
    await s.deliver(); const recovered = new DatabaseSync(join(s.directory, 'runtime.sqlite')); recovered.exec('DROP TRIGGER fail_slack_receipt'); recovered.close();
    const delivery = s.store.slack.deliveries()[0]!;
    assert.equal(delivery.state, 'unknown'); assert.equal(delivery.attempts.length, 1); assert.equal(delivery.attempts[0]!.status, 'unknown');
    assert.equal(s.calls.filter(call => call.method === 'chat.postMessage').length, 1);
    await s.reopen(); await s.deliver(); assert.equal(s.calls.filter(call => call.method === 'chat.postMessage').length, 1);
    s.store.slack.reconcile(delivery.id, { action: 'delivered', receipt: { workspaceId: 'TFOREST', channelId: 'GENGINEERS', timestamp: '2.000001' } }, s.now);
    await s.deliver(); assert.equal(s.calls.filter(call => call.method === 'chat.postMessage').length, 1);
    assert.equal(s.store.slack.delivery(delivery.id).state, 'confirmed'); assert.equal(s.store.inspect(s.run.id).attempts.length, 0);
  } finally { await s.cleanup(); }
});
test('daemon handles an unavailable Slack store with a visible retry delay and no unhandled rejection', async () => {
  const s = await fixture();
  const service = new DaemonService(s.store, { directory: s.directory, credentials: tokenCredentials('fictional-token'), profile: async () => s.profile, now: () => s.now,
    slack: { workspaceId: 'TFOREST', token: async () => 'fictional-token', transport: async () => { throw new Error('No Slack call should be attempted.'); } } });
  try {
    s.store.pause(s.repo.id, true, s.now);
    let failures = 0; const recover = s.store.slack.recover.bind(s.store.slack);
    s.store.slack.recover = () => { failures++; throw new Error('Fictional storage error.'); };
    await service.tick(); await service.idle();
    const status = service.status() as { slackFailure: { reason: string; retryAt: number } };
    assert.match(status.slackFailure.reason, /could not persist/); assert.equal(status.slackFailure.retryAt, s.now + s.store.limits.pollSeconds * 1000);
    await service.tick(); await service.idle(); assert.equal(failures, 1);
    s.store.slack.recover = recover; s.advance(s.store.limits.pollSeconds * 1000);
    await service.tick(); await service.idle(); assert.equal((service.status() as { slackFailure: unknown }).slackFailure, null);
    assert.equal(s.calls.length, 0); assert.equal(s.store.inspect(s.run.id).attempts.length, 0);
  } finally { await service.stop(); await s.cleanup(); }
});
for (const mode of ['daemon', 'apply']) test(`${mode} CLI inbox keeps complete content and reconciles unknown delivery`, async () => {
  const s = await fixture();
  const service = new DaemonService(s.store, { directory: s.directory, credentials: tokenCredentials('fictional-token'), profile: async () => s.profile, now: () => s.now });
  const control = await serveControl(s.directory, service);
  const cli = async (args: string[]) => promisify(execFile)(process.execPath, [resolve('apps/cli/dist/cli.js'), mode, ...args, '--state-dir', s.directory, '--json']);
  try {
    const completeFinding = 'A retained finding with full supporting context. '.repeat(1500);
    await s.queue({ findings: [completeFinding] }); const delivery = s.store.slack.deliveries()[0]!;
    s.store.slack.begin(delivery.id, 'GENGINEERS', 'lost-worker', s.now); s.advance(31_000); s.store.slack.recover(s.now);
    const inbox = JSON.parse((await cli(['inbox', s.run.id])).stdout);
    assert.equal(inbox.result[0].packet.findings[0], completeFinding);
    assert.ok(inbox.result[0].preview.message.text.length < completeFinding.length);
    assert.equal(inbox.result[0].deliveries[0].state, 'unknown');
    await assert.rejects(cli(['slack-reconcile', delivery.id, '--delivered', '--workspace', 'TFOREST', '--channel', 'CWRONG', '--timestamp', '123.000001']), error => (error as { code: number }).code === 8);
    assert.equal(s.store.slack.delivery(delivery.id).state, 'unknown');
    const reconciled = JSON.parse((await cli(['slack-reconcile', delivery.id, '--delivered', '--workspace', 'TFOREST', '--channel', 'GENGINEERS', '--timestamp', '123.000001'])).stdout);
    assert.equal(reconciled.result.state, 'confirmed');
    assert.equal(reconciled.result.attempts[0].state, 'unknown');
    assert.equal(s.store.inspect(s.run.id).effectAttempts[0]!.state, 'unknown');
    assert.equal(s.store.slack.request(delivery.requestId).receipt?.timestamp, '123.000001');
    await s.revise(); await s.queue({ reason: 'A new request with a lost result.' }); const next = s.store.slack.deliveries().find(item => item.state === 'planned')!;
    s.store.slack.begin(next.id, 'GENGINEERS', 'lost-again', s.now); s.advance(31_000); s.store.slack.recover(s.now);
    const resend = JSON.parse((await cli(['slack-reconcile', next.id, '--resend'])).stdout);
    assert.equal(resend.result.state, 'planned'); assert.notEqual(resend.result.id, next.id);
    assert.equal(s.store.slack.delivery(next.id).attempts[0]?.status, 'unknown');
    assert.equal(s.calls.length, 0); assert.equal(s.store.inspect(s.run.id).attempts.length, 0);
  } finally { await control.close(); await service.stop(); await s.cleanup(); }
});

test('a parked packet uses shared effect ownership without scheduling or reserving provider work', async () => {
  const s = await fixture();
  try {
    await s.queue(); const claim = s.store.claim(s.run.id, 'park-workflow', s.now, 30)!, current = s.store.run(s.run.id);
    s.store.park(claim, 'waiting', 'Waiting for a human.', null, current.control, null, s.now);
    const delivery = s.store.slack.deliveries()[0]!, lease = s.store.slack.begin(delivery.id, 'GENGINEERS', 'notification', s.now)!;
    assert.ok(lease); assert.equal(s.store.run(s.run.id).owner, null); assert.equal(s.store.run(s.run.id).dueAt, null); assert.equal(s.store.run(s.run.id).nextAction, null);
    assert.equal(s.store.effectAttempts(delivery.id).length, 1); assert.equal(s.store.effectCurrent(lease, s.now), true);
    s.store.recover(s.now + 100); assert.equal(s.store.slack.delivery(delivery.id).state, 'sending');
    assert.equal(s.store.claimForEffect(delivery.id, 'duplicate', s.now, 30), null);
    assert.equal(s.store.claim(s.run.id, 'provider', s.now, 30), null);
    assert.equal(s.store.inspect(s.run.id).attempts.length, 0); assert.equal(s.store.inspect(s.run.id).reservations.length, 0);
    s.advance(31_000); s.store.recover(s.now);
    assert.equal(s.store.slack.delivery(delivery.id).state, 'unknown'); assert.equal(s.store.effectAttempts(delivery.id)[0]!.state, 'unknown');
    assert.equal(s.store.claimForEffect(delivery.id, 'blind-retry', s.now, 30), null); await s.deliver(); assert.equal(s.calls.length, 0);
  } finally { await s.cleanup(); }
});

test('Slack effect claims share repository contention with provider claims and keep the parked continuation', async () => {
  const s = await fixture();
  try {
    await s.queue(); const other = structuredClone(s.inspection);
    other.evidence.pullRequest!.id = 'PR_43'; other.evidence.pullRequest!.number = 43; other.evidence.requested.pr = 43;
    other.evidenceDigest = digest(canonicalJson(other.evidence)); other.fixture.observations[0]!.evidenceDigest = other.evidenceDigest;
    const second = (await s.store.observe(s.repo.id, other, s.now))!, claim = s.store.claim(second.id, 'provider-owner', s.now, 30)!; assert.ok(claim);
    const delivery = s.store.slack.deliveries()[0]!;
    assert.equal(s.store.slack.begin(delivery.id, 'GENGINEERS', 'notification', s.now), null); assert.equal(s.store.effectAttempts(delivery.id).length, 0);
    s.store.park(claim, 'waiting', 'Provider work is idle.', null, second.control, null, s.now);
    const db = new DatabaseSync(join(s.directory, 'runtime.sqlite')); db.prepare("UPDATE runs SET data=json_set(data,'$.steps',7,'$.agents',2) WHERE id=?").run(s.run.id); db.close();
    const before = s.store.run(s.run.id), lease = s.store.slack.begin(delivery.id, 'GENGINEERS', 'notification', s.now)!; assert.ok(lease);
    assert.equal(s.store.run(s.run.id).steps, before.steps); assert.equal(s.store.run(s.run.id).agents, before.agents);
    assert.equal(s.store.run(s.run.id).status, before.status); assert.equal(s.store.run(s.run.id).nextAction, before.nextAction); assert.equal(s.store.run(s.run.id).dueAt, before.dueAt);
    assert.equal(s.store.claimForEffect(delivery.id, 'another-owner', s.now, 30), null);
    assert.equal(s.store.claim(second.id, 'provider-again', s.now, 30), null);
    assert.equal(s.store.inspect(s.run.id).reservations.length, 0);
  } finally { await s.cleanup(); }
});

for (const interrupt of ['pause', 'cancel', 'new-head'] as const) test(`${interrupt} prevents Slack dispatch or fences late completion without erasing history`, async () => {
  const s = await fixture();
  try {
    await s.queue(); const delivery = s.store.slack.deliveries()[0]!;
    s.store.pause(s.repo.id, true, s.now); assert.equal(s.store.slack.begin(delivery.id, 'GENGINEERS', 'paused', s.now), null);
    s.store.pause(s.repo.id, false, s.now);
    const lease = s.store.slack.begin(delivery.id, 'GENGINEERS', 'active-owner', s.now)!; assert.ok(lease);
    if (interrupt === 'pause') s.store.pause(s.repo.id, true, s.now);
    else if (interrupt === 'cancel') s.store.cancel(s.run.id);
    else await s.revise(true);
    assert.equal(s.store.slack.finish(lease, { status: 'confirmed', value: { workspaceId: 'TFOREST', channelId: 'GENGINEERS', timestamp: '123.000001' } }, s.now), false);
    assert.equal(s.store.slack.delivery(delivery.id).state, 'unknown'); assert.equal(s.store.effectAttempts(delivery.id)[0]!.state, 'unknown');
    s.store.slack.supersedeStale(s.now); await s.deliver(); assert.equal(s.calls.length, 0);
    assert.equal(s.store.inspect(s.run.id).attempts.length, 0);
  } finally { await s.cleanup(); }
});

for (const mode of ['plan', 'denied', 'allowed'] as const) test(`shared service ${mode} delivery honors private notify policy without starting workflow work`, async () => {
  const s = await fixture(), calls: string[] = [];
  const service = new DaemonService(s.store, { directory: s.directory, credentials: tokenCredentials('fictional-token'), profile: async () => s.profile, now: () => s.now, planOnly: mode === 'plan',
    applyPolicy: async () => ({ schemaVersion: 1, repository: s.repo.name, capabilities: mode === 'denied' ? [] : ['notify.send'], maxRepairsPerLifecycle: 1, maxPushAttempts: 1 }),
    slack: { workspaceId: 'TFOREST', token: async () => 'fictional-token', transport: async (url, options) => {
      const method = String(url).split('/').at(-1)!; calls.push(method);
      if (method === 'auth.test') return Response.json({ ok: true, team_id: 'TFOREST' });
      const body = JSON.parse(String(options?.body)); return Response.json({ ok: true, channel: body.channel, ts: '123.000001' });
    } } });
  try {
    await s.queue(); const current = s.store.run(s.run.id), claim = s.store.claim(s.run.id, 'park-workflow', s.now, 30)!;
    s.store.park(claim, 'waiting', 'The human decision is retained.', null, current.control, null, s.now);
    s.store.pollFinished(s.repo.id, s.now + 60_000, null);
    for (let count = 0; count < 4; count++) { await service.tick(); await service.idle(); s.advance(1500); }
    assert.equal(s.store.slack.deliveries()[0]!.state, mode === 'plan' ? 'planned' : mode === 'denied' ? 'rejected' : 'confirmed');
    assert.equal(calls.filter(method => method === 'chat.postMessage').length, mode === 'allowed' ? 1 : 0);
    if (mode !== 'allowed') assert.equal(calls.length, 0);
    assert.equal(s.store.inspect(s.run.id).attempts.length, 0); assert.equal(s.store.inspect(s.run.id).reservations.length, 0);
  } finally { await service.stop(); await s.cleanup(); }
});

test('temporary evidence loss preserves the current confirmed request across restart without another send', async () => {
  const s = await fixture();
  try {
    const first = await s.queue(); await s.deliver(); const before = s.store.inspect(s.run.id), receipt = s.store.slack.request(first.id).receipt;
    s.store.unavailable(s.run.id, 'Temporary evidence outage.', s.now); s.store.slack.supersedeStale(s.now); await s.deliver();
    assert.equal(s.store.slack.request(first.id).status, 'open'); await s.reopen();
    await s.store.observe(s.repo.id, s.inspection, s.now); const restored = await s.queue(); await s.deliver();
    assert.equal(restored.id, first.id); assert.equal(restored.activation, 0); assert.deepEqual(restored.receipt, receipt);
    assert.equal(s.store.slack.requests(s.run.id).filter(request => request.status === 'open').length, 1);
    assert.equal(s.calls.filter(call => call.method.startsWith('chat.')).length, 1);
    assert.deepEqual(s.store.inspect(s.run.id).reservations, before.reservations); assert.equal(s.store.inspect(s.run.id).attempts.length, 0);
  } finally { await s.cleanup(); }
});
for (const cleanup of ['pending', 'confirmed']) test(`returning to earlier evidence restores the same request after ${cleanup} cleanup and restart`, async () => {
  const s = await fixture();
  try {
    const first = await s.queue(); await s.deliver(); const receipt = s.store.slack.request(first.id).receipt!;
    for (let cycle = 1; cycle <= 2; cycle++) {
      await s.revise(true); s.store.slack.supersedeStale(s.now); assert.equal(s.store.slack.request(first.id).status, 'superseded');
      if (cleanup === 'confirmed') { await s.deliver(); assert.match(String(s.calls.at(-1)!.body.text), /Superseded request/); }
      await s.reopen(); await s.store.observe(s.repo.id, s.inspection, s.now); const current = await s.queue();
      assert.equal(current.id, first.id); assert.equal(current.status, 'open'); assert.equal(current.activation, cycle); assert.deepEqual(current.receipt, receipt);
      await s.deliver(); assert.ok(!String(s.calls.at(-1)!.body.text).includes('Superseded request')); assert.equal(s.calls.at(-1)!.body.ts, receipt.timestamp);
      assert.equal(s.store.slack.requests(s.run.id).filter(request => request.status === 'open').length, 1);
    }
    assert.equal(s.calls.filter(call => call.method === 'chat.postMessage').length, 1); assert.equal(s.store.inspect(s.run.id).reservations.length, 0); assert.equal(s.store.inspect(s.run.id).attempts.length, 0);
  } finally { await s.cleanup(); }
});
test('A to B to A reuses the same message and retains one current request through repeated activations', async () => {
  const s = await fixture();
  try {
    const a = await s.queue(); await s.deliver(); const receipt = s.store.slack.request(a.id).receipt!;
    await s.revise(); const bInspection = await s.store.artifacts.get<typeof s.inspection>(s.store.run(s.run.id).inspection), b = await s.queue({ reason: 'Decision B.' }); await s.deliver();
    for (const [inspection, input, id] of [[s.inspection, {}, a.id], [bInspection, { reason: 'Decision B.' }, b.id], [s.inspection, {}, a.id]] as const) {
      await s.store.observe(s.repo.id, inspection, s.now); const current = await s.queue(input); await s.deliver();
      assert.equal(current.id, id); assert.deepEqual(current.receipt, receipt); assert.equal(s.calls.at(-1)!.body.ts, receipt.timestamp); assert.ok(!String(s.calls.at(-1)!.body.text).includes('Superseded request'));
      assert.deepEqual(s.store.slack.requests(s.run.id).filter(request => request.status === 'open').map(request => request.id), [id]);
    }
    assert.equal(s.store.slack.requests(s.run.id).length, 2); assert.equal(s.calls.filter(call => call.method === 'chat.postMessage').length, 1); assert.equal(s.calls.filter(call => call.method === 'chat.update').length, 4);
    assert.equal(s.store.inspect(s.run.id).reservations.length, 0); assert.equal(s.store.inspect(s.run.id).attempts.length, 0);
  } finally { await s.cleanup(); }
});
for (const mode of ['sending', 'unknown']) test(`restoration cannot bypass a ${mode} superseding update`, async () => {
  const s = await fixture();
  try {
    const first = await s.queue(); await s.deliver(); const receipt = s.store.slack.request(first.id).receipt!;
    await s.revise(true); s.store.slack.supersedeStale(s.now); const cleanup = s.store.slack.deliveries().find(delivery => delivery.operation === 'supersede')!;
    const lease = mode === 'sending' ? s.store.slack.begin(cleanup.id, receipt.channelId, 'interrupted-cleanup', s.now)! : null;
    if (mode === 'unknown') { s.failure('lost'); await s.deliver(); }
    const messages = s.calls.filter(call => call.method.startsWith('chat.')).length;
    await s.store.observe(s.repo.id, s.inspection, s.now); await s.queue();
    if (lease) assert.equal(s.store.slack.finish(lease, { status: 'confirmed', value: receipt }, s.now), false);
    await s.reopen(); await s.deliver(); assert.equal(s.calls.filter(call => call.method.startsWith('chat.')).length, messages);
    assert.equal(s.store.slack.delivery(cleanup.id).state, 'unknown'); assert.equal(s.store.effectAttempts(cleanup.id)[0]!.state, 'unknown');
    s.store.slack.reconcile(cleanup.id, { action: 'delivered', receipt }, s.now); s.failure(null); await s.deliver();
    assert.equal(s.calls.filter(call => call.method.startsWith('chat.')).length, messages + 1); assert.equal(s.calls.filter(call => call.method === 'chat.postMessage').length, 1);
    assert.ok(!String(s.calls.at(-1)!.body.text).includes('Superseded request')); assert.equal(s.store.effectAttempts(cleanup.id)[0]!.state, 'unknown');
    assert.equal(s.store.inspect(s.run.id).reservations.length, 0); assert.equal(s.store.inspect(s.run.id).attempts.length, 0);
  } finally { await s.cleanup(); }
});
test('restored unknown post uses the explicitly reconciled receipt instead of creating a duplicate message', async () => {
  const s = await fixture();
  try {
    const request = await s.queue(); s.failure('lost'); await s.deliver(); const original = s.store.slack.deliveries()[0]!;
    await s.revise(true); s.store.slack.supersedeStale(s.now); await s.store.observe(s.repo.id, s.inspection, s.now); await s.queue(); await s.deliver();
    assert.equal(s.calls.filter(call => call.method === 'chat.postMessage').length, 1);
    s.store.slack.reconcile(original.id, { action: 'delivered', receipt: { workspaceId: 'TFOREST', channelId: 'GENGINEERS', timestamp: '123.000001' } }, s.now);
    s.failure(null); await s.deliver(); assert.equal(s.calls.filter(call => call.method === 'chat.postMessage').length, 1); assert.equal(s.calls.filter(call => call.method === 'chat.update').length, 1);
    assert.equal(s.store.slack.request(request.id).status, 'open'); assert.equal(s.store.effectAttempts(original.id)[0]!.state, 'unknown'); assert.equal(s.store.inspect(s.run.id).reservations.length, 0);
  } finally { await s.cleanup(); }
});

for (const cleanup of ['pending', 'confirmed']) test(`a new decision after a route return reuses the latest receipt after ${cleanup} cleanup and restart`, async () => {
  const s = await fixture();
  try {
    const a = await s.queue(); await s.deliver(); const receipt = s.store.slack.request(a.id).receipt!;
    await s.revise(); const b = await s.queue({ outcome: 'needs_team', reason: 'Decision B for the team.' }); await s.deliver();
    await s.store.observe(s.repo.id, s.inspection, s.now); const restored = await s.queue(); await s.deliver();
    assert.equal(restored.id, a.id); assert.deepEqual(restored.receipt, receipt);
    const teamCalls = s.calls.filter(call => call.body.channel === 'CPAPERBOAT').length;
    await s.revise(); s.store.slack.supersedeStale(s.now);
    if (cleanup === 'confirmed') await s.deliver();
    await s.reopen(); const c = await s.queue({ reason: 'Decision C in the private channel.' }); await s.deliver();
    assert.equal(c.activation, 3); assert.deepEqual(c.receipt, receipt);
    assert.deepEqual(s.store.slack.requests(s.run.id).filter(request => request.status === 'open').map(request => request.id), [c.id]);
    assert.equal(s.store.slack.request(b.id).status, 'superseded');
    assert.equal(s.calls.filter(call => call.method === 'chat.postMessage' && call.body.channel === 'GENGINEERS').length, 1);
    assert.equal(s.calls.filter(call => call.body.channel === 'CPAPERBOAT').length, teamCalls);
    assert.equal(s.calls.at(-1)!.method, 'chat.update'); assert.equal(s.calls.at(-1)!.body.ts, receipt.timestamp); assert.match(s.calls.at(-1)!.body.text, /Decision C in the private channel/);
    assert.equal(s.store.inspect(s.run.id).attempts.length, 0); assert.equal(s.store.inspect(s.run.id).reservations.length, 0);
  } finally { await s.cleanup(); }
});

test('several intent changes at one clock time retain queue order through restart', async () => {
  const s = await fixture();
  try {
    const a = await s.queue(); await s.deliver(); const receipt = s.store.slack.request(a.id).receipt!, at = s.now;
    await s.revise(); const b = await s.queue({ outcome: 'needs_team', reason: 'Decision B.' });
    await s.store.observe(s.repo.id, s.inspection, s.now); const restored = await s.queue();
    await s.revise(); s.store.slack.supersedeStale(s.now); const c = await s.queue({ reason: 'Decision C.' });
    assert.equal(s.now, at); assert.deepEqual([a.activation, b.activation, restored.activation, c.activation], [0, 1, 2, 3]);
    await s.reopen(); await s.deliver();
    assert.deepEqual(s.store.slack.request(c.id).receipt, receipt); assert.deepEqual(s.store.slack.requests(s.run.id).filter(request => request.status === 'open').map(request => request.id), [c.id]);
    assert.deepEqual(s.calls.filter(call => call.method.startsWith('chat.')).map(call => call.method), ['chat.postMessage', 'chat.update']);
    assert.equal(s.calls.at(-1)!.body.ts, receipt.timestamp); assert.match(s.calls.at(-1)!.body.text, /Decision C/);
    assert.equal(s.store.inspect(s.run.id).reservations.length, 0);
  } finally { await s.cleanup(); }
});

test('late cleanup reconciliation cannot replace the latest intent or authorize an unknown retry', async () => {
  const s = await fixture();
  try {
    const a = await s.queue(); await s.deliver(); const privateReceipt = s.store.slack.request(a.id).receipt!;
    await s.revise(); const b = await s.queue({ outcome: 'needs_team', reason: 'Decision B.' }); await s.deliver(); const teamReceipt = s.store.slack.request(b.id).receipt!;
    await s.store.observe(s.repo.id, s.inspection, s.now); await s.queue();
    const cleanup = s.store.slack.deliveries().find(delivery => delivery.requestId === b.id && delivery.operation === 'supersede')!;
    const lease = s.store.slack.begin(cleanup.id, teamReceipt.channelId, 'cleanup-worker', s.now)!; assert.ok(lease);
    assert.equal(s.store.slack.finish(lease, { status: 'unknown', reason: 'Slack accepted cleanup but the response was lost.' }, s.now), true);
    await s.revise(); s.store.slack.supersedeStale(s.now); const c = await s.queue({ reason: 'Decision C.' });
    const sent = s.calls.length; await s.reopen(); await s.deliver(); assert.equal(s.calls.length, sent);
    s.store.slack.reconcile(cleanup.id, { action: 'delivered', receipt: teamReceipt }, s.now);
    assert.equal(s.store.slack.request(b.id).activation, 1); assert.equal(s.store.slack.request(c.id).activation, 3);
    const d = await s.queue({ reason: 'Decision D after the older receipt was recorded.' }); await s.deliver();
    assert.equal(d.activation, 4); assert.deepEqual(d.receipt, privateReceipt);
    assert.deepEqual(s.store.slack.requests(s.run.id).filter(request => request.status === 'open').map(request => request.id), [d.id]);
    assert.equal(s.calls.filter(call => call.method === 'chat.postMessage').length, 2); assert.equal(s.calls.at(-1)!.method, 'chat.update'); assert.equal(s.calls.at(-1)!.body.ts, privateReceipt.timestamp);
    assert.match(s.calls.at(-1)!.body.text, /Decision D after the older receipt/);
    assert.equal(s.store.slack.delivery(cleanup.id).state, 'confirmed'); assert.equal(s.store.effectAttempts(cleanup.id)[0]!.state, 'unknown');
    assert.ok(s.store.slack.requests(s.run.id).every(request => request.resends === 0));
    assert.equal(s.store.inspect(s.run.id).attempts.length, 0); assert.equal(s.store.inspect(s.run.id).reservations.length, 0);
  } finally { await s.cleanup(); }
});

test('distinct complete packets with identical bounded previews keep their own delivery work', async () => {
  const s = await fixture();
  try {
    const prefix = 'A retained finding. '.repeat(30);
    const a = await s.queue({ findings: [prefix + 'First ending.'] });
    const b = await s.queue({ findings: [prefix + 'Second ending.'] });
    assert.notEqual(a.id, b.id); assert.notEqual(a.packet.digest, b.packet.digest); assert.equal(a.preview.digest, b.preview.digest);
    await s.deliver(); const receipt = s.store.slack.request(b.id).receipt!; assert.ok(receipt);
    const c = await s.queue({ findings: [prefix + 'Third ending.'] }); await s.deliver();
    assert.deepEqual(c.receipt, receipt); assert.equal(c.preview.digest, b.preview.digest);
    assert.equal((await s.queue({ findings: [prefix + 'Third ending.'] })).id, c.id); await s.reopen(); await s.deliver();
    const inbox = await s.store.slack.inbox(s.run.id) as { id: string; packet: DecisionPacket }[];
    assert.equal(inbox.find(request => request.id === c.id)!.packet.findings[0], prefix + 'Third ending.');
    assert.deepEqual(s.calls.filter(call => call.method.startsWith('chat.')).map(call => call.method), ['chat.postMessage', 'chat.update']);
    assert.equal(s.store.slack.deliveries().filter(delivery => delivery.state === 'confirmed').length, 2);
    assert.deepEqual(s.store.slack.requests(s.run.id).filter(request => request.status === 'open').map(request => request.id), [c.id]);
    assert.equal(s.store.inspect(s.run.id).reservations.length, 0);
  } finally { await s.cleanup(); }
});

test('requests without activation metadata retain their receipts and enter the ordered history on restoration', async () => {
  const s = await fixture();
  try {
    const a = await s.queue(); await s.deliver(); const receipt = s.store.slack.request(a.id).receipt!;
    await s.revise(); await s.queue({ outcome: 'needs_team', reason: 'Decision B.' }); await s.deliver();
    const db = new DatabaseSync(join(s.directory, 'runtime.sqlite'));
    db.exec("UPDATE slack_requests SET data=json_remove(data,'$.activation'); UPDATE slack_deliveries SET data=json_remove(data,'$.activation');"); db.close();
    await s.reopen(); await s.store.observe(s.repo.id, s.inspection, s.now); const restored = await s.queue(); await s.deliver();
    assert.equal(restored.activation, 1); assert.deepEqual(restored.receipt, receipt);
    await s.revise(); s.store.slack.supersedeStale(s.now); const c = await s.queue({ reason: 'Decision C.' }); await s.deliver();
    assert.equal(c.activation, 2); assert.deepEqual(c.receipt, receipt);
    assert.equal(s.calls.filter(call => call.method === 'chat.postMessage' && call.body.channel === receipt.channelId).length, 1);
    assert.equal(s.store.inspect(s.run.id).reservations.length, 0);
  } finally { await s.cleanup(); }
});

test('restoring an earlier request keeps its exhausted explicit-resend allowance', async () => {
  const s = await fixture();
  try {
    const a = await s.queue(); s.failure('access'); await s.deliver();
    let delivery = s.store.slack.deliveries()[0]!;
    for (let count = 0; count < 3; count++) {
      delivery = s.store.slack.reconcile(delivery.id, { action: 'resend' }, s.now); await s.deliver();
      assert.equal(s.store.slack.delivery(delivery.id).state, 'rejected');
    }
    await s.revise(); await s.queue({ outcome: 'needs_team', reason: 'Decision B.' });
    await s.store.observe(s.repo.id, s.inspection, s.now); const restored = await s.queue(); await s.deliver();
    assert.equal(restored.id, a.id); assert.equal(restored.activation, 2); assert.equal(restored.resends, 3);
    const latest = s.store.slack.deliveries().find(item => item.requestId === a.id && item.activation === restored.activation)!;
    assert.equal(latest.state, 'rejected'); assert.throws(() => s.store.slack.reconcile(latest.id, { action: 'resend' }, s.now), /three explicit resends/);
    await s.reopen(); await s.deliver(); assert.equal(s.calls.filter(call => call.method === 'chat.postMessage').length, 5);
    assert.equal(s.store.inspect(s.run.id).attempts.length, 0); assert.equal(s.store.inspect(s.run.id).reservations.length, 0);
  } finally { await s.cleanup(); }
});
