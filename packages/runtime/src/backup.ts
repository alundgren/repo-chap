import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { prepareCaptureDirectory } from '@repo-chap/github';
import { RuntimeError } from './artifacts.js';
import { claimProcess, releaseProcess } from './ownership.js';
import { RuntimeStore, validateLimits } from './store.js';
import type { AnalysisJob, AnalysisResult, ArtifactRef, RepairAttemptJob, RepairAttemptResult, RepositoryRecord, RunRecord, RuntimeLimits, WorkflowVersion } from './types.js';
import type { RepairResult, ArtifactRef as ExecutionArtifact } from '@repo-chap/execution';
import type { SlackRequestRecord } from './slack.js';

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
const fileMaximum = (path: string) => path === 'runtime.sqlite' ? databaseLimit : receiptPath.test(path) ? 16 * 1024 : path.startsWith('artifacts/') ? 32 * 1024 * 1024 : fileLimit;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function privateDirectory(path: string, optional = false): Promise<void> {
  const info = await lstat(path).catch(error => { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
  if (info && (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid())) throw new RuntimeError('Artifact directories must be private account-owned directories without symlinks.');
}
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
  const actual = await fingerprint(join(root, file.path), fileMaximum(file.path));
  if (actual.bytes !== file.bytes || actual.digest !== file.digest) throw new RuntimeError('Backup integrity check failed. Keep the original state and choose a complete, unmodified backup.');
}
async function freshDestination(source: string, destination: string): Promise<{ target: string; staging: string }> {
  const parent = await prepareCaptureDirectory(dirname(resolve(destination))), target = join(parent, basename(resolve(destination)));
  const relation = relative(source, target);
  const outsideSource = relation === '..' || relation.startsWith(`..${sep}`);
  if (!outsideSource || source.startsWith(`${target}${sep}`)) throw new RuntimeError('Choose a backup or restore destination outside its source directory.');
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
export async function inspectStoredConfiguration(directory: string): Promise<{ schema: string | null; repositories: { name: string; profile: string }[] }> {
  const root = await prepareCaptureDirectory(directory);
  if (!await lstat(join(root, 'runtime.sqlite')).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; })) return { schema: null, repositories: [] };
  await databaseFiles(root);
  const db = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
  try { return { schema: databaseVersion(db), repositories: db.prepare('SELECT data FROM repositories').all().map(row => {
    const repo = JSON.parse(String(row.data)) as RepositoryRecord; return { name: repo.name, profile: repo.profile };
  }) }; } finally { db.close(); }
}
async function validateReferences(root: string, files: SavedFile[], schema: string): Promise<void> {
  const entries = new Map(files.map(file => [file.path, file]));
  const results = new Set<string>(), repairs = new Set<string>();
  const reference = (ref: ArtifactRef | ExecutionArtifact, store: 'artifacts' | 'repairs'): string => {
    const path = `${store}/${ref?.id}`, saved = entries.get(path);
    if (!ref || !artifactPath.test(path) || !saved || saved.digest !== ref.digest || saved.bytes !== ref.bytes)
      throw new RuntimeError('A database or artifact reference is missing or corrupt. Retain the original installation and repair its durable artifact store before backup or restore.');
    return path;
  };
  const job = (value: AnalysisJob | RepairAttemptJob): void => {
    if ('kind' in value && value.kind === 'repair' && value.review) reference(value.review, 'artifacts');
    reference(value.package, 'artifacts'); reference(value.inspection, 'artifacts'); reference(value.sources, 'kind' in value && value.kind === 'repair' ? 'repairs' : 'artifacts');
  };
  const repair = (ref: ExecutionArtifact): void => { repairs.add(reference(ref, 'repairs')); };
  const repairResult = (result: RepairResult): void => {
    reference(result.job, 'repairs');
    if (result.source) reference(result.source, 'repairs');
    if (result.candidate) { reference(result.candidate.bundle, 'repairs'); reference(result.candidate.patch, 'repairs'); }
    for (const check of result.checks) if (check.log) reference(check.log, 'repairs');
  };
  const readJson = async <T>(path: string): Promise<T> => {
    const input = await privateFile(join(root, path), fileMaximum(path));
    try { return JSON.parse(await input.readFile('utf8')) as T; } finally { await input.close(); }
  };
  const db = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
  try {
    if (databaseVersion(db) !== schema) throw new RuntimeError('Backup manifest does not match its SQLite schema. Use an intact backup.');
    if (Object.values(db.prepare('PRAGMA quick_check').get() ?? {})[0] !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) throw new RuntimeError('SQLite integrity check failed. Keep the original state and recover a complete backup.');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
    const values = function* <T>(table: string, column: string): Generator<T> {
      if (tables.has(table)) for (const row of db.prepare(`SELECT ${quote(column)} AS value FROM ${quote(table)}`).iterate()) if (row.value !== null) yield JSON.parse(String(row.value)) as T;
    };
    for (const repo of values<RepositoryRecord>('repositories', 'data')) if (repo.package) reference(repo.package, 'artifacts');
    for (const run of values<RunRecord>('runs', 'data')) {
      reference(run.package, 'artifacts'); reference(run.inspection, 'artifacts');
      for (const retained of [run.repair, run.threadResolution?.repair]) if (retained) { job(retained.job); repair(retained.result); }
    }
    for (const version of values<WorkflowVersion>('workflow_versions', 'data')) reference(version.package, 'artifacts');
    for (const ref of values<ArtifactRef>('observations', 'artifact')) reference(ref, 'artifacts');
    for (const value of values<AnalysisJob | RepairAttemptJob>('attempts', 'job')) job(value);
    for (const [table, column] of [['attempts', 'result'], ['notes', 'artifact']] as const)
      for (const ref of values<ArtifactRef>(table, column)) results.add(reference(ref, 'artifacts'));
    for (const effect of values<{ payload: ArtifactRef }>('effects', 'request')) reference(effect.payload, 'artifacts');
    for (const request of values<SlackRequestRecord>('slack_requests', 'data')) for (const ref of [request.packet, request.preview, request.supersededPreview]) reference(ref, 'artifacts');
    for (const path of results) {
      const result = await readJson<AnalysisResult | RepairAttemptResult>(path); job(result.job);
      if ('repair' in result) { repair(result.reference); repairResult(result.repair); }
    }
    for (const entry of files.filter(file => receiptPath.test(file.path))) {
      const receipt = await readJson<{ job: ExecutionArtifact; result?: ExecutionArtifact }>(entry.path);
      reference(receipt.job, 'repairs'); if (receipt.result) repair(receipt.result);
    }
    for (const path of repairs) repairResult(await readJson<RepairResult>(path));
  } finally { db.close(); }
}
export async function backupState(directory: string, destination: string, input?: Partial<RuntimeLimits>): Promise<BackupManifest> {
  let db: DatabaseSync | undefined, ownership: string | undefined, staging: string | undefined;
  try {
    const root = await databaseFiles(directory); db = new DatabaseSync(join(root, 'runtime.sqlite'));
    const runtimeSchema = databaseVersion(db); ownership = claimProcess(db);
    const stored = db.prepare("SELECT value FROM metadata WHERE key='installation_limits'").get();
    const limits = validateLimits(stored ? JSON.parse(String(stored.value)) : input);
    if (input && Object.entries(input).some(([key, value]) => limits[key as keyof RuntimeLimits] !== value)) throw new RuntimeError('Backup configuration differs from the last active installation limits. Use the unchanged service configuration.');
    const paths = await freshDestination(root, destination); staging = paths.staging;
    const databasePath = join(staging, 'runtime.sqlite'), reserved = await open(databasePath, 'wx', 0o600); await reserved.close();
    await backup(db, databasePath); await chmod(databasePath, 0o600);
    const snapshot = new DatabaseSync(databasePath);
    try { snapshot.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;'); } finally { snapshot.close(); }
    const database = await privateFile(databasePath, databaseLimit); try { await database.sync(); } finally { await database.close(); }
    const files: SavedFile[] = [{ path: 'runtime.sqlite', ...await fingerprint(databasePath, databaseLimit) }];
    for (const store of ['artifacts', 'repairs']) {
      await mkdir(join(staging, store), { mode: 0o700 });
      await privateDirectory(join(root, store), true);
      const entries = await readdir(join(root, store)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
      for (const id of entries.sort()) {
        if (id.endsWith('.pending') || store === 'repairs' && /^(worker|source)-/.test(id)) continue;
        const path = `${store}/${id}`;
        if (!artifactPath.test(path) && !receiptPath.test(path) || files.length >= maximumFiles) throw new RuntimeError('Unexpected durable artifact entry or too many files. Inspect the private stores before backup.');
        const saved = await copyFile(join(root, path), join(staging, path), fileMaximum(path));
        if (artifactPath.test(path) && saved.digest !== `sha256:${id}`) throw new RuntimeError('Durable artifact digest mismatch. Keep the original state and repair the artifact store.');
        files.push({ path, ...saved });
      }
      await syncDirectory(join(staging, store));
    }
    await validateReferences(staging, files, runtimeSchema);
    const manifest: BackupManifest = { schemaVersion: 1, createdAt: new Date().toISOString(), runtimeSchema, limits, files };
    const contents = JSON.stringify(manifest);
    if (Buffer.byteLength(contents) > manifestLimit) throw new RuntimeError('Backup inventory exceeds its size limit. Keep the original state and use a compatible release.');
    const manifestFile = await open(join(staging, 'manifest.json'), 'wx', 0o600);
    try { await manifestFile.writeFile(contents); await manifestFile.sync(); } finally { await manifestFile.close(); }
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
    if (!manifest.limits || Object.keys(manifest.limits).length !== Object.keys(validateLimits()).length) throw new RuntimeError('Backup lacks complete installation limits. Use an intact backup.');
    validateLimits(manifest.limits);
    for (const store of ['artifacts', 'repairs']) await privateDirectory(join(root, store));
    for (const suffix of ['-wal', '-shm', '-journal']) if (await lstat(join(root, `runtime.sqlite${suffix}`)).catch(() => null)) throw new RuntimeError('Backup contains SQLite journal files. Use the standalone snapshot produced by daemon backup.');
    const names = new Set<string>();
    for (const saved of manifest.files) {
      if (!saved || !(saved.path === 'runtime.sqlite' || artifactPath.test(saved.path) || receiptPath.test(saved.path)) || names.has(saved.path) || !Number.isSafeInteger(saved.bytes) || saved.bytes < 0 || !/^sha256:[a-f0-9]{64}$/.test(saved.digest) || artifactPath.test(saved.path) && saved.digest !== `sha256:${basename(saved.path)}`)
        throw new RuntimeError('Invalid backup file inventory. Existing state has not been changed.');
      names.add(saved.path); await checkFile(root, saved);
    }
    if (!names.has('runtime.sqlite')) throw new RuntimeError('The backup has no SQLite database.');
    await validateReferences(root, manifest.files, manifest.runtimeSchema);
    const paths = await freshDestination(root, destination); staging = paths.staging;
    for (const name of ['artifacts', 'repairs']) await mkdir(join(staging, name), { mode: 0o700 });
    for (const saved of manifest.files) {
      const copied = await copyFile(join(root, saved.path), join(staging, saved.path), fileMaximum(saved.path));
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
