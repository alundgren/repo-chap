import type { AnalysisRecord, Outcome, ProviderProfile } from '@repo-chap/providers';
import type { Inspection } from '@repo-chap/github';
import type { DocumentToken, EditorResult } from './protocol.js';
import type { ConversationProvider } from './conversation-protocol.js';

export interface TrialSelection { repository: string; pr: number; sourceRepository: string; profile: string }
export interface TrialProposal { document: DocumentToken; selection: TrialSelection; provider: ConversationProvider; preparedBy: 'person' | 'assistant' }
export interface TrialRecord {
  schemaVersion: 1; id: string; workflowIdentity: string; document: DocumentToken;
  selection: TrialSelection; provider: ConversationProvider; profileDigest: string;
  draftDigest: string; packageDigest: string; startedAt: string; finishedAt: string | null;
  status: 'running' | Outcome; phase: 'capture' | 'sources' | 'classify' | 'review' | 'verify' | 'finished';
  diagnostic: string; invalidated: boolean; capture: string | null;
  inspection: { status: Inspection['status']; evidenceDigest: string; headSha: string | null; baseSha: string | null } | null;
  remote: { status: 'unchecked' | 'current' | 'stale' | 'unknown'; checkedAt: string | null; headSha: string | null; baseSha: string | null };
  analysis: (AnalysisRecord & { recordPath: string }) | null;
  recordPath: string;
}
export interface TrialSnapshot {
  documentSessionId: string; revision: number; proposal: TrialProposal | null;
  activeId: string | null; refreshing: boolean; refreshingId: string | null; records: TrialRecord[]; currentIds: string[];
}
export interface TrialResult extends EditorResult { trial: TrialSnapshot | null; profiles: ConversationProvider[] }
export interface TrialBridge {
  current(): Promise<TrialResult>;
  loadProfiles(): Promise<TrialResult>;
  chooseSource(documentSessionId: string): Promise<TrialResult & { sourceRepository?: string }>;
  prepare(token: DocumentToken, selection: TrialSelection): Promise<TrialResult>;
  start(token: DocumentToken, selection: TrialSelection): Promise<TrialResult>;
  invalidate(documentSessionId: string): Promise<TrialResult>;
  cancel(documentSessionId: string, id: string): Promise<TrialResult>;
  refresh(documentSessionId: string, id: string): Promise<TrialResult>;
  exportFixture(documentSessionId: string, id: string): Promise<TrialResult>;
  onChange(callback: (snapshot: TrialSnapshot) => void): () => void;
}
export const publicProfile = ({ name, provider, model, effort }: ProviderProfile): ConversationProvider => ({ name, provider, model, ...(effort ? { effort } : {}) });
