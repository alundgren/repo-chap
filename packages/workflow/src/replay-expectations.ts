import { canonicalJson } from './common.js';
import type { ReplayComparison, ReplayExpectation, ReplayResult } from './types.js';

/** Compare only declared expectations, while retaining the full replay as separate evidence. */
export function compareReplay(result: ReplayResult, expected: ReplayExpectation): ReplayComparison {
  const actual: ReplayExpectation = {
    status: result.status,
    selectedRuleIds: result.decisions.map(decision => decision.ruleId),
    proposedEffects: result.proposedEffects.map(({ actionId, uses, outcome }) => ({ actionId, uses, ...(outcome ? { outcome } : {}) })),
  };
  const checks = (Object.keys(actual) as (keyof ReplayExpectation)[]).map(field => ({
    field, expected: structuredClone(expected[field]), actual: actual[field],
    passed: canonicalJson(expected[field]) === canonicalJson(actual[field]),
  }));
  return { passed: !['needs_result', 'needs_observation'].includes(result.status) && checks.every(check => check.passed), checks };
}
