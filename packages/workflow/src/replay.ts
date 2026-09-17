import { controlDecision } from './control.js';
import schema from './fixture.schema.json' with { type: 'json' };
import { canonicalJson, digest, fail, record, WorkflowError } from './common.js';
import { currentFacts, currentMemory, evaluate, hasCompleteEvidence } from './evaluate.js';
import { validateActionPayload } from './package.js';
import { actionRegistry } from './registry.js';
import { limits, schemaDiagnostics, schemaValidator } from './validate.js';
import type { ControlState, PacketOutcome, ReplayFixture, ReplayResult, WorkflowPackage } from './types.js';

const validateFixture = schemaValidator().compile(schema);
export function parseFixture(value: unknown): ReplayFixture {
  if (!validateFixture(value)) throw new WorkflowError(schemaDiagnostics(validateFixture, '/fixture'));
  return value as unknown as ReplayFixture;
}
export function replay(pkg: WorkflowPackage, input: ReplayFixture): ReplayResult {
  const fixture = parseFixture(input);
  const workflow = pkg.workflow;
  for (const id of Object.keys(fixture.results ?? {})) if (!Object.hasOwn(workflow.actions, id)) fail('stub_action', `/fixture/results/${id}`, 'Stub names an unknown action.');
  const control: ControlState = structuredClone(fixture.control ?? {});
  const result: ReplayResult = { schemaVersion: 1, packageDigest: pkg.digest, now: fixture.now, status: 'blocked', reason: '', nextWakeAt: null, decisions: [], actions: [], proposedEffects: [], control };
  const stop = (status: ReplayResult['status'], reason: string, wake: number | null = null): ReplayResult => {
    result.status = status; result.reason = reason;
    result.nextWakeAt = wake === null ? null : new Date(wake).toISOString();
    return result;
  };
  let observationIndex = 0, agents = 0;
  let observation = fixture.observations[0]!;
  let actionId = '';
  let failureReason: string | undefined;
  const inputs = new Map<string, string>();
  const used: Record<string, number> = Object.create(null);
  const now = Date.parse(fixture.now);
  for (let step = 0; step < (fixture.maxSteps ?? limits.replaySteps); step++) {
    if (!actionId) {
      const decision = evaluate(workflow, observation, control, fixture.now);
      result.decisions.push(decision); actionId = decision.actionId;
    }
    const action = workflow.actions[actionId]!;
    const definition = actionRegistry[action.uses]!;
    const facts = currentFacts(workflow, observation, fixture.now);
    const memory = currentMemory(control, observation);
    if (definition.requires) {
      const analysis = definition.requires === 'review' || definition.requires === 'classification';
      const expected = analysis ? `${observation.headSha}:${observation.baseSha}` : inputs.get('candidate');
      if (!expected || inputs.get(definition.requires) !== expected) return stop('blocked', `${actionId} requires a successful ${definition.requires} result in this action chain.`);
    }
    if (action.uses === 'github.set_labels' && control.classification?.uncertain !== false) return stop('blocked', 'Uncertain classification cannot publish labels. Its evidence remains local.');
    const scheduling = controlDecision(workflow, action.uses, observation, control, fixture.now);
    if (scheduling) {
      if (scheduling.refreshAttempts !== undefined) control.refreshAttempts = scheduling.refreshAttempts;
      if (scheduling.status === 'waiting' || scheduling.status === 'closed') result.actions.push({ actionId, uses: action.uses, status: 'simulated', reason: scheduling.reason });
      return stop(scheduling.status, scheduling.reason, scheduling.nextWakeAt ? Date.parse(scheduling.nextWakeAt) : null);
    }
    if (!hasCompleteEvidence(facts) && action.uses !== 'human.publish_packet') return stop('blocked', 'Incomplete or unknown evidence cannot authorize an agent action or effect.');
    if (facts.lifecycle !== 'open' || facts.draft !== false || facts.young !== false || facts.headDebouncing !== false) {
      if (action.uses !== 'human.publish_packet') return stop('blocked', 'Work requires an open, non-draft PR whose age and debounce delays have passed.');
    }
    if (definition.repair && memory.repairSuppressed !== false) return stop('blocked', 'Repair suppression must be resolved against current evidence before another repair.');
    if (definition.consumesAgentBudget) {
      if (agents >= workflow.limits.maxAgentActionsPerWake || (control.attemptsThisHead ?? 0) >= workflow.limits.maxAttemptsPerHead) return stop('blocked', 'Agent action or per-head attempt budget is exhausted.');
      if (definition.repair && (control.repairsThisLifecycle ?? 0) >= workflow.limits.maxRepairsPerLifecycle) return stop('blocked', 'Lifecycle repair budget is exhausted.');
    }
    let outcome: PacketOutcome | undefined;
    if (action.uses === 'human.publish_packet') {
      outcome = failureReason || !hasCompleteEvidence(facts) || facts.externalReviewPending !== false || facts.lifecycle !== 'open' || facts.draft !== false || facts.young !== false || facts.headDebouncing !== false ? 'blocked_execution' :
        facts.conflict === true ? 'needs_author' : facts.unaddressedReview === true ? 'needs_team' :
        memory.reviewCurrent === true && memory.classificationCurrent === true && control.review?.coverage === 'complete' && control.review.verdict === 'acceptable' && control.classification?.uncertain === false ? 'ready_for_human_merge' :
        memory.reviewCurrent === true && (control.review?.verdict === 'concerns' || control.review?.verdict === 'blocking') ? 'needs_team' : 'blocked_execution';
    }
    const reason = failureReason ?? (outcome ? `Proposed human handoff: ${outcome}.` : 'Proposed action only; replay runs no code, provider, or remote effect.');
    result.proposedEffects.push({ actionId, uses: action.uses, capabilities: [...action.capabilities], ...(outcome ? { outcome, headSha: observation.headSha ?? null, destination: workflow.slack?.routes[outcome] ?? 'unconfigured' } : {}), reason });
    const index = used[actionId] ?? 0;
    const stub = fixture.results?.[actionId]?.[index];
    if (!stub) return stop('needs_result', `Supply fixture.results.${actionId}[${index}] to continue the proposed action.`);
    used[actionId] = index + 1;
    for (const kind of definition.invalidates ?? []) inputs.delete(kind);
    if (definition.repair || action.uses === 'agent.review') {
      control.memory = { ...control.memory, reviewCurrent: false, packetCurrent: false };
      delete control.review;
    }
    if (definition.repair || action.uses === 'agent.classify') {
      control.memory = { ...control.memory, classificationCurrent: false, packetCurrent: false };
      delete control.classification;
    }
    if (definition.consumesAgentBudget) {
      agents++; control.attemptsThisHead = (control.attemptsThisHead ?? 0) + 1;
      if (definition.repair) control.repairsThisLifecycle = (control.repairsThisLifecycle ?? 0) + 1;
    }
    if (stub.status === 'unknown') {
      result.actions.push({ actionId, uses: action.uses, status: 'unknown', reason: stub.reason ?? 'Stub reports an unknown outcome.' });
      return stop('blocked', 'Action outcome is unknown. Reconciliation is required before another attempt.');
    }
    let success = stub.status === 'success';
    if (success && action.outputSchema) {
      validateActionPayload(pkg, actionId, stub.payload);
      if (record(stub.payload)) {
        if (observation.headSha && (stub.payload.headSha ?? stub.payload.expectedHeadSha) !== observation.headSha) return stop('blocked', 'Stub result belongs to a different PR head.');
        if (observation.baseSha && stub.payload.baseSha && stub.payload.baseSha !== observation.baseSha) return stop('blocked', 'Stub result belongs to a different PR base.');
        if (definition.repair && stub.payload.outcome !== 'candidate') {
          success = false;
          failureReason = String(stub.payload.reason ?? 'Repair made no candidate.');
          control.repairSuppression = { evidenceDigest: observation.evidenceDigest ?? digest(canonicalJson(observation)), reason: failureReason };
        }
        if (action.uses === 'agent.classify') {
          control.memory = { ...control.memory, classificationCurrent: true };
          control.classification = { uncertain: stub.payload.uncertain as boolean };
          const names = (stub.payload.labels as { name: string }[]).map(label => label.name);
          if (new Set(names).size !== names.length || names.some(name => !workflow.labels.includes(name))) fail('classification_labels', `/results/${actionId}/payload/labels`, 'Classification labels must be unique and allowed by the workflow.');
        }
        if (action.uses === 'agent.review') {
          control.memory = { ...control.memory, reviewCurrent: true };
          control.review = { coverage: stub.payload.coverage, verdict: stub.payload.verdict } as NonNullable<ControlState['review']>;
        }
      }
    }
    if (!success) failureReason ??= stub.reason ?? `${actionId} failed.`;
    result.actions.push({ actionId, uses: action.uses, status: success ? 'success' : 'failure', reason: success ? 'Used the supplied successful result.' : failureReason! });
    if (success && definition.produces) {
      const revision = definition.produces === 'review' || definition.produces === 'classification' ? `${observation.headSha}:${observation.baseSha}` :
        definition.produces === 'candidate' ? (stub.payload as { candidateSha: string }).candidateSha : inputs.get('candidate')!;
      inputs.set(definition.produces, revision);
    }
    const next = success ? action.onSuccess : action.onFailure;
    if (next === '$wait') return stop('waiting', failureReason ?? 'The action chain is waiting for an external signal.');
    if (next === '$blocked') return stop('blocked', failureReason ?? 'The action chain requested an operational block.');
    if (next === '$closed') return stop('blocked', 'Only the close control action can finish a confirmed closed lifecycle.');
    if (next === '$observe') {
      observationIndex++;
      if (!fixture.observations[observationIndex]) return stop('needs_observation', 'Supply another observation to continue after $observe.');
      const previous = observation;
      observation = fixture.observations[observationIndex]!;
      if (previous.headSha !== observation.headSha || previous.baseSha !== observation.baseSha) control.memory = { ...control.memory, classificationCurrent: false, reviewCurrent: false, packetCurrent: false };
      inputs.clear(); failureReason = undefined; actionId = '';
    } else actionId = next;
  }
  return stop('blocked', 'Replay step budget is exhausted.');
}
