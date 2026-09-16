import type { Diagnostic, ReplayResult, Workflow } from '@repo-chap/workflow';
import type { ReplayHandoffPreview } from '@repo-chap/slack';

export interface DocumentToken { sessionId: string; revision: number }
export interface SourceDocument {
  path: string;
  text: string;
  dirty: boolean;
  external: boolean;
  error: string | null;
}
export interface EditorDiagnostic extends Diagnostic { file: string }
export type VisualEdit =
  | { kind: 'moveRule'; ruleId: string; toIndex: number }
  | { kind: 'action'; actionId: string; field: 'onSuccess' | 'onFailure' | 'prompt'; value: string }
  | { kind: 'context'; actionId: string; value: string[] }
  | { kind: 'setting'; field: 'newPrDelaySeconds' | 'headDebounceSeconds' | 'reviewWaitSeconds' | 'reviewDeadlineSeconds'; value: number };
export type SimulationInputKind = 'fixture' | 'packets';
export interface SimulationInput { name: string; text: string; changed: boolean }
export interface SemanticChange { path: string; before: string; after: string }
export interface SimulationRecord {
  token: DocumentToken;
  packageDigest: string;
  fixtureDigest: string;
  packetsDigest: string | null;
  result: ReplayResult;
  handoffs: ReplayHandoffPreview[];
  previewError: string | null;
}
export interface DocumentSnapshot extends DocumentToken {
  repositoryRoot: string;
  workflowPath: string;
  files: SourceDocument[];
  readOnlyReason: string | null;
  diagnostics: EditorDiagnostic[];
  packageDigest: string | null;
  workflow: Workflow | null;
  semanticChanges: SemanticChange[];
  semanticError: string | null;
  simulationInputs: Record<SimulationInputKind, SimulationInput | null>;
  simulation: SimulationRecord | null;
  simulationCurrent: boolean;
}
export interface EditorResult {
  snapshot: DocumentSnapshot | null;
  error?: string;
  cancelled?: boolean;
}
export type OpenKind = 'repository' | 'workflow';
export interface EditorBridge {
  current(): Promise<EditorResult>;
  open(kind: OpenKind, token: DocumentToken | null, discard: boolean): Promise<EditorResult>;
  edit(token: DocumentToken, path: string, text: string): Promise<EditorResult>;
  save(token: DocumentToken): Promise<EditorResult>;
  reload(token: DocumentToken, path: string): Promise<EditorResult>;
  discard(token: DocumentToken, path: string): Promise<EditorResult>;
  visualEdit(token: DocumentToken, edit: VisualEdit): Promise<EditorResult>;
  reset(token: DocumentToken): Promise<EditorResult>;
  loadSimulationInput(token: DocumentToken, kind: SimulationInputKind): Promise<EditorResult>;
  editSimulationInput(token: DocumentToken, kind: SimulationInputKind, text: string): Promise<EditorResult>;
  resetSimulationInput(token: DocumentToken, kind: SimulationInputKind): Promise<EditorResult>;
  setClock(token: DocumentToken, now: string): Promise<EditorResult>;
  simulate(token: DocumentToken): Promise<EditorResult>;
  exportWorkflow(token: DocumentToken): Promise<EditorResult>;
  checkExternal(): Promise<EditorResult>;
  close(token: DocumentToken | null, discard: boolean): Promise<EditorResult>;
  onCloseRequested(callback: () => void): () => void;
}
