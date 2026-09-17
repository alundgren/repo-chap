import { canonicalJson, digest, type WorkflowPackage } from '@repo-chap/workflow';
import { GitHubPublicationClient, PublicationRemoteError, inspectPullRequest, publishReview, setClassificationLabels,
  type GitHubReader, type Inspection, type Publication, type PublicationReceipt, type PublicationRemote, type PublicationTarget } from '@repo-chap/github';
import type { SourceBundle } from '@repo-chap/providers';
import { prepareLabelPublication, prepareReviewPublication, requireApplyPolicy, RuntimeError, type Claim, type RuntimeStore } from '@repo-chap/runtime';
import type { DaemonDependencies } from './service.js';

function remoteFor(store: RuntimeStore, dependencies: DaemonDependencies, now: () => number, signal: AbortSignal): PublicationRemote {
  return dependencies.publicationRemote?.(signal) ?? new GitHubPublicationClient(dependencies.credentials, {
    fetch: dependencies.readOptions?.fetch, now, signal,
    cooldown: { read: () => store.cooldown(), extend: until => { store.cooldown(until); } }, writeCredentials: dependencies.publicationCredentials,
  });
}
function refreshAfterPublication(store: RuntimeStore, runId: string, reason: string, now: number): void {
  const run = store.run(runId);
  store.unavailable(run.id, reason, now); store.pollFinished(run.repositoryId, now, null);
}
function rejectedReceipt(kind: Publication['kind'], target: PublicationTarget, marker: string, reason: string): PublicationReceipt {
  return { schemaVersion: 1, kind, marker, outcome: 'rejected', freshness: 'current', reason, expectedHeadSha: target.headSha, observedHeadSha: target.headSha,
    expectedBaseSha: target.baseSha, observedBaseSha: target.baseSha, remote: null, reobserve: false, retryable: false };
}

export async function dispatchPublication(store: RuntimeStore, claim: Claim, actionId: string, pkg: WorkflowPackage, dependencies: DaemonDependencies,
  reader: () => GitHubReader, now: () => number, signal: AbortSignal): Promise<void> {
  const run = store.run(claim.runId), repo = store.repository(run.repositoryId), action = pkg.workflow.actions[actionId]!;
  const kind = action.uses === 'github.publish_review' ? 'review.publish' : 'labels.set';
  let publication: Publication, inspection: Inspection;
  try {
    const saved = await store.currentAnalysis(run.id, kind === 'review.publish' ? 'agent.review' : 'agent.classify');
    inspection = await store.artifacts.get<Inspection>(saved.result.job.inspection);
    const input = { run, result: saved.result, package: pkg, inspection, sources: await store.artifacts.get<SourceBundle>(saved.result.job.sources) };
    publication = kind === 'review.publish' ? prepareReviewPublication(input) : prepareLabelPublication(input);
  } catch (error) {
    if (!store.isCurrent(claim, now())) return;
    const reason = error instanceof RuntimeError ? error.message : 'The retained publication inputs failed validation. Inspect the complete local analysis.';
    const target: PublicationTarget = { repository: repo.name, repositoryId: repo.id, pullRequestId: run.subjectId, number: run.number, headSha: run.headSha!, baseSha: run.baseSha! };
    const marker = `<!-- repo-chap:${kind}:${digest(canonicalJson({ runId: run.id, target, evidenceKey: run.evidenceKey, reason })).slice(7)} -->`;
    const payload = await store.artifacts.put({ schemaVersion: 1, kind, target, marker, rejection: reason });
    const id = store.planEffect(claim, { kind, destination: `${repo.name}#${run.number}`, evidenceKey: run.evidenceKey, expectedRevision: run.headSha!, payload }, now());
    store.transitionEffect(claim, id, 'planned', 'rejected', rejectedReceipt(kind, target, marker, reason), now());
    store.continuePublication(claim, actionId, action.onFailure, reason, false, now()); return;
  }
  const payload = await store.artifacts.put(publication);
  const id = store.planEffect(claim, { kind, destination: `${repo.name}#${run.number}`, evidenceKey: run.evidenceKey, expectedRevision: run.headSha!, payload }, now());
  store.bindPublication(claim, id, actionId, now());
  const effect = store.effects(run.id).find(value => value.id === id)!, prior = effect.receipt as PublicationReceipt | null;
  if (effect.state === 'confirmed') {
    if (prior?.freshness === 'stale') { refreshAfterPublication(store, run.id, prior.reason, now()); return; }
    if (prior?.freshness === 'unverified') {
      store.park(claim, 'waiting', prior.reason, prior.reconcileAfter ?? now() + store.limits.pollSeconds * 1000, run.control, actionId, now()); return;
    }
    store.continuePublication(claim, actionId, action.onSuccess, prior?.reason ?? 'Publication is already confirmed.', true, now()); return;
  }
  if (['sending', 'unknown'].includes(effect.state)) {
    store.park(claim, 'blocked', 'Publication is still sending or has an unknown result. Reconciliation must finish before another write.', null, run.control, actionId, now()); return;
  }
  if (effect.state === 'rejected' && !prior?.retryable) {
    store.continuePublication(claim, actionId, action.onFailure, prior?.reason ?? 'Publication was rejected after its inputs changed.', false, now()); return;
  }
  await dependencies.onPlannedEffect?.(effect);
  if (dependencies.planOnly) {
    store.park(claim, 'waiting', 'Publication plan retained locally. Run apply without --plan to send within the current policy.', now(), run.control, actionId, now()); return;
  }
  const authorized = async (): Promise<boolean> => {
    const policy = await dependencies.applyPolicy?.(repo.name) ?? null;
    try { requireApplyPolicy(policy, repo.name, [kind]); } catch { return false; }
    const profile = await dependencies.profile(repo.profile);
    return profile.maximumCapabilities.includes(kind) && action.capabilities.includes(kind) && pkg.workflow.requestedCapabilities.includes(kind) && !signal.aborted;
  };
  if (!await authorized()) throw new RuntimeError(`The current private policy or provider capability ceiling does not authorize ${kind}. The plan remains local.`);
  const lease = store.beginEffect(claim, id, Math.min(100, store.limits.maxRetries + 1), now());
  store.park(claim, 'waiting', 'Reconciling and publishing validated analysis.', now() + store.limits.pollSeconds * 1000, run.control, actionId, now());
  let inputsChanged = false;
  const dispatch = { phase: 'planned' as const, authorize: authorized, beforeSend: async () => {
    if (!store.effectCurrent(lease, now()) || signal.aborted) return false;
    let fresh: Inspection;
    try { fresh = await inspectPullRequest(reader(), pkg, { repository: repo.name, pr: run.number, reviewers: repo.reviewers, previous: inspection }); }
    catch { throw new PublicationRemoteError('rejected', 'Current PR evidence could not be read before publication. Retry the retained result after refreshing access.', true); }
    if (fresh.status !== 'complete') throw new PublicationRemoteError('rejected', 'Current PR evidence is incomplete. Retry the retained publication after a complete read.', true);
    if (!await store.publicationEvidenceCurrent(run.id, run.evidenceKey, fresh)) { inputsChanged = true; throw new PublicationRemoteError('rejected', 'PR evidence changed before publication. Reobserve before using the retained analysis.'); }
    const permitted = await authorized();
    return permitted && !signal.aborted && store.effectCurrent(lease, now());
  } };
  let receipt: PublicationReceipt;
  try {
    const remote = remoteFor(store, dependencies, now, signal);
    receipt = publication.kind === 'review.publish' ? await publishReview(publication, remote, dispatch) : await setClassificationLabels(publication, remote, dispatch);
  } catch {
    receipt = { ...rejectedReceipt(kind, publication.target, publication.marker, 'Publication could not prepare its remote reads or authorization. Retry the retained result after checking access.'), freshness: 'unverified', retryable: true };
  }
  if (inputsChanged) { receipt.freshness = 'stale'; receipt.reobserve = true; }
  if (receipt.outcome === 'unknown' || receipt.freshness === 'unverified') receipt.reconcileAfter = now() + store.limits.pollSeconds * 1000;
  if (store.finishEffect(lease, receipt.outcome, receipt, now())) {
    if (receipt.freshness === 'stale' && !receipt.retryable) refreshAfterPublication(store, run.id, receipt.reason, now());
    else store.wakeAfterEffect(id, now(), receipt.retryable ? now() + store.limits.pollSeconds * 1000 : now());
  }
}

export async function reconcilePendingPublications(store: RuntimeStore, dependencies: DaemonDependencies, now: () => number, signal: AbortSignal): Promise<void> {
  if (store.cooldown() > now()) return;
  for (const run of store.runs()) for (const effect of store.effects(run.id)) {
    const target = dependencies.target;
    if (target && (target.number !== run.number || store.repository(run.repositoryId).name.toLowerCase() !== target.repository.toLowerCase())) continue;
    const prior = effect.receipt as PublicationReceipt | null;
    if (!['review.publish', 'labels.set'].includes(effect.kind) || !(effect.state === 'unknown' || effect.state === 'confirmed' && prior?.freshness === 'unverified') || (prior?.reconcileAfter ?? 0) > now()) continue;
    try {
      const publication = await store.artifacts.get<Publication>(effect.payload), remote = remoteFor(store, dependencies, now, signal);
      const dispatch = { phase: 'unknown' as const, authorize: async () => false, beforeSend: async () => false };
      let receipt = publication.kind === 'review.publish' ? await publishReview(publication, remote, dispatch) : await setClassificationLabels(publication, remote, dispatch);
      if (effect.state === 'confirmed' && receipt.outcome !== 'confirmed') receipt = { ...prior!, reason: receipt.reason, freshness: 'unverified', reobserve: true };
      if (receipt.outcome === 'unknown' || receipt.freshness === 'unverified') receipt.reconcileAfter = now() + store.limits.pollSeconds * 1000;
      const recorded = effect.state === 'confirmed' ? store.refreshPublicationReceipt(effect.id, receipt) : store.reconcileEffect(effect.id, receipt.outcome, receipt, now());
      if (recorded && receipt.outcome !== 'unknown') {
        const current = store.run(run.id);
        if (receipt.freshness === 'stale' && current.evidenceKey === effect.evidenceKey && !['cancelled', 'closed'].includes(current.status)) refreshAfterPublication(store, run.id, receipt.reason, now());
        else store.wakeAfterEffect(effect.id, now(), receipt.freshness === 'unverified' ? receipt.reconcileAfter! : now());
      }
    } catch {
      const failed = { ...(effect.receipt ?? {}), reason: 'Cannot read the retained publication request or reconcile its outcome. Inspect private artifacts and GitHub access.',
        retryable: false, reconcileAfter: now() + store.limits.pollSeconds * 1000 };
      if (effect.state === 'confirmed') store.refreshPublicationReceipt(effect.id, failed as PublicationReceipt);
      else store.reconcileEffect(effect.id, 'unknown', failed, now());
    }
  }
}
