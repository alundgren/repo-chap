import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildPackage } from '@repo-chap/workflow';
import { RuntimeStore, type ApplyPolicy } from '@repo-chap/runtime';
import { requestControl } from '@repo-chap/daemon';
import { repairFixture } from './helpers/repair-fixture.ts';
import { git } from './helpers/provider-fixture.ts';
import { slackConfig } from './helpers/slack-fixture.ts';

const cli = resolve('apps/cli/dist/cli.js'), preload = resolve('tests/helpers/slack-cli-preload.ts');
async function fixture(mode = 'access', direct = false) {
  const s = await repairFixture(), state = join(s.temporary, 'state'), remote = join(s.temporary, 'remote.git');
  await mkdir(remote); git(remote, 'init', '--bare', '-q'); git(s.repository, 'push', '-q', remote, `${s.head}:refs/heads/update`, `${s.base}:refs/heads/main`);
  const files = Object.fromEntries(s.pkg.files.map(file => [file.path, file.text])), workflow = JSON.parse(files[s.pkg.workflowPath]!);
  workflow.settings.newPrDelaySeconds = 0; workflow.settings.headDebounceSeconds = 0; workflow.slack = slackConfig; workflow.actions.resolve_threads.onSuccess = 'handoff';
  if (direct) { workflow.actions.push_candidate.onSuccess = 'handoff'; delete workflow.actions.resolve_threads; }
  if (mode === 'human_head') workflow.limits.maxRepairsPerLifecycle = 1;
  files[s.pkg.workflowPath] = JSON.stringify(workflow); const pkg = buildPackage(s.pkg.workflowPath, files); s.inspection.packageDigest = pkg.digest;
  const workflowRoot = join(s.temporary, 'workflow');
  for (const file of pkg.files) { const path = join(workflowRoot, file.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.text); }
  const policyPath = join(s.temporary, 'apply.json'), config = join(s.temporary, 'slack.json'), token = join(s.temporary, 'slack-token'), fixturePath = join(s.temporary, 'fixture.json'), requests = join(s.temporary, 'requests.jsonl');
  const policy: ApplyPolicy = { schemaVersion: 1, repository: 'reef-labs/paperboat', capabilities: ['workspace.write', 'checks.run', 'pr.push', 'review.resolve', 'notify.send'], maxRepairsPerLifecycle: 2, maxPushAttempts: 2, execution: s.policy };
  const slack = { enabled: true, workspaceId: 'TFOREST', tokenFile: token };
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 }); await writeFile(config, JSON.stringify({ schemaVersion: 1, slack }), { mode: 0o600 }); await writeFile(token, 'fictional-slack-token', { mode: 0o600 });
  await writeFile(fixturePath, JSON.stringify({ inspection: s.inspection, remote, policy: policyPath, requests, mode }), { mode: 0o600 });
  const env = { ...process.env, GH_TOKEN: 'fictional-local-token', GITHUB_TOKEN: '', REPO_CHAP_SLACK_FIXTURE: fixturePath };
  const args = ['apply', join(workflowRoot, pkg.workflowPath), '--repo-root', workflowRoot, '--repo', policy.repository, '--pr', '42', '--state-dir', state, '--policy', policyPath, '--provider-config', s.settings, '--profile', 'pilot', '--slack-config', config, '--json'];
  const run = (command = args) => { const child = spawnSync(process.execPath, ['--import', preload, cli, ...command], { env, encoding: 'utf8', timeout: 40_000 }); return { ...child, value: child.stdout?.startsWith('{') ? JSON.parse(child.stdout) : null }; };
  const calls = async (kind?: string) => { const text = await readFile(requests, 'utf8').catch(() => ''); const values = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); return kind ? values.filter(value => value.kind === kind) : values; };
  const providers = async () => (await readFile(s.log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]).filter(args => args.includes('exec') && !args.includes('--help')).length;
  const setMode = async (mode: string) => { const value = JSON.parse(await readFile(fixturePath, 'utf8')); value.mode = mode; await writeFile(fixturePath, JSON.stringify(value)); };
  const inbox = (id: string) => run(['apply', 'inbox', id, '--state-dir', state, '--json']).value.result;
  return { ...s, pkg, state, remote, policy, policyPath, config, slack, env, args, run, calls, providers, setMode, inbox };
}
function assertEvidence(packet: any, candidate: string, threads = true) {
  assert.ok(packet.attemptedFixes.some((value: string) => value.includes(`Candidate ${candidate}`)));
  assert.ok(packet.attemptedFixes.some((value: string) => /Conditional push: confirmed/.test(value)));
  assert.ok(packet.checks.some((check: any) => check.status === 'passed' && check.evidence.includes(candidate)));
  if (threads) assert.ok(packet.findings.some((value: string) => /Thread THREAD_value: addressed; resolution confirmed/.test(value)));
  assert.notEqual(packet.outcome, 'ready_for_human_merge', 'A repaired candidate alone does not establish accepted review and classification.');
}
test('built local apply repairs once, retains failed and unknown Slack delivery, and accepts an explicit receipt offline', async () => {
  const s = await fixture();
  try {
    const first = s.run(); assert.equal(first.status, 0, first.stderr || first.stdout);
    const id = first.value.run.id, candidate = git(s.remote, 'rev-parse', 'refs/heads/update'), request = s.inbox(id)[0], delivery = request.deliveries[0];
    assert.notEqual(candidate, s.head); assert.equal(request.packet.headSha, candidate); assertEvidence(request.packet, candidate); assert.equal(delivery.state, 'rejected'); assert.equal(await s.providers(), 1); assert.equal(first.value.reservations.length, 1);
    assert.equal((await s.calls('chat.postMessage')).length, 1);
    const reads = await s.calls('github'); assert.ok(reads.every(call => call.value.variables.number === undefined || call.value.variables.number === 42));
    const store = await RuntimeStore.open(s.state); assert.deepEqual(store.runs().map(run => run.number), [42]); store.close();
    const resend = s.run(['apply', 'slack-reconcile', delivery.id, '--resend', '--state-dir', s.state, '--json']); assert.equal(resend.status, 0, resend.stderr || resend.stdout);
    await s.setMode('lost'); await delay(1100); const unknown = s.run(); assert.equal(unknown.status, 8, unknown.stderr || unknown.stdout);
    const retained = s.inbox(id)[0].deliveries.find((value: any) => value.id === resend.value.result.id); assert.equal(retained.state, 'unknown', retained.reason);
    s.run(); assert.equal((await s.calls('chat.postMessage')).length, 2); assert.equal(await s.providers(), 1);
    await s.setMode('offline'); const receipt = s.run(['apply', 'slack-reconcile', retained.id, '--delivered', '--workspace', 'TFOREST', '--channel', 'CPAPERBOAT', '--timestamp', '123.000001', '--state-dir', s.state, '--json']);
    assert.equal(receipt.status, 0, receipt.stderr || receipt.stdout);
    const inspected = s.run(['apply', 'inspect', id, '--state-dir', s.state, '--json']);
    assert.equal(inspected.value.effects.find((effect: any) => effect.id === retained.id).state, 'confirmed');
    assert.equal(inspected.value.effectAttempts.find((attempt: any) => attempt.effectId === retained.id).state, 'unknown');
    assert.equal(inspected.value.reservations.length, 1); assert.equal(await s.providers(), 1); assert.equal((await s.calls('chat.postMessage')).length, 2);
  } finally { await s.cleanup(); }
});
test('built local --slack-config validation, plan and permission revocation retain one repair without a Slack send', async () => {
  const s = await fixture('revoke', true);
  try {
    await chmod(s.config, 0o644); const invalid = s.run(); assert.equal(invalid.status, 8); assert.match(invalid.stdout, /mode 0600/); assert.equal(await s.providers(), 0); assert.equal((await s.calls()).length, 0);
    await chmod(s.config, 0o600); const planned = s.run([...s.args, '--plan']); assert.equal(planned.status, 0, planned.stderr || planned.stdout); assert.equal(await s.providers(), 1); assert.equal((await s.calls('auth.test')).length, 0); assert.equal(git(s.remote, 'rev-parse', 'refs/heads/update'), s.head);
    const applied = s.run(); assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    const request = s.inbox(applied.value.run.id)[0]; assertEvidence(request.packet, git(s.remote, 'rev-parse', 'refs/heads/update'), false); assert.equal(request.packet.headSha, git(s.remote, 'rev-parse', 'refs/heads/update'));
    assert.equal(request.deliveries[0].state, 'rejected'); assert.match(request.deliveries[0].reason, /permission changed/i); assert.equal((await s.calls('chat.postMessage')).length, 0); assert.equal(await s.providers(), 1);
  } finally { await s.cleanup(); }
});
test('post-push packet refresh preserves a concurrent human head without restoring old repair authority', async () => {
  const s = await fixture('human_head', true);
  try {
    const result = s.run(); assert.equal(result.status, 8, result.stderr || result.stdout);
    const change = (await s.calls('human-ref'))[0].value;
    assert.equal(result.value.run.headSha, change.human); assert.equal(git(s.remote, 'rev-parse', 'refs/heads/update'), change.human);
    assert.equal(result.value.run.repair, null); assert.equal(result.value.run.control.memory.reviewCurrent, false);
    assert.equal(result.value.effects.find((effect: any) => effect.kind === 'github.push_candidate').receipt.candidateSha, change.candidate);
    assert.equal(s.inbox(result.value.run.id).length, 0); assert.equal((await s.calls('chat.postMessage')).length, 0); assert.equal(await s.providers(), 1); assert.equal(result.value.reservations.length, 1);
  } finally { await s.cleanup(); }
});
test('built App daemon recovers a Slack acceptance crash and explicitly resends without replacement repair', async () => {
  const s = await fixture('crash'), key = join(s.temporary, 'app.pem'), config = join(s.temporary, 'installation.json');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(key, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  await writeFile(config, JSON.stringify({ schemaVersion: 1, app: { appId: 'fictional-app', installationId: 42, privateKeyFile: key }, providerConfig: s.settings, applyPolicies: [s.policyPath], slack: s.slack }), { mode: 0o600 });
  let child: ReturnType<typeof spawn> | undefined, errors = '';
  const start = async () => {
    child = spawn(process.execPath, ['--import', preload, cli, 'daemon', 'start', '--state-dir', s.state, '--config', config, '--json'], { env: { ...s.env, REPO_CHAP_SLACK_DAEMON: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr!.on('data', value => errors += value);
    await new Promise<void>((resolve, reject) => { child!.stdout!.once('data', value => { try { assert.equal(JSON.parse(String(value)).status, 'started'); resolve(); } catch (error) { reject(error); } }); child!.once('exit', code => reject(new Error(`Daemon exited ${code}: ${errors}`))); });
  };
  const waitFor = async (predicate: () => Promise<boolean>) => { for (let i = 0; i < 150; i++) { if (await predicate()) return; await delay(100); } assert.fail(`Daemon did not reach the expected retained state: ${errors}`); };
  try {
    await start(); const registration = await requestControl(s.state, { method: 'register', name: s.policy.repository, package: s.pkg, profile: 'pilot', reviewers: [] }); assert.equal(registration.ok, true);
    await waitFor(async () => child!.signalCode === 'SIGKILL'); assert.equal((await s.calls('chat.postMessage')).length, 1); assert.equal(await s.providers(), 1);
    await s.setMode('valid'); await start();
    const status: any = (await requestControl(s.state, { method: 'status' })).result, id = status.runs[0].id;
    const request: any = ((await requestControl(s.state, { method: 'inbox', runId: id })).result as any[])[0]; assertEvidence(request.packet, git(s.remote, 'rev-parse', 'refs/heads/update'));
    assert.equal(request.deliveries[0].state, 'unknown'); await delay(1100); assert.equal((await s.calls('chat.postMessage')).length, 1);
    const retried: any = (await requestControl(s.state, { method: 'slack-reconcile', deliveryId: request.deliveries[0].id, resolution: { action: 'resend' } })).result;
    await waitFor(async () => ((await requestControl(s.state, { method: 'inspect', runId: id })).result as any).effects.find((effect: any) => effect.id === retried.id).state === 'confirmed');
    const inspected: any = (await requestControl(s.state, { method: 'inspect', runId: id })).result;
    assert.equal(inspected.effectAttempts.find((attempt: any) => attempt.effectId === request.deliveries[0].id).state, 'unknown'); assert.equal(inspected.reservations.length, 1); assert.equal(await s.providers(), 1); assert.equal((await s.calls('chat.postMessage')).length, 2);
    const app = await s.calls('app-token'); assert.ok(app.some(call => call.value.permissions.contents === 'write')); assert.ok(app.some(call => call.value.permissions.pull_requests === 'write'));
  } finally { if (child && child.exitCode === null && child.signalCode === null) { const closed = new Promise(done => child!.once('exit', done)); child.kill('SIGKILL'); await closed; } await s.cleanup(); }
});
