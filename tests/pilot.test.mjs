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

async function fixture(t, faults = {}) {
  const root = await mkdtemp(join(tmpdir(), 'repo-chap-pilot-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const run = { version: 1, id: '0123456789abcdef01234567', name: 'rcp-0123456789abcdef01234567', created: 1700000000, expires: 1700086400, repository: 'example-team/pilot-test', repositoryId: 17, digitaloceanAccount: 'fictional-account', region: 'ams3', size: 's-2vcpu-4gb', stage: 'prepared', configDirectory: join(root, 'config'), codexHome: join(root, 'codex') };
  await mkdir(run.configDirectory, { mode: 0o700 });
  await mkdir(run.codexHome, { mode: 0o700 });
  await writePrivate(join(run.codexHome, 'auth.json'), '{"token":"fictional-codex-secret"}');
  await writePrivate(join(run.configDirectory, 'installation.json'), JSON.stringify({ providerConfig: '/etc/repo-chap/providers.json', app: { privateKeyFile: '/etc/repo-chap/app.pem' } }));
  await writePrivate(join(run.configDirectory, 'providers.json'), '{}');
  await writePrivate(join(run.configDirectory, 'app.pem'), 'fictional-app-secret');
  await store.save(run);
  const state = { droplets: [], projects: [], firewalls: [], tags: [], devices: [], runners: [], calls: [], output: [], jobs: [] };
  function create() {
    state.droplets = [{ id: 101, name: run.name, tags: markers(run) }];
    state.projects = [{ id: 'project-101', name: run.name, description: markers(run).join(' ') }];
    state.firewalls = [{ id: 'firewall-101', name: run.name, tags: [run.name] }];
    state.tags = markers(run).map(name => ({ name, resources: { count: 1 } }));
    if (!faults.enrollment) state.devices = [{ id: 'device-101', hostname: run.name, name: `${run.name}.example.ts.net`, tags: ['tag:repo-chap-pilot'] }];
  }
  async function hang() { return command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 20 }); }
  const io = {
    async request(url, options = {}) {
      const path = new URL(url).pathname;
      state.calls.push(`${options.method ?? 'GET'} ${path}`);
      if (url.includes('digitalocean.com')) {
        if (faults.inaccessible) throw new PilotError('denied', 'inaccessible');
        if (path === '/v2/account') return { account: { uuid: 'fictional-account', status: 'active' } };
        if (options.method === 'DELETE') {
          if (faults.delete) throw new PilotError('delete unavailable');
          const [, , kind, id] = path.split('/');
          const removed = state[kind].filter(item => String(item.id ?? item.name) === decodeURIComponent(id));
          state[kind] = state[kind].filter(item => !removed.includes(item));
          if (kind === 'droplets') for (const tag of state.tags) tag.resources.count -= removed.filter(d => d.tags.includes(tag.name)).length;
          return {};
        }
        if (path.includes('/resources')) return { resources: state.droplets.map(d => ({ urn: `do:droplet:${d.id}` })) };
        const key = path.split('/').at(-1);
        return { [key]: state[key] };
      }
      if (path.endsWith('/oauth/token')) return { access_token: 'fictional-oauth-secret' };
      if (path.endsWith('/keys')) {
        assert.equal(options.body.expirySeconds, 600);
        assert.deepEqual(options.body.capabilities.devices.create, { reusable: false, ephemeral: true, preauthorized: true, tags: ['tag:repo-chap-pilot'] });
        if (faults.mint) throw new PilotError('mint failed');
        return { key: 'tskey-auth-fictional-bootstrap-secret', expires: faults.expired ? '2000-01-01T00:00:00Z' : '2099-01-01T00:00:00Z' };
      }
      if (options.method === 'DELETE') {
        if (faults.tsHang) await hang();
        if (faults.tsRemove) throw new PilotError('Tailscale removal failed');
        state.devices = [];
        return {};
      }
      return { devices: state.devices };
    },
    async command(file, args, options = {}) {
      state.calls.push(`${file} ${args.join(' ')}`);
      if (file === 'terraform') {
        if (args[0] === 'version') return JSON.stringify({ terraform_version: versions.terraform });
        if (args[0] === 'apply') { create(); if (faults.apply) throw new PilotError('partial apply'); }
        if (args[0] === 'destroy') {
          if (faults.stateMissing || faults.stateCorrupt) throw new PilotError('state unavailable');
          if (!faults.delete) { state.droplets = []; state.projects = []; state.firewalls = []; state.tags = []; }
        }
        return '';
      }
      if (file === 'gh') {
        const path = args.at(-1);
        if (path.endsWith('/registration-token')) {
          if (faults.token) throw new PilotError('token mint failed');
          return JSON.stringify({ token: 'FICTIONAL_RUNNER_SECRET', expires_at: '2099-01-01T00:00:00Z' });
        }
        if (args.includes('DELETE')) {
          if (faults.runnerHang) await hang();
          if (faults.runnerRemove) throw new PilotError('runner removal failed');
          state.runners = []; return '';
        }
        if (path.includes('/actions/runners')) return JSON.stringify({ total_count: state.runners.length, runners: state.runners });
        return JSON.stringify({ id: 17, private: true, permissions: { admin: true } });
      }
      if (file === 'tar') {
        if (args[0] === '--version') return 'tar';
        await writeFile(args[1], 'fictional archive', { mode: 0o600 }); return '';
      }
      if (file === 'tailscale') {
        if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running' });
        if (faults.unreachable) throw new PilotError('unreachable host');
        const script = options.input?.toString() ?? '';
        if (script.includes('RUNNER_INPUT_TOKEN')) {
          if (faults.register) throw new PilotError('registration failed');
          state.runners = [{ id: 201, name: run.name, labels: [{ name: run.name }] }];
          if (faults.afterRegistration) { faults.afterRegistration = false; throw new PilotError('interrupted after registration'); }
        }
        if (script.includes('Runner.Listener --version')) return `v${versions.node}\nvp v${versions.vitePlus}\n${versions.tailscale}\ncodex-cli ${versions.codex}\n${versions.runner}\n`;
        if (script.includes('journalctl')) return 'services\nActiveState=active\nfictional-codex-secret\n{"PRIORITY":"6"}\n{"MESSAGE":"fictional-app-secret"}\n';
        return '';
      }
      throw new Error(`Unexpected fixture command ${file}`);
    },
  };
  const accounts = new Accounts(io, { DIGITALOCEAN_TOKEN: 'fictional-do-secret', TAILSCALE_CLIENT_ID: 'fictional-client', TAILSCALE_CLIENT_SECRET: 'fictional-ts-secret' });
  const pilot = new Pilot(store, accounts, { output: text => state.output.push(text), pause: async () => {} });
  return { root, store, run, state, accounts, pilot, create };
}

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
  assert.match(f.state.output.join('\n'), /retained for diagnosis/);
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
  assert.equal(await main(['up','--root', f.root,'--run',f.run.id,'--dry-run'], f.accounts, text => f.state.output.push(text)), 0);
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
  assert.equal(await main(['up','--root',f.root,'--run',f.run.id], f.accounts, () => {}), 1);
  await writePrivate(join(f.store.directory(f.run.id), 'manifest.json'), '{');
  await assert.rejects(f.store.load(f.run.id), /manifest/);
  assert.equal(f.state.calls.length, 0);
});
test('Ctrl-C during apply defaults to cleanup and cancellation does not abort cleanup', async t => {
  const f = await fixture(t);
  const original = f.accounts.io.command;
  f.accounts.io.command = async (file, args, options) => {
    if (file === 'terraform' && args[0] === 'apply') { f.create(); process.emit('SIGINT'); throw new PilotError('interrupted'); }
    if (file === 'terraform' && args[0] === 'destroy') process.emit('SIGINT');
    return original(file, args, options);
  };
  assert.equal(await main(['up','--root',f.root,'--run',f.run.id], f.accounts, () => {}), 1);
  assert.equal(f.state.droplets.length, 0);
  assert.equal((await f.store.load(f.run.id)).stage, 'clean');
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
  const original = f.accounts.io.command;
  const dispatched = [];
  const controller = new AbortController();
  f.pilot.signal = controller.signal;
  f.accounts.io.command = async (file, args, options) => {
    const path = args.at(-1);
    if (file === 'gh' && path.includes('/commits/')) return JSON.stringify({ sha: path.endsWith('/failing') ? 'a'.repeat(40) : 'b'.repeat(40) });
    if (file === 'gh' && path.endsWith('/dispatches')) {
      const body = JSON.parse(options.input);
      const native = { id: 501 + dispatched.length, display_title: body.inputs.correlation, head_sha: body.ref === 'failing' ? 'a'.repeat(40) : 'b'.repeat(40), run_attempt: 1, status: 'completed', branch: body.ref };
      dispatched.push(native);
      if (fault.dispatchResponse) { fault.dispatchResponse = false; throw new PilotError('dispatch response lost'); }
      return '';
    }
    if (file === 'gh' && path.includes('/runs?')) {
      return JSON.stringify({ workflow_runs: dispatched.filter(d => path.includes(`branch=${d.branch}`)) });
    }
    if (file === 'gh' && path.includes('/jobs?')) {
      const native = dispatched.find(d => path.includes(`/runs/${d.id}/`));
      if (fault.betweenJobs && native.branch === 'failing') { fault.betweenJobs = false; controller.abort(); }
      return JSON.stringify({ total_count: 1, jobs: [{ id: native.id + 100, name: 'check', status: 'completed', conclusion: native.branch === 'failing' ? 'failure' : 'success', runner_id: fault.wrongRunner ? 999 : f.run.runnerId, runner_name: f.run.name, labels: [f.run.name] }] });
    }
    return original(file, args, options);
  };
  return { ...f, dispatched };
}
const integrationSelection = { workflow: 'pilot.yml', failingRef: 'failing', repairedRef: 'repaired' };
test('live integration path provisions and validates GitHub job evidence on the installed runner', async t => {
  const { runIntegration } = await import('../deploy/pilot/integration.mjs');
  const f = await integrationFixture(t);
  assert.equal(await runIntegration(f.pilot, f.run, integrationSelection), true);
  const evidence = JSON.parse(await readFile(join(f.store.directory(f.run.id), 'integration.json'), 'utf8'));
  assert.equal(evidence.complete, true);
  assert.deepEqual(evidence.jobs.map(j => [j.conclusion, j.runnerId]), [['failure',201], ['success',201]]);
  assert.notEqual(evidence.jobs[0].head, evidence.jobs[1].head);
  assert.equal(f.state.droplets.length, 0);
  assert.ok(f.state.calls.some(c => c.includes('systemctl is-active --quiet repo-chap-runner.service')));
});
test('integration rejects successful jobs reported on a different runner and still cleans', async t => {
  const { runIntegration } = await import('../deploy/pilot/integration.mjs');
  const f = await integrationFixture(t, { wrongRunner: true });
  assert.equal(await runIntegration(f.pilot, f.run, integrationSelection), false);
  assert.equal(f.state.droplets.length, 0);
  assert.equal(f.dispatched.length, 1);
});
test('interruption between real workflow observations cleans by default', async t => {
  const { runIntegration } = await import('../deploy/pilot/integration.mjs');
  const f = await integrationFixture(t, { betweenJobs: true });
  assert.equal(await runIntegration(f.pilot, f.run, integrationSelection), false);
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.state.droplets.length, 0);
});
test('retained integration reconciles a lost dispatch response without sending the job twice', async t => {
  const { runIntegration } = await import('../deploy/pilot/integration.mjs');
  const f = await integrationFixture(t, { dispatchResponse: true });
  assert.equal(await runIntegration(f.pilot, f.run, integrationSelection, { retainOnFailure: true }), false);
  assert.equal(f.run.retained, true);
  assert.equal(f.dispatched.length, 1);
  assert.equal(await runIntegration(f.pilot, f.run, integrationSelection), true);
  assert.equal(f.dispatched.length, 2);
  assert.equal(f.state.droplets.length, 0);
});
test('live integration defaults to a read-only preview without cloud credentials', async t => {
  const f = await fixture(t);
  const output = await command('vp', ['exec', 'node', 'deploy/pilot/integration.mjs', '--root', f.root, '--run', f.run.id, '--failing-ref', 'failing', '--repaired-ref', 'repaired']);
  assert.match(output, /Preview only/);
  assert.equal(f.state.calls.length, 0);
});
