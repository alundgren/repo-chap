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
  const inputs = new Set<string>();
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
    if (definition.requires && !inputs.has(definition.requires)) return stop('blocked', `${actionId} requires a successful ${definition.requires} result in this action chain.`);
    if (action.uses === 'control.close') {
      if (facts.lifecycle !== 'closed' && facts.lifecycle !== 'merged') return stop('blocked', 'Closure requires an observation that confirms closed or merged.');
      result.actions.push({ actionId, uses: action.uses, status: 'simulated', reason: 'Observed lifecycle is closed.' });
      return stop('closed', 'The observed PR is closed.');
    }
    if (action.uses.startsWith('control.wait_')) {
      let wake = now + workflow.settings.reviewWaitSeconds * 1000;
      let reason = 'Wait for an external signal or periodic reconciliation.';
      if (action.uses === 'control.wait_refresh') {
        wake = now + Math.min(300, 5 * 2 ** Math.min(control.refreshAttempts ?? 0, 6)) * 1000;
        control.refreshAttempts = (control.refreshAttempts ?? 0) + 1;
        reason = 'Required evidence is incomplete; refresh after bounded backoff.';
      }
      if (action.uses === 'control.wait_debounce') {
        if ((facts.young && !observation.createdAt) || (facts.headDebouncing && !observation.headChangedAt)) return stop('blocked', 'Debounce requires createdAt and headChangedAt for the active delay.');
        wake = Math.max(now, observation.createdAt ? Date.parse(observation.createdAt) + workflow.settings.newPrDelaySeconds * 1000 : now, observation.headChangedAt ? Date.parse(observation.headChangedAt) + workflow.settings.headDebounceSeconds * 1000 : now);
        if (wake <= now) return stop('needs_observation', 'Debounce deadlines have passed; refresh the observation.');
        reason = 'Wait until both the PR age and head debounce deadlines pass.';
      }
      if (action.uses === 'control.wait_reviewer') {
        if (!observation.externalReviewStartedAt) return stop('blocked', 'Reviewer wait requires externalReviewStartedAt so its deadline cannot restart.');
        const deadline = Date.parse(observation.externalReviewStartedAt) + workflow.settings.reviewDeadlineSeconds * 1000;
        if (deadline <= now) return stop('needs_observation', 'Reviewer deadline has passed; refresh without the expired wait hint.');
        wake = Math.min(wake, deadline); reason = 'Wait for the next reviewer poll or the fixed reviewer deadline.';
      }
      result.actions.push({ actionId, uses: action.uses, status: 'simulated', reason });
      return stop('waiting', reason, wake);
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
    result.proposedEffects.push({ actionId, uses: action.uses, capabilities: [...action.capabilities], ...(outcome ? { outcome, destination: workflow.slack?.routes[outcome] ?? 'unconfigured' } : {}), reason });
    const index = used[actionId] ?? 0;
    const stub = fixture.results?.[actionId]?.[index];
    if (!stub) return stop('needs_result', `Supply fixture.results.${actionId}[${index}] to continue the proposed action.`);
    used[actionId] = index + 1;
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
    if (success && definition.produces) inputs.add(definition.produces);
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
