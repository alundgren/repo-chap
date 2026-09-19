import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalJson, compareReplay, digest, loadWorkflow, parseFixture, parseJson, readFixtureText, replay, WorkflowError } from '@repo-chap/workflow';
import type { WorkflowPackage } from '@repo-chap/workflow';
import { readCapturedInspection } from '@repo-chap/github';
import { previewReplayHandoffs, validatePacket } from '@repo-chap/slack';
import { parseCompanionRequest } from '@repo-chap/companion';
import type { CompanionRequest, CompanionResponse, CompanionState, InputMode, SimulationInput, SimulationRecord } from '@repo-chap/companion';
import { discoverWorkflows, repositoryPath } from './discovery.ts';

const message = (error: unknown): string => error instanceof Error ? error.message : 'Cannot read the selected files.';
interface Scenario {
  input: SimulationInput | null;
  packetsPath: string | null;
  packetsText: string | null;
  packetsError: string | null;
  simulation: SimulationRecord | null;
}
const emptyScenario = (): Scenario => ({ input: null, packetsPath: null, packetsText: null, packetsError: null, simulation: null });
const emptyState = (): CompanionState => ({
  schemaVersion: 1, revision: 0, repositoryRoot: null, workflows: [], discoveryWarning: null,
  workflowPath: null, workflow: null, packageDigest: null, files: [], changedPaths: [], diagnostics: [],
  view: 'overview', mode: 'tests', input: null, packetsPath: null, packetsError: null,
  simulation: null, simulationCurrent: false, guidance: null, targets: [],
});

/** Reads repository files and replays captured input. It never writes workflow source or starts a provider. */
export class CompanionSession {
  private state = emptyState();
  private pkg: WorkflowPackage | null = null;
  private scenarios: Record<InputMode, Scenario> = { tests: emptyScenario(), pr: emptyScenario() };
  private operations = Promise.resolve();
  private readonly changed: (state: CompanionState) => void;

  constructor(changed: (state: CompanionState) => void = () => {}) { this.changed = changed; }

  snapshot(): CompanionState {
    const scenario = this.scenarios[this.state.mode];
    const current = !!scenario.simulation && !!this.pkg && !!scenario.input?.digest && !scenario.input.error && !scenario.packetsError &&
      scenario.simulation.packageDigest === this.pkg.digest && scenario.simulation.inputDigest === scenario.input.digest &&
      scenario.simulation.packetsDigest === (scenario.packetsText === null ? null : digest(scenario.packetsText));
    return structuredClone({ ...this.state, input: scenario.input, packetsPath: scenario.packetsPath, packetsError: scenario.packetsError,
      simulation: scenario.simulation, simulationCurrent: current,
      guidance: this.state.guidance && this.state.guidance.expiresAt > Date.now() ? this.state.guidance : null });
  }

  private queue(operation: () => Promise<void>): Promise<CompanionResponse> {
    const response = this.operations.then(async (): Promise<CompanionResponse> => {
      const before = JSON.stringify(this.snapshot());
      let error: unknown;
      try { await operation(); } catch (caught) { error = caught; }
      if (JSON.stringify(this.snapshot()) !== before) { this.state.revision++; this.changed(this.snapshot()); }
      return error ? { schemaVersion: 1, ok: false, error: message(error) } : { schemaVersion: 1, ok: true, state: this.snapshot() };
    });
    this.operations = response.then(() => {}, () => {});
    return response;
  }

  refresh(): Promise<CompanionResponse> { return this.queue(() => this.readFiles()); }

  execute(value: unknown): Promise<CompanionResponse> {
    return this.queue(async () => {
      const request = parseCompanionRequest(value);
      await this.checkRepository(request);
      const command = request.command;
      if (command.kind === 'open') {
        const root = await realpath(resolve(command.repositoryRoot));
        if (!(await stat(root)).isDirectory()) throw new Error('Choose a repository directory.');
        const workflowPath = command.workflowPath ? repositoryPath(root, command.workflowPath) : null;
        if (workflowPath) { repositoryPath(root, await realpath(resolve(root, workflowPath))); }
        const discovered = await discoverWorkflows(root, workflowPath ? [workflowPath] : []);
        this.state = { ...emptyState(), revision: this.state.revision, repositoryRoot: root, workflows: discovered.workflows,
          discoveryWarning: discovered.warning, workflowPath: workflowPath ?? discovered.workflows.find(entry => entry.path === '.repo-chap/workflow.json')?.path ?? discovered.workflows[0]?.path ?? null };
        this.pkg = null; this.scenarios = { tests: emptyScenario(), pr: emptyScenario() };
        await this.readFiles();
        return;
      }
      await this.readFiles();
      if (command.kind === 'status') return;
      if (!this.state.repositoryRoot) throw new Error('Open a repository first with repo-chap desktop open.');
      if (command.kind === 'select') {
        const path = repositoryPath(this.state.repositoryRoot, command.workflowPath);
        repositoryPath(this.state.repositoryRoot, await realpath(resolve(this.state.repositoryRoot, path)));
        if (path === this.state.workflowPath) return;
        this.state.workflowPath = path; this.state.changedPaths = []; this.state.guidance = null;
        this.state.files = []; this.pkg = null; this.scenarios = { tests: emptyScenario(), pr: emptyScenario() };
        await this.readFiles();
      } else if (command.kind === 'show') {
        this.state.guidance = null;
        if (command.mode) { this.state.mode = command.mode; this.updateTargets(); }
        if (command.target) this.navigate(command.target);
        else if (command.view) this.state.view = command.view;
        else if (command.mode) this.state.view = 'simulation';
      } else if (command.kind === 'input') {
        this.state.mode = command.mode; this.state.view = 'simulation'; this.state.guidance = null;
        this.scenarios[command.mode].input = { path: resolve(command.path), digest: null, fixture: null, error: null };
        await this.readScenario(command.mode);
        if (this.scenarios[command.mode].input!.error) throw new Error(this.scenarios[command.mode].input!.error!);
      } else if (command.kind === 'packets') {
        this.scenarios[this.state.mode].packetsPath = resolve(command.path);
        await this.readScenario(this.state.mode);
        if (this.scenarios[this.state.mode].packetsError) throw new Error(this.scenarios[this.state.mode].packetsError!);
      } else if (command.kind === 'simulate') {
        if (command.mode) this.state.mode = command.mode;
        const scenario = this.scenarios[this.state.mode];
        if (command.path) scenario.input = { path: resolve(command.path), digest: null, fixture: null, error: null };
        if (command.packetsPath) scenario.packetsPath = resolve(command.packetsPath);
        this.state.view = 'simulation'; this.state.guidance = null;
        await this.readScenario(this.state.mode);
        if (!this.pkg) throw new Error('Fix workflow validation errors before simulating.');
        if (!scenario.input?.fixture || scenario.input.error) throw new Error(scenario.input?.error ?? 'Choose a test fixture or captured PR first.');
        if (scenario.packetsError) throw new Error(scenario.packetsError);
        const result = replay(this.pkg, scenario.input.fixture);
        const simulation: SimulationRecord = { packageDigest: this.pkg.digest, inputDigest: scenario.input.digest!,
          packetsDigest: scenario.packetsText === null ? null : digest(scenario.packetsText), result,
          comparison: scenario.input.fixture.expected ? compareReplay(result, scenario.input.fixture.expected) : null,
          handoffs: [], previewError: null };
        try {
          const packets = scenario.packetsText === null ? [] : parseJson(scenario.packetsText, scenario.packetsPath!);
          simulation.handoffs = previewReplayHandoffs(result, (Array.isArray(packets) ? packets : [packets]).map(validatePacket), this.pkg.workflow.slack);
        } catch (error) { simulation.previewError = message(error); }
        scenario.simulation = simulation;
      } else if (command.kind === 'highlight') {
        this.navigate(command.target);
        this.state.guidance = { id: randomUUID(), target: command.target, text: command.text ?? '', style: command.style ?? 'highlight', expiresAt: Date.now() + (command.seconds ?? 15) * 1000 };
      } else this.state.guidance = null;
      this.updateTargets();
    });
  }

  private async checkRepository(request: CompanionRequest): Promise<void> {
    if (request.command.kind === 'open') return;
    if (request.repositoryRoot && await realpath(resolve(request.repositoryRoot)) !== this.state.repositoryRoot) throw new Error('The desktop is showing another repository. Use desktop open for the intended repository.');
    if (request.workflowPath && (!this.state.repositoryRoot || repositoryPath(this.state.repositoryRoot, request.workflowPath) !== this.state.workflowPath)) throw new Error('The desktop is showing another workflow. Select the intended workflow first.');
  }

  private navigate(target: string): void {
    if (!this.state.targets.includes(target)) throw new Error('Unknown desktop target. Read desktop status --json for the available targets.');
    this.state.view = ['simulation', 'inputs', 'result'].includes(target) ? 'simulation' : 'overview';
    // A short focus instruction also works for navigation without an annotation.
    this.state.guidance = { id: randomUUID(), target, text: '', style: 'highlight', expiresAt: Date.now() + 3000 };
  }

  private updateTargets(): void {
    this.state.targets = !this.state.workflowPath ? [] : ['workflow', 'simulation', 'inputs',
      ...(this.state.workflow ? ['rules', 'files'] : []),
      ...(this.scenarios[this.state.mode].simulation ? ['result'] : []),
      ...this.state.workflow?.rules.map(rule => `rule:${rule.id}`) ?? [],
      ...Object.keys(this.state.workflow?.actions ?? {}).map(id => `action:${id}`)];
    if (this.state.guidance && (!this.state.targets.includes(this.state.guidance.target) || this.state.guidance.expiresAt <= Date.now())) this.state.guidance = null;
  }

  private async readFiles(): Promise<void> {
    if (!this.state.repositoryRoot) return;
    const root = this.state.repositoryRoot;
    try {
      const discovered = await discoverWorkflows(root, [...this.state.workflows.map(entry => entry.path), ...this.state.workflowPath ? [this.state.workflowPath] : []]);
      this.state.workflows = discovered.workflows; this.state.discoveryWarning = discovered.warning;
      if (!this.state.workflowPath) this.state.workflowPath = discovered.workflows[0]?.path ?? null;
      if (this.state.workflowPath && !this.state.workflows.some(entry => entry.path === this.state.workflowPath)) this.state.workflows.push({ path: this.state.workflowPath, id: null });
      if (this.state.workflowPath) {
        const next = await loadWorkflow(resolve(root, this.state.workflowPath), { repositoryRoot: root });
        const changed = [...new Set([...this.state.files.map(file => file.path), ...next.files.map(file => file.path)])]
          .filter(path => this.state.files.find(file => file.path === path)?.digest !== next.files.find(file => file.path === path)?.digest);
        if (this.state.files.length && changed.length) this.state.changedPaths = changed;
        this.pkg = next; this.state.workflow = next.workflow; this.state.packageDigest = next.digest;
        this.state.files = next.files.map(({ path, digest }) => ({ path, digest })); this.state.diagnostics = [];
      }
    } catch (error) {
      this.pkg = null; this.state.workflow = null; this.state.packageDigest = null;
      this.state.diagnostics = error instanceof WorkflowError ? error.diagnostics : [{ code: 'file_read', path: this.state.workflowPath ?? root, message: message(error) }];
    }
    await this.readScenario('tests'); await this.readScenario('pr');
    this.updateTargets();
  }

  private async readScenario(mode: InputMode): Promise<void> {
    const scenario = this.scenarios[mode];
    if (scenario.input) {
      const path = scenario.input.path;
      try {
        if (mode === 'tests') {
          const text = await readFixtureText(path);
          scenario.input = { path, digest: digest(text), fixture: parseFixture(parseJson(text, path)), error: null };
        } else {
          const captured = await readCapturedInspection(path), pr = captured.evidence.pullRequest;
          scenario.input = { path, digest: digest(canonicalJson(captured)), fixture: captured.fixture, error: null,
            capture: { ...captured.evidence.requested, title: pr?.title ?? 'PR evidence unavailable', headSha: pr?.headSha ?? null,
              status: captured.status, packageDigest: captured.packageDigest } };
        }
      } catch (error) { scenario.input = { path, digest: null, fixture: null, error: message(error) }; }
    }
    if (scenario.packetsPath) {
      try {
        const text = await readFixtureText(scenario.packetsPath), packets = parseJson(text, scenario.packetsPath);
        (Array.isArray(packets) ? packets : [packets]).forEach(validatePacket);
        scenario.packetsText = text; scenario.packetsError = null;
      } catch (error) { scenario.packetsText = null; scenario.packetsError = message(error); }
    }
  }
}
