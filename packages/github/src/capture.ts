import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { canonicalJson, digest, parseFixture, parseJson, type WorkflowPackage } from '@repo-chap/workflow';
import { object } from './client.js';
import { validateTarget, type Evidence, type Inspection } from './inspect.js';

export class CaptureError extends Error {
  constructor(message: string) { super(message); this.name = 'CaptureError'; }
}
export async function prepareCaptureDirectory(directory: string): Promise<string> {
  try {
    const absolute = resolve(directory);
    let existing = absolute;
    while (true) {
      try { existing = await realpath(existing); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(existing) === existing) throw error;
        existing = dirname(existing);
      }
    }
    for (let parent = existing; ; parent = dirname(parent)) {
      const git = await lstat(join(parent, '.git')).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (git) throw new CaptureError('Choose a private capture directory outside every Git checkout.');
      if (dirname(parent) === parent) break;
    }
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    const info = await lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid())
      throw new CaptureError('Choose a directory owned by you with mode 0700. Capture directories cannot be symlinks.');
    return await realpath(absolute);
  } catch (error) {
    if (error instanceof CaptureError) throw error;
    throw new CaptureError('Cannot prepare the private capture directory. Check its path and permissions.');
  }
}
export async function saveCapture(directory: string, inspection: Inspection): Promise<{ directory: string; fixture: string; evidence: string }> {
  const root = await prepareCaptureDirectory(directory);
  let target: string | undefined;
  try {
    target = await mkdtemp(join(root, 'inspection-'));
    const fixture = parseFixture(inspection.fixture);
    const document = {
      schemaVersion: 1, status: inspection.status, packageDigest: inspection.packageDigest,
      evidenceDigest: inspection.evidenceDigest, fixtureDigest: digest(canonicalJson(fixture)), evidence: inspection.evidence,
    };
    if (document.evidenceDigest !== digest(canonicalJson(document.evidence))) throw new CaptureError('Evidence changed before capture. Inspect again.');
    const paths = { directory: target, fixture: join(target, 'fixture.json'), evidence: join(target, 'evidence.json') };
    await writeFile(paths.evidence, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await writeFile(paths.fixture, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return paths;
  } catch (error) {
    if (target) await rm(target, { recursive: true, force: true });
    if (error instanceof CaptureError) throw error;
    throw new CaptureError('Cannot save the capture. Check available space and directory permissions.');
  }
}
async function readJson(file: string): Promise<unknown> {
  const handle = await open(file, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new CaptureError('Capture entries must be regular files.');
    const maximum = 32 * 1024 * 1024;
    const data = Buffer.alloc(maximum + 1); let length = 0;
    while (length < data.length) {
      const read = await handle.read(data, length, data.length - length, null);
      if (!read.bytesRead) break; length += read.bytesRead;
    }
    if (length > maximum) throw new CaptureError('Capture exceeds the 32 MiB file limit.');
    return parseJson(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, length)), file);
  } finally { await handle.close(); }
}
export async function readCapture(directory: string, pkg: WorkflowPackage): Promise<Inspection> {
  try {
    const document = object(await readJson(join(directory, 'evidence.json')));
    const fixture = parseFixture(await readJson(join(directory, 'fixture.json')));
    const evidence = object(document.evidence);
    if (document.schemaVersion !== 1 || evidence.schemaVersion !== 1 || document.packageDigest !== pkg.digest ||
      document.evidenceDigest !== digest(canonicalJson(evidence)) || document.fixtureDigest !== digest(canonicalJson(fixture)) || fixture.observations.length !== 1)
      throw new CaptureError('Capture versions or digests do not match. Use both files from the same inspection and its pinned workflow package.');
    const requested = object(evidence.requested);
    validateTarget(String(requested.repository), Number(requested.pr));
    const observation = fixture.observations[0]!;
    const pr = evidence.pullRequest === null ? null : object(evidence.pullRequest);
    if (observation.evidenceDigest !== document.evidenceDigest || observation.headSha !== pr?.headSha || observation.baseSha !== pr?.baseSha ||
      document.status !== (pr ? observation.facts.evidenceComplete === true ? 'complete' : 'partial' : 'unavailable'))
      throw new CaptureError('Fixture identity does not match the captured evidence.');
    for (const name of ['labels', 'checks', 'reviews', 'threads', 'reviewerActivity']) {
      const collection = object(evidence[name]);
      if (!Array.isArray(collection.items) || !['complete', 'partial', 'unknown'].includes(String(object(collection.coverage).status)))
        throw new CaptureError('Capture collections are invalid.');
    }
    if (!Array.isArray(evidence.configuredReviewers) || !['stable', 'changed', 'unknown'].includes(String(object(evidence.revision).status)))
      throw new CaptureError('Capture provenance is invalid.');
    return { schemaVersion: 1, status: document.status as Inspection['status'], packageDigest: pkg.digest,
      evidenceDigest: document.evidenceDigest as string, evidence: evidence as unknown as Evidence, fixture };
  } catch (error) {
    if (error instanceof CaptureError) throw error;
    throw new CaptureError('Cannot read a valid capture. Use the fixture and evidence files from one inspection.');
  }
}
