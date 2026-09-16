import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, dirname } from 'node:path';
import { installationCredentials, prepareCaptureDirectory } from '@repo-chap/github';
import { readProfile } from '@repo-chap/providers';
import { RuntimeError, validateLimits, type RuntimeLimits } from '@repo-chap/runtime';
import type { DaemonDependencies } from './service.js';

async function privateText(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new RuntimeError('Installation file paths must be absolute paths outside Git.');
  await prepareCaptureDirectory(dirname(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1_048_576 || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw new RuntimeError('Installation files must be owned by the daemon account with mode 0600 and fit within 1 MiB.');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}
export async function loadInstallation(path: string, directory: string): Promise<{ dependencies: DaemonDependencies; limits: RuntimeLimits }> {
  try {
    const config = JSON.parse(await privateText(path)) as { schemaVersion: number; app: { appId: string; installationId: number; privateKeyFile: string }; providerConfig: string; limits?: Partial<RuntimeLimits> };
    if (config.schemaVersion !== 1 || !config.app || Object.keys(config).some(key => !['schemaVersion', 'app', 'providerConfig', 'limits'].includes(key)) ||
      Object.keys(config.app).some(key => !['appId', 'installationId', 'privateKeyFile'].includes(key)) || typeof config.app.appId !== 'string' || !isAbsolute(config.providerConfig)) throw new RuntimeError('Unsupported daemon installation configuration.');
    await privateText(config.providerConfig);
    const credentials = installationCredentials({ appId: config.app.appId, installationId: config.app.installationId, privateKey: await privateText(config.app.privateKeyFile) });
    return { limits: validateLimits(config.limits), dependencies: { directory, credentials, profile: name => readProfile(config.providerConfig, name) } };
  } catch (error) { if (error instanceof RuntimeError) throw error; throw new RuntimeError('Cannot load private installation settings. Check the JSON, GitHub App key and provider profile paths.'); }
}
