import type { Capability, ControlState, Diagnostic, WorkflowPackage } from '@repo-chap/workflow';
import type { Inspection } from '@repo-chap/github';
import type { ProviderResult } from '@repo-chap/providers';

export interface ArtifactRef { id: string; digest: string; bytes: number }
export interface RuntimeLimits {
  concurrency: number; repositoryConcurrency: number; maxAttemptsPerLifecycle: number; maxRetries: number;
  repositoryCostUnits: number; dailyCostUnits: number; attemptCostUnits: number;
  maxAttemptSeconds: number; maxImmediateSteps: number; pollSeconds: number;
}
export const defaultLimits: RuntimeLimits = {
  concurrency: 2, repositoryConcurrency: 1, maxAttemptsPerLifecycle: 20, maxRetries: 3,
  repositoryCostUnits: 1000, dailyCostUnits: 100, attemptCostUnits: 1,
  maxAttemptSeconds: 300, maxImmediateSteps: 32, pollSeconds: 60,
};
export interface RepositoryRecord {
  id: string; name: string; package: ArtifactRef | null; packageDigest: string | null; profile: string;
  reviewers: string[]; paused: boolean; nextPollAt: number; diagnostic: string | null;
  lastPolledPr: number;
  activeVersionId: string | null; source: WorkflowSource | null;
}
export interface WorkflowSource {
  workflowPath: string; branch: string | null; maximumCapabilities: Capability[];
  resolvedBranch: string | null; observedRevision: string | null; checkedAt: number | null;
  status: 'pending' | 'valid' | 'invalid' | 'unavailable'; diagnostics: Diagnostic[]; held: boolean;
}
export interface WorkflowVersion {
  id: string; repositoryId: string; package: ArtifactRef; packageDigest: string;
  sourceRevision: string | null; sourceBranch: string | null; createdAt: number;
}
export interface MigrationRecord {
  id: string; runId: string; fromVersionId: string; toVersionId: string; at: number;
  ownershipToken: number; notesRevision: number; evidenceKey: string; invalidatedResults: boolean;
}
export interface WaitTiming {
  youngUntil: number | null;
  head: { headSha: string | null; baseSha: string | null; until: number } | null;
  reviewer: { startedAt: string; until: number } | null;
}
export type RunStatus = 'ready' | 'running' | 'waiting' | 'blocked' | 'cancelled' | 'closed';
export interface RunRecord {
  id: string; repositoryId: string; subjectKind: 'pull_request'; subjectId: string; number: number;
  package: ArtifactRef; packageDigest: string; inspection: ArtifactRef; evidenceKey: string;
  headSha: string | null; baseSha: string | null; control: ControlState;
  status: RunStatus; reason: string; dueAt: number | null; nextAction: string | null;
  token: number; owner: string | null; leaseUntil: number | null; notesRevision: number;
  retries: number; steps: number; agents: number; suppression: string | null;
  evidenceAvailable: boolean;
  failedActions: Record<string, string>; retryAction: string | null;
  workflowVersionId: string; waitTiming: WaitTiming | null;
}
export interface Claim { runId: string; owner: string; token: number; until: number; evidenceKey: string; notesRevision: number }
export interface AnalysisJob {
  schemaVersion: 1; runId: string; attemptId: string; ownershipToken: number; deadline: string;
  repositoryId: string; subjectId: string; actionId: string; headSha: string; baseSha: string;
  package: ArtifactRef; packageDigest: string; inspection: ArtifactRef; sources: ArtifactRef;
  evidenceKey: string; notesRevision: number; profile: string; profileDigest: string;
  workflowVersionId?: string;
}
export interface AnalysisResult {
  schemaVersion: 1; job: AnalysisJob; provider: ProviderResult;
}
export interface EffectRequest {
  kind: string; destination: string; evidenceKey: string; payload: ArtifactRef; expectedRevision: string;
}
export type EffectState = 'planned' | 'sending' | 'confirmed' | 'rejected' | 'unknown';
export interface EffectRecord extends EffectRequest { id: string; runId: string; token: number; state: EffectState; receipt: unknown | null }
export interface Registration { id: string; name: string; package: WorkflowPackage; profile: string; reviewers: string[] }
export interface SourceRegistration { id: string; name: string; workflowPath: string; branch: string | null; profile: string; reviewers: string[]; maximumCapabilities: Capability[] }
export interface ObservationInput { repositoryId: string; inspection: Inspection; package: ArtifactRef }
