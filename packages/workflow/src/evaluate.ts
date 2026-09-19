import { factTypes, type Condition, type ConditionTrace, type ControlState, type Decision, type Facts, type Memory, type Observation, type Workflow } from './types.js';

export function evaluateCondition(condition: Condition, facts: Facts, memory: Memory): ConditionTrace {
  if ('field' in condition) {
    const [group, name] = condition.field.split('.') as [string, string];
    const source = group === 'facts' ? facts : memory;
    const value: unknown = Object.hasOwn(source, name) ? (source as Record<string, unknown>)[name] : undefined;
    if (value == null || typeof value !== typeof condition.value) return { value: 'unknown', reason: `${condition.field} is unknown.` };
    const matches = condition.op === 'eq' ? value === condition.value : value !== condition.value;
    return { value: matches, reason: `${condition.field} is ${JSON.stringify(value)}; ${condition.op} ${JSON.stringify(condition.value)} is ${matches}.` };
  }
  if ('not' in condition) {
    const child = evaluateCondition(condition.not, facts, memory);
    return { value: child.value === 'unknown' ? 'unknown' : !child.value, reason: 'Negation preserves unknown values.', children: [child] };
  }
  const all = 'all' in condition;
  const children = (all ? condition.all : condition.any).map(child => evaluateCondition(child, facts, memory));
  const values = children.map(child => child.value);
  const value = all ? (values.includes(false) ? false : values.includes('unknown') ? 'unknown' : true) : (values.includes(true) ? true : values.includes('unknown') ? 'unknown' : false);
  return { value, reason: all ? 'Every condition must be true.' : 'At least one condition must be true.', children };
}
export function currentFacts(workflow: Workflow, observation: Observation, now: string): Facts {
  const facts = { ...observation.facts };
  const time = Date.parse(now);
  if (observation.createdAt) facts.young = time < Date.parse(observation.createdAt) + workflow.settings.newPrDelaySeconds * 1000;
  if (observation.headChangedAt) facts.headDebouncing = time < Date.parse(observation.headChangedAt) + workflow.settings.headDebounceSeconds * 1000;
  if (observation.externalReviewStartedAt && time >= Date.parse(observation.externalReviewStartedAt) + workflow.settings.reviewDeadlineSeconds * 1000) facts.externalReviewPending = false;
  return facts;
}
export function currentMemory(control: ControlState, observation: Observation): Memory {
  const memory: Memory = { repairSuppressed: false, ...control.memory };
  if (control.repairSuppression) memory.repairSuppressed = observation.evidenceDigest ? control.repairSuppression.evidenceDigest === observation.evidenceDigest : null;
  return memory;
}
// CI results are optional in older captures and are checked separately for CI repair and merge readiness.
export function hasCompleteEvidence(facts: Facts): boolean {
  return facts.evidenceComplete === true && Object.entries(factTypes).filter(([key]) => key !== 'ciFailed' && key !== 'ciPending').every(([key, type]) => typeof (facts as Record<string, unknown>)[key] === type);
}
export function evaluate(workflow: Workflow, observation: Observation, control: ControlState, now: string): Decision {
  const facts = currentFacts(workflow, observation, now);
  const memory = currentMemory(control, observation);
  const rules: Decision['rules'] = [];
  for (const rule of workflow.rules) {
    const condition = evaluateCondition(rule.when, facts, memory);
    rules.push({ id: rule.id, selected: condition.value === true, condition });
    if (condition.value === true) return { actionId: rule.action, ruleId: rule.id, rules };
  }
  return { actionId: workflow.otherwise, ruleId: null, rules };
}
