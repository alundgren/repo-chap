import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildPackage, canonicalJson, digest } from '@repo-chap/workflow';
import { saveCapture } from '@repo-chap/github';
import { collectSources, runCodex, runProcess } from '@repo-chap/providers';

import { setup, git } from './helpers/provider-fixture.ts';

const root = resolve('.'), cli = join(root, 'apps/cli/dist/cli.js');

test('analyze CLI binds correct code, keeps supported usage separate, and saves a private decision', async () => {
  const s = await setup();
  try {
    await writeFile(join(s.repository, 'src/value.js'), 'uncommitted bytes must not be analyzed\n');
    const result = s.run(); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.json.status, 'completed'); assert.equal(result.json.decision, 'analysis_acceptable');
    assert.equal(result.json.headSha, s.head); assert.equal(result.json.baseSha, s.base);
    assert.equal(result.json.control.memory.reviewCurrent, true);
    const attempt = result.json.results.classify.attempts[0];
    assert.deepEqual(attempt.usage.actual, { inputTokens: 100, cachedInputTokens: 20, outputTokens: 30 });
    assert.equal(attempt.usage.estimated.method, 'utf8_bytes_divided_by_four');
    const inputs = (await readdir(s.output)).find(name => name.startsWith('inputs-'))!;
    const sources = JSON.parse(await readFile(join(s.output, inputs, 'sources.json'), 'utf8'));
    assert.equal(sources.files.find((f: { side: string; path: string }) => f.side === 'head' && f.path === 'src/value.js').text, 'export const value = 2;\n');
    assert.deepEqual(await readdir(dirname(result.json.recordPath)), ['decision.json']);
    const calls: string[][] = (await readFile(s.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls.filter(args => args.includes('exec') && !args.includes('--help')).every(args => args.includes('read-only') && args.includes('--ignore-user-config') && args.includes('never')));
    assert.equal(git(s.repository, 'rev-parse', 'HEAD'), s.head);
  } finally { await s.cleanup(); }
});

for (const mode of ['ambient-global', 'custom-instructions', 'model-instructions', 'skills-error']) test(`Codex rejects ${mode} before sending pinned action inputs`, async () => {
  const s = await setup(mode);
  try {
    const result = s.run(); assert.equal(result.status, 5); assert.equal(result.json.status, 'blocked');
    assert.equal(result.json.results.classify.attempts.length, 0);
    assert.ok(!result.stdout.includes('PRIVATE_'));
    const calls: string[][] = (await readFile(s.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.some(args => args.includes('exec') && !args.includes('--help')), false);
    assert.equal((await readFile(s.settingsLog, 'utf8')).includes('turn/start'), false);
  } finally { await s.cleanup(); }
});

test('Codex native settings inspection shares cancellation and action deadline', async () => {
  for (const cancel of [false, true]) {
    const s = await setup('settings-hang', { timeoutMs: cancel ? 10_000 : 500 });
    const controller = new AbortController();
    const timer = cancel ? setTimeout(() => controller.abort('superseded'), 500) : undefined;
    try {
      const sources = await collectSources(s.repository, s.head, s.base);
      const result = await runCodex({ package: s.pkg, profile: s.profile, actionId: 'classify', mode: 'read', workingDirectory: s.temporary, artifactDirectory: s.output,
        sources, evidence: s.inspection.evidence, evidenceDigest: s.inspection.evidenceDigest, fixtureDigest: 'fixture', missingEvidence: [], signal: controller.signal });
      assert.equal(result.outcome, cancel ? 'superseded' : 'timeout'); assert.equal(result.attempts.length, 0); assert.equal(result.session, undefined);
    } finally { clearTimeout(timer); await s.cleanup(); }
  }
});

test('Codex transient isolation settings invalidate sessions from the earlier adapter', async () => {
  const s = await setup();
  try {
    const first = s.run(); assert.equal(first.status, 0);
    const result = first.json;
    for (const action of ['classify', 'review']) {
      const old = result.results[action];
      old.session.providerDigest = digest(canonicalJson({ provider: 'codex', version: old.providerVersion, profile: s.profile, effectiveEffort: 'medium', authHome: process.env.CODEX_HOME ?? process.env.HOME ?? '', userConfig: 'ignored' }));
    }
    await writeFile(first.json.recordPath, JSON.stringify(result));
    const again = s.run('--resume', first.json.recordPath); assert.equal(again.status, 0);
    assert.equal(again.json.results.classify.attempts[0].resumed, false); assert.equal(again.json.results.review.attempts[0].resumed, false);
    const calls: string[][] = (await readFile(s.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const actions = calls.filter(args => args.includes('exec') && !args.includes('--help'));
    assert.ok(actions.every(args => args.includes('project_doc_max_bytes=0') && args.includes('features.skip_host_skill_discovery=true') && args.some(value => value.startsWith('skills=') && value.includes('"enabled"=false'))));
    const inspections = (await readFile(s.settingsLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(inspections.filter(x => x.method === 'thread/start').every(x => x.params.ephemeral && x.params.config.skills.config.every((skill: { enabled: boolean }) => !skill.enabled)));
  } finally { await s.cleanup(); }
});

for (const mode of ['invalid', 'citation', 'wrong_side', 'wrong_head', 'unsupported', 'flood', 'error']) test(`analyze CLI reports ${mode} without accepting old readiness`, async () => {
  const s = await setup(mode);
  try {
    const result = s.run(); assert.equal(result.status, 5, result.stdout + result.stderr);
    assert.equal(result.json.status, mode === 'unsupported' ? 'blocked' : mode === 'error' ? 'provider_error' : 'invalid_output');
    assert.equal(result.json.control.memory.classificationCurrent, false); assert.equal(result.json.decision, 'incomplete');
    assert.ok(!result.stdout.includes('credential-example-must-not-leak'));
    const attempt = result.json.results.classify.attempts[0];
    if (mode === 'flood') assert.ok(attempt.outputBytes <= s.profile.maxOutputBytes);
    if (mode === 'unsupported') assert.equal((await readFile(s.log, 'utf8')).includes('--bundled'), false);
  } finally { await s.cleanup(); }
});

test('source omissions remain incomplete and a fabricated clear review is rejected', async () => {
  for (const mode of ['valid', 'false_clear']) {
    const s = await setup(mode);
    try {
      await writeFile(join(s.repository, 'asset.bin'), Buffer.from([0, 1, 2])); git(s.repository, 'add', '.'); git(s.repository, 'commit', '-qm', 'Binary asset');
      const head = git(s.repository, 'rev-parse', 'HEAD');
      const inspection = s.inspection; inspection.evidence.pullRequest!.headSha = head; inspection.evidence.revision.headSha = head;
      inspection.evidenceDigest = digest(canonicalJson(inspection.evidence)); inspection.fixture.observations[0]!.headSha = head; inspection.fixture.observations[0]!.evidenceDigest = inspection.evidenceDigest;
      const capture = await saveCapture(join(s.temporary, 'captures'), inspection); s.args[s.args.indexOf('--capture') + 1] = capture.directory;
      const result = s.run(); assert.equal(result.status, mode === 'valid' ? 0 : 5, result.stdout);
      assert.equal(result.json.decision, 'incomplete'); assert.match(result.json.missingEvidence.join(' '), /binary/);
      assert.equal(result.json.results.review.outcome, mode === 'valid' ? 'completed' : 'invalid_output');
    } finally { await s.cleanup(); }
  }
});

test('same inputs resume exact sessions; settings changes start fresh and replacement failure clears readiness', async () => {
  const s = await setup();
  try {
    const first = s.run(); assert.equal(first.status, 0, first.stdout);
    const second = s.run('--resume', first.json.recordPath); assert.equal(second.status, 0, second.stdout);
    assert.ok(Object.values(second.json.results).every((value: any) => value.attempts[0].resumed));
    const calls: string[][] = (await readFile(s.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const resumedCalls = calls.filter(args => args.includes('resume') && !args.includes('--help'));
    assert.equal(resumedCalls.length, 2);
    for (const args of resumedCalls) {
      for (const option of ['--strict-config', '--ignore-user-config', '--config', 'project_doc_max_bytes=0', 'sandbox_mode="read-only"', 'approval_policy="never"'])
        assert.ok(args.indexOf(option) > args.indexOf('resume'), `${option} must apply to the resume subcommand`);
    }
    const config = JSON.parse(await readFile(s.settings, 'utf8')); config.profiles.pilot.effort = 'high'; await writeFile(s.settings, JSON.stringify(config));
    const changed = s.run('--resume', second.json.recordPath); assert.equal(changed.status, 0, changed.stdout);
    assert.ok(Object.values(changed.json.results).every((value: any) => !value.attempts[0].resumed));
    config.profiles.pilot.effort = 'unsupported'; await writeFile(s.settings, JSON.stringify(config));
    const failed = s.run('--resume', first.json.recordPath); assert.equal(failed.status, 5, failed.stdout);
    assert.equal(failed.json.control.memory.reviewCurrent, false); assert.equal(failed.json.control.memory.classificationCurrent, false);
  } finally { await s.cleanup(); }
});

test('timeout and cancellation terminate descendants and save terminal records', async () => {
  for (const mode of ['hang', 'cancel']) {
    const s = await setup(mode, { timeoutMs: mode === 'hang' ? 1000 : 10_000 });
    try {
      const child = spawn(process.execPath, [cli, ...s.args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; child.stdout.on('data', data => stdout += data);
      const exit = new Promise<number | null>(resolve => child.on('close', code => resolve(code)));
      if (mode === 'cancel') {
        for (let i = 0; i < 100; i++) { if (await readFile(s.childPid, 'utf8').catch(() => '')) break; await new Promise(resolve => setTimeout(resolve, 20)); }
        child.kill('SIGINT');
      }
      assert.equal(await exit, mode === 'hang' ? 5 : 130);
      const result = JSON.parse(stdout); assert.equal(result.status, mode === 'hang' ? 'timeout' : 'cancelled');
      const pid = Number(await readFile(s.childPid, 'utf8'));
      const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
      assert.ok(ps.status !== 0 || !ps.stdout.trim() || ps.stdout.trim().startsWith('Z'), `Descendant still active: ${ps.stdout}`);
      assert.deepEqual(await readdir(dirname(result.recordPath)), ['decision.json']);
    } finally { await s.cleanup(); }
  }
});

test('a decision stays running after classification while review is unfinished', async () => {
  const s = await setup('hang_review');
  const child = spawn(process.execPath, [cli, ...s.args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise<number | null>(resolve => child.on('close', code => resolve(code)));
  let stdout = ''; child.stdout.on('data', data => stdout += data);
  try {
    for (let i = 0; i < 200; i++) { if (await readFile(s.marker, 'utf8').catch(() => '') === 'review') break; await new Promise(resolve => setTimeout(resolve, 20)); }
    const directory = (await readdir(s.output)).find(name => name.startsWith('analysis-'))!;
    const pending = JSON.parse(await readFile(join(s.output, directory, 'decision.json'), 'utf8'));
    assert.equal(pending.status, 'running'); assert.equal(pending.control.memory.classificationCurrent, true); assert.equal(pending.control.memory.reviewCurrent, false);
    child.kill('SIGINT'); assert.equal(await exit, 130); assert.equal(JSON.parse(stdout).status, 'cancelled');
  } finally { child.kill('SIGINT'); await exit; await s.cleanup(); }
});

test('lost sessions get one fresh bounded attempt and superseded results are discarded', async () => {
  const s = await setup('lost', { maxAttempts: 2 });
  try {
    const sources = await collectSources(s.repository, s.head, s.base);
    const request = { package: s.pkg, profile: s.profile, actionId: 'classify', mode: 'read' as const, workingDirectory: s.temporary, artifactDirectory: s.output,
      sources, evidence: s.inspection.evidence, evidenceDigest: s.inspection.evidenceDigest, fixtureDigest: digest(canonicalJson(s.inspection.fixture)), missingEvidence: [] };
    const first = await runCodex(request); assert.equal(first.outcome, 'completed');
    const changedEvidence = { ...s.inspection.evidence, configuredReviewers: ['willow-bot'] };
    const incompatible = await runCodex({ ...request, session: first.session, evidence: changedEvidence, evidenceDigest: digest(canonicalJson(changedEvidence)) });
    assert.equal(incompatible.outcome, 'completed'); assert.equal(incompatible.attempts[0]!.resumed, false);
    const resumed = await runCodex({ ...request, session: first.session });
    assert.equal(resumed.outcome, 'completed'); assert.equal(resumed.attempts.length, 2);
    assert.deepEqual(resumed.attempts.map(attempt => attempt.resumed), [true, false]);
    let checks = 0;
    const stale = await runCodex({ ...request, isCurrent: () => ++checks < 3 });
    assert.equal(stale.outcome, 'superseded'); assert.equal(stale.payload, undefined);
    const controller = new AbortController(); controller.abort('superseded');
    assert.equal((await runCodex({ ...request, signal: controller.signal })).outcome, 'superseded');
  } finally { await s.cleanup(); }
});

test('invalid output correction stays within its configured attempt budget', async () => {
  const s = await setup('invalid', { maxAttempts: 2 });
  try {
    const result = s.run(); assert.equal(result.status, 5); assert.equal(result.json.results.classify.attempts.length, 2);
    assert.equal(result.json.results.review, undefined); assert.equal(result.json.control.memory.classificationCurrent, false);
  } finally { await s.cleanup(); }
});

test('comparison base is pinned to the common ancestor, not later target-branch commits', async () => {
  const s = await setup();
  try {
    git(s.repository, 'checkout', '--detach', s.base); await writeFile(join(s.repository, 'target-only.js'), 'export const baseOnly = true;\n');
    git(s.repository, 'add', '.'); git(s.repository, 'commit', '-qm', 'Target advances'); const target = git(s.repository, 'rev-parse', 'HEAD');
    const sources = await collectSources(s.repository, s.head, target);
    assert.equal(sources.baseSha, target); assert.equal(sources.comparisonBaseSha, s.base); assert.ok(!sources.diff!.text.includes('target-only.js'));
    assert.ok(sources.files.filter(file => file.side === 'base').every(file => file.revision === s.base));
  } finally { await s.cleanup(); }
});

test('bounded process wrapper handles stderr overflow, launch failure, and descendants after normal parent exit', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'repo-chap-process-'));
  try {
    const bounded = await runProcess(process.execPath, ['-e', 'process.stderr.write("x".repeat(10000));setInterval(()=>{},1000)'], { cwd: temporary, timeoutMs: 2000, maxBytes: 100 });
    assert.equal(bounded.status, 'output_limit'); assert.equal(bounded.stderr.length, 100);
    const missing = await runProcess(join(temporary, 'missing'), [], { cwd: temporary, timeoutMs: 100, maxBytes: 100 }); assert.equal(missing.status, 'provider_error');
    const orphan = await runProcess(process.execPath, ['-e', 'const cp=require("node:child_process");const c=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(c.pid);c.unref();'], { cwd: temporary, timeoutMs: 2000, maxBytes: 100 });
    assert.equal(orphan.status, 'exited');
    const ps = spawnSync('ps', ['-o', 'stat=', '-p', orphan.stdout.toString().trim()], { encoding: 'utf8' });
    assert.ok(ps.status !== 0 || !ps.stdout.trim() || ps.stdout.trim().startsWith('Z'));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('canonical contracts cannot be relaxed and configured contracts can tighten results', async () => {
  for (const mode of ['invalid', 'valid']) {
    const s = await setup(mode);
    try {
      const files = Object.fromEntries(s.pkg.files.map(file => [file.path, file.text]));
      const schemaPath = 'docs/pr-workflows/schemas/results.schema.json';
      const schema = JSON.parse(files[schemaPath]!);
      schema.$defs.classification = mode === 'invalid' ? {} : { ...schema.$defs.classification, properties: { ...schema.$defs.classification.properties, uncertain: { const: true } } };
      files[schemaPath] = JSON.stringify(schema);
      const pkg = buildPackage(s.pkg.workflowPath, files);
      const result = await runCodex({ package: pkg, profile: s.profile, actionId: 'classify', mode: 'read', workingDirectory: s.temporary, artifactDirectory: s.output,
        sources: await collectSources(s.repository, s.head, s.base), evidence: s.inspection.evidence, evidenceDigest: s.inspection.evidenceDigest,
        fixtureDigest: digest(canonicalJson(s.inspection.fixture)), missingEvidence: [] });
      assert.equal(result.outcome, 'invalid_output'); assert.equal(result.attempts.length, 1);
      assert.equal(result.attempts[0]!.usage.actual!.inputTokens, 100);
    } finally { await s.cleanup(); }
  }
});

test('workspace actions use the same adapter and missing usage remains unknown', async () => {
  const s = await setup('no_usage');
  try {
    const request = { package: s.pkg, profile: s.profile, actionId: 'resolve_conflict', mode: 'workspace' as const, workingDirectory: s.temporary, artifactDirectory: s.output,
      sources: await collectSources(s.repository, s.head, s.base), evidence: s.inspection.evidence, evidenceDigest: s.inspection.evidenceDigest,
      fixtureDigest: digest(canonicalJson(s.inspection.fixture)), missingEvidence: [] };
    const blockedRead = await runCodex({ ...request, mode: 'read' }); assert.equal(blockedRead.outcome, 'blocked'); assert.equal(blockedRead.attempts.length, 0);
    const result = await runCodex(request); assert.equal(result.outcome, 'blocked'); assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0]!.usage.actual, null); assert.ok(result.attempts[0]!.usage.estimated.inputTokens > 0);
    const calls: string[][] = (await readFile(s.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls.some(args => args.includes('workspace-write')));
  } finally { await s.cleanup(); }
});

test('input contents are checked against their revisions and digest before any provider call', async () => {
  const s = await setup();
  try {
    const sources = await collectSources(s.repository, s.head, s.base);
    sources.files[0]!.text = 'modified evidence';
    const result = await runCodex({ package: s.pkg, profile: s.profile, actionId: 'classify', mode: 'read', workingDirectory: s.temporary, artifactDirectory: s.output,
      sources, evidence: s.inspection.evidence, evidenceDigest: s.inspection.evidenceDigest, fixtureDigest: digest(canonicalJson(s.inspection.fixture)), missingEvidence: [] });
    assert.equal(result.outcome, 'blocked'); assert.equal(result.attempts.length, 0);
    assert.equal(await readFile(s.log, 'utf8').catch(() => ''), '');
  } finally { await s.cleanup(); }
});

test('capture mismatch and unavailable Git objects block the public command without provider execution', async () => {
  const s = await setup();
  try {
    s.args[s.args.indexOf('--source-repo') + 1] = join(s.temporary, 'no-repository');
    const missing = s.run(); assert.equal(missing.status, 5); assert.equal(missing.json.status, 'blocked');
    assert.match(missing.json.missingEvidence.join(' '), /common ancestor/);
    const fixture = JSON.parse(await readFile(s.capture.fixture, 'utf8')); fixture.now = '2026-01-02T00:00:00.000Z';
    await writeFile(s.capture.fixture, JSON.stringify(fixture));
    const mismatch = s.run(); assert.equal(mismatch.status, 5); assert.match(mismatch.json.diagnostics[0].message, /digests/);
    assert.equal(await readFile(s.log, 'utf8').catch(() => ''), '');
  } finally { await s.cleanup(); }
});

test('public analysis preserves UTF-8 BOM bytes in source evidence and Git blob identity', async () => {
  const s = await setup();
  try {
    const text = '\ufeffexport const value = 3;\n'; await writeFile(join(s.repository, 'src/value.js'), text);
    git(s.repository, 'commit', '-qam', 'Preserve text bytes'); const head = git(s.repository, 'rev-parse', 'HEAD');
    s.inspection.evidence.pullRequest!.headSha = head; s.inspection.evidence.revision.headSha = head;
    s.inspection.evidenceDigest = digest(canonicalJson(s.inspection.evidence));
    s.inspection.fixture.observations[0]!.headSha = head; s.inspection.fixture.observations[0]!.evidenceDigest = s.inspection.evidenceDigest;
    const capture = await saveCapture(join(s.temporary, 'captures'), s.inspection); s.args[s.args.indexOf('--capture') + 1] = capture.directory;
    const result = s.run(); assert.equal(result.status, 0, result.stdout); assert.equal(result.json.decision, 'analysis_acceptable');
    const inputs = (await readdir(s.output)).find(name => name.startsWith('inputs-'))!;
    const source = JSON.parse(await readFile(join(s.output, inputs, 'sources.json'), 'utf8'));
    assert.equal(source.files.find((file: { path: string; side: string }) => file.path === 'src/value.js' && file.side === 'head').text, text);
    assert.deepEqual(source.missingEvidence, []);
  } finally { await s.cleanup(); }
});

test('public analysis supplies a restricted workflow label set to the provider', async () => {
  const s = await setup();
  try {
    const authored = join(s.temporary, 'authored'); s.args.push('--repo-root', authored);
    for (const allowedLabels of [['tests'], []]) {
      const files = Object.fromEntries(s.pkg.files.map(file => [file.path, file.text]));
      const workflow = JSON.parse(files[s.pkg.workflowPath]!); workflow.labels = allowedLabels; files[s.pkg.workflowPath] = JSON.stringify(workflow);
      const pkg = buildPackage(s.pkg.workflowPath, files);
      for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(authored, path)), { recursive: true }); await writeFile(join(authored, path), text); }
      s.inspection.packageDigest = pkg.digest;
      const capture = await saveCapture(join(s.temporary, 'captures'), s.inspection); s.args[s.args.indexOf('--capture') + 1] = capture.directory;
      s.args[1] = join(authored, pkg.workflowPath);
      const result = s.run(); assert.equal(result.status, 0, result.stdout); assert.deepEqual(result.json.results.classify.payload.labels.map((label: { name: string }) => label.name), allowedLabels);
    }
  } finally { await s.cleanup(); }
});
