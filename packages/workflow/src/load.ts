import { open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fail, parseJson, WorkflowError } from './common.js';
import { buildPackage, referencePath, workflowReferences } from './package.js';
import { limits, validateWorkflow } from './validate.js';
import type { Capability, WorkflowPackage } from './types.js';

async function readBounded(path: string): Promise<string> {
  try {
    const handle = await open(path, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile()) fail('invalid_file', path, 'Reference must be a regular file.');
      if (info.size > limits.fileBytes) fail('size_limit', path, 'File exceeds 1 MiB.');
      const buffer = Buffer.alloc(limits.fileBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > limits.fileBytes) fail('size_limit', path, 'File exceeds 1 MiB.');
      try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)); }
      catch { return fail('invalid_encoding', path, 'File must contain valid UTF-8.'); }
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    return fail('file_read', path, `Cannot read file: ${(error as NodeJS.ErrnoException).code ?? 'I/O error'}.`);
  }
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
async function discoverRoot(file: string): Promise<string> {
  for (let directory = dirname(file); ; directory = dirname(directory)) {
    try { await stat(resolve(directory, '.git')); return directory; } catch { /* Continue to the repository ancestor. */ }
    if (dirname(directory) === directory) fail('repository_root', file, 'No Git repository found. Supply --repo-root for a plain directory.');
  }
}
export async function loadWorkflow(file: string, options: { repositoryRoot?: string; maximumCapabilities?: readonly Capability[] } = {}): Promise<WorkflowPackage> {
  const absolute = resolve(file);
  let root: string;
  try { root = await realpath(options.repositoryRoot ?? await discoverRoot(absolute)); }
  catch (error) { if (error instanceof WorkflowError) throw error; return fail('repository_root', file, 'Repository root does not exist.'); }
  if (!within(root, absolute)) fail('outside_repository', file, 'Workflow file must be within the repository root.');
  const workflowPath = relative(root, absolute).split(sep).join('/');
  const files: Record<string, string> = Object.create(null);
  const targets: Record<string, string> = Object.create(null);
  let totalBytes = 0;
  async function capture(path: string): Promise<void> {
    if (Object.hasOwn(files, path)) return;
    let target: string;
    try { target = await realpath(resolve(root, path)); }
    catch { return fail('missing_file', path, 'Referenced file does not exist.'); }
    if (!within(root, target)) fail('outside_repository', path, 'Reference resolves outside the repository root.');
    files[path] = await readBounded(target); targets[path] = target;
    totalBytes += Buffer.byteLength(files[path]);
    if (totalBytes > limits.packageBytes) fail('size_limit', workflowPath, 'Package exceeds 8 MiB.');
  }
  await capture(workflowPath);
  const workflow = validateWorkflow(parseJson(files[workflowPath]!, workflowPath), options.maximumCapabilities);
  const refs = [...new Set(workflowReferences(workflow).map(ref => referencePath(workflowPath, ref).path))];
  if (refs.length >= limits.files) fail('size_limit', workflowPath, 'Package exceeds 256 files.');
  for (const ref of refs) await capture(ref);
  const pkg = buildPackage(workflowPath, files, options);
  for (const [path, text] of Object.entries(files)) {
    let current: string;
    try { current = await realpath(resolve(root, path)); } catch { return fail('snapshot_changed', path, 'File changed during loading. Try again.'); }
    if (current !== targets[path] || await readBounded(current) !== text) fail('snapshot_changed', path, 'File changed during loading. Try again.');
  }
  return pkg;
}
export const readFixtureText = readBounded;
