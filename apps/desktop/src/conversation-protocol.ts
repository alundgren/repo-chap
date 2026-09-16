import type { ConversationErrorCode, ConversationInputRequest, ProviderProfile } from '@repo-chap/providers';
import type { DocumentToken } from './protocol.js';

export type ConversationProvider = Pick<ProviderProfile, 'provider' | 'name' | 'model' | 'effort'>;

/** The document/test owner captures this before dispatch. The controller does not read files. */
export interface CapturedConversationContext {
  text: string;
  document: DocumentToken;
  provenance: string;
}
export interface ConversationContextRecord {
  document: DocumentToken;
  digest: string;
  provenance: string;
}
export interface ConversationTurn {
  kind: 'turn';
  id: string;
  provider: ConversationProvider;
  sessionId: string | null;
  context: ConversationContextRecord;
  prompt: string;
  answer: string;
  answerTruncated: boolean;
  status: 'running' | 'completed' | 'cancelled' | 'error';
  tools: { id: string; name: string; status: 'running' | 'completed' | 'failed' }[];
  inputs: { question: string; answer: string; truncated: boolean }[];
  error: { code: ConversationErrorCode; message: string } | null;
}
export interface ConversationNotice {
  kind: 'notice';
  id: string;
  reason: 'fresh' | 'provider';
  text: string;
  provider: ConversationProvider;
  handoff: { status: 'pending' | 'attached' | 'cleared'; includedTurns: number; omittedTurns: number; truncated: boolean } | null;
}
export type ConversationHistoryEntry = ConversationTurn | ConversationNotice;

/** Renderer data contains neither provider bindings nor the private process directory. */
export interface ConversationSnapshot {
  id: string;
  revision: number;
  documentSessionId: string;
  provider: ConversationProvider;
  status: 'ready' | 'running' | 'waiting' | 'input' | 'cancelling' | 'closed';
  waitingFor: 'provider' | 'tool' | null;
  requiresFresh: boolean;
  session: { id: string; version: string; turns: number } | null;
  activeTurnId: string | null;
  input: { turnId: string; request: ConversationInputRequest } | null;
  history: ConversationHistoryEntry[];
  omittedEntries: number;
}
