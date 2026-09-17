import { currentFacts } from './evaluate.js';
import type { ControlState, Observation, Workflow } from './types.js';

export interface ControlDecision {
  status: 'waiting' | 'closed' | 'blocked' | 'needs_observation';
  reason: string; nextWakeAt: string | null; refreshAttempts?: number;
}
export function controlDecision(workflow: Workflow, uses: string, observation: Observation, control: ControlState, clock: string): ControlDecision | undefined {
  const now = Date.parse(clock), facts = currentFacts(workflow, observation, clock);
  const stop = (status: ControlDecision['status'], reason: string, wake: number | null = null): ControlDecision => ({ status, reason, nextWakeAt: wake === null ? null : new Date(wake).toISOString() });
  if (uses === 'control.close') return facts.lifecycle === 'closed' || facts.lifecycle === 'merged'
    ? stop('closed', 'The observed PR is closed.') : stop('blocked', 'Closure requires an observation that confirms closed or merged.');
  if (!uses.startsWith('control.wait_')) return undefined;
  let wake = now + workflow.settings.reviewWaitSeconds * 1000;
  let reason = 'Wait for an external signal or periodic reconciliation.';
  if (uses === 'control.wait_refresh') return {
    ...stop('waiting', 'Required evidence is incomplete; refresh after bounded backoff.', now + Math.min(300, 5 * 2 ** Math.min(control.refreshAttempts ?? 0, 6)) * 1000),
    refreshAttempts: (control.refreshAttempts ?? 0) + 1,
  };
  if (uses === 'control.wait_debounce') {
    if ((facts.young && !observation.createdAt) || (facts.headDebouncing && !observation.headChangedAt)) return stop('blocked', 'Debounce requires createdAt and headChangedAt for the active delay.');
    wake = Math.max(now, observation.createdAt ? Date.parse(observation.createdAt) + workflow.settings.newPrDelaySeconds * 1000 : now, observation.headChangedAt ? Date.parse(observation.headChangedAt) + workflow.settings.headDebounceSeconds * 1000 : now);
    if (wake <= now) return stop('needs_observation', 'Debounce deadlines have passed; refresh the observation.');
    reason = 'Wait until both the PR age and head debounce deadlines pass.';
  }
  if (uses === 'control.wait_reviewer') {
    if (!observation.externalReviewStartedAt) return stop('blocked', 'Reviewer wait requires externalReviewStartedAt so its deadline cannot restart.');
    const deadline = Date.parse(observation.externalReviewStartedAt) + workflow.settings.reviewDeadlineSeconds * 1000;
    if (deadline <= now) return stop('needs_observation', 'Reviewer deadline has passed; refresh without the expired wait hint.');
    wake = Math.min(wake, deadline); reason = 'Wait for the next reviewer poll or the fixed reviewer deadline.';
  }
  return stop('waiting', reason, wake);
}
