import { lstat, readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { ExecutionPolicy } from './types.js';

export class ExecutionError extends Error {}
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validPath(path: unknown): path is string {
  return typeof path === 'string' && !!path && !/[\\\x00-\x1f\x7f]/.test(path) && !path.startsWith('/') && path === posix.normalize(path) && !path.split('/').some(part => part === '..' || part === '.' || part === '.git');
}
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
export function validatePolicy(value: unknown): asserts value is ExecutionPolicy {
  if (!object(value) || value.schemaVersion !== 1 || !keys(value, ['schemaVersion', 'allowedPaths', 'excludedPaths', 'requiredChecks']) ||
    !Array.isArray(value.allowedPaths) || !value.allowedPaths.length || value.allowedPaths.length > 256 || !value.allowedPaths.every(validPath) ||
    !Array.isArray(value.excludedPaths) || value.excludedPaths.length > 256 || !value.excludedPaths.every(validPath) ||
    !Array.isArray(value.requiredChecks) || !value.requiredChecks.length || value.requiredChecks.length > 32)
    throw new ExecutionError('Execution policy requires version 1, allowedPaths and excludedPaths directory/file prefixes, and 1 to 32 requiredChecks.');
  const ids = new Set<string>();
  for (const check of value.requiredChecks) {
    if (!object(check) || !keys(check, ['id', 'executable', 'args', 'timeoutMs', 'maxOutputBytes']) || typeof check.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(check.id) || ids.has(check.id) ||
      typeof check.executable !== 'string' || !check.executable || /[\x00-\x1f\x7f]/.test(check.executable) ||
      !Array.isArray(check.args) || check.args.length > 128 || check.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > 64 * 1024) ||
      !Number.isSafeInteger(check.timeoutMs) || Number(check.timeoutMs) < 1 || Number(check.timeoutMs) > 3_600_000 ||
      !Number.isSafeInteger(check.maxOutputBytes) || Number(check.maxOutputBytes) < 1 || Number(check.maxOutputBytes) > 16 * 1024 * 1024)
      throw new ExecutionError('Each required check needs a unique id, executable, args, timeoutMs from 1 to 3600000, and maxOutputBytes from 1 to 16777216.');
    ids.add(check.id);
  }
}
export async function readExecutionPolicy(path: string): Promise<ExecutionPolicy> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error();
    const value = JSON.parse(await readFile(path, 'utf8')); validatePolicy(value); return value;
  } catch (error) { if (error instanceof ExecutionError) throw error; throw new ExecutionError('Use a regular execution policy JSON file below 256 KiB.'); }
}
export function permittedPath(path: string, policy: ExecutionPolicy): boolean {
  const matches = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
  return validPath(path) && !path.split('/').includes('node_modules') && !path.split('/').includes('.repo-chap') &&
    policy.allowedPaths.some(matches) && !policy.excludedPaths.some(matches);
}
