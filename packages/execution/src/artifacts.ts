import { constants } from 'node:fs';
import { link, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { prepareCaptureDirectory } from '@repo-chap/github';
import { canonicalJson } from '@repo-chap/workflow';
import { ExecutionError } from './policy.js';
import type { ArtifactRef, RepairResult } from './types.js';

export const artifactLimit = 128 * 1024 * 1024;
const hash = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export function validArtifact(ref: ArtifactRef): boolean {
  return !!ref && /^[a-f0-9]{64}$/.test(ref.id) && ref.digest === `sha256:${ref.id}` && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 && ref.bytes <= artifactLimit && ['job', 'result', 'source', 'bundle', 'patch', 'log'].includes(ref.kind);
}
export async function putArtifact(directory: string, kind: ArtifactRef['kind'], bytes: Buffer | string): Promise<ArtifactRef> {
  const root = await prepareCaptureDirectory(directory), data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (data.length > artifactLimit) throw new ExecutionError('Artifact exceeds the 128 MiB limit.');
  const digest = hash(data), ref = { id: digest.slice(7), digest, bytes: data.length, kind };
  const temporary = join(root, `artifact-${randomUUID()}.pending`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    try { await link(temporary, join(root, ref.id)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await readArtifact(root, ref); }
  } finally { await rm(temporary, { force: true }); }
  return ref;
}
export const putJson = (directory: string, kind: ArtifactRef['kind'], value: unknown) => putArtifact(directory, kind, canonicalJson(value));
export async function readArtifact(directory: string, ref: ArtifactRef): Promise<Buffer> {
  if (!validArtifact(ref)) throw new ExecutionError('Invalid logical artifact reference.');
  const root = await prepareCaptureDirectory(directory), handle = await open(join(root, ref.id), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== ref.bytes || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new ExecutionError('Artifact metadata does not match its private reference.');
    const bytes = Buffer.alloc(ref.bytes + 1); let count = 0;
    while (count < bytes.length) { const result = await handle.read(bytes, count, bytes.length - count, null); if (!result.bytesRead) break; count += result.bytesRead; }
    const data = bytes.subarray(0, count);
    if (data.length !== ref.bytes || hash(data) !== ref.digest) throw new ExecutionError('Artifact digest mismatch.');
    return data;
  } finally { await handle.close(); }
}
export async function readRepairResult(directory: string, ref: ArtifactRef): Promise<RepairResult> {
  if (ref.kind !== 'result') throw new ExecutionError('Expected a repair result artifact.');
  const result = JSON.parse((await readArtifact(directory, ref)).toString('utf8')) as RepairResult;
  if (result.schemaVersion !== 1 || !validArtifact(result.job) || !Array.isArray(result.checks)) throw new ExecutionError('Unsupported repair result.');
  const job = JSON.parse((await readArtifact(directory, result.job)).toString('utf8'));
  for (const key of ['runId', 'attemptId', 'ownershipToken', 'deadline', 'repositoryId', 'pullRequestId', 'headSha', 'baseSha', 'policyDigest', 'profileDigest'] as const)
    if (result[key] !== job[key]) throw new ExecutionError('Repair result does not match its job.');
  if (result.packageDigest !== job.package.digest || result.evidenceDigest !== job.inspection.evidenceDigest) throw new ExecutionError('Repair input digests do not match.');
  if (result.candidate && (result.payload?.outcome !== 'candidate' || result.payload.candidateSha !== result.candidate.sha || result.checks.some(check => check.candidateSha !== result.candidate!.sha))) throw new ExecutionError('Candidate and check revisions do not match.');
  if (result.requiredChecksPassed && (!result.candidate || result.status !== 'candidate' || job.policy.requiredChecks.length !== result.checks.length ||
    result.checks.some((check, index) => check.status !== 'passed' || check.id !== job.policy.requiredChecks[index].id))) throw new ExecutionError('Required check receipts are incomplete.');
  return result;
}
