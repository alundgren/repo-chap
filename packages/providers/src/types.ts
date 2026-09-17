import type { Capability, WorkflowPackage } from '@repo-chap/workflow';
import type { SourceBundle } from './sources.js';

export type Outcome = 'completed' | 'provider_error' | 'invalid_output' | 'blocked' | 'timeout' | 'cancelled' | 'superseded';
export interface ProviderProfile {
  provider: 'codex' | 'claude'; name: string; executable: string; model: string; effort?: string;
  timeoutMs: number; maxOutputBytes: number; maxAttempts: number;
  maximumCapabilities: Capability[];
}
export interface SessionIdentity { provider: string; providerDigest: string; inputDigest: string; id: string }
export interface Usage {
  actual: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens?: number; cacheCreationInputTokens?: number } | null;
  estimated: { inputTokens: number; outputTokens: number; method: 'utf8_bytes_divided_by_four'; costUsd?: number; costMethod?: 'provider_reported_estimate' };
}
export interface Attempt {
  id: string; outcome: Outcome; resumed: boolean; startedAt: string; finishedAt: string;
  diagnostic: string; usage: Usage; outputBytes: number; exitCode: number | null;
}
export interface ProviderResult {
  schemaVersion: 1; provider: string; providerVersion: string | null; profile: string;
  providerDigest: string | null; inputDigest: string; outcome: Outcome; diagnostic: string;
  payload?: unknown; session?: SessionIdentity; attempts: Attempt[];
}
export interface ProviderRequest {
  package: WorkflowPackage; actionId: string; profile: ProviderProfile; mode: 'read' | 'workspace';
  workingDirectory: string; artifactDirectory: string;
  sources: SourceBundle; evidence: unknown; evidenceDigest: string; fixtureDigest: string;
  missingEvidence: string[]; signal?: AbortSignal; session?: SessionIdentity;
  /** The host can reject a late result after its lease or observed inputs changed. */
  isCurrent?: () => boolean | Promise<boolean>;
}
