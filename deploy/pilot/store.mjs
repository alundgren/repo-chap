import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open, rename, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PilotError } from './io.mjs';

export async function outsideGit(path) {
  if (!isAbsolute(path)) throw new PilotError('Use an absolute operator path outside Git');
  for (let parent = path; ; parent = dirname(parent)) {
    const info = await lstat(parent).catch(() => null);
    if (info?.isSymbolicLink()) throw new PilotError('Operator paths must not contain symlinks');
    if (await lstat(join(parent, '.git')).catch(() => null)) throw new PilotError('Keep operator files outside Git');
    if (dirname(parent) === parent) break;
  }
}
export async function privateDirectory(path, create = false) {
  await outsideGit(path);
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.mode & 0o077 || info.uid !== process.getuid())
    throw new PilotError('Operator directories must be owned by you with mode 0700');
  return realpath(path);
}
export async function privateRead(path) {
  await outsideGit(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid() || info.size > 1048576)
      throw new PilotError('Operator files must be owned by you, private, and at most 1 MiB');
    return await file.readFile();
  } finally { await file.close(); }
}
export async function writePrivate(path, data) {
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  await rename(temp, path);
}
export function markers(run) {
  return [run.name, `${run.name}-v1`, `${run.name}-created-${run.created}`, `${run.name}-expires-${run.expires}`];
}
export function validateRun(run) {
  if (run.version !== 1 || !/^[a-f0-9]{24}$/.test(run.id) || run.name !== `rcp-${run.id}` ||
      !Number.isSafeInteger(run.created) || !Number.isSafeInteger(run.expires) || run.expires <= run.created ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(run.repository))
    throw new PilotError('Invalid run ownership manifest; restore its protected backup before cleanup');
  return run;
}
export class Store {
  constructor(root) { this.root = resolve(root); }
  directory(id) {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new PilotError('Use the complete run ID');
    return join(this.root, id);
  }
  async load(id) {
    await privateDirectory(this.root);
    const directory = this.directory(id);
    await privateDirectory(directory);
    let run;
    try { run = JSON.parse(await privateRead(join(directory, 'manifest.json'))); }
    catch { throw new PilotError('Cannot read run manifest; restore manifest.backup.json before retrying'); }
    validateRun(run);
    if (run.id !== id) throw new PilotError('Run directory and manifest disagree');
    return run;
  }
  async save(run) {
    validateRun(run);
    const directory = this.directory(run.id);
    await privateDirectory(directory, true);
    const text = JSON.stringify(run, null, 2) + '\n';
    await writePrivate(join(directory, 'manifest.backup.json'), text);
    await writePrivate(join(directory, 'manifest.json'), text);
  }
  async runs() {
    await privateDirectory(this.root);
    const results = [];
    for (const id of await readdir(this.root)) {
      if (/^[a-f0-9]{24}$/.test(id)) results.push(await this.load(id));
    }
    return results;
  }
}
