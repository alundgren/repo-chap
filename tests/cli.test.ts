import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const cli = join(root, 'apps/cli/dist/cli.js');
const workflow = join(root, 'docs/pr-workflows/examples/team-pr/workflow.json');
const environment = { PATH: process.env.PATH, HOME: tmpdir(), LANG: 'C' };
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: environment });

test('CLI returns versioned JSON and usable text without credentials', () => {
  const valid = run('validate', workflow, '--json');
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).valid, true);
  const replay = run('replay', workflow, '--fixture', 'fixtures/replay/review-wait.json');
  assert.equal(replay.status, 0, replay.stderr);
  assert.match(replay.stdout, /Rule reviewer_active: true \(selected\)/);
  assert.match(replay.stdout, /Next wake 2026-05-01T12:05:00.000Z/);
});

test('CLI distinguishes command, workflow and fixture failures with JSON diagnostics', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'repo-chap-cli-'));
  try {
    const malformed = join(temporary, 'bad.json'); await writeFile(malformed, '{');
    for (const [code, args] of [
      [64, ['merge', workflow, '--json']],
      [64, ['replay', workflow, '--json']],
      [2, ['validate', malformed, '--repo-root', temporary, '--json']],
      [3, ['replay', workflow, '--fixture', malformed, '--json']],
    ] as [number, string[]][]) {
      const output = run(...args); assert.equal(output.status, code, output.stderr);
      assert.equal(JSON.parse(output.stdout).exitCode, code);
      assert.ok(JSON.parse(output.stdout).diagnostics.length);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('packed and installed repo-chap runs independently of workspace dependencies', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'repo-chap-install-'));
  try {
    const pack = spawnSync('vp', ['pm', 'pack', '--filter', 'repo-chap', '--pack-destination', temporary], { cwd: root, encoding: 'utf8' });
    assert.equal(pack.status, 0, pack.stderr || pack.stdout);
    const archive = (await readdir(temporary)).find(name => name.endsWith('.tgz'))!;
    await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@11.22.0', dependencies: { 'repo-chap': `file:${archive}` } }));
    const install = spawnSync('vp', ['install', '--offline', '--ignore-scripts'], { cwd: temporary, encoding: 'utf8' });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    const installed = join(temporary, 'node_modules/.bin/repo-chap');
    const validation = spawnSync(installed, ['validate', workflow, '--json'], { cwd: temporary, encoding: 'utf8', env: environment });
    assert.equal(validation.status, 0, validation.stderr);
    assert.equal(JSON.parse(validation.stdout).valid, true);
    for (const name of ['conflict', 'review-wait', 'incomplete-evidence', 'suppressed-repair', 'handoff']) {
      const result = spawnSync(installed, ['replay', workflow, '--fixture', join(root, `fixtures/replay/${name}.json`), '--json'], { cwd: temporary, encoding: 'utf8', env: environment });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).schemaVersion, 1);
      assert.ok(JSON.parse(result.stdout).decisions.length);
    }
    const manifest = JSON.parse(await readFile(join(temporary, 'node_modules/repo-chap/package.json'), 'utf8'));
    assert.equal(manifest.dependencies, undefined);
    const skills = join(temporary, 'global-skills');
    const skillInstall = spawnSync(installed, ['skill', 'install', '--directory', skills], { cwd: temporary, encoding: 'utf8', env: environment });
    assert.equal(skillInstall.status, 0, skillInstall.stderr);
    const skill = join(skills, 'repo-chap-workflows');
    const starter = join(skill, 'assets/workflow.json'), closed = join(skill, 'assets/closed.json');
    const skillReplay = spawnSync(installed, ['replay', starter, '--repo-root', skill, '--fixture', closed, '--json'], { cwd: temporary, encoding: 'utf8', env: environment });
    assert.equal(skillReplay.status, 0, skillReplay.stderr);
    assert.equal(JSON.parse(skillReplay.stdout).comparison.passed, true);
    const customized = '# A local skill change\n'; await writeFile(join(skill, 'SKILL.md'), customized);
    const repeated = spawnSync(installed, ['skill', 'install', '--directory', skills], { cwd: temporary, encoding: 'utf8', env: environment });
    assert.equal(repeated.status, 64); assert.equal(await readFile(join(skill, 'SKILL.md'), 'utf8'), customized);
    const replace = spawnSync(installed, ['skill', 'install', '--directory', skills, '--replace'], { cwd: temporary, encoding: 'utf8', env: environment });
    assert.equal(replace.status, 0, replace.stderr);
    assert.notEqual(await readFile(join(skill, 'SKILL.md'), 'utf8'), customized);
    for (const name of ['workflow', 'fixture', 'results']) {
      const schema = spawnSync(installed, ['schema', name], { cwd: temporary, encoding: 'utf8', env: environment });
      assert.equal(schema.status, 0, schema.stderr); assert.equal(JSON.parse(schema.stdout).$schema, 'https://json-schema.org/draft/2020-12/schema');
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
