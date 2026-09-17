import { constants } from 'node:fs';
import { link, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareCaptureDirectory } from '@repo-chap/github';
import { canonicalJson, digest } from '@repo-chap/workflow';
import type { ArtifactRef } from './types.js';

export class RuntimeError extends Error {}
const maximum = 32 * 1024 * 1024;
export class ArtifactStore {
  constructor(private readonly directory: string) {}
  async put(value: unknown): Promise<ArtifactRef> {
    const root = await prepareCaptureDirectory(this.directory), text = canonicalJson(JSON.parse(JSON.stringify(value))), bytes = Buffer.byteLength(text);
    if (bytes > maximum) throw new RuntimeError('Artifact exceeds the 32 MiB limit.');
    const hash = digest(text), ref = { id: hash.slice(7), digest: hash, bytes };
    const pending = join(root, `${randomUUID()}.pending`), file = await open(pending, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    try {
      try { await link(pending, join(root, ref.id)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await this.get(ref); }
      const folder = await open(root, 'r'); try { await folder.sync(); } finally { await folder.close(); }
    } finally { await rm(pending, { force: true }); }
    return ref;
  }
  async get<T = unknown>(ref: ArtifactRef): Promise<T> {
    if (!ref || !/^[a-f0-9]{64}$/.test(ref.id) || ref.digest !== `sha256:${ref.id}` || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > maximum) throw new RuntimeError('Invalid artifact reference.');
    const root = await prepareCaptureDirectory(this.directory), file = await open(join(root, ref.id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== ref.bytes || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw new RuntimeError('Artifact is not a private file with the expected size.');
      const buffer = Buffer.alloc(ref.bytes + 1); let length = 0;
      while (length < buffer.length) { const read = await file.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
      if (length !== ref.bytes || digest(text) !== ref.digest) throw new RuntimeError('Artifact digest mismatch.');
      return JSON.parse(text) as T;
    } finally { await file.close(); }
  }
}
