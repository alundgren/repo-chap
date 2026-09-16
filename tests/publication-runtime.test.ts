import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { buildPackage, canonicalJson, digest, type WorkflowPackage } from '@repo-chap/workflow';
import { collectSources } from '@repo-chap/providers';
import { tokenCredentials, type PublicationCapability, type PublicationReceipt } from '@repo-chap/github';
import { RuntimeStore, prepareLabelPublication, summarizePublications, type AnalysisJob, type ApplyPolicy } from '@repo-chap/runtime';
import { DaemonService, type DaemonDependencies } from '@repo-chap/daemon';
import { setup, git } from './helpers/provider-fixture.ts';
import { completed } from './helpers/daemon-remote.ts';
import { publicationRemote, publicationState } from './helpers/publication-remote.ts';

export function publicationWorkflow(pkg: WorkflowPackage, kind: PublicationCapability = 'review.publish', onFailure = '$blocked'): WorkflowPackage {
  const files = Object.fromEntries(pkg.files.map(file => [file.path, file.text])), workflow = structuredClone(pkg.workflow);
  const analysisId = kind === 'review.publish' ? 'review' : 'classify';
  const analysis = workflow.actions[analysisId]!;
  analysis.onSuccess = 'publish'; analysis.onFailure = '$blocked';
  workflow.actions = { [analysisId]: analysis, publish: { uses: kind === 'review.publish' ? 'github.publish_review' : 'github.set_labels', execution: 'code',
    capabilities: [kind], onSuccess: '$wait', onFailure } };
  workflow.rules = [{ id: 'analyze', when: { field: 'facts.lifecycle', op: 'eq', value: 'open' }, action: analysisId }]; workflow.otherwise = analysisId;
  workflow.requestedCapabilities = ['workspace.read', kind];
  workflow.settings.newPrDelaySeconds = 0; workflow.settings.headDebounceSeconds = 0;
  return buildPackage(pkg.workflowPath, { ...files, [pkg.workflowPath]: JSON.stringify(workflow) });
}
async function fixture(kind: PublicationCapability = 'review.publish', source = false, configure?: (base: WorkflowPackage) => WorkflowPackage) {
  const s = await setup(), pkg = configure?.(s.pkg) ?? publicationWorkflow(s.pkg, kind), directory = join(s.temporary, 'publication-runtime');
  s.inspection.packageDigest = pkg.digest;
  const remote = publicationRemote(s.inspection), jobs: AnalysisJob[] = [];
  const policy: ApplyPolicy = { schemaVersion: 1, repository: 'reef-labs/paperboat', capabilities: [kind], maxRepairsPerLifecycle: 1, maxPushAttempts: 1 };
  let now = Date.parse('2026-09-16T12:00:00Z'), store = await RuntimeStore.open(directory), enabled = true, onToken = async () => {};
  const dependencies: DaemonDependencies = { directory, now: () => now, credentials: tokenCredentials('fictional-read-token'), profile: async () => s.profile,
    applyPolicy: async () => enabled ? policy : null, readOptions: { fetch: async (url, init) => {
      if (source && new URL(String(url)).pathname === '/graphql' && String(init?.body).includes('query WorkflowSource')) {
        const target = { oid: store.repository('R_paperboat').source!.observedRevision };
        return Response.json({ data: { repository: { id: 'R_paperboat', defaultBranchRef: { name: 'main', target }, ref: { name: 'main', target } } } });
      }
      return remote.fetch(url, init);
    } },
    publicationCredentials: async (repository, capability) => ({ repository, capability, permission: capability === 'review.publish' ? 'pull_requests:write' : 'issues:write',
      redact: value => value, token: async () => { await onToken(); return 'fictional-write-token'; } }),
    sources: async (_repo, inspection) => collectSources(s.repository, inspection.evidence.pullRequest!.headSha, inspection.evidence.pullRequest!.baseSha),
    execute: async job => { jobs.push(job); const result = completed(job); if (job.actionId === 'classify') (result.provider.payload as any).labels = [
      { name: 'tests', reason: 'The value needs a test.', evidence: [{ path: 'src/value.js', side: 'head', startLine: 1, endLine: 1, explanation: 'The value changes.' }] }]; return result; },
  };
  let service = new DaemonService(store, dependencies);
  let repo;
  if (source) {
    repo = store.registerSource({ id: 'R_paperboat', name: policy.repository, profile: s.profile.name, reviewers: [], workflowPath: pkg.workflowPath, branch: 'main', maximumCapabilities: s.profile.maximumCapabilities }, now);
    await store.activateSource(repo.id, 'a'.repeat(40), 'main', pkg, now);
    repo = store.repository(repo.id);
  } else repo = await service.register({ name: policy.repository, package: pkg, profile: s.profile.name, reviewers: [] });
  return { ...s, pkg, directory, repo, remote, policy, dependencies, jobs,
    get store() { return store; }, get service() { return service; }, get now() { return now; },
    advance: (ms = 61_000) => { now += ms; }, revoke: () => { enabled = false; }, restore: () => { enabled = true; }, onToken: (callback: () => Promise<void>) => { onToken = callback; },
    tick: async () => { await service.tick(); await service.idle(); },
    restart: async () => { await service.stop(); store.close(); store = await RuntimeStore.open(directory); service = new DaemonService(store, dependencies); },
    cleanup: async () => { await service.stop(); store.close(); await s.cleanup(); },
  };
}

test('daemon publication uses one accepted analysis and independent durable effect receipts with only its own capability', async () => {
  for (const kind of ['review.publish', 'labels.set'] as const) {
    const s = await fixture(kind);
    try {
      await s.tick(); await s.tick(); await s.tick();
      const run = s.store.runs()[0]!, details = s.store.inspect(run.id), effect = details.effects[0]!;
      assert.equal(effect.state, 'confirmed', run.reason); assert.equal(effect.kind, kind);
      assert.equal(details.effectAttempts.length, 1); assert.equal(details.effectAttempts[0]!.state, 'confirmed');
      assert.equal(details.reservations.length, 1); assert.equal(s.jobs.length, 1); assert.equal(s.remote.state.writes, 1);
      assert.equal((effect.receipt as PublicationReceipt).freshness, 'current');
      if (kind === 'labels.set') assert.deepEqual(s.remote.state.labels, ['human-choice', 'auth', 'tests']);
      await s.restart(); assert.equal(s.store.effects(run.id)[0]!.id, effect.id); assert.equal(s.store.run(run.id).nextAction, '$wait');
    } finally { await s.cleanup(); }
  }
});

test('analysis-only daemon stops before publication and never acquires write credentials', async () => {
  const s = await fixture();
  try {
    delete s.dependencies.applyPolicy;
    s.dependencies.publicationCredentials = async () => { assert.fail('Analysis mode must not acquire effect credentials.'); };
    await s.tick(); await s.tick();
    const run = s.store.runs()[0]!; assert.equal(run.status, 'blocked'); assert.match(run.reason, /Analysis mode stopped before github.publish_review/);
    assert.equal(s.jobs.length, 1); assert.equal(s.store.effects(run.id).length, 0); assert.equal(s.remote.state.writes, 0);
  } finally { await s.cleanup(); }
});

test('policy and provider permission revocation after credentials prevents the first publication write', async () => {
  for (const kind of ['review.publish', 'labels.set'] as const) for (const revoke of ['policy', 'profile'] as const) {
    const s = await fixture(kind);
    try {
      await s.tick(); s.onToken(async () => { if (revoke === 'policy') s.revoke(); else s.profile.maximumCapabilities = ['workspace.read']; });
      await s.tick(); const run = s.store.runs()[0]!, effect = s.store.effects(run.id)[0]!;
      assert.equal(effect.state, 'rejected', run.reason); assert.match((effect.receipt as PublicationReceipt).reason, /policy/i);
      assert.equal(s.remote.state.writes, 0); assert.equal(s.jobs.length, 1); assert.equal(s.store.inspect(run.id).notes.length, 1);
    } finally { await s.cleanup(); }
  }
});

test('restoring pre-send policy reuses the saved publication within its retained attempt bound', async () => {
  const s = await fixture();
  try {
    await s.tick(); s.onToken(async () => s.revoke()); await s.tick();
    const id = s.store.runs()[0]!.id, effect = s.store.effects(id)[0]!;
    assert.equal(effect.state, 'rejected'); assert.equal((effect.receipt as PublicationReceipt).retryable, true);
    s.advance(); await s.tick(); assert.equal(s.remote.state.writes, 0); assert.equal(s.store.inspect(id).effectAttempts.length, 1);
    s.restore(); s.onToken(async () => {}); s.store.retry(id, s.now); await s.tick();
    assert.equal(s.store.effects(id)[0]!.state, 'confirmed'); assert.equal(s.store.effects(id)[0]!.id, effect.id);
    assert.equal(s.remote.state.writes, 1); assert.equal(s.jobs.length, 1); assert.equal(s.store.inspect(id).effectAttempts.length, 2);
  } finally { await s.cleanup(); }
});

test('temporary evidence loss preserves pending publication through service waiting and restart', async () => {
  for (const planned of [false, true]) {
    const s = await fixture();
    try {
      await s.tick(); if (planned) { s.dependencies.planOnly = true; await s.tick(); }
      const id = s.store.runs()[0]!.id; s.remote.graph.access(false);
      await s.service.poll(s.store.repository(s.repo.id)); s.advance(); s.service.dispatch(); await s.service.idle();
      assert.equal(s.store.run(id).evidenceAvailable, false); assert.equal(s.store.run(id).nextAction, 'publish');
      assert.equal(s.store.run(id).control.memory?.reviewCurrent, false); assert.equal(s.remote.state.writes, 0);
      await s.restart(); s.remote.graph.access(true); s.dependencies.planOnly = false;
      await s.service.poll(s.store.repository(s.repo.id)); await s.tick();
      assert.equal(s.store.effects(id)[0]!.state, 'confirmed'); assert.equal(s.jobs.length, 1); assert.equal(s.store.inspect(id).reservations.length, 1);
      assert.equal(s.store.inspect(id).effectAttempts.length, 1); assert.equal(s.remote.state.writes, 1);
    } finally { await s.cleanup(); }
  }
});

test('non-diff findings are retained behind a durable publication rejection and failure continuation', async () => {
  const s = await fixture();
  try {
    const lines = Array.from({ length: 30 }, (_, i) => `export const value${i} = ${i};\n`);
    await writeFile(join(s.repository, 'src/value.js'), lines.join('')); git(s.repository, 'commit', '-qam', 'Expand source');
    s.inspection.evidence.pullRequest!.baseSha = git(s.repository, 'rev-parse', 'HEAD');
    lines[0] = 'export const value0 = 42;\n'; await writeFile(join(s.repository, 'src/value.js'), lines.join('')); git(s.repository, 'commit', '-qam', 'Change first line');
    s.inspection.evidence.pullRequest!.headSha = git(s.repository, 'rev-parse', 'HEAD');
    const execute = s.dependencies.execute!;
    s.dependencies.execute = async (...args) => {
      const value = await execute(...args); Object.assign(value.provider.payload as object, { verdict: 'concerns', findings: [1, 25].map(line => ({
        id: `finding-${line}`, kind: 'bug', severity: 'medium', confidence: 0.9, title: `Value on line ${line}`, reason: 'A caller needs this value.',
        evidence: [{ path: 'src/value.js', side: 'head', startLine: line, endLine: line, explanation: 'The value is used.' }],
      })) }); return value;
    };
    await s.tick(); await s.tick(); const id = s.store.runs()[0]!.id, effect = s.store.effects(id)[0]!;
    assert.equal(effect.state, 'rejected'); assert.match((effect.receipt as PublicationReceipt).reason, /outside the pinned diff/);
    assert.equal(s.store.run(id).nextAction, '$blocked'); assert.equal(s.store.inspect(id).effectAttempts.length, 0);
    await s.restart(); await s.tick();
    const saved = await s.store.currentAnalysis(id, 'agent.review'); assert.equal((saved.result.provider.payload as any).findings.length, 2);
    assert.equal(s.store.run(id).status, 'blocked'); assert.equal(s.jobs.length, 1); assert.equal(s.remote.state.writes, 0);
  } finally { await s.cleanup(); }
});

test('post-write head changes preserve remote acceptance and invalidate current analysis', async () => {
  for (const kind of ['review.publish', 'labels.set'] as const) {
    const s = await fixture(kind);
    try {
      const fetch = s.dependencies.readOptions!.fetch!;
      s.dependencies.readOptions!.fetch = async (url, init) => {
        const response = await fetch(url, init);
        if (init?.method === 'POST' && !String(url).endsWith('/graphql')) s.inspection.evidence.pullRequest!.headSha = 'e'.repeat(40);
        return response;
      };
      await s.tick(); await s.tick(); const run = s.store.runs()[0]!, receipt = s.store.effects(run.id)[0]!.receipt as PublicationReceipt;
      assert.equal(receipt.outcome, 'confirmed'); assert.equal(receipt.freshness, 'stale'); assert.equal(receipt.reobserve, true);
      assert.equal(run.control.memory?.reviewCurrent, false); assert.equal(run.control.memory?.classificationCurrent, false); assert.equal(run.evidenceAvailable, false);
      await s.restart(); assert.equal(s.store.effects(run.id)[0]!.state, 'confirmed'); assert.equal(s.jobs.length, 1); assert.equal(s.remote.state.writes, 1);
    } finally { await s.cleanup(); }
  }
});

test('cancellation and same-package migration fence an active publication lease without resending', async () => {
  for (const change of ['cancel', 'migrate'] as const) {
    const s = await fixture();
    try {
      await s.tick(); const run = s.store.runs()[0]!;
      s.onToken(async () => { if (change === 'cancel') s.store.cancel(run.id); else await s.store.migrate(run.id, run.workflowVersionId, s.now); });
      await s.tick(); assert.equal(s.store.effects(run.id)[0]!.state, 'unknown'); assert.equal(s.remote.state.writes, 0);
      await s.restart(); s.advance(); await s.tick();
      assert.equal(s.store.effects(run.id)[0]!.state, 'unknown'); assert.equal(s.remote.state.writes, 0); assert.equal(s.jobs.length, 1);
      assert.equal(s.store.inspect(run.id).effectAttempts.length, 1);
    } finally { await s.cleanup(); }
  }
});

test('final policy and profile awaits cannot outlive publication ownership', async () => {
  for (const kind of ['review.publish', 'labels.set'] as const) for (const boundary of ['policy', 'profile'] as const)
    for (const change of ['cancel', 'migrate', 'pause', 'expire'] as const) {
      const s = await fixture(kind); let release!: () => void;
      try {
        await s.tick(); const run = s.store.runs()[0]!; let arrived!: () => void, reads = 0;
        const ready = new Promise<void>(done => { arrived = done; }), hold = new Promise<void>(done => { release = done; });
        if (boundary === 'policy') s.dependencies.applyPolicy = async () => { if (++reads === 3) { arrived(); await hold; } return s.policy; };
        else s.dependencies.profile = async () => { if (++reads === 4) { arrived(); await hold; } return s.profile; };
        await s.service.tick(); await ready;
        if (change === 'cancel') s.store.cancel(run.id);
        else if (change === 'migrate') await s.store.migrate(run.id, run.workflowVersionId, s.now);
        else if (change === 'pause') s.store.pause(s.repo.id, true, s.now);
        else { s.advance(301_000); s.store.recover(s.now); }
        release(); await s.service.idle();
        assert.equal(s.remote.state.writes, 0, `${kind} ${boundary} ${change}`); assert.equal(s.jobs.length, 1);
        assert.notEqual(s.store.effects(run.id)[0]!.state, 'confirmed');
      } finally { release?.(); await s.cleanup(); }
    }
});

test('cancellation after remote acceptance keeps the uncertain send for read-only reconciliation', async () => {
  for (const kind of ['review.publish', 'labels.set'] as const) {
    const s = await fixture(kind);
    try {
      await s.tick(); const run = s.store.runs()[0]!, fetch = s.dependencies.readOptions!.fetch!;
      s.dependencies.readOptions!.fetch = async (url, init) => {
        const response = await fetch(url, init);
        if (init?.method === 'POST' && !String(url).endsWith('/graphql')) { s.store.cancel(run.id); throw new Error('Fictional lost response after cancellation.'); }
        return response;
      };
      await s.tick(); assert.equal(s.store.effects(run.id)[0]!.state, 'unknown'); assert.equal(s.remote.state.writes, 1);
      await s.restart(); s.advance(); await s.tick();
      assert.equal(s.store.run(run.id).status, 'cancelled'); assert.equal(s.store.effects(run.id)[0]!.state, 'confirmed');
      assert.equal(s.remote.state.writes, 1); assert.equal(s.jobs.length, 1); assert.equal(s.store.inspect(run.id).effectAttempts.length, 1);
    } finally { await s.cleanup(); }
  }
});

test('complete readback of accepted review and labels preserves one analysis and logical effect across restart', async () => {
  for (const kind of ['review.publish', 'labels.set'] as const) for (const lost of [false, true]) {
    const s = await fixture(kind);
    try {
      await s.tick(); const run = s.store.runs()[0]!; s.remote.state.loseResponse = lost; await s.tick();
      const first = s.store.effects(run.id)[0]!;
      await s.restart(); s.remote.state.loseResponse = false; s.advance(); await s.tick(); await s.tick(); await s.tick();
      const current = s.store.run(run.id), details = s.store.inspect(run.id), observed = await s.store.artifacts.get<any>(current.inspection);
      assert.equal(current.evidenceKey, run.evidenceKey); assert.notEqual(current.observationKey, current.evidenceKey);
      assert.equal(details.effects.length, 1); assert.equal(details.effects[0]!.id, first.id); assert.equal(details.effectAttempts.length, 1);
      assert.equal(details.reservations.length, 1); assert.equal(s.jobs.length, 1); assert.equal(s.remote.state.writes, 1);
      assert.equal(summarizePublications(current, details.effects)[0]!.freshness, 'current');
      assert.equal(summarizePublications(current, details.effects)[0]!.currentAnalysisAvailable, true);
      if (kind === 'review.publish') assert.equal(observed.evidence.reviews.items[0].id, (details.effects[0]!.receipt as PublicationReceipt).remote!.nodeId);
      else assert.deepEqual(observed.evidence.labels.items.map((label: any) => label.name), ['human-choice', 'auth', 'tests']);
    } finally { await s.cleanup(); }
  }
});

test('confirmed own publications never conceal concurrent human evidence or changed revisions', async () => {
  for (const kind of ['review.publish', 'labels.set'] as const) for (const change of ['body', 'head', 'base', 'review', 'label', 'removed-label', 'edited-review', 'copied-review'] as const) {
    if (kind === 'labels.set' && ['edited-review', 'copied-review'].includes(change)) continue;
    const s = await fixture(kind);
    try {
      await s.tick(); const run = s.store.runs()[0]!; await s.tick();
      if (change === 'body') s.inspection.evidence.pullRequest!.body += '\nHuman context.';
      else if (change === 'head') s.inspection.evidence.pullRequest!.headSha = 'e'.repeat(40);
      else if (change === 'base') s.inspection.evidence.pullRequest!.baseSha = 'f'.repeat(40);
      else if (change === 'review') s.inspection.evidence.reviews.items.push({ id: 'PRR_human', author: 'river', state: 'COMMENTED', body: 'Please check this caller.', headSha: run.headSha, submittedAt: '2026-09-16T12:00:01Z' });
      else if (change === 'label') s.remote.state.labels.push('human-followup');
      else if (change === 'removed-label') s.remote.state.labels = s.remote.state.labels.filter(name => name !== 'auth');
      else if (change === 'edited-review') s.remote.state.reviews[0]!.body += '\nHuman edit.';
      else s.remote.state.reviews.push({ ...s.remote.state.reviews[0]!, id: 99, node_id: 'PRR_human_copy' });
      await s.service.poll(s.store.repository(s.repo.id)); const changed = s.store.run(run.id);
      assert.notEqual(changed.evidenceKey, run.evidenceKey, `${kind} ${change}`);
      assert.equal(changed.control.memory?.reviewCurrent, false); assert.equal(changed.control.memory?.classificationCurrent, false);
      assert.equal(summarizePublications(changed, s.store.effects(run.id))[0]!.freshness, 'stale');
      assert.equal(s.jobs.length, 1); assert.equal(s.remote.state.writes, 1);
    } finally { await s.cleanup(); }
  }
});

test('a review then classification publication chain survives polling both accepted outputs', async () => {
  const s = await fixture('review.publish', false, base => {
    const workflow = structuredClone(base.workflow), review = workflow.actions.review!, classify = workflow.actions.classify!;
    review.onSuccess = 'publish_review'; classify.onSuccess = 'publish_labels'; review.onFailure = '$blocked'; classify.onFailure = '$blocked';
    workflow.actions = { review, classify, publish_review: { uses: 'github.publish_review', execution: 'code', capabilities: ['review.publish'], onSuccess: 'classify', onFailure: '$blocked' },
      publish_labels: { uses: 'github.set_labels', execution: 'code', capabilities: ['labels.set'], onSuccess: '$wait', onFailure: '$blocked' } };
    workflow.rules = [{ id: 'analyze', when: { field: 'facts.lifecycle', op: 'eq', value: 'open' }, action: 'review' }]; workflow.otherwise = 'review';
    workflow.requestedCapabilities = ['workspace.read', 'review.publish', 'labels.set']; workflow.settings.newPrDelaySeconds = 0; workflow.settings.headDebounceSeconds = 0;
    return buildPackage(base.workflowPath, { ...Object.fromEntries(base.files.map(file => [file.path, file.text])), [base.workflowPath]: JSON.stringify(workflow) });
  });
  try {
    s.policy.capabilities.push('labels.set'); await s.tick(); await s.tick();
    const id = s.store.runs()[0]!.id; s.advance(); await s.tick(); await s.tick(); await s.tick();
    s.advance(); await s.tick(); await s.tick();
    const run = s.store.run(id), details = s.store.inspect(id);
    assert.deepEqual(s.jobs.map(job => job.actionId), ['review', 'classify']); assert.equal(details.reservations.length, 2);
    assert.equal(details.effects.length, 2); assert.equal(details.effectAttempts.length, 2); assert.equal(s.remote.state.writes, 2);
    assert.ok(details.effects.every(effect => effect.state === 'confirmed')); assert.ok(summarizePublications(run, details.effects).every(value => value.freshness === 'current'));
    assert.equal(run.control.memory?.reviewCurrent, true); assert.equal(run.control.memory?.classificationCurrent, true);
    assert.equal((await s.store.currentAnalysis(id, 'agent.review')).result.job.evidenceKey, run.evidenceKey);
    const accepted = (await s.store.currentAnalysis(id, 'agent.classify')).result;
    const inspection = await s.store.artifacts.get<any>(accepted.job.inspection), sources = await s.store.artifacts.get<any>(accepted.job.sources);
    assert.equal(accepted.job.evidenceKey, run.evidenceKey); assert.equal(inspection.evidence.reviews.items.length, 1);
    assert.notEqual(accepted.job.evidenceKey, digest(canonicalJson({ head: run.headSha, base: run.baseSha, evidence: inspection.evidenceDigest })));
    const input = { run, result: accepted, package: s.pkg, inspection, sources };
    assert.equal(prepareLabelPublication(input).kind, 'labels.set');
    const changed = structuredClone(inspection); changed.evidence.pullRequest.body += '\nUnaccepted input.'; changed.evidenceDigest = digest(canonicalJson(changed.evidence));
    assert.throws(() => prepareLabelPublication({ ...input, inspection: changed }), /pinned workflow, observation, and source/);
  } finally { await s.cleanup(); }
});

test('independent publication lease remains current after the analysis claim is parked', async () => {
  const s = await fixture();
  let release!: () => void, arrived!: () => void;
  const ready = new Promise<void>(done => { arrived = done; }), hold = new Promise<void>(done => { release = done; });
  try {
    await s.tick(); s.onToken(async () => { arrived(); await hold; });
    await s.service.tick(); await ready;
    const run = s.store.runs()[0]!; assert.equal(s.store.effects(run.id)[0]!.state, 'sending');
    s.store.recover(s.now); assert.equal(s.store.effects(run.id)[0]!.state, 'sending');
    s.service.abortStale(); release(); await s.service.idle();
    assert.equal(s.store.effects(run.id)[0]!.state, 'confirmed'); assert.equal(s.remote.state.writes, 1);
  } finally { release?.(); await s.cleanup(); }
});

test('current evidence changes after credential retrieval reject publication and invalidate analysis', async () => {
  for (const changed of ['head', 'body'] as const) {
    const s = await fixture();
    try {
      await s.tick(); s.onToken(async () => { if (changed === 'head') s.inspection.evidence.pullRequest!.headSha = 'e'.repeat(40); else s.inspection.evidence.pullRequest!.body = 'New review context.'; });
      await s.tick(); const run = s.store.runs()[0]!, effect = s.store.effects(run.id)[0]!;
      assert.equal(effect.state, 'rejected'); assert.equal((effect.receipt as PublicationReceipt).freshness, 'stale');
      assert.equal(run.control.memory?.reviewCurrent, false); assert.equal(run.evidenceAvailable, false);
      assert.equal(s.remote.state.writes, 0); assert.equal(s.store.inspect(run.id).notes.length, 1);
    } finally { await s.cleanup(); }
  }
});

test('restart reconciles an accepted publication without another provider call or send', async () => {
  const s = await fixture();
  try {
    await s.tick(); s.remote.state.loseResponse = true; await s.tick();
    const run = s.store.runs()[0]!, effect = s.store.effects(run.id)[0]!;
    assert.equal(effect.state, 'unknown'); assert.equal(s.remote.state.writes, 1);
    s.remote.graph.access(false); await s.service.poll(s.store.repository(s.repo.id));
    assert.equal(s.store.run(run.id).nextAction, 'publish'); assert.equal(s.store.run(run.id).evidenceAvailable, false);
    await s.restart(); s.remote.graph.access(true); s.remote.state.loseResponse = false; s.advance(); await s.tick();
    assert.equal(s.store.effects(run.id)[0]!.id, effect.id); assert.equal(s.store.effects(run.id)[0]!.state, 'confirmed');
    assert.equal(s.remote.state.writes, 1); assert.equal(s.jobs.length, 1); assert.equal(s.store.inspect(run.id).effectAttempts.length, 1);
  } finally { await s.cleanup(); }
});

test('unknown publication without proof remains blocked across polls and restarts', async () => {
  const s = await fixture();
  try {
    s.remote.state.accept = false; s.remote.state.loseResponse = true; await s.tick(); await s.tick();
    const run = s.store.runs()[0]!; await s.restart(); s.advance(); await s.tick(); await s.tick();
    assert.equal(s.store.effects(run.id)[0]!.state, 'unknown'); assert.equal(s.jobs.length, 1); assert.equal(s.remote.state.writes, 1);
    assert.equal(s.store.run(run.id).control.memory?.reviewCurrent, true);
  } finally { await s.cleanup(); }
});

test('confirmed publication with unreadable current head recovers freshness using reads only', async () => {
  const s = await fixture();
  try {
    s.remote.state.failAfterWrite = true; await s.tick(); await s.tick();
    const run = s.store.runs()[0]!, effect = s.store.effects(run.id)[0]!;
    assert.equal(effect.state, 'confirmed'); assert.equal((effect.receipt as PublicationReceipt).freshness, 'unverified');
    await s.restart(); s.remote.state.failAfterWrite = false; s.advance(); await s.tick();
    const refreshed = s.store.effects(run.id)[0]!; assert.equal(refreshed.state, 'confirmed'); assert.equal((refreshed.receipt as PublicationReceipt).freshness, 'current');
    assert.equal(s.jobs.length, 1); assert.equal(s.remote.state.writes, 1); assert.equal(s.store.inspect(run.id).effectAttempts.length, 1);
    assert.equal((s.store.inspect(run.id).effectAttempts[0]!.receipt as PublicationReceipt).freshness, 'unverified');
  } finally { await s.cleanup(); }
});

test('actual prompt-only migration invalidates analysis and retains the same publication and send receipt', async () => {
  const s = await fixture('review.publish', true);
  try {
    await s.tick(); await s.tick(); await s.tick();
    const run = s.store.runs()[0]!, first = s.store.effects(run.id)[0]!, files = Object.fromEntries(s.pkg.files.map(file => [file.path, file.text]));
    files['docs/pr-workflows/examples/team-pr/prompts/review.md'] += '\nKeep findings specific.\n';
    const changed = buildPackage(s.pkg.workflowPath, files);
    await s.store.activateSource(s.repo.id, 'b'.repeat(40), 'main', changed, s.now);
    await s.store.migrate(run.id, s.store.repository(s.repo.id).activeVersionId!, s.now);
    assert.equal(s.store.run(run.id).control.memory?.reviewCurrent, false);
    await s.restart(); s.advance(); await s.tick(); await s.tick();
    const effects = s.store.effects(run.id); assert.equal(s.jobs.length, 2); assert.equal(effects.length, 1);
    assert.equal(effects[0]!.id, first.id); assert.equal(effects[0]!.state, 'confirmed'); assert.equal(s.remote.state.writes, 1);
    assert.equal(s.store.inspect(run.id).effectAttempts.length, 1); assert.equal(s.store.inspect(run.id).migrations.length, 1);
  } finally { await s.cleanup(); }
});

for (const kind of ['review.publish', 'labels.set'] as const) test(`built CLI plans ${kind}, inspects offline, and reconciles SIGKILL after acceptance`, async () => {
  const s = await setup(), pkg = publicationWorkflow(s.pkg, kind, '$wait'), workflowRoot = join(s.temporary, 'workflow'), state = join(s.temporary, 'local-state');
  const policyPath = join(s.temporary, 'apply.json'), fixturePath = join(s.temporary, 'publication-fixture.json'), remoteState = join(s.temporary, 'remote-state.json'), requests = join(s.temporary, 'requests.jsonl');
  for (const file of pkg.files) { const path = join(workflowRoot, file.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.text); }
  await writeFile(policyPath, JSON.stringify({ schemaVersion: 1, repository: 'reef-labs/paperboat', capabilities: [kind], maxRepairsPerLifecycle: 1, maxPushAttempts: 1 }), { mode: 0o600 });
  await writeFile(remoteState, JSON.stringify(publicationState()));
  const mode = (value?: string) => writeFile(fixturePath, JSON.stringify({ inspection: s.inspection, remote: s.repository, state: remoteState, requests, mode: value }), { mode: 0o600 });
  const args = ['apply', join(workflowRoot, pkg.workflowPath), '--repo-root', workflowRoot, '--repo', 'reef-labs/paperboat', '--pr', '42', '--state-dir', state,
    '--policy', policyPath, '--provider-config', s.settings, '--profile', 'pilot'];
  const invoke = (command: string[], token = 'fictional-local-token') => {
    const result = spawnSync(process.execPath, ['--import', resolve('tests/helpers/publication-cli-preload.ts'), resolve('apps/cli/dist/cli.js'), ...command], {
      env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: '', REPO_CHAP_PUBLICATION_FIXTURE: fixturePath }, encoding: 'utf8', timeout: 30_000,
    });
    return { ...result, value: result.stdout?.startsWith('{') ? JSON.parse(result.stdout) : null };
  };
  const providerCalls = async () => (await readFile(s.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]).filter(argv => argv.includes('exec') && !argv.includes('--help')).length;
  try {
    await mode(); const planned = invoke([...args, '--plan', '--json']); assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    const id = planned.value.run.id, effectId = planned.value.effects[0].id;
    assert.equal(planned.value.effects[0].state, 'planned'); assert.equal(planned.value.effectAttempts.length, 0); assert.equal(await providerCalls(), 1);
    assert.equal(JSON.parse(await readFile(remoteState, 'utf8')).writes, 0);
    const before = await readFile(requests, 'utf8'); await mode('offline');
    const inspected = invoke(['apply', 'inspect', id, '--state-dir', state, '--json'], ''); assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
    assert.equal(inspected.value.effects[0].id, effectId); assert.equal(await readFile(requests, 'utf8'), before);
    if (kind === 'review.publish') {
      await mode(); const store = await RuntimeStore.open(state), saved = await store.currentAnalysis(id, 'agent.review'); store.close();
      const path = join(state, 'artifacts', saved.result.job.sources.id), bytes = await readFile(path);
      await writeFile(path, '{}', { mode: 0o600 });
      const failed = invoke([...args, '--json']); assert.equal(failed.status, 8, failed.stderr || failed.stdout);
      assert.equal(failed.value.run.status, 'waiting'); assert.ok(failed.value.effects.some((effect: any) => effect.state === 'rejected'));
      assert.equal(failed.value.effectAttempts.length, 0); assert.equal(failed.value.results.length, 1); assert.equal(await providerCalls(), 1);
      await writeFile(path, bytes, { mode: 0o600 });
    }
    await mode('crash'); const crashed = invoke([...args, ...(kind === 'review.publish' ? ['--retry'] : []), '--json']); assert.equal(crashed.signal, 'SIGKILL', crashed.stderr || crashed.stdout);
    assert.equal(JSON.parse(await readFile(remoteState, 'utf8')).writes, 1); assert.equal(await providerCalls(), 1);
    await mode(); const recovered = invoke(['apply', 'reconcile', id, '--state-dir', state, '--json']); assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    assert.equal(recovered.value.effects[0].id, effectId); assert.equal(recovered.value.effects[0].state, 'confirmed');
    assert.equal(recovered.value.effects[0].receipt.freshness, 'current'); assert.equal(recovered.value.effectAttempts.length, 1); assert.equal(await providerCalls(), 1);
    const printed = invoke(['apply', 'inspect', id, '--state-dir', state]); assert.equal(printed.status, 0, printed.stderr || printed.stdout);
    assert.ok(printed.stdout.includes(`confirmed, current. ${kind}`));
    if (kind === 'review.publish') assert.match(printed.stdout, /pullrequestreview-1/);
    else assert.ok(recovered.value.effects[0].receipt.labels.preserved.includes('human-choice'));
  } finally { await s.cleanup(); }
});
