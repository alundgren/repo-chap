import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from '../deploy/pilot/io.mjs';
import { fixture } from './pilot-fixture.mjs';
import { main } from '../deploy/pilot/pilot.mjs';
import { runGuide, scenarios, saveEvidence } from '../deploy/pilot/guide.mjs';
import { generateFixtures } from '../deploy/pilot/fixtures.mjs';

function passingAnswer(run) {
  return async message => {
    if (message.includes('prerequisite checklist')) return 'ready';
    if (message.includes('Type matched')) return 'matched';
    if (message.includes('Type approve')) return `approve ${run.id}`;
    if (message.includes('fixtures-ready')) return 'fixtures-ready';
    if (message.includes('fixtures-clean')) return 'fixtures-clean';
    return 'pass';
  };
}
const evidence = async f => JSON.parse(await readFile(join(f.store.directory(f.run.id), 'evidence.json'), 'utf8'));

test('guided dry run requires no credentials and performs no writes', async t => {
  const f = await fixture(t);
  assert.equal(await main(['run', '--root', f.root, '--run', f.run.id, '--dry-run'], f.accounts, text => f.state.output.push(text)), 0);
  assert.equal(f.state.calls.length, 0);
  assert.match(f.state.output.join('\n'), /Every fixture mutation has its own preview and confirmation/);
  assert.equal((await f.store.load(f.run.id)).guide, undefined);
});

test('complete no-credentials guide uses fake lifecycle, records outcomes and verifies cleanup', async t => {
  const f = await fixture(t);
  assert.equal(await runGuide(f.pilot, f.run, { answer: passingAnswer(f.run), mode: 'rehearsal' }), true);
  assert.equal(f.state.droplets.length, 0);
  assert.equal(f.run.guide.current, 'finished');
  const record = await evidence(f);
  assert.equal(record.mode, 'rehearsal');
  assert.equal(record.fixtureCleanup, 'operator-confirmed');
  assert.deepEqual(record.remainingFailures, []);
  assert.deepEqual(record.verification, { digitalocean: 'absent', github: 'absent', tailscale: 'absent' });
  assert.equal(Object.keys(record.outcomes).length, scenarios.length);
  assert.doesNotMatch(JSON.stringify(record), /fictional-.*secret|example-team|example.ts.net/);
  assert.equal((await stat(join(f.store.directory(f.run.id), 'evidence.json'))).mode & 0o777, 0o600);
});

for (const stage of ['prerequisites', 'offline', 'host', 'fixtures', ...scenarios.map(([id]) => id), 'fixture-cleanup']) {
  test(`failure at ${stage} retains only explicitly, and resume retries the checkpoint`, async t => {
    const f = await fixture(t);
    const pass = passingAnswer(f.run);
    let failed = false;
    const answer = async message => {
      if (!failed && f.run.guide.current === stage) { failed = true; throw new Error('fictional-secret'); }
      return pass(message);
    };
    assert.equal(await runGuide(f.pilot, f.run, { answer, retainOnFailure: true }), false);
    assert.equal(f.run.retained, true);
    assert.equal(f.run.guide.failedAt, stage);
    assert.match(f.state.output.join('\n'), /billing may be ongoing/);
    assert.doesNotMatch(f.state.output.join('\n'), /fictional-secret/);
    const resumed = await f.store.load(f.run.id);
    assert.equal(await runGuide(f.pilot, resumed, { answer: passingAnswer(resumed) }), true);
    assert.equal(resumed.retained, false);
    assert.equal(f.state.droplets.length, 0);
    assert.equal(f.state.calls.filter(call => call.startsWith('terraform apply')).length, 1);
  });
}

test('refusing infrastructure confirmation never applies Terraform', async t => {
  const f = await fixture(t);
  const pass = passingAnswer(f.run);
  assert.equal(await runGuide(f.pilot, f.run, { answer: message => message.includes('Type approve') ? 'yes' : pass(message) }), false);
  assert.ok(!f.state.calls.some(call => call.startsWith('terraform apply')));
  assert.equal((await evidence(f)).failedAt, 'host');
});

test('scenario failure and cancellation clean the VM by default', async t => {
  for (const cancel of [false, true]) {
    const f = await fixture(t);
    const controller = new AbortController();
    f.pilot.signal = controller.signal;
    const pass = passingAnswer(f.run);
    assert.equal(await runGuide(f.pilot, f.run, { answer: message => {
      if (f.run.guide.current === 'ci-recovery') {
        if (cancel) controller.abort();
        return 'fail';
      }
      return pass(message);
    } }), false);
    assert.equal(f.state.droplets.length, 0);
    assert.equal(f.run.stage, 'clean');
    assert.equal((await evidence(f)).fixtureCleanup, 'pending');
  }
});

test('SIGINT in the command entry point still reaches cleanup', async t => {
  const f = await fixture(t);
  f.create(); f.run.stage = 'running';
  await f.store.save(f.run);
  const original = f.accounts.io.command;
  f.accounts.io.command = async (file, args, options) => {
    if (file === 'terraform' && args[0] === 'destroy') process.emit('SIGINT');
    return original(file, args, options);
  };
  // Noninteractive invocation cannot confirm a checkpoint and follows the failure cleanup path.
  assert.equal(await main(['run', '--root', f.root, '--run', f.run.id], f.accounts, () => {}), 1);
  assert.equal(f.state.droplets.length, 0);
});

test('failed cleanup is visible and guided retry never reprovisions', async t => {
  const faults = { delete: true }; const f = await fixture(t, faults);
  assert.equal(await runGuide(f.pilot, f.run, { answer: passingAnswer(f.run) }), false);
  assert.equal(f.run.guide.current, 'cleanup-pending');
  assert.equal((await evidence(f)).verification.digitalocean, 'unresolved');
  faults.delete = false;
  const resumed = await f.store.load(f.run.id);
  assert.equal(await runGuide(f.pilot, resumed, { answer: () => { throw new Error('must not ask'); } }), true);
  assert.equal(f.state.calls.filter(call => call.startsWith('terraform apply')).length, 1);
});

test('explicit cleanup clears guide retention and later run only verifies cleanup', async t => {
  const f = await fixture(t);
  const pass = passingAnswer(f.run);
  await runGuide(f.pilot, f.run, { retainOnFailure: true, answer: message => f.run.guide.current === 'codex' ? 'fail' : pass(message) });
  assert.equal(await main(['cleanup', '--root', f.root, '--run', f.run.id], f.accounts, () => {}), 0);
  const resumed = await f.store.load(f.run.id);
  assert.equal(resumed.retained, false);
  assert.equal(await runGuide(f.pilot, resumed, { answer: () => { throw new Error('no new work'); } }), false);
  assert.equal(f.state.calls.filter(call => call.startsWith('terraform apply')).length, 1);
});

test('generated fixtures target only the selected run and supply guarded cleanup', async t => {
  const f = await fixture(t);
  const directory = await generateFixtures(f.store, f.run);
  const workflow = await readFile(join(directory, 'pilot.yml'), 'utf8');
  assert.match(workflow, new RegExp(`runs-on: \\['${f.run.name}'\\]`));
  const plan = await readFile(join(directory, 'fixture-plan.md'), 'utf8');
  assert.match(plan, /test "\$reply" = "approve \$run"/);
  assert.match(plan, /--jq '\.private'/);
  assert.match(plan, /--force-with-lease="\$ref:\$observed"/);
  assert.doesNotMatch(plan, /gh pr merge|git push --delete|fictional-.*secret/);
  assert.equal(f.state.calls.length, 0);
  await generateFixtures(f.store, f.run);
  assert.equal(await readFile(join(directory, 'fixture-plan.md'), 'utf8'), plan);
});

test('summary rejects arbitrary private outcomes and does not copy raw version output', async t => {
  const f = await fixture(t);
  f.run.guide = { current: 'codex', outcomes: { codex: 'token=fictional-secret' }, mode: 'live' };
  f.run.versions = { observed: 'fictional-secret', codex: 'token=fictional-secret' };
  await saveEvidence(f.pilot, f.run);
  const record = await evidence(f);
  assert.equal(record.outcomes.codex, 'not-tested');
  assert.equal(record.installed.codex, 'unrecorded');
  assert.doesNotMatch(JSON.stringify(record), /fictional-secret/);
});


test('generated CI cases exercise shared classification, waits, handoffs and bounded repair', async t => {
  const { loadWorkflow, replay } = await import('@repo-chap/workflow');
  const pkg = await loadWorkflow('docs/pr-workflows/examples/team-pr/workflow.json');
  const f = await fixture(t);
  const directory = await generateFixtures(f.store, f.run);
  const replayCase = async name => replay(pkg, JSON.parse(await readFile(join(directory, `ci-${name}.json`), 'utf8')));
  for (const name of ['running', 'pending', 'mixed', 'stale', 'unknown', 'incomplete', 'budget']) {
    const result = await replayCase(name);
    assert.ok(!result.proposedEffects.some(effect => effect.uses === 'agent.fix_ci'), name);
  }
  for (const name of ['remote-log-only', 'infrastructure', 'access', 'credential', 'rerun-only']) {
    const result = await replayCase(name);
    assert.ok(result.proposedEffects.some(effect => effect.uses === 'human.publish_packet'), name);
    assert.ok(!result.proposedEffects.some(effect => effect.uses === 'github.push_candidate'), name);
  }
  const recovery = await replayCase('recovery');
  assert.equal(recovery.status, 'waiting');
  assert.ok(recovery.proposedEffects.some(effect => effect.uses === 'github.push_candidate'));
  assert.equal(recovery.decisions.at(-1).ruleId, 'ci_running');
  for (const name of ['changed-head', 'unknown-github', 'unknown-slack']) {
    assert.equal((await replayCase(name)).status, 'blocked', name);
  }
});


test('fixture mutation wrapper refuses unconfirmed, foreign or public targets before writing', async t => {
  const f = await fixture(t);
  const directory = await generateFixtures(f.store, f.run);
  const plan = await readFile(join(directory, 'fixture-plan.md'), 'utf8');
  const block = plan.split('```bash\n')[1].split('```')[0];
  const guard = block.slice(0, block.indexOf('test ! -e'));
  const bin = join(f.root, 'bin'); await mkdir(bin, { mode: 0o700 });
  const calls = join(f.root, 'mutations');
  await writeFile(join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *".id"*) echo "\${FAKE_REPO_ID:-17}" ;;
  *".private"*) echo "\${FAKE_PRIVATE:-true}" ;;
  *) echo mutation >> "$CALLS" ;;
esac
`, { mode: 0o700 });
  await writeFile(join(bin, 'git'), `#!/bin/sh
echo "\${FAKE_REMOTE:-https://github.com/example-team/pilot-test.git}"
`, { mode: 0o700 });
  const script = guard + '\nmutate gh label create "$prefix" --repo "$repo"\n';
  const env = { PATH: `${bin}:${process.env.PATH}`, CALLS: calls };
  for (const [input, extra] of [
    ['yes\n', {}],
    [`approve ${f.run.id}\n`, { FAKE_REPO_ID: '99' }],
    [`approve ${f.run.id}\n`, { FAKE_PRIVATE: 'false' }],
    [`approve ${f.run.id}\n`, { FAKE_REMOTE: 'https://github.com/example-team/another.git' }],
  ]) {
    await assert.rejects(command('bash', ['-c', script], { input, env: { ...env, ...extra } }));
    await assert.rejects(readFile(calls), { code: 'ENOENT' });
  }
  const output = await command('bash', ['-c', script], { input: `approve ${f.run.id}\n`, env });
  assert.match(output, /Proposed command/);
  assert.equal(await readFile(calls, 'utf8'), 'mutation\n');
  for (const match of plan.matchAll(/```bash\n([\s\S]*?)```/g)) await command('bash', ['-n'], { input: match[1] });
});

test('fixture guard resolves separate, multiple and rewritten Git push destinations', async t => {
  const f = await fixture(t);
  const directory = await generateFixtures(f.store, f.run);
  const plan = await readFile(join(directory, 'fixture-plan.md'), 'utf8');
  const block = plan.split('```bash\n')[1].split('```')[0];
  const guard = block.slice(0, block.indexOf('test ! -e'));
  const bin = join(f.root, 'gh-bin'); await mkdir(bin, { mode: 0o700 });
  const calls = join(f.root, 'remote-mutations');
  await writeFile(join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *".id"*) echo 17 ;;
  *".private"*) echo true ;;
  *) echo mutation >> "$CALLS" ;;
esac
`, { mode: 0o700 });
  const approved = 'https://github.com/example-team/pilot-test.git';
  const foreign = 'https://github.com/example-team/another.git';
  const env = { PATH: `${bin}:${process.env.PATH}`, CALLS: calls, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const cases = [
    [['remote.origin.pushurl', foreign]],
    [['remote.origin.pushurl', approved], ['remote.origin.pushurl', foreign]],
    [[`url.${foreign}.pushInsteadOf`, approved]],
    [['remote.origin.pushurl', approved], ['remote.origin.pushurl', approved]],
  ];
  for (const [index, settings] of cases.entries()) {
    const cwd = join(f.root, `repo-${index}`); await mkdir(cwd, { mode: 0o700 });
    await command('git', ['init'], { cwd, env });
    await command('git', ['remote', 'add', 'origin', approved], { cwd, env });
    for (const [key, value] of settings) await command('git', ['config', '--add', key, value], { cwd, env });
    assert.equal((await command('git', ['remote', 'get-url', 'origin'], { cwd, env })).trim(), approved);
    await assert.rejects(command('bash', ['-c', guard + '\nmutate gh label create "$prefix" --repo "$repo"'], {
      cwd, env, input: `approve ${f.run.id}\n`,
    }));
    await assert.rejects(readFile(calls), { code: 'ENOENT' });
  }
});
