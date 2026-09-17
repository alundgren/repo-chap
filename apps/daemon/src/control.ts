import { createConnection, createServer, type Server } from 'node:net';
import { chmod, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareCaptureDirectory } from '@repo-chap/github';
import { RuntimeError } from '@repo-chap/runtime';
import type { WorkflowPackage } from '@repo-chap/workflow';
import type { DaemonService } from './service.js';

const maximum = 20 * 1024 * 1024;
export type ControlRequest = { method: 'status' } | { method: 'inspect' | 'cancel' | 'retry'; runId: string } |
  { method: 'pause' | 'resume'; repository: string } | { method: 'register'; name: string; package: WorkflowPackage; profile: string; reviewers: string[] };
export interface ControlResponse { schemaVersion: 1; ok: boolean; result?: unknown; error?: string }
export async function handleControl(service: DaemonService, request: ControlRequest): Promise<unknown> {
  if (!request || typeof request !== 'object') throw new RuntimeError('Send a valid daemon command.');
  switch (request.method) {
    case 'status': return service.status();
    case 'register': return service.register(request);
    case 'inspect': {
      if (typeof request.runId !== 'string') throw new RuntimeError('Inspect requires a run ID.');
      const details = service.store.inspect(request.runId);
      return { ...details, inspection: await service.store.artifacts.get(details.run.inspection), results: await Promise.all(details.notes.map(async item => {
        const note = item as { revision: number; artifact: Parameters<typeof service.store.artifacts.get>[0] };
        return { revision: note.revision, result: await service.store.artifacts.get(note.artifact) };
      })) };
    }
    case 'pause': case 'resume':
      if (typeof request.repository !== 'string') throw new RuntimeError('Pause and resume require a registered repository.');
      return service.store.pause(request.repository, request.method === 'pause', service.now());
    case 'cancel': {
      if (typeof request.runId !== 'string') throw new RuntimeError('Cancel requires a run ID.');
      const result = service.store.cancel(request.runId); service.abortStale(); return result;
    }
    case 'retry':
      if (typeof request.runId !== 'string') throw new RuntimeError('Retry requires a run ID.');
      return service.store.retry(request.runId, service.now());
    default: throw new RuntimeError('Unknown daemon command. Use status, register, inspect, pause, resume, cancel, or retry.');
  }
}
export async function serveControl(directory: string, service: DaemonService): Promise<{ socket: string; close: () => Promise<void> }> {
  const root = await prepareCaptureDirectory(directory), path = join(root, 'control.sock');
  if (Buffer.byteLength(path) > 100) throw new RuntimeError('The Unix socket path is too long. Choose a shorter private state directory.');
  const prior = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
  if (prior) {
    if (!prior.isSocket()) throw new RuntimeError('The control socket path contains another file. Inspect the state directory.');
    await rm(path);
  }
  const sockets = new Set<ReturnType<typeof createConnection>>();
  const server: Server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.setTimeout(330_000, () => socket.destroy());
    let data = Buffer.alloc(0), used = false;
    socket.on('data', async bytes => {
      if (used) return;
      if (data.length + bytes.length > maximum) { used = true; socket.end(`${JSON.stringify({ schemaVersion: 1, ok: false, error: 'Daemon request exceeds 20 MiB.' })}\n`); return; }
      data = Buffer.concat([data, bytes]);
      const end = data.indexOf(10); if (end < 0) return; used = true;
      let response: ControlResponse;
      try { response = { schemaVersion: 1, ok: true, result: await handleControl(service, JSON.parse(data.subarray(0, end).toString('utf8'))) }; }
      catch (error) { response = { schemaVersion: 1, ok: false, error: error instanceof RuntimeError ? error.message : 'Daemon command failed. Check the command, private inputs, and repository access.' }; }
      const text = JSON.stringify(response);
      socket.end(`${Buffer.byteLength(text) <= maximum ? text : JSON.stringify({ schemaVersion: 1, ok: false, error: 'Response is too large. Inspect one run at a time.' })}\n`);
    });
  });
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.removeListener('error', reject); resolve(); }); });
  await chmod(path, 0o600);
  return { socket: path, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(path, { force: true }); } };
}
export async function requestControl(directory: string, request: ControlRequest): Promise<ControlResponse> {
  const root = await prepareCaptureDirectory(directory), path = join(root, 'control.sock');
  return new Promise((resolve, reject) => {
    const socket = createConnection(path); let data = Buffer.alloc(0), settled = false;
    const fail = () => { if (settled) return; settled = true; socket.destroy(); reject(new RuntimeError('Cannot reach the local daemon. Check --state-dir and start the daemon on this machine.')); };
    socket.setTimeout(330_000, fail); socket.on('error', fail); socket.on('end', () => { if (!settled) fail(); });
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', chunk => {
      if (settled) return;
      if (data.length + chunk.length > maximum) { fail(); return; } data = Buffer.concat([data, chunk]);
      if (!data.includes(10)) return;
      try {
        const response = JSON.parse(data.subarray(0, data.indexOf(10)).toString('utf8')) as ControlResponse;
        if (response.schemaVersion !== 1 || typeof response.ok !== 'boolean') throw new Error();
        settled = true; socket.destroy(); resolve(response);
      } catch { fail(); }
    });
  });
}
