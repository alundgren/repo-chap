import type { Diagnostic } from '@repo-chap/workflow';

export interface DocumentToken { sessionId: string; revision: number }
export interface SourceDocument {
  path: string;
  text: string;
  dirty: boolean;
  external: boolean;
  error: string | null;
}
export interface EditorDiagnostic extends Diagnostic { file: string }
export interface DocumentSnapshot extends DocumentToken {
  repositoryRoot: string;
  workflowPath: string;
  files: SourceDocument[];
  readOnlyReason: string | null;
  diagnostics: EditorDiagnostic[];
  packageDigest: string | null;
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
  checkExternal(): Promise<EditorResult>;
  close(token: DocumentToken | null, discard: boolean): Promise<EditorResult>;
  onCloseRequested(callback: () => void): () => void;
}
