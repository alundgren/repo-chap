import { summarizePublications, type AnalysisResult, type RepairAttemptResult, type RuntimeStore, type RunRecord } from '@repo-chap/runtime';
import { currentFacts, hasCompleteEvidence, type WorkflowPackage } from '@repo-chap/workflow';
import { checkOutcome, ciFacts, type Inspection, type PushReceipt } from '@repo-chap/github';
import type { DecisionPacket } from '@repo-chap/slack';
import { threadResolutionSummary } from './threads.js';

type Citation = { path: string; side: string; startLine: number; endLine: number; explanation: string };
const citations = (items: Citation[] = []) => items.map(item => `${item.side} ${item.path}:${item.startLine}-${item.endLine}: ${item.explanation}`).join('; ');
type Review = { summary: string; coverage: string; verdict: string; findings: { severity: string; title: string; reason: string; evidence?: Citation[] }[]; missingEvidence: string[] };
type Classification = { uncertain: boolean; labels: { name: string; reason: string; evidence?: Citation[] }[] };
type FailedRepair = { job: RepairAttemptResult['job']; status: string; diagnostic: string };

/** Read accepted host artifacts; the browser renderer receives only the resulting serializable packet. */
export async function packetForRun(store: RuntimeStore, run: RunRecord, pkg: WorkflowPackage, inspection: Inspection, now: number): Promise<DecisionPacket> {
  const facts = currentFacts(pkg.workflow, inspection.fixture.observations[0]!, new Date(now).toISOString());
  const history: (AnalysisResult | RepairAttemptResult | FailedRepair)[] = [];
  for (const entry of store.inspect(run.id).notes as { artifact: Parameters<typeof store.artifacts.get>[0] }[]) history.push(await store.artifacts.get(entry.artifact));
  const accepted = async (uses: 'agent.review' | 'agent.classify') => {
    if (!run.evidenceAvailable || run.control.memory?.[uses === 'agent.review' ? 'reviewCurrent' : 'classificationCurrent'] !== true) return undefined;
    const { result } = await store.currentAnalysis(run.id, uses);
    return result.job.headSha === run.headSha ? result : undefined;
  };
  const currentReview = await accepted('agent.review'), classification = (await accepted('agent.classify'))?.provider.payload as Classification | undefined;
  const review = currentReview?.provider.payload as Review | undefined;
  const retainedReview = currentReview ?? history.findLast((result): result is AnalysisResult => 'provider' in result && result.provider.outcome === 'completed' && pkg.workflow.actions[result.job.actionId]?.uses === 'agent.review');
  const reviewPayload = retainedReview?.provider.payload as Review | undefined;
  const findings = reviewPayload?.findings.map(finding => `${currentReview ? '' : `Historical review at ${retainedReview!.job.headSha}: `}${finding.severity}: ${finding.title}. ${finding.reason}${finding.evidence?.length ? ` Evidence: ${citations(finding.evidence)}.` : ''}`) ?? [];
  const uncertainty = [...(review?.missingEvidence ?? [])];
  if (!run.evidenceAvailable || !hasCompleteEvidence(facts)) uncertainty.push('Current PR evidence is incomplete.');
  if (!review) uncertainty.push('No accepted review matches the current package, evidence and head.');
  else if (review.coverage !== 'complete' || review.verdict === 'inconclusive') uncertainty.push(`Current review is ${review.coverage} with verdict ${review.verdict}.`);
  if (!classification || classification.uncertain) uncertainty.push('Current classification is missing or uncertain.');
  if (classification) for (const label of classification.labels) findings.push(`Classification${classification.uncertain ? ' (uncertain)' : ''}: ${label.name}. ${label.reason}${label.evidence?.length ? ` Evidence: ${citations(label.evidence)}.` : ''}`);
  const attemptedFixes: string[] = [], checks: DecisionPacket['checks'] = [], evidenceLinks: DecisionPacket['evidenceLinks'] = [];
  for (const entry of history) {
    if ('repair' in entry) {
      const result = entry.repair, candidate = result.candidate?.sha;
      attemptedFixes.push(`Repair from ${entry.job.headSha}: ${result.status}. ${result.payload?.outcome === 'candidate' ? result.payload.summary : result.payload?.reason ?? result.diagnostic}${candidate ? ` Candidate ${candidate}; required checks ${result.requiredChecksPassed ? 'passed' : 'did not pass'}.` : ' No candidate retained.'}`);
      if (result.payload?.outcome === 'candidate') attemptedFixes.push(`Candidate ${candidate}: changed ${result.payload.changedPaths.join(', ')}. This artifact alone does not prove a push.`);
      for (const thread of result.payload?.threads ?? []) findings.push(`Repair disposition for thread ${thread.threadId}: ${thread.disposition}. ${thread.response}${thread.evidenceRefs.length ? ` Evidence: ${thread.evidenceRefs.join(', ')}.` : ''}`);
      for (const check of result.checks) checks.push({ name: `Candidate ${check.id}`, status: check.status === 'passed' ? 'passed' : check.status === 'skipped' ? 'not_run' : 'failed', evidence: `Retained check on ${check.candidateSha}${check.candidateSha === run.headSha ? ' (current head)' : ' (historical candidate)'}: ${check.status}. ${check.diagnostic}${check.log ? ` Log artifact ${check.log.id}.` : ''}` });
    } else if (!('provider' in entry)) attemptedFixes.push(`Repair from ${entry.job.headSha}: ${entry.status}. ${entry.diagnostic}`);
  }
  const effects = store.effects(run.id);
  for (const effect of effects.filter(effect => effect.kind === 'github.push_candidate')) {
    const receipt = effect.receipt as PushReceipt | null;
    attemptedFixes.push(`Conditional push: ${effect.state}. ${receipt ? `Candidate ${receipt.candidateSha}; observed ${receipt.observedSha ?? 'unavailable'}. ${receipt.reason}` : `Expected head ${effect.expectedRevision}; no remote receipt.`}`);
    if (effect.state === 'unknown' || effect.state === 'sending') uncertainty.push('A conditional push has an unknown remote outcome. Inspect its retained receipt before another repair.');
    if (receipt?.status === 'confirmed') evidenceLinks.push({ label: 'Confirmed pushed candidate', url: `https://github.com/${receipt.repository}/commit/${receipt.candidateSha}` });
  }
  const threads = await threadResolutionSummary(store, run.id);
  if (threads) {
    for (const concern of threads.concerns) findings.push(`Thread ${concern.threadId}: ${concern.disposition}; resolution ${concern.state}; remote ${concern.remoteResolved === null ? 'unknown' : concern.remoteResolved ? 'resolved' : 'open'}; evidence ${concern.evidenceCurrent === null ? 'unverified' : concern.evidenceCurrent ? 'current' : 'stale'}. ${concern.reason}`);
    if (threads.remainingConcerns.length) uncertainty.push(`${threads.remainingConcerns.length} retained thread concern(s) still need attention, including any stale evidence on remotely resolved threads.`);
  }
  const publications = summarizePublications(run, effects);
  for (const publication of publications) {
    const receipt = publication.receipt;
    findings.push(`${publication.kind === 'review.publish' ? 'Review publication' : 'Label publication'} ${publication.effectId}: ${publication.state}; current freshness ${publication.freshness}. ${receipt?.reason ?? 'No acceptance receipt.'}${receipt?.analysis ? ` Published review: ${receipt.analysis.coverage}, ${receipt.analysis.verdict}.` : ''}${receipt ? ` Receipt at ${receipt.expectedHeadSha}: ${receipt.outcome}, historically ${receipt.freshness}.` : ''}`);
    if (receipt?.remote) evidenceLinks.push({ label: 'Published review', url: receipt.remote.url });
    if (publication.state !== 'confirmed' || publication.freshness !== 'current') uncertainty.push(`Publication ${publication.effectId} is ${publication.state} with ${publication.freshness} current evidence; historical acceptance does not establish current success.`);
  }
  const currentFailures = Object.entries(run.failedActions).filter(([, evidence]) => evidence === run.evidenceKey).map(([action]) => action);
  for (const action of currentFailures) {
    const failure = history.findLast(entry => entry.job.actionId === action && entry.job.evidenceKey === run.evidenceKey);
    uncertainty.push(`Action ${action} failed for current evidence.${failure && 'provider' in failure ? ` ${failure.provider.diagnostic}` : failure && 'repair' in failure ? ` ${failure.repair.diagnostic}` : ''}`);
  }
  const githubChecks: DecisionPacket['checks'] = inspection.evidence.checks.items.map(check => {
    const outcome = checkOutcome(check);
    return { name: check.name, status: outcome === 'unknown' ? 'not_run' : outcome,
      evidence: `GitHub ${check.kind} captured on ${run.headSha}: ${check.conclusion ?? check.status}.` };
  });
  checks.unshift(...githubChecks);
  if (!githubChecks.length) uncertainty.push('No current GitHub check results were recorded. Confirm required checks before merging.');
  const publicationBlocked = publications.some(publication => effects.find(effect => effect.id === publication.effectId)!.evidenceKey === run.evidenceKey && (publication.state !== 'confirmed' || publication.freshness !== 'current'));
  const blocked = !run.evidenceAvailable || !hasCompleteEvidence(facts) || currentFailures.length > 0 || publicationBlocked || facts.lifecycle !== 'open' || facts.draft !== false || facts.externalReviewPending !== false || facts.young !== false || facts.headDebouncing !== false;
  const unresolvedPush = effects.some(effect => effect.kind === 'github.push_candidate' && ['sending', 'unknown'].includes(effect.state));
  const ci = ciFacts(inspection.evidence);
  if (ci.ciPending === true) uncertainty.push('GitHub CI checks are still running. Wait for their results.');
  if (ci.ciFailed === null || ci.ciPending === null) uncertainty.push('Current GitHub CI results are unknown. Refresh check evidence before a merge handoff.');
  const ready = ci.ciFailed === false && ci.ciPending === false && !blocked && !unresolvedPush && facts.conflict === false && facts.unaddressedReview === false && !threads?.remainingConcerns.length && review?.coverage === 'complete' && review.verdict === 'acceptable' && classification?.uncertain === false && githubChecks.length > 0 && githubChecks.every(check => check.status === 'passed');
  const outcome = blocked ? 'blocked_execution' : facts.conflict === true || ci.ciFailed === true ? 'needs_author' : facts.unaddressedReview === true || threads?.remainingConcerns.length || review?.verdict === 'concerns' || review?.verdict === 'blocking' ? 'needs_team' : ready ? 'ready_for_human_merge' : 'blocked_execution';
  const reason = outcome === 'ready_for_human_merge' ? review!.summary : outcome === 'needs_author' ? ci.ciFailed === true ? 'The PR has failed CI checks that need the author.' : 'The PR has a conflict that needs the author.' : outcome === 'needs_team' ? review?.summary ?? 'Retained review concerns need a team decision.' : currentFailures.length ? `Current action failed: ${currentFailures.join(', ')}. ${run.reason}` : publicationBlocked ? 'Publication has not completed with current evidence. Inspect each retained outcome.' : 'Current evidence does not establish a ready handoff.';
  const decisions = { ready_for_human_merge: 'Review the current GitHub checks and changes. Merge on GitHub if the evidence is sufficient.', needs_author: 'Resolve the conflict or failed CI checks, or explain the intended change on the pull request.', needs_team: 'Decide how to address the remaining concerns on the pull request.', blocked_execution: 'Inspect the local run evidence and resolve the execution or access problem before retrying.' };
  return { schemaVersion: 1, repository: store.repository(run.repositoryId).name, prNumber: run.number, headSha: run.headSha!, authorLogin: inspection.evidence.pullRequest?.author ?? null, outcome, reason, recommendedDecision: decisions[outcome], findings, attemptedFixes, checks, uncertainty, evidenceLinks };
}
