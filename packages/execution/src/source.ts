import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareCaptureDirectory } from '@repo-chap/github';
import { artifactLimit, putArtifact, readArtifact } from './artifacts.js';
import { git, gitProcess, initializeCheckout } from './git.js';
import { ExecutionError } from './policy.js';
import type { ArtifactRef } from './types.js';

export async function captureRepairSource(repository: string, head: string, base: string, directory: string, signal?: AbortSignal): Promise<ArtifactRef> {
  if (![head, base].every(value => /^[a-f0-9]{40}$/.test(value))) throw new ExecutionError('Source capture requires full commit IDs.');
  const root = await prepareCaptureDirectory(directory), temporary = await mkdtemp(join(root, 'source-')), deadline = Date.now() + 60_000;
  try {
    await initializeCheckout(temporary, repository, head, base, deadline, signal);
    await git(temporary, ['update-ref', 'refs/heads/source-head', head], deadline, signal);
    await git(temporary, ['update-ref', 'refs/heads/source-base', base], deadline, signal);
    const bundle = await gitProcess(temporary, ['bundle', 'create', '-', 'refs/heads/source-head', 'refs/heads/source-base'], deadline, signal, artifactLimit);
    if (bundle.status !== 'exited' || bundle.exitCode !== 0) throw new ExecutionError('Cannot retain repair source history within the artifact limit.');
    return await putArtifact(root, 'bundle', bundle.stdout);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
export async function restoreRepairSource(directory: string, reference: ArtifactRef, destination: string, signal?: AbortSignal): Promise<void> {
  if (reference.kind !== 'bundle') throw new ExecutionError('Repair source must be a Git bundle.');
  const root = await prepareCaptureDirectory(destination), temporary = await mkdtemp(join(root, 'source-')), bundle = join(temporary, 'source.bundle'), deadline = Date.now() + 30_000;
  try {
    await writeFile(bundle, await readArtifact(directory, reference), { mode: 0o600, flag: 'wx' });
    await git(root, ['init', '--bare', '--quiet', '--template='], deadline, signal);
    await git(root, ['fetch', '--quiet', '--no-tags', bundle, 'refs/heads/source-head:refs/heads/source-head', 'refs/heads/source-base:refs/heads/source-base'], deadline, signal);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
