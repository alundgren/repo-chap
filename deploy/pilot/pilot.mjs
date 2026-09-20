import { parseArgs } from 'node:util';
import { join, resolve, isAbsolute } from 'node:path';
import { open, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Accounts, PilotError } from './io.mjs';
import { Store, privateDirectory, privateRead, writePrivate } from './store.mjs';
import { Pilot } from './lifecycle.mjs';
import { runTestSuite } from './integration.mjs';
import { validateInputs } from './remote.mjs';
import { ensureDigitalOceanSshKey, validDigitalOceanSshFingerprint } from './digitalocean-key.mjs';
import { prepareRepository } from './repository.mjs';

const help = `Usage:
  vp run pilot create [--root /absolute/private/directory] [--environment ID]
  vp run pilot prepare-repository [--root /absolute/private/directory]
  vp run pilot test [--root /absolute/private/directory] [--environment ID]
  vp run pilot delete [--root /absolute/private/directory] [--environment ID]
  vp run pilot <status|ssh|verify-clean> [--root /absolute/private/directory] [--environment ID]
  vp run pilot reap [--root /absolute/private/directory] --older-than 24h

create provisions a new environment, or resumes the named environment. test runs
each scenario once, stops on failure, and leaves the environment available. delete
removes it and verifies cleanup. verify-clean independently checks that
DigitalOcean resources, the GitHub runner, and the Tailscale device are absent.
Set REPO_CHAP_PILOT_ROOT to avoid repeating --root. An explicit --root takes precedence.
Commands use the current environment saved by create when --environment is omitted.
Exit 0: success or clean; 1: operation failed or verification unresolved; 64: invalid command.
`;

export function createdLabel(created, now = new Date()) {
  const date = new Date(created * 1000);
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) {
    const minutes = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60000));
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function confirmDeletion(run, output) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  output(`Environment: ${run.id}`);
  output(`Created: ${createdLabel(run.created)}`);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(?:es)?$/i.test((await prompt.question('Delete this environment? [y/N] ')).trim()); }
  finally { prompt.close(); }
}

async function confirmReap(runs, output) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(?:es)?$/i.test((await prompt.question('Delete? [y/N] ')).trim()); }
  finally { prompt.close(); }
}

async function prepareEnvironment(store, accounts, output) {
  const configPath = join(store.root, 'operator.json');
  let config;
  try { config = JSON.parse(await privateRead(configPath)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const sshKey = await ensureDigitalOceanSshKey(store.root, accounts.io);
    await writePrivate(join(store.root, '.gitignore'), '*\n');
    await writePrivate(configPath, JSON.stringify({
      repository: 'example-team/pilot-test', region: 'ams3', size: 's-2vcpu-4gb',
      digitalOceanSshKeyFingerprint: sshKey.fingerprint,
      configDirectory: '/absolute/private/pilot-config', codexHome: '/absolute/private/pilot-codex',
    }, null, 2) + '\n');
    output(`Register ${sshKey.publicKeyFile} with DigitalOcean, complete ${configPath}, then rerun create. No credentials were read and no resources were created.`);
    return null;
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository) || !/^[a-z0-9-]+$/.test(config.region) ||
      !/^[a-z0-9-]+$/.test(config.size) || !validDigitalOceanSshFingerprint(config.digitalOceanSshKeyFingerprint))
    throw new PilotError('Select one private repository, region, size, and DigitalOcean SSH key fingerprint in operator.json');
  await validateInputs(config);
  await accounts.io.command('terraform', ['version']);
  const ts = JSON.parse(await accounts.io.command('tailscale', ['status', '--json']));
  if (ts.BackendState !== 'Running') throw new PilotError('Connect the operator to Tailscale first');
  await accounts.io.command('tar', ['--version']);
  const repo = await accounts.gh(`repos/${config.repository}`);
  if (!repo.private || !repo.permissions?.admin) throw new PilotError('GitHub account needs admin access to the dedicated private test repository');
  const account = await accounts.do('account');
  if (account.account?.status !== 'active' || !account.account.uuid) throw new PilotError('DigitalOcean account is not active');
  await accounts.ts('tailnet/-/devices');
  const id = randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);
  const run = {
    version: 1, id, name: `rcp-${id}`, created, expires: created + 86400,
    repository: config.repository, repositoryId: repo.id, digitaloceanAccount: account.account.uuid,
    digitalOceanSshKeyFingerprint: config.digitalOceanSshKeyFingerprint,
    configDirectory: config.configDirectory, codexHome: config.codexHome, region: config.region, size: config.size,
    stage: 'prepared', retained: false,
  };
  await store.save(run);
  return run;
}

export async function main(argv, accounts = new Accounts(), output = console.log, env = process.env, askDelete = confirmDeletion, askReap = confirmReap) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      root: { type: 'string' }, environment: { type: 'string' },
      'older-than': { type: 'string' }, help: { type: 'boolean' },
    } });
  } catch { output(help); return 64; }
  const { values, positionals } = parsed;
  const action = positionals[0];
  const root = values.root ?? env.REPO_CHAP_PILOT_ROOT;
  if (values.help) { output(help); return 0; }
  if (positionals.length !== 1 || !root || !isAbsolute(root) ||
      !['create', 'prepare-repository', 'test', 'delete', 'status', 'ssh', 'verify-clean', 'reap'].includes(action) ||
      values['older-than'] && action !== 'reap' || ['reap', 'prepare-repository'].includes(action) && values.environment) {
    output(help); return 64;
  }
  const store = new Store(root);
  const controller = new AbortController();
  const pilot = new Pilot(store, accounts, { output, signal: controller.signal });
  let lock;
  const interrupt = () => {
    if (action === 'delete' || action === 'reap' || pilot.cleaning) output('Deletion continues through its bounded infrastructure removal stage.');
    else controller.abort();
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    await privateDirectory(store.root, action === 'create' && !values.environment);
    const writes = ['create', 'prepare-repository', 'test', 'delete', 'reap'].includes(action);
    if (writes) {
      const path = join(store.root, '.pilot.lock');
      try { lock = await open(path, 'wx', 0o600); await lock.writeFile(String(process.pid)); }
      catch { throw new PilotError('Operator directory is locked. Confirm its process has exited before removing .pilot.lock'); }
    }
    if (action === 'reap') {
      const match = /^(\d+)h$/.exec(values['older-than'] ?? '');
      if (!match || +match[1] < 1) throw new PilotError('Use reap --older-than 24h with a positive whole number of hours');
      const cutoff = Math.floor(Date.now() / 1000) - +match[1] * 3600;
      const runs = (await store.runs()).filter(run => run.created <= cutoff && run.stage !== 'clean');
      output(`Selected environments: ${runs.map(run => run.id).join(', ') || 'none'}`);
      if (!runs.length) { output('done'); return 0; }
      if (!await askReap(runs, output)) { output('Deletion cancelled.'); return 1; }
      pilot.signal = undefined;
      let ok = true;
      for (const run of runs) {
        const inventory = await pilot.inventory(run);
        if (inventory.collisions.length || inventory.unknown.length) { output(`Refused environment ${run.id}: incomplete ownership markers or unknown resources.`); ok = false; continue; }
        if (await pilot.cleanup(run)) await store.clearCurrent(run.id);
        else ok = false;
      }
      if (ok) output('done');
      return ok ? 0 : 1;
    }
    if (action === 'prepare-repository') {
      const config = JSON.parse(await privateRead(join(store.root, 'operator.json')));
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository)) throw new PilotError('Select one private repository in operator.json');
      return await prepareRepository(accounts, config.repository, output) ? 0 : 1;
    }
    const selectedEnvironment = values.environment ?? (!['create', 'reap', 'prepare-repository'].includes(action) ? await store.current() : null);
    if (!['create', 'reap', 'prepare-repository'].includes(action) && !selectedEnvironment)
      throw new PilotError('No current environment. Run create or use --environment ID.');
    const run = action === 'create' && !values.environment
      ? await prepareEnvironment(store, accounts, output)
      : await store.load(values.environment ?? selectedEnvironment);
    if (!run) return 0;
    if (action === 'create') {
      await store.select(run.id);
      output('creating...');
      const created = await pilot.up(run, { retainOnFailure: true });
      if (created) output(`done - id: ${run.id}`);
      return created ? 0 : 1;
    }
    if (action === 'test') {
      return await runTestSuite(pilot, run) ? 0 : 1;
    }
    if (action === 'delete') {
      const confirmed = await askDelete(run, output);
      if (confirmed === null && !values.environment)
        throw new PilotError('Non-interactive delete requires --environment ID.');
      if (confirmed === false) { output('Deletion cancelled.'); return 1; }
      pilot.signal = undefined;
      const cleaned = await pilot.cleanup(run);
      if (cleaned) await store.clearCurrent(run.id);
      if (cleaned) output('done');
      return cleaned ? 0 : 1;
    }
    if (action === 'status') return pilot.status(run, await pilot.verify(run)) ? 0 : 1;
    if (action === 'verify-clean') {
      const result = await pilot.verify(run);
      const clean = [result.digitalocean, result.github, result.tailscale].every(value => value.state === 'absent');
      if (clean) output('done');
      else pilot.report(run, result);
      return clean ? 0 : 1;
    }
    if (action === 'ssh') { output(await pilot.ssh(run, undefined, undefined, 3600000)); return 0; }
  } catch (error) {
    output(action === 'test'
      ? 'environment health: fail'
      : error instanceof PilotError ? error.message : 'Pilot command failed. Check private inputs, account access, and the saved environment record.');
    return 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    if (lock) { await lock.close(); await rm(join(store.root, '.pilot.lock'), { force: true }); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  process.exitCode = await main(process.argv.slice(2));
}
