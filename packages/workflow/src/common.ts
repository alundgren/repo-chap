import { createHash } from 'node:crypto';
import type { Diagnostic } from './types.js';

export class WorkflowError extends Error {
  constructor(public readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map(d => `${d.path}: ${d.message}`).join('\n'));
    this.name = 'WorkflowError';
  }
}
export function fail(code: string, path: string, message: string): never {
  throw new WorkflowError([{ code, path, message }]);
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const digest = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
export function parseJson(text: string, path: string): unknown {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail('invalid_json', path, 'Invalid JSON. Check commas, quotes, and braces.'); }
  const stack: { object: boolean; keys: Set<string>; keyExpected: boolean }[] = [];
  for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g)) {
    const part = token[0];
    if (part === '{' || part === '[') {
      stack.push({ object: part === '{', keys: new Set(), keyExpected: part === '{' });
      if (stack.length > 64) fail('size_limit', path, 'JSON nesting exceeds depth 64.');
    } else if (part === '}' || part === ']') stack.pop();
    else {
      const current = stack.at(-1);
      if (!current?.object) continue;
      if (part === ',') current.keyExpected = true;
      else if (part === ':') current.keyExpected = false;
      else if (part.startsWith('"') && current.keyExpected) {
        const key = JSON.parse(part) as string;
        if (current.keys.has(key)) fail('duplicate_key', path, `Duplicate JSON property: ${key}`);
        current.keys.add(key);
      }
    }
  }
  return value;
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export const normalizeId = (id: string): string => id.normalize('NFKC').trim().toLowerCase();
