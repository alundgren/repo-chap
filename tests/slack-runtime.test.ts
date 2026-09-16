import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeStore } from '@repo-chap/runtime';
import { canonicalJson, digest } from '@repo-chap/workflow';
import { deliverSlack } from '@repo-chap/daemon';
import { SlackApi, type SlackReceipt } from '@repo-chap/slack/web-api';
import type { DecisionPacket, SlackConfiguration } from '@repo-chap/slack';
import { join } from 'node:path';
import { setup } from './helpers/provider-fixture.ts';
import { decisionPacket, slackConfig } from './helpers/slack-fixture.ts';

async function fixture() {
  const source = await setup(), directory = join(source.temporary, 'slack-state');
  let store = await RuntimeStore.open(directory), now = Date.now();
  const repo = await store.register({ id: 'R_paperboat', name: 'reef-labs/paperboat', package: source.pkg, profile: source.profile.name, reviewers: [] }, now);
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
  return { ...source, run, repo, calls, queue, deliver, revise, get store() { return store; }, get now() { return now; }, failure: (mode: typeof fail) => { fail = mode; },
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
