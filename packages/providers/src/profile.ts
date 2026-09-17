import { lstat, realpath, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseJson, supportedCapabilities } from '@repo-chap/workflow';
import type { ProviderProfile } from './types.js';

export class ProviderConfigurationError extends Error {}
export function validateProfile(profile: ProviderProfile): void {
  if (profile.provider !== 'codex' || typeof profile.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(profile.name) || typeof profile.executable !== 'string' || !profile.executable || typeof profile.model !== 'string' || !profile.model || profile.effort !== undefined && (typeof profile.effort !== 'string' || !profile.effort) || /[\x00-\x1f\x7f]/.test(profile.executable + profile.model + (profile.effort ?? '')))
    throw new ProviderConfigurationError('Choose a Codex profile with a name, executable, and explicit model.');
  if (!Array.isArray(profile.maximumCapabilities) || profile.maximumCapabilities.some(value => !supportedCapabilities.includes(value)))
    throw new ProviderConfigurationError('The operator profile must declare maximumCapabilities using supported capability names.');
  for (const [key, ceiling] of [['timeoutMs', 3_600_000], ['maxOutputBytes', 16 * 1024 * 1024], ['maxAttempts', 2]] as const)
    if (!Number.isSafeInteger(profile[key]) || profile[key] < 1 || profile[key] > ceiling) throw new ProviderConfigurationError(`${key} must be an integer from 1 to ${ceiling}.`);
}
export async function readProfile(path: string, name: string): Promise<ProviderProfile> {
  try {
  const absolute = resolve(path), info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 || info.mode & 0o077 || process.getuid && info.uid !== process.getuid())
    throw new ProviderConfigurationError('Provider settings must be your private regular file with mode 0600, outside Git.');
  for (let parent = dirname(await realpath(absolute)); ; parent = dirname(parent)) {
    if (await lstat(join(parent, '.git')).catch(() => null)) throw new ProviderConfigurationError('Keep provider settings outside Git.');
    if (dirname(parent) === parent) break;
  }
  const document = parseJson(await readFile(absolute, 'utf8'), 'provider settings') as { schemaVersion?: unknown; profiles?: Record<string, unknown> };
  if (!document || document.schemaVersion !== 1 || !document.profiles || Object.keys(document).some(key => !['schemaVersion', 'profiles'].includes(key))) throw new ProviderConfigurationError('Provider settings require schemaVersion 1 and profiles.');
  const value = document.profiles[name];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['provider', 'executable', 'model', 'effort', 'timeoutMs', 'maxOutputBytes', 'maxAttempts', 'maximumCapabilities'].includes(key)))
    throw new ProviderConfigurationError('The selected provider profile is missing or contains unsupported settings.');
  const profile = { executable: 'codex', timeoutMs: 120_000, maxOutputBytes: 1024 * 1024, maxAttempts: 1, ...value, name } as ProviderProfile;
  validateProfile(profile); return profile;
  } catch (error) {
    if (error instanceof ProviderConfigurationError) throw error;
    throw new ProviderConfigurationError('Cannot read valid provider settings. Use a private version-1 JSON file outside Git and select an existing profile.');
  }
}
