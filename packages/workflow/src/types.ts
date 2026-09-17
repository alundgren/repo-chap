export type Truth = true | false | 'unknown';
export const factTypes = {
  lifecycle: 'string', draft: 'boolean', evidenceComplete: 'boolean', young: 'boolean',
  headDebouncing: 'boolean', conflict: 'boolean', unaddressedReview: 'boolean', externalReviewPending: 'boolean',
} as const;
export const memoryFields = ['classificationCurrent', 'reviewCurrent', 'packetCurrent', 'repairSuppressed'] as const;
export type MemoryField = typeof memoryFields[number];
export type Facts = { lifecycle?: 'open' | 'closed' | 'merged' | null } &
  Partial<Record<Exclude<keyof typeof factTypes, 'lifecycle'>, boolean | null>>;
export type Memory = Partial<Record<MemoryField, boolean | null>>;
export type Condition = { field: string; op: 'eq' | 'ne'; value: string | boolean } |
  { all: Condition[] } | { any: Condition[] } | { not: Condition };
export type Capability = 'workspace.read' | 'workspace.write' | 'checks.run' | 'pr.push' |
  'review.resolve' | 'labels.set' | 'review.publish' | 'notify.send';
export interface Action {
  execution: 'code' | 'agent'; uses: string; capabilities: Capability[];
  onSuccess: string; onFailure: string; prompt?: string; outputSchema?: string; contextFiles?: string[];
}
export interface Workflow {
  schemaVersion: 1; id: string; version: string;
  settings: { newPrDelaySeconds: number; headDebounceSeconds: number; reviewWaitSeconds: number; reviewDeadlineSeconds: number; mergeMode: 'human' };
  limits: { maxAttemptsPerHead: number; maxRepairsPerLifecycle: number; maxAgentActionsPerWake: number; maxAttemptSeconds: number; maxDailyCostUnits: number };
  requestedCapabilities: Capability[]; labels: string[];
  rules: { id: string; when: Condition; action: string }[];
  otherwise: string; actions: Record<string, Action>; layout?: Record<string, unknown>;
  slack?: { workspaceId: string; users: Record<string, string>; channels: Record<string, string>; defaultChannel: string; routes: Record<PacketOutcome, string>; mentions?: Partial<Record<PacketOutcome, string[]>> };
}
export interface Diagnostic { code: string; path: string; message: string }
export interface PinnedFile { path: string; text: string; digest: string }
export interface WorkflowPackage {
  schemaVersion: 1; workflowPath: string; workflow: Workflow; files: readonly PinnedFile[]; digest: string;
}
export interface Observation {
  facts: Facts; headSha?: string; baseSha?: string; evidenceDigest?: string;
  createdAt?: string; headChangedAt?: string; externalReviewStartedAt?: string;
}
export interface ControlState {
  memory?: Memory; attemptsThisHead?: number; repairsThisLifecycle?: number;
  repairSuppression?: { evidenceDigest: string; reason: string } | null;
  refreshAttempts?: number;
  review?: { verdict: 'acceptable' | 'concerns' | 'blocking' | 'inconclusive'; coverage: 'complete' | 'partial' };
  classification?: { uncertain: boolean };
}
export interface StubResult {
  status: 'success' | 'failure' | 'unknown'; payload?: unknown; reason?: string;
}
export interface ReplayFixture {
  schemaVersion: 1; now: string; observations: Observation[]; control?: ControlState;
  results?: Record<string, StubResult[]>; maxSteps?: number;
  expected?: ReplayExpectation;
}
export interface ReplayExpectation {
  status: ReplayResult['status'];
  selectedRuleIds: (string | null)[];
  proposedEffects: { actionId: string; uses: string; outcome?: PacketOutcome }[];
}
export interface ReplayComparison {
  passed: boolean;
  checks: { field: keyof ReplayExpectation; expected: unknown; actual: unknown; passed: boolean }[];
}
export type PacketOutcome = 'needs_author' | 'needs_team' | 'ready_for_human_merge' | 'blocked_execution';
export interface ConditionTrace { value: Truth; reason: string; children?: ConditionTrace[] }
export interface Decision {
  actionId: string; ruleId: string | null;
  rules: { id: string; selected: boolean; condition: ConditionTrace }[];
}
export interface ProposedEffect { actionId: string; uses: string; capabilities: Capability[]; outcome?: PacketOutcome; headSha?: string | null; destination?: string; reason: string }
export interface ReplayResult {
  schemaVersion: 1; packageDigest: string; now: string;
  status: 'waiting' | 'closed' | 'blocked' | 'needs_observation' | 'needs_result';
  reason: string; nextWakeAt: string | null; decisions: Decision[];
  actions: { actionId: string; uses: string; status: string; reason: string }[];
  proposedEffects: ProposedEffect[];
  control: ControlState;
}
