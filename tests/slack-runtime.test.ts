import assert from 'node:assert/strict';
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
    reopen: async () => { store.close(); store = await RuntimeStore.open(directory); store.slack.recover(now, true); api = createApi(); },
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
    s.store.slack.begin(delivery.id, 'GENGINEERS', 'old-worker', s.now);
    const files = Object.fromEntries(s.pkg.files.map(file => [file.path, file.text]));
    const prompt = s.pkg.files.find(file => file.path.endsWith('classify.md'))!; files[prompt.path] += '\nCheck the captured head.\n';
    const version = await s.store.activateSource(s.repo.id, '2'.repeat(40), 'main', buildPackage(s.pkg.workflowPath, files), s.now);
    await s.store.migrate(s.run.id, version.id, s.now);
    const receipt = { workspaceId: 'TFOREST', channelId: 'GENGINEERS', timestamp: '123456.000001' };
    assert.equal(s.store.slack.finish(delivery.id, 'old-worker', { status: 'confirmed', value: receipt }, s.now), false);
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
    await s.queue(); const finish = s.store.slack.finish.bind(s.store.slack);
    s.store.slack.finish = (id, owner, result, now) => {
      if (result.status === 'confirmed') throw new Error('Fictional receipt write failure after acceptance.');
      return finish(id, owner, result, now);
    };
    await s.deliver(); const delivery = s.store.slack.deliveries()[0]!;
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
test('CLI inbox keeps complete content and reconciles unknown delivery through the local control socket', async () => {
  const s = await fixture();
  const service = new DaemonService(s.store, { directory: s.directory, credentials: tokenCredentials('fictional-token'), profile: async () => s.profile, now: () => s.now });
  const control = await serveControl(s.directory, service);
  const cli = async (args: string[]) => promisify(execFile)(process.execPath, [resolve('apps/cli/dist/cli.js'), 'daemon', ...args, '--state-dir', s.directory, '--json']);
  try {
    const completeFinding = 'A retained finding with full supporting context. '.repeat(1500);
    await s.queue({ findings: [completeFinding] }); const delivery = s.store.slack.deliveries()[0]!;
    s.store.slack.begin(delivery.id, 'GENGINEERS', 'lost-worker', s.now); s.store.slack.recover(s.now, true);
    const inbox = JSON.parse((await cli(['inbox', s.run.id])).stdout);
    assert.equal(inbox.result[0].packet.findings[0], completeFinding);
    assert.ok(inbox.result[0].preview.message.text.length < completeFinding.length);
    assert.equal(inbox.result[0].deliveries[0].state, 'unknown');
    await assert.rejects(cli(['slack-reconcile', delivery.id, '--delivered', '--workspace', 'TFOREST', '--channel', 'CWRONG', '--timestamp', '123.000001']), error => (error as { code: number }).code === 8);
    assert.equal(s.store.slack.delivery(delivery.id).state, 'unknown');
    const reconciled = JSON.parse((await cli(['slack-reconcile', delivery.id, '--delivered', '--workspace', 'TFOREST', '--channel', 'GENGINEERS', '--timestamp', '123.000001'])).stdout);
    assert.equal(reconciled.result.state, 'confirmed');
    assert.equal(s.store.slack.request(delivery.requestId).receipt?.timestamp, '123.000001');
    await s.revise(); await s.queue({ reason: 'A new request with a lost result.' }); const next = s.store.slack.deliveries().find(item => item.state === 'planned')!;
    s.store.slack.begin(next.id, 'GENGINEERS', 'lost-again', s.now); s.store.slack.recover(s.now, true);
    const resend = JSON.parse((await cli(['slack-reconcile', next.id, '--resend'])).stdout);
    assert.equal(resend.result.state, 'planned'); assert.notEqual(resend.result.id, next.id);
    assert.equal(s.store.slack.delivery(next.id).attempts[0]?.status, 'unknown');
    assert.equal(s.calls.length, 0); assert.equal(s.store.inspect(s.run.id).attempts.length, 0);
  } finally { await control.close(); await service.stop(); await s.cleanup(); }
});
