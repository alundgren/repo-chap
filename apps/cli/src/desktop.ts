import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseCompanionRequest, requestCompanion } from '@repo-chap/companion';
import type { CompanionCommand, CompanionState, InputMode } from '@repo-chap/companion';

const help = `Steer the running Repo Chap desktop app from your agent.

  repo-chap desktop open [--repo-root <directory>] [--workflow <repository-relative-path>]
  repo-chap desktop status [--json]
  repo-chap desktop select --workflow <repository-relative-path>
  repo-chap desktop show [--view overview|available|simulation] [--mode tests|pr] [--target <target>]
  repo-chap desktop input <--fixture <file> | --capture <directory>>
  repo-chap desktop simulate [--fixture <file> | --capture <directory>] [--packets <file>]
  repo-chap desktop highlight --target <target> [--text <explanation>] [--style highlight|arrow] [--seconds 15]
  repo-chap desktop clear

Every command accepts --json and --repo-root. The default root is your current
Git repository, or the current directory when outside Git. Except for open and
select, --workflow checks that the intended workflow is still selected.
Status lists the available targets. Navigation and highlights only affect the
view. Simulation replays local input without models, network or remote effects.
Real PR input is an inspection directory containing evidence.json and fixture.json.
Start the installed app first, or run vp run desktop from its checkout.
Set REPO_CHAP_DESKTOP_CONTROL in both processes to use a separate private socket.
`;
async function currentRoot(): Promise<string> {
  const current = await realpath(process.cwd());
  for (let path = current; ; path = dirname(path)) {
    if (await lstat(join(path, '.git')).catch(() => null)) return path;
    if (dirname(path) === path) return current;
  }
}
function describe(state: CompanionState): string {
  const lines = [state.repositoryRoot ?? 'No repository open.', state.workflowPath ?? 'No workflow selected.'];
  if (state.workflowPath) lines.push(`${state.view} · ${state.mode === 'tests' ? 'Test fixtures' : 'Captured real PRs'}`, state.diagnostics.length ? `${state.diagnostics.length} validation error(s).` : 'Workflow valid.');
  for (const entry of state.workflows) lines.push(`${entry.path === state.workflowPath ? '*' : ' '} ${entry.path}`);
  if (state.simulation) lines.push(`Simulation ${state.simulation.result.status}${state.simulationCurrent ? '' : ' · stale'}. ${state.simulation.result.reason}`,
    ...(state.simulation.comparison ? [`Expectations ${state.simulation.comparison.passed ? 'passed' : 'failed'}.`] : []));
  if (state.guidance) lines.push(`Showing ${state.guidance.target}${state.guidance.text ? `: ${state.guidance.text}` : ''}`);
  return lines.join('\n') + '\n';
}
export async function desktopCommand(args: string[]): Promise<void> {
  if (!args.length || args.includes('--help') || args.includes('-h')) { process.stdout.write(help); return; }
  const json = args.includes('--json');
  let exitCode = 64;
  try {
    const kind = args.shift()!;
    const supported: Record<string, string[]> = {
      open: [], status: [], select: [], show: ['--view', '--mode', '--target'], input: ['--fixture', '--capture'],
      simulate: ['--fixture', '--capture', '--packets'], highlight: ['--target', '--text', '--style', '--seconds'], clear: [],
    };
    if (!Object.hasOwn(supported, kind)) throw new Error('Unknown desktop command. See desktop --help.');
    const options: Record<string, string> = {}, seen = new Set<string>();
    while (args.length) {
      const key = args.shift()!;
      if (seen.has(key)) throw new Error(`Repeated option: ${key}`);
      seen.add(key);
      if (key === '--json') continue;
      if (!['--repo-root', '--workflow', ...supported[kind]!].includes(key)) throw new Error(`Unknown option: ${key}`);
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error(`${key} requires a value.`);
      options[key] = value;
    }
    const repositoryRoot = options['--repo-root'] ? resolve(options['--repo-root']) : await currentRoot();
    if (options['--fixture'] && options['--capture']) throw new Error('Choose either --fixture or --capture.');
    const mode: InputMode | undefined = options['--fixture'] ? 'tests' : options['--capture'] ? 'pr' : undefined;
    const inputPath = options['--fixture'] ?? options['--capture'];
    let command: CompanionCommand;
    if (kind === 'open') command = { kind, repositoryRoot, ...(options['--workflow'] ? { workflowPath: options['--workflow'] } : {}) };
    else if (kind === 'select') {
      if (!options['--workflow']) throw new Error('Select requires --workflow.');
      command = { kind, workflowPath: options['--workflow'] };
    } else if (kind === 'input') {
      if (!inputPath || !mode) throw new Error('Input requires --fixture or --capture.');
      command = { kind, mode, path: resolve(inputPath) };
    } else if (kind === 'simulate') command = { kind, ...(mode ? { mode, path: resolve(inputPath!) } : {}), ...(options['--packets'] ? { packetsPath: resolve(options['--packets']) } : {}) };
    else if (kind === 'show') command = { kind, ...(options['--view'] ? { view: options['--view'] as 'overview' | 'available' | 'simulation' } : {}), ...(options['--mode'] ? { mode: options['--mode'] as InputMode } : {}), ...(options['--target'] ? { target: options['--target'] } : {}) };
    else if (kind === 'highlight') {
      if (!options['--target']) throw new Error('Highlight requires --target.');
      command = { kind, target: options['--target'], ...(options['--text'] ? { text: options['--text'] } : {}), ...(options['--style'] ? { style: options['--style'] as 'highlight' | 'arrow' } : {}), ...(options['--seconds'] ? { seconds: Number(options['--seconds']) } : {}) };
    } else command = { kind: kind as 'status' | 'clear' };
    const request = parseCompanionRequest({ schemaVersion: 1, repositoryRoot, ...(!['open', 'select'].includes(kind) && options['--workflow'] ? { workflowPath: options['--workflow'] } : {}), command });
    exitCode = 8;
    const response = await requestCompanion(request);
    if (!response.ok) throw new Error(response.error);
    process.stdout.write(json ? JSON.stringify(response, null, 2) + '\n' : describe(response.state));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Desktop command failed.';
    if (json) process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, exitCode, error: message }) + '\n');
    else process.stderr.write(message + '\n');
    process.exitCode = exitCode;
  }
}
