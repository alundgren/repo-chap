import { canonicalJson, digest, supportedCapabilities, type Capability } from '@repo-chap/workflow';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { validatePolicy, type ExecutionPolicy } from '@repo-chap/execution';
import { prepareCaptureDirectory, validateTarget } from '@repo-chap/github';
import { RuntimeError } from './artifacts.js';

export interface ApplyPolicy {
  schemaVersion: 1; repository: string; capabilities: Capability[];
  maxRepairsPerLifecycle: number; maxPushAttempts: number; execution?: ExecutionPolicy;
}
export const applyPolicyDigest = (policy: ApplyPolicy): string => digest(canonicalJson(policy));
export async function readApplyPolicy(path: string): Promise<ApplyPolicy> {
  try {
    if (!isAbsolute(path)) throw new Error();
    await prepareCaptureDirectory(dirname(path));
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 1_048_576 || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw new Error();
      const policy = JSON.parse(await file.readFile('utf8')); validateApplyPolicy(policy); return policy;
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('Use a private apply policy outside Git, owned by this account with mode 0600 and no larger than 1 MiB.');
  }
}
export function validateApplyPolicy(value: unknown): asserts value is ApplyPolicy {
  const p = value as ApplyPolicy;
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.schemaVersion !== 1 ||
    Object.keys(p).some(key => !['schemaVersion', 'repository', 'capabilities', 'maxRepairsPerLifecycle', 'maxPushAttempts', 'execution'].includes(key)) ||
    !Array.isArray(p.capabilities) || p.capabilities.some(cap => !supportedCapabilities.includes(cap)) || new Set(p.capabilities).size !== p.capabilities.length ||
    !Number.isSafeInteger(p.maxRepairsPerLifecycle) || p.maxRepairsPerLifecycle < 1 || p.maxRepairsPerLifecycle > 1000 ||
    !Number.isSafeInteger(p.maxPushAttempts) || p.maxPushAttempts < 1 || p.maxPushAttempts > 100)
    throw new RuntimeError('Apply policy requires version 1, one repository, permitted capabilities, and bounded repair and push attempts.');
  try { validateTarget(p.repository, 1); if (p.execution) validatePolicy(p.execution); }
  catch { throw new RuntimeError('Apply policy has an invalid repository or execution policy.'); }
}
export function requireApplyPolicy(policy: ApplyPolicy | null, repository: string, capabilities: readonly Capability[]): ApplyPolicy {
  validateApplyPolicy(policy);
  if (policy!.repository.toLowerCase() !== repository.toLowerCase() || capabilities.some(cap => !policy!.capabilities.includes(cap)))
    throw new RuntimeError('The private apply policy does not authorize these capabilities for this repository.');
  return policy!;
}
