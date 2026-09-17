import { resolve } from 'node:path';
import { loadWorkflow } from '@repo-chap/workflow';
import { requestControl, startDaemon, loadInstallation, diagnoseInstallation, type ControlRequest } from '@repo-chap/daemon';
import { backupState, restoreState } from '@repo-chap/runtime';
import { slackInboxCommand, slackInboxHelp } from './slack.js';

export const daemonHelp = `Daemon commands use a private local Unix socket. The daemon runs on Linux. Private apply policies can authorize bounded repair and push.

  repo-chap daemon start --state-dir <private-directory> --config <private-installation.json>
  repo-chap daemon diagnose --state-dir <directory> --config <private-installation.json> [--json]
  repo-chap daemon backup <new-backup-directory> --state-dir <directory> --config <private-installation.json> [--json]
  repo-chap daemon restore <backup-directory> --state-dir <new-directory> [--json]
  repo-chap daemon reconcile --state-dir <directory> [--json]
  repo-chap daemon resume-restored --state-dir <directory> [--keep-unknown] [--json]
  repo-chap daemon register <workflow.json> --repo <owner/name> --profile <name> --state-dir <directory> [--repo-root <directory>] [--reviewers <login,login>] [--json]
  repo-chap daemon register-source <repository-workflow-path> --repo <owner/name> --profile <name> --state-dir <directory> [--branch <name>] [--reviewers <login,login>] [--json]
  repo-chap daemon versions --repo <owner/name-or-id> --state-dir <directory> [--json]
  repo-chap daemon rollback <version-id> --repo <owner/name-or-id> --state-dir <directory> [--json]
  repo-chap daemon resume-auto --repo <owner/name-or-id> --state-dir <directory> [--json]
  repo-chap daemon migrate <run-id> --version <version-id> --state-dir <directory> [--json]
  repo-chap daemon status --state-dir <directory> [--json]
  repo-chap daemon inspect <run-id> --state-dir <directory> [--json]
  repo-chap daemon pause --repo <owner/name-or-id> --state-dir <directory> [--json]
  repo-chap daemon resume --repo <owner/name-or-id> --state-dir <directory> [--json]
  repo-chap daemon cancel <run-id> --state-dir <directory> [--json]
  repo-chap daemon retry <run-id> --state-dir <directory> [--json]

Backup requires a stopped service. Restore creates a new state directory with dispatch paused.
Reconcile reads uncertain GitHub outcomes. Slack receipts use slack-reconcile.
Resume-restored releases only the recovery pause after reconciliation. --keep-unknown retains uncertain outcomes without authorizing resends.
Diagnose checks the invoking account and makes provider login-status and GitHub reads, without model calls or repository/Slack writes.
Start stays in the foreground. Ctrl-C stops the daemon and active providers.
Pause stops new dispatch for a repository; active analysis can finish.
Cancel fences a run and stops its provider. Retry retains every attempt and budget charge.
Register-source watches the repository default branch unless --branch is supplied.
Rollback holds the selected version until resume-auto. It does not migrate existing runs.
Migrate records a checkpoint, stops active work and retains all receipts and charges.
Slack delivery also requires private installation settings and notify.send permission.
Analysis never writes remotely. Apply uses private policy; every mode leaves merge to a human. Exit 7 means a daemon command failed.
${slackInboxHelp}
`;
export async function daemonCommand(args: string[]): Promise<void> {
  const json = args.includes('--json');
  try {
    const command = args.shift();
    if (command === 'inbox' || command === 'slack-reconcile') { await slackInboxCommand(command, args); return; }
    if (!command || args.includes('--help') || command === '--help') { process.stdout.write(daemonHelp); return; }
    if (!['start', 'diagnose', 'backup', 'restore', 'reconcile', 'resume-restored', 'register', 'register-source', 'versions', 'rollback', 'resume-auto', 'migrate', 'status', 'inspect', 'pause', 'resume', 'cancel', 'retry'].includes(command)) throw new Error('Unknown daemon command. See repo-chap daemon --help.');
    const requiresValue = ['backup', 'restore', 'register', 'register-source', 'rollback', 'migrate', 'inspect', 'cancel', 'retry'].includes(command);
    const positional = requiresValue ? args.shift() : undefined;
    if (requiresValue && (!positional || positional.startsWith('-'))) throw new Error(`${command} requires ${command.startsWith('register') ? 'a workflow path' : command === 'rollback' ? 'a version ID' : ['backup', 'restore'].includes(command) ? 'a directory' : 'a run ID'}.`);
    const options: Record<string, string> = {}, seen = new Set<string>();
    const allowed = ['--state-dir', '--json', ...(['start', 'diagnose', 'backup'].includes(command) ? ['--config'] : []), ...(command === 'resume-restored' ? ['--keep-unknown'] : []), ...(['pause', 'resume', 'register', 'register-source', 'versions', 'rollback', 'resume-auto'].includes(command) ? ['--repo'] : []),
      ...(command.startsWith('register') ? ['--profile', '--reviewers'] : []), ...(command === 'register' ? ['--repo-root'] : []), ...(command === 'register-source' ? ['--branch'] : []), ...(command === 'migrate' ? ['--version'] : [])];
    while (args.length) {
      const option = args.shift()!;
      if (!allowed.includes(option) || seen.has(option)) throw new Error(`Unknown or repeated option: ${option}. See repo-chap daemon --help.`);
      seen.add(option); if (option === '--json' || option === '--keep-unknown') continue;
      const value = args.shift(); if (!value || value.startsWith('-')) throw new Error(`${option} requires a value.`); options[option] = value;
    }
    if (!options['--state-dir']) throw new Error('Daemon commands require --state-dir <private-directory>.');
    const directory = resolve(options['--state-dir']);
    if (['backup', 'diagnose'].includes(command) && !options['--config']) throw new Error(`${command} requires --config <private-installation.json>.`);
    if (command === 'diagnose') {
      const result = await diagnoseInstallation(directory, resolve(options['--config']!));
      if (!result.ok) process.exitCode = 7;
      process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : [`Diagnostics for ${result.account.username}, UID ${result.account.uid}.`, ...result.checks.map(check => `${check.ok ? 'PASS' : 'FAIL'} ${check.check}: ${check.message}`)].join('\n') + '\n'); return;
    }
    if (command === 'backup' || command === 'restore') {
      const manifest = command === 'backup' ? await backupState(directory, resolve(positional!), (await loadInstallation(resolve(options['--config']!), directory)).limits) : await restoreState(resolve(positional!), directory);
      const result = { directory: command === 'backup' ? resolve(positional!) : directory, files: manifest.files.length, runtimeSchema: manifest.runtimeSchema, limits: manifest.limits, paused: command === 'restore' };
      process.stdout.write(json ? `${JSON.stringify({ schemaVersion: 1, ok: true, result }, null, 2)}\n` : command === 'backup'
        ? `Backup saved to ${result.directory}. ${result.files} durable files verified. Private configuration and credentials require separate recovery.\n`
        : `Restored to ${result.directory}. Dispatch is paused. Start with private configuration, run daemon reconcile, inspect status and inbox, then use daemon resume-restored.\n`); return;
    }
    if (command === 'start') {
      if (!options['--config']) throw new Error('Start requires --config <private-installation.json>.');
      const daemon = await startDaemon(directory, resolve(options['--config']));
      const mode = (daemon.service.status() as { mode: string }).mode;
      process.stdout.write(json ? `${JSON.stringify({ schemaVersion: 1, status: 'started', mode })}\n` : `Daemon started in ${mode} mode. Use daemon status with the same state directory.\n`);
      await new Promise<void>(done => {
        const stop = () => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); void daemon.stop().then(done, done); };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
      }); return;
    }
    let request: ControlRequest;
    if (command === 'register' || command === 'register-source') {
      if (!options['--repo'] || !options['--profile']) throw new Error('Register requires --repo and --profile.');
      const common = { name: options['--repo'], profile: options['--profile'], reviewers: options['--reviewers']?.split(',').map(value => value.trim()) ?? [] };
      request = command === 'register' ? { method: command, ...common, package: await loadWorkflow(positional!, { repositoryRoot: options['--repo-root'] }) } :
        { method: command, ...common, workflowPath: positional!, branch: options['--branch'] ?? null };
    } else if (command === 'migrate') {
      if (!options['--version']) throw new Error('Migrate requires --version <retained-version-id>. Use daemon versions.');
      request = { method: command, runId: positional!, versionId: options['--version'] };
    } else if (command === 'pause' || command === 'resume' || command === 'versions' || command === 'resume-auto' || command === 'rollback') {
      if (!options['--repo']) throw new Error(`${command} requires --repo <registered-name-or-id>.`);
      request = command === 'rollback' ? { method: command, repository: options['--repo'], versionId: positional! } : { method: command, repository: options['--repo'] };
    } else if (command === 'status' || command === 'reconcile') request = { method: command };
    else if (command === 'resume-restored') request = { method: command, keepUnknown: seen.has('--keep-unknown') };
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
export function humanResult(command: string, value: unknown): string {
  const data = value as Record<string, any>;
  if (command === 'reconcile' || command === 'resume-restored') return recoveryLines(data).join('\n') + '\n';
  if (command === 'status') return [`Daemon ${data.mode} mode`, ...recoveryLines(data.recovery), `Slack delivery ${data.slackEnabled ? 'enabled' : 'disabled'}. Use daemon inbox for complete handoffs.`, ...(data.githubRetryAt ? [`GitHub retry after ${new Date(data.githubRetryAt).toISOString()}`] : []),
    ...(data.slackFailure ? [`${data.slackFailure.reason} Next retry ${new Date(data.slackFailure.retryAt).toISOString()}.`] : []),
    ...(data.slackDeliveries ?? []).filter((item: any) => item.state !== 'confirmed').map((item: any) => `Slack ${item.id}: ${item.state}. ${item.reason}`),
    ...data.repositories.flatMap((repo: any) => repositoryLines(repo)),
    ...data.runs.map((run: any) => `${run.id} PR #${run.number}: ${run.status}. ${run.reason}${run.dueAt ? ` Next wake ${new Date(run.dueAt).toISOString()}.` : ''}`),
    ...(data.repositories.length ? [] : ['No repositories registered. Use daemon register.'])].join('\n') + '\n';
  if (command === 'inspect') return [`Run ${data.run.id}: ${data.run.status}`, data.run.reason, `Head ${data.run.headSha ?? 'unknown'}`, `Package ${data.run.packageDigest}`, `Run workflow version ${data.version.id}; source ${data.version.sourceRevision ?? 'explicit local package'}`,
    ...(data.run.dueAt ? [`Next wake ${new Date(data.run.dueAt).toISOString()}`] : []),
    `Migration checkpoints ${data.migrations.length}`,
    `Attempts ${data.attempts.length}; reservations ${data.reservations.reduce((sum: number, entry: any) => sum + entry.units, 0)} cost units; operator retries ${data.run.retries}`,
    ...data.results.map((note: any) => { const result = note.result.repair ?? note.result.provider ?? note.result; return `${note.result.job.actionId}: ${result.status ?? result.outcome}. ${result.diagnostic}`; }),
    ...(data.run.repair ? [`Candidate ${data.run.repair.candidateSha ?? 'none'}; required checks ${data.run.repair.checksCurrent ? 'validated' : 'not validated'}`] : []),
    ...(data.threadResolution ? [`Push ${data.threadResolution.pushConfirmed ? 'confirmed' : 'unconfirmed'}: ${data.threadResolution.candidateSha}; ${data.threadResolution.remainingConcerns.length} concerns need attention.`,
      ...data.threadResolution.concerns.map((concern: any) => `Thread ${concern.threadId}: ${concern.state}, ${concern.disposition}. ${concern.reason}`)] : []),
    ...data.effects.flatMap((effect: any) => [
      `Effect ${effect.id}: ${effect.state}${effect.receipt?.freshness ? `, ${data.publications?.find((value: any) => value.effectId === effect.id)?.freshness ?? effect.receipt.freshness}` : ''}. ${effect.kind} to ${effect.destination}; expected ${effect.expectedRevision}. ${effect.receipt?.reason ?? 'Planned effect retained locally.'}`,
      ...(effect.receipt?.analysis ? [`Review evidence ${effect.receipt.analysis.coverage}; verdict ${effect.receipt.analysis.verdict}.`, ...effect.receipt.analysis.missingEvidence.map((value: string) => `Missing evidence: ${value}`)] : []),
      ...(effect.receipt?.remote?.url ? [`Published review ${effect.receipt.remote.url}`] : []),
    ]), 'Use --json for complete evidence, results, and receipts.'].join('\n') + '\n';
  if (command === 'register') return `Registered ${data.name}. Private installation policy controls apply permissions. Package ${data.packageDigest}.\n`;
  if (command === 'versions') return [...repositoryLines(data.repository), ...data.versions.map((version: any) =>
    `${version.id}${version.id === data.repository.activeVersionId ? ' ACTIVE' : ''}: source ${version.sourceRevision ?? 'explicit local package'}; package ${version.packageDigest}`),
    ...(data.versions.length ? ['Use rollback <version-id> to select and hold a version; resume-auto permits source activation again.'] : ['No valid package yet. Correct the source files and commit a new source revision.'])].join('\n') + '\n';
  if (command === 'register-source' || command === 'rollback' || command === 'resume-auto') return repositoryLines(data).join('\n') + '\n';
  if (command === 'migrate') return [`Run ${data.run.id}: ${data.run.status}. ${data.run.reason}`, `Checkpoint ${data.checkpoint.id}`, `Run workflow version ${data.version.id}; source ${data.version.sourceRevision ?? 'explicit local package'}`, `Package ${data.run.packageDigest}`].join('\n') + '\n';
  if (command === 'pause' || command === 'resume') return `${data.name}: ${data.paused ? 'paused' : 'active'}.\n`;
  return `Run ${data.id}: ${data.status}. ${data.reason}\n`;
}
function repositoryLines(repo: any): string[] {
  return [`${repo.name}: ${repo.paused ? 'paused' : !repo.package ? 'blocked, no valid workflow' : 'active'}${repo.diagnostic ? `. ${repo.diagnostic}` : ''}`,
    `Active workflow version ${repo.activeVersionId ?? 'none'}; package ${repo.packageDigest ?? 'none'}`,
    ...(repo.source ? [`Source ${repo.source.resolvedBranch ?? repo.source.branch ?? 'repository default branch'} at ${repo.source.observedRevision ?? 'unknown'}: ${repo.source.status}; automatic activation ${repo.source.held ? 'held, use resume-auto to release' : 'enabled'}`,
      ...repo.source.diagnostics.map((item: any) => `${item.path}: ${item.message}`)] : [])];
}

function recoveryLines(data: any): string[] {
  if (!data) return [];
  return [`Restore dispatch ${data.paused ? 'paused; run daemon reconcile, inspect the outcomes, then resume-restored' : 'enabled'}.`,
    `Unresolved effects ${data.unknownEffects}; retained historical unknown attempts ${data.historicalUnknownAttempts}. Historical attempts do not grant resend permission.`,
    ...(data.paused && data.unknownEffects ? ['Use daemon inspect and daemon inbox. Slack outcomes require an explicit receipt or separately authorized resend. --keep-unknown releases unrelated work only.'] : [])];
}
