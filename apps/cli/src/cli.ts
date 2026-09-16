#!/usr/bin/env node
import { loadWorkflow, parseFixture, parseJson, readFixtureText, replay, WorkflowError, type ReplayResult, type ConditionTrace } from '@repo-chap/workflow';
import { CaptureError, GitHubReadError, validateTarget } from '@repo-chap/github';
import { inspectCommand } from './inspect.js';
import { analyzeCommand } from './analyze.js';
import { workspaceCommand } from './workspace.js';
import { daemonCommand } from './daemon.js';
import { applyCommand } from './apply.js';
import { slackPreviewCommand } from './slack.js';
import { ExecutionError } from '@repo-chap/execution';
import { readProfile, ProviderConfigurationError } from '@repo-chap/providers';

const help = `repo-chap validates, replays, and inspects repository workflows.

Usage:
  repo-chap validate <workflow.json> [--repo-root <directory>] [--json]
  repo-chap replay <workflow.json> --fixture <fixture.json> [--repo-root <directory>] [--json]
  repo-chap inspect <workflow.json> --repo <owner/name> --pr <number> --capture-dir <private-directory> [--reviewers <login,login>] [--repo-root <directory>] [--json]
  repo-chap analyze <workflow.json> --capture <inspection-directory> --source-repo <local-git-repository> --output-dir <private-directory> --provider-config <private-settings.json> --profile <name> [--resume <decision.json>] [--repo-root <directory>] [--json]
  repo-chap workspace <workflow.json> --capture <inspection-directory> --source-repo <local-git-repository> --output-dir <private-directory> --provider-config <private-settings.json> --profile <name> --execution-policy <policy.json> --action <repair-action-id> [--repo-root <directory>] [--json]
  repo-chap daemon <start|register|status|inspect|pause|resume|cancel|retry> --state-dir <private-directory> [options]
  repo-chap apply <workflow.json|inspect|reconcile> [options] (see apply --help)
  repo-chap slack-preview <workflow.json> --packet <packet.json> [--repo-root <directory>] [--json | --html]

Replay uses supplied observations, results, control state, and time.
It never runs providers, commands, or remote effects. Humans merge.
Inspect reads GitHub using GH_TOKEN, GITHUB_TOKEN, or your local gh login.
It saves a private fixture and evidence outside Git, with no models or repository writes.
Optional reviewer logins use PR eyes reactions as bounded waiting hints.
Analyze explicitly starts a local provider to classify and review captured revisions.
It saves a private decision and never publishes, pushes, sends messages, or merges.

Workspace edits a disposable local checkout, finalizes a candidate, and runs required checks.
It retains private artifacts and removes the checkout. It performs no remote effects.
Apply uses local GitHub auth and private policy for bounded repair and push, with durable plans and recovery.

Exit codes: 0 valid or replay completed, 2 invalid workflow/package,
3 invalid fixture, 4 incomplete inspection/access/capture failure, 5 analysis failure, 6 repair blocked/failed,
64 invalid command, 70 unexpected internal failure, 130 cancelled work.
A simulated wait, block, or missing stub is a successful replay with exit 0.
`;
function conditionReason(trace: ConditionTrace): string {
  return trace.children?.length ? trace.children.map(conditionReason).join(' ') : trace.reason;
}
function humanReplay(result: ReplayResult): string {
  const lines = [`Replay ${result.status}`, `Package ${result.packageDigest}`, `Clock ${result.now}`];
  for (const decision of result.decisions) {
    for (const rule of decision.rules) lines.push(`Rule ${rule.id}: ${rule.condition.value}${rule.selected ? ' (selected)' : ' (rejected)'}. ${conditionReason(rule.condition)}`);
    lines.push(`Action ${decision.actionId}${decision.ruleId === null ? ' (fallback)' : ''}`);
  }
  for (const action of result.actions) lines.push(`${action.actionId}: ${action.status}. ${action.reason}`);
  for (const effect of result.proposedEffects) lines.push(`Proposed ${effect.uses}${effect.outcome ? `: ${effect.outcome} to ${effect.destination}` : ''}`);
  lines.push(result.reason);
  if (result.nextWakeAt) lines.push(`Next wake ${result.nextWakeAt}`);
  return `${lines.join('\n')}\n`;
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === 'daemon') { await daemonCommand(args.slice(1)); return; }
  if (args[0] === 'apply') { await applyCommand(args.slice(1)); return; }
  if (args[0] === 'slack-preview') { await slackPreviewCommand(args.slice(1)); return; }
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) { process.stdout.write(help); return; }
  const json = args.includes('--json');
  let phase = 64;
  try {
    const command = args.shift();
    const file = args.shift();
    if (!['validate', 'replay', 'inspect', 'analyze', 'workspace'].includes(command ?? '') || !file || file.startsWith('-')) throw new Error('Use validate, replay, inspect, analyze, or workspace followed by a workflow path. See --help.');
    let repositoryRoot: string | undefined, fixture: string | undefined;
    const inspectOptions: Record<string, string> = {};
    const seen = new Set<string>();
    while (args.length) {
      const option = args.shift()!;
      if (seen.has(option)) throw new Error(`Repeated option: ${option}`);
      seen.add(option);
      if (option === '--json') continue;
      if (option !== '--repo-root' && option !== '--fixture' && !(command === 'inspect' && ['--repo', '--pr', '--capture-dir', '--reviewers'].includes(option)) && !(command === 'analyze' && ['--capture', '--source-repo', '--output-dir', '--provider-config', '--profile', '--resume'].includes(option)) && !(command === 'workspace' && ['--capture', '--source-repo', '--output-dir', '--provider-config', '--profile', '--execution-policy', '--action'].includes(option))) throw new Error(`Unknown option: ${option}. See --help.`);
      const value = args.shift();
      if (!value || value.startsWith('-')) throw new Error(`${option} requires a value.`);
      if (option === '--repo-root') repositoryRoot = value; else if (option === '--fixture') fixture = value; else inspectOptions[option] = value;
    }
    if (command === 'replay' && !fixture) throw new Error('Replay requires --fixture <fixture.json>.');
    if (command !== 'replay' && fixture) throw new Error('--fixture is only used with replay.');
    if (command === 'analyze' && ['--capture', '--source-repo', '--output-dir', '--provider-config', '--profile'].some(key => !inspectOptions[key])) throw new Error('Analyze requires --capture, --source-repo, --output-dir, --provider-config, and --profile. See --help.');
    if (command === 'workspace' && ['--capture', '--source-repo', '--output-dir', '--provider-config', '--profile', '--execution-policy', '--action'].some(key => !inspectOptions[key])) throw new Error('Workspace requires --capture, --source-repo, --output-dir, --provider-config, --profile, --execution-policy, and --action. See --help.');
    if (command === 'inspect') {
      if (!inspectOptions['--repo'] || !inspectOptions['--pr'] || !inspectOptions['--capture-dir']) throw new Error('Inspect requires --repo, --pr, and --capture-dir. See --help.');
      if (!/^\d+$/.test(inspectOptions['--pr'])) throw new Error('--pr requires a positive integer.');
      validateTarget(inspectOptions['--repo'], Number(inspectOptions['--pr']));
      if (inspectOptions['--reviewers']?.split(',').some(s => !/^[a-z0-9][a-z0-9-]*(\[bot\])?$/i.test(s.trim()))) throw new Error('--reviewers requires comma-separated GitHub logins.');
    }
    phase = 2;
    const profile = ['analyze', 'workspace'].includes(command!) ? await readProfile(inspectOptions['--provider-config']!, inspectOptions['--profile']!) : undefined;
    const pkg = await loadWorkflow(file, { repositoryRoot, ...(profile ? { maximumCapabilities: profile.maximumCapabilities } : {}) });
    if (command === 'validate') {
      const result = { schemaVersion: 1, valid: true, workflowId: pkg.workflow.id, packageDigest: pkg.digest, files: pkg.files.map(f => ({ path: f.path, digest: f.digest })) };
      process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `Valid ${pkg.workflow.id}\nPackage ${pkg.digest}\nPinned ${pkg.files.length} files.\n`);
    } else if (command === 'inspect') {
      phase = 4;
      await inspectCommand(pkg, { repository: inspectOptions['--repo']!, pr: Number(inspectOptions['--pr']), directory: inspectOptions['--capture-dir']!, reviewers: inspectOptions['--reviewers']?.split(',') ?? [], json });
    } else if (command === 'workspace') {
      phase = 6;
      await workspaceCommand(pkg, profile!, { capture: inspectOptions['--capture']!, sourceRepository: inspectOptions['--source-repo']!, directory: inspectOptions['--output-dir']!, policy: inspectOptions['--execution-policy']!, action: inspectOptions['--action']!, json });
    } else if (command === 'analyze') {
      phase = 5;
      await analyzeCommand(pkg, profile!, { capture: inspectOptions['--capture']!, sourceRepository: inspectOptions['--source-repo']!, directory: inspectOptions['--output-dir']!, resume: inspectOptions['--resume'], json });
    } else {
      phase = 3;
      const result = replay(pkg, parseFixture(parseJson(await readFixtureText(fixture!), fixture!)));
      process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : humanReplay(result));
    }
  } catch (error) {
    const diagnostics = error instanceof WorkflowError ? error.diagnostics : [{ code: error instanceof GitHubReadError ? error.failure.code : error instanceof ExecutionError ? 'execution' : error instanceof CaptureError ? 'capture' : phase === 64 ? 'usage' : 'internal', path: '', message: error instanceof Error ? error.message : String(error) }];
    const exitCode = error instanceof ExecutionError ? 6 : error instanceof ProviderConfigurationError ? 5 : error instanceof WorkflowError || error instanceof GitHubReadError || error instanceof CaptureError || phase === 64 ? phase : 70;
    const result = { schemaVersion: 1, valid: false, exitCode, diagnostics };
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stderr.write(`${diagnostics.map(d => `${d.code}${d.path ? ` ${d.path}` : ''}: ${d.message}`).join('\n')}\n`);
    process.exitCode = exitCode;
  }
}
await main();
