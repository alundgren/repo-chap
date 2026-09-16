import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPackage } from '@repo-chap/workflow';
import { GitHubReader, githubThreadTransport, installationPullRequestWriteCredentials, localPullRequestWriteCredentials, localPushTransport,
  readThreadTarget, reconcileThread, resolveThread, threadContentDigest, tokenCredentials,
  type PushReceipt, type PushRequest, type ThreadResolutionRequest, type ThreadTarget, type ThreadTransport, type Inspection } from '@repo-chap/github';
import { RuntimeStore, type ApplyPolicy, type RepairAttemptJob } from '@repo-chap/runtime';
import { captureRepairSource } from '@repo-chap/execution';
import { DaemonService, executeRepair, handleControl, inspectLocalApply } from '@repo-chap/daemon';
import { repairFixture } from './helpers/repair-fixture.ts';
import { remote } from './helpers/daemon-remote.ts';
import { git } from './helpers/provider-fixture.ts';

function adapterFixture() {
  const push: PushRequest = { schemaVersion: 1, repository: 'reef-labs/paperboat', repositoryId: 'R_paperboat', pullRequestId: 'PR_42', number: 42,
    targetRef: 'refs/heads/update', expectedHeadSha: '1'.repeat(40), baseSha: '2'.repeat(40), candidateSha: '3'.repeat(40), tree: '4'.repeat(40), parents: ['1'.repeat(40)] };
  const target: ThreadTarget = { repository: push.repository, repositoryId: push.repositoryId, pullRequestId: push.pullRequestId, number: push.number,
    headRepositoryId: push.repositoryId, headSha: push.candidateSha, baseSha: push.baseSha, headRef: push.targetRef, lifecycle: 'open', draft: false, canResolve: true,
    thread: { id: 'THREAD_value', resolved: false, outdated: true, path: 'src/value.js', line: null, comments: { coverage: { status: 'complete', pages: 1 }, items: [
      { id: 'COMMENT_value', author: 'river', body: 'Use value three.', createdAt: '2026-01-01T00:00:00.000Z', headSha: push.expectedHeadSha },
    ] } } };
  const request: ThreadResolutionRequest = { schemaVersion: 1, pushEffectId: 'confirmed-push', push, threadId: target.thread.id, threadDigest: threadContentDigest(target.thread), disposition: 'addressed' };
  const pushReceipt: PushReceipt = { status: 'confirmed', repository: push.repository, targetRef: push.targetRef, expectedHeadSha: push.expectedHeadSha,
    candidateSha: push.candidateSha, observedSha: push.candidateSha, retryable: false, reason: 'Confirmed tested push.' };
  let writes = 0;
  const transport: ThreadTransport = { repository: push.repository, resolve: async (_id, before) => { if (await before()) { writes++; target.thread.resolved = true; return 'accepted'; } return 'unknown'; } };
  return { push, target, request, pushReceipt, transport, readTarget: async () => structuredClone(target), authorize: () => true, get writes() { return writes; } };
}
test('adapter resolves one confirmed addressed concern, including outdated locations, without claiming other concerns', async () => {
  const s = adapterFixture(), result = await resolveThread(s.request, s);
  assert.equal(result.status, 'confirmed'); assert.equal(result.threadId, 'THREAD_value'); assert.equal(result.remoteResolved, true); assert.equal(result.evidenceCurrent, true); assert.equal(s.writes, 1);
  assert.equal((await resolveThread(s.request, s)).status, 'confirmed'); assert.equal(s.writes, 1);
});
test('adapter rejects unconfirmed, declined, blocked, changed, foreign, missing and unauthorized concerns without a write', async () => {
  const changes: ((s: ReturnType<typeof adapterFixture>) => void)[] = [
    s => { s.pushReceipt.status = 'unknown'; }, s => { s.pushReceipt.candidateSha = '5'.repeat(40); },
    s => { s.request.disposition = 'declined'; }, s => { s.request.disposition = 'blocked'; }, s => { s.target.headSha = '6'.repeat(40); },
    s => { s.target.thread.comments.items[0]!.body = 'Use value four instead.'; }, s => { s.target.thread.comments.items.push({ ...s.target.thread.comments.items[0]!, id: 'COMMENT_followup' }); },
    s => { s.target.thread.id = 'THREAD_unrelated'; }, s => { s.target.repositoryId = 'R_other'; }, s => { s.target.pullRequestId = 'PR_other'; },
    s => { s.target.headRepositoryId = 'R_fork'; }, s => { s.target.draft = true; }, s => { s.target.lifecycle = 'closed'; },
    s => { s.target.canResolve = false; }, s => { s.authorize = () => false; },
  ];
  for (const change of changes) { const s = adapterFixture(); change(s); const receipt = await resolveThread(s.request, s); assert.equal(receipt.status, 'rejected'); assert.equal(s.writes, 0); assert.ok(receipt.reason); }
  const missing = adapterFixture(); assert.equal((await resolveThread(missing.request, { ...missing, readTarget: async () => { throw new Error('Missing thread'); } })).status, 'rejected'); assert.equal(missing.writes, 0);
});
test('ambiguous thread writes reconcile remote state without retrying an open or reopened thread', async () => {
  const s = adapterFixture();
  const lost = { ...s.transport, resolve: async (...args: Parameters<ThreadTransport['resolve']>) => { await s.transport.resolve(...args); throw new Error('Lost response'); } };
  assert.equal((await resolveThread(s.request, { ...s, transport: lost })).status, 'confirmed'); assert.equal(s.writes, 1);
  s.target.thread.resolved = false;
  const open = await reconcileThread(s.request, s.readTarget); assert.equal(open.status, 'unknown'); assert.equal(open.retryable, false); assert.equal(open.remoteResolved, false); assert.equal(s.writes, 1);
  const unreadable = await reconcileThread(s.request, async () => { throw new Error('offline'); }); assert.equal(unreadable.status, 'unknown'); assert.equal(unreadable.remoteResolved, null);
});
test('post-write head and content changes stay visible even when GitHub reports resolved', async () => {
  for (const changed of ['head', 'content']) {
    const s = adapterFixture(), transport = { ...s.transport, resolve: async (...args: Parameters<ThreadTransport['resolve']>) => {
      const result = await s.transport.resolve(...args); if (changed === 'head') s.target.headSha = '6'.repeat(40); else s.target.thread.comments.items[0]!.body = 'A new concern.'; return result;
    } };
    const result = await resolveThread(s.request, { ...s, transport }); assert.equal(result.status, 'confirmed'); assert.equal(result.remoteResolved, true); assert.equal(result.evidenceCurrent, false); assert.match(result.reason, /does not confirm/);
  }
});
test('write credentials finish before final head, thread and ownership checks; GraphQL mutation is never automatically retried', async () => {
  const s = adapterFixture(); let sends = 0; const events: string[] = [];
  const credentials = { repository: s.push.repository, permission: 'pull_requests:write' as const, redact: (text: string) => text,
    token: async () => { events.push('credentials'); s.target.headSha = '6'.repeat(40); return 'fictional-secret'; } };
  const transport = githubThreadTransport(s.push.repository, credentials, { fetch: async () => { sends++; throw new Error('Lost response'); } });
  assert.equal((await resolveThread(s.request, { ...s, transport, readTarget: async () => { events.push('read'); return s.target; } })).status, 'rejected');
  assert.deepEqual(events, ['credentials', 'read']); assert.equal(sends, 0);
  credentials.token = async () => 'fictional-secret'; s.target.headSha = s.push.candidateSha;
  assert.equal((await resolveThread(s.request, { ...s, transport })).status, 'unknown'); assert.equal(sends, 1);
  const denied = await resolveThread(s.request, { ...s, transport, authorize: () => false }); assert.equal(denied.status, 'rejected'); assert.equal(sends, 1);
});
test('PR write credential factories scope installation access and reject missing returned permission', async () => {
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  for (const permission of ['read', 'write']) {
    const credentials = installationPullRequestWriteCredentials({ appId: 'fictional-app', installationId: 17, privateKey, fetch: async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { permissions: { contents: 'read', pull_requests: 'write' }, repositories: ['paperboat'] });
      return Response.json({ token: 'fictional-write-token', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { contents: 'read', pull_requests: permission } });
    } }, 'reef-labs/paperboat');
    if (permission === 'read') await assert.rejects(credentials.token()); else assert.equal(await credentials.token(), 'fictional-write-token');
  }
  const local = await localPullRequestWriteCredentials('reef-labs/paperboat', { env: { GH_TOKEN: 'fictional-local' } }); assert.equal(local.permission, 'pull_requests:write');
  assert.throws(() => githubThreadTransport('reef-labs/other', local));
});
test('thread reads require every comment page and reject changing or incomplete pagination', async () => {
  const s = adapterFixture(), comment = s.target.thread.comments.items[0]!;
  for (const failure of ['none', 'count', 'errors', 'duplicate']) {
    let pages = 0;
    const reader = new GitHubReader(tokenCredentials('fictional-read'), { fetch: async (_url, init) => {
      const { variables } = JSON.parse(String(init?.body)); pages++;
      assert.equal(variables.cursor, pages === 1 ? null : 'next');
      const data = { node: { id: s.request.threadId, isResolved: false, isOutdated: true, path: s.target.thread.path, line: null, viewerCanResolve: true,
        pullRequest: { id: s.push.pullRequestId, number: 42, state: 'OPEN', isDraft: false, headRefOid: s.push.candidateSha, baseRefOid: s.push.baseSha,
          headRefName: 'update', repository: { id: s.push.repositoryId, nameWithOwner: s.push.repository }, headRepository: { id: s.push.repositoryId } },
        comments: { totalCount: failure === 'count' && pages === 2 ? 3 : 2, pageInfo: { hasNextPage: pages === 1, endCursor: pages === 1 ? 'next' : null },
          nodes: [{ id: failure === 'duplicate' ? 'COMMENT_same' : `COMMENT_${pages}`, body: comment.body, createdAt: comment.createdAt, author: { login: comment.author }, commit: { oid: comment.headSha } }] },
      } };
      return Response.json({ data, ...(failure === 'errors' && pages === 2 ? { errors: [{ message: 'Incomplete response' }] } : {}) });
    } });
    if (failure === 'none') assert.equal((await readThreadTarget(reader, s.request.threadId)).thread.comments.items.length, 2);
    else await assert.rejects(readThreadTarget(reader, s.request.threadId));
    assert.equal(pages, 2);
  }
});

async function runtimeFixture(mode = 'valid') {
  const s = await repairFixture('codex', mode), directory = join(s.temporary, 'state'), remotePath = join(s.temporary, 'remote.git');
  await mkdir(remotePath); git(remotePath, 'init', '--bare', '-q'); git(s.repository, 'push', '-q', remotePath, `${s.head}:refs/heads/update`, `${s.base}:refs/heads/main`);
  const files = Object.fromEntries(s.pkg.files.map(file => [file.path, file.text])), workflow = JSON.parse(files[s.pkg.workflowPath]!);
  workflow.settings.newPrDelaySeconds = 0; workflow.settings.headDebounceSeconds = 0; files[s.pkg.workflowPath] = JSON.stringify(workflow); s.pkg = buildPackage(s.pkg.workflowPath, files);
  s.inspection.packageDigest = s.pkg.digest;
  const policy: ApplyPolicy = { schemaVersion: 1, repository: 'reef-labs/paperboat', capabilities: ['workspace.write', 'checks.run', 'pr.push', 'review.resolve'],
    maxRepairsPerLifecycle: 2, maxPushAttempts: 2, execution: s.policy };
  let store = await RuntimeStore.open(directory), service: DaemonService, sends = 0, unknown = false, permitted = true;
  const jobs: RepairAttemptJob[] = [], fake = remote(s.inspection);
  const dependencies = { directory, credentials: tokenCredentials('fictional-read'), profile: async () => s.profile, applyPolicy: async () => permitted ? policy : null,
    readOptions: { fetch: (async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.query.startsWith('mutation ')) {
        sends++; if (unknown && body.variables.id === 'THREAD_value') throw new Error('Lost fictional remote response');
        const thread = s.inspection.evidence.threads.items.find(thread => thread.id === body.variables.id)!; thread.resolved = true;
        return Response.json({ data: { resolveReviewThread: { thread: { id: thread.id, isResolved: true } } } });
      }
      return fake.fetch(url, init);
    }) as typeof globalThis.fetch },
    threadCredentials: (repository: string) => localPullRequestWriteCredentials(repository, { env: { GH_TOKEN: 'fictional-write' } }),
    repairSources: (_repository: string, inspection: Inspection, signal: AbortSignal) => captureRepairSource(remotePath, inspection.evidence.pullRequest!.headSha, inspection.evidence.pullRequest!.baseSha, join(directory, 'repairs'), signal),
    repair: async (job: RepairAttemptJob, profile: typeof s.profile, signal: AbortSignal, isCurrent: () => boolean) => { jobs.push(job); return executeRepair(job, { artifacts: store.artifacts, profile, artifactDirectory: join(directory, 'repairs'), workerDirectory: join(directory, 'workers'), signal, isCurrent }); },
    pushTransport: async (repository: string, checkout: string, signal: AbortSignal) => {
      const transport = localPushTransport(repository, checkout, remotePath, signal);
      return { ...transport, push: async (...args: Parameters<typeof transport.push>) => { const outcome = await transport.push(...args); if (outcome === 'accepted') s.inspection.evidence.pullRequest!.headSha = args[2]; return outcome; } };
    },
  };
  service = new DaemonService(store, dependencies); const repo = await service.register({ name: policy.repository, package: s.pkg, profile: s.profile.name, reviewers: [] });
  const tick = async () => { await service.tick(); await service.idle(); };
  const push = async () => { await tick(); await tick(); await tick(); assert.equal(store.effects(store.runs()[0]!.id)[0]!.state, 'confirmed'); };
  return { ...s, directory, repo, policy, jobs, dependencies, tick, push, get store() { return store; }, get service() { return service; }, get sends() { return sends; },
    uncertain: () => { unknown = true; }, revoke: () => { permitted = false; },
    restart: async () => { await service.stop(); store.close(); store = await RuntimeStore.open(directory); service = new DaemonService(store, dependencies); },
    cleanup: async () => { await service.stop(); store.close(); await s.cleanup(); },
  };
}
test('daemon resolves after ordinary bot-head observation and restart using one retained repair, then exposes independent handoff details', async () => {
  const s = await runtimeFixture();
  try {
    await s.push(); const id = s.store.runs()[0]!.id;
    await s.restart(); s.store.pollFinished(s.repo.id, 0, null); await s.tick();
    assert.equal(s.store.run(id).repair, null); assert.equal(s.jobs.length, 1); assert.equal(s.sends, 1);
    const details = await handleControl(s.service, { method: 'inspect', runId: id }) as any;
    assert.equal(details.threadResolution.pushConfirmed, true); assert.equal(details.threadResolution.concerns[0].state, 'confirmed'); assert.deepEqual(details.threadResolution.remainingConcerns, []);
    assert.equal(s.store.inspect(id).reservations.length, 1);
    const cli = spawnSync(process.execPath, [resolve('apps/cli/dist/cli.js'), 'apply', 'inspect', id, '--state-dir', s.directory], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /Push confirmed: [a-f0-9]{40}; 0 concerns need attention/); assert.match(cli.stdout, /Thread THREAD_value: confirmed, addressed/);
    await s.restart(); await s.tick(); assert.equal(s.sends, 1); assert.equal(s.jobs.length, 1);
  } finally { await s.cleanup(); }
});
test('mixed thread outcomes retain one unknown, confirm another, report a new concern, and never rerun repair', async () => {
  const s = await runtimeFixture();
  try {
    s.inspection.evidence.threads.items.push({ ...structuredClone(s.inspection.evidence.threads.items[0]!), id: 'THREAD_second' });
    await s.push(); const id = s.store.runs()[0]!.id;
    s.inspection.evidence.threads.items.push({ ...structuredClone(s.inspection.evidence.threads.items[0]!), id: 'THREAD_new' });
    s.uncertain(); s.store.pollFinished(s.repo.id, 0, null); await s.tick();
    const details = await handleControl(s.service, { method: 'inspect', runId: id }) as any;
    assert.equal(s.sends, 2); assert.deepEqual(details.threadResolution.concerns.map((c: any) => [c.threadId, c.state]), [['THREAD_value', 'unknown'], ['THREAD_second', 'confirmed'], ['THREAD_new', 'skipped']]);
    assert.equal(details.threadResolution.remainingConcerns.length, 2); assert.equal(s.jobs.length, 1);
    await s.restart(); await s.tick(); assert.equal(s.sends, 2); assert.equal(s.store.inspect(id).reservations.length, 1);
  } finally { await s.cleanup(); }
});
test('edited concern and a newer PR head reject retained resolution without another repair', async () => {
  for (const change of ['head', 'content']) {
    const s = await runtimeFixture();
    try {
      await s.push(); const id = s.store.runs()[0]!.id;
      if (change === 'head') s.inspection.evidence.pullRequest!.headSha = '6'.repeat(40); else s.inspection.evidence.threads.items[0]!.comments.items[0]!.body = 'New review intent.';
      s.store.pollFinished(s.repo.id, 0, null); await s.tick();
      const details = await handleControl(s.service, { method: 'inspect', runId: id }) as any;
      assert.equal(s.sends, 0); assert.equal(details.threadResolution.concerns[0].state, 'stale'); assert.equal(details.threadResolution.remainingConcerns.length, 1); assert.equal(s.jobs.length, 1);
    } finally { await s.cleanup(); }
  }
});
test('declined decisions stay open while the addressed thread resolves and its failure handoff survives observation', async () => {
  const s = await runtimeFixture('mixed_threads');
  try {
    s.inspection.evidence.threads.items.push({ ...structuredClone(s.inspection.evidence.threads.items[0]!), id: 'THREAD_declined' });
    await s.push(); await s.tick(); const id = s.store.runs()[0]!.id;
    const next = s.store.run(id).nextAction;
    assert.equal(s.sends, 1); assert.equal(s.inspection.evidence.threads.items[1]!.resolved, false);
    let details = await handleControl(s.service, { method: 'inspect', runId: id }) as any;
    assert.deepEqual(details.threadResolution.concerns.map((c: any) => c.state), ['confirmed', 'skipped']); assert.equal(details.threadResolution.remainingConcerns[0].disposition, 'declined');
    s.store.pollFinished(s.repo.id, 0, null); await s.tick(); assert.equal(s.jobs.length, 1); assert.equal(s.store.run(id).nextAction, next);
    details = await handleControl(s.service, { method: 'inspect', runId: id }) as any; assert.equal(details.threadResolution.remainingConcerns.length, 1);
  } finally { await s.cleanup(); }
});
test('later reopened and changed concerns are visible beside historical confirmed receipts', async () => {
  const s = await runtimeFixture();
  try {
    await s.push(); await s.tick(); const id = s.store.runs()[0]!.id;
    s.inspection.evidence.threads.items[0]!.resolved = false;
    await s.service.poll(s.store.repository(s.repo.id));
    const details = await handleControl(s.service, { method: 'inspect', runId: id }) as any;
    assert.equal(details.threadResolution.concerns[0].state, 'stale'); assert.equal(details.threadResolution.concerns[0].remoteResolved, false); assert.equal(details.threadResolution.remainingConcerns.length, 1);
    assert.match(details.threadResolution.concerns[0].reason, /reopened/); assert.equal(details.effects.find((effect: any) => effect.kind === 'github.resolve_eligible_threads').state, 'confirmed'); assert.equal(s.sends, 1);
    s.store.unavailable(id, 'Access unavailable.', Date.now() + 60_000);
    const unavailable = await handleControl(s.service, { method: 'inspect', runId: id }) as any;
    assert.equal(unavailable.threadResolution.concerns[0].state, 'unknown'); assert.equal(unavailable.threadResolution.concerns[0].remoteResolved, null);
    assert.equal(unavailable.threadResolution.remainingConcerns.length, 1); assert.equal(s.sends, 1);
  } finally { await s.cleanup(); }
});
test('local plan mode persists individual thread requests without writes or another repair', async () => {
  const s = await runtimeFixture();
  try {
    await s.push(); await s.service.stop(); const id = s.store.runs()[0]!.id;
    const planner = new DaemonService(s.store, { ...s.dependencies, planOnly: true });
    await planner.tick(); await planner.idle(); await planner.stop();
    const effects = s.store.effects(id).filter(effect => effect.kind === 'github.resolve_eligible_threads');
    assert.equal(effects.length, 1); assert.equal(effects[0]!.state, 'planned'); assert.equal(s.store.effectAttempts(effects[0]!.id).length, 0); assert.equal(s.sends, 0); assert.equal(s.jobs.length, 1);
    await s.restart(); await s.tick(); assert.equal(s.sends, 1);
  } finally { await s.cleanup(); }
});
test('a pre-send failure reuses its semantic request after another thread resolves and new evidence is observed', async () => {
  const s = await runtimeFixture();
  try {
    s.inspection.evidence.threads.items.push({ ...structuredClone(s.inspection.evidence.threads.items[0]!), id: 'THREAD_second' });
    await s.push(); const id = s.store.runs()[0]!.id, original = s.dependencies.threadCredentials; let first = true;
    s.dependencies.threadCredentials = async repository => { if (first) { first = false; throw new Error('Temporary credential failure'); } return original(repository); };
    await s.tick(); const prior = s.store.effects(id).filter(effect => effect.kind === 'github.resolve_eligible_threads');
    assert.deepEqual(prior.map(effect => effect.state), ['rejected', 'confirmed']); assert.equal(s.sends, 1);
    await s.restart(); s.store.retry(id, Date.now()); s.store.pollFinished(s.repo.id, 0, null); await s.tick();
    const effects = s.store.effects(id).filter(effect => effect.kind === 'github.resolve_eligible_threads');
    assert.deepEqual(effects.map(effect => effect.id), prior.map(effect => effect.id)); assert.ok(effects.every(effect => effect.state === 'confirmed'));
    assert.equal(s.sends, 2); assert.equal(s.store.effectAttempts(prior[0]!.id).length, 2); assert.equal(s.jobs.length, 1); assert.equal(s.store.inspect(id).reservations.length, 1);
  } finally { await s.cleanup(); }
});
test('policy revocation and cancellation during credential acquisition prevent thread writes', async () => {
  for (const change of ['policy', 'ownership']) {
    const s = await runtimeFixture();
    try {
      await s.push(); const id = s.store.runs()[0]!.id;
      s.dependencies.threadCredentials = async repository => ({ repository, permission: 'pull_requests:write', redact: text => text, token: async () => {
        if (change === 'policy') s.revoke(); else s.store.cancel(id); return 'fictional-not-sent';
      } });
      await s.tick(); await s.tick(); assert.equal(s.sends, 0); assert.equal(s.jobs.length, 1);
      assert.ok(s.store.effects(id).some(effect => effect.kind === 'github.resolve_eligible_threads' && ['rejected', 'unknown'].includes(effect.state)));
    } finally { await s.cleanup(); }
  }
});
test('temporary evidence loss and restart preserve pending resolution and its single repair reservation', async () => {
  const s = await runtimeFixture();
  try {
    await s.push(); const id = s.store.runs()[0]!.id;
    await s.service.poll(s.store.repository(s.repo.id)); assert.equal(s.store.run(id).repair, null);
    const pending = s.store.run(id).nextAction; assert.equal(pending, 'resolve_threads');
    s.store.unavailable(id, 'Temporary access loss.', Date.now());
    s.service.dispatch(); await s.service.idle(); assert.equal(s.store.run(id).nextAction, pending); assert.equal(s.sends, 0);
    await s.restart(); await s.service.poll(s.store.repository(s.repo.id));
    assert.equal(s.store.run(id).nextAction, pending); await s.tick();
    assert.equal(s.sends, 1); assert.equal(s.jobs.length, 1); assert.equal(s.store.inspect(id).reservations.length, 1);
  } finally { await s.cleanup(); }
});
test('later human resolution updates skipped concerns while access loss preserves the failure handoff and original decisions', async () => {
  const s = await runtimeFixture('mixed_threads');
  try {
    s.inspection.evidence.threads.items.push({ ...structuredClone(s.inspection.evidence.threads.items[0]!), id: 'THREAD_declined' });
    await s.push(); await s.tick(); const id = s.store.runs()[0]!.id;
    await s.service.poll(s.store.repository(s.repo.id)); const continuation = s.store.run(id).nextAction;
    assert.equal(s.store.run(id).repair, null);
    s.store.unavailable(id, 'Temporary access loss.', Date.now()); s.service.dispatch(); await s.service.idle();
    assert.equal(s.store.run(id).nextAction, continuation);
    const unavailable = await handleControl(s.service, { method: 'inspect', runId: id }) as any;
    assert.equal(unavailable.threadResolution.concerns[1].remoteResolved, null); assert.equal(unavailable.threadResolution.concerns[1].state, 'unknown');
    s.inspection.evidence.threads.items[1]!.resolved = true;
    await s.restart(); await s.service.poll(s.store.repository(s.repo.id));
    const details = await handleControl(s.service, { method: 'inspect', runId: id }) as any;
    assert.equal(details.threadResolution.remainingConcerns.length, 0); assert.equal(details.threadResolution.concerns[1].disposition, 'declined');
    assert.equal(details.threadResolution.concerns[1].remoteResolved, true); assert.equal(details.threadResolution.concerns[1].state, 'skipped');
    assert.equal(details.threadResolution.concerns[1].effectId, null); assert.equal(s.sends, 1); assert.equal(s.jobs.length, 1); assert.equal(s.store.inspect(id).reservations.length, 1);
  } finally { await s.cleanup(); }
});
test('actual daemon process death after thread acceptance reconciles one receipt with no duplicate write or provider invocation', async () => {
  const s = await runtimeFixture();
  try {
    await s.push(); const id = s.store.runs()[0]!.id;
    await s.service.stop(); const fixture = join(s.temporary, 'thread-crash.json');
    await writeFile(fixture, JSON.stringify({ directory: s.directory, inspection: s.inspection, profile: s.profile, policy: s.policy }), { mode: 0o600 });
    const child = spawnSync(process.execPath, [resolve('tests/helpers/thread-crash-child.ts'), fixture], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr || child.stdout);
    const persisted = JSON.parse(await readFile(fixture, 'utf8')); Object.assign(s.inspection, persisted.inspection);
    assert.equal(s.inspection.evidence.threads.items[0]!.resolved, true);
    await s.restart();
    const details = await inspectLocalApply(s.directory, id, s.dependencies) as any;
    assert.equal(details.threadResolution.concerns[0].state, 'confirmed'); assert.equal(details.threadResolution.concerns[0].remoteResolved, true);
    assert.equal(details.effectAttempts.filter((attempt: any) => attempt.effectId === details.threadResolution.concerns[0].effectId).length, 1);
    await s.tick(); assert.equal(s.sends, 0); assert.equal(s.jobs.length, 1); assert.equal(s.store.inspect(id).reservations.length, 1);
  } finally { await s.cleanup(); }
});
