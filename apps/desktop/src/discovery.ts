import { execFile } from 'node:child_process';
import { readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { readFixtureText } from '@repo-chap/workflow';
import type { WorkflowEntry } from '@repo-chap/companion';

export function repositoryPath(root: string, file: string): string {
  const path = relative(root, resolve(root, file));
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('Choose a workflow inside the selected repository.');
  return path.split(sep).join('/');
}

export async function discoverWorkflows(root: string, known: string[] = []): Promise<{ workflows: WorkflowEntry[]; warning: string | null }> {
  let paths: string[] = [], warning: string | null = null;
  const maximum = 2000;
  try {
    const { stdout } = await promisify(execFile)('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.json'], { maxBuffer: 4 * 1024 * 1024, timeout: 5000 });
    paths = [...new Set(stdout.split('\0').filter(Boolean))];
  } catch {
    let visited = 0;
    const excluded = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.next', '.venv']);
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++visited > 20_000 || paths.length > maximum) { warning = 'Workflow discovery was limited. Open a workflow by path with the CLI.'; return; }
        const path = join(directory, entry.name);
        if (entry.isDirectory() && !excluded.has(entry.name)) await walk(path);
        else if (entry.isFile() && entry.name.endsWith('.json')) paths.push(repositoryPath(root, path));
      }
    };
    await walk(root);
  }
  if (paths.length > maximum) warning = 'Workflow discovery was limited to 2000 JSON files. Open a workflow by path with the CLI.';
  paths = [...new Set([...known, '.repo-chap/workflow.json', ...paths.slice(0, maximum)])].sort();
  const workflows: WorkflowEntry[] = [];
  for (const path of paths) {
    let candidate = known.includes(path) || /^(workflow(?:-.*)?|.*\.workflow)\.json$/.test(basename(path));
    let id: string | null = null;
    try {
      const target = await realpath(resolve(root, path));
      repositoryPath(root, target);
      const value = JSON.parse(await readFixtureText(target));
      if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.rules) && value.actions && 'schemaVersion' in value) {
        candidate = true;
        if (typeof value.id === 'string') id = value.id;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
    }
    if (candidate) workflows.push({ path, id });
  }
  return { workflows, warning };
}
