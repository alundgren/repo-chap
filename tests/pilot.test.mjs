import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts, command, PilotError } from '../deploy/pilot/io.mjs';
import { Store, markers, writePrivate } from '../deploy/pilot/store.mjs';
import { Pilot } from '../deploy/pilot/lifecycle.mjs';
import { main } from '../deploy/pilot/pilot.mjs';
import { bootstrap, diagnoseHost, versions } from '../deploy/pilot/remote.mjs';

import { fixture } from './pilot-fixture.mjs';

test('successful lifecycle leaves one persistent runner until explicit cleanup', async t => {
  const f = await fixture(t);
  assert.equal(await f.pilot.up(f.run), true);
  assert.equal(f.state.droplets.length, 1);
  assert.equal(f.run.stage, 'running');
  const runnerId = f.state.runners[0].id;
  await f.pilot.up(await f.store.load(f.run.id));
  assert.equal(f.state.runners[0].id, runnerId);
  assert.equal(await f.pilot.cleanup(f.run), true);
  assert.equal(await f.pilot.cleanup(await f.store.load(f.run.id)), true);
  assert.equal(f.state.calls.filter(c => c === 'terraform apply -input=false -no-color -auto-approve -lock-timeout=10s').length, 1);
});

for (const fault of ['apply','enrollment','unreachable','token','register','afterRegistration']) test(`failed up cleans after ${fault}`, async t => {
  const f = await fixture(t, { [fault]: true });
  assert.equal(await f.pilot.up(f.run), false);
  assert.equal(f.state.droplets.length, 0);
  assert.ok(f.state.calls.some(c => c.startsWith('terraform destroy')));
});
for (const fault of ['mint','expired']) test(`${fault} bootstrap refuses before infrastructure`, async t => {
  const f = await fixture(t, { [fault]: true });
  assert.equal(await f.pilot.up(f.run), false);
  assert.equal(f.state.droplets.length, 0);
  assert.ok(!f.state.calls.some(c => c.startsWith('terraform apply')));
});
for (const fault of ['runnerRemove','runnerHang','tsRemove','tsHang','unreachable','stateMissing','stateCorrupt']) test(`infrastructure destruction and verification survive ${fault}`, async t => {
  const f = await fixture(t, { [fault]: true });
  f.create(); f.run.stage = 'running';
  f.state.runners = [{ id: 201, name: f.run.name, labels: [{ name: f.run.name }] }];
  await f.store.save(f.run);
  const clean = await f.pilot.cleanup(f.run);
  assert.ok(f.state.calls.some(c => c.startsWith('terraform destroy')));
  assert.equal((await f.pilot.verify(f.run)).digitalocean.state, 'absent');
  assert.equal(f.state.droplets.length, 0);
  if (['runnerRemove','runnerHang','tsRemove','tsHang'].includes(fault)) {
    assert.equal(clean, false);
    assert.equal(f.run.stage, 'cleanup-pending');
    assert.match(f.state.output.join('\n'), /Billable DigitalOcean resources are gone/);
  } else assert.equal(clean, true);
});
test('explicit retention, resume after registration, cleanup clears retention', async t => {
  const f = await fixture(t, { afterRegistration: true });
  assert.equal(await f.pilot.up(f.run, { retainOnFailure: true }), false);
  assert.equal(f.run.retained, true);
  assert.equal(f.state.droplets.length, 1);
  assert.match(f.state.output.join('\n'), /billing may be ongoing/);
  assert.equal(await f.pilot.up(await f.store.load(f.run.id)), true);
  assert.equal(f.state.calls.filter(c => c.includes('/registration-token')).length, 1);
  assert.equal(await f.pilot.cleanup(f.run), true);
  assert.equal(f.run.retained, false);
});
test('cleanup failure persists and retry removes resources without applying again', async t => {
  const faults = { delete: true }; const f = await fixture(t, faults); f.create();
  assert.equal(await f.pilot.cleanup(f.run), false);
  assert.equal((await f.store.load(f.run.id)).stage, 'cleanup-pending');
  faults.delete = false;
  assert.equal(await f.pilot.cleanup(await f.store.load(f.run.id)), true);
  assert.ok(!f.state.calls.some(c => c.startsWith('terraform apply')));
});
test('ownership collisions refuse destructive commands', async t => {
  const f = await fixture(t); f.create(); f.state.droplets[0].tags.pop();
  assert.equal(await f.pilot.cleanup(f.run), false);
  assert.equal(f.state.droplets.length, 1);
  assert.ok(!f.state.calls.some(c => c.startsWith('terraform destroy') || c.startsWith('DELETE /v2/')));
});
test('inaccessible verification never reports absent and read-only commands do not mutate', async t => {
  const f = await fixture(t, { inaccessible: true });
  assert.equal((await f.pilot.verify(f.run)).digitalocean.state, 'inaccessible');
  assert.ok(!f.state.calls.some(c => c.startsWith('DELETE') || c.startsWith('terraform')));
  assert.equal(await main(['create','--root', f.root,'--environment',f.run.id,'--dry-run'], f.accounts, text => f.state.output.push(text)), 0);
  assert.ok(!f.state.calls.some(c => c.startsWith('terraform')));
});
test('diagnostics redact arbitrary messages and cloud-init contains only limited bootstrap credential', async t => {
  const f = await fixture(t); f.create();
  await diagnoseHost(f.pilot, f.run);
  const diagnostics = await readFile(join(f.store.directory(f.run.id), 'diagnostics.txt'), 'utf8');
  assert.match(diagnostics, /ActiveState=active/);
  assert.doesNotMatch(diagnostics, /secret|MESSAGE/);
  const init = bootstrap(f.run, 'tskey-auth-fictional-bootstrap-secret');
  assert.match(init, /tskey-auth-fictional-bootstrap-secret/);
  assert.doesNotMatch(init, /fictional-(codex|app|do|ts)-secret|RUNNER_SECRET|ssh_authorized_keys/);
  assert.doesNotMatch(f.state.output.join('\n'), /fictional-.*secret/);
});
test('private inputs and corrupt manifests fail without resource writes', async t => {
  const f = await fixture(t);
  await chmod(join(f.run.codexHome, 'auth.json'), 0o644);
  assert.equal(await main(['create','--root',f.root,'--environment',f.run.id,'--confirm'], f.accounts, () => {}), 1);
  await writePrivate(join(f.store.directory(f.run.id), 'manifest.json'), '{');
  await assert.rejects(f.store.load(f.run.id), /manifest/);
  assert.equal(f.state.calls.length, 0);
});
test('prepare accepts compatible Terraform and verifies the repository directly', async t => {
  const f = await fixture(t);
  await writePrivate(join(f.root, 'operator.json'), JSON.stringify({
    repository: f.run.repository,
    region: f.run.region,
    size: f.run.size,
    configDirectory: f.run.configDirectory,
    codexHome: f.run.codexHome,
  }));
  assert.equal(await main(['create', '--root', f.root], f.accounts, text => f.state.output.push(text)), 0);
  assert.ok(f.state.calls.includes('terraform version'));
  assert.equal((await f.store.runs()).length, 2);
  assert.match(f.state.output.join('\n'), /Prepared environment/);
});
test('Ctrl-C during create retains resources for diagnosis and explicit deletion', async t => {
  const f = await fixture(t);
  const original = f.accounts.io.command;
  f.accounts.io.command = async (file, args, options) => {
    if (file === 'terraform' && args[0] === 'apply') { f.create(); process.emit('SIGINT'); throw new PilotError('interrupted'); }
    if (file === 'terraform' && args[0] === 'destroy') process.emit('SIGINT');
    return original(file, args, options);
  };
  assert.equal(await main(['create','--root',f.root,'--environment',f.run.id,'--confirm'], f.accounts, () => {}), 1);
  assert.equal(f.state.droplets.length, 1);
  assert.equal((await f.store.load(f.run.id)).stage, 'retained');
  assert.ok(!f.state.calls.some(c => c.startsWith('terraform destroy')));
});
test('reaper previews, then refuses incomplete ownership markers', async t => {
  const f = await fixture(t); f.create();
  const args = ['reap','--root',f.root,'--older-than','24h'];
  assert.equal(await main(args, f.accounts, () => {}), 0);
  assert.equal(f.state.droplets.length, 1);
  f.state.droplets[0].tags = [f.run.name];
  assert.equal(await main([...args,'--confirm'], f.accounts, () => {}), 1);
  assert.equal(f.state.droplets.length, 1);
});
test('command deadlines kill hung children and suppress secret output', async () => {
  await assert.rejects(command(process.execPath, ['-e', 'console.error("fictional-secret");setInterval(()=>{},1000)'], { timeout: 30 }), error => !error.message.includes('fictional-secret') && /timed out/.test(error.message));
});

test('DigitalOcean and runner inventories read every page', async () => {
  const calls = [];
  const accounts = new Accounts({
    request: async url => {
      calls.push(url);
      const second = new URL(url).searchParams.get('page') === '2';
      return { droplets: [{ id: second ? 2 : 1 }], links: second ? {} : { pages: { next: 'next' } } };
    },
    command: async (_file, args) => {
      calls.push(args.at(-1));
      return JSON.stringify({ total_count: 2, runners: [{ id: /[?&]page=2(?:&|$)/.test(args.at(-1)) ? 2 : 1 }] });
    },
  }, { DIGITALOCEAN_TOKEN: 'fictional-token' });
  assert.deepEqual((await accounts.list('droplets', 'droplets')).map(d => d.id), [1, 2]);
  assert.deepEqual((await accounts.runners('example-team/pilot-test')).map(r => r.id), [1, 2]);
  assert.equal(calls.length, 4);
});
test('unknown tagged resources remain visible and are not erased by Terraform', async t => {
  const f = await fixture(t); f.create(); f.state.tags[0].resources.count = 2;
  assert.equal(await f.pilot.cleanup(f.run), false);
  assert.ok(!f.state.calls.some(c => c.startsWith('terraform destroy')));
  assert.ok(f.run.cleanupFailures.includes('unknown tagged resources: refused Terraform destroy'));
});
test('retained run with lost credentials still defaults to cleanup on failed resume', async t => {
  const f = await fixture(t); f.create(); f.run.stage = 'retained'; f.run.retained = true;
  await rm(join(f.run.codexHome, 'auth.json'));
  assert.equal(await f.pilot.up(f.run), false);
  assert.equal(f.state.droplets.length, 0);
  assert.equal(f.run.retained, false);
});
test('interruption after token minting resumes with a fresh token and one runner', async t => {
  const faults = { register: true }; const f = await fixture(t, faults);
  assert.equal(await f.pilot.up(f.run, { retainOnFailure: true }), false);
  assert.equal(f.state.runners.length, 0);
  assert.equal(f.state.calls.filter(c => c.includes('/registration-token')).length, 1);
  faults.register = false;
  assert.equal(await f.pilot.up(await f.store.load(f.run.id)), true);
  assert.equal(f.state.calls.filter(c => c.includes('/registration-token')).length, 2);
  assert.equal(f.state.runners.length, 1);
  const manifest = await readFile(join(f.store.directory(f.run.id), 'manifest.json'), 'utf8');
  assert.doesNotMatch(manifest, /SECRET|fictional-.*secret/);
  await f.pilot.cleanup(f.run);
});

async function integrationFixture(t, fault = {}) {
  const f = await fixture(t);
  f.create();
  f.state.runners = [{ id: 201, name: f.run.name, labels: [{ name: f.run.name }] }];
  Object.assign(f.run, { stage: 'running', runnerId: 201, deviceId: 'device-101' });
  await f.store.save(f.run);
  const original = f.accounts.io.command;
  const dispatched = [];
  const controller = new AbortController();
  f.pilot.signal = controller.signal;
  f.accounts.io.command = async (file, args, options) => {
    const path = args.at(-1);
    if (file === 'gh' && path.includes('/commits/')) return JSON.stringify({ sha: path.endsWith('/pilot-failing') ? 'a'.repeat(40) : 'b'.repeat(40) });
    if (file === 'gh' && path.endsWith('/dispatches')) {
      const body = JSON.parse(options.input);
      const native = { id: 501 + dispatched.length, display_title: body.inputs.correlation, head_sha: body.ref === 'pilot-failing' ? 'a'.repeat(40) : 'b'.repeat(40), run_attempt: 1, status: fault.pending ? 'in_progress' : 'completed', branch: body.ref };
      dispatched.push(native);
      if (fault.dispatchResponse) { fault.dispatchResponse = false; throw new PilotError('dispatch response lost'); }
      return '';
    }
    if (file === 'gh' && path.includes('/runs?')) {
      return JSON.stringify({ workflow_runs: dispatched.filter(d => path.includes(`branch=${d.branch}`)) });
    }
    if (file === 'gh' && path.includes('/jobs?')) {
      const native = dispatched.find(d => path.includes(`/runs/${d.id}/`));
      if (fault.betweenJobs && native.branch === 'pilot-failing') { fault.betweenJobs = false; controller.abort(); }
      return JSON.stringify({ total_count: 1, jobs: [{ id: native.id + 100, name: 'check', status: 'completed', conclusion: native.branch === 'pilot-failing' ? 'failure' : 'success', runner_id: fault.wrongRunner ? 999 : f.run.runnerId, runner_name: f.run.name, labels: [f.run.name] }] });
    }
    return original(file, args, options);
  };
  return { ...f, dispatched };
}
test('fixed suite validates GitHub job evidence and leaves the environment running', async t => {
  const { runTestSuite } = await import('../deploy/pilot/integration.mjs');
  const f = await integrationFixture(t);
  assert.equal(await runTestSuite(f.pilot, f.run), true);
  const evidence = JSON.parse(await readFile(join(f.store.directory(f.run.id), 'test.json'), 'utf8'));
  assert.equal(evidence.complete, true);
  assert.deepEqual(evidence.jobs.map(j => [j.conclusion, j.runnerId]), [['failure',201], ['success',201]]);
  assert.notEqual(evidence.jobs[0].head, evidence.jobs[1].head);
  assert.equal(f.state.droplets.length, 1);
  assert.equal((await f.store.load(f.run.id)).test.status, 'passed');
  assert.ok(f.state.calls.some(c => c.includes('systemctl is-active --quiet repo-chap-runner.service')));
  assert.ok(f.state.calls.some(c => c.includes('env CODEX_HOME=/var/lib/repo-chap-home/pilot-codex')));
});
test('fixed suite rejects another runner and preserves the environment for diagnosis', async t => {
  const { runTestSuite } = await import('../deploy/pilot/integration.mjs');
  const fault = { wrongRunner: true };
  const f = await integrationFixture(t, fault);
  assert.equal(await runTestSuite(f.pilot, f.run), false);
  assert.equal(f.state.droplets.length, 1);
  assert.equal((await f.store.load(f.run.id)).test.status, 'failed');
  assert.equal(f.dispatched.length, 1);
  fault.wrongRunner = false;
  assert.equal(await runTestSuite(f.pilot, f.run), true);
  assert.equal(f.dispatched.length, 3);
  const evidence = JSON.parse(await readFile(join(f.store.directory(f.run.id), 'test.json'), 'utf8'));
  assert.deepEqual(evidence.history.map(value => value.status), ['failed']);
});
test('interruption between workflow observations preserves the environment', async t => {
  const { runTestSuite } = await import('../deploy/pilot/integration.mjs');
  const f = await integrationFixture(t, { betweenJobs: true });
  assert.equal(await runTestSuite(f.pilot, f.run), false);
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.state.droplets.length, 1);
  f.pilot.signal = undefined;
  assert.equal(await runTestSuite(f.pilot, f.run), true);
  assert.equal(f.dispatched.length, 2);
});
test('queued workflow is reconciled before another job is dispatched', async t => {
  const { runTestSuite } = await import('../deploy/pilot/integration.mjs');
  const fault = { pending: true };
  const f = await integrationFixture(t, fault);
  assert.equal(await runTestSuite(f.pilot, f.run), false);
  assert.equal(f.dispatched.length, 1);
  fault.pending = false;
  f.dispatched[0].status = 'completed';
  assert.equal(await runTestSuite(f.pilot, f.run), true);
  assert.equal(f.dispatched.length, 2);
});
test('fixed suite reconciles a lost dispatch response without sending the job twice', async t => {
  const { runTestSuite } = await import('../deploy/pilot/integration.mjs');
  const f = await integrationFixture(t, { dispatchResponse: true });
  assert.equal(await runTestSuite(f.pilot, f.run), false);
  assert.equal(f.dispatched.length, 1);
  assert.equal(await runTestSuite(f.pilot, f.run), true);
  assert.equal(f.dispatched.length, 2);
  assert.equal(f.state.droplets.length, 1);
});
test('fixed suite CLI defaults to a read-only preview', async t => {
  const f = await fixture(t);
  const output = await command('vp', ['exec', 'node', 'deploy/pilot/integration.mjs', '--root', f.root, '--environment', f.run.id]);
  assert.match(output, /Preview only/);
  assert.equal(f.state.calls.length, 0);
});

test('delete preview is read-only and confirmed delete verifies absence', async t => {
  const f = await integrationFixture(t);
  assert.equal(await main(['delete', '--root', f.root, '--environment', f.run.id], f.accounts, text => f.state.output.push(text)), 0);
  assert.equal(f.state.droplets.length, 1);
  assert.ok(!f.state.calls.some(call => call.startsWith('DELETE') || call.startsWith('terraform destroy')));
  assert.equal(await main(['delete', '--root', f.root, '--environment', f.run.id, '--confirm'], f.accounts, text => f.state.output.push(text)), 0);
  assert.equal(f.state.droplets.length, 0);
  assert.equal(await main(['verify-clean', '--root', f.root, '--environment', f.run.id], f.accounts, () => {}), 0);
});
