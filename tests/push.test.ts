import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync } from 'node:crypto';
import { canonicalJson, digest, buildPackage } from '@repo-chap/workflow';
import { conditionalPush, localPushTransport, githubPushTransport, reconcilePush, tokenCredentials, installationCredentials, installationPushCredentials, type PushRequest, type PushTarget, type PushTransport } from '@repo-chap/github';
import { captureRepairSource, runRepair, restoreCandidate, validateTestedCandidate } from '@repo-chap/execution';
import { RuntimeStore, type ApplyPolicy, type RepairAttemptJob } from '@repo-chap/runtime';
import { DaemonService, executeRepair, profileDigest, serveControl } from '@repo-chap/daemon';
import { repairFixture } from './helpers/repair-fixture.ts';
import { git } from './helpers/provider-fixture.ts';
import { remote, completed } from './helpers/daemon-remote.ts';

async function bare(s: Awaited<ReturnType<typeof repairFixture>>) {
  const path = join(s.temporary, 'remote.git'); await mkdir(path); git(path, 'init', '--bare', '-q');
  git(s.repository, 'push', '-q', path, `${s.head}:refs/heads/update`, `${s.base}:refs/heads/main`); return path;
}
async function prepared() {
  const s = await repairFixture(), remote = await bare(s), value = await runRepair(s.job(), s.options), checkout = join(s.temporary, 'restored');
  await restoreCandidate(s.output, value.reference, checkout);
  const candidate = value.result.candidate!, pr = s.inspection.evidence.pullRequest!;
  const request: PushRequest = { schemaVersion: 1, repositoryId: 'R_paperboat', repository: 'reef-labs/paperboat', pullRequestId: pr.id, number: 42,
    targetRef: 'refs/heads/update', expectedHeadSha: s.head, baseSha: s.base, candidateSha: candidate.sha, tree: candidate.tree, parents: candidate.parents };
  const target: PushTarget = { repositoryId: request.repositoryId, repository: request.repository, pullRequestId: pr.id, number: 42, headRepositoryId: request.repositoryId,
    headRepository: request.repository, headRef: request.targetRef, baseRef: 'refs/heads/main', defaultRef: 'refs/heads/main', headSha: s.head, baseSha: s.base, lifecycle: 'open', draft: false };
  return { ...s, remote, value, checkout, request, target, transport: localPushTransport(request.repository, checkout, remote) };
}
test('local Git pushes exactly the tested object and preserves a concurrent author update', async () => {
  const s = await prepared();
  try {
    validateTestedCandidate(s.value.result, s.policy);
    const accepted = await conditionalPush(s.request, { transport: s.transport, readTarget: async () => s.target, authorize: () => true });
    assert.equal(accepted.status, 'confirmed'); assert.equal(git(s.remote, 'rev-parse', s.request.targetRef), s.request.candidateSha);
    git(s.remote, 'update-ref', s.request.targetRef, s.head);
    const other = git(s.repository, '-c', 'user.name=River', '-c', 'user.email=river@example.invalid', 'commit-tree', `${s.head}^{tree}`, '-p', s.head, '-m', 'Concurrent author work');
    git(s.repository, 'push', '-q', s.remote, `${other}:refs/heads/author`);
    const raced = await conditionalPush(s.request, { transport: s.transport, readTarget: async () => s.target,
      authorize: () => { git(s.remote, 'update-ref', s.request.targetRef, other); return true; } });
    assert.equal(raced.status, 'unknown'); assert.equal(git(s.remote, 'rev-parse', s.request.targetRef), other);
    const receipt = await reconcilePush(s.request, s.transport); assert.equal(receipt.status, 'unknown'); assert.equal(receipt.observedSha, other); assert.equal(receipt.retryable, false);
  } finally { await s.cleanup(); }
});
test('conditional push rejects wrong targets, forks, lifecycle changes, rewrites and revoked authority without writes', async () => {
  const s = await prepared();
  try {
    for (const update of [{ draft: true }, { lifecycle: 'closed' as const }, { lifecycle: 'merged' as const }, { headRef: 'refs/heads/elsewhere' }, { baseRef: s.request.targetRef },
      { defaultRef: s.request.targetRef }, { headSha: 'a'.repeat(40) }, { baseSha: 'b'.repeat(40) }, { repositoryId: 'R_other' }, { pullRequestId: 'PR_other' }, { headRepositoryId: 'R_fork' }, { headRepository: null }]) {
      const result = await conditionalPush(s.request, { transport: s.transport, readTarget: async () => ({ ...s.target, ...update }), authorize: () => true });
      assert.equal(result.status, 'rejected', JSON.stringify(update)); assert.equal(git(s.remote, 'rev-parse', s.request.targetRef), s.head);
    }
    assert.equal((await conditionalPush(s.request, { transport: s.transport, readTarget: async () => s.target, authorize: () => false })).status, 'rejected');
    const rewrite = git(s.checkout, '-c', 'user.name=River', '-c', 'user.email=river@example.invalid', 'commit-tree', s.request.tree, '-p', s.base, '-m', 'Rewrite published history');
    assert.equal((await conditionalPush({ ...s.request, candidateSha: rewrite }, { transport: s.transport, readTarget: async () => s.target, authorize: () => true })).status, 'rejected');
    const forgedParents = { ...s.transport, candidate: async () => ({ tree: s.request.tree, parents: [s.head] }) };
    assert.equal((await conditionalPush({ ...s.request, candidateSha: rewrite }, { transport: forgedParents, readTarget: async () => s.target, authorize: () => true })).status, 'rejected');
    for (const targetRef of ['refs/heads/main', '', ':refs/heads/update', 'refs/heads/update:other']) assert.equal((await conditionalPush({ ...s.request, targetRef }, { transport: s.transport, readTarget: async () => s.target, authorize: () => true })).status, 'rejected');
    const bad = structuredClone(s.value.result); bad.checks[0]!.commandDigest = digest('another command'); assert.throws(() => validateTestedCandidate(bad, s.policy), /Required checks/);
    bad.checks[0] = { ...s.value.result.checks[0]!, status: 'failed', exitCode: 1 }; assert.throws(() => validateTestedCandidate(bad, s.policy));
    assert.equal(git(s.remote, 'rev-parse', s.request.targetRef), s.head);
  } finally { await s.cleanup(); }
});
test('ambiguous Git responses reconcile candidate, old, unexpected, missing and unreadable refs', async () => {
  const s = await prepared();
  try {
    assert.equal((await reconcilePush(s.request, s.transport)).retryable, true);
    const accepted = await conditionalPush(s.request, { transport: { ...s.transport, push: async (...args) => { await s.transport.push(...args); return 'unknown'; } }, readTarget: async () => s.target, authorize: () => true });
    assert.equal(accepted.status, 'unknown'); assert.equal((await reconcilePush(s.request, s.transport)).status, 'confirmed');
    git(s.remote, 'update-ref', '-d', s.request.targetRef); assert.equal((await reconcilePush(s.request, s.transport)).status, 'unknown');
    assert.equal((await reconcilePush(s.request, { ...s.transport, readRef: async () => { throw new Error('private transport detail'); } })).status, 'unknown');
  } finally { await s.cleanup(); }
});
test('credential retrieval finishes before the final target and authorization checks', async () => {
  const s = await prepared();
  try {
    let authorized = true; const events: string[] = [];
    const transport = githubPushTransport(s.request.repository, s.checkout, { repository: s.request.repository, permission: 'contents:write',
      token: async () => { events.push('credentials'); authorized = false; return 'fictional-never-sent'; }, redact: text => text });
    const receipt = await conditionalPush(s.request, { transport, readTarget: async () => { events.push('target'); return s.target; }, authorize: () => { events.push('policy'); return authorized; } });
    assert.equal(receipt.status, 'rejected'); assert.deepEqual(events, ['credentials', 'target', 'policy']);
    assert.equal(git(s.remote, 'rev-parse', s.request.targetRef), s.head);
  } finally { await s.cleanup(); }
});
test('temporary credential and final-read failures permit bounded retry of the same tested candidate', async () => {
  const s = await prepared();
  try {
    for (const unavailable of ['credentials', 'target']) {
      const receipt = await conditionalPush(s.request, {
        transport: unavailable === 'credentials' ? { ...s.transport, push: async () => { throw new Error('Temporary credential service failure'); } } : s.transport,
        readTarget: async () => { if (unavailable === 'target') throw new Error('Temporary GitHub read failure'); return s.target; }, authorize: () => true,
      });
      assert.equal(receipt.status, 'rejected'); assert.equal(receipt.retryable, true); assert.equal(git(s.remote, 'rev-parse', s.request.targetRef), s.head);
    }
    assert.equal((await conditionalPush(s.request, { transport: s.transport, readTarget: async () => s.target, authorize: () => true })).status, 'confirmed');
    assert.equal(git(s.remote, 'rev-parse', s.request.targetRef), s.request.candidateSha);
  } finally { await s.cleanup(); }
});

async function daemonFixture(mode = 'valid', maxRepairs = 2) {
  const s = await repairFixture('codex', mode), remotePath = await bare(s), directory = join(s.temporary, 'state');
  const files = Object.fromEntries(s.pkg.files.map(file => [file.path, file.text])), workflow = JSON.parse(files[s.pkg.workflowPath]!);
  workflow.settings.newPrDelaySeconds = 0; workflow.settings.headDebounceSeconds = 0; workflow.limits.maxRepairsPerLifecycle = maxRepairs;
  workflow.actions.push_candidate.onSuccess = '$observe'; delete workflow.actions.resolve_threads; files[s.pkg.workflowPath] = JSON.stringify(workflow); s.pkg = buildPackage(s.pkg.workflowPath, files);
  s.inspection.packageDigest = s.pkg.digest; s.profile.maxAttempts = 2;
  if (mode === 'increment') s.policy.requiredChecks[0]!.args = ['-e', 'const fs=require("node:fs");if(!/value = [3-9]/.test(fs.readFileSync("src/value.js","utf8")))process.exit(9)'];
  const policy: ApplyPolicy = { schemaVersion: 1, repository: 'reef-labs/paperboat', capabilities: ['workspace.write', 'checks.run', 'pr.push'], maxRepairsPerLifecycle: maxRepairs, maxPushAttempts: 2, execution: s.policy };
  let store = await RuntimeStore.open(directory), enabled = true, sends = 0, response: 'accepted' | 'unknown' | 'old' = 'accepted';
  const fake = remote(s.inspection), jobs: RepairAttemptJob[] = [];
  const dependencies = { directory, credentials: tokenCredentials('fictional-read-token'), profile: async () => s.profile, readOptions: { fetch: fake.fetch },
    applyPolicy: async () => enabled ? policy : null,
    repairSources: async (_repo: string, inspection: typeof s.inspection, signal: AbortSignal) => captureRepairSource(remotePath, inspection.evidence.pullRequest!.headSha, inspection.evidence.pullRequest!.baseSha, join(directory, 'repairs'), signal),
    repair: async (job: RepairAttemptJob, profile: typeof s.profile, signal: AbortSignal, isCurrent: () => boolean) => { jobs.push(job); return executeRepair(job, { artifacts: store.artifacts, profile, artifactDirectory: join(directory, 'repairs'), workerDirectory: join(directory, 'workers'), signal, isCurrent }); },
    pushTransport: async (repository: string, checkout: string, signal: AbortSignal): Promise<PushTransport> => {
      const transport = localPushTransport(repository, checkout, remotePath, signal);
      return { ...transport, push: async (...args) => { sends++; if (response === 'old') { await args[3](); return 'unknown'; } const outcome = await transport.push(...args); return response === 'unknown' ? 'unknown' : outcome; } };
    },
  };
  let service = new DaemonService(store, dependencies);
  const repo = await service.register({ name: policy.repository, package: s.pkg, profile: s.profile.name, reviewers: [] });
  const tick = async () => { await service.tick(); await service.idle(); };
  return { ...s, directory, remotePath, repo, policy, dependencies, fake, jobs, tick, get store() { return store; }, get service() { return service; }, get sends() { return sends; },
    revoke: () => { enabled = false; }, response: (value: typeof response) => { response = value; },
    restart: async () => { await service.stop(); store.close(); store = await RuntimeStore.open(directory); service = new DaemonService(store, dependencies); },
    cleanup: async () => { await service.stop(); store.close(); await s.cleanup(); },
  };
}
test('daemon reserves one provider invocation, retains tested repair/checks, displays plan, and pushes from durable artifacts', async () => {
  const s = await daemonFixture();
  try {
    await s.tick(); const run = s.store.runs()[0]!; assert.equal(s.jobs.length, 1); assert.ok(s.store.run(run.id).repair, s.store.run(run.id).reason);
    const job = s.jobs[0]!; assert.ok(!JSON.stringify(job).includes(s.temporary));
    const saved = await s.store.readRepair(s.store.run(run.id).repair!.result); assert.equal(saved.provider?.attempts.length, 1); assert.equal(saved.status, 'candidate');
    await rm(s.repository, { recursive: true }); await rm(join(s.directory, 'workers'), { recursive: true, force: true }); await s.restart();
    await s.tick(); assert.equal(s.store.run(run.id).repair!.checksCurrent, true);
    await s.tick(); const effect = s.store.effects(run.id)[0]!; assert.equal(effect.state, 'confirmed', JSON.stringify(effect));
    assert.equal(git(s.remotePath, 'rev-parse', 'refs/heads/update'), saved.candidate!.sha); assert.equal(s.sends, 1); assert.equal(s.jobs.length, 1);
    assert.equal(s.store.inspect(run.id).reservations.length, 1); assert.equal(s.store.effectAttempts(effect.id).length, 1);
    const server = await serveControl(s.directory, s.service);
    try {
      const child = spawn(process.execPath, [resolve('apps/cli/dist/cli.js'), 'daemon', 'inspect', run.id, '--state-dir', s.directory]);
      let output = ''; child.stdout.on('data', bytes => output += bytes); assert.equal(await new Promise(done => child.once('close', done)), 0);
      assert.match(output, /Candidate [a-f0-9]{40}; required checks validated/); assert.match(output, /Effect .*confirmed/);
    } finally { await server.close(); }
  } finally { await s.cleanup(); }
});
test('revoked policy retains a visible planned push and never calls its transport', async () => {
  const s = await daemonFixture();
  try {
    await s.tick(); await s.tick(); s.revoke(); await s.tick();
    const run = s.store.runs()[0]!; assert.equal(s.store.effects(run.id)[0]!.state, 'planned'); assert.equal(s.sends, 0); assert.equal(s.jobs.length, 1); assert.equal(run.status, 'blocked');
  } finally { await s.cleanup(); }
});
test('effect failure retries the same candidate within send bounds without another repair', async () => {
  const s = await daemonFixture();
  try {
    s.response('old'); await s.tick(); await s.tick(); await s.tick(); assert.equal(s.sends, 1);
    await s.restart(); await s.tick(); assert.equal(s.sends, 2); await s.tick();
    const run = s.store.runs()[0]!; assert.equal(run.status, 'blocked'); assert.match(run.reason, /effect attempt limit/); assert.equal(s.jobs.length, 1);
    assert.equal(s.store.effectAttempts(s.store.effects(run.id)[0]!.id).length, 2); assert.equal(s.store.inspect(run.id).reservations.length, 1);
  } finally { await s.cleanup(); }
});
test('daemon retries a temporary pre-send credential failure after restart without another provider reservation', async () => {
  const s = await daemonFixture();
  try {
    const original = s.dependencies.pushTransport; let unavailable = true;
    s.dependencies.pushTransport = async (...args) => { const transport = await original(...args); return { ...transport, push: async (...pushArgs) => {
      if (unavailable) throw new Error('Temporary credential service failure'); return transport.push(...pushArgs);
    } }; };
    await s.tick(); await s.tick(); await s.tick();
    const run = s.store.runs()[0]!, effect = s.store.effects(run.id)[0]!;
    assert.equal(effect.state, 'rejected'); assert.equal((effect.receipt as { retryable: boolean }).retryable, true);
    assert.equal(s.store.run(run.id).status, 'waiting'); assert.equal(s.sends, 0);
    unavailable = false; await s.restart(); s.store.retry(run.id, Date.now()); await s.tick();
    assert.equal(s.store.effects(run.id)[0]!.state, 'confirmed'); assert.equal(s.sends, 1); assert.equal(s.jobs.length, 1);
    assert.equal(s.store.inspect(run.id).reservations.length, 1); assert.equal(s.store.effectAttempts(effect.id).length, 2);
  } finally { await s.cleanup(); }
});

async function localCliFixture() {
  const s = await daemonFixture('valid', 1), workflowRoot = join(s.temporary, 'workflow'), state = join(s.temporary, 'local-state');
  for (const file of s.pkg.files) { const path = join(workflowRoot, file.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.text); }
  const policy = join(s.temporary, 'apply.json'), fixture = join(s.temporary, 'cli-fixture.json'), requests = join(s.temporary, 'requests.jsonl');
  await writeFile(policy, JSON.stringify(s.policy), { mode: 0o600 });
  const args = ['apply', join(workflowRoot, s.pkg.workflowPath), '--repo-root', workflowRoot, '--repo', s.policy.repository, '--pr', '42', '--state-dir', state,
    '--policy', policy, '--provider-config', s.settings, '--profile', 'pilot'];
  const mode = async (value?: string) => writeFile(fixture, JSON.stringify({ inspection: s.inspection, remote: s.remotePath, requests, mode: value }), { mode: 0o600 });
  await mode();
  const run = (command: string[], token = 'fictional-local-token') => {
    const child = spawnSync(process.execPath, ['--import', resolve('tests/helpers/apply-cli-preload.ts'), resolve('apps/cli/dist/cli.js'), ...command], {
      env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: '', REPO_CHAP_APPLY_FIXTURE: fixture }, encoding: 'utf8', timeout: 45_000,
    });
    return { ...child, value: child.stdout?.startsWith('{') ? JSON.parse(child.stdout) : null };
  };
  const calls = async () => (await readFile(s.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]).filter(argv => argv.includes('exec') && !argv.includes('--help')).length;
  return { ...s, state, policy, requests, args, mode, run, calls };
}
test('actual local apply command plans only the selected PR, inspects offline and recovers a crash without replacement repair', async () => {
  const s = await localCliFixture();
  try {
    const planned = s.run([...s.args, '--plan', '--json']); assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    const id = planned.value.run.id, candidate = planned.value.run.repair.candidateSha, effect = planned.value.effects[0];
    assert.equal(effect.state, 'planned'); assert.equal(planned.value.effectAttempts.length, 0); assert.equal(await s.calls(), 1);
    assert.equal(git(s.remotePath, 'rev-parse', 'refs/heads/update'), s.head);
    const requests = (await readFile(s.requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(requests.some(value => value.number === 42)); assert.ok(requests.every(value => value.number === undefined || value.number === 42));
    const state = await RuntimeStore.open(s.state); assert.deepEqual(state.runs().map(run => run.number), [42]); state.close();
    const printed = s.run([...s.args, '--plan']); assert.equal(printed.status, 0, printed.stderr || printed.stdout); assert.match(printed.stdout, /Planned github.push_candidate/);
    await s.mode('offline'); const offline = s.run(['apply', 'inspect', id, '--state-dir', s.state, '--json'], '');
    assert.equal(offline.status, 0, offline.stderr || offline.stdout); assert.equal(offline.value.effects[0].id, effect.id); assert.equal(await s.calls(), 1);
    await rm(s.repository, { recursive: true });
    await s.mode('crash'); const crashed = s.run([...s.args, '--json']); assert.equal(crashed.signal, 'SIGKILL', crashed.stderr || crashed.stdout);
    assert.equal(git(s.remotePath, 'rev-parse', 'refs/heads/update'), candidate); assert.equal(await s.calls(), 1);
    await s.mode(); const reconciled = s.run(['apply', 'reconcile', id, '--state-dir', s.state, '--json']); assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
    assert.equal(reconciled.value.effects[0].state, 'confirmed'); assert.equal(reconciled.value.effects[0].id, effect.id);
    assert.equal(reconciled.value.effectAttempts.length, 1); assert.equal(reconciled.value.reservations.length, 1); assert.equal(await s.calls(), 1);
    const limited = s.run([...s.args, '--json']); assert.equal(limited.status, 8, limited.stderr || limited.stdout);
    assert.match(limited.value.run.reason, /repair.*limit|Repair.*limit/); assert.equal(await s.calls(), 1);
    assert.equal(git(s.remotePath, 'rev-parse', 'refs/heads/update'), candidate);
  } finally { await s.cleanup(); }
});
test('actual local apply retry recovers a temporary final read with the saved candidate and retained send bounds', async () => {
  const s = await localCliFixture();
  try {
    await s.mode('read_failure'); const failed = s.run([...s.args, '--json']);
    assert.equal(failed.value.effects[0].state, 'rejected', failed.stderr || failed.stdout); assert.equal(failed.value.effects[0].receipt.retryable, true);
    const candidate = failed.value.run.repair.candidateSha; assert.equal(git(s.remotePath, 'rev-parse', 'refs/heads/update'), s.head); assert.equal(await s.calls(), 1);
    await s.mode(); const retried = s.run([...s.args, '--retry', '--json']);
    assert.equal(retried.value.effects[0].state, 'confirmed', retried.stderr || retried.stdout); assert.equal(retried.value.effectAttempts.length, 2);
    assert.equal(retried.value.effects[0].id, failed.value.effects[0].id); assert.equal(git(s.remotePath, 'rev-parse', 'refs/heads/update'), candidate);
    assert.equal(retried.value.reservations.length, 1); assert.equal(await s.calls(), 1);
  } finally { await s.cleanup(); }
});
test('local apply checks repair and push capabilities per action after accepting a publication-only policy', async () => {
  const denied = await localCliFixture();
  try {
    await writeFile(denied.policy, JSON.stringify({ schemaVersion: 1, repository: 'reef-labs/paperboat', capabilities: ['review.publish'], maxRepairsPerLifecycle: 1, maxPushAttempts: 1 }), { mode: 0o600 });
    const result = denied.run([...denied.args, '--json']);
    assert.equal(result.status, 8, result.stderr || result.stdout); assert.match(result.value.run.reason, /does not authorize/);
    assert.match(denied.pkg.workflow.actions[result.value.run.nextAction]!.uses, /agent\.(address_review|resolve_conflict)/);
    assert.equal(result.value.attempts.length, 0); assert.equal(result.value.effects.length, 0);
    assert.equal(git(denied.remotePath, 'rev-parse', 'refs/heads/update'), denied.head);
  } finally { await denied.cleanup(); }
  const push = await localCliFixture();
  try {
    const planned = push.run([...push.args, '--plan', '--json']); assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    const policy = JSON.parse(await readFile(push.policy, 'utf8')); policy.capabilities = policy.capabilities.filter((value: string) => value !== 'pr.push');
    await writeFile(push.policy, JSON.stringify(policy), { mode: 0o600 });
    const result = push.run([...push.args, '--json']);
    assert.equal(result.status, 8, result.stderr || result.stdout); assert.match(result.value.run.reason, /does not authorize/); assert.equal(result.value.run.nextAction, 'push_candidate');
    assert.equal(result.value.effects[0].state, 'planned'); assert.equal(result.value.effectAttempts.length, 0); assert.equal(await push.calls(), 1);
    assert.equal(git(push.remotePath, 'rev-parse', 'refs/heads/update'), push.head);
  } finally { await push.cleanup(); }
});
test('SIGKILL after Git acceptance before receipt persistence confirms the one existing commit on restart', async () => {
  const s = await daemonFixture();
  try {
    await s.tick(); await s.tick(); await s.service.stop();
    const run = s.store.runs()[0]!, candidate = run.repair!.candidateSha!;
    const input = join(s.temporary, 'push-crash.json');
    await writeFile(input, JSON.stringify({ directory: s.directory, remote: s.remotePath, runId: run.id, pkg: s.pkg, profile: s.profile, policy: s.policy, inspection: s.inspection }), { mode: 0o600 });
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import {readFile} from 'node:fs/promises';
      import {RuntimeStore} from '@repo-chap/runtime';
      import {GitHubReader,tokenCredentials,localPushTransport} from '@repo-chap/github';
      import {dispatchCandidatePush} from './apps/daemon/dist/push.js';
      import {remote} from './tests/helpers/daemon-remote.ts';
      const p=JSON.parse(await readFile(process.argv[1],'utf8')),store=await RuntimeStore.open(p.directory),fake=remote(p.inspection),credentials=tokenCredentials('fictional');
      const claim=store.claim(p.runId,'crashing-push',Date.now(),300);
      const dependencies={directory:p.directory,credentials,profile:async()=>p.profile,applyPolicy:async()=>p.policy,
        pushTransport:async(repo,checkout,signal)=>{const t=localPushTransport(repo,checkout,p.remote,signal);return {...t,push:async(...args)=>{
          const outcome=await t.push(...args);if(outcome!=='accepted')throw new Error('Fixture push failed');
          process.stdout.write('accepted\\n',()=>process.kill(process.pid,'SIGKILL'));await new Promise(()=>{});
        }}}};
      await dispatchCandidatePush(store,claim,'push_candidate',p.pkg,dependencies,()=>new GitHubReader(credentials,{fetch:fake.fetch}),Date.now,new AbortController().signal);
    `, input], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', diagnostics = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => diagnostics += bytes);
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(done => child.once('close', (code, signal) => done([code, signal])));
    assert.equal(signal, 'SIGKILL', `${code}: ${diagnostics}`); assert.match(output, /accepted/);
    assert.equal(git(s.remotePath, 'rev-parse', 'refs/heads/update'), candidate); assert.equal(s.store.effects(run.id)[0]!.state, 'sending');
    await s.restart(); await s.tick();
    const effect = s.store.effects(run.id)[0]!; assert.equal(effect.state, 'confirmed'); assert.equal(s.store.effectAttempts(effect.id).length, 1);
    assert.equal(s.jobs.length, 1); assert.equal(s.sends, 0); assert.equal(s.store.inspect(run.id).reservations.length, 1);
    assert.equal(git(s.remotePath, 'rev-parse', 'refs/heads/update'), candidate);
  } finally { await s.cleanup(); }
});
test('automatic repairs stop at the total limit across confirmed bot heads and restart', async () => {
  const s = await daemonFixture('increment');
  try {
    for (let index = 0; index < 2; index++) {
      await s.tick(); await s.tick(); await s.tick(); assert.equal(s.sends, index + 1, s.store.runs()[0]!.reason);
      const head = git(s.remotePath, 'rev-parse', 'refs/heads/update');
      s.inspection.evidence.pullRequest!.headSha = head; s.inspection.evidence.revision.headSha = head;
      s.inspection.evidence.threads.items[0]!.comments.items[0]!.headSha = head;
      s.store.pollFinished(s.repo.id, 0, null); await s.restart();
    }
    await s.tick(); const run = s.store.runs()[0]!;
    assert.equal(s.jobs.length, 2); assert.equal(s.sends, 2); assert.equal(s.store.inspect(run.id).reservations.length, 2);
    assert.match(run.reason, /repair.*limit|Repair.*limit/); assert.equal(run.status, 'blocked');
  } finally { await s.cleanup(); }
});
test('failed required checks never create a push request', async () => {
  const s = await daemonFixture();
  try {
    s.policy.execution!.requiredChecks[0]!.args = ['-e', 'process.exit(1)']; await s.tick(); await s.tick();
    const run = s.store.runs()[0]!; const result = await s.store.readRepair(run.repair!.result);
    assert.equal(result.status, 'checks_failed'); assert.equal(s.sends, 0); assert.deepEqual(s.store.effects(run.id).filter(effect => effect.kind === 'github.push_candidate'), []);
    assert.equal((await s.store.slack.inbox(run.id)).length, 1);
  } finally { await s.cleanup(); }
});
test('temporary inspection failure resumes the same validated candidate when identical evidence returns', async () => {
  const s = await daemonFixture();
  try {
    await s.tick(); await s.tick(); const before = s.store.runs()[0]!.repair!.result.digest;
    s.fake.access(false); s.store.pollFinished(s.repo.id, 0, null); await s.tick();
    assert.equal(s.store.runs()[0]!.evidenceAvailable, false); assert.equal(s.sends, 0);
    s.fake.access(true); s.store.pollFinished(s.repo.id, 0, null); await s.restart(); await s.tick();
    const run = s.store.runs()[0]!; assert.equal(run.repair!.result.digest, before); assert.equal(s.jobs.length, 1);
    assert.equal(s.store.effects(run.id)[0]!.state, 'confirmed', run.reason); assert.equal(s.sends, 1);
  } finally { await s.cleanup(); }
});
test('effect lease survives provider release and expires or is fenced by migration and new heads', async () => {
  const s = await daemonFixture();
  try {
    await s.tick(); const run = s.store.runs()[0]!, now = Date.now(), claim = s.store.claim(run.id, 'delivery', now, 1)!;
    const id = s.store.planEffect(claim, { kind: 'fixture', destination: 'fictional-team', expectedRevision: s.head, evidenceKey: claim.evidenceKey, payload: await s.store.artifacts.put({ message: 'Review needed.' }) }, now);
    const lease = s.store.beginEffect(claim, id, 2, now, 120);
    s.store.park(claim, 'waiting', 'Delivery active.', now + 1000, run.control, run.nextAction, now);
    s.store.recover(now + 2000); assert.equal(s.store.effects(run.id)[0]!.state, 'sending'); assert.equal(s.store.effectCurrent(lease, now + 2000), true);
    assert.equal(s.store.claim(run.id, 'concurrent-worker', now + 2000, 10), null);
    await s.store.migrate(run.id, run.workflowVersionId, now + 2001); assert.equal(s.store.effects(run.id)[0]!.state, 'unknown'); assert.equal(s.store.effectCurrent(lease, now + 2002), false);
    assert.equal(s.store.finishEffect(lease, 'confirmed', { remoteId: 'stale' }, now + 2002), false);
    s.store.reconcileEffect(id, 'confirmed', { remoteId: 'observed-fixture' }, now + 2002);
    const next = s.store.claim(run.id, 'next-delivery', now + 2003, 1)!;
    const second = s.store.planEffect(next, { kind: 'fixture', destination: 'fictional-next', expectedRevision: s.head, evidenceKey: next.evidenceKey, payload: await s.store.artifacts.put({ message: 'Another decision.' }) }, now + 2003);
    const expired = s.store.beginEffect(next, second, 2, now + 2003, 1);
    s.store.park(next, 'waiting', 'Delivery active.', now + 2004, s.store.run(run.id).control, run.nextAction, now + 2003);
    s.store.recover(now + 4000); assert.equal(s.store.effectCurrent(expired, now + 4000), false); assert.equal(s.store.effects(run.id).find(e => e.id === second)!.state, 'unknown');
    s.store.reconcileEffect(second, 'rejected', { retryable: false }, now + 4000);
    const final = s.store.claim(run.id, 'head-delivery', now + 4001, 10)!;
    const third = s.store.planEffect(final, { kind: 'fixture', destination: 'fictional-third', expectedRevision: s.head, evidenceKey: final.evidenceKey, payload: await s.store.artifacts.put({ message: 'Head-bound decision.' }) }, now + 4001);
    const fenced = s.store.beginEffect(final, third, 2, now + 4001);
    const changed = structuredClone(s.inspection); changed.evidence.pullRequest!.headSha = 'c'.repeat(40); changed.evidence.revision.headSha = 'c'.repeat(40);
    changed.evidenceDigest = digest(canonicalJson(changed.evidence)); changed.fixture.observations[0]!.headSha = 'c'.repeat(40); changed.fixture.observations[0]!.evidenceDigest = changed.evidenceDigest;
    await s.store.observe(s.repo.id, changed, now + 4002);
    assert.equal(s.store.effects(run.id).find(e => e.id === third)!.state, 'unknown'); assert.equal(s.store.effectCurrent(fenced, now + 4003), false);
  } finally { await s.cleanup(); }
});
test('write credentials request explicit repository-scoped contents write while inspection remains read-only', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const requests: any[] = [], fetch: typeof globalThis.fetch = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return Response.json({ token: 'fictional-token', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { contents: 'write' } }); };
  const options = { appId: 'fixture', installationId: 7, privateKey, fetch };
  await installationCredentials(options).token(); await installationPushCredentials(options, 'reef-labs/paperboat').token();
  assert.equal(requests[0].permissions.contents, 'read'); assert.equal(requests[1].permissions.contents, 'write'); assert.deepEqual(requests[1].repositories, ['paperboat']);
});
for (const version of ['1', '2']) test(`schema ${version} analysis data upgrades with charges, pinned jobs and uncertain/confirmed receipts retained`, async () => {
  const s = await repairFixture(), directory = join(s.temporary, 'upgrade'); let store = await RuntimeStore.open(directory);
  try {
    const now = Date.now(), repo = await store.register({ id: 'R_paperboat', name: 'reef-labs/paperboat', package: s.pkg, profile: s.profile.name, reviewers: [] }, now);
    const run = (await store.observe(repo.id, s.inspection, now))!, claim = store.claim(run.id, 'analysis', now, 300)!;
    const job = store.reserve(claim, { actionId: 'classify', package: s.pkg, sources: await store.artifacts.put({ fixture: 'source' }), profile: s.profile.name, profileDigest: profileDigest(s.profile) }, now);
    await store.complete(claim, completed(job), now + 1);
    const effectOwner = store.claim(run.id, 'legacy-effects', now + 2, 300)!, ids: string[] = [];
    for (const state of ['confirmed', 'sending', 'unknown'] as const) {
      const id = store.planEffect(effectOwner, { kind: 'fixture', destination: 'fictional-team', evidenceKey: effectOwner.evidenceKey, expectedRevision: s.head, payload: await store.artifacts.put({ state }) }, now + 2); ids.push(id);
      store.transitionEffect(effectOwner, id, 'planned', 'sending', null, now + 2);
      if (state !== 'sending') store.transitionEffect(effectOwner, id, 'sending', state, { remoteId: `fictional-${state}` }, now + 3);
    }
    const before = store.inspect(run.id); store.close();
    const db = new DatabaseSync(join(directory, 'runtime.sqlite'));
    db.exec(`UPDATE metadata SET value='${version}' WHERE key='schema'; DROP TABLE effect_leases; DROP TABLE effect_attempts;`);
    if (version === '1') db.exec("UPDATE repositories SET data=json_remove(data,'$.source','$.activeVersionId'); UPDATE runs SET data=json_remove(data,'$.workflowVersionId','$.waitTiming'); DROP TABLE workflow_versions; DROP TABLE migrations;");
    db.close(); store = await RuntimeStore.open(directory);
    const after = store.inspect(run.id); assert.deepEqual(after.attempts, before.attempts); assert.deepEqual(after.reservations, before.reservations); assert.deepEqual(after.notes, before.notes);
    for (const [index, id] of ids.entries()) { const effect = after.effects.find(value => value.id === id)!; assert.equal(effect.state, index === 0 ? 'confirmed' : 'unknown'); assert.deepEqual(effect.receipt, before.effects.find(value => value.id === id)!.receipt); }
    assert.equal(after.run.notesRevision, before.run.notesRevision); assert.equal(after.run.token, before.run.token); assert.equal(after.run.packageDigest, before.run.packageDigest);
  } finally { store.close(); await s.cleanup(); }
});
test('invalid repair output consumes one reserved provider call even with a two-attempt profile', async () => {
  const s = await daemonFixture('invalid_payload');
  try {
    await s.tick(); const run = s.store.runs()[0]!, result = await s.store.readRepair(run.repair!.result);
    assert.equal(result.status, 'invalid_output'); assert.equal(result.provider!.attempts.length, 1); assert.equal(s.store.inspect(run.id).reservations.length, 1);
    await s.tick(); await s.restart(); await s.tick(); assert.equal(s.jobs.length, 1); assert.equal(s.sends, 0);
  } finally { await s.cleanup(); }
});
test('durable repair source runs after source loss and stale completion cannot replace a newer observation', async () => {
  const s = await daemonFixture();
  try {
    await s.service.stop(); const now = Date.now(), run = (await s.store.observe(s.repo.id, s.inspection, now))!;
    const source = await captureRepairSource(s.repository, s.head, s.base, join(s.directory, 'repairs'));
    const claim = s.store.claim(run.id, 'source-worker', now, 300)!, job = s.store.reserveRepair(claim, { actionId: 'address', sources: source, package: s.pkg, profile: s.profile.name, profileDigest: profileDigest(s.profile), applyPolicy: s.policy }, now);
    await rm(s.repository, { recursive: true }); await rm(s.remotePath, { recursive: true });
    const result = await executeRepair(JSON.parse(JSON.stringify(job)), { artifacts: s.store.artifacts, profile: s.profile, artifactDirectory: join(s.directory, 'repairs'), workerDirectory: join(s.directory, 'workers'), isCurrent: () => s.store.isCurrent(claim, Date.now()) });
    assert.equal(result.repair.status, 'candidate');
    const changed = structuredClone(s.inspection); changed.evidence.pullRequest!.draft = true; changed.evidenceDigest = digest(canonicalJson(changed.evidence));
    changed.fixture.observations[0]!.evidenceDigest = changed.evidenceDigest; changed.fixture.observations[0]!.facts.draft = true;
    await s.store.observe(s.repo.id, changed, Date.now()); assert.equal(await s.store.completeRepair(claim, result, Date.now()), false);
    assert.equal(s.store.run(run.id).repair, null); assert.equal(s.store.inspect(run.id).reservations.length, 1);
  } finally { await s.cleanup(); }
});
test('an empty-content conflict merge pushes its exact tested two-parent commit', async () => {
  const s = await repairFixture('claude', 'keep_head', true);
  try {
    s.policy.requiredChecks[0]!.args = ['-e', 'if(require("node:fs").readFileSync("src/value.js","utf8")!=="export const value = 2;\\n")process.exit(1)'];
    const remote = await bare(s), value = await runRepair(s.job(), s.options), result = value.result; validateTestedCandidate(result, s.policy);
    assert.equal(result.payload?.outcome, 'candidate'); assert.deepEqual(result.candidate!.parents, [s.head, s.base]);
    const checkout = join(s.temporary, 'push-merge'); await restoreCandidate(s.output, value.reference, checkout);
    assert.equal(git(checkout, 'diff', '--name-only', s.head, result.candidate!.sha), '');
    const request: PushRequest = { schemaVersion: 1, repositoryId: 'R_paperboat', repository: 'reef-labs/paperboat', pullRequestId: 'PR_42', number: 42, targetRef: 'refs/heads/update',
      expectedHeadSha: s.head, baseSha: s.base, candidateSha: result.candidate!.sha, tree: result.candidate!.tree, parents: result.candidate!.parents };
    const target: PushTarget = { repositoryId: request.repositoryId, repository: request.repository, pullRequestId: request.pullRequestId, number: 42, headRepositoryId: request.repositoryId, headRepository: request.repository,
      headRef: request.targetRef, baseRef: 'refs/heads/main', defaultRef: 'refs/heads/main', headSha: s.head, baseSha: s.base, lifecycle: 'open', draft: false };
    assert.equal((await conditionalPush(request, { transport: localPushTransport(request.repository, checkout, remote), readTarget: async () => target, authorize: () => true })).status, 'confirmed');
    assert.equal(git(remote, 'rev-parse', request.targetRef), result.candidate!.sha);
  } finally { await s.cleanup(); }
});
