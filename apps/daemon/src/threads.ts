import type { WorkflowPackage } from '@repo-chap/workflow';
import { GitHubReader, githubThreadTransport, inspectPullRequest, readThreadTarget, reconcileThread, resolveThread, threadContentDigest,
  type Inspection, type PushReceipt, type PushRequest, type ThreadReceipt, type ThreadResolutionRequest } from '@repo-chap/github';
import { validateTestedCandidate } from '@repo-chap/execution';
import { applyPolicyDigest, requireApplyPolicy, RuntimeError, type Claim, type EffectRecord, type RuntimeStore, type ThreadConcern } from '@repo-chap/runtime';
import { profileDigest } from './worker.js';
import type { DaemonDependencies } from './service.js';

const kind = 'github.resolve_eligible_threads';
function effectConcern(concern: ThreadConcern, effect: EffectRecord | undefined): ThreadConcern {
  if (!effect) return concern;
  const receipt = effect.receipt as ThreadReceipt | null;
  return { ...concern, state: receipt?.evidenceCurrent === false ? 'stale' : effect.state === 'planned' ? 'eligible' : effect.state === 'sending' ? 'unknown' : effect.state,
    reason: receipt?.reason ?? (effect.state === 'rejected' ? 'Observation or ownership changed before resolution. The retained request was not resent.' : 'Thread resolution is planned or awaiting reconciliation.'),
    remoteResolved: receipt?.remoteResolved ?? null, evidenceCurrent: receipt?.evidenceCurrent ?? null };
}
export async function threadResolutionSummary(store: RuntimeStore, runId: string) {
  const run = store.run(runId), saved = run.threadResolution;
  if (!saved) return null;
  const effects = store.effects(runId), push = effects.find(effect => effect.id === saved.pushEffectId), inspection = await store.artifacts.get<Inspection>(run.inspection);
  const concerns = saved.concerns.map(concern => effectConcern(concern, effects.find(effect => effect.id === concern.effectId)));
  for (const concern of concerns) {
    if (!run.evidenceAvailable || inspection.status !== 'complete') {
      concern.state = 'unknown'; concern.evidenceCurrent = null; concern.remoteResolved = null;
      concern.reason = 'Current PR evidence is unavailable or incomplete. Earlier receipts remain recorded; inspect after access recovers.'; continue;
    }
    if (!concern.effectId) {
      if (Date.parse(inspection.fixture.now) < (saved.observedAt ?? 0)) continue;
      const thread = inspection.evidence.threads.items.find(thread => thread.id === concern.threadId);
      concern.remoteResolved = thread?.resolved ?? null; concern.evidenceCurrent = null;
      if (!thread) { concern.state = 'unknown'; concern.reason = 'The latest observation cannot find this concern. The original repair disposition remains recorded.'; }
      else if (thread.resolved) concern.reason += ' The latest observation shows this thread resolved; the retained repair disposition is historical.';
      continue;
    }
    const effect = effects.find(value => value.id === concern.effectId)!, attempt = store.effectAttempts(effect.id).at(-1);
    if (!attempt?.finishedAt || Date.parse(inspection.fixture.now) < attempt.finishedAt) continue;
    const request = await store.artifacts.get<ThreadResolutionRequest>(effect.payload), thread = inspection.evidence.threads.items.find(thread => thread.id === concern.threadId);
    const unchanged = inspection.evidence.pullRequest?.headSha === request.push.candidateSha && thread && threadContentDigest(thread) === request.threadDigest;
    if (!unchanged || concern.remoteResolved === true && !thread?.resolved) {
      concern.state = 'stale'; concern.evidenceCurrent = false; concern.remoteResolved = thread?.resolved ?? null;
      concern.reason = !thread ? 'The latest observation cannot find this thread. Inspect its retained receipt.' :
        !unchanged ? 'A later observation changed the PR head or concern. The earlier resolution receipt does not address the current evidence.' :
          'The thread was reopened after its resolution receipt. The current concern remains open and will not be resolved again automatically.';
    }
  }
  for (const thread of inspection.evidence.threads.items) if (!thread.resolved && !concerns.some(concern => concern.threadId === thread.id)) concerns.push({
    threadId: thread.id, disposition: 'unrelated', effectId: null, state: run.evidenceAvailable && inspection.status === 'complete' ? 'skipped' : 'unknown',
    reason: 'This concern has no verified addressed decision for the pushed candidate.', remoteResolved: run.evidenceAvailable && inspection.status === 'complete' ? false : null, evidenceCurrent: null,
  });
  const confirmed = push?.state === 'confirmed';
  return { schemaVersion: 1, candidateSha: saved.repair.candidateSha, pushEffectId: saved.pushEffectId, pushConfirmed: confirmed,
    pushReceipt: push?.receipt ?? null, concerns, remainingConcerns: concerns.filter(concern => concern.remoteResolved !== true || concern.evidenceCurrent === false) };
}

export async function dispatchThreadResolutions(store: RuntimeStore, claim: Claim, actionId: string, pkg: WorkflowPackage,
  dependencies: DaemonDependencies, reader: () => GitHubReader, now: () => number, signal: AbortSignal): Promise<void> {
  const run = store.run(claim.runId), saved = run.threadResolution, repo = store.repository(run.repositoryId), action = pkg.workflow.actions[actionId]!;
  if (!saved || saved.actionId !== actionId || saved.packageDigest !== pkg.digest) throw new RuntimeError('Thread resolution requires the current retained post-push repair.');
  const pushEffect = store.effects(run.id).find(effect => effect.id === saved.pushEffectId);
  if (pushEffect?.state !== 'confirmed') throw new RuntimeError('Thread resolution requires a confirmed push receipt.');
  const push = await store.artifacts.get<PushRequest>(pushEffect.payload), result = await store.readRepair(saved.repair.result),
    capture = await store.artifacts.get<Inspection>(saved.repair.job.inspection);
  validateTestedCandidate(result, saved.repair.job.policy);
  if (result.payload?.outcome !== 'candidate' || result.candidate?.sha !== push.candidateSha || push.expectedHeadSha !== saved.repair.job.headSha ||
    push.repositoryId !== repo.id || push.pullRequestId !== run.subjectId || result.packageDigest !== pkg.digest)
    throw new RuntimeError('The retained push and final host repair result do not identify the same candidate.');
  const authorize = async () => {
    const policy = requireApplyPolicy(await dependencies.applyPolicy?.(repo.name) ?? null, repo.name, ['review.resolve']);
    const profile = await dependencies.profile(repo.profile), current = store.run(run.id);
    return applyPolicyDigest(policy) === saved.repair.job.applyPolicyDigest && profileDigest(profile) === saved.repair.job.profileDigest &&
      action.capabilities.every(cap => profile.maximumCapabilities.includes(cap) && pkg.workflow.requestedCapabilities.includes(cap)) &&
      current.threadResolution?.pushEffectId === saved.pushEffectId && current.packageDigest === saved.packageDigest &&
      store.effects(run.id).some(effect => effect.id === saved.pushEffectId && effect.state === 'confirmed') &&
      store.pushBudgetCurrent(run.id, pkg, policy, now()) && !signal.aborted;
  };
  const latest = await inspectPullRequest(reader(), pkg, { repository: repo.name, pr: run.number, reviewers: repo.reviewers });
  const decisions = result.payload.threads, concerns: ThreadConcern[] = [];
  for (const thread of capture.evidence.threads.items.filter(thread => !thread.resolved)) {
    const matching = decisions.filter(decision => decision.threadId === thread.id), decision = matching.length === 1 ? matching[0] : undefined;
    const prior = saved.concerns.find(concern => concern.threadId === thread.id);
    const concern: ThreadConcern = { threadId: thread.id, disposition: decision?.disposition ?? 'blocked', effectId: prior?.effectId ?? null,
      state: 'skipped', reason: decision?.response ?? 'The final repair has no unique decision for this concern.',
      remoteResolved: latest.evidence.threads.items.find(current => current.id === thread.id)?.resolved ?? null, evidenceCurrent: null };
    concerns.push(concern);
    if (decision?.disposition !== 'addressed' || !decision.evidenceRefs.length) continue;
    const request: ThreadResolutionRequest = { schemaVersion: 1, pushEffectId: pushEffect.id, push, threadId: thread.id, threadDigest: threadContentDigest(thread), disposition: 'addressed' };
    const payload = await store.artifacts.put(request);
    const id = store.planEffect(claim, { kind, destination: `${repo.name}:${run.number}:${thread.id}`, expectedRevision: push.candidateSha, evidenceKey: run.evidenceKey, payload }, now());
    concern.effectId = id; concern.state = 'eligible'; concern.reason = 'Addressed by the confirmed tested candidate; current thread verification is required before sending.';
  }
  for (const thread of latest.evidence.threads.items) if (!thread.resolved && !concerns.some(concern => concern.threadId === thread.id)) concerns.push({
    threadId: thread.id, disposition: 'unrelated', effectId: null, state: 'skipped', reason: 'This concern was not in the final repair decisions. It remains open.', remoteResolved: false, evidenceCurrent: null,
  });
  store.recordThreadConcerns(claim, concerns, false, now());
  const park = (reason: string, status: 'blocked' | 'waiting' | 'ready', next: string, due: number | null) =>
    store.park(claim, status, reason, due, store.run(run.id).control, next, now());
  if (latest.status !== 'complete') { park('Current thread collection is incomplete. Retained repair and per-thread plans remain available; retry after GitHub access recovers.', 'waiting', actionId, now() + store.limits.pollSeconds * 1000); return; }
  let retryAt: number | null = null;
  for (const concern of concerns) {
    if (!concern.effectId || !store.isCurrent(claim, now())) continue;
    let effect = store.effects(run.id).find(value => value.id === concern.effectId)!;
    if (effect.state === 'confirmed' || effect.state === 'unknown' || effect.state === 'sending' || effect.state === 'rejected' && !(effect.receipt as ThreadReceipt | null)?.retryable) continue;
    await dependencies.onPlannedEffect?.(effect);
    if (dependencies.planOnly) continue;
    let authorized = false;
    try { authorized = await authorize(); } catch { /* Keep all concerns visible when private authority is missing. */ }
    if (!authorized) {
      const receipt: ThreadReceipt = { status: 'rejected', threadId: concern.threadId, candidateSha: push.candidateSha, remoteResolved: false, evidenceCurrent: null,
        observedHeadSha: null, observedThreadDigest: null, retryable: false, reason: 'Current policy, provider permissions or retained limits do not authorize resolution. The concern remains open.' };
      if (effect.state === 'planned') store.transitionEffect(claim, effect.id, 'planned', 'rejected', receipt, now());
      continue;
    }
    const lease = store.beginEffect(claim, effect.id, store.limits.maxRetries + 1, now());
    const request = await store.artifacts.get<ThreadResolutionRequest>(effect.payload);
    let receipt: ThreadReceipt;
    try {
      if (!dependencies.threadTransport && !dependencies.threadCredentials) throw new RuntimeError('Thread resolution requires explicit pull-request write credentials.');
      const credentials = dependencies.threadTransport ? undefined : await dependencies.threadCredentials!(repo.name);
      const transport = dependencies.threadTransport ? await dependencies.threadTransport(repo.name, signal) :
        githubThreadTransport(repo.name, credentials!, { fetch: dependencies.readOptions?.fetch, signal, now,
          cooldown: { read: () => store.cooldown(), extend: until => { store.cooldown(until); } } });
      receipt = await resolveThread(request, { pushReceipt: pushEffect.receipt as PushReceipt, transport,
        readTarget: () => readThreadTarget(credentials ? new GitHubReader(credentials, { ...dependencies.readOptions, signal, now,
          cooldown: { read: () => store.cooldown(), extend: until => { store.cooldown(until); } } }) : reader(), concern.threadId),
        authorize: async () => await authorize() && store.effectCurrent(lease, now()) });
    } catch {
      receipt = { status: 'rejected', threadId: concern.threadId, candidateSha: push.candidateSha, remoteResolved: null, evidenceCurrent: null,
        observedHeadSha: null, observedThreadDigest: null, retryable: true, reason: 'Cannot prepare explicit write credentials. No thread resolution was sent; the repair remains retained.' };
    }
    if (receipt.status === 'unknown') receipt.reconcileAfter = now() + store.limits.pollSeconds * 1000;
    if (receipt.retryable) retryAt = now() + store.limits.pollSeconds * 1000;
    store.finishEffect(lease, receipt.status, receipt, now());
    effect = store.effects(run.id).find(value => value.id === concern.effectId)!; Object.assign(concern, effectConcern(concern, effect));
  }
  if (!store.isCurrent(claim, now())) return;
  const outcomes = concerns.map(concern => effectConcern(concern, store.effects(run.id).find(effect => effect.id === concern.effectId)));
  const pending = outcomes.some(concern => ['eligible', 'unknown'].includes(concern.state));
  const remaining = outcomes.filter(concern => concern.remoteResolved !== true || concern.evidenceCurrent === false);
  store.recordThreadConcerns(claim, outcomes, !pending && retryAt === null, now(), remaining.length ? action.onFailure : action.onSuccess);
  if (dependencies.planOnly && pending) { park('Per-thread resolution plans retained locally. Run apply without --plan to dispatch under the private policy.', 'waiting', actionId, now()); return; }
  if (pending || retryAt !== null) { park('Some thread outcomes are pending or unknown. Inspect the individual receipts; the tested repair will be reused.', 'waiting', actionId, retryAt ?? now() + store.limits.pollSeconds * 1000); return; }
  park(`Pushed ${push.candidateSha}. ${outcomes.length - remaining.length} thread concerns confirmed resolved; ${remaining.length} concerns still need attention. Inspect each reason.`, 'ready', remaining.length ? action.onFailure : action.onSuccess, now());
}

export async function reconcilePendingThreads(store: RuntimeStore, dependencies: DaemonDependencies, reader: () => GitHubReader, now: () => number): Promise<void> {
  if (store.cooldown() > now()) return;
  for (const run of store.runs()) for (const effect of store.effects(run.id)) {
    const target = dependencies.target;
    if (target && (run.number !== target.number || store.repository(run.repositoryId).name.toLowerCase() !== target.repository.toLowerCase())) continue;
    if (effect.kind !== kind || effect.state !== 'unknown' || ((effect.receipt as ThreadReceipt | null)?.reconcileAfter ?? 0) > now()) continue;
    try {
      const request = await store.artifacts.get<ThreadResolutionRequest>(effect.payload);
      const receipt = await reconcileThread(request, () => readThreadTarget(reader(), request.threadId));
      if (receipt.status === 'unknown') receipt.reconcileAfter = now() + store.limits.pollSeconds * 1000;
      if (store.reconcileEffect(effect.id, receipt.status, receipt, now()) && receipt.status !== 'unknown') store.wakeAfterEffect(effect.id, now());
    } catch {
      store.reconcileEffect(effect.id, 'unknown', { reason: 'Cannot read the retained thread request. Inspect private artifacts; no resolution was retried.',
        retryable: false, reconcileAfter: now() + store.limits.pollSeconds * 1000 }, now());
    }
  }
}
