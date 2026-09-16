import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import type { Inspection } from '@repo-chap/github';
import { remote } from './daemon-remote.ts';

// Every endpoint is intercepted. Git objects and provider executables are fictional local fixtures.
const path = process.env.REPO_CHAP_SLACK_FIXTURE!;
const fixture = JSON.parse(readFileSync(path, 'utf8')) as { inspection: Inspection; remote: string; requests: string; policy: string; mode?: string };
const originalHead = fixture.inspection.evidence.pullRequest!.headSha;
const fake = remote(fixture.inspection, process.env.REPO_CHAP_SLACK_DAEMON ? 1 : 3), originalSpawn = childProcess.spawn;
const record = (kind: string, value: unknown) => appendFileSync(fixture.requests, JSON.stringify({ kind, value }) + '\n');
globalThis.fetch = async (url, init) => {
  const mode = JSON.parse(readFileSync(path, 'utf8')).mode;
  if (mode === 'offline') throw new Error('Offline inbox attempted network access.');
  const address = String(url), body = JSON.parse(String(init?.body));
  if (address.startsWith('https://slack.com/api/')) {
    const method = address.split('/').at(-1)!; record(method, body);
    if (method === 'auth.test') {
      if (mode === 'revoke') { const policy = JSON.parse(readFileSync(fixture.policy, 'utf8')); policy.capabilities = policy.capabilities.filter((capability: string) => capability !== 'notify.send'); writeFileSync(fixture.policy, JSON.stringify(policy)); }
      return Response.json({ ok: true, team_id: 'TFOREST' });
    }
    if (method === 'conversations.open') return Response.json({ ok: true, channel: { id: 'DWILLOW' } });
    if (mode === 'lost') throw new Error('Fictional message accepted but its response was lost.');
    if (mode === 'access') return Response.json({ ok: false, error: 'not_in_channel' });
    if (mode === 'crash') process.kill(process.pid, 'SIGKILL');
    return Response.json({ ok: true, channel: body.channel, ts: body.ts ?? '123.000001' });
  }
  if (address.endsWith('/access_tokens')) { record('app-token', { permissions: body.permissions, repositories: body.repositories }); return Response.json({ token: 'fictional-app-token', expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: body.permissions }); }
  if (address !== 'https://api.github.com/graphql') throw new Error(`Unexpected fixture endpoint ${address}`);
  record('github', { variables: body.variables, operation: body.query.split('(')[0] });
  let head = childProcess.execFileSync('git', ['rev-parse', 'refs/heads/update'], { cwd: fixture.remote, encoding: 'utf8' }).trim();
  if (mode === 'human_head' && body.query.startsWith('query InspectMetadata') && head !== originalHead) {
    const git = (...args: string[]) => childProcess.execFileSync('git', args, { cwd: fixture.remote, encoding: 'utf8' }).trim();
    const human = git('-c', 'user.name=Willow', '-c', 'user.email=willow@example.invalid', 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'Concurrent human update');
    git('update-ref', 'refs/heads/update', human, head); record('human-ref', { candidate: head, human }); head = human;
    const saved = JSON.parse(readFileSync(path, 'utf8')); saved.mode = 'valid'; writeFileSync(path, JSON.stringify(saved));
  }
  fixture.inspection.evidence.pullRequest!.headSha = head;
  if (body.query.startsWith('mutation ')) {
    const thread = fixture.inspection.evidence.threads.items.find(thread => thread.id === body.variables.id)!;
    thread.resolved = true;
    const saved = JSON.parse(readFileSync(path, 'utf8')); saved.inspection.evidence.threads = fixture.inspection.evidence.threads; writeFileSync(path, JSON.stringify(saved));
    return Response.json({ data: { resolveReviewThread: { thread: { id: thread.id, isResolved: true } } } });
  }
  return fake.fetch(url, init);
};
childProcess.spawn = ((command: string, args: string[], options: object) => {
  const rewritten = command === 'git' ? args.map(arg => arg === 'https://github.com/reef-labs/paperboat.git' ? fixture.remote : arg) : args;
  return originalSpawn(command, rewritten, options);
}) as typeof childProcess.spawn;
syncBuiltinESMExports();
