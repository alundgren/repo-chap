import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Accounts, command, PilotError } from '../deploy/pilot/io.mjs';
import { Store, markers, writePrivate } from '../deploy/pilot/store.mjs';
import { Pilot } from '../deploy/pilot/lifecycle.mjs';
import { bootstrap, diagnoseHost, versions } from '../deploy/pilot/remote.mjs';

export async function fixture(t, faults = {}, selectedRoot) {
  const root = selectedRoot ?? await mkdtemp(join(await realpath(tmpdir()), 'repo-chap-pilot-test-'));
  if (selectedRoot) await mkdir(root, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const sshFingerprint = '00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff';
  const run = { version: 1, id: '0123456789abcdef01234567', name: 'rcp-0123456789abcdef01234567', created: 1700000000, expires: 1700086400, repository: 'example-team/pilot-test', repositoryId: 17, digitaloceanAccount: 'fictional-account', digitalOceanSshKeyFingerprint: sshFingerprint, region: 'ams3', size: 's-2vcpu-4gb', stage: 'prepared', configDirectory: join(root, 'config'), codexHome: join(root, 'codex') };
  await mkdir(run.configDirectory, { mode: 0o700 });
  await mkdir(run.codexHome, { mode: 0o700 });
  await writePrivate(join(run.codexHome, 'auth.json'), '{"token":"fictional-codex-secret"}');
  await writePrivate(join(run.configDirectory, 'installation.json'), JSON.stringify({ providerConfig: '/etc/repo-chap/providers.json', app: { privateKeyFile: '/etc/repo-chap/app.pem' } }));
  await writePrivate(join(run.configDirectory, 'providers.json'), '{}');
  await writePrivate(join(run.configDirectory, 'app.pem'), 'fictional-app-secret');
  await store.save(run);
  const state = { droplets: [], projects: [], firewalls: [], tags: [], devices: [], runners: [], calls: [], commands: [], output: [], jobs: [] };
  function create(selected = run) {
    state.droplets = [{ id: 101, name: selected.name, tags: markers(selected) }];
    state.projects = [{ id: 'project-101', name: selected.name, description: markers(selected).join(' ') }];
    state.firewalls = [{ id: 'firewall-101', name: selected.name, tags: [selected.name] }];
    state.tags = markers(selected).map(name => ({ name, resources: { count: 1 } }));
    if (!faults.enrollment) state.devices = [{ id: 'device-101', hostname: selected.name, name: `${selected.name}.example.ts.net`, tags: ['tag:repo-chap-pilot'] }];
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
      const script = typeof options.input === 'string'
        ? options.input.replace(/ACTIONS_RUNNER_INPUT_TOKEN='[^']+'/g, "ACTIONS_RUNNER_INPUT_TOKEN='[redacted]'")
        : undefined;
      state.commands.push({ file, args, interactive: options.interactive, hasInput: options.input !== undefined, timeout: options.timeout, script });
      if (file === 'terraform') {
        if (args[0] === 'version') return 'Terraform v1.16.3';
        if (args[0] === 'apply') {
          create(await store.load(basename(dirname(options.cwd))));
          if (faults.apply) throw new PilotError('partial apply');
        }
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
        throw new Error(`Unexpected fixture command ${file}`);
      }
      if (file === 'ssh') {
        if (faults.unreachable) throw new PilotError('unreachable host');
        const script = options.input?.toString() ?? '';
        if (script.includes('RUNNER_INPUT_TOKEN')) {
          if (faults.register) throw new PilotError('registration failed');
          const name = /--name ([a-zA-Z0-9.-]+)/.exec(script)?.[1] ?? run.name;
          state.runners = [{ id: 201, name, labels: [{ name }] }];
          if (faults.afterRegistration) { faults.afterRegistration = false; throw new PilotError('interrupted after registration'); }
        }
        if (script.includes('Runner.Listener --version')) return `v${versions.node}\nvp v${versions.vitePlus}\n1.96.0\ncodex-cli 0.155.0\n${versions.runner}\n`;
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
