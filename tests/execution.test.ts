import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildPackage, canonicalJson, digest } from '@repo-chap/workflow';
import { saveCapture } from '@repo-chap/github';
import { createRepairJob, readArtifact, readRepairAttempt, readRepairResult, restoreCandidate, runRepair, type ExecutionPolicy } from '@repo-chap/execution';
import { setup as providerFixture, git } from './helpers/provider-fixture.ts';

async function setup(provider: 'codex' | 'claude' = 'codex', mode = 'valid', conflict = false) {
  const s = await providerFixture('valid', { provider });
  await writeFile(join(s.repository, 'AGENTS.md'), 'Keep the exported value numeric. Use the supplied review intent.\n');
  git(s.repository, 'add', 'AGENTS.md'); git(s.repository, 'commit', '-qm', 'Repository instructions'); s.head = git(s.repository, 'rev-parse', 'HEAD');
  s.inspection.evidence.pullRequest!.headSha = s.head; s.inspection.evidence.revision.headSha = s.head; s.inspection.fixture.observations[0]!.headSha = s.head;
  if (conflict) {
    git(s.repository, 'checkout', '--detach', s.base);
    await writeFile(join(s.repository, 'src/value.js'), 'export const value = 4;\n');
    git(s.repository, 'commit', '-qam', 'Base advances'); s.base = git(s.repository, 'rev-parse', 'HEAD');
    git(s.repository, 'checkout', '--detach', s.head);
    s.inspection.evidence.pullRequest!.baseSha = s.base; s.inspection.evidence.pullRequest!.mergeability = 'conflicting';
    s.inspection.evidence.revision.baseSha = s.base; s.inspection.fixture.observations[0]!.baseSha = s.base;
    s.inspection.fixture.observations[0]!.facts.conflict = true;
  } else {
    s.inspection.evidence.threads.items.push({ id: 'THREAD_value', resolved: false, outdated: false, path: 'src/value.js', line: 1,
      comments: { coverage: { status: 'complete', pages: 1 }, items: [{ id: 'COMMENT_value', author: 'river', body: 'Use value three.', headSha: s.head, createdAt: '2026-01-01T00:00:00Z' }] } });
    s.inspection.fixture.observations[0]!.facts.unaddressedReview = true;
  }
  s.inspection.evidenceDigest = digest(canonicalJson(s.inspection.evidence)); s.inspection.fixture.observations[0]!.evidenceDigest = s.inspection.evidenceDigest;
  const capture = await saveCapture(join(s.temporary, 'captures'), s.inspection);
  await writeFile(s.executable, `#!${process.execPath}\nglobal.fixture=${JSON.stringify({ provider, mode, log: s.log, marker: s.marker, childPid: s.childPid })};\nrequire(${JSON.stringify(resolve('tests/helpers/fake-repair.cjs'))});\n`, { mode: 0o700 });
  const policy: ExecutionPolicy = { schemaVersion: 1, allowedPaths: ['src'], excludedPaths: ['src/generated'], requiredChecks: [{ id: 'value', executable: process.execPath,
    args: ['-e', 'const fs=require("node:fs"),cp=require("node:child_process");if(cp.execFileSync("git",["rev-parse","HEAD"]).toString().trim()!==process.env.REPO_CHAP_CANDIDATE_SHA)process.exit(8);if(fs.readFileSync("src/value.js","utf8")!=="export const value = 3;\\n")process.exit(9);'], timeoutMs: 5000, maxOutputBytes: 64 * 1024 }] };
  const policyFile = join(s.temporary, 'execution.json'); await writeFile(policyFile, JSON.stringify(policy));
  const action = conflict ? 'resolve_conflict' : 'address';
  const job = () => createRepairJob(s.pkg, s.inspection, s.profile, policy, action);
  const options = { sourceRepository: s.repository, artifactDirectory: s.output, profile: s.profile };
  const args = ['workspace', resolve('docs/pr-workflows/examples/team-pr/workflow.json'), '--capture', capture.directory, '--source-repo', s.repository, '--output-dir', s.output,
    '--provider-config', s.settings, '--profile', 'pilot', '--execution-policy', policyFile, '--action', action, '--json'];
  return { ...s, policy, policyFile, job, options, args };
}

for (const provider of ['codex', 'claude'] as const) for (const conflict of [false, true]) test(`${provider} local ${conflict ? 'conflict' : 'review'} repair retains exact tested commit after checkout removal`, async () => {
  const s = await setup(provider, 'valid', conflict);
  try {
    await writeFile(join(s.repository, 'src/value.js'), 'original dirty work must remain\n');
    const job = JSON.parse(JSON.stringify(s.job())), { result, reference } = await runRepair(job, s.options);
    assert.equal(result.status, 'candidate', result.diagnostic); assert.equal(result.requiredChecksPassed, true);
    assert.equal(result.payload!.outcome, 'candidate'); const sha = result.candidate!.sha;
    assert.notEqual(sha, s.head); assert.equal(result.checks[0]!.candidateSha, sha); assert.equal((result.payload as any).candidateSha, sha);
    assert.deepEqual(result.candidate!.parents, conflict ? [s.head, s.base] : [s.head]);
    const invocation = JSON.parse(await readFile(s.marker, 'utf8')); assert.equal(invocation.remotes, '');
    assert.ok(!JSON.stringify(result).includes(invocation.cwd)); assert.ok(!(await readdir(s.output)).some(name => name.startsWith('worker-')));
    assert.equal(git(s.repository, 'rev-parse', 'HEAD'), s.head); assert.equal(await readFile(join(s.repository, 'src/value.js'), 'utf8'), 'original dirty work must remain\n');
    assert.deepEqual(await readRepairResult(s.output, reference), result);
    const receipt = await readRepairAttempt(s.output, job.attemptId); assert.equal(receipt.state, 'completed');
    const providerArgs: string[][] = (await readFile(s.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    if (provider === 'claude') { const args = providerArgs.find(args => args.includes('--print'))!; assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write'); }
    await rm(s.repository, { recursive: true });
    const restored = join(s.temporary, 'restored'); await restoreCandidate(s.output, reference, restored);
    assert.equal(git(restored, 'rev-parse', 'HEAD'), sha); assert.equal(git(restored, 'rev-parse', 'HEAD^{tree}'), result.candidate!.tree);
    assert.equal(git(restored, 'show', '-s', '--format=%P', 'HEAD'), result.candidate!.parents.join(' '));
    assert.equal(await readFile(join(restored, 'src/value.js'), 'utf8'), 'export const value = 3;\n');
    assert.ok((await readArtifact(s.output, result.candidate!.patch)).toString().includes('+export const value = 3;'));
    await assert.rejects(runRepair(job, s.options), /already exists/);
  } finally { await s.cleanup(); }
});

for (const mode of ['blocked', 'no_change', 'blocked_thread', 'declined']) test(`workspace preserves ${mode} decisions without a candidate or checks`, async () => {
  const s = await setup('codex', mode);
  try {
    const { result } = await runRepair(s.job(), s.options);
    assert.equal(result.status, mode === 'no_change' ? 'no_change' : 'blocked', result.diagnostic);
    assert.equal(result.candidate, undefined); assert.equal(result.checks.length, 0); assert.equal(result.requiredChecksPassed, false);
    assert.ok(result.payload?.threads[0]?.response); assert.equal(result.payload?.threads[0]?.disposition, mode === 'no_change' || mode === 'declined' ? 'declined' : 'blocked');
  } finally { await s.cleanup(); }
});
for (const mode of ['wrong_paths', 'outside_policy', 'symlink', 'changed_head', 'missing_thread', 'foreign_thread', 'bad_ref']) test(`workspace rejects ${mode} without provider-specific candidate rules`, async () => {
  const s = await setup('claude', mode);
  try { const { result } = await runRepair(s.job(), s.options); assert.equal(result.status, 'invalid_output', result.diagnostic); assert.equal(result.candidate, undefined); assert.equal(result.requiredChecksPassed, false); }
  finally { await s.cleanup(); }
});

test('required failure cannot be replaced by provider suggestions and later checks are skipped', async () => {
  const s = await setup();
  try {
    s.policy.requiredChecks[0]!.args = ['-e', 'process.exit(1)'];
    s.policy.requiredChecks.push({ ...s.policy.requiredChecks[0]!, id: 'later', args: ['-e', 'throw new Error("must not run")'] });
    const { result } = await runRepair(s.job(), s.options);
    assert.equal(result.status, 'checks_failed'); assert.equal(result.requiredChecksPassed, false); assert.ok(result.candidate);
    assert.deepEqual(result.checks.map(check => check.status), ['failed', 'skipped']); assert.equal(result.checks[0]!.exitCode, 1);
    assert.ok(result.checks.every(check => check.candidateSha === result.candidate!.sha));
  } finally { await s.cleanup(); }
});

test('a passing command that changes the finalized checkout fails validation', async () => {
  const s = await setup();
  try {
    s.policy.requiredChecks[0]!.args = ['-e', 'require("node:fs").writeFileSync("src/value.js","changed after commit")'];
    const { result } = await runRepair(s.job(), s.options); assert.equal(result.status, 'checks_failed'); assert.match(result.checks[0]!.diagnostic, /changed/);
  } finally { await s.cleanup(); }
});

test('required commands have bounded output and timeout receipts', async () => {
  for (const mode of ['output_limit', 'timeout']) {
    const s = await setup();
    try {
      s.policy.requiredChecks[0]!.args = ['-e', mode === 'output_limit' ? 'process.stdout.write("x".repeat(100000));setInterval(()=>{},1000)' : 'setInterval(()=>{},1000)'];
      s.policy.requiredChecks[0]!.timeoutMs = 300;
      const { result } = await runRepair(s.job(), s.options); assert.equal(result.status, 'checks_failed'); assert.equal(result.checks[0]!.status, mode);
      assert.ok(result.checks[0]!.log!.bytes <= s.policy.requiredChecks[0]!.maxOutputBytes);
    } finally { await s.cleanup(); }
  }
});

test('host finalization revalidates the configured candidate contract', async () => {
  const s = await setup();
  try {
    const files = Object.fromEntries(s.pkg.files.map(file => [file.path, file.text])); const path = 'docs/pr-workflows/schemas/results.schema.json';
    const schema = JSON.parse(files[path]!); schema.$defs.candidate.oneOf[0].properties.candidateSha = { const: s.head }; files[path] = JSON.stringify(schema);
    const pkg = buildPackage(s.pkg.workflowPath, files), inspection = structuredClone(s.inspection); inspection.packageDigest = pkg.digest;
    const job = createRepairJob(pkg, inspection, s.profile, s.policy, 'address');
    const { result } = await runRepair(job, s.options); assert.equal(result.status, 'invalid_output'); assert.match(result.diagnostic, /host-finalized/); assert.equal(result.candidate, undefined); assert.equal(result.requiredChecksPassed, false);
  } finally { await s.cleanup(); }
});

test('jobs reject mismatched policy, profile, evidence and empty required checks before starting work', async () => {
  const s = await setup();
  try {
    for (const field of ['policyDigest', 'profileDigest'] as const) { const job = s.job(); job[field] = 'wrong'; await assert.rejects(runRepair(job, s.options), /changed/); }
    const job = s.job(); job.inspection.evidence.pullRequest!.headSha = 'a'.repeat(40); await assert.rejects(runRepair(job, s.options), /match/);
    s.policy.requiredChecks = []; assert.throws(s.job, /requiredChecks/); assert.equal(await readFile(s.marker, 'utf8').catch(() => ''), '');
  } finally { await s.cleanup(); }
});

test('incomplete or stale captures do not start a provider or produce a candidate', async () => {
  const s = await setup();
  try {
    s.inspection.evidence.revision.status = 'changed'; s.inspection.evidenceDigest = digest(canonicalJson(s.inspection.evidence)); s.inspection.fixture.observations[0]!.evidenceDigest = s.inspection.evidenceDigest;
    const { result } = await runRepair(s.job(), s.options); assert.equal(result.status, 'blocked'); assert.equal(result.provider, undefined);
  } finally { await s.cleanup(); }
});

test('lost ownership after a successful command cannot become a successful candidate', async () => {
  const s = await setup();
  try {
    const proof = join(s.temporary, 'ownership-lost');
    s.policy.requiredChecks[0]!.args = ['-e', `require('node:fs').writeFileSync(${JSON.stringify(proof)},'lost')`];
    const { result } = await runRepair(s.job(), { ...s.options, isCurrent: async () => !await readFile(proof, 'utf8').catch(() => '') });
    assert.equal(result.status, 'superseded'); assert.equal(result.requiredChecksPassed, false);
  } finally { await s.cleanup(); }
});

test('logical artifacts reject corrupted bytes after worker removal', async () => {
  const s = await setup();
  try {
    const { result } = await runRepair(s.job(), s.options); const bundle = result.candidate!.bundle;
    const bytes = await readFile(join(s.output, bundle.id)); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; await writeFile(join(s.output, bundle.id), bytes);
    await assert.rejects(readArtifact(s.output, bundle), /digest/);
  } finally { await s.cleanup(); }
});

test('public workspace CLI prints serializable local results and clear exit statuses', async () => {
  for (const mode of ['valid', 'blocked', 'no_change']) {
    const s = await setup('claude', mode);
    try {
      const child = spawnSync(process.execPath, [resolve('apps/cli/dist/cli.js'), ...s.args], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(child.status, mode === 'blocked' ? 6 : 0, child.stdout + child.stderr); const result = JSON.parse(child.stdout);
      assert.equal(result.status, mode === 'valid' ? 'candidate' : mode); assert.ok(result.resultReference.id); assert.equal(result.headSha, s.head);
    } finally { await s.cleanup(); }
  }
});

test('public workspace cancellation and deadline kill descendants, retain terminal results, and remove checkouts', async () => {
  for (const provider of ['codex', 'claude'] as const) for (const mode of ['cancel', 'hang']) {
    const s = await setup(provider, mode);
    const settings = JSON.parse(await readFile(s.settings, 'utf8')); settings.profiles.pilot.timeoutMs = mode === 'hang' ? 800 : 10_000; await writeFile(s.settings, JSON.stringify(settings));
    const child = spawn(process.execPath, [resolve('apps/cli/dist/cli.js'), ...s.args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exit = new Promise<number | null>(resolve => child.on('close', resolve)); let output = ''; child.stdout.on('data', bytes => output += bytes);
    try {
      if (mode === 'cancel') {
        for (let attempt = 0; attempt < 150; attempt++) { if (await readFile(s.childPid, 'utf8').catch(() => '')) break; await new Promise(resolve => setTimeout(resolve, 20)); }
        child.kill('SIGINT');
      }
      assert.equal(await exit, mode === 'cancel' ? 130 : 6, output); const result = JSON.parse(output);
      assert.equal(result.status, mode === 'cancel' ? 'cancelled' : 'timeout'); assert.equal(result.requiredChecksPassed, false);
      const pid = (await readFile(s.childPid, 'utf8')).trim(), ps = spawnSync('ps', ['-o', 'stat=', '-p', pid], { encoding: 'utf8' });
      assert.ok(ps.status !== 0 || !ps.stdout.trim() || ps.stdout.trim().startsWith('Z'));
      assert.ok(!(await readdir(s.output)).some(name => name.startsWith('worker-')));
      assert.equal((await readRepairResult(s.output, result.resultReference)).status, result.status);
    } finally { child.kill('SIGINT'); await exit; await s.cleanup(); }
  }
});

test('unresolved conflict markers are rejected before candidate creation', async () => {
  const s = await setup('codex', 'leftover_conflict', true);
  try { const { result } = await runRepair(s.job(), s.options); assert.equal(result.status, 'invalid_output'); assert.match(result.diagnostic, /markers/); assert.equal(result.candidate, undefined); }
  finally { await s.cleanup(); }
});

test('excluded path boundaries are enforced independently of allowed parent directories', async () => {
  const s = await setup();
  try { s.policy.excludedPaths = ['src/value.js']; const { result } = await runRepair(s.job(), s.options); assert.equal(result.status, 'invalid_output'); assert.equal(result.candidate, undefined); }
  finally { await s.cleanup(); }
});

test('required check timeout cleans descendants and recovery never overwrites existing files', async () => {
  const s = await setup();
  try {
    s.policy.requiredChecks[0]!.args = ['-e', `const cp=require('node:child_process'),fs=require('node:fs');const child=cp.spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(s.childPid)},String(child.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`];
    s.policy.requiredChecks[0]!.timeoutMs = 500;
    const { result, reference } = await runRepair(s.job(), s.options); assert.equal(result.status, 'checks_failed'); assert.equal(result.checks[0]!.status, 'timeout');
    const pid = (await readFile(s.childPid, 'utf8')).trim(), ps = spawnSync('ps', ['-o', 'stat=', '-p', pid], { encoding: 'utf8' });
    assert.ok(ps.status !== 0 || !ps.stdout.trim() || ps.stdout.trim().startsWith('Z'));
    const destination = join(s.temporary, 'occupied'); await mkdir(destination, { mode: 0o700 }); await writeFile(join(destination, 'keep'), 'original');
    await assert.rejects(restoreCandidate(s.output, reference, destination), /empty/); assert.equal(await readFile(join(destination, 'keep'), 'utf8'), 'original');
  } finally { await s.cleanup(); }
});

test('an expired serializable deadline stops before checkout or provider creation', async () => {
  const s = await setup();
  try { const job = s.job(); job.deadline = '2026-01-01T00:00:00Z'; const { result } = await runRepair(job, s.options); assert.equal(result.status, 'timeout'); assert.equal(result.provider, undefined); assert.equal(result.candidate, undefined); }
  finally { await s.cleanup(); }
});

for (const provider of ['codex', 'claude'] as const) test(`${provider} conflict repair can retain the PR tree in a new tested two-parent commit`, async () => {
  const s = await setup(provider, 'keep_head', true);
  try {
    s.policy.requiredChecks[0]!.args[1] = s.policy.requiredChecks[0]!.args[1]!.replace('value = 3', 'value = 2');
    const originalTree = git(s.repository, 'rev-parse', `${s.head}^{tree}`);
    const { result, reference } = await runRepair(s.job(), s.options);
    assert.equal(result.status, 'candidate', result.diagnostic); assert.equal(result.requiredChecksPassed, true);
    assert.equal(result.candidate!.tree, originalTree); assert.notEqual(result.candidate!.sha, s.head);
    assert.deepEqual(result.candidate!.parents, [s.head, s.base]); assert.deepEqual((result.payload as any).changedPaths, []);
    assert.equal(result.checks[0]!.candidateSha, result.candidate!.sha); assert.equal(result.checks[0]!.status, 'passed');
    assert.equal((await readArtifact(s.output, result.candidate!.patch)).length, 0);
    const restored = join(s.temporary, 'restored'); await restoreCandidate(s.output, reference, restored);
    assert.equal(git(restored, 'rev-parse', 'HEAD'), result.candidate!.sha);
    assert.equal(git(restored, 'show', '-s', '--format=%P', 'HEAD'), `${s.head} ${s.base}`);
    assert.equal(git(restored, 'rev-parse', 'HEAD^{tree}'), originalTree);
  } finally { await s.cleanup(); }
});
