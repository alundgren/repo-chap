import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, readFileSync } from 'node:fs';
import type { Inspection } from '@repo-chap/github';
import { remote } from './daemon-remote.ts';

// Only subprocess tests import this helper. All GitHub reads and Git remotes are fictional/local.
const fixture = JSON.parse(readFileSync(process.env.REPO_CHAP_APPLY_FIXTURE!, 'utf8')) as {
  inspection: Inspection; remote: string; requests: string; mode?: 'crash' | 'read_failure' | 'offline';
};
const fake = remote(fixture.inspection, 3), originalSpawn = childProcess.spawn;
globalThis.fetch = async (url, init) => {
  if (fixture.mode === 'offline') throw new Error('Offline inspect attempted network access.');
  const request = JSON.parse(String(init?.body)); appendFileSync(fixture.requests, JSON.stringify(request.variables) + '\n');
  const head = childProcess.execFileSync('git', ['rev-parse', 'refs/heads/update'], { cwd: fixture.remote, encoding: 'utf8' }).trim();
  fixture.inspection.evidence.pullRequest!.headSha = head;
  for (const thread of fixture.inspection.evidence.threads.items) for (const comment of thread.comments.items) comment.headSha = head;
  if (fixture.mode === 'read_failure' && request.query.includes('query PushTarget')) return Response.json({ data: null, errors: [{ message: 'Temporary fixture read failure.' }] });
  return fake.fetch(url, init);
};
childProcess.spawn = ((command: string, args: string[], options: object) => {
  if (fixture.mode === 'offline') throw new Error('Offline inspect attempted to start a process.');
  const rewritten = command === 'git' ? args.map(arg => arg === 'https://github.com/reef-labs/paperboat.git' ? fixture.remote : arg) : args;
  const child = originalSpawn(command, rewritten, options);
  if (fixture.mode === 'crash' && command === 'git' && args.includes('push')) child.once('close', code => {
    if (code === 0) process.kill(process.pid, 'SIGKILL');
  });
  return child;
}) as typeof childProcess.spawn;
syncBuiltinESMExports();
