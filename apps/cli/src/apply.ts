import { resolve } from 'node:path';
import { loadWorkflow, WorkflowError } from '@repo-chap/workflow';
import { localCredentials, localPushCredentials, validateTarget, GitHubReadError } from '@repo-chap/github';
import { readProfile, ProviderConfigurationError } from '@repo-chap/providers';
import { readApplyPolicy, requireApplyPolicy, RuntimeError } from '@repo-chap/runtime';
import { runLocalApply, inspectLocalApply } from '@repo-chap/daemon';
import { humanResult } from './daemon.js';

export const applyHelp = `Local apply uses GH_TOKEN, GITHUB_TOKEN, or your gh login. It runs immediately due work for one PR and retains every attempt and effect in private state.

  repo-chap apply <workflow.json> --repo <owner/name> --pr <number> --state-dir <private-directory> --provider-config <private-settings.json> --profile <name> --policy <private-apply-policy.json> [--plan] [--retry] [--repo-root <directory>] [--reviewers <login,login>] [--json]
  repo-chap apply inspect <run-id> --state-dir <private-directory> [--json]
  repo-chap apply reconcile <run-id> --state-dir <private-directory> [--json]

The private policy authorizes bounded repair and push. Planned pushes print before dispatch.
--plan performs live GitHub reads, provider repair and local checks, then saves the push plan without remote writes.
Run the same command without --plan to continue. --retry explicitly retries a retained failed action within its original limits.
Inspect is offline. Reconcile only reads unknown remote outcomes; it never starts a model or pushes.
Reuse the same state directory across invocations to preserve lifetime limits and recovery. Keep it separate from daemon state.
Waiting work exits with its next wake time; rerun after that time. Ctrl-C stops active work. Humans merge.
Exit 8 means local apply failed, was blocked, or needs unknown-outcome inspection; 130 means cancelled work.
`;
export async function applyCommand(args: string[]): Promise<void> {
  const json = args.includes('--json'), controller = new AbortController(), cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const command = args.shift();
    if (!command || command === '--help' || args.includes('--help')) { process.stdout.write(applyHelp); return; }
    const inspect = command === 'inspect' || command === 'reconcile', runId = inspect ? args.shift() : undefined;
    if (inspect && (!runId || runId.startsWith('-'))) throw new RuntimeError(`${command} requires a retained run ID.`);
    const options: Record<string, string> = {}, seen = new Set<string>();
    const flags = ['--json', ...(!inspect ? ['--plan', '--retry'] : [])];
    const allowed = ['--state-dir', ...(!inspect ? ['--repo', '--pr', '--provider-config', '--profile', '--policy', '--repo-root', '--reviewers'] : []), ...flags];
    while (args.length) {
      const option = args.shift()!;
      if (!allowed.includes(option) || seen.has(option)) throw new RuntimeError(`Unknown or repeated option: ${option}. See repo-chap apply --help.`);
      seen.add(option); if (flags.includes(option)) continue;
      const value = args.shift(); if (!value || value.startsWith('-')) throw new RuntimeError(`${option} requires a value.`); options[option] = value;
    }
    if (!options['--state-dir']) throw new RuntimeError('Apply requires --state-dir <private-directory>.');
    const directory = resolve(options['--state-dir']);
    let details: unknown;
    if (inspect) {
      details = await inspectLocalApply(directory, runId!, command === 'reconcile' ? {
        credentials: await localCredentials(), profile: async () => { throw new RuntimeError('Reconciliation never starts a provider.'); },
      } : undefined, controller.signal);
    } else {
      if (['--repo', '--pr', '--provider-config', '--profile', '--policy'].some(key => !options[key])) throw new RuntimeError('Apply requires --repo, --pr, --provider-config, --profile and --policy. See repo-chap apply --help.');
      if (!/^\d+$/.test(options['--pr']!)) throw new RuntimeError('--pr requires a positive integer.');
      const repository = options['--repo']!, number = Number(options['--pr']); validateTarget(repository, number);
      const config = resolve(options['--provider-config']!), policyPath = resolve(options['--policy']!);
      requireApplyPolicy(await readApplyPolicy(policyPath), repository, ['workspace.write', 'checks.run', ...(seen.has('--plan') ? [] : ['pr.push'] as const)]);
      const profile = await readProfile(config, options['--profile']!), pkg = await loadWorkflow(command, { repositoryRoot: options['--repo-root'], maximumCapabilities: profile.maximumCapabilities });
      const displayed = new Set<string>();
      details = await runLocalApply({ directory, repository, number, package: pkg, profile: profile.name, planOnly: seen.has('--plan'), retry: seen.has('--retry'),
        reviewers: options['--reviewers']?.split(',').map(value => value.trim()), signal: controller.signal }, {
        credentials: await localCredentials(), profile: name => readProfile(config, name), applyPolicy: () => readApplyPolicy(policyPath), pushCredentials: name => localPushCredentials(name),
        onPlannedEffect: effect => { if (!json && !displayed.has(effect.id)) { displayed.add(effect.id); process.stdout.write(`Planned ${effect.kind} to ${effect.destination}; expected ${effect.expectedRevision}. Effect ${effect.id}\n`); } },
      });
    }
    process.stdout.write(json ? `${JSON.stringify({ schemaVersion: 1, mode: 'apply', ...details as object }, null, 2)}\n` : humanResult('inspect', details));
    const result = details as { run: { status: string; repair?: { pushEffectId: string | null } }; effects: { id: string; state: string }[] };
    if (!inspect && (result.run.status === 'blocked' || result.effects.some(effect => ['sending', 'unknown'].includes(effect.state) || effect.state === 'rejected' && effect.id === result.run.repair?.pushEffectId))) process.exitCode = 8;
    if (controller.signal.aborted) process.exitCode = 130;
  } catch (error) {
    process.exitCode = controller.signal.aborted ? 130 : 8;
    const message = error instanceof RuntimeError || error instanceof WorkflowError || error instanceof ProviderConfigurationError ? error.message : error instanceof GitHubReadError ? error.failure.message : 'Local apply failed. Check private inputs, local GitHub access and retained state.';
    if (json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: false, error: message })}\n`); else process.stderr.write(`${message}\n`);
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
