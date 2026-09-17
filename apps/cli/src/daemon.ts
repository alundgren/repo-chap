import { resolve } from 'node:path';
import { loadWorkflow } from '@repo-chap/workflow';
import { requestControl, startDaemon, type ControlRequest } from '@repo-chap/daemon';

export const daemonHelp = `Daemon commands use a private local Unix socket. The daemon runs analysis on Linux.

  repo-chap daemon start --state-dir <private-directory> --config <private-installation.json>
  repo-chap daemon register <workflow.json> --repo <owner/name> --profile <name> --state-dir <directory> [--repo-root <directory>] [--reviewers <login,login>] [--json]
  repo-chap daemon status --state-dir <directory> [--json]
  repo-chap daemon inspect <run-id> --state-dir <directory> [--json]
  repo-chap daemon pause --repo <owner/name-or-id> --state-dir <directory> [--json]
  repo-chap daemon resume --repo <owner/name-or-id> --state-dir <directory> [--json]
  repo-chap daemon cancel <run-id> --state-dir <directory> [--json]
  repo-chap daemon retry <run-id> --state-dir <directory> [--json]

Start stays in the foreground. Ctrl-C stops the daemon and active providers.
Pause stops new dispatch for a repository; active analysis can finish.
Cancel fences a run and stops its provider. Retry retains every attempt and budget charge.
Analysis never pushes, publishes, sends messages, or merges. Exit 7 means a daemon command failed.
`;
export async function daemonCommand(args: string[]): Promise<void> {
  const json = args.includes('--json');
  try {
    const command = args.shift();
    if (!command || args.includes('--help') || command === '--help') { process.stdout.write(daemonHelp); return; }
    if (!['start', 'register', 'status', 'inspect', 'pause', 'resume', 'cancel', 'retry'].includes(command)) throw new Error('Unknown daemon command. See repo-chap daemon --help.');
    const positional = ['register', 'inspect', 'cancel', 'retry'].includes(command) ? args.shift() : undefined;
    if (['register', 'inspect', 'cancel', 'retry'].includes(command) && (!positional || positional.startsWith('-'))) throw new Error(`${command} requires ${command === 'register' ? 'a workflow path' : 'a run ID'}.`);
    const options: Record<string, string> = {}, seen = new Set<string>();
    const allowed = ['--state-dir', '--json', ...(command === 'start' ? ['--config'] : []), ...(['pause', 'resume', 'register'].includes(command) ? ['--repo'] : []), ...(command === 'register' ? ['--profile', '--repo-root', '--reviewers'] : [])];
    while (args.length) {
      const option = args.shift()!;
      if (!allowed.includes(option) || seen.has(option)) throw new Error(`Unknown or repeated option: ${option}. See repo-chap daemon --help.`);
      seen.add(option); if (option === '--json') continue;
      const value = args.shift(); if (!value || value.startsWith('-')) throw new Error(`${option} requires a value.`); options[option] = value;
    }
    if (!options['--state-dir']) throw new Error('Daemon commands require --state-dir <private-directory>.');
    const directory = resolve(options['--state-dir']);
    if (command === 'start') {
      if (!options['--config']) throw new Error('Start requires --config <private-installation.json>.');
      const daemon = await startDaemon(directory, resolve(options['--config']));
      process.stdout.write(json ? `${JSON.stringify({ schemaVersion: 1, status: 'started', mode: 'analysis' })}\n` : 'Daemon started in analysis mode. Use daemon status with the same state directory.\n');
      await new Promise<void>(done => {
        const stop = () => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); void daemon.stop().then(done, done); };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
      }); return;
    }
    let request: ControlRequest;
    if (command === 'register') {
      if (!options['--repo'] || !options['--profile']) throw new Error('Register requires --repo and --profile.');
      request = { method: 'register', name: options['--repo'], profile: options['--profile'], reviewers: options['--reviewers']?.split(',').map(value => value.trim()) ?? [], package: await loadWorkflow(positional!, { repositoryRoot: options['--repo-root'] }) };
    } else if (command === 'pause' || command === 'resume') {
      if (!options['--repo']) throw new Error(`${command} requires --repo <registered-name-or-id>.`);
      request = { method: command, repository: options['--repo'] };
    } else if (command === 'status') request = { method: command };
    else request = { method: command as 'inspect' | 'cancel' | 'retry', runId: positional! };
    const response = await requestControl(directory, request);
    if (!response.ok) { process.exitCode = 7; if (json) process.stdout.write(`${JSON.stringify(response, null, 2)}\n`); else process.stderr.write(`${response.error}\n`); return; }
    if (json) process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    else process.stdout.write(humanResult(command, response.result));
  } catch (error) {
    process.exitCode = 7;
    const message = error instanceof Error ? error.message : 'Daemon command failed.';
    if (json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: false, error: message })}\n`); else process.stderr.write(`${message}\n`);
  }
}
function humanResult(command: string, value: unknown): string {
  const data = value as Record<string, any>;
  if (command === 'status') return ['Daemon analysis mode', ...(data.githubRetryAt ? [`GitHub retry after ${new Date(data.githubRetryAt).toISOString()}`] : []),
    ...data.repositories.map((repo: any) => `${repo.name}: ${repo.paused ? 'paused' : 'active'}${repo.diagnostic ? `. ${repo.diagnostic}` : ''}`),
    ...data.runs.map((run: any) => `${run.id} PR #${run.number}: ${run.status}. ${run.reason}${run.dueAt ? ` Next wake ${new Date(run.dueAt).toISOString()}.` : ''}`),
    ...(data.repositories.length ? [] : ['No repositories registered. Use daemon register.'])].join('\n') + '\n';
  if (command === 'inspect') return [`Run ${data.run.id}: ${data.run.status}`, data.run.reason, `Head ${data.run.headSha ?? 'unknown'}`, `Package ${data.run.packageDigest}`,
    `Attempts ${data.attempts.length}; reservations ${data.reservations.reduce((sum: number, entry: any) => sum + entry.units, 0)} cost units; operator retries ${data.run.retries}`,
    ...data.results.map((note: any) => `${note.result.job.actionId}: ${note.result.provider.outcome}. ${note.result.provider.diagnostic}`), 'Use --json for complete evidence, results, and receipts.'].join('\n') + '\n';
  if (command === 'register') return `Registered ${data.name} in analysis mode. Package ${data.packageDigest}.\n`;
  if (command === 'pause' || command === 'resume') return `${data.name}: ${data.paused ? 'paused' : 'active'}.\n`;
  return `Run ${data.id}: ${data.status}. ${data.reason}\n`;
}
