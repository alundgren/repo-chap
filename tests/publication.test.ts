import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { buildPackage, canonicalJson, digest, replay, type Workflow } from '@repo-chap/workflow';
import { collectSources, type SourceBundle } from '@repo-chap/providers';
import { GitHubPublicationClient, PublicationRemoteError, publishReview, setClassificationLabels, tokenCredentials, installationCredentials, installationPublicationCredentials,
  type LabelPublication, type PublicationDispatch, type PublicationRemote, type PublishedReview, type RemotePublicationTarget, type ReviewPublication } from '@repo-chap/github';
import { prepareLabelPublication, prepareReviewPublication, summarizePublications, RuntimeStore, type AnalysisResult, type PublicationInput, type EffectRecord } from '@repo-chap/runtime';
import { setup, git } from './helpers/provider-fixture.ts';
import { publicationRemote } from './helpers/publication-remote.ts';

const citation = (side = 'head', startLine = 1, path = 'src/value.js') => ({ path, side, startLine, endLine: startLine, explanation: 'The exported value changes here.' });
const finding = (evidence = [citation()]) => ({ id: 'value', kind: 'bug', severity: 'medium', confidence: 0.9, title: 'Check the changed value', reason: 'The caller expects the previous value.', evidence });
async function fixture(kind: 'review' | 'classification' = 'review', options: {
  payload?: (value: any) => void; sources?: (value: SourceBundle) => void;
  source?: (repository: string) => Promise<{ head: string; base: string }>;
  workflow?: (value: Workflow) => void;
} = {}) {
  const s = await setup();
  let pkg = s.pkg, inspection = structuredClone(s.inspection);
  if (options.workflow) {
    const workflow = structuredClone(pkg.workflow); options.workflow(workflow);
    pkg = buildPackage(pkg.workflowPath, { ...Object.fromEntries(pkg.files.map(file => [file.path, file.text])), [pkg.workflowPath]: JSON.stringify(workflow) });
  }
  const revisions = await options.source?.(s.repository) ?? { head: s.head, base: s.base };
  inspection.packageDigest = pkg.digest;
  Object.assign(inspection.evidence.pullRequest!, { headSha: revisions.head, baseSha: revisions.base });
  Object.assign(inspection.evidence.revision, { headSha: revisions.head, baseSha: revisions.base });
  inspection.evidenceDigest = digest(canonicalJson(inspection.evidence));
  Object.assign(inspection.fixture.observations[0]!, { headSha: revisions.head, baseSha: revisions.base, evidenceDigest: inspection.evidenceDigest });
  const sources = await collectSources(s.repository, revisions.head, revisions.base);
  if (options.sources) { options.sources(sources); const { digest: _digest, ...body } = sources; sources.digest = digest(canonicalJson(body)); }
  const directory = join(s.temporary, 'publication-state'); let store = await RuntimeStore.open(directory);
  const now = Date.now(), repo = await store.register({ id: 'R_paperboat', name: 'reef-labs/paperboat', package: pkg, profile: 'pilot', reviewers: [] }, now);
  const run = (await store.observe(repo.id, inspection, now))!;
  const claim = store.claim(run.id, 'analysis-worker', now, 300)!;
  const actionId = kind === 'review' ? 'review' : 'classify';
  const job = store.reserve(claim, { actionId, sources: await store.artifacts.put(sources), profile: 'pilot', profileDigest: digest('fictional-profile'), package: pkg }, now);
  const payload: any = kind === 'review' ? { schemaVersion: 1, headSha: revisions.head, baseSha: revisions.base, summary: 'Review the value change.',
    verdict: 'concerns', coverage: 'complete', missingEvidence: [], findings: [finding()] } : {
    schemaVersion: 1, headSha: revisions.head, labels: [{ name: 'tests', reason: 'The value needs a regression test.', evidence: [citation()] }], uncertain: false };
  options.payload?.(payload);
  const result: AnalysisResult = { schemaVersion: 1, job, provider: { schemaVersion: 1, provider: 'codex', providerVersion: 'fictional', profile: 'pilot', providerDigest: null,
    inputDigest: job.evidenceKey, outcome: 'completed', diagnostic: 'Validated fictional analysis.', payload, attempts: [] } };
  await store.complete(claim, result, now + 1);
  const input: PublicationInput = { run: store.run(run.id), result, package: pkg, inspection, sources };
  return { ...s, ...revisions, pkg, inspection, input, now, get store() { return store; },
    reopen: async () => { store.close(); store = await RuntimeStore.open(directory); },
    cleanup: async () => { store.close(); await s.cleanup(); } };
}
function fakeRemote(publication: ReviewPublication | LabelPublication) {
  const state = { target: { ...publication.target, lifecycle: 'open', draft: false } as RemotePublicationTarget, labels: ['human-choice', 'auth'],
    reviews: [] as PublishedReview[], writes: 0, reads: 0, loseResponse: false, changeAfterSend: false, readFailure: false };
  const remote: PublicationRemote = {
    target: async () => { state.reads++; if (state.readFailure) throw new Error('unavailable'); return structuredClone(state.target); },
    labels: async () => [...state.labels], reviews: async () => structuredClone(state.reviews),
    publishReview: async (plan, beforeSend) => {
      if (!await beforeSend(() => remote.target(plan.target))) throw new PublicationRemoteError('rejected', 'Not authorized.');
      state.writes++;
      const result: PublishedReview = { id: 'review-1', url: `https://github.com/${plan.target.repository}/pull/${plan.target.number}#pullrequestreview-1`, headSha: plan.target.headSha, state: 'COMMENTED', body: plan.body };
      state.reviews.push(result);
      if (state.changeAfterSend) state.target.headSha = 'e'.repeat(40);
      if (state.loseResponse) throw new Error('response lost');
      return result;
    },
    addLabels: async (_target, labels, beforeSend) => {
      if (!await beforeSend(() => remote.target(_target))) throw new PublicationRemoteError('rejected', 'Not authorized.');
      state.writes++; state.labels = [...new Set([...state.labels, ...labels])];
      if (state.changeAfterSend) state.target.headSha = 'e'.repeat(40);
      if (state.loseResponse) throw new Error('response lost');
      return [...state.labels];
    },
  };
  return { state, remote };
}
const permitted = (phase: PublicationDispatch['phase'] = 'planned'): PublicationDispatch => ({ phase, authorize: async () => true, beforeSend: async () => true });

test('current publication summaries distinguish historical receipt freshness from later observations', async () => {
  const s = await fixture();
  try {
    const plan = prepareReviewPublication(s.input), receipt = await publishReview(plan, fakeRemote(plan).remote, permitted());
    const effect: EffectRecord = { id: 'effect', runId: s.input.run.id, token: 1, state: 'confirmed', kind: plan.kind, destination: plan.target.repository,
      expectedRevision: s.head, evidenceKey: s.input.run.evidenceKey, payload: await s.store.artifacts.put(plan), receipt };
    const run = s.store.run(s.input.run.id);
    assert.equal(summarizePublications(run, [effect])[0]!.freshness, 'current');
    const unavailable = summarizePublications({ ...run, evidenceAvailable: false }, [effect])[0]!;
    assert.equal(unavailable.freshness, 'unverified'); assert.equal(unavailable.currentAnalysisAvailable, false); assert.equal(unavailable.receipt!.freshness, 'current');
    const changed = summarizePublications({ ...run, headSha: 'e'.repeat(40), evidenceKey: digest('new evidence') }, [effect])[0]!;
    assert.equal(changed.state, 'confirmed'); assert.equal(changed.freshness, 'stale'); assert.equal(changed.receipt!.freshness, 'current');
    const invalidated = summarizePublications({ ...run, control: { memory: { reviewCurrent: false } } }, [effect])[0]!;
    assert.equal(invalidated.currentAnalysisAvailable, false); assert.equal(invalidated.state, 'confirmed');
  } finally { await s.cleanup(); }
});

test('App publication credentials narrow the repository and validate the actual review or label write permission', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const requests: any[] = []; let allow = true;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request);
    return Response.json({ token: 'fictional-installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: allow ? request.permissions : {} });
  };
  const options = { appId: 'fixture', installationId: 7, privateKey, fetch };
  await installationCredentials(options).token();
  assert.ok(Object.values(requests[0].permissions).every(value => value === 'read'));
  for (const capability of ['review.publish', 'labels.set'] as const) {
    const credentials = installationPublicationCredentials(options, 'reef-labs/paperboat', capability); await credentials.token();
    const request = requests.at(-1)!;
    assert.deepEqual(request.repositories, ['paperboat']); assert.equal(request.permissions[capability === 'review.publish' ? 'pull_requests' : 'issues'], 'write');
    assert.equal(request.permissions.contents, 'read');
    allow = false; await assert.rejects(installationPublicationCredentials(options, 'reef-labs/paperboat', capability).token()); allow = true;
  }
});

test('publication final target read uses the acquired write credential and never falls back to inspection authority', async () => {
  const s = await fixture();
  try {
    const publication = prepareReviewPublication(s.input); let writes = 0, finalReads = 0;
    const client = new GitHubPublicationClient(tokenCredentials('fictional-read-token'), {
      writeCredentials: async (repository, capability) => ({ ...tokenCredentials('fictional-write-token'), repository, capability, permission: 'pull_requests:write' }),
      fetch: async (_url, init) => {
        assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer fictional-write-token');
        if (init?.method === 'GET') {
          finalReads++; return Response.json({ node_id: publication.target.pullRequestId, number: 42, state: 'open', draft: false, head: { sha: s.head },
            base: { sha: s.base, repo: { node_id: publication.target.repositoryId, full_name: publication.target.repository } } });
        }
        writes++; return Response.json({ id: 1, html_url: 'https://github.com/reef-labs/paperboat/pull/42#pullrequestreview-1', commit_id: s.head, body: publication.body, state: 'COMMENTED' });
      },
    });
    await client.publishReview(publication, async readTarget => { assert.equal((await readTarget()).headSha, s.head); return true; });
    assert.equal(finalReads, 1); assert.equal(writes, 1);
  } finally { await s.cleanup(); }
});

test('REST publication refuses missing, wrong-repository and wrong-operation write credentials', async () => {
  const s = await fixture();
  try {
    const plan = prepareReviewPublication(s.input);
    for (const mode of ['missing', 'repository', 'permission'] as const) {
      const client = new GitHubPublicationClient(tokenCredentials('fictional-read-token'), {
        ...(mode === 'missing' ? {} : { writeCredentials: async () => ({ ...tokenCredentials('fictional-token'), repository: mode === 'repository' ? 'reef-labs/other' : plan.target.repository,
          capability: 'review.publish' as const, permission: mode === 'permission' ? 'issues:write' as const : 'pull_requests:write' as const }) }),
        fetch: async () => { assert.fail('Invalid scope must not send a request.'); },
      });
      await assert.rejects(client.publishReview(plan, async () => { assert.fail('Invalid scope must not enter the final send check.'); }),
        (error: unknown) => error instanceof PublicationRemoteError && error.outcome === 'rejected');
    }
  } finally { await s.cleanup(); }
});

test('publication renders every finding and uses the pinned common ancestor for base citations', async () => {
  const s = await fixture('review', { payload: payload => { payload.findings[0].evidence.push(citation('base')); }, source: async repository => {
    const head = git(repository, 'rev-parse', 'HEAD'), ancestor = git(repository, 'rev-parse', 'HEAD^');
    git(repository, 'checkout', '-qb', 'advanced-target', ancestor);
    await writeFile(join(repository, 'readme.md'), 'Unrelated target-branch change.\n');
    git(repository, 'add', '.'); git(repository, 'commit', '-qm', 'Advance target');
    return { head, base: git(repository, 'rev-parse', 'HEAD') };
  } });
  try {
    const plan = prepareReviewPublication(s.input);
    assert.notEqual(s.input.sources.comparisonBaseSha, s.base);
    assert.ok(plan.body.includes(`/blob/${s.head}/src/value.js#L1`));
    assert.ok(plan.body.includes(`/blob/${s.input.sources.comparisonBaseSha}/src/value.js#L1`));
    assert.ok(!plan.body.includes(`/blob/${s.base}/`)); assert.match(plan.body, /Check the changed value/);
    assert.equal(plan.analysis.verdict, 'concerns'); assert.equal(plan.body.split(plan.marker).length, 2);
  } finally { await s.cleanup(); }
});

test('source omissions publish as partial and inconclusive, and contradictory clean output is rejected', async () => {
  const s = await fixture('review', { sources: source => { source.missingEvidence.push('Binary content is unavailable.'); }, payload: payload => {
    payload.coverage = 'partial'; payload.verdict = 'inconclusive'; payload.missingEvidence = ['Binary content is unavailable.'];
  } });
  try {
    const plan = prepareReviewPublication(s.input); assert.match(plan.body, /Evidence: partial\. Verdict: inconclusive/);
    assert.deepEqual(plan.analysis.missingEvidence, ['Binary content is unavailable.']); assert.match(plan.body, /Check the changed value/);
    const changed = structuredClone(s.input); Object.assign(changed.result.provider.payload as object, { coverage: 'complete', verdict: 'acceptable', missingEvidence: [], findings: [] });
    assert.throws(() => prepareReviewPublication(changed), /contradicts/);
  } finally { await s.cleanup(); }
});

test('non-diff source context rejects the whole publication and preserves all local findings', async () => {
  const s = await fixture('review', { source: async repository => {
    const lines = Array.from({ length: 30 }, (_, index) => `export const value${index} = ${index};\n`);
    await writeFile(join(repository, 'src/value.js'), lines.join('')); git(repository, 'commit', '-qam', 'Expand source');
    const base = git(repository, 'rev-parse', 'HEAD'); lines[0] = 'export const value0 = 42;\n';
    await writeFile(join(repository, 'src/value.js'), lines.join('')); git(repository, 'commit', '-qam', 'Change first line');
    return { base, head: git(repository, 'rev-parse', 'HEAD') };
  }, payload: payload => { payload.findings.push({ ...finding([citation('head', 25)]), id: 'context' }); } });
  try {
    const before = canonicalJson(s.input.result.provider.payload);
    assert.throws(() => prepareReviewPublication(s.input), /outside the pinned diff/);
    assert.equal(canonicalJson(s.input.result.provider.payload), before);
    assert.equal((s.input.result.provider.payload as any).findings.length, 2);
  } finally { await s.cleanup(); }
});

test('publication rejects changed heads, stale readiness, changed artifacts and provider failures', async () => {
  const s = await fixture();
  try {
    for (const change of [
      (input: PublicationInput) => { input.run.headSha = 'a'.repeat(40); },
      (input: PublicationInput) => { input.run.control.memory!.reviewCurrent = false; },
      (input: PublicationInput) => { input.sources.files[0]!.text = 'Changed after validation.\n'; },
      (input: PublicationInput) => { input.result.provider.outcome = 'invalid_output'; },
      (input: PublicationInput) => { input.result.job.packageDigest = digest('different package'); },
    ]) { const input = structuredClone(s.input); change(input); assert.throws(() => prepareReviewPublication(input)); }
  } finally { await s.cleanup(); }
});

test('configured label validation rejects unauthorized names and uncertain classification', async () => {
  const s = await fixture('classification', { workflow: workflow => { workflow.labels = ['tests']; } });
  try {
    assert.deepEqual(prepareLabelPublication(s.input).labels, ['tests']);
    const wrong = structuredClone(s.input); (wrong.result.provider.payload as any).labels[0].name = 'auth';
    assert.throws(() => prepareLabelPublication(wrong), /pinned workflow/);
    const uncertain = structuredClone(s.input); (uncertain.result.provider.payload as any).uncertain = true;
    assert.throws(() => prepareLabelPublication(uncertain), /Uncertain classification/);
    const invalid = structuredClone(s.input); (invalid.result.provider.payload as any).labels[0].evidence[0].endLine = 100;
    assert.throws(() => prepareLabelPublication(invalid), /citation/);
  } finally { await s.cleanup(); }
});

test('additive labels preserve human choices and previous configured categories, including empty classifications', async () => {
  const s = await fixture('classification');
  try {
    const plan = prepareLabelPublication(s.input), fake = fakeRemote(plan);
    const receipt = await setClassificationLabels(plan, fake.remote, permitted());
    assert.equal(receipt.outcome, 'confirmed'); assert.deepEqual(fake.state.labels, ['human-choice', 'auth', 'tests']);
    assert.deepEqual(receipt.labels?.preserved, ['human-choice', 'auth']);
    const empty = structuredClone(s.input); (empty.result.provider.payload as any).labels = [];
    const noLabels = await setClassificationLabels(prepareLabelPublication(empty), fake.remote, permitted());
    assert.equal(noLabels.outcome, 'confirmed'); assert.match(noLabels.reason, /no labels/); assert.equal(fake.state.writes, 1);
    assert.deepEqual(noLabels.labels?.preserved, ['human-choice', 'auth', 'tests']);
  } finally { await s.cleanup(); }
});

test('read-only or denied capabilities perform no remote writes', async () => {
  for (const kind of ['review', 'classification'] as const) {
    const s = await fixture(kind);
    try {
      const plan = kind === 'review' ? prepareReviewPublication(s.input) : prepareLabelPublication(s.input), fake = fakeRemote(plan);
      const dispatch: PublicationDispatch = { phase: 'planned', authorize: async capability => { assert.equal(capability, plan.kind); return false; }, beforeSend: async () => { assert.fail('Denied dispatch must not enter sending'); } };
      const receipt = plan.kind === 'review.publish' ? await publishReview(plan, fake.remote, dispatch) : await setClassificationLabels(plan, fake.remote, dispatch);
      assert.equal(receipt.outcome, 'rejected'); assert.equal(fake.state.writes, 0); assert.match(receipt.reason, /Apply policy/);
    } finally { await s.cleanup(); }
  }
});

test('changed heads before and after publication remain visibly stale', async () => {
  const s = await fixture();
  try {
    const plan = prepareReviewPublication(s.input), before = fakeRemote(plan); before.state.target.headSha = 'd'.repeat(40);
    const blocked = await publishReview(plan, before.remote, permitted());
    assert.equal(blocked.outcome, 'rejected'); assert.equal(blocked.freshness, 'stale'); assert.equal(before.state.writes, 0);
    const after = fakeRemote(plan); after.state.changeAfterSend = true;
    const sent = await publishReview(plan, after.remote, permitted());
    assert.equal(sent.outcome, 'confirmed'); assert.equal(sent.freshness, 'stale'); assert.equal(sent.reobserve, true);
    assert.equal(after.state.reviews[0]!.headSha, s.head); assert.equal(sent.analysis?.verdict, 'concerns');
  } finally { await s.cleanup(); }
});

test('crash after remote review acceptance reconciles a marked review from a durable unknown effect', async () => {
  const s = await fixture();
  try {
    const plan = prepareReviewPublication(s.input), fake = fakeRemote(plan); fake.state.loseResponse = true;
    const claim = s.store.claim(s.input.run.id, 'publisher', s.now + 2, 1)!;
    const id = s.store.planEffect(claim, { kind: plan.kind, destination: plan.target.pullRequestId, evidenceKey: claim.evidenceKey, expectedRevision: plan.target.headSha, payload: await s.store.artifacts.put(plan) }, s.now + 2);
    const result = await publishReview(plan, fake.remote, { ...permitted(), beforeSend: async () => s.store.transitionEffect(claim, id, 'planned', 'sending', null, s.now + 2) });
    assert.equal(result.outcome, 'unknown');
    await s.reopen(); s.store.recover(s.now + 1003);
    const effect = s.store.effects(s.input.run.id)[0]!; assert.equal(effect.state, 'unknown');
    const saved = await s.store.artifacts.get<ReviewPublication>(effect.payload);
    const reconciled = await publishReview(saved, fake.remote, permitted('unknown'));
    assert.equal(reconciled.outcome, 'confirmed'); assert.equal(reconciled.remote?.id, 'review-1'); assert.equal(fake.state.writes, 1);
    const next = s.store.claim(s.input.run.id, 'reconciler', s.now + 1004, 10)!;
    assert.equal(s.store.transitionEffect(next, id, 'unknown', 'confirmed', reconciled, s.now + 1004), true);
    await s.reopen(); assert.equal((s.store.effects(s.input.run.id)[0]!.receipt as any).remote.id, 'review-1');
  } finally { await s.cleanup(); }
});

test('unknown results with no remote proof never trigger another review or label write', async () => {
  for (const kind of ['review', 'classification'] as const) {
    const s = await fixture(kind);
    try {
      const plan = kind === 'review' ? prepareReviewPublication(s.input) : prepareLabelPublication(s.input), fake = fakeRemote(plan);
      const receipt = plan.kind === 'review.publish' ? await publishReview(plan, fake.remote, permitted('unknown')) : await setClassificationLabels(plan, fake.remote, permitted('unknown'));
      assert.equal(receipt.outcome, 'unknown'); assert.equal(fake.state.writes, 0);
      if (plan.kind === 'labels.set') { fake.state.labels.push('tests'); const found = await setClassificationLabels(plan, fake.remote, permitted('unknown')); assert.equal(found.outcome, 'confirmed'); assert.equal(fake.state.writes, 0); }
    } finally { await s.cleanup(); }
  }
});

test('bounded pagination finds review and label proof on later pages without another mutation', async () => {
  for (const kind of ['review', 'classification'] as const) {
    const s = await fixture(kind);
    try {
      const plan = kind === 'review' ? prepareReviewPublication(s.input) : prepareLabelPublication(s.input), fake = publicationRemote(s.inspection), pages: number[] = [];
      const client = new GitHubPublicationClient(tokenCredentials('fictional-token'), { fetch: async (url, init) => {
        const parsed = new URL(String(url));
        if (parsed.pathname.endsWith('/reviews') || parsed.pathname.endsWith('/labels')) {
          assert.equal(init?.method, 'GET'); const page = Number(parsed.searchParams.get('page')); pages.push(page);
          if (plan.kind === 'labels.set') return Response.json(page === 1 ? Array.from({ length: 100 }, (_, index) => ({ name: `human-${index}` })) : [{ name: 'tests' }]);
          return Response.json(page === 1 ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, html_url: `${s.inspection.evidence.pullRequest!.url}#pullrequestreview-${index + 1}`,
            commit_id: s.head, state: 'COMMENTED', body: 'An earlier human review.' })) : [{ id: 101, html_url: `${s.inspection.evidence.pullRequest!.url}#pullrequestreview-101`, commit_id: s.head, state: 'COMMENTED', body: plan.body }]);
        }
        return fake.fetch(url, init);
      } });
      const result = plan.kind === 'review.publish' ? await publishReview(plan, client, permitted('unknown')) : await setClassificationLabels(plan, client, permitted('unknown'));
      assert.equal(result.outcome, 'confirmed'); assert.deepEqual(pages, [1, 2]); assert.equal(fake.state.writes, 0);
      if (plan.kind === 'labels.set') assert.equal(result.labels!.preserved.length, 100);
    } finally { await s.cleanup(); }
  }
});

test('incomplete pages and bounded read exhaustion never count as absence or authorize an unknown resend', async () => {
  for (const mode of ['malformed', 'endless'] as const) {
    const s = await fixture();
    try {
      const plan = prepareReviewPublication(s.input), fake = publicationRemote(s.inspection); let reads = 0;
      const client = new GitHubPublicationClient(tokenCredentials('fictional-token'), { maxRequests: 4, fetch: async (url, init) => {
        if (new URL(String(url)).pathname.endsWith('/reviews')) {
          reads++;
          return Response.json(mode === 'malformed' && reads > 1 ? { incomplete: true } : Array.from({ length: 100 }, (_, i) => ({ id: i + reads * 100,
            html_url: `${s.inspection.evidence.pullRequest!.url}#pullrequestreview-${i + reads * 100}`, commit_id: s.head, state: 'COMMENTED', body: 'An earlier human review.' })));
        }
        return fake.fetch(url, init);
      } });
      const result = await publishReview(plan, client, permitted('unknown'));
      assert.equal(result.outcome, 'unknown'); assert.equal(result.freshness, 'unverified'); assert.equal(fake.state.writes, 0); assert.ok(reads >= 2 && reads <= 3);
    } finally { await s.cleanup(); }
  }
});

test('a conflicting marked review stays unknown even beside an exact matching review', async () => {
  const s = await fixture();
  try {
    const plan = prepareReviewPublication(s.input), fake = fakeRemote(plan);
    fake.state.reviews = [{ id: 'review-1', url: `${s.inspection.evidence.pullRequest!.url}#pullrequestreview-1`, headSha: s.head, state: 'COMMENTED', body: plan.body },
      { id: 'review-2', url: `${s.inspection.evidence.pullRequest!.url}#pullrequestreview-2`, headSha: s.head, state: 'COMMENTED', body: `Edited content.\n${plan.marker}` }];
    const result = await publishReview(plan, fake.remote, permitted());
    assert.equal(result.outcome, 'unknown'); assert.match(result.reason, /different review content/); assert.equal(fake.state.writes, 0);
  } finally { await s.cleanup(); }
});

test('prompt-only package changes preserve identical publication markers and remote deduplication', async () => {
  const s = await fixture();
  try {
    const plan = prepareReviewPublication(s.input), changed = structuredClone(s.input), files = Object.fromEntries(s.pkg.files.map(file => [file.path, file.text]));
    const prompt = 'docs/pr-workflows/examples/team-pr/prompts/review.md'; files[prompt] += '\nKeep findings specific.\n';
    changed.package = buildPackage(s.pkg.workflowPath, files); changed.run.packageDigest = changed.package.digest;
    changed.result.job.packageDigest = changed.package.digest; changed.result.job.package = await s.store.artifacts.put(changed.package);
    changed.inspection.packageDigest = changed.package.digest; changed.result.job.inspection = await s.store.artifacts.put(changed.inspection);
    const migrated = prepareReviewPublication(changed); assert.equal(migrated.marker, plan.marker); assert.equal(migrated.body, plan.body);
    const fake = fakeRemote(plan); await publishReview(plan, fake.remote, permitted());
    const prior = await publishReview(migrated, fake.remote, permitted()); assert.equal(prior.outcome, 'confirmed'); assert.equal(fake.state.writes, 1);
  } finally { await s.cleanup(); }
});

test('REST publication binds COMMENT to the commit and treats lost mutation responses as unknown without retries', async () => {
  const s = await fixture();
  try {
    const plan = prepareReviewPublication(s.input); let writes = 0;
    const client = new GitHubPublicationClient(tokenCredentials('fictional-token'), {
      writeCredentials: async (repository, capability) => ({ ...tokenCredentials('fictional-write-token'), repository, capability, permission: 'pull_requests:write' }), fetch: async (_url, init) => {
      assert.equal(init?.method, 'POST'); const body = JSON.parse(String(init?.body)); writes++;
      assert.equal(body.event, 'COMMENT'); assert.equal(body.commit_id, s.head); assert.equal(body.body, plan.body); assert.equal(body.comments, undefined);
      throw new Error('fictional connection loss');
    } });
    await assert.rejects(client.publishReview(plan, async () => true), error => error instanceof PublicationRemoteError && error.outcome === 'unknown'); assert.equal(writes, 1);
  } finally { await s.cleanup(); }
});

test('workflow validates named publication inputs and replay preserves partial review state', async () => {
  const s = await fixture('review', { workflow: workflow => {
    workflow.requestedCapabilities.push('review.publish'); workflow.actions.review!.onSuccess = 'publish_review';
    workflow.actions.publish_review = { execution: 'code', uses: 'github.publish_review', capabilities: ['review.publish'], onSuccess: '$wait', onFailure: '$blocked' };
  }, payload: payload => { payload.coverage = 'partial'; payload.verdict = 'inconclusive'; payload.missingEvidence = ['A binary file is unavailable.']; } });
  try {
    const observation = structuredClone(s.inspection.fixture.observations[0]!);
    const result = replay(s.pkg, { schemaVersion: 1, now: new Date(s.now).toISOString(), observations: [observation], control: { memory: { classificationCurrent: true, reviewCurrent: false, packetCurrent: false } },
      results: { review: [{ status: 'success', payload: s.input.result.provider.payload }], publish_review: [{ status: 'success' }] } });
    assert.equal(result.status, 'waiting'); assert.deepEqual(result.control.review, { coverage: 'partial', verdict: 'inconclusive' });
    assert.ok(result.proposedEffects.some(effect => effect.uses === 'github.publish_review'));
    const workflow = structuredClone(s.pkg.workflow); workflow.actions.review!.onFailure = 'publish_review';
    assert.throws(() => buildPackage(s.pkg.workflowPath, { ...Object.fromEntries(s.pkg.files.map(file => [file.path, file.text])), [s.pkg.workflowPath]: JSON.stringify(workflow) }), /requires a successful review/);
  } finally { await s.cleanup(); }
});
