import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalJson, digest, buildPackage, controlDecision, replay, type WorkflowPackage } from '@repo-chap/workflow';
import { GitHubReader, listOpenPullRequests, tokenCredentials, type Inspection } from '@repo-chap/github';
import { collectSources } from '@repo-chap/providers';
import { RuntimeStore, type AnalysisJob, type AnalysisResult } from '@repo-chap/runtime';
import { DaemonService, fetchSources, serveControl, requestControl, type ControlRequest } from '@repo-chap/daemon';
import { setup } from './helpers/provider-fixture.ts';

const cli = resolve('apps/cli/dist/cli.js');
function remote(inspection: Inspection, count = 1) {
  const calls: string[] = [];
  let draft = false, closed = false, unavailable = false, reviewer = false, incomplete = false;
  const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)), operation = /query\s+(\w+)/.exec(request.query)?.[1] ?? '';
    calls.push(operation); assert.ok(request.query.startsWith('query '));
    if (unavailable) return Response.json({ data: { repository: null } });
    if (incomplete && operation === 'Inspectreviews') return Response.json({ data: null, errors: [{ message: 'Fictional incomplete review collection.' }] });
    const pr = inspection.evidence.pullRequest!, repo = inspection.evidence.repository!;
    let data: unknown;
    if (operation === 'PollPullRequests') data = { repository: { id: repo.id, nameWithOwner: repo.name, isPrivate: true, pullRequests: page(closed ? [] : Array.from({ length: count }, (_, index) => ({ number: 42 + index }))) } };
    else if (operation === 'InspectMetadata') data = { repository: { id: repo.id, nameWithOwner: repo.name, isPrivate: true, pullRequest: {
      id: `PR_${request.variables.number}`, number: request.variables.number, url: pr.url.replace(/\d+$/, String(request.variables.number)), title: pr.title, body: pr.body, author: { login: pr.author }, state: closed ? 'CLOSED' : 'OPEN', isDraft: draft,
      headRefOid: pr.headSha, baseRefOid: pr.baseSha, headRefName: pr.headRef, baseRefName: pr.baseRef, headRepository: { id: repo.id, nameWithOwner: repo.name },
      createdAt: pr.createdAt, updatedAt: pr.updatedAt, mergeable: 'MERGEABLE', reviewDecision: null,
    } } };
    else if (operation === 'InspectChecks') data = { repository: { object: { statusCheckRollup: { contexts: page([]) } } } };
    else if (operation === 'Inspectreactions') data = { repository: { pullRequest: { reactions: page(reviewer ? [{ id: 'EYES_fictional', user: { login: 'willow-bot' }, content: 'EYES', createdAt: '2026-09-16T12:00:00Z' }] : []) } } };
    else if (operation.startsWith('Inspect')) data = { repository: { pullRequest: { [operation.slice(7)]: page([]) } } };
    else throw new Error('Unexpected query');
    return Response.json({ data });
  };
  return { calls, fetch, draft: (value: boolean) => { draft = value; }, close: () => { closed = true; }, access: (value: boolean) => { unavailable = !value; }, reviewer: () => { reviewer = true; }, incomplete: () => { incomplete = true; } };
}
function completed(job: AnalysisJob): AnalysisResult {
  const payload = job.actionId === 'classify' ? { schemaVersion: 1, headSha: job.headSha, labels: [], uncertain: false } :
    { schemaVersion: 1, headSha: job.headSha, baseSha: job.baseSha, summary: 'Fictional pinned review.', verdict: 'acceptable', coverage: 'complete', missingEvidence: [], findings: [] };
  return { schemaVersion: 1, job, provider: { schemaVersion: 1, provider: 'codex', providerVersion: 'fixture', profile: 'pilot', providerDigest: null, inputDigest: job.evidenceKey,
    outcome: 'completed', diagnostic: 'Validated fixture analysis.', payload, attempts: [] } };
}
async function fixture(options: { failing?: boolean; reviewers?: string[]; limits?: Parameters<typeof RuntimeStore.open>[1] } = {}) {
  const s = await setup(), directory = join(s.temporary, 'state'), fake = remote(s.inspection), jobs: AnalysisJob[] = [];
  let now = Date.parse('2026-09-16T12:00:00Z');
  let store = await RuntimeStore.open(directory, options.limits);
  const sources = await collectSources(s.repository, s.head, s.base);
  const deps = { directory, credentials: tokenCredentials('fictional-daemon-token'), profile: async () => s.profile, readOptions: { fetch: fake.fetch, sleep: async () => {} }, now: () => now,
    sources: async () => sources, execute: async (job: AnalysisJob) => { jobs.push(job); if (options.failing) throw new Error('credential-not-for-output'); return completed(job); } };
  let service = new DaemonService(store, deps);
  const repo = await service.register({ name: 'reef-labs/paperboat', package: s.pkg, profile: s.profile.name, reviewers: options.reviewers ?? [] });
  const tick = async () => { await service.tick(); await service.idle(); };
  return { ...s, directory, fake, jobs, repo, get store() { return store; }, get service() { return service; }, get now() { return now; }, tick,
    advance: (milliseconds: number) => { now += milliseconds; },
    restart: async () => { await service.stop(); store.close(); store = await RuntimeStore.open(directory, options.limits); service = new DaemonService(store, deps); },
    cleanup: async () => { await service.stop(); store.close(); await s.cleanup(); } };
}
test('daemon waits persist across restart and analysis progresses to a local effect stop', async () => {
  const s = await fixture();
  try {
    await s.tick(); const waiting = s.store.runs()[0]!; assert.equal(waiting.status, 'waiting'); assert.equal(waiting.dueAt, s.now + 30_000); assert.equal(s.jobs.length, 0);
    await s.restart(); s.advance(30_001); await s.tick(); assert.equal(s.jobs.length, 1); assert.equal(s.store.run(waiting.id).control.memory?.classificationCurrent, true);
    await s.tick(); s.advance(60_001); await s.tick(); assert.equal(s.jobs.length, 2);
    await s.tick(); s.advance(60_001); await s.tick();
    assert.equal(s.store.run(waiting.id).status, 'blocked'); assert.match(s.store.run(waiting.id).reason, /Analysis mode stopped before human.publish_packet/);
    assert.deepEqual(s.store.effects(waiting.id), []); assert.equal(s.jobs.map(job => job.actionId).join(','), 'classify,review');
    assert.ok(s.fake.calls.every(call => call.startsWith('Inspect') || call === 'PollPullRequests'));
    const ref = s.store.run(waiting.id).inspection; const latest = await s.store.artifacts.get<Inspection>(ref);
    assert.equal(latest.fixture.observations[0]!.headChangedAt, '2026-09-16T12:00:00.000Z');
  } finally { await s.cleanup(); }
});
test('draft, closure and missing access stop analysis without stopping the daemon', async () => {
  const s = await fixture();
  try {
    s.fake.draft(true); await s.tick(); assert.equal(s.jobs.length, 0); const run = s.store.runs()[0]!; assert.equal(run.status, 'waiting');
    s.fake.draft(false); s.advance(61_000); await s.tick();
    s.fake.access(false); s.advance(61_000); await s.tick(); assert.equal(s.store.run(run.id).evidenceAvailable, false);
    s.store.retry(run.id, s.now); s.service.dispatch(); await s.service.idle(); assert.equal(s.store.run(run.id).control.memory?.classificationCurrent, false);
    s.fake.access(true); s.fake.close(); s.advance(61_000); await s.tick(); assert.equal(s.store.run(run.id).status, 'closed');
  } finally { await s.cleanup(); }
});
test('provider failures remain visible and suppressed until a bounded explicit retry', async () => {
  const s = await fixture({ failing: true });
  try {
    await s.tick(); s.advance(31_000); await s.tick(); await s.tick(); const run = s.store.runs()[0]!;
    assert.equal(run.status, 'blocked'); assert.equal(s.jobs.length, 1); assert.ok(!JSON.stringify(s.store.inspect(run.id)).includes('credential-not-for-output'));
    s.advance(61_000); await s.tick(); await s.restart(); s.advance(61_000); await s.tick(); assert.equal(s.jobs.length, 1);
    s.store.retry(run.id, s.now); await s.tick(); assert.equal(s.jobs.length, 2); assert.equal(s.store.inspect(run.id).reservations.length, 2);
  } finally { await s.cleanup(); }
});
test('reviewer deadline and incomplete-evidence timers use the shared replay decision', async () => {
  const s = await fixture({ reviewers: ['willow-bot'] });
  try {
    s.fake.reviewer(); await s.tick(); s.advance(31_000); await s.tick();
    const run = s.store.runs()[0]!, inspection = await s.store.artifacts.get<Inspection>(run.inspection);
    const expected = replay(s.pkg, { ...inspection.fixture, now: new Date(s.now).toISOString(), control: run.control });
    assert.equal(run.dueAt, Date.parse(expected.nextWakeAt!)); await s.restart(); s.advance(1800_000); await s.tick(); assert.equal(s.jobs.length, 1);
    const incomplete = { ...inspection.fixture.observations[0]!, facts: { ...inspection.fixture.observations[0]!.facts, evidenceComplete: false } };
    const control = controlDecision(s.pkg.workflow, 'control.wait_refresh', incomplete, { refreshAttempts: 5 }, new Date(s.now).toISOString())!;
    assert.equal(control.nextWakeAt, replay(s.pkg, { schemaVersion: 1, now: new Date(s.now).toISOString(), observations: [incomplete], control: { refreshAttempts: 5 } }).nextWakeAt);
  } finally { await s.cleanup(); }
});
test('operator socket and CLI expose status, inspect, pause/resume, cancel, retry and registration failure', async () => {
  const s = await fixture(), server = await serveControl(s.directory, s.service);
  const call = async (args: string[]) => {
    const child = spawn(process.execPath, [cli, 'daemon', ...args, '--state-dir', s.directory, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; child.stdout.on('data', data => text += data); const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
    return { code, output: JSON.parse(text) };
  };
  try {
    assert.equal((await stat(server.socket)).mode & 0o777, 0o600);
    assert.equal((await call(['status'])).output.result.mode, 'analysis');
    assert.equal((await call(['pause', '--repo', s.repo.name])).output.result.paused, true); await s.tick(); assert.equal(s.store.runs().length, 0);
    assert.equal((await call(['resume', '--repo', s.repo.name])).output.result.paused, false); await s.tick(); const run = s.store.runs()[0]!;
    assert.equal((await call(['inspect', run.id])).output.result.run.id, run.id);
    assert.equal((await call(['cancel', run.id])).output.result.status, 'cancelled');
    assert.equal((await call(['retry', run.id])).output.result.retries, 1);
    const bad = await requestControl(s.directory, { method: 'register', name: s.repo.name, profile: 'pilot', reviewers: [], package: { ...s.pkg, digest: 'invalid' } });
    assert.equal(bad.ok, false); assert.equal(s.store.repositories().length, 1); assert.equal(s.store.repository(s.repo.id).packageDigest, s.pkg.digest);
    const unchanged = await call(['register', resolve('docs/pr-workflows/examples/team-pr/workflow.json'), '--repo', s.repo.name, '--profile', 'pilot']); assert.equal(unchanged.code, 0);
    assert.equal((await call(['inspect', 'unknown-run'])).code, 7);
  } finally { await server.close(); await s.cleanup(); }
});
test('polling paginates without inferring absence after a partial list and persists cooldown', async () => {
  let pages = 0; const now = Date.now();
  const listing = await listOpenPullRequests(new GitHubReader(tokenCredentials('fictional'), { now: () => now, fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body)); pages++;
    assert.equal(request.variables.cursor, pages === 1 ? null : 'next');
    return Response.json({ data: { repository: { id: 'R_fictional', nameWithOwner: 'reef-labs/paperboat', isPrivate: true, pullRequests: { nodes: [{ number: pages }], pageInfo: { hasNextPage: pages === 1, endCursor: pages === 1 ? 'next' : null } } } } });
  } }), 'reef-labs/paperboat');
  assert.deepEqual(listing.numbers, [1, 2]); assert.equal(listing.coverage.status, 'complete');
  const limited = await listOpenPullRequests(new GitHubReader(tokenCredentials('fictional'), { now: () => now, fetch: async () => Response.json({}, { status: 429, headers: { 'retry-after': '600' } }) }), 'reef-labs/paperboat');
  assert.equal(limited.coverage.status, 'unknown'); assert.equal(Date.parse(limited.coverage.failure!.retryAt!), now + 600_000);
  const s = await fixture();
  try {
    const time = s.now + 600_000; s.store.cooldown(time); await s.restart(); const before = s.fake.calls.length; await s.tick(); assert.equal(s.fake.calls.length, before); assert.equal(s.store.cooldown(), time);
  } finally { await s.cleanup(); }
});
test('daily cost exhaustion persists its next UTC-day wake and then permits remaining bounded work', async () => {
  const s = await fixture({ limits: { dailyCostUnits: 1 } });
  try {
    await s.tick(); s.advance(31_000); await s.tick(); await s.tick(); s.advance(61_000); await s.tick();
    const run = s.store.runs()[0]!; assert.equal(run.status, 'waiting'); assert.match(run.reason, /Daily cost-unit/); assert.equal(new Date(run.dueAt!).toISOString(), '2026-09-17T00:00:00.000Z');
    await s.restart(); s.advance(run.dueAt! - s.now + 1); await s.tick(); assert.equal(s.jobs.length, 2); assert.equal(s.store.inspect(run.id).reservations.length, 2);
  } finally { await s.cleanup(); }
});
test('partial reviews persist a refresh timer and never become an empty clear review', async () => {
  const s = await fixture();
  try {
    s.fake.incomplete(); await s.tick(); const run = s.store.runs()[0]!;
    assert.equal(run.status, 'waiting'); assert.match(run.reason, /evidence is incomplete/); assert.equal(run.dueAt, s.now + 5000);
    const inspection = await s.store.artifacts.get<Inspection>(run.inspection); assert.equal(inspection.evidence.reviews.coverage.status, 'unknown');
    await s.restart(); s.advance(6000); await s.tick(); assert.equal(s.jobs.length, 0); assert.equal(s.store.run(run.id).control.refreshAttempts, 2);
  } finally { await s.cleanup(); }
});
test('direct action chains obey immediate-step and per-wake ceilings', async () => {
  for (const kind of ['steps', 'agents']) {
    const s = await setup(), directory = join(s.temporary, 'state');
    const workflow = structuredClone(s.pkg.workflow); workflow.actions.classify!.onSuccess = 'review'; workflow.limits.maxAgentActionsPerWake = kind === 'agents' ? 1 : 3;
    const pkg = buildPackage(s.pkg.workflowPath, Object.fromEntries(s.pkg.files.map(file => [file.path, file.path === s.pkg.workflowPath ? JSON.stringify(workflow) : file.text])));
    const inspection = { ...s.inspection, packageDigest: pkg.digest };
    const store = await RuntimeStore.open(directory, { maxImmediateSteps: kind === 'steps' ? 1 : 32 });
    const now = Date.now(); let calls = 0;
    const service = new DaemonService(store, { directory, credentials: tokenCredentials('fictional'), profile: async () => s.profile, now: () => now,
      sources: () => collectSources(s.repository, s.head, s.base), execute: async job => { calls++; return completed(job); } });
    try {
      const repo = await store.register({ id: 'R_paperboat', name: 'reef-labs/paperboat', package: pkg, profile: 'pilot', reviewers: [] }, now);
      const run = (await store.observe(repo.id, inspection, now))!;
      service.dispatch(); await service.idle(); service.dispatch(); await service.idle();
      assert.equal(calls, 1); assert.equal(store.run(run.id).status, 'blocked'); assert.match(store.run(run.id).reason, kind === 'steps' ? /Immediate step/ : /per-wake/);
    } finally { await service.stop(); store.close(); await s.cleanup(); }
  }
});
test('one repository provider failure does not stop another repository analysis', async () => {
  const s = await setup(), directory = join(s.temporary, 'state'), store = await RuntimeStore.open(directory), now = Date.now();
  const service = new DaemonService(store, { directory, credentials: tokenCredentials('fictional'), profile: async () => s.profile, now: () => now,
    sources: () => collectSources(s.repository, s.head, s.base), execute: async job => { if (job.repositoryId === 'R_paperboat') throw new Error('Fictional provider failure'); return completed(job); } });
  try {
    for (const name of ['paperboat', 'sailboat']) {
      const repo = await store.register({ id: `R_${name}`, name: `reef-labs/${name}`, package: s.pkg, profile: 'pilot', reviewers: [] }, now);
      const inspection = structuredClone(s.inspection); inspection.evidence.repository = { id: repo.id, name: repo.name, private: true }; inspection.evidence.requested.repository = repo.name;
      inspection.evidenceDigest = digest(canonicalJson(inspection.evidence)); inspection.fixture.observations[0]!.evidenceDigest = inspection.evidenceDigest;
      await store.observe(repo.id, inspection, now);
    }
    service.dispatch(); await service.idle(); service.dispatch(); await service.idle();
    assert.equal(store.runs('R_paperboat')[0]!.status, 'blocked'); assert.equal(store.runs('R_sailboat')[0]!.control.memory?.classificationCurrent, true);
  } finally { await service.stop(); store.close(); await s.cleanup(); }
});
test('foreground daemon starts with private App settings and recovers its socket after SIGKILL', async () => {
  const s = await setup(), directory = join(s.temporary, 'daemon');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyFile = join(s.temporary, 'app.pem'), config = join(s.temporary, 'installation.json'), preload = join(s.temporary, 'network.mjs');
  await writeFile(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  await writeFile(config, JSON.stringify({ schemaVersion: 1, app: { appId: 'fictional-app', installationId: 42, privateKeyFile: keyFile }, providerConfig: s.settings }), { mode: 0o600 });
  await writeFile(preload, `import net from 'node:net'; const original=net.Server.prototype.listen; net.Server.prototype.listen=function(...args){if(typeof args[0]!=='string')throw Error('TCP listener forbidden');return original.apply(this,args);};
    globalThis.fetch=async(url,options)=>{if(String(url).endsWith('/access_tokens'))return Response.json({token:'fictional-installation-token',expires_at:new Date(Date.now()+3600000).toISOString()});
    const input=JSON.parse(options.body); if(!input.query.startsWith('query '))throw Error('Remote mutation forbidden');return Response.json({data:{repository:{id:'R_paperboat',nameWithOwner:'reef-labs/paperboat',isPrivate:true,pullRequests:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}});};`, { mode: 0o600 });
  const start = async () => {
    const child = spawn(process.execPath, ['--import', preload, cli, 'daemon', 'start', '--state-dir', directory, '--config', config, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => { child.stdout.once('data', bytes => { try { assert.equal(JSON.parse(String(bytes)).status, 'started'); resolve(); } catch (e) { reject(e); } }); child.once('exit', code => reject(new Error(`Daemon exited ${code}`))); child.once('error', reject); });
    return child;
  };
  let child: ReturnType<typeof spawn> | undefined;
  const stop = async (signal: NodeJS.Signals) => { if (!child) return; const exited = new Promise(done => child!.once('exit', done)); child.kill(signal); await exited; child = undefined; };
  try {
    child = await start(); const registered = await requestControl(directory, { method: 'register', name: 'reef-labs/paperboat', package: s.pkg, profile: 'pilot', reviewers: [] }); assert.equal(registered.ok, true);
    await requestControl(directory, { method: 'pause', repository: 'reef-labs/paperboat' }); await stop('SIGKILL'); child = await start();
    const status = (await requestControl(directory, { method: 'status' })).result as any; assert.equal(status.repositories[0].paused, true); assert.equal(status.mode, 'analysis');
    await stop('SIGTERM');
  } finally { await stop('SIGKILL'); await s.cleanup(); }
});
test('source provisioning fetches pinned commits with ephemeral credentials and removes each fetch directory', async () => {
  const s = await setup(), bin = join(s.temporary, 'bin'), record = join(s.temporary, 'git-calls.jsonl'); await mkdir(bin);
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim(), oldPath = process.env.PATH;
  await writeFile(join(bin, 'git'), `#!${process.execPath}
    const fs=require('node:fs'),cp=require('node:child_process'),args=process.argv.slice(2);
    if(args.includes('fetch')) { if(!process.env.GIT_CONFIG_VALUE_0?.startsWith('Authorization: Basic '))process.exit(90); args[args.findIndex(x=>x.startsWith('https://github.com/'))]=${JSON.stringify(s.repository)}; }
    fs.appendFileSync(${JSON.stringify(record)},JSON.stringify(args)+'\\n');
    const result=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit',env:process.env}); process.exit(result.status??1);
  `, { mode: 0o700 });
  try {
    process.env.PATH = `${bin}:${oldPath}`;
    const cache = join(s.temporary, 'fetches');
    const bundle = await fetchSources(cache, 'reef-labs/paperboat', s.inspection, tokenCredentials('fictional-app-access'), new AbortController().signal);
    assert.equal(bundle.headSha, s.head); assert.equal(bundle.baseSha, s.base); assert.ok(bundle.comparisonBaseSha); assert.ok(bundle.diff);
    assert.deepEqual(await readdir(cache), []);
    const calls = await readFile(record, 'utf8'); assert.ok(!calls.includes('fictional-app-access')); assert.ok(!calls.includes('Authorization:')); assert.ok(!calls.includes('push'));
  } finally { process.env.PATH = oldPath; await s.cleanup(); }
});
test('forty PRs each receive complete bounded inspections, including cooldown and restart recovery', async () => {
  const s = await setup(), directory = join(s.temporary, 'state'), fake = remote(s.inspection, 40);
  let now = Date.parse('2026-09-16T12:00:00Z'), limited = false;
  const visited: number[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes('query InspectMetadata')) {
      visited.push(variables.number);
      if (variables.number === 55 && !limited) { limited = true; return Response.json({}, { status: 429, headers: { 'retry-after': '600' } }); }
    }
    return fake.fetch(url, init);
  };
  let store = await RuntimeStore.open(directory);
  const dependencies = { directory, credentials: tokenCredentials('fictional'), profile: async () => s.profile, now: () => now, readOptions: { fetch, sleep: async () => {} } };
  let service = new DaemonService(store, dependencies);
  try {
    const repo = await service.register({ name: 'reef-labs/paperboat', package: s.pkg, profile: 'pilot', reviewers: [] });
    await service.poll(repo); assert.equal(limited, true); assert.equal(store.repository(repo.id).lastPolledPr, 55);
    const retry = store.cooldown(), before = visited.length; assert.equal(retry, now + 600_000);
    await service.stop(); store.close(); store = await RuntimeStore.open(directory); service = new DaemonService(store, dependencies);
    await service.poll(store.repository(repo.id)); assert.equal(visited.length, before);
    now = retry + 1; await service.poll(store.repository(repo.id));
    assert.equal(visited[before], 56); assert.equal(store.runs().length, 40);
    for (const run of store.runs()) assert.equal((await store.artifacts.get<Inspection>(run.inspection)).status, 'complete', `PR ${run.number}`);
    now += 61_000; await service.poll(store.repository(repo.id));
    assert.equal(store.runs().length, 40); assert.ok(store.runs().some(run => run.number === 81));
    for (const run of store.runs()) assert.equal((await store.artifacts.get<Inspection>(run.inspection)).status, 'complete', `PR ${run.number}`);
  } finally { await service.stop(); store.close(); await s.cleanup(); }
});
test('failed analysis resumes each configured failure continuation after restart and keeps its charge', async () => {
  for (const continuation of ['review', '$wait', '$blocked', 'park']) {
    const s = await setup(), directory = join(s.temporary, 'state'), now = Date.now(), jobs: string[] = [];
    const workflow = structuredClone(s.pkg.workflow); workflow.actions.classify!.onFailure = continuation;
    const pkg = buildPackage(s.pkg.workflowPath, Object.fromEntries(s.pkg.files.map(file => [file.path, file.path === s.pkg.workflowPath ? JSON.stringify(workflow) : file.text])));
    const inspection = { ...s.inspection, packageDigest: pkg.digest };
    let store = await RuntimeStore.open(directory);
    const dependencies = { directory, credentials: tokenCredentials('fictional'), profile: async () => s.profile, now: () => now,
      sources: () => collectSources(s.repository, s.head, s.base), execute: async (job: AnalysisJob) => { jobs.push(job.actionId); if (job.actionId === 'classify') throw new Error('Fictional failure'); return completed(job); } };
    let service = new DaemonService(store, dependencies);
    try {
      const repo = await store.register({ id: 'R_paperboat', name: 'reef-labs/paperboat', package: pkg, profile: 'pilot', reviewers: [] }, now);
      const run = (await store.observe(repo.id, inspection, now))!;
      service.dispatch(); await service.idle(); assert.equal(store.run(run.id).nextAction, continuation); assert.equal(store.run(run.id).control.memory?.classificationCurrent, false);
      await service.stop(); store.close(); store = await RuntimeStore.open(directory); service = new DaemonService(store, dependencies);
      service.dispatch(); await service.idle();
      const simulated = replay(pkg, { ...inspection.fixture, control: { memory: { classificationCurrent: false, reviewCurrent: false, packetCurrent: false } }, results: { classify: [{ status: 'failure', reason: 'Fictional failure' }] } });
      if (continuation === 'review') {
        assert.deepEqual(jobs, ['classify', 'review']); assert.match(simulated.reason, /results.review/);
        assert.equal(store.run(run.id).control.memory?.reviewCurrent, true); assert.equal(store.run(run.id).control.memory?.classificationCurrent, false);
      } else { assert.deepEqual(jobs, ['classify']); assert.equal(store.run(run.id).status, simulated.status); }
      assert.equal(store.inspect(run.id).reservations.length, jobs.length);
      assert.equal(store.run(run.id).failedActions.classify, run.evidenceKey);
    } finally { await service.stop(); store.close(); await s.cleanup(); }
  }
});
test('failed-action suppression permits its alternative but stops unchanged repetition', async () => {
  const s = await setup(), directory = join(s.temporary, 'state');
  let now = Date.now(); const jobs: string[] = [];
  const workflow = structuredClone(s.pkg.workflow); workflow.actions.classify!.onFailure = 'review'; workflow.limits.maxAttemptsPerHead = 4;
  const pkg = buildPackage(s.pkg.workflowPath, Object.fromEntries(s.pkg.files.map(file => [file.path, file.path === s.pkg.workflowPath ? JSON.stringify(workflow) : file.text])));
  const inspection = { ...s.inspection, packageDigest: pkg.digest }, store = await RuntimeStore.open(directory);
  const service = new DaemonService(store, { directory, credentials: tokenCredentials('fictional'), profile: async () => s.profile, now: () => now,
    sources: () => collectSources(s.repository, s.head, s.base), execute: async job => { jobs.push(job.actionId); if (job.actionId === 'classify') throw new Error('Fictional failure'); return completed(job); } });
  const step = async () => { service.dispatch(); await service.idle(); };
  try {
    const repo = await store.register({ id: 'R_paperboat', name: 'reef-labs/paperboat', package: pkg, profile: 'pilot', reviewers: [] }, now);
    const run = (await store.observe(repo.id, inspection, now))!;
    await step(); await step(); await step(); now += 61_000; await step();
    assert.deepEqual(jobs, ['classify', 'review']); assert.match(store.run(run.id).reason, /Unchanged work is suppressed/);
    store.retry(run.id, now); await step(); assert.deepEqual(jobs, ['classify', 'review', 'classify']);
    assert.equal(store.inspect(run.id).reservations.length, 3); assert.equal(store.run(run.id).retries, 1);
  } finally { await service.stop(); store.close(); await s.cleanup(); }
});
test('already-created readers observe another reader cooldown before their next request', async () => {
  const now = Date.now(); let until = 0, requests = 0;
  const options = { now: () => now, cooldown: { read: () => until, extend: (value: number) => { until = Math.max(until, value); } },
    fetch: async () => { requests++; return Response.json({}, { status: 429, headers: { 'retry-after': '600' } }); } };
  const first = new GitHubReader(tokenCredentials('fictional'), options), second = new GitHubReader(tokenCredentials('fictional'), options);
  await assert.rejects(first.query('query Fictional { viewer { login } }', {}));
  assert.equal(until, now + 600_000); await assert.rejects(second.query('query Fictional { viewer { login } }', {}));
  assert.equal(requests, 1);
});
