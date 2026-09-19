import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function repositoryIdentity(root: string): Promise<{ repositoryName: string; worktreeName: string | null }> {
  const fallback = { repositoryName: basename(root), worktreeName: null };
  try {
    const { stdout } = await execute('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir'],
      { timeout: 3000, maxBuffer: 64 * 1024 });
    const [top, common, git] = stdout.trim().split('\n');
    if (!top || !common || !git || await realpath(top) !== root) return fallback;
    if (await realpath(common) === await realpath(git)) return fallback;
    return { repositoryName: basename(common) === '.git' ? basename(dirname(common)) : basename(common).replace(/\.git$/, ''), worktreeName: basename(root) };
  } catch {
    // Plain directories and machines without Git can still display workflows.
    return fallback;
  }
}
