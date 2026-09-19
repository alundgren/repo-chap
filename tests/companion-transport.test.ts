import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection, createServer } from 'node:net';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { requestCompanion, serveCompanion } from '@repo-chap/companion';
import { CompanionSession } from '../apps/desktop/src/companion.ts';
import { companionFixture } from './helpers/companion-fixture.ts';

const cli = resolve('apps/cli/dist/cli.js');
function raw(path: string, text: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path); let response = '';
    socket.setEncoding('utf8'); socket.on('error', reject); socket.on('connect', () => socket.write(text));
    socket.on('data', data => { response += data; }); socket.on('end', () => { try { resolve(JSON.parse(response)); } catch (error) { reject(error); } });
  });
}

test('CLI controls the app through a private local socket, reports wrong repositories and reconnects after restart', async t => {
  const f = await companionFixture(); t.after(f.cleanup);
  const session = new CompanionSession();
  let stop = await serveCompanion(f.control, request => session.execute(request));
  t.after(async () => { await stop(); });
  const run = async (...args: string[]) => {
    try { const result = await promisify(execFile)(process.execPath, [cli, 'desktop', ...args, '--json'], { cwd: f.repository, env: { ...process.env, REPO_CHAP_DESKTOP_CONTROL: f.control } }); return { status: 0, json: JSON.parse(result.stdout) }; }
    catch (error: any) { return { status: error.code, json: JSON.parse(error.stdout) }; }
  };
  const open = await run('open', '--workflow', f.pkg.workflowPath); assert.equal(open.status, 0); assert.equal(open.json.state.workflow.id, 'team-pr');
  const simulate = await run('simulate', '--fixture', f.fixturePath); assert.equal(simulate.status, 0); assert.equal(simulate.json.state.simulation.comparison.passed, true);
  const annotation = 'Review waits here. $() and <script> stay plain text.';
  const highlighted = await run('highlight', '--target', 'result', '--text', annotation, '--style', 'arrow');
  assert.equal(highlighted.json.state.guidance.text, annotation);
  const wrong = await run('clear', '--repo-root', f.temporary); assert.equal(wrong.status, 8); assert.match(wrong.json.error, /another repository/);
  assert.equal(session.snapshot().guidance!.text, annotation);
  assert.equal((await run('status')).json.state.input.path, f.fixturePath);
  assert.equal((await lstat(f.control)).mode & 0o777, 0o700);
  await assert.rejects(serveCompanion(f.control, request => session.execute(request)), /already running/);
  await stop(); stop = async () => {};
  const closed = await run('status'); assert.equal(closed.status, 8); assert.match(closed.json.error, /Start.*desktop/);
  stop = await serveCompanion(f.control, request => session.execute(request));
  assert.equal((await run('status')).status, 0);
});

test('socket rejects malformed and oversized commands and refuses unsafe control directories', async t => {
  const f = await companionFixture(); t.after(f.cleanup);
  let calls = 0;
  const session = new CompanionSession();
  const stop = await serveCompanion(f.control, request => { calls++; return session.execute(request); }); t.after(stop);
  assert.equal((await raw(join(f.control, 'control.sock'), '{\n')).ok, false);
  assert.equal((await raw(join(f.control, 'control.sock'), 'x'.repeat(17 * 1024) + '\n')).ok, false);
  assert.equal((await raw(join(f.control, 'control.sock'), JSON.stringify({ schemaVersion: 1, command: { kind: 'eval', script: 'anything' } }) + '\n')).ok, false);
  assert.equal(calls, 0);
  await mkdir(join(f.repository, '.git'));
  await assert.rejects(serveCompanion(join(f.repository, 'private'), request => session.execute(request)), /outside Git/);
  const publicDirectory = join(f.temporary, 'public'); await mkdir(publicDirectory); await chmod(publicDirectory, 0o755);
  await assert.rejects(serveCompanion(publicDirectory, request => session.execute(request)), /0700/);
});

test('startup preserves an occupied control file and a disconnected request never reports success', async t => {
  const f = await companionFixture(); t.after(f.cleanup);
  await mkdir(f.control, { mode: 0o700 }); const path = join(f.control, 'control.sock');
  await writeFile(path, 'keep this file');
  await assert.rejects(serveCompanion(f.control, request => new CompanionSession().execute(request)), /occupied/);
  assert.equal(await readFile(path, 'utf8'), 'keep this file');
  const other = join(f.temporary, 'disconnect'); await mkdir(other, { mode: 0o700 });
  const server = createServer(socket => socket.destroy());
  await new Promise<void>(resolve => server.listen(join(other, 'control.sock'), resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  await assert.rejects(requestCompanion({ schemaVersion: 1, command: { kind: 'status' } }, other), /disconnected|EPIPE|reset/);
});

test('the control socket recovers after the previous app process crashes', async t => {
  const f = await companionFixture(); t.after(f.cleanup);
  await mkdir(f.control, { mode: 0o700 }); const path = join(f.control, 'control.sock');
  const child = spawn(process.execPath, ['-e', "require('node:net').createServer().listen(process.argv[1], () => process.stdout.write('ready'))", path], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('Socket fixture exited before listening.'))); });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exited;
  assert.equal((await lstat(path)).isSocket(), true);
  const session = new CompanionSession(); const stop = await serveCompanion(f.control, request => session.execute(request)); t.after(stop);
  assert.equal((await requestCompanion({ schemaVersion: 1, command: { kind: 'status' } }, f.control)).ok, true);
});
