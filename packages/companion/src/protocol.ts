import type { Diagnostic, ReplayComparison, ReplayFixture, ReplayResult, Workflow } from '@repo-chap/workflow';
import type { ReplayHandoffPreview } from '@repo-chap/slack';

export type CompanionView = 'overview' | 'available' | 'simulation';
export type InputMode = 'tests' | 'pr';
export interface WorkflowEntry { path: string; id: string | null }
export interface SimulationInput {
  path: string;
  digest: string | null;
  fixture: ReplayFixture | null;
  error: string | null;
  capture?: { repository: string; pr: number; title: string; headSha: string | null; status: string; packageDigest: string };
}
export interface SimulationRecord {
  packageDigest: string;
  inputDigest: string;
  packetsDigest: string | null;
  result: ReplayResult;
  comparison: ReplayComparison | null;
  handoffs: ReplayHandoffPreview[];
  previewError: string | null;
}
export interface Guidance {
  id: string;
  target: string;
  text: string;
  style: 'highlight' | 'arrow';
  expiresAt: number;
}
export interface CompanionState {
  schemaVersion: 1;
  revision: number;
  repositoryRoot: string | null;
  repositoryName?: string | null;
  worktreeName?: string | null;
  workflows: WorkflowEntry[];
  discoveryWarning: string | null;
  workflowPath: string | null;
  workflow: Workflow | null;
  packageDigest: string | null;
  files: { path: string; digest: string }[];
  changedPaths: string[];
  diagnostics: Diagnostic[];
  view: CompanionView;
  mode: InputMode;
  input: SimulationInput | null;
  packetsPath: string | null;
  packetsError: string | null;
  simulation: SimulationRecord | null;
  simulationCurrent: boolean;
  guidance: Guidance | null;
  targets: string[];
}
export type CompanionCommand =
  | { kind: 'status' }
  | { kind: 'open'; repositoryRoot: string; workflowPath?: string }
  | { kind: 'select'; workflowPath: string }
  | { kind: 'show'; view?: CompanionView; mode?: InputMode; target?: string }
  | { kind: 'input'; mode: InputMode; path: string }
  | { kind: 'packets'; path: string }
  | { kind: 'simulate'; mode?: InputMode; path?: string; packetsPath?: string }
  | { kind: 'highlight'; target: string; text?: string; style?: 'highlight' | 'arrow'; seconds?: number }
  | { kind: 'clear' };
export interface CompanionRequest {
  schemaVersion: 1;
  repositoryRoot?: string;
  workflowPath?: string;
  command: CompanionCommand;
}
export type CompanionResponse = { schemaVersion: 1; ok: true; state: CompanionState } | { schemaVersion: 1; ok: false; error: string };

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function fields(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown desktop field: ${key}.`);
}
function string(value: unknown, label: string, optional = false): void {
  if (optional && value === undefined) return;
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')) throw new Error(`${label} must be nonempty text of at most 4096 characters.`);
}
export function parseCompanionRequest(value: unknown): CompanionRequest {
  if (!object(value) || value.schemaVersion !== 1 || !object(value.command)) throw new Error('Use desktop protocol version 1 with a command.');
  fields(value, ['schemaVersion', 'repositoryRoot', 'workflowPath', 'command']);
  string(value.repositoryRoot, 'repositoryRoot', true); string(value.workflowPath, 'workflowPath', true);
  const command = value.command;
  const allowed: Record<string, string[]> = {
    status: [], open: ['repositoryRoot', 'workflowPath'], select: ['workflowPath'],
    show: ['view', 'mode', 'target'], input: ['mode', 'path'], packets: ['path'],
    simulate: ['mode', 'path', 'packetsPath'], highlight: ['target', 'text', 'style', 'seconds'], clear: [],
  };
  if (typeof command.kind !== 'string' || !Object.hasOwn(allowed, command.kind)) throw new Error('Unknown desktop command. See repo-chap desktop --help.');
  fields(command, ['kind', ...allowed[command.kind]!]);
  for (const key of ['repositoryRoot', 'workflowPath', 'path', 'packetsPath', 'target', 'text']) if (key in command) string(command[key], key);
  for (const [kind, keys] of Object.entries({ open: ['repositoryRoot'], select: ['workflowPath'], input: ['path', 'mode'], packets: ['path'], highlight: ['target'] })) {
    if (command.kind === kind) for (const key of keys) string(command[key], key);
  }
  if (command.view !== undefined && !['overview', 'available', 'simulation'].includes(String(command.view))) throw new Error('Choose overview, available, or simulation.');
  if (command.mode !== undefined && !['tests', 'pr'].includes(String(command.mode))) throw new Error('Choose tests or pr.');
  if (command.path !== undefined && command.kind === 'simulate' && command.mode === undefined) throw new Error('Choose tests or pr when supplying simulation input.');
  if (command.style !== undefined && !['highlight', 'arrow'].includes(String(command.style))) throw new Error('Choose highlight or arrow.');
  if (command.seconds !== undefined && (typeof command.seconds !== 'number' || !Number.isFinite(command.seconds) || command.seconds < 1 || command.seconds > 120)) throw new Error('Guidance lasts between 1 and 120 seconds.');
  return value as unknown as CompanionRequest;
}
