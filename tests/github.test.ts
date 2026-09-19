import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, verify } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJson, digest, loadWorkflow, parseFixture, replay } from '@repo-chap/workflow';
import { GitHubReader, GitHubReadError, inspectPullRequest, installationCredentials, localCredentials, tokenCredentials, prepareCaptureDirectory, readCapture, saveCapture } from '@repo-chap/github';

const workflow = resolve('docs/pr-workflows/examples/team-pr/workflow.json');
const pkg = await loadWorkflow(workflow);
const start = Date.parse('2026-05-01T12:00:00.000Z');
const head = 'a'.repeat(40);
const token = 'fictional-test-token';

// This self-contained fake also runs as the CLI subprocess's fetch preload.
function githubFixture(settings: { private?: boolean; mergeable?: string; changed?: boolean; repoId?: string; prId?: string; head?: string; base?: string; body?: string } = {}) {
  const calls: { query: string; variables: Record<string, unknown>; authorization: string | null }[] = [];
  let metadataReads = 0;
  const head = settings.head ?? 'a'.repeat(40);
  const page = (nodes: unknown[], cursor: unknown) => ({ nodes: [nodes[cursor ? 1 : 0]], pageInfo: { hasNextPage: !cursor, endCursor: cursor ? null : 'page-2' } });
  const pr = { id: settings.prId ?? 'PR_paperboat_42', number: 42, url: 'https://github.com/reef-labs/paperboat/pull/42', title: 'Repair search', body: settings.body ?? 'Fictional PR evidence.',
    author: { login: 'river' }, state: 'OPEN', isDraft: false, headRefOid: head, baseRefOid: settings.base ?? 'b'.repeat(40), headRefName: 'repair-search', baseRefName: 'main',
    headRepository: { id: settings.repoId ?? 'R_paperboat', nameWithOwner: 'reef-labs/paperboat' }, createdAt: '2026-04-01T12:00:00Z', updatedAt: '2026-05-01T11:00:00Z', mergeable: settings.mergeable ?? 'MERGEABLE', reviewDecision: 'APPROVED' };
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    calls.push({ ...input, authorization: new Headers(init?.headers).get('authorization') });
    const operation = /query\s+(\w+)/.exec(input.query)?.[1];
    const cursor = input.variables.cursor;
    let data: unknown;
    if (operation === 'InspectMetadata') {
      metadataReads++;
      data = { repository: { id: settings.repoId ?? 'R_paperboat', nameWithOwner: 'reef-labs/paperboat', isPrivate: settings.private ?? false,
        pullRequest: { ...pr, headRefOid: settings.changed && metadataReads > 1 ? 'c'.repeat(40) : head } } };
    } else if (operation === 'Inspectlabels') data = { repository: { pullRequest: { labels: page([{ id: 'L_a', name: 'tests' }, { id: 'L_b', name: 'ux' }], cursor) } } };
    else if (operation === 'InspectChecks') data = { repository: { object: { statusCheckRollup: { contexts: page([
      { __typename: 'CheckRun', id: 'CHECK_a', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: null },
      { __typename: 'StatusContext', id: 'STATUS_b', context: 'build', state: 'SUCCESS', targetUrl: null },
    ], cursor) } } } };
    else if (operation === 'Inspectreviews') data = { repository: { pullRequest: { reviews: page([
      { id: 'REVIEW_a', author: { login: 'birch' }, state: 'APPROVED', body: 'Reviewed.', commit: { oid: head }, submittedAt: '2026-05-01T11:59:00Z' },
      { id: 'REVIEW_b', author: { login: 'river' }, state: 'COMMENTED', body: 'Updated tests.', commit: { oid: head }, submittedAt: '2026-05-01T11:59:00Z' },
    ], cursor) } } };
    else if (operation === 'InspectreviewThreads') data = { repository: { pullRequest: { reviewThreads: page([
      { id: 'THREAD_a', isResolved: true, isOutdated: false, path: 'src/search.ts', line: 2 },
      { id: 'THREAD_b', isResolved: true, isOutdated: true, path: 'src/search.ts', line: null },
    ], cursor) } } };
    else if (operation === 'InspectThreadComments') data = { node: { comments: page([
      { id: `${input.variables.id}_1`, author: { login: 'birch' }, body: 'Check this branch.', createdAt: '2026-05-01T10:00:00Z', commit: { oid: head } },
      { id: `${input.variables.id}_2`, author: { login: 'river' }, body: 'Fixed.', createdAt: '2026-05-01T11:00:00Z', commit: { oid: head } },
    ], cursor) } };
    else if (operation === 'Inspectreactions') data = { repository: { pullRequest: { reactions: page([
      { id: 'REACTION_a', user: { login: 'willow-bot' }, content: 'EYES', createdAt: '2026-05-01T11:59:00Z' },
      { id: 'REACTION_b', user: { login: 'non-reviewer' }, content: 'EYES', createdAt: '2026-05-01T11:59:30Z' },
    ], cursor) } } };
    else throw new Error(`Unexpected operation: ${operation}`);
    return Response.json({ data });
  };
  return { calls, fetch };
}
const inspect = (fetch: typeof globalThis.fetch, more: Partial<Parameters<typeof inspectPullRequest>[2]> = {}, read = {}) => inspectPullRequest(
  new GitHubReader(tokenCredentials(token), { fetch, now: () => start, sleep: async () => {}, ...read }), pkg,
  { repository: 'reef-labs/paperboat', pr: 42, reviewers: ['Willow-Bot'], ...more });

test('public and private inspection paginate every collection and retain stable identities', async () => {
  for (const isPrivate of [false, true]) {
    const fake = githubFixture({ private: isPrivate });
    const result = await inspect(fake.fetch);
    assert.equal(result.status, 'complete');
    assert.equal(result.evidence.repository?.private, isPrivate);
    assert.equal(result.evidence.repository?.id, 'R_paperboat');
    assert.equal(result.evidence.pullRequest?.id, 'PR_paperboat_42');
    assert.equal(result.fixture.observations[0]?.headSha, head);
    for (const collection of [result.evidence.labels, result.evidence.checks, result.evidence.reviews, result.evidence.threads, result.evidence.reviewerActivity]) {
      assert.equal(collection.coverage.status, 'complete'); assert.equal(collection.coverage.pages, 2);
    }
    assert.deepEqual(result.evidence.threads.items.map(t => t.comments.items.length), [2, 2]);
    assert.equal(result.evidence.reviewerActivity.items.length, 1);
    assert.equal(result.fixture.observations[0]?.facts.externalReviewPending, true);
    assert.equal(parseFixture(result.fixture).schemaVersion, 1);
    assert.equal(replay(pkg, result.fixture).status, 'waiting');
    assert.ok(fake.calls.every(call => call.query.startsWith('query ') && !call.query.includes('mutation')));
    assert.ok(fake.calls.every(call => call.authorization === `Bearer ${token}`));
    assert.ok(!JSON.stringify(result).includes(token));
  }
});

test('unknown mergeability and revision changes remain visible and cannot authorize readiness', async () => {
  for (const settings of [{ mergeable: 'UNKNOWN' }, { changed: true }]) {
    const result = await inspect(githubFixture(settings).fetch);
    assert.equal(result.status, 'partial');
    assert.equal(result.fixture.observations[0]?.facts.evidenceComplete, false);
    assert.equal(replay(pkg, result.fixture).decisions[0]?.ruleId, 'missing_evidence');
    if (settings.changed) assert.equal(result.evidence.revision.status, 'changed');
    else assert.equal(result.fixture.observations[0]?.facts.conflict, null);
  }
});

test('partial reviews retain the first page and null facts after bounded failed retries', async () => {
  const fake = githubFixture(); let failures = 0;
  const result = await inspect(async (url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes('query Inspectreviews') && variables.cursor) { failures++; return Response.json({ message: token }, { status: 503 }); }
    return fake.fetch(url, init);
  });
  assert.equal(failures, 3);
  assert.equal(result.evidence.reviews.items.length, 1);
  assert.equal(result.evidence.reviews.coverage.status, 'partial');
  assert.equal(result.evidence.reviews.coverage.failure?.code, 'network');
  assert.equal(result.fixture.observations[0]?.facts.unaddressedReview, null);
  assert.equal(result.fixture.observations[0]?.facts.externalReviewPending, null);
  assert.equal(result.status, 'partial');
  assert.ok(!JSON.stringify(result).includes(token));
});

test('GraphQL partial pages and malformed nodes preserve usable evidence with partial coverage', async () => {
  const fake = githubFixture();
  const result = await inspect(async (url, init) => {
    const response = await fake.fetch(url, init);
    const body = await response.json();
    if (String(init?.body).includes('query Inspectreviews')) {
      body.errors = [{ message: token, type: 'FORBIDDEN' }];
      body.data.repository.pullRequest.reviews.nodes.push(null);
    }
    return Response.json(body);
  });
  assert.equal(result.evidence.reviews.items.length, 1);
  assert.equal(result.evidence.reviews.coverage.status, 'partial');
  assert.equal(result.fixture.observations[0]?.facts.evidenceComplete, false);
  assert.ok(!JSON.stringify(result).includes(token));
});

test('nested thread-comment failures and interrupted reads retain missing coverage', async () => {
  const fake = githubFixture();
  const controller = new AbortController();
  const result = await inspect(async (url, init) => {
    if (String(init?.body).includes('InspectThreadComments')) { controller.abort(); throw new Error(token); }
    return fake.fetch(url, init);
  }, {}, { signal: controller.signal });
  assert.equal(result.evidence.labels.items.length, 2);
  assert.equal(result.evidence.threads.coverage.status, 'partial');
  assert.equal(result.evidence.threads.items[0]?.comments.coverage.failure?.code, 'cancelled');
  assert.equal(result.evidence.revision.status, 'unknown');
  assert.equal(result.fixture.observations[0]?.facts.evidenceComplete, false);
});

test('retry-after and primary reset guidance delay all reads and long limits stop early', async () => {
  for (const headers of [{ 'retry-after': '2' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(start / 1000 + 2) }] as Record<string, string>[]) {
    let now = start; let attempts = 0; const delays: number[] = []; const fake = githubFixture();
    const result = await inspect(async (url, init) => {
      if (++attempts === 1) return Response.json({ message: 'rate limit' }, { status: 403, headers });
      return fake.fetch(url, init);
    }, {}, { now: () => now, sleep: async (ms: number) => { delays.push(ms); now += ms; } });
    assert.equal(result.status, 'complete'); assert.ok(delays[0]! >= 2000); assert.equal(delays.length, 1);
  }
  let requests = 0;
  const result = await inspect(async () => { requests++; return Response.json({ message: token }, { status: 429, headers: { 'retry-after': '600' } }); });
  assert.equal(requests, 1);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.evidence.metadata.failure?.code, 'rate_limit');
  assert.equal(result.evidence.metadata.failure?.retryAt, '2026-05-01T12:10:00.000Z');
});

test('shared cooldown extensions during sleep delay requests or retain the new retry time', async () => {
  for (const extension of [2000, 600_000]) {
    let now = start, until = start + 1000, requests = 0;
    const reader = new GitHubReader(tokenCredentials(token), {
      now: () => now, cooldown: { read: () => until, extend: value => { until = Math.max(until, value); } },
      sleep: async milliseconds => { now += milliseconds; until = start + extension; },
      fetch: async () => { requests++; assert.ok(now >= until); return Response.json({ data: { fictional: true } }); },
    });
    if (extension === 2000) { await reader.query('query Fictional { fictional }', {}); assert.equal(now, until); assert.equal(requests, 1); }
    else {
      await assert.rejects(reader.query('query Fictional { fictional }', {}), new GitHubReadError('rate_limit', new Date(start + extension).toISOString()));
      assert.equal(requests, 0);
    }
  }
});

test('shared cooldown extensions during credential lookup delay requests or retain the new retry time', async () => {
  for (const extension of [2000, 600_000]) {
    let now = start, until = 0, requests = 0;
    const reader = new GitHubReader({ ...tokenCredentials(token), token: async () => { until = start + extension; return token; } }, {
      now: () => now, cooldown: { read: () => until, extend: value => { until = Math.max(until, value); } },
      sleep: async milliseconds => { now += milliseconds; },
      fetch: async () => { requests++; assert.ok(now >= until); return Response.json({ data: { fictional: true } }); },
    });
    if (extension === 2000) { await reader.query('query Fictional { fictional }', {}); assert.equal(now, until); assert.equal(requests, 1); }
    else {
      await assert.rejects(reader.query('query Fictional { fictional }', {}), new GitHubReadError('rate_limit', new Date(start + extension).toISOString()));
      assert.equal(requests, 0);
    }
  }
});

test('bounded requests and bad cursors cannot silently truncate a collection', async () => {
  const limited = await inspect(githubFixture().fetch, {}, { maxRequests: 2 });
  assert.equal(limited.evidence.labels.items.length, 1);
  assert.equal(limited.evidence.labels.coverage.failure?.code, 'limit');
  const fake = githubFixture();
  const result = await inspect(async (url, init) => {
    const response = await fake.fetch(url, init); const body = await response.json();
    if (String(init?.body).includes('Inspectlabels')) body.data.repository.pullRequest.labels.pageInfo = { hasNextPage: true, endCursor: 'same' };
    return Response.json(body);
  });
  assert.equal(result.evidence.labels.coverage.status, 'partial');
  assert.equal(result.evidence.labels.coverage.failure?.code, 'invalid_response');
});

test('denied repository access is scoped to the requested repository, with no false empty result', async () => {
  const result = await inspect(async () => Response.json({ message: token }, { status: 404 }));
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.evidence.requested, { repository: 'reef-labs/paperboat', pr: 42 });
  assert.equal(result.evidence.metadata.failure?.code, 'access');
  assert.equal(result.evidence.reviews.coverage.status, 'unknown');
  assert.equal(result.fixture.observations[0]?.facts.lifecycle, null);
  assert.equal((await inspect(githubFixture().fetch)).status, 'complete');
});

test('local credentials prefer environment tokens and isolate gh output and failures', async () => {
  let calls = 0;
  const source = await localCredentials({ env: { GH_TOKEN: token, GITHUB_TOKEN: 'other-fictional-token' }, runGh: async () => { calls++; return 'unused'; } });
  assert.equal(await source.token(), token); assert.equal(calls, 0);
  assert.equal(source.redact(`Bearer ${token}`), 'Bearer [redacted]');
  const gh = await localCredentials({ env: {}, runGh: async () => `${token}\n` });
  assert.equal(await gh.token(), token);
  await assert.rejects(localCredentials({ env: {}, runGh: async () => { throw new Error(token); } }), error => !String(error).includes(token));
});

test('App JWT credentials refresh before expiry and once on 401 without repository mutations', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  let now = start; let issued = 0; const requests: string[] = [];
  const app = installationCredentials({ appId: 'fictional-app', installationId: 42, privateKey: pem, now: () => now,
    fetch: async (url, init) => {
      requests.push(String(url)); assert.equal(init?.method, 'POST');
      assert.ok(String(url).endsWith('/app/installations/42/access_tokens'));
      assert.ok(Object.values(JSON.parse(String(init?.body)).permissions).every(v => v === 'read'));
      const jwt = new Headers(init?.headers).get('Authorization')!.slice('Bearer '.length);
      const [header, payload, signature] = jwt.split('.');
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
      assert.equal(claims.iss, 'fictional-app'); assert.ok(claims.exp - now / 1000 <= 600);
      assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, 'base64url')), true);
      return Response.json({ token: `fictional-installation-${++issued}`, expires_at: new Date(now + 3600_000).toISOString() });
    } });
  assert.equal(await app.token(), 'fictional-installation-1');
  assert.equal(await app.token(), 'fictional-installation-1');
  now += 3550_000;
  assert.equal(await app.token(), 'fictional-installation-2');
  const fake = githubFixture(); let denied = false;
  const result = await inspectPullRequest(new GitHubReader(app, { now: () => now, fetch: async (url, init) => {
    if (!denied) { denied = true; return Response.json({ message: 'expired' }, { status: 401 }); }
    return fake.fetch(url, init);
  } }), pkg, { repository: 'reef-labs/paperboat', pr: 42 });
  assert.equal(result.status, 'complete'); assert.equal(issued, 3); assert.equal(requests.length, 3);
  assert.ok(!JSON.stringify(result).includes('fictional-installation-'));
  assert.ok(!JSON.stringify(result).includes(pem));
});

test('restart-style reuse retains timing only for the same repository, PR, head and base', async () => {
  const first = await inspect(githubFixture().fetch);
  const restarted = await inspect(githubFixture().fetch, { previous: first }, { now: () => start + 40_000 });
  assert.equal(restarted.fixture.observations[0]?.headChangedAt, first.fixture.observations[0]?.headChangedAt);
  assert.equal(restarted.fixture.observations[0]?.facts.headDebouncing, false);
  assert.equal(restarted.fixture.observations[0]?.externalReviewStartedAt, first.fixture.observations[0]?.externalReviewStartedAt);
  assert.equal(restarted.evidenceDigest, first.evidenceDigest);
  for (const settings of [{ head: 'c'.repeat(40) }, { base: 'd'.repeat(40) }, { prId: 'PR_paperboat_other' }, { repoId: 'R_other' }]) {
    const next = await inspect(githubFixture(settings).fetch, { previous: first }, { now: () => start + 40_000 });
    assert.equal(next.fixture.observations[0]?.facts.headDebouncing, true);
    assert.notEqual(next.fixture.observations[0]?.headChangedAt, first.fixture.observations[0]?.headChangedAt);
  }
  const expired = await inspect(githubFixture().fetch, { previous: first }, { now: () => start + 1800_000 });
  assert.equal(expired.fixture.observations[0]?.facts.externalReviewPending, false);
  const disabled = await inspect(githubFixture().fetch, { reviewers: [] });
  assert.equal(disabled.fixture.observations[0]?.facts.externalReviewPending, false);
  const changed = await inspect(githubFixture({ changed: true }).fetch);
  const afterChange = await inspect(githubFixture().fetch, { previous: changed }, { now: () => start + 40_000 });
  assert.equal(afterChange.fixture.observations[0]?.facts.headDebouncing, true);
});

test('outdated unresolved threads remain concerns and a current-head review clears the reviewer hint', async () => {
  const fake = githubFixture();
  const result = await inspect(async (url, init) => {
    const body = await (await fake.fetch(url, init)).json();
    if (String(init?.body).includes('InspectreviewThreads')) Object.assign(body.data.repository.pullRequest.reviewThreads.nodes[0], { isResolved: false, isOutdated: true });
    if (String(init?.body).includes('Inspectreviews')) Object.assign(body.data.repository.pullRequest.reviews.nodes[0], { author: { login: 'Willow-Bot' }, submittedAt: '2026-05-01T11:59:30Z' });
    return Response.json(body);
  });
  assert.equal(result.fixture.observations[0]?.facts.unaddressedReview, true);
  assert.equal(result.fixture.observations[0]?.facts.externalReviewPending, false);
});

test('successful responses with no rate allowance pause later queries; partial rate responses retain data', async () => {
  for (const partial of [false, true]) {
    const fake = githubFixture(); let requests = 0; let now = start; let waited = 0;
    const result = await inspect(async (url, init) => {
      requests++;
      const body = await (await fake.fetch(url, init)).json();
      if (requests === 1) {
        if (partial) body.errors = [{ type: 'RATE_LIMITED', message: token }];
        return Response.json(body, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(start / 1000 + 3) } });
      }
      assert.ok(now >= start + 3000);
      return Response.json(body);
    }, {}, { now: () => now, sleep: async (ms: number) => { waited += ms; now += ms; } });
    assert.ok(waited >= 3000);
    assert.equal(result.status, partial ? 'partial' : 'complete');
    assert.equal(result.evidence.pullRequest?.id, 'PR_paperboat_42');
  }
});

test('response and deadline limits leave evidence unknown without leaking transport errors', async () => {
  const large = await inspect(githubFixture().fetch, {}, { maxResponseBytes: 100 });
  assert.equal(large.status, 'unavailable'); assert.equal(large.evidence.metadata.failure?.code, 'limit');
  const timeout = await inspect(async (_url, init) => new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(token)), 1000);
    init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error(token)); }, { once: true });
  }), {}, { maxDurationMs: 10 });
  assert.equal(timeout.evidence.metadata.failure?.code, 'timeout');
  assert.ok(!JSON.stringify(timeout).includes(token));
});

test('failed and rate-limited App credential creation use fixed diagnostics and a shared cooldown', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  let calls = 0;
  const credentials = installationCredentials({ appId: 'fictional-app', installationId: 42, privateKey: pem, now: () => start,
    fetch: async () => { calls++; return Response.json({ message: pem }, { status: 429, headers: { 'retry-after': '600' } }); } });
  for (let i = 0; i < 2; i++) await assert.rejects(credentials.token(), error => String(error).includes('rate limit') && !String(error).includes(pem));
  assert.equal(calls, 1);
});

test('private captures replay offline, redact credentials and reject mixed files or revisions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repo-chap-capture-'));
  try {
    const first = await inspect(githubFixture({ body: `Never capture ${token}` }).fetch);
    const paths = await saveCapture(directory, first);
    assert.equal((await stat(paths.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.fixture)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.evidence)).mode & 0o777, 0o600);
    assert.ok(!(await readFile(paths.evidence, 'utf8')).includes(token));
    assert.deepEqual(await readCapture(paths.directory, pkg), first);
    assert.equal(replay(pkg, parseFixture(JSON.parse(await readFile(paths.fixture, 'utf8')))).status, 'waiting');
    const second = await saveCapture(directory, await inspect(githubFixture({ head: 'd'.repeat(40) }).fetch));
    await writeFile(paths.fixture, await readFile(second.fixture));
    await assert.rejects(readCapture(paths.directory, pkg), /digests do not match/);
    await assert.rejects(readCapture(second.directory, { ...pkg, digest: `sha256:${'0'.repeat(64)}` }), /digests do not match/);
    const document = JSON.parse(await readFile(second.evidence, 'utf8'));
    document.evidence.pullRequest.headSha = 'f'.repeat(40);
    document.evidenceDigest = digest(canonicalJson(document.evidence));
    await writeFile(second.evidence, JSON.stringify(document));
    await assert.rejects(readCapture(second.directory, pkg), /identity does not match/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('capture rejects Git checkouts, shared directories and symlink targets before writing evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repo-chap-capture-'));
  try {
    await assert.rejects(prepareCaptureDirectory(resolve('capture-must-not-exist')), /outside every Git checkout/);
    await assert.rejects(stat(resolve('capture-must-not-exist')));
    await chmod(directory, 0o755);
    await assert.rejects(prepareCaptureDirectory(directory), /0700/);
    await chmod(directory, 0o700);
    const link = join(directory, 'alias'); await symlink(directory, link);
    await assert.rejects(prepareCaptureDirectory(link), /symlinks/);
    assert.deepEqual(await readdir(directory), ['alias']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('actual CLI inspects public/private fixture responses and reports replayable captures and partial exit status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repo-chap-inspect-cli-'));
  try {
    const preload = join(directory, 'fake-github.mjs');
    for (const settings of [{ private: false }, { private: true }, { mergeable: 'UNKNOWN' }]) {
      await writeFile(preload, `globalThis.fetch = (${githubFixture.toString()})(${JSON.stringify(settings)}).fetch;`);
      const result = spawnSync(process.execPath, ['--import', preload, 'apps/cli/dist/cli.js', 'inspect', workflow, '--repo', 'reef-labs/paperboat', '--pr', '42', '--capture-dir', directory, '--json'], {
        encoding: 'utf8', env: { PATH: process.env.PATH, GH_TOKEN: token, HOME: directory },
      });
      assert.equal(result.status, settings.mergeable ? 4 : 0, result.stderr || result.stdout);
      const output = JSON.parse(result.stdout);
      assert.equal(output.schemaVersion, 1); assert.equal(output.headSha, head);
      assert.equal(output.coverage.reviews.status, 'complete');
      assert.ok(!result.stdout.includes(token));
      const replayed = spawnSync(process.execPath, ['apps/cli/dist/cli.js', 'replay', workflow, '--fixture', output.capture.fixture, '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: directory } });
      assert.equal(replayed.status, 0, replayed.stderr);
      assert.ok(['waiting', 'needs_result'].includes(JSON.parse(replayed.stdout).status));
    }
    const invalid = spawnSync(process.execPath, ['apps/cli/dist/cli.js', 'inspect', workflow, '--repo', 'reef-labs/paperboat', '--pr', '42', '--json'], { encoding: 'utf8' });
    assert.equal(invalid.status, 64); assert.match(invalid.stdout, /capture-dir/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI interruption saves a partial capture and returns 130', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repo-chap-interrupt-'));
  try {
    const preload = join(directory, 'fake-github.mjs');
    await writeFile(preload, `const fake = (${githubFixture.toString()})();
      globalThis.fetch = async (url, init) => {
        if (String(init.body).includes('Inspectlabels')) {
          process.stderr.write('READ_WAITING\\n');
          return new Promise((resolve, reject) => {
            const keepAlive = setTimeout(() => reject(new Error('test timeout')), 10000);
            init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(new Error('cancelled')); }, { once: true });
          });
        }
        return fake.fetch(url, init);
      };`);
    const child = spawn(process.execPath, ['--import', preload, 'apps/cli/dist/cli.js', 'inspect', workflow, '--repo', 'reef-labs/paperboat', '--pr', '42', '--capture-dir', directory, '--json'], {
      env: { PATH: process.env.PATH, GH_TOKEN: token, HOME: directory }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.includes('READ_WAITING')) child.kill('SIGINT'); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    const exit = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    clearTimeout(timeout);
    assert.equal(exit, 130, stderr || stdout);
    const result = JSON.parse(stdout);
    assert.equal(result.status, 'partial');
    assert.equal(result.coverage.labels.failure.code, 'cancelled');
    assert.equal((await readCapture(result.capture.directory, pkg)).fixture.observations[0]?.facts.evidenceComplete, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a collection server retry deadline blocks every later read and preserves its retry timestamp', async () => {
  const fake = githubFixture(); let requests = 0;
  const result = await inspect(async (url, init) => {
    requests++;
    if (String(init?.body).includes('Inspectlabels')) return Response.json({ message: 'temporarily unavailable' }, { status: 503, headers: { 'retry-after': '600' } });
    return fake.fetch(url, init);
  }, {}, { maxDurationMs: 1000 });
  assert.equal(requests, 2, 'Only metadata and the first labels request may reach GitHub.');
  assert.equal(result.status, 'partial');
  assert.equal(result.evidence.labels.coverage.failure?.code, 'timeout');
  assert.equal(result.evidence.labels.coverage.failure?.retryAt, '2026-05-01T12:10:00.000Z');
  for (const coverage of [result.evidence.checks.coverage, result.evidence.reviews.coverage, result.evidence.threads.coverage, result.evidence.reviewerActivity.coverage]) {
    assert.equal(coverage.status, 'unknown');
    assert.equal(coverage.failure?.retryAt, '2026-05-01T12:10:00.000Z');
  }
  assert.equal(result.evidence.revision.status, 'unknown');
  assert.equal(result.evidence.revision.failure?.retryAt, '2026-05-01T12:10:00.000Z');
  assert.equal(result.fixture.observations[0]?.facts.evidenceComplete, false);
});

test('a deleted review author and GitHub aggregate changes-requested state remain unaddressed', async () => {
  for (const deletedAuthor of [true, false]) {
    const fake = githubFixture();
    const result = await inspect(async (url, init) => {
      const body = await (await fake.fetch(url, init)).json();
      if (deletedAuthor && String(init?.body).includes('Inspectreviews')) Object.assign(body.data.repository.pullRequest.reviews.nodes[0], { author: null, state: 'CHANGES_REQUESTED' });
      if (!deletedAuthor && String(init?.body).includes('InspectMetadata')) body.data.repository.pullRequest.reviewDecision = 'CHANGES_REQUESTED';
      return Response.json(body);
    });
    assert.equal(result.fixture.observations[0]?.facts.unaddressedReview, true);
    assert.equal(result.status, 'complete');
  }
});

test('inspection derives CI failure and pending facts from check runs and commit statuses', async () => {
  const run = (conclusion: string | null, status = 'COMPLETED') => ({ __typename: 'CheckRun', id: 'CHECK_ci', name: 'unit', status, conclusion, detailsUrl: null });
  const context = (state: string) => ({ __typename: 'StatusContext', id: 'STATUS_ci', context: 'build', state, targetUrl: null });
  const cases = [
    { nodes: [run('SUCCESS'), context('SUCCESS'), run('NEUTRAL'), run('SKIPPED')], failed: false, pending: false },
    ...['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].map(value => ({ nodes: [run(value)], failed: true, pending: false })),
    ...['FAILURE', 'ERROR'].map(value => ({ nodes: [context(value)], failed: true, pending: false })),
    ...['QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'PENDING'].map(value => ({ nodes: [run(null, value)], failed: false, pending: true })),
    { nodes: [run('FAILURE'), context('PENDING')], failed: true, pending: true },
    { nodes: [run(null)], failed: null, pending: null },
    { nodes: [context('FUTURE_STATE')], failed: null, pending: null },
    { nodes: [run('FAILURE'), run('FUTURE_CONCLUSION')], failed: true, pending: null },
    { nodes: [], failed: null, pending: null },
  ];
  for (const scenario of cases) {
    const fake = githubFixture();
    const result = await inspect(async (url, init) => {
      if (String(init?.body).includes('query InspectChecks')) return Response.json({ data: { repository: { object: { statusCheckRollup: { contexts: {
        nodes: scenario.nodes, pageInfo: { hasNextPage: false, endCursor: null },
      } } } } } });
      return fake.fetch(url, init);
    });
    assert.equal(result.fixture.observations[0]!.facts.ciFailed, scenario.failed, JSON.stringify(scenario));
    assert.equal(result.fixture.observations[0]!.facts.ciPending, scenario.pending, JSON.stringify(scenario));
    assert.equal(result.fixture.observations[0]!.facts.evidenceComplete, true);
  }
});

test('partial check collection and changed heads leave both CI facts unknown', async () => {
  for (const changed of [false, true]) {
    const fake = githubFixture({ changed });
    const result = await inspect(async (url, init) => {
      const input = JSON.parse(String(init?.body));
      if (!changed && input.query.includes('query InspectChecks') && input.variables.cursor) return Response.json({}, { status: 503 });
      return fake.fetch(url, init);
    });
    assert.equal(result.fixture.observations[0]!.facts.ciFailed, null);
    assert.equal(result.fixture.observations[0]!.facts.ciPending, null);
    assert.equal(result.fixture.observations[0]!.facts.evidenceComplete, false);
  }
});
