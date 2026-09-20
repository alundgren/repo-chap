import { chmod, cp, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { PilotError } from './io.mjs';
import { markers, writePrivate } from './store.mjs';
import { bootstrap, provisionHost, diagnoseHost, validateInputs } from './remote.mjs';

const moduleDirectory = new URL('./digitalocean/', import.meta.url);
const statusOf = error => error.status === 'inaccessible' ? 'inaccessible' : 'unknown';
const summary = (state, ids = []) => ({ state, ids });
export class Pilot {
  constructor(store, accounts, { output = console.log, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), signal } = {}) {
    this.store = store;
    this.accounts = accounts;
    this.output = output;
    this.pause = pause;
    this.signal = signal;
  }
  async checkpoint(run, stage) {
    run.stage = stage;
    await this.store.save(run);
  }
  warn(run) {
    this.output(`Environment ${run.id}: billing may be ongoing.\nDelete: vp run pilot delete --root '${this.store.root.replaceAll("'", "'\\''")}' --environment ${run.id}`);
  }
  async inventory(run) {
    const account = await this.accounts.do('account');
    if (account.account?.uuid !== run.digitaloceanAccount) throw new PilotError('DigitalOcean account differs from prepared account', 'inaccessible');
    const droplets = await this.accounts.list('droplets', 'droplets');
    const projects = await this.accounts.list('projects', 'projects');
    const firewalls = await this.accounts.list('firewalls', 'firewalls');
    const tags = await this.accounts.list('tags', 'tags');
    const wanted = markers(run);
    const selected = droplets.filter(d => d.name === run.name || d.tags?.includes(run.name) || run.dropletIds?.includes(d.id));
    const collisions = selected.filter(d => d.name !== run.name || !wanted.every(t => d.tags?.includes(t)));
    const ownedProjects = projects.filter(p => p.name === run.name || run.projectIds?.includes(p.id));
    for (const p of ownedProjects) {
      if (p.name !== run.name || p.description !== wanted.join(' ')) collisions.push(p);
    }
    const ownedFirewalls = firewalls.filter(f => f.name === run.name || f.tags?.includes(run.name));
    for (const f of ownedFirewalls) {
      if (f.name !== run.name || f.tags?.length !== 1 || f.tags[0] !== run.name) collisions.push(f);
    }
    const unknown = [];
    for (const p of ownedProjects) {
      const resources = await this.accounts.list(`projects/${p.id}/resources`, 'resources');
      for (const r of resources) if (!selected.some(d => r.urn === `do:droplet:${d.id}`)) unknown.push(r.urn);
    }
    const ownedTags = tags.filter(t => wanted.includes(t.name));
    for (const t of ownedTags) {
      const count = t.resources?.count;
      if (!Number.isInteger(count) || count !== selected.filter(d => d.tags.includes(t.name)).length)
        unknown.push(`tag:${t.name}`);
    }
    return { droplets: selected, projects: ownedProjects, firewalls: ownedFirewalls, tags: ownedTags, collisions, unknown };
  }
  async devices(run) {
    const data = await this.accounts.ts('tailnet/-/devices');
    if (!Array.isArray(data.devices)) throw new PilotError('Invalid Tailscale inventory');
    const devices = data.devices.filter(d => d.hostname === run.name || d.id === run.deviceId);
    if (devices.some(d => d.hostname !== run.name || !d.tags?.includes('tag:repo-chap-pilot')) || devices.length > 1)
      throw new PilotError('Tailscale device ownership is ambiguous');
    return devices;
  }
  async runners(run) {
    const repo = await this.accounts.gh(`repos/${run.repository}`);
    if (repo.id !== run.repositoryId || !repo.private) throw new PilotError('Runner repository identity or privacy changed', 'inaccessible');
    const all = await this.accounts.runners(run.repository);
    const selected = all.filter(r => r.name === run.name || r.id === run.runnerId);
    if (selected.some(r => r.name !== run.name || !r.labels?.some(l => l.name === run.name)) || selected.length > 1)
      throw new PilotError('Runner ownership is ambiguous');
    return selected;
  }
  async verify(run) {
    let digitalocean, github, tailscale;
    try {
      const inventory = await this.inventory(run);
      const ids = [...inventory.droplets.map(d => `droplet:${d.id}`), ...inventory.projects.map(p => `project:${p.id}`), ...inventory.firewalls.map(f => `firewall:${f.id}`), ...inventory.tags.map(t => `tag:${t.name}`), ...inventory.unknown];
      digitalocean = summary(inventory.collisions.length ? 'unknown' : ids.length ? 'unresolved' : 'absent', ids);
    } catch (error) { digitalocean = summary(statusOf(error)); }
    try { const list = await this.runners(run); github = summary(list.length ? 'unresolved' : 'absent', list.map(r => `runner:${r.id}`)); }
    catch (error) { github = summary(statusOf(error)); }
    try { const list = await this.devices(run); tailscale = summary(list.length ? 'unresolved' : 'absent', list.map(d => `device:${d.id}`)); }
    catch (error) { tailscale = summary(statusOf(error)); }
    return { digitalocean, github, tailscale,
      links: { digitalocean: 'https://cloud.digitalocean.com/resources', github: `https://github.com/${run.repository}/settings/actions/runners`, tailscale: 'https://login.tailscale.com/admin/machines' } };
  }
  report(run, result) {
    this.output(JSON.stringify({ run: run.id, stage: run.stage, retained: !!run.retained, ...result }, null, 2));
    if (result.digitalocean.state === 'absent') this.output('Billable DigitalOcean resources are gone.');
    else this.warn(run);
    return Object.values(result).filter(v => v?.state).every(v => v.state === 'absent');
  }
  async terraform(run, action) {
    const cwd = join(this.store.directory(run.id), 'terraform');
    return this.accounts.io.command('terraform', [action, '-input=false', '-no-color', ...(action === 'init' ? [] : ['-auto-approve', '-lock-timeout=10s'])], {
      cwd, timeout: action === 'init' ? 120000 : 300000,
      env: { TF_IN_AUTOMATION: '1', TF_LOG: 'OFF', TF_LOG_PATH: '', DIGITALOCEAN_TOKEN: this.accounts.env.DIGITALOCEAN_TOKEN },
      ...(action === 'apply' || action === 'init' ? { signal: this.signal } : {}),
    });
  }
  async cleanup(run) {
    this.cleaning = true;
    run.retained = false;
    // A checkpoint failure must not suppress infrastructure deletion.
    const failures = [];
    const attempt = async (name, fn) => { try { await fn(); } catch { failures.push(name); } };
    await attempt('checkpoint', () => this.checkpoint(run, 'cleaning'));
    try {
      await attempt('diagnostics', () => diagnoseHost(this, run));
      await attempt('shutdown', async () => this.ssh(run, 'sudo timeout 20 systemctl stop repo-chap.service repo-chap-runner.service', undefined, 25000));
      await attempt('runner removal', async () => {
        for (const r of await this.runners(run)) await this.accounts.gh(`repos/${run.repository}/actions/runners/${r.id}`, 'DELETE');
      });
      await attempt('Tailscale removal', async () => {
        for (const d of await this.devices(run)) await this.accounts.ts(`device/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
      });
    } finally {
      let inventory;
      await attempt('DigitalOcean inventory', async () => { inventory = await this.inventory(run); });
      if (inventory?.collisions.length) failures.push('ownership collision: refused destruction');
      else {
        if (!inventory?.unknown.length) await attempt('Terraform destroy', () => this.terraform(run, 'destroy'));
        else failures.push('unknown tagged resources: refused Terraform destroy');
        // Use fresh API inventory even when Terraform has lost its local state.
        await attempt('DigitalOcean fallback deletion', async () => {
          const current = await this.inventory(run);
          if (current.collisions.length) throw new PilotError('Ownership collision');
          for (const d of current.droplets) await attempt(`droplet:${d.id}`, () => this.accounts.do(`droplets/${d.id}`, { method: 'DELETE' }));
          for (const f of current.firewalls) await attempt(`firewall:${f.id}`, () => this.accounts.do(`firewalls/${f.id}`, { method: 'DELETE' }));
          // A Project is an inventory container. Removing it never deletes its resources.
          if (!current.unknown.length) {
            for (const p of current.projects) await attempt(`project:${p.id}`, () => this.accounts.do(`projects/${p.id}`, { method: 'DELETE' }));
          }
          const remaining = await this.inventory(run);
          if (!remaining.droplets.length && !remaining.unknown.length && !remaining.collisions.length) {
            for (const t of remaining.tags) await attempt(`tag:${t.name}`, () => this.accounts.do(`tags/${encodeURIComponent(t.name)}`, { method: 'DELETE' }));
          }
        });
      }
    }
    let result;
    for (let n = 0; n < 3; n++) {
      result = await this.verify(run);
      if (result.digitalocean.state === 'absent') break;
      if (n < 2) await this.pause(2000);
    }
    run.cleanupFailures = failures;
    run.verification = result;
    const clean = [result.digitalocean, result.github, result.tailscale].every(v => v.state === 'absent');
    await attempt('checkpoint', () => this.checkpoint(run, clean ? 'clean' : 'cleanup-pending'));
    this.report(run, result);
    return clean && !failures.includes('checkpoint');
  }
  async ssh(run, script, input, timeout = 30000) {
    const devices = await this.devices(run);
    if (devices.length !== 1 || !devices[0].name || !/^[a-zA-Z0-9.-]+$/.test(devices[0].name)) throw new PilotError('Run has no verified tailnet destination');
    const d = devices[0];
    if (run.deviceId && run.deviceId !== d.id) throw new PilotError('Tailnet device changed');
    const knownHosts = join(this.store.directory(run.id), 'ssh_known_hosts');
    const file = await open(knownHosts, 'a', 0o600);
    await file.close();
    await chmod(knownHosts, 0o600);
    return this.accounts.io.command('ssh', [
      '-o', `UserKnownHostsFile=${knownHosts}`,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=yes',
      `pilot-diagnostic@${d.name}`,
      ...(script ? [script] : []),
    ], { input, timeout, signal: this.signal, interactive: !script });
  }
  async up(run, { retainOnFailure = false } = {}) {
    if (run.stage === 'clean' || run.stage === 'cleanup-pending' || run.stage === 'cleaning') throw new PilotError('This run is being cleaned or is clean; prepare a new run');
    if (run.stage === 'running') { this.warn(run); return true; }
    let mayExist = run.stage !== 'prepared';
    run.retained = false;
    try {
      await validateInputs(run);
      const inventory = await this.inventory(run);
      if (inventory.collisions.length || inventory.unknown.length) throw new PilotError('Ownership collision or unknown resources; inspect inventory');
      if (!mayExist && (inventory.droplets.length || inventory.projects.length || inventory.firewalls.length || inventory.tags.length))
        throw new PilotError('Run ID collision; prepare a new run');
      if (mayExist && (inventory.droplets.length !== 1 || inventory.projects.length !== 1 || inventory.firewalls.length !== 1 || inventory.tags.length !== 4)) throw new PilotError('Incomplete infrastructure requires cleanup, then a new run');
      if (!mayExist) {
        const key = await this.accounts.ts('tailnet/-/keys', { method: 'POST', body: {
          capabilities: { devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: ['tag:repo-chap-pilot'] } } },
          expirySeconds: 600, description: run.name,
        } });
        if (!key.key || Date.parse(key.expires) <= Date.now()) throw new PilotError('Bootstrap key is missing or expired');
        const directory = join(this.store.directory(run.id), 'terraform');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await cp(moduleDirectory, directory, { recursive: true });
        await writePrivate(join(directory, 'pilot.auto.tfvars.json'), JSON.stringify({ run_id: run.id, created: run.created, expires: run.expires, region: run.region, size: run.size, bootstrap: bootstrap(run, key.key) }));
        await this.terraform(run, 'init');
        await this.checkpoint(run, 'applying');
        mayExist = true;
        await this.terraform(run, 'apply');
      }
      await this.checkpoint(run, 'enrolling');
      let devices;
      for (let i = 0; i < 30; i++) {
        this.signal?.throwIfAborted();
        devices = await this.devices(run);
        if (devices.length === 1) break;
        await this.pause(10000);
      }
      if (devices?.length !== 1) throw new PilotError('Tailnet enrollment failed or bootstrap key expired');
      run.deviceId = devices[0].id;
      const live = await this.inventory(run);
      run.dropletIds = live.droplets.map(d => d.id);
      run.projectIds = live.projects.map(p => p.id);
      await this.checkpoint(run, 'installing');
      await provisionHost(this, run);
      this.signal?.throwIfAborted();
      await this.checkpoint(run, 'running');
      this.warn(run);
      this.output(`Environment left running.\nvp run pilot status --root '${this.store.root}' --environment ${run.id}\nWith operator permission, follow docs/pilot-ssh-debugging.md.`);
      return true;
    } catch (error) {
      this.output(error instanceof PilotError ? error.message : 'Pilot setup failed or was interrupted');
      if (mayExist) {
        if (retainOnFailure) { run.retained = true; await this.checkpoint(run, 'retained'); this.warn(run); }
        else {
          const signal = this.signal;
          this.signal = undefined;
          try { await this.cleanup(run); } finally { this.signal = signal; }
        }
      }
      return false;
    }
  }
}
