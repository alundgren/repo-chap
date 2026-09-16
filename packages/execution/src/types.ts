import type { WorkflowPackage } from '@repo-chap/workflow';
import type { Inspection } from '@repo-chap/github';
import type { Outcome, ProviderResult } from '@repo-chap/providers';

export interface CheckCommand { id: string; executable: string; args: string[]; timeoutMs: number; maxOutputBytes: number }
export interface ExecutionPolicy {
  schemaVersion: 1; allowedPaths: string[]; excludedPaths: string[]; requiredChecks: CheckCommand[];
}
export interface RepairJob {
  schemaVersion: 1; runId: string; attemptId: string; ownershipToken: string; deadline: string;
  repositoryId: string; pullRequestId: string; headSha: string; baseSha: string;
  package: WorkflowPackage; inspection: Inspection; actionId: string;
  profile: string; profileDigest: string; policy: ExecutionPolicy; policyDigest: string;
}
export interface ArtifactRef { id: string; digest: string; bytes: number; kind: 'job' | 'result' | 'source' | 'bundle' | 'patch' | 'log' }
export interface ThreadDecision { threadId: string; disposition: 'addressed' | 'declined' | 'blocked'; response: string; evidenceRefs: string[] }
export interface Candidate {
  schemaVersion: 1; outcome: 'candidate'; expectedHeadSha: string; baseSha: string; candidateSha: string;
  summary: string; changedPaths: string[]; threads: ThreadDecision[]; suggestedChecks: string[]; notesMarkdown: string;
}
export interface RepairStop {
  schemaVersion: 1; outcome: 'blocked' | 'no_change'; expectedHeadSha: string; reason: string; threads: ThreadDecision[]; notesMarkdown: string;
}
export interface CheckReceipt {
  id: string; candidateSha: string; commandDigest: string; status: 'passed' | 'failed' | 'timeout' | 'cancelled' | 'superseded' | 'output_limit' | 'skipped';
  exitCode: number | null; startedAt: string; finishedAt: string; diagnostic: string; log?: ArtifactRef;
}
export interface RepairResult {
  schemaVersion: 1; runId: string; attemptId: string; ownershipToken: string; deadline: string;
  repositoryId: string; pullRequestId: string; headSha: string; baseSha: string; packageDigest: string;
  policyDigest: string; profileDigest: string; evidenceDigest: string; fixtureDigest: string; job: ArtifactRef;
  status: 'candidate' | 'blocked' | 'no_change' | 'checks_failed' | Exclude<Outcome, 'completed'>;
  startedAt: string; finishedAt: string; diagnostic: string; requiredChecksPassed: boolean;
  payload?: Candidate | RepairStop; provider?: ProviderResult; source?: ArtifactRef;
  candidate?: { sha: string; tree: string; parents: string[]; bundle: ArtifactRef; patch: ArtifactRef };
  checks: CheckReceipt[];
}
