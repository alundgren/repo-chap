import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivate } from '../deploy/pilot/store.mjs';
import { journey } from './pilot-journey-fixture.mjs';

async function created(t) {
  const f = await journey(t);
  assert.deepEqual(f.remote.pulls, []);
  assert.deepEqual(f.remote.runs, []);
  assert.equal(await f.invoke('create'), 0, f.state.output.join('\n'));
  f.id = await f.store.current();
  return f;
}

test('fresh production dispatcher completes create, test and delete without operator fixture state', async t => {
  const f = await created(t);
  assert.equal(await f.invoke('test'), 0, f.state.output.join('\n'));
  const run = await f.store.load(f.id);
  assert.equal(Object.keys(run.fixtures.pulls).length, 2);
  assert.equal(Object.keys(run.fixtures.branches).length, 6);
  assert.equal(run.fixtures.cases.review.runId, f.remote.runs[0].id);
  assert.equal(f.remote.dispatches.length, 2);
  assert.equal(f.remote.effects.length, 2);
  assert.equal(f.remote.messages.length, 2);
  assert.ok(f.state.output.includes('code review and fix: pass'));
  assert.ok(f.state.output.includes('merge conflict and resolve: pass'));
  assert.ok(f.state.output.includes('Slack client rendering: pass'));
  const writes = f.remote.writes.length;
  assert.equal(await f.invoke('test'), 0, f.state.output.join('\n'));
  assert.equal(f.remote.writes.length, writes, 'rerun must only observe existing effects');
  assert.equal(f.remote.confirmations.length, 2);
  await assert.rejects(readFile(join(f.root, 'workflow-cases.json')), { code: 'ENOENT' });
  assert.equal(await f.invoke('delete'), 0, f.state.output.join('\n'));
  assert.deepEqual(f.remote.refs, { main: f.initial });
  assert.ok(f.remote.pulls.every(pr => pr.state === 'closed'));
  assert.equal(f.remote.dispatches.length, 0);
  assert.equal(f.state.droplets.length + f.state.runners.length + f.state.devices.length, 0);
  assert.equal(await f.store.current(), null);
});

test('every setup and effect response can be lost without duplicate PRs, ready conversions, dispatches, pushes or Slack sends', async t => {
  const baseline = await created(t);
  assert.equal(await baseline.invoke('test'), 0, baseline.state.output.join('\n'));
  const count = baseline.remote.writes.length;
  for (let index = 1; index <= count; index++) {
    await t.test(`write ${index}: ${baseline.remote.writes[index - 1]}`, async t => {
      const f = await created(t);
      f.remote.interrupt = index;
      assert.equal(await f.invoke('test'), 1, `fault ${index} must reach production orchestration`);
      assert.equal(await f.invoke('test'), 0, f.state.output.join('\n'));
      assert.equal(f.remote.pulls.length, 2);
      assert.equal(Object.keys(f.remote.commits).length, 7, 'immutable commit retries must preserve identity');
      assert.equal(f.remote.dispatches.length, 2);
      assert.equal(f.remote.effects.length, 2);
      assert.equal(f.remote.messages.length, 2);
      for (const label of ['register', 'pause', 'resume', 'ready 1', 'ready 2']) assert.equal(f.remote.writes.filter(write => write === label).length, 1, label);
      assert.equal(await f.invoke('delete'), 0, f.state.output.join('\n'));
    });
  }
});

test('delete retains changed fixture artifacts while removing billable infrastructure', async t => {
  const f = await created(t);
  assert.equal(await f.invoke('test'), 0, f.state.output.join('\n'));
  const branch = f.remote.pulls[0].head.ref;
  f.remote.refs[branch] = 'f'.repeat(40);
  f.remote.pulls[0].head.sha = 'f'.repeat(40);
  assert.equal(await f.invoke('delete'), 1);
  assert.equal(f.remote.refs[branch], 'f'.repeat(40));
  assert.equal(f.remote.pulls[0].state, 'open');
  assert.equal(f.state.droplets.length, 0);
  assert.ok((await f.store.load(f.id)).fixtures.cleanupRefused.includes(branch));
});

test('Slack rendering confirmation is part of test and resumes without another message', async t => {
  const f = await created(t);
  f.remote.rendering = false;
  assert.equal(await f.invoke('test'), 1);
  const record = JSON.parse(await readFile(join(f.store.directory(f.id), 'workflow-test.json'), 'utf8'));
  assert.equal(record.rendering.confirmed, false);
  assert.equal(record.status, 'failed');
  f.remote.rendering = true;
  assert.equal(await f.invoke('test'), 0, f.state.output.join('\n'));
  assert.equal(f.remote.messages.length, 2);
});

test('invalid Slack selection fails before fixture mutations', async t => {
  const f = await created(t);
  const request = f.accounts.io.request;
  f.accounts.io.request = async (url, options) => url.startsWith('https://slack.com/') ? { ok: false } : request(url, options);
  assert.equal(await f.invoke('test'), 1);
  assert.equal(f.remote.writes.length, 0);
});

test('normal guide contains exactly create, test and delete', async () => {
  const guide = await readFile(new URL('../docs/pilot-guide.md', import.meta.url), 'utf8');
  assert.deepEqual([...guide.matchAll(/^vp run pilot (\S+)/gm)].map(match => match[1]), ['create', 'test', 'delete']);
  assert.doesNotMatch(guide, /deploy\/pilot\/setup.sh|write.*workflow-cases\.json/i);
});

test('unknown push and unknown or rejected Slack outcomes cannot pass or cause resends', async t => {
  for (const fault of [{ unknownPush: true }, { deliveryState: 'unknown' }, { deliveryState: 'rejected' }]) {
    await t.test(JSON.stringify(fault), async t => {
      const f = await created(t);
      Object.assign(f.remote, fault);
      assert.equal(await f.invoke('test'), 1);
      assert.equal((await f.store.load(f.id)).test.status, 'failed');
      const effects = f.remote.effects.length;
      const messages = f.remote.messages.length;
      f.remote.unknownPush = false;
      f.remote.deliveryState = null;
      assert.equal(await f.invoke('test'), 0, f.state.output.join('\n'));
      assert.equal(f.remote.effects.length, 2);
      assert.equal(f.remote.messages.length, 2);
      assert.ok(effects > 0 && messages > 0);
    });
  }
});

test('stale base fails without another repair or message', async t => {
  const f = await created(t);
  assert.equal(await f.invoke('test'), 0);
  f.remote.pulls[0].base.sha = 'e'.repeat(40);
  assert.equal(await f.invoke('test'), 1);
  assert.equal(f.remote.effects.length, 2);
  assert.equal(f.remote.messages.length, 2);
});

test('delete resumes after every cleanup write response is lost', async t => {
  const baseline = await created(t);
  assert.equal(await baseline.invoke('test'), 0);
  const start = baseline.remote.writes.length;
  assert.equal(await baseline.invoke('delete'), 0);
  const count = baseline.remote.writes.length - start;
  for (let offset = 1; offset <= count; offset++) {
    await t.test(`cleanup write ${offset}`, async t => {
      const f = await created(t);
      assert.equal(await f.invoke('test'), 0);
      f.remote.interrupt = f.remote.writes.length + offset;
      assert.equal(await f.invoke('delete'), 1);
      assert.equal(await f.invoke('delete'), 0, f.state.output.join('\n'));
      assert.deepEqual(f.remote.refs, { main: f.initial });
    });
  }
});

test('generated workflow loads through the production validator and check policy protects tests', async t => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const { loadWorkflow } = await import('@repo-chap/workflow');
  const { validateApplyPolicy } = await import('@repo-chap/runtime');
  const { prepareConfiguration } = await import('../deploy/pilot/configuration.mjs');
  const f = await created(t);
  assert.equal(await f.invoke('test'), 0);
  const run = await f.store.load(f.id);
  const files = f.remote.trees[f.remote.commits[run.fixtures.commits.workflow].tree.sha];
  const directory = join(f.root, 'workflow-validation');
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), text);
  }
  const pkg = await loadWorkflow(join(directory, '.repo-chap/pilot/workflow.json'), { repositoryRoot: directory });
  assert.equal(pkg.workflow.actions.review.onSuccess, 'address');
  assert.equal(pkg.workflow.actions.push_candidate.onSuccess, 'handoff');
  await prepareConfiguration(run, run.configDirectory);
  const policy = JSON.parse(await readFile(join(run.configDirectory, 'pilot-apply.json'), 'utf8'));
  validateApplyPolicy(policy);
  assert.deepEqual(policy.execution.allowedPaths, ['src']);
  assert.deepEqual(policy.execution.requiredChecks[0].args, ['node', 'tests/pilot-regression.mjs']);
});

test('create rejects missing, incomplete and placeholder test selections before provisioning', async t => {
  for (const pilotConfig of [undefined, {}, { profile: 'pilot', workspaceId: 'TSELECT', channelId: 'CSELECT' }]) {
    const f = await journey(t);
    const path = join(f.root, 'operator.json');
    const config = JSON.parse(await readFile(path, 'utf8'));
    await writePrivate(path, JSON.stringify({ ...config, pilotConfig }));
    assert.equal(await f.invoke('create'), 1);
    assert.match(f.state.output.join('\n'), /Complete pilotConfig/);
    assert.equal((await f.store.runs()).length, 0);
    assert.equal(f.state.calls.length, 0);
  }
});

test('old environments explain recreation and cannot report successful create', async t => {
  const f = await created(t);
  const run = await f.store.load(f.id);
  delete run.pilotConfig;
  await f.store.save(run);
  assert.equal(await f.invoke('create'), 1);
  assert.equal(await f.invoke('test'), 1);
  assert.match(f.state.output.join('\n'), /delete this environment and create a new one/);
  assert.equal(f.remote.writes.length, 0);
});


test('Slack preflight explains API failures separately from membership and stops before mutations', async t => {
  const cases = [
    { auth: { ok: false, error: 'invalid_auth' }, message: /Slack authentication failed/ },
    { auth: { ok: true, team_id: 'TOTHER' }, message: /different workspace/ },
    { channel: { ok: false, error: 'missing_scope' }, message: /missing_scope.*channels:read.*groups:read.*reinstall/ },
    { channel: { ok: false, error: 'channel_not_found' }, message: /cannot access the selected channel/ },
    { channel: { ok: false, error: 'fictional-secret' }, message: /Slack channel lookup failed/ },
    { channel: { ok: true, channel: { is_member: false } }, message: /not a member/ },
    { channel: { ok: true, channel: { is_member: true, is_archived: true } }, message: /channel is archived/ },
  ];
  for (const scenario of cases) {
    const f = await created(t);
    const request = f.accounts.io.request;
    f.accounts.io.request = async (url, options) => {
      if (url.includes('slack.com/api/auth.test') && scenario.auth) return scenario.auth;
      if (url.includes('slack.com/api/conversations.info') && scenario.channel) return scenario.channel;
      return request(url, options);
    };
    assert.equal(await f.invoke('test'), 1);
    assert.match(f.state.output.join('\n'), scenario.message);
    assert.doesNotMatch(f.state.output.join('\n'), /fictional-secret/);
    assert.equal(f.remote.writes.length, 0);
  }
});
