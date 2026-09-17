import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildPackage, canonicalJson, digest } from '@repo-chap/workflow';
import { saveCapture } from '@repo-chap/github';
import { collectSources, readProfile, runClaude, runProvider, type ProviderProfile } from '@repo-chap/providers';
import { setup as fixture, git } from './helpers/provider-fixture.ts';

const setup = (mode = 'valid', extra: Partial<ProviderProfile> = {}) => fixture(mode, { provider: 'claude', ...extra });
const requestFor = async (s: Awaited<ReturnType<typeof setup>>, actionId = 'classify') => ({
  package: s.pkg, profile: s.profile, actionId, mode: 'read' as const, workingDirectory: s.temporary, artifactDirectory: s.output,
  sources: await collectSources(s.repository, s.head, s.base), evidence: s.inspection.evidence,
  evidenceDigest: s.inspection.evidenceDigest, fixtureDigest: digest(canonicalJson(s.inspection.fixture)), missingEvidence: [],
});

test('Claude public analysis uses pinned code, native JSON results and separate usage estimates', async () => {
  const s = await setup();
  try {
    await writeFile(join(s.repository, 'src/value.js'), 'uncommitted bytes must not be analyzed\n');
    const result = s.run(); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.json.decision, 'analysis_acceptable'); assert.equal(result.json.headSha, s.head);
    assert.equal(result.json.results.classify.provider, 'claude');
    const usage = result.json.results.classify.attempts[0].usage;
    assert.deepEqual(usage.actual, { inputTokens: 130, cachedInputTokens: 20, outputTokens: 30, cacheCreationInputTokens: 10 });
    assert.equal(usage.estimated.costUsd, 0.012); assert.equal(usage.estimated.costMethod, 'provider_reported_estimate');
    const inputs = (await readdir(s.output)).find(name => name.startsWith('inputs-'))!;
    const sources = JSON.parse(await readFile(join(s.output, inputs, 'sources.json'), 'utf8'));
    assert.equal(sources.files.find((f: { side: string; path: string }) => f.side === 'head' && f.path === 'src/value.js').text, 'export const value = 2;\n');
    const calls: string[][] = (await readFile(s.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    for (const args of calls.filter(args => args.includes('--print'))) {
      assert.equal(args[args.indexOf('--tools') + 1], ''); assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
      assert.ok(args.includes('--safe-mode')); assert.ok(!args.includes('--bare')); assert.ok(!args.includes('--continue'));
      assert.equal(args[args.indexOf('--setting-sources') + 1], '');
      assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]!), { disableAllHooks: true });
      const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]!);
      assert.equal(schema.type, 'object'); assert.ok(schema.required.includes('headSha')); assert.ok(!schema.properties.resultJson);
      assert.ok(!JSON.stringify(schema).includes('2020-12'));
    }
    assert.equal(git(s.repository, 'rev-parse', 'HEAD'), s.head);
  } finally { await s.cleanup(); }
});

for (const mode of ['invalid', 'malformed', 'no_result', 'schema_error', 'citation', 'wrong_head', 'wrong_base', 'unsupported', 'flood', 'stderr_flood', 'error', 'reported_error']) test(`Claude public analysis rejects ${mode} with no old readiness`, async () => {
  const s = await setup(mode);
  try {
    const result = s.run(); assert.equal(result.status, 5, result.stdout + result.stderr);
    assert.equal(result.json.status, mode === 'unsupported' ? 'blocked' : ['error', 'reported_error'].includes(mode) ? 'provider_error' : 'invalid_output');
    assert.equal(result.json.decision, 'incomplete'); assert.equal(result.json.control.memory.reviewCurrent, false);
    assert.ok(!result.stdout.includes('credential-example-must-not-leak'));
    if (mode.includes('flood')) assert.ok(result.json.results.classify.attempts[0].outputBytes <= s.profile.maxOutputBytes);
    if (mode === 'unsupported') assert.equal(await readFile(s.marker, 'utf8').catch(() => ''), '');
  } finally { await s.cleanup(); }
});

test('Claude missing evidence cannot be reported as a clear review', async () => {
  for (const mode of ['valid', 'false_clear']) {
    const s = await setup(mode);
    try {
      await writeFile(join(s.repository, 'asset.bin'), Buffer.from([0, 1, 2])); git(s.repository, 'add', '.'); git(s.repository, 'commit', '-qm', 'Binary asset');
      const head = git(s.repository, 'rev-parse', 'HEAD');
      s.inspection.evidence.pullRequest!.headSha = head; s.inspection.evidence.revision.headSha = head;
      s.inspection.evidenceDigest = digest(canonicalJson(s.inspection.evidence));
      s.inspection.fixture.observations[0]!.headSha = head; s.inspection.fixture.observations[0]!.evidenceDigest = s.inspection.evidenceDigest;
      const capture = await saveCapture(join(s.temporary, 'captures'), s.inspection); s.args[s.args.indexOf('--capture') + 1] = capture.directory;
      const result = s.run(); assert.equal(result.status, mode === 'valid' ? 0 : 5, result.stdout);
      assert.equal(result.json.decision, 'incomplete'); assert.equal(result.json.results.classify.payload.uncertain, true);
      assert.match(result.json.missingEvidence.join(' '), /binary/);
      assert.equal(result.json.results.review.outcome, mode === 'valid' ? 'completed' : 'invalid_output');
    } finally { await s.cleanup(); }
  }
});

test('Claude native generation cannot weaken canonical or configured host contracts', async () => {
  for (const mode of ['invalid', 'valid']) {
    const s = await setup(mode);
    try {
      const files = Object.fromEntries(s.pkg.files.map(file => [file.path, file.text]));
      const path = 'docs/pr-workflows/schemas/results.schema.json', schema = JSON.parse(files[path]!);
      schema.$defs.classification = mode === 'invalid' ? {} : { ...schema.$defs.classification, properties: { ...schema.$defs.classification.properties, uncertain: { const: true } } };
      files[path] = JSON.stringify(schema);
      const result = await runClaude({ ...await requestFor(s), package: buildPackage(s.pkg.workflowPath, files) });
      assert.equal(result.outcome, 'invalid_output'); assert.equal(result.attempts[0]!.usage.actual!.inputTokens, 130);
    } finally { await s.cleanup(); }
  }
});

test('Claude exact session resume rejects changed profiles, provider IDs and input revisions', async () => {
  const s = await setup();
  try {
    const first = s.run(); const second = s.run('--resume', first.json.recordPath); assert.equal(second.status, 0, second.stdout);
    assert.ok(Object.values(second.json.results).every((result: any) => result.attempts[0].resumed));
    const config = JSON.parse(await readFile(s.settings, 'utf8')); config.profiles.pilot.effort = 'high'; await writeFile(s.settings, JSON.stringify(config));
    const changed = s.run('--resume', second.json.recordPath); assert.equal(changed.status, 0, changed.stdout);
    assert.ok(Object.values(changed.json.results).every((result: any) => !result.attempts[0].resumed));
    config.profiles.pilot.effort = 'unsupported'; await writeFile(s.settings, JSON.stringify(config));
    const blocked = s.run('--resume', first.json.recordPath); assert.equal(blocked.status, 5); assert.equal(blocked.json.status, 'blocked');
    assert.equal(blocked.json.control.memory.classificationCurrent, false); assert.equal(blocked.json.control.memory.reviewCurrent, false);
    const request = await requestFor(s), initial = await runClaude(request);
    for (const session of [{ ...initial.session!, provider: 'codex' }, { ...initial.session!, inputDigest: 'changed' }, { ...initial.session!, id: '../../session' }]) {
      const result = await runClaude({ ...request, session }); assert.equal(result.outcome, 'completed'); assert.equal(result.attempts[0]!.resumed, false);
    }
  } finally { await s.cleanup(); }
});

test('Claude lost sessions recover once and invalid correction shares the CLI attempt allowance', async () => {
  const s = await setup('lost', { maxAttempts: 2 });
  try {
    const request = await requestFor(s), first = await runProvider(request);
    const recovered = await runProvider({ ...request, session: first.session }); assert.equal(recovered.outcome, 'completed');
    assert.deepEqual(recovered.attempts.map(attempt => attempt.resumed), [true, false]);
  } finally { await s.cleanup(); }
  const invalid = await setup('invalid', { maxAttempts: 2 });
  try { const result = invalid.run(); assert.equal(result.status, 5); assert.equal(result.json.results.classify.attempts.length, 2); assert.equal(result.json.results.review, undefined); }
  finally { await invalid.cleanup(); }
});

test('Claude timeout and cancellation stop descendants and save terminal public records', async () => {
  for (const mode of ['hang', 'cancel']) {
    const s = await setup(mode, { timeoutMs: mode === 'hang' ? 1000 : 10_000 });
    const child = spawn(process.execPath, [resolve('apps/cli/dist/cli.js'), ...s.args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exit = new Promise<number | null>(resolve => child.on('close', resolve)); let stdout = ''; child.stdout.on('data', data => stdout += data);
    try {
      if (mode === 'cancel') { for (let i = 0; i < 100; i++) { if (await readFile(s.childPid, 'utf8').catch(() => '')) break; await new Promise(resolve => setTimeout(resolve, 20)); } child.kill('SIGINT'); }
      assert.equal(await exit, mode === 'hang' ? 5 : 130); assert.equal(JSON.parse(stdout).status, mode === 'hang' ? 'timeout' : 'cancelled');
      const pid = (await readFile(s.childPid, 'utf8')).trim(); const ps = spawnSync('ps', ['-o', 'stat=', '-p', pid], { encoding: 'utf8' });
      assert.ok(ps.status !== 0 || !ps.stdout.trim() || ps.stdout.trim().startsWith('Z'));
    } finally { child.kill('SIGINT'); await exit; await s.cleanup(); }
  }
});

test('Claude workspace calls obey capabilities; missing usage and unsafe session IDs stay absent', async () => {
  for (const mode of ['no_usage', 'bad_session']) {
    const s = await setup(mode);
    try {
      const request = await requestFor(s, 'resolve_conflict');
      assert.equal((await runClaude(request)).outcome, 'blocked');
      const result = await runClaude({ ...request, mode: 'workspace' }); assert.equal(result.outcome, 'blocked'); assert.equal(result.attempts.length, 1);
      if (mode === 'no_usage') { assert.equal(result.attempts[0]!.usage.actual, null); assert.equal(result.attempts[0]!.usage.estimated.costUsd, undefined); }
      if (mode === 'bad_session') assert.equal(result.session, undefined);
      const args = JSON.parse((await readFile(s.log, 'utf8')).trim().split('\n').at(-1)!);
      assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write');
    } finally { await s.cleanup(); }
  }
});

test('Claude superseded results and altered evidence cannot become current', async () => {
  const s = await setup();
  try {
    const request = await requestFor(s); let checks = 0;
    const result = await runClaude({ ...request, isCurrent: () => ++checks < 3 }); assert.equal(result.outcome, 'superseded'); assert.equal(result.payload, undefined);
    const controller = new AbortController(); controller.abort('superseded');
    assert.equal((await runClaude({ ...request, signal: controller.signal })).outcome, 'superseded');
    request.sources.files[0]!.text = 'modified'; assert.equal((await runClaude(request)).outcome, 'blocked');
    const config = JSON.parse(await readFile(s.settings, 'utf8')); delete config.profiles.pilot.executable; await writeFile(s.settings, JSON.stringify(config));
    assert.equal((await readProfile(s.settings, 'pilot')).executable, 'claude');
  } finally { await s.cleanup(); }
});

test('interruption during a correction discards an earlier attempt session', async () => {
  const s = await setup('invalid_then_hang', { maxAttempts: 2, timeoutMs: 1000 });
  try {
    const result = await runClaude(await requestFor(s));
    assert.equal(result.outcome, 'timeout'); assert.deepEqual(result.attempts.map(attempt => attempt.outcome), ['invalid_output', 'timeout']);
    assert.equal(result.session, undefined); assert.equal(result.payload, undefined);
  } finally { await s.cleanup(); }
});
