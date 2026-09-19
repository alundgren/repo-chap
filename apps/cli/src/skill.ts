import { cp, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function skillCommand(args: string[]): Promise<void> {
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write('repo-chap skill install [--directory <skills-directory>] [--replace]\n\nInstalls repo-chap-workflows into ~/.agents/skills for use in any repository.\n--replace explicitly replaces an existing copy. No agent settings are changed.\n'); return;
  }
  let staging: string | undefined;
  let keepRecoveryCopy = false;
  try {
    if (args.shift() !== 'install') throw new Error('Use repo-chap skill install.');
    let directory = join(homedir(), '.agents', 'skills'), replace = false;
    const seen = new Set<string>();
    while (args.length) {
      const key = args.shift()!;
      if (seen.has(key)) throw new Error(`Repeated option: ${key}`);
      seen.add(key);
      if (key === '--replace') replace = true;
      else if (key === '--directory' && args[0] && !args[0].startsWith('-')) directory = resolve(args.shift()!);
      else throw new Error(`Invalid skill installation option: ${key}`);
    }
    const target = join(directory, 'repo-chap-workflows');
    const existing = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing && !replace) throw new Error(`A skill already exists at ${target}. Use --replace to replace that copy.`);
    if (existing?.isSymbolicLink()) throw new Error(`The existing skill is a symbolic link. Remove that link explicitly before installing a copy: ${target}`);
    await mkdir(directory, { recursive: true });
    staging = await mkdtemp(join(directory, '.repo-chap-install-'));
    const source = fileURLToPath(new URL('./skill/', import.meta.url));
    await cp(source, join(staging, 'new'), { recursive: true, errorOnExist: true });
    if (existing) await rename(target, join(staging, 'previous'));
    try { await rename(join(staging, 'new'), target); }
    catch (error) {
      if (existing) {
        try { await rename(join(staging, 'previous'), target); }
        catch { keepRecoveryCopy = true; throw new Error(`Skill installation failed. Your previous skill is retained at ${join(staging, 'previous')}. Restore that directory before retrying.`); }
      }
      throw error;
    }
    process.stdout.write(`Installed ${target}\nUse $repo-chap-workflows in your normal agent inside the repository you want to configure.\n`);
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'Skill installation failed.') + '\n'); process.exitCode = 64;
  } finally { if (staging && !keepRecoveryCopy) await rm(staging, { recursive: true, force: true }); }
}
