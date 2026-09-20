import { join } from 'node:path';
import { privateRead, writePrivate } from './store.mjs';
import { PilotError } from './io.mjs';

export const pilotCapabilities = ['workspace.read', 'workspace.write', 'checks.run', 'pr.push', 'notify.send'];

// Build the transferred configuration from account inputs. The operator does
// not author fixture permissions, check commands or repair policies.
export async function prepareConfiguration(run, directory) {
  if (!run.pilotConfig) return;
  const config = JSON.parse(await privateRead(join(directory, 'installation.json')));
  const profileName = run.pilotConfig.profile;
  if (!/^[A-Za-z0-9_-]+$/.test(profileName ?? '')) throw new PilotError('Select a provider profile in pilotConfig');
  const providerPath = join(directory, config.providerConfig.slice('/etc/repo-chap/'.length));
  const providers = JSON.parse(await privateRead(providerPath));
  if (!providers.profiles?.[profileName]) throw new PilotError('The selected provider profile is missing');
  providers.profiles[profileName].maximumCapabilities = pilotCapabilities;
  await writePrivate(providerPath, JSON.stringify(providers, null, 2));
  const policy = {
    schemaVersion: 1, repository: run.repository, capabilities: pilotCapabilities,
    maxRepairsPerLifecycle: 3, maxPushAttempts: 2,
    execution: { schemaVersion: 1, allowedPaths: ['src'], excludedPaths: [], requiredChecks: [
      { id: 'pilot-regression', executable: '/opt/vite-plus/bin/vp', args: ['node', 'tests/pilot-regression.mjs'], timeoutMs: 120000, maxOutputBytes: 1048576 },
    ] },
  };
  await writePrivate(join(directory, 'pilot-apply.json'), JSON.stringify(policy, null, 2));
  config.applyPolicies = ['/etc/repo-chap/pilot-apply.json'];
  await writePrivate(join(directory, 'installation.json'), JSON.stringify(config, null, 2));
}
