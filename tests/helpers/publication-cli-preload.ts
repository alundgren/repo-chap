import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import type { Inspection } from '@repo-chap/github';
import { publicationRemote, type PublicationState } from './publication-remote.ts';

// Only subprocess tests import this helper. GitHub operations and source remotes are fictional/local.
const fixture = JSON.parse(readFileSync(process.env.REPO_CHAP_PUBLICATION_FIXTURE!, 'utf8')) as {
  inspection: Inspection; remote: string; state: string; requests: string; mode?: 'crash' | 'offline';
};
const state = JSON.parse(readFileSync(fixture.state, 'utf8')) as PublicationState;
const fake = publicationRemote(fixture.inspection, state, () => {
  writeFileSync(fixture.state, JSON.stringify(state));
  if (fixture.mode === 'crash') process.kill(process.pid, 'SIGKILL');
}), originalSpawn = childProcess.spawn;
globalThis.fetch = async (url, init) => {
  if (fixture.mode === 'offline') throw new Error('Offline inspect attempted network access.');
  appendFileSync(fixture.requests, JSON.stringify({ method: init?.method, path: new URL(String(url)).pathname }) + '\n');
  return fake.fetch(url, init);
};
childProcess.spawn = ((command: string, args: string[], options: object) => {
  if (fixture.mode === 'offline') throw new Error('Offline inspect attempted to start a process.');
  const rewritten = command === 'git' ? args.map(arg => arg === 'https://github.com/reef-labs/paperboat.git' ? fixture.remote : arg) : args;
  return originalSpawn(command, rewritten, options);
}) as typeof childProcess.spawn;
syncBuiltinESMExports();
