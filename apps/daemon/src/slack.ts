import { randomUUID } from 'node:crypto';
import { SlackApi } from '@repo-chap/slack/web-api';
import type { DecisionPacket, PacketPreview } from '@repo-chap/slack';
import type { AnalysisResult, RuntimeStore, RunRecord } from '@repo-chap/runtime';
import { currentFacts, hasCompleteEvidence, type WorkflowPackage } from '@repo-chap/workflow';
import type { Inspection } from '@repo-chap/github';

export async function packetForRun(store: RuntimeStore, run: RunRecord, pkg: WorkflowPackage, inspection: Inspection, now: number): Promise<DecisionPacket> {
  const facts = currentFacts(pkg.workflow, inspection.fixture.observations[0]!, new Date(now).toISOString());
  const completed: AnalysisResult[] = [];
  for (const entry of store.inspect(run.id).notes as { artifact: Parameters<typeof store.artifacts.get>[0] }[]) {
    const result = await store.artifacts.get<AnalysisResult>(entry.artifact);
    if (result.job.evidenceKey === run.evidenceKey) completed.push(result);
  }
  const review = completed.findLast(result => pkg.workflow.actions[result.job.actionId]?.uses === 'agent.review' && result.provider.outcome === 'completed')?.provider.payload as { summary: string; findings: { severity: string; title: string; reason: string }[]; missingEvidence: string[] } | undefined;
  const failed = completed.filter(result => result.provider.outcome !== 'completed');
  const uncertainty = [...(review?.missingEvidence ?? []), ...(!hasCompleteEvidence(facts) ? ['Current PR evidence is incomplete.'] : []), ...(run.control.classification?.uncertain !== false ? ['Classification is missing or uncertain.'] : [])];
  const checks = inspection.evidence.checks.items.map(check => ({ name: check.name, status: (check.status !== 'COMPLETED' && check.kind === 'CheckRun' || check.status === 'PENDING') ? 'pending' as const : ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion ?? check.status) ? 'passed' as const : 'failed' as const, evidence: `GitHub ${check.kind}: ${check.conclusion ?? check.status}.` }));
  const ready = hasCompleteEvidence(facts) && facts.lifecycle === 'open' && facts.draft === false && facts.conflict === false && facts.unaddressedReview === false && run.control.memory?.reviewCurrent === true && run.control.memory?.classificationCurrent === true && run.control.review?.coverage === 'complete' && run.control.review.verdict === 'acceptable' && run.control.classification?.uncertain === false && checks.length > 0 && checks.every(check => check.status === 'passed') && !failed.length;
  const outcome = !hasCompleteEvidence(facts) || failed.length ? 'blocked_execution' : facts.conflict === true ? 'needs_author' : facts.unaddressedReview === true || run.control.review?.verdict === 'concerns' || run.control.review?.verdict === 'blocking' ? 'needs_team' : ready ? 'ready_for_human_merge' : 'blocked_execution';
  const reason = outcome === 'ready_for_human_merge' ? review?.summary ?? 'Current complete review is acceptable.' : outcome === 'needs_author' ? 'The PR has a conflict that needs the author.' : outcome === 'needs_team' ? review?.summary ?? 'Unresolved review concerns need a team decision.' : failed.at(-1)?.provider.diagnostic ?? 'Current evidence does not establish a ready handoff.';
  const decisions = { ready_for_human_merge: 'Review the current GitHub checks and changes. Merge on GitHub if the evidence is sufficient.', needs_author: 'Resolve the conflict or explain the intended change on the pull request.', needs_team: 'Decide how to address the remaining concerns on the pull request.', blocked_execution: 'Inspect the local run evidence and resolve the execution or access problem before retrying.' };
  if (!checks.length) uncertainty.push('No GitHub check results were recorded. Confirm required checks before merging.');
  return { schemaVersion: 1, repository: store.repository(run.repositoryId).name, prNumber: run.number, headSha: run.headSha!, authorLogin: inspection.evidence.pullRequest?.author ?? null, outcome, reason, recommendedDecision: decisions[outcome], findings: review?.findings.map(finding => `${finding.severity}: ${finding.title}. ${finding.reason}`) ?? [], attemptedFixes: [], checks, uncertainty, evidenceLinks: [] };
}

export async function deliverSlack(store: RuntimeStore, api: SlackApi, now: () => number, signal: AbortSignal, permitted: (run: RunRecord) => Promise<boolean>): Promise<void> {
  store.slack.recover(now()); store.slack.supersedeStale(now());
  for (const pending of store.slack.pending(now())) {
    if (signal.aborted) return;
    let owner: string | null = null;
    try {
      const request = store.slack.request(pending.requestId), run = store.run(pending.runId);
      if (store.repository(run.repositoryId).paused) continue;
      if (!await permitted(run)) { store.slack.prepare(pending.id, { status: 'rejected', reason: 'Current operator permissions do not allow Slack delivery. The complete request stays in the CLI inbox.' }, now()); continue; }
      const preview = await store.artifacts.get<PacketPreview>(pending.operation === 'supersede' ? request.supersededPreview : request.preview);
      if (preview.route.workspaceId !== api.workspaceId || !preview.route.destination) { store.slack.prepare(pending.id, { status: 'rejected', reason: 'No configured Slack destination matches this installation. The complete request stays in the CLI inbox.' }, now()); continue; }
      const verified = await api.verify(signal);
      if (verified.status !== 'confirmed') { store.slack.prepare(pending.id, verified, now()); continue; }
      const destination = preview.route.destination;
      let channel = pending.channelId ?? (destination.kind === 'channel' ? destination.channelId : store.slack.dm(api.workspaceId, destination.memberId));
      if (!channel && destination.kind === 'dm') {
        const opened = await api.openDm(destination.memberId, signal);
        if (opened.status !== 'confirmed') { store.slack.prepare(pending.id, opened, now()); continue; }
        channel = opened.value; store.slack.dm(api.workspaceId, destination.memberId, channel);
      }
      if (!channel) continue;
      if (!await permitted(store.run(pending.runId))) { store.slack.prepare(pending.id, { status: 'rejected', reason: 'Slack permission changed during preparation. The complete request stays in the CLI inbox.' }, now()); continue; }
      owner = randomUUID();
      const attempt = store.slack.begin(pending.id, channel, owner, now());
      if (!attempt) continue;
      const result = await api.send(channel, preview.message, attempt.timestamp ?? undefined, signal);
      store.slack.finish(pending.id, owner, result, now());
    } catch {
      const current = store.slack.delivery(pending.id);
      if (current.state === 'sending' && owner) store.slack.finish(pending.id, owner, { status: 'unknown', reason: 'Slack delivery stopped without a saved outcome. Reconcile the receipt before resending.' }, now());
      else if (current.state === 'planned') store.slack.prepare(pending.id, { status: 'rejected', reason: 'Slack delivery could not read its private configuration or packet. Fix the input, then explicitly retry this delivery from the inbox.' }, now());
    }
  }
}
