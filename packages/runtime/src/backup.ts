import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { prepareCaptureDirectory } from '@repo-chap/github';
import { RuntimeError } from './artifacts.js';
import { claimProcess, releaseProcess } from './ownership.js';
import { RuntimeStore, validateLimits } from './store.js';
import type { RuntimeLimits } from './types.js';

type SavedFile = { path: string; bytes: number; digest: string };
export interface BackupManifest {
  schemaVersion: 1;
  createdAt: string;
  runtimeSchema: string;
  limits: RuntimeLimits;
  files: SavedFile[];
}
const maximumFiles = 100_000;
const fileLimit = 128 * 1024 * 1024;
const manifestLimit = 32 * 1024 * 1024;
const databaseLimit = 16 * 1024 * 1024 * 1024;
const artifactPath = /^(artifacts|repairs)\/[a-f0-9]{64}$/;
const receiptPath = /^repairs\/attempt-[a-zA-Z0-9_-]{1,128}\.json$/;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function privateFile(path: string, maximum: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum || info.mode & 0o077 || process.getuid && info.uid !== process.getuid())
      throw new RuntimeError('Backup data must be bounded private regular files owned by the current account. Check ownership, permissions and available storage.');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
async function copyFile(source: string, destination: string, maximum: number): Promise<Omit<SavedFile, 'path'>> {
  const input = await privateFile(source, maximum);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    output = await open(destination, 'wx', 0o600);
    const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024); let bytes = 0;
    while (true) {
      const result = await input.read(buffer, 0, buffer.length, null); if (!result.bytesRead) break;
      bytes += result.bytesRead; if (bytes > maximum) throw new RuntimeError('Backup entry grew beyond its size limit. Stop all state writers and retry.');
      const chunk = buffer.subarray(0, result.bytesRead); digest.update(chunk); await output.writeFile(chunk);
    }
    await output.sync(); return { bytes, digest: `sha256:${digest.digest('hex')}` };
  } finally { await input.close(); await output?.close(); }
}
async function fingerprint(path: string, maximum: number): Promise<Omit<SavedFile, 'path'>> {
  const input = await privateFile(path, maximum);
  try {
    const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024); let bytes = 0;
    while (true) {
      const result = await input.read(buffer, 0, buffer.length, null); if (!result.bytesRead) break;
      bytes += result.bytesRead; if (bytes > maximum) throw new RuntimeError('Backup file exceeds its size limit.'); digest.update(buffer.subarray(0, result.bytesRead));
    }
    return { bytes, digest: `sha256:${digest.digest('hex')}` };
  } finally { await input.close(); }
}
async function checkFile(root: string, file: SavedFile): Promise<void> {
  const actual = await fingerprint(join(root, file.path), file.path === 'runtime.sqlite' ? databaseLimit : fileLimit);
  if (actual.bytes !== file.bytes || actual.digest !== file.digest) throw new RuntimeError('Backup integrity check failed. Keep the original state and choose a complete, unmodified backup.');
}
async function freshDestination(source: string, destination: string): Promise<{ target: string; staging: string }> {
  const parent = await prepareCaptureDirectory(dirname(resolve(destination))), target = join(parent, basename(resolve(destination)));
  const relation = relative(source, target);
  if (!relation || !relation.startsWith('..') || source.startsWith(`${target}/`)) throw new RuntimeError('Choose a backup or restore destination outside its source directory.');
  if (await lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; })) throw new RuntimeError('Backup and restore require a new destination directory. Existing data is never replaced.');
  const staging = join(parent, `.repo-chap-${randomUUID()}.pending`); await mkdir(staging, { mode: 0o700 });
  return { target, staging };
}
async function databaseFiles(directory: string): Promise<string> {
  const root = await prepareCaptureDirectory(directory);
  for (const suffix of ['', '-wal', '-shm']) {
    try { const file = await privateFile(join(root, `runtime.sqlite${suffix}`), databaseLimit); await file.close(); }
    catch (error) { if (suffix && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
  }
  return root;
}
function databaseVersion(db: DatabaseSync): string {
  const row = db.prepare("SELECT value FROM metadata WHERE key='schema'").get();
  if (!row || !['1', '2', '3', '4'].includes(String(row.value))) throw new RuntimeError('This binary cannot back up or restore that runtime schema. Use its matching release.');
  return String(row.value);
}
async function validateReferences(root: string, files: SavedFile[]): Promise<void> {
  const entries = new Map(files.map(file => [file.path, file])), pending = files.filter(file => receiptPath.test(file.path)).map(file => file.path), visited = new Set<string>(pending);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const item = value as Record<string, unknown>;
    if (typeof item.id === 'string' && typeof item.digest === 'string' && 'bytes' in item) {
      const path = `${'kind' in item ? 'repairs' : 'artifacts'}/${item.id}`, saved = entries.get(path);
      if (!artifactPath.test(path) || !saved || saved.digest !== item.digest || saved.bytes !== item.bytes)
        throw new RuntimeError('A database or artifact reference is missing or corrupt. Retain the original installation and repair its durable artifact store before backup or restore.');
      if ((!('kind' in item) || ['job', 'result'].includes(String(item.kind))) && !visited.has(path)) { visited.add(path); pending.push(path); }
    }
    Object.values(item).forEach(visit);
  };
  const db = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
  try {
    databaseVersion(db);
    if (Object.values(db.prepare('PRAGMA quick_check').get() ?? {})[0] !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) throw new RuntimeError('SQLite integrity check failed. Keep the original state and recover a complete backup.');
    for (const table of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      for (const row of db.prepare(`SELECT * FROM ${quote(String(table.name))}`).iterate()) for (const value of Object.values(row)) {
        if (typeof value !== 'string' || !/^[\s]*[\[{]/.test(value)) continue;
        let parsed: unknown; try { parsed = JSON.parse(value); } catch { continue; } visit(parsed);
      }
    }
    while (pending.length) {
      const path = pending.pop()!, input = await privateFile(join(root, path), fileLimit);
      try { visit(JSON.parse(await input.readFile('utf8'))); } finally { await input.close(); }
    }
  } finally { db.close(); }
}
export async function backupState(directory: string, destination: string, input: Partial<RuntimeLimits> = {}): Promise<BackupManifest> {
  let db: DatabaseSync | undefined, ownership: string | undefined, staging: string | undefined;
  try {
    const root = await databaseFiles(directory); db = new DatabaseSync(join(root, 'runtime.sqlite'));
    const runtimeSchema = databaseVersion(db); ownership = claimProcess(db);
    const paths = await freshDestination(root, destination); staging = paths.staging;
    const databasePath = join(staging, 'runtime.sqlite'), reserved = await open(databasePath, 'wx', 0o600); await reserved.close();
    await backup(db, databasePath); await chmod(databasePath, 0o600);
    const snapshot = new DatabaseSync(databasePath);
    try { snapshot.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;'); } finally { snapshot.close(); }
    const database = await privateFile(databasePath, databaseLimit); try { await database.sync(); } finally { await database.close(); }
    const files: SavedFile[] = [{ path: 'runtime.sqlite', ...await fingerprint(databasePath, databaseLimit) }];
    for (const store of ['artifacts', 'repairs']) {
      await mkdir(join(staging, store), { mode: 0o700 });
      const entries = await readdir(join(root, store)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
      for (const id of entries.sort()) {
        if (id.endsWith('.pending') || store === 'repairs' && id.startsWith('worker-')) continue;
        const path = `${store}/${id}`;
        if (!artifactPath.test(path) && !receiptPath.test(path) || files.length >= maximumFiles) throw new RuntimeError('Unexpected durable artifact entry or too many files. Inspect the private stores before backup.');
        const saved = await copyFile(join(root, path), join(staging, path), receiptPath.test(path) ? 16 * 1024 : fileLimit);
        if (artifactPath.test(path) && saved.digest !== `sha256:${id}`) throw new RuntimeError('Durable artifact digest mismatch. Keep the original state and repair the artifact store.');
        files.push({ path, ...saved });
      }
      await syncDirectory(join(staging, store));
    }
    await validateReferences(staging, files);
    const manifest: BackupManifest = { schemaVersion: 1, createdAt: new Date().toISOString(), runtimeSchema, limits: validateLimits(input), files };
    const manifestFile = await open(join(staging, 'manifest.json'), 'wx', 0o600);
    try { await manifestFile.writeFile(JSON.stringify(manifest)); await manifestFile.sync(); } finally { await manifestFile.close(); }
    await syncDirectory(staging); await rename(staging, paths.target); staging = undefined; await syncDirectory(dirname(paths.target)); return manifest;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('Backup failed. Stop the service, check private file ownership, free storage and the selected release, then retry into a new destination.');
  } finally { if (ownership) releaseProcess(db!, ownership); db?.close(); if (staging) await rm(staging, { recursive: true, force: true }); }
}
export async function restoreState(source: string, destination: string): Promise<BackupManifest> {
  let staging: string | undefined;
  try {
    const root = await prepareCaptureDirectory(source), file = await privateFile(join(root, 'manifest.json'), manifestLimit);
    let manifest: BackupManifest; try { manifest = JSON.parse(await file.readFile('utf8')); } finally { await file.close(); }
    if (manifest.schemaVersion !== 1 || !['1', '2', '3', '4'].includes(manifest.runtimeSchema) || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > maximumFiles)
      throw new RuntimeError('Unsupported backup manifest. Use a complete backup and its compatible release.');
    validateLimits(manifest.limits);
    const names = new Set<string>();
    for (const saved of manifest.files) {
      if (!saved || !(saved.path === 'runtime.sqlite' || artifactPath.test(saved.path) || receiptPath.test(saved.path)) || names.has(saved.path) || !Number.isSafeInteger(saved.bytes) || saved.bytes < 0 || !/^sha256:[a-f0-9]{64}$/.test(saved.digest) || artifactPath.test(saved.path) && saved.digest !== `sha256:${basename(saved.path)}`)
        throw new RuntimeError('Invalid backup file inventory. Existing state has not been changed.');
      names.add(saved.path); await checkFile(root, saved);
    }
    if (!names.has('runtime.sqlite')) throw new RuntimeError('The backup has no SQLite database.');
    await validateReferences(root, manifest.files);
    const paths = await freshDestination(root, destination); staging = paths.staging;
    for (const name of ['artifacts', 'repairs']) await mkdir(join(staging, name), { mode: 0o700 });
    for (const saved of manifest.files) {
      const copied = await copyFile(join(root, saved.path), join(staging, saved.path), saved.path === 'runtime.sqlite' ? databaseLimit : fileLimit);
      if (copied.digest !== saved.digest || copied.bytes !== saved.bytes) throw new RuntimeError('Backup changed while restoring. Retry from an unmodified backup.');
    }
    const snapshot = new DatabaseSync(join(staging, 'runtime.sqlite'));
    try { snapshot.prepare("DELETE FROM metadata WHERE key='daemon_owner'").run(); } finally { snapshot.close(); }
    const store = await RuntimeStore.open(staging, manifest.limits);
    try { store.prepareRestoredState(Date.now()); } finally { store.close(); }
    for (const name of ['artifacts', 'repairs']) await syncDirectory(join(staging, name));
    await syncDirectory(staging); await rename(staging, paths.target); staging = undefined; await syncDirectory(dirname(paths.target)); return manifest;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('Restore failed. Check the backup integrity, current account ownership, free storage and selected release. Existing state has not been replaced.');
  } finally { if (staging) await rm(staging, { recursive: true, force: true }); }
}
