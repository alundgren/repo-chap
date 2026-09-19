import type { CheckEvidence, Evidence } from './inspect.js';

export function checkOutcome(check: CheckEvidence): 'passed' | 'failed' | 'pending' | 'unknown' {
  if (check.kind === 'StatusContext') {
    if (check.status === 'SUCCESS') return 'passed';
    if (['FAILURE', 'ERROR'].includes(check.status)) return 'failed';
    return check.status === 'PENDING' ? 'pending' : 'unknown';
  }
  if (['QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'PENDING'].includes(check.status)) return 'pending';
  if (check.status !== 'COMPLETED') return 'unknown';
  if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion ?? '')) return 'passed';
  if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(check.conclusion ?? '')) return 'failed';
  return 'unknown';
}

export function ciFacts(evidence: Evidence): { ciFailed: boolean | null; ciPending: boolean | null } {
  if (!evidence.pullRequest || evidence.metadata.status !== 'complete' || evidence.revision.status !== 'stable' ||
    evidence.revision.headSha !== evidence.pullRequest.headSha || evidence.checks.coverage.status !== 'complete' || !evidence.checks.items.length)
    return { ciFailed: null, ciPending: null };
  const outcomes = evidence.checks.items.map(checkOutcome);
  return {
    ciFailed: outcomes.includes('failed') ? true : outcomes.includes('unknown') ? null : false,
    ciPending: outcomes.includes('pending') ? true : outcomes.includes('unknown') ? null : false,
  };
}
