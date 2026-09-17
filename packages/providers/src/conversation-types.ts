import type { ProviderProfile } from './types.js';

export const conversationLimits = {
  promptBytes: 16 * 1024, contextBytes: 256 * 1024, outputBytes: 1024 * 1024,
  protocolLineBytes: 512 * 1024, protocolEvents: 20_000, toolCalls: 32,
  toolArgumentBytes: 32 * 1024, toolResultBytes: 64 * 1024, turns: 20,
} as const;

export interface ConversationSessionIdentity {
  provider: 'codex' | 'claude'; version: string; binding: string; id: string; turns: number;
}
export interface ConversationQuestion {
  id: string; header: string; question: string;
  options: { label: string; description: string }[]; multiple: boolean; freeform: boolean;
}
export type ConversationInputRequest =
  | { id: string; kind: 'questions'; questions: ConversationQuestion[] }
  | { id: string; kind: 'approval'; tool: string; description: string };
export type ConversationInputAnswer = { answers: Record<string, string[]> } | { decision: 'allow' | 'deny' };
export type ConversationEvent =
  | { type: 'session'; session: ConversationSessionIdentity }
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; status: 'running' | 'completed' | 'failed' }
  | { type: 'waiting'; reason: 'provider' | 'tool' | 'input' }
  | { type: 'input'; request: ConversationInputRequest }
  | { type: 'completed'; session: ConversationSessionIdentity }
  | { type: 'cancelled' }
  | { type: 'error'; code: ConversationErrorCode; message: string };
export type ConversationErrorCode = 'unavailable' | 'unsupported' | 'login' | 'settings' | 'protocol' | 'provider' | 'limit' | 'timeout' | 'session';
export interface ConversationTool {
  name: string; description: string; inputSchema: Record<string, unknown>;
  execute(arguments_: unknown, operation: { id: string; signal: AbortSignal }): Promise<{ text: string; isError?: boolean }>;
}
export interface ConversationTurnRequest {
  profile: ProviderProfile;
  /** Private application directory, outside the managed repository. */
  workingDirectory: string;
  prompt: string;
  /** Immutable host snapshot, including its document and test revision provenance. */
  context: string;
  session?: ConversationSessionIdentity;
  tools?: readonly ConversationTool[];
  signal?: AbortSignal;
  onEvent(event: ConversationEvent): void;
  onInput(request: ConversationInputRequest, signal: AbortSignal): Promise<ConversationInputAnswer>;
}
export type ConversationTurnResult =
  | { status: 'completed'; session: ConversationSessionIdentity }
  | { status: 'cancelled' }
  | { status: 'error'; code: ConversationErrorCode; message: string };

export class ConversationError extends Error {
  constructor(readonly code: ConversationErrorCode, message: string) { super(message); }
}
