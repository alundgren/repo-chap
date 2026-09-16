import type { DocumentToken, VisualEdit } from './protocol.js';

export type AuthoringAction =
  | { kind: 'read'; paths: string[] }
  | { kind: 'edit'; changes: { path: string; text: string }[] }
  | { kind: 'visual'; edit: VisualEdit }
  | { kind: 'createFixture'; path: string; text: string }
  | { kind: 'validate' }
  | { kind: 'test'; fixturePath: string };
export interface AuthoringOperation { operationId: string; expected: DocumentToken; action: AuthoringAction }
export interface AuthoringReceipt {
  operationId: string;
  kind: AuthoringAction['kind'];
  status: 'applied' | 'completed' | 'rejected' | 'cancelled';
  before: DocumentToken;
  after: DocumentToken;
  changedPaths: string[];
  message: string;
  display: 'confirmed' | 'unconfirmed' | 'not-needed';
}
export interface AuthoringContext {
  token: DocumentToken;
  workflowPath: string;
  packageDigest: string | null;
  files: { path: string; kind: 'source' | 'fixture'; digest: string; dirty: boolean }[];
  filesOmitted?: number;
  pendingHumanInput?: { field: string; value: string }[];
}
export interface AuthoringResponse { receipt: AuthoringReceipt; context: AuthoringContext; data?: unknown }
