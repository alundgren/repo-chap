import { createConnection, createServer, type Socket } from 'node:net';
import { lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseCompanionRequest, type CompanionRequest, type CompanionResponse } from './protocol.js';

export function controlDirectory(): string {
  return resolve(process.env.REPO_CHAP_DESKTOP_CONTROL ?? join(homedir(), '.repo-chap', 'desktop'));
}
export async function privateDirectory(directory: string, create = false): Promise<string> {
  const path = resolve(directory);
  let ancestor = path;
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error; ancestor = dirname(ancestor); }
  }
  for (let parent = ancestor; ; parent = dirname(parent)) {
    if (await lstat(join(parent, '.git')).catch(() => null)) throw new Error('Keep desktop state and control files outside Git repositories.');
    if (dirname(parent) === parent) break;
  }
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || process.getuid && info.uid !== process.getuid()) throw new Error('The desktop control directory must be owned by you with mode 0700 and cannot be a symbolic link.');
  return await realpath(path);
}
function socketPath(directory: string): string {
  const path = join(directory, 'control.sock');
  if (Buffer.byteLength(path) > 100) throw new Error('Desktop socket path is too long. Set REPO_CHAP_DESKTOP_CONTROL to a shorter private directory for both the CLI and app.');
  return path;
}
const failure = (error: unknown): CompanionResponse => ({ schemaVersion: 1, ok: false, error: error instanceof Error ? error.message : 'Desktop command failed.' });

export async function serveCompanion(directory: string, handle: (request: CompanionRequest) => Promise<CompanionResponse>): Promise<() => Promise<void>> {
  const path = socketPath(await privateDirectory(directory, true));
  const previous = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (previous) {
    if (!previous.isSocket() || process.getuid && previous.uid !== process.getuid()) throw new Error('The desktop control path is occupied by another file.');
    const active = await new Promise<boolean>((resolve, reject) => {
      const probe = createConnection(path);
      probe.setTimeout(1000, () => { probe.destroy(); reject(new Error('The desktop socket is unresponsive. Close the existing app before restarting.')); });
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', error => { if (['ECONNREFUSED', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) resolve(false); else reject(error); });
    });
    if (active) throw new Error('Repo Chap is already running with this control directory.');
    const current = await lstat(path).catch(() => null);
    if (current?.ino === previous.ino && current.dev === previous.dev) await unlink(path);
  }
  const clients = new Set<Socket>();
  const server = createServer(socket => {
    clients.add(socket); socket.once('close', () => clients.delete(socket)); socket.on('error', () => {});
    socket.setTimeout(10_000, () => socket.destroy());
    let input = '', bytes = 0, received = false;
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      if (received) return;
      input += chunk; bytes += Buffer.byteLength(chunk);
      if (bytes > 16 * 1024) { received = true; socket.end(JSON.stringify(failure(new Error('Desktop command exceeds 16 KiB.'))) + '\n'); return; }
      if (!input.includes('\n')) return;
      received = true;
      void (async () => {
        try { const request = parseCompanionRequest(JSON.parse(input)); socket.end(JSON.stringify(await handle(request)) + '\n'); }
        catch (error) { socket.end(JSON.stringify(failure(error)) + '\n'); }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.removeListener('error', reject); resolve(); }); });
  const identity = await lstat(path);
  return async () => {
    for (const socket of clients) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const current = await lstat(path).catch(() => null);
    if (current?.ino === identity.ino && current.dev === identity.dev) await unlink(path);
  };
}

export async function requestCompanion(request: CompanionRequest, directory = controlDirectory()): Promise<CompanionResponse> {
  parseCompanionRequest(request);
  let path: string;
  try { path = socketPath(await privateDirectory(directory)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Start the Repo Chap desktop app, then retry this command.'); throw error; }
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let input = '', bytes = 0, complete = false;
    const fail = (error: Error): void => { if (complete) return; complete = true; socket.destroy(); reject(error); };
    socket.setEncoding('utf8');
    socket.setTimeout(10_000, () => fail(new Error('Desktop command timed out. Check desktop status before repeating the command.')));
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('error', error => fail(new Error(['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '') ? 'Start the Repo Chap desktop app, then retry this command.' : error.message)));
    socket.on('data', chunk => {
      input += chunk; bytes += Buffer.byteLength(chunk);
      if (bytes > 16 * 1024 * 1024) { fail(new Error('Desktop response exceeds 16 MiB.')); return; }
      if (!input.includes('\n')) return;
      try {
        const response = JSON.parse(input);
        if (response.schemaVersion !== 1 || typeof response.ok !== 'boolean' || (response.ok ? !response.state : typeof response.error !== 'string')) throw new Error('Invalid desktop response.');
        complete = true; socket.destroy(); resolve(response);
      } catch { fail(new Error('The desktop returned an invalid response.')); }
    });
    socket.once('close', () => { if (!complete) fail(new Error('Desktop disconnected before acknowledging the command. Check status before repeating it.')); });
  });
}
