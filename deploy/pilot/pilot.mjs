import { parseArgs } from 'node:util';
import { join, resolve, isAbsolute } from 'node:path';
import { open, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Accounts, PilotError } from './io.mjs';
import { Store, privateDirectory, privateRead, writePrivate } from './store.mjs';
import { Pilot } from './lifecycle.mjs';
import { runTestSuite, suite } from './integration.mjs';
import { validateInputs, versions } from './remote.mjs';

const help = `Usage:
  vp run pilot create --root /absolute/private/directory
  vp run pilot create --root /absolute/private/directory --environment ID [--dry-run|--confirm]
  vp run pilot test --root /absolute/private/directory --environment ID [--confirm]
  vp run pilot delete --root /absolute/private/directory --environment ID [--confirm]
  vp run pilot <status|ssh|verify-clean> --root /absolute/private/directory --environment ID
  vp run pilot reap --root /absolute/private/directory --older-than 24h [--confirm]

create writes operator.json on first use. Edit it, rerun create, then preview and
confirm the prepared environment. test runs the fixed suite and always leaves the
environment available. delete removes it; verify-clean independently checks that
DigitalOcean resources, the GitHub runner, and the Tailscale device are absent.
Exit 0: success or clean; 1: operation failed or verification unresolved; 64: invalid command.
`;

const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const environmentCommand = (action, store, run, suffix = '') =>
  `vp run pilot ${action} --root ${quote(store.root)} --environment ${run.id}${suffix}`;

async function prepareEnvironment(store, accounts, output) {
  const configPath = join(store.root, 'operator.json');
  let config;
  try { config = JSON.parse(await privateRead(configPath)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writePrivate(join(store.root, '.gitignore'), '*\n');
    await writePrivate(configPath, JSON.stringify({
      repository: 'example-team/pilot-test', region: 'ams3', size: 's-2vcpu-4gb',
      configDirectory: '/absolute/private/pilot-config', codexHome: '/absolute/private/pilot-codex',
      trustedPrivateRepository: true,
    }, null, 2) + '\n');
    output(`Wrote ${configPath}. Complete the private values, then rerun create. No credentials were read and no resources were created.`);
    return null;
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository) || !/^[a-z0-9-]+$/.test(config.region) ||
      !/^[a-z0-9-]+$/.test(config.size) || config.trustedPrivateRepository !== true)
    throw new PilotError('Select one dedicated trusted private repository, region and size in operator.json');
  await validateInputs(config);
  const tf = JSON.parse(await accounts.io.command('terraform', ['version', '-json']));
  if (tf.terraform_version !== versions.terraform) throw new PilotError(`Install Terraform ${versions.terraform}`);
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
    configDirectory: config.configDirectory, codexHome: config.codexHome, region: config.region, size: config.size,
    stage: 'prepared', retained: false,
  };
  await store.save(run);
  output(`Prepared environment ${id}. No resources were created.`);
  output(`Preview: ${environmentCommand('create', store, run, ' --dry-run')}`);
  output(`Create: ${environmentCommand('create', store, run, ' --confirm')}`);
  return run;
}

function createPreview(output, store, run) {
  output(JSON.stringify({
    environment: run.id, repository: run.repository, region: run.region, size: run.size,
    resources: ['one Droplet', 'one Project', 'one deny-inbound firewall', 'four ownership tags', 'one ephemeral Tailscale device', 'one repository runner'],
    versions,
  }, null, 2));
  output('Preview only. No API calls, Terraform commands, credential reads, or resource changes occurred.');
  output(`Create: ${environmentCommand('create', store, run, ' --confirm')}`);
}

function testPreview(output, store, run) {
  if (run.stage !== 'running') throw new PilotError('The environment must be running before tests start');
  output(`Environment ${run.id}; repository ${run.repository}; stage ${run.stage}.`);
  output(`Fixed suite: ${suite.workflow}; ${suite.failingRef} must fail; ${suite.repairedRef} must pass on runner ${run.name}.`);
  output('The suite verifies daemon diagnostics, service health, distinct GitHub heads, and exact runner identity. It never merges or deletes the environment.');
  output(`Run: ${environmentCommand('test', store, run, ' --confirm')}`);
}

export async function main(argv, accounts = new Accounts(), output = console.log) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      root: { type: 'string' }, environment: { type: 'string' }, 'dry-run': { type: 'boolean' },
      'older-than': { type: 'string' }, confirm: { type: 'boolean' }, help: { type: 'boolean' },
    } });
  } catch { output(help); return 64; }
  const { values, positionals } = parsed;
  const action = positionals[0];
  if (values.help) { output(help); return 0; }
  if (positionals.length !== 1 || !values.root || !isAbsolute(values.root) ||
      !['create', 'test', 'delete', 'status', 'ssh', 'verify-clean', 'reap'].includes(action) ||
      values['dry-run'] && action !== 'create' || values.confirm && !['create', 'test', 'delete', 'reap'].includes(action) ||
      values['older-than'] && action !== 'reap' || action === 'reap' && values.environment ||
      !['create', 'reap'].includes(action) && !values.environment || values.confirm && values['dry-run'] ||
      action === 'create' && !values.environment && (values.confirm || values['dry-run'])) {
    output(help); return 64;
  }
  const store = new Store(values.root);
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
    const writes = action === 'create' && (!values.environment || values.confirm) || action === 'test' && values.confirm ||
      action === 'delete' && values.confirm || action === 'reap' && values.confirm;
    if (writes) {
      const path = join(store.root, '.pilot.lock');
      try { lock = await open(path, 'wx', 0o600); await lock.writeFile(String(process.pid)); }
      catch { throw new PilotError('Operator directory is locked. Confirm its process has exited before removing .pilot.lock'); }
    }
    if (action === 'create' && !values.environment) {
      await prepareEnvironment(store, accounts, output);
      return 0;
    }
    if (action === 'reap') {
      const match = /^(\d+)h$/.exec(values['older-than'] ?? '');
      if (!match || +match[1] < 1) throw new PilotError('Use reap --older-than 24h with a positive whole number of hours');
      const cutoff = Math.floor(Date.now() / 1000) - +match[1] * 3600;
      const runs = (await store.runs()).filter(run => run.created <= cutoff && run.stage !== 'clean');
      output(`Selected environments: ${runs.map(run => run.id).join(', ') || 'none'}`);
      if (!values.confirm) { output('Preview only. Add --confirm to delete these environments.'); return 0; }
      pilot.signal = undefined;
      let ok = true;
      for (const run of runs) {
        const inventory = await pilot.inventory(run);
        if (inventory.collisions.length || inventory.unknown.length) { output(`Refused environment ${run.id}: incomplete ownership markers or unknown resources.`); ok = false; continue; }
        if (!await pilot.cleanup(run)) ok = false;
      }
      return ok ? 0 : 1;
    }
    const run = await store.load(values.environment);
    if (action === 'create') {
      if (values['dry-run'] || !values.confirm) { createPreview(output, store, run); return 0; }
      const created = await pilot.up(run, { retainOnFailure: true });
      if (created) {
        output(`Environment ${run.id} is running.`);
        output(`Next: ${environmentCommand('test', store, run)}`);
      }
      return created ? 0 : 1;
    }
    if (action === 'test') {
      if (!values.confirm) { testPreview(output, store, run); return 0; }
      const passed = await runTestSuite(pilot, run);
      if (passed) output(`Environment ${run.id} passed. Delete it when inspection is complete: ${environmentCommand('delete', store, run)}`);
      return passed ? 0 : 1;
    }
    if (action === 'delete') {
      if (!values.confirm) {
        const result = await pilot.verify(run);
        pilot.report(run, result);
        output(`Delete only this environment: ${environmentCommand('delete', store, run, ' --confirm')}`);
        return 0;
      }
      pilot.signal = undefined;
      return await pilot.cleanup(run) ? 0 : 1;
    }
    if (action === 'status' || action === 'verify-clean') return pilot.report(run, await pilot.verify(run)) ? 0 : 1;
    if (action === 'ssh') { output(await pilot.ssh(run, undefined, undefined, 3600000)); return 0; }
  } catch (error) {
    output(error instanceof PilotError ? error.message : 'Pilot command failed. Check private inputs, account access, and the saved environment record.');
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
