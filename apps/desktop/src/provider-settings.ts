import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readProfiles, runProcess, validateProfile } from '@repo-chap/providers';
import type { ProviderProfile } from '@repo-chap/providers';

export interface ProviderChoice { provider: 'codex' | 'claude'; model: string }
export interface ProviderModel { id: string; label: string }

export async function providerModels(provider: string, directory: string): Promise<ProviderModel[]> {
  if (provider !== 'codex' && provider !== 'claude') throw new Error('Choose Codex or Claude.');
  const result = await runProcess(provider, provider === 'codex' ? ['debug', 'models', '--bundled'] : ['--version'], { cwd: directory, timeoutMs: 10_000, maxBytes: 4 * 1024 * 1024 });
  if (result.status !== 'exited' || result.exitCode !== 0) throw new Error(`Cannot find a supported ${provider === 'codex' ? 'Codex' : 'Claude Code'} CLI. Install it, log in from your terminal, then retry.`);
  if (provider === 'claude') return ['sonnet', 'opus', 'haiku'].map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }));
  try {
    const data = JSON.parse(result.stdout.toString());
    const models = data.models.filter((model: any) => typeof model.slug === 'string' && model.slug.length > 0).map((model: any) => ({ id: model.slug, label: typeof model.display_name === 'string' ? model.display_name : model.slug }));
    if (!models.length) throw new Error();
    return models;
  } catch { throw new Error('Cannot read the installed Codex model list. Update Codex, then retry.'); }
}

export function desktopProfile(choice: ProviderChoice): ProviderProfile {
  if (!choice || !['codex', 'claude'].includes(choice.provider) || typeof choice.model !== 'string' || choice.model.length > 200) throw new Error('Choose a provider and model.');
  const profile: ProviderProfile = { name: `desktop_${choice.provider}`, provider: choice.provider, executable: choice.provider, model: choice.model.trim(), timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024, maxAttempts: 1, maximumCapabilities: [] };
  validateProfile(profile);
  return profile;
}

export async function saveDesktopProfiles(directory: string, profiles: ProviderProfile[]): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(directory);
  for (let parent = root; ; parent = dirname(parent)) {
    if (await lstat(join(parent, '.git')).catch(() => null)) throw new Error('Keep desktop provider settings outside Git.');
    if (dirname(parent) === parent) break;
  }
  const temporary = await mkdtemp(join(root, '.providers-'));
  try {
    const path = join(temporary, 'providers.json');
    await writeFile(path, JSON.stringify({ schemaVersion: 1, profiles: Object.fromEntries(profiles.map(({ name, ...profile }) => [name, profile])) }, null, 2) + '\n', { mode: 0o600 });
    await readProfiles(path);
    await rename(path, join(root, 'providers.json'));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
