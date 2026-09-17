import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflow, validateWorkflow, parseFixture, replay } from '@repo-chap/workflow';
import { memberMappings, previewReplayHandoffs, previewPacket, previewRoute, previewHtml, validatePacket, type PacketOutcome } from '@repo-chap/slack';
import { SlackApi, type SlackRateStore } from '@repo-chap/slack/web-api';
import { decisionPacket, slackConfig } from './helpers/slack-fixture.ts';
import { build } from 'esbuild';

test('each outcome previews its channel or stable author DM offline with accessible decision evidence', () => {
  const destinations = ['dm', 'channel', 'channel', 'channel'];
  (['needs_author', 'needs_team', 'ready_for_human_merge', 'blocked_execution'] as PacketOutcome[]).forEach((outcome, index) => {
    const preview = previewPacket({ ...decisionPacket, outcome }, slackConfig);
    assert.equal(preview.route.destination?.kind, destinations[index]);
    for (const label of ['Decision', 'Findings', 'Attempted changes', 'Tests', 'Uncertainty', decisionPacket.headSha, 'Pull request: https://github.com/']) assert.ok(preview.message.text.includes(label));
    assert.ok(preview.message.text.length <= 4000);
    assert.equal(preview.message.mrkdwn, false); assert.equal(preview.message.parse, 'none');
    assert.ok(preview.message.blocks.every(block => block.text.verbatim));
  });
});
test('mapping normalizes case, accepts matching duplicates, rejects conflicts and makes fallback visible', () => {
  assert.equal(memberMappings({ Willow: 'UWILLOW', willow: 'UWILLOW' }).willow, 'UWILLOW');
  assert.throws(() => memberMappings({ Willow: 'UWILLOW', willow: 'UROWAN' }), /Conflicting/);
  assert.equal(previewRoute(slackConfig, 'needs_author', 'WILLOW').destination?.kind, 'dm');
  const fallback = previewPacket({ ...decisionPacket, outcome: 'needs_author', authorLogin: 'hazel' }, slackConfig);
  assert.equal(fallback.route.fallback, true); assert.match(fallback.message.text, /No Slack member mapping for hazel/);
  assert.deepEqual(fallback.route.destination, { kind: 'channel', channelId: 'CPAPERBOAT', name: 'team' });
  assert.equal(previewRoute({ ...slackConfig, channels: {} }, 'needs_author', null).destination, null);
  assert.match(previewPacket(decisionPacket).message.text, /CLI inbox/);
});
test('workflow rejects conflicting normalized mappings and non-author DM routes', async () => {
  const pkg = await loadWorkflow('docs/pr-workflows/examples/team-pr/workflow.json');
  const workflow = structuredClone(pkg.workflow); workflow.slack = structuredClone(slackConfig);
  workflow.slack.users = { Willow: 'UWILLOW', willow: 'UWILLOW' }; assert.doesNotThrow(() => validateWorkflow(workflow));
  workflow.slack.users.willow = 'UROWAN'; assert.throws(() => validateWorkflow(workflow), /Conflicting/);
  workflow.slack.users = {}; workflow.slack.routes.needs_team = 'author_dm'; assert.throws(() => validateWorkflow(workflow), /configured channel/);
});
test('source text cannot create Slack mentions, formatting, HTML or arbitrary links', () => {
  const preview = previewPacket({ ...decisionPacket, outcome: 'needs_team', reason: '<!channel> <@UINJECTED> & *urgent* `code` <script>alert(1)</script>' }, slackConfig);
  const blocks = JSON.stringify(preview.message.blocks);
  assert.ok(!blocks.includes('<@UINJECTED>')); assert.ok(!blocks.includes('<!channel>')); assert.ok(blocks.includes('&lt;@UINJECTED&gt;')); assert.ok(blocks.includes('<@UROWAN>'));
  assert.ok(!preview.message.text.includes('<@UINJECTED>'));
  const page = previewHtml(preview); assert.ok(!page.includes('<script>')); assert.ok(page.includes('&lt;script&gt;'));
  assert.throws(() => validatePacket({ ...decisionPacket, evidenceLinks: [{ label: 'Bad', url: 'javascript:alert(1)' }] }), /HTTPS GitHub URL/);
  assert.throws(() => validatePacket({ ...decisionPacket, evidenceLinks: [{ label: 'Bad', url: 'https://github.com.evil.test/a' }] }));
});
test('long and escaped content stays bounded with explicit omissions and a complete unchanged packet', () => {
  const packet = { ...decisionPacket, reason: '&<>😀'.repeat(5000), recommendedDecision: '<@UEXAMPLE>'.repeat(2000), findings: Array.from({ length: 100 }, () => '&'.repeat(3000)), attemptedFixes: Array.from({ length: 30 }, () => 'change'.repeat(1000)), uncertainty: ['unknown'.repeat(1000)], checks: Array.from({ length: 50 }, () => ({ name: 'required'.repeat(100), status: 'failed' as const, evidence: 'failure'.repeat(1000) })) };
  const original = JSON.stringify(packet), preview = previewPacket(packet, slackConfig);
  assert.equal(JSON.stringify(packet), original); assert.ok(preview.omissions.length > 0);
  assert.match(preview.message.text, /shortened or omitted/); assert.match(preview.message.text, /CLI inbox/);
  assert.ok(preview.message.text.length <= 4000, String(preview.message.text.length));
  assert.ok(preview.message.blocks.length <= 12);
  for (const block of preview.message.blocks) assert.ok(block.text.text.length <= 3000, String(block.text.text.length));
});
test('superseded rendering removes the old requested action and configured mentions', () => {
  const preview = previewPacket({ ...decisionPacket, outcome: 'needs_team' }, slackConfig, true);
  assert.match(preview.message.text, /Superseded request/); assert.match(preview.message.text, /Do not act/);
  assert.ok(!preview.message.text.includes(decisionPacket.recommendedDecision)); assert.ok(!JSON.stringify(preview.message).includes('<@UROWAN>'));
});
test('worst-case escaping, Unicode, links and configured mentions fit the complete message budget', () => {
  const repeated = '&<>😀*_~`'.repeat(500), ids = Array.from({ length: 10 }, (_, i) => `U${String(i).padStart(30, 'A')}`);
  for (const char of ['&', '<', '>', '😀', repeated]) {
    const value = char.repeat(Math.max(1, Math.floor(8000 / char.length)));
    const packet = { ...decisionPacket, repository: `${'a'.repeat(49)}/${'b'.repeat(50)}`, prNumber: Number.MAX_SAFE_INTEGER,
      reason: value, recommendedDecision: value, findings: Array(8).fill(value), attemptedFixes: Array(8).fill(value), uncertainty: Array(8).fill(value),
      checks: Array(8).fill({ name: value, status: 'failed', evidence: value }),
      evidenceLinks: Array.from({ length: 6 }, () => ({ label: value, url: `https://github.com/reef-labs/paperboat/pull/42#${'a'.repeat(200)}` })) };
    const preview = previewPacket(packet, { ...slackConfig, mentions: { ready_for_human_merge: ids } });
    assert.ok(preview.message.text.length <= 4000, `Fallback has ${preview.message.text.length} characters.`);
    assert.ok(preview.message.blocks.length <= 12);
    assert.ok(preview.message.blocks.every(block => block.text.text.length <= 3000));
    assert.match(preview.message.text, /complete request is in the CLI inbox/);
  }
});
test('the public renderer bundles for a browser without delivery or Node runtime dependencies', async () => {
  const bundle = await build({ stdin: { contents: 'export { previewPacket, previewRoute, previewHtml } from "@repo-chap/slack";', resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent' });
  assert.ok(Object.keys(bundle.metafile!.inputs).every(path => !path.includes('web-api') && !path.includes('node:')));
  assert.ok(!bundle.outputFiles[0]!.text.includes('slack.com/api/'));
});
test('CLI renders text, JSON and standalone HTML without credentials or network', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chap-preview-'));
  try {
    const path = join(directory, 'packet.json'); await writeFile(path, JSON.stringify(decisionPacket));
    for (const format of [[], ['--json'], ['--html']]) {
      const output = await promisify(execFile)(process.execPath, ['apps/cli/dist/cli.js', 'slack-preview', 'docs/pr-workflows/examples/team-pr/workflow.json', '--packet', path, ...format], { env: { PATH: process.env.PATH, GH_TOKEN: '', GITHUB_TOKEN: '', HTTPS_PROXY: 'http://127.0.0.1:1' } });
      assert.ok(output.stdout.includes(format[0] === '--json' ? 'blocks' : 'Local Slack preview'));
      if (format[0] === '--html') assert.ok(output.stdout.startsWith('<!doctype html>'));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function apiFixture(responses: (Response | Error | ((body: any) => Response))[]) {
  let now = 100_000; const deadlines = new Map<string, number>(); const calls: { method: string; body: any }[] = [];
  const rates: SlackRateStore = { read: key => deadlines.get(key) ?? 0, extend: (key, until) => { deadlines.set(key, Math.max(deadlines.get(key) ?? 0, until)); } };
  const api = new SlackApi({ workspaceId: 'TFOREST', token: async () => 'fictional-token', now: () => now, rates, transport: async (url, options) => {
    const body = JSON.parse(String(options?.body)); calls.push({ method: String(url).split('/').at(-1)!, body });
    assert.equal(options?.redirect, 'error'); assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer fictional-token');
    const response = responses.shift(); if (response instanceof Error) throw response;
    assert.ok(response); return typeof response === 'function' ? response(body) : response;
  } });
  return { api, calls, rates, advance: (milliseconds = 1200) => { now += milliseconds; } };
}
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
test('API verifies workspace, creates or resumes one author DM and sends public/private/update requests', async () => {
  const s = apiFixture([response({ ok: true, team_id: 'TFOREST' }), response({ ok: true, channel: { id: 'DWILLOW' } }), response({ ok: true, channel: { id: 'DWILLOW' } }), ...['CPAPERBOAT', 'GENGINEERS', 'DWILLOW'].map(channel => response({ ok: true, channel, ts: '123456.000001' })), response({ ok: true, channel: 'CPAPERBOAT', ts: '123456.000001' })]);
  assert.equal((await s.api.verify()).status, 'confirmed'); s.advance();
  assert.deepEqual(await s.api.openDm('UWILLOW'), { status: 'confirmed', value: 'DWILLOW' }); s.advance();
  assert.deepEqual(await s.api.openDm('UWILLOW'), { status: 'confirmed', value: 'DWILLOW' }); s.advance();
  for (const channel of ['CPAPERBOAT', 'GENGINEERS', 'DWILLOW']) { assert.equal((await s.api.send(channel, previewPacket(decisionPacket, slackConfig).message)).status, 'confirmed'); s.advance(); }
  assert.equal((await s.api.send('CPAPERBOAT', previewPacket(decisionPacket, slackConfig).message, '123456.000001')).status, 'confirmed');
  assert.equal(s.calls.at(-1)?.method, 'chat.update'); assert.equal(s.calls[1]?.body.users, 'UWILLOW');
});
test('API honors rate guidance, rejects missing membership and leaves lost acceptance unknown without retry', async () => {
  const s = apiFixture([response({ ok: true, team_id: 'TFOREST' }), new Response('', { status: 429, headers: { 'retry-after': '120' } }), response({ ok: false, error: 'not_in_channel' }), new Error('secret token and response must not be exposed')]);
  await s.api.verify(); s.advance(); const message = previewPacket(decisionPacket, slackConfig).message;
  const limited = await s.api.send('CPAPERBOAT', message); assert.equal(limited.status, 'deferred');
  s.advance(60_000); assert.equal((await s.api.send('CPAPERBOAT', message)).status, 'deferred'); assert.equal(s.calls.length, 2);
  s.advance(60_000); assert.match((await s.api.send('CPAPERBOAT', message) as { reason: string }).reason, /not_in_channel/); s.advance();
  const unknown = await s.api.send('CPAPERBOAT', message); assert.equal(unknown.status, 'unknown'); assert.equal(s.calls.length, 4); assert.ok(!JSON.stringify(unknown).includes('secret'));
});
test('wrong workspace, malformed acceptance and server failure never become confirmed receipts', async () => {
  const wrong = apiFixture([response({ ok: true, team_id: 'TOTHER' })]); assert.equal((await wrong.api.verify()).status, 'rejected');
  const s = apiFixture([response({ ok: true, team_id: 'TFOREST' }), response({ ok: true, channel: 'COTHER' }), new Response('', { status: 500 })]);
  await s.api.verify(); s.advance(); const message = previewPacket(decisionPacket, slackConfig).message;
  assert.equal((await s.api.send('CPAPERBOAT', message)).status, 'unknown'); s.advance(); assert.equal((await s.api.send('CPAPERBOAT', message)).status, 'unknown');
});
test('token rotation requires workspace verification and a send uses the token that was verified', async () => {
  let now = 100_000, token = 'fictional-original'; const calls: { method: string; token: string | null }[] = [];
  const api = new SlackApi({ workspaceId: 'TFOREST', token: async () => token, now: () => now, rates: { read: () => 0, extend: () => {} }, transport: async (url, options) => {
    const credential = new Headers(options?.headers).get('authorization'), method = String(url).split('/').at(-1)!;
    calls.push({ method, token: credential });
    return response(method === 'auth.test' ? { ok: true, team_id: credential === 'Bearer fictional-original' ? 'TFOREST' : 'TOTHER' } : { ok: true, channel: 'CPAPERBOAT', ts: '123456.000001' });
  } });
  assert.equal((await api.verify()).status, 'confirmed'); token = 'fictional-replacement'; now += 1500;
  assert.equal((await api.send('CPAPERBOAT', previewPacket(decisionPacket, slackConfig).message)).status, 'confirmed');
  assert.equal(calls.at(-1)?.token, 'Bearer fictional-original');
  assert.equal((await api.verify()).status, 'rejected');
  await assert.rejects(api.send('CPAPERBOAT', previewPacket(decisionPacket, slackConfig).message), /Verify the installation workspace/);
  assert.equal(calls.filter(call => call.method === 'chat.postMessage').length, 1);
});
test('invalid receipt types and incomplete rejection responses remain unknown', async () => {
  const s = apiFixture([response({ ok: true, team_id: 'TFOREST' }), response({ ok: true, channel: 'CPAPERBOAT', ts: 123456.000001 }), response({ error: 'not_in_channel' })]);
  await s.api.verify(); s.advance();
  assert.equal((await s.api.send('CPAPERBOAT', previewPacket(decisionPacket, slackConfig).message)).status, 'unknown'); s.advance();
  assert.equal((await s.api.send('CPAPERBOAT', previewPacket(decisionPacket, slackConfig).message)).status, 'unknown');
});

test('replay composes the same bounded renderer with matching fictional packet context in the built CLI', async () => {
  const pkg = await loadWorkflow('docs/pr-workflows/examples/team-pr/workflow.json');
  const fixture = parseFixture(JSON.parse(await readFile('fixtures/replay/handoff.json', 'utf8'))), result = replay(pkg, fixture);
  const packet = { ...decisionPacket, headSha: fixture.observations[0]!.headSha! };
  const previews = previewReplayHandoffs(result, [packet], pkg.workflow.slack);
  assert.equal(previews.length, 1); assert.deepEqual(previews[0]!.preview, previewPacket(packet, pkg.workflow.slack));
  assert.throws(() => previewReplayHandoffs(result, [{ ...packet, headSha: 'f'.repeat(40) }], pkg.workflow.slack), /exactly one packet/);
  assert.throws(() => previewReplayHandoffs(result, [{ ...packet, outcome: 'needs_author' }], pkg.workflow.slack), /exactly one packet/);
  assert.throws(() => previewReplayHandoffs(result, [packet, packet], pkg.workflow.slack), /exactly one packet/);
  const directory = await mkdtemp(join(tmpdir(), 'repo-chap-replay-packet-'));
  try {
    const file = join(directory, 'packet.json'); await writeFile(file, JSON.stringify(packet));
    const args = ['apps/cli/dist/cli.js', 'replay', 'docs/pr-workflows/examples/team-pr/workflow.json', '--fixture', 'fixtures/replay/handoff.json', '--packet', file];
    const { stdout } = await promisify(execFile)(process.execPath, [...args, '--json']);
    assert.deepEqual(JSON.parse(stdout).handoffs, previews);
    assert.match((await promisify(execFile)(process.execPath, args)).stdout, /Local Slack preview\. Simulation sent nothing\./);
    await writeFile(file, JSON.stringify({ ...packet, headSha: 'f'.repeat(40) }));
    await assert.rejects(promisify(execFile)(process.execPath, [...args, '--json']), error => (error as { code: number }).code === 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
