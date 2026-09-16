import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type WorkflowPackage } from '@repo-chap/workflow';
import { conditionalPush, githubPushTransport, githubRefReader, inspectPullRequest, prepareCaptureDirectory, readPushTarget, reconcilePush,
  type GitHubReader, type PushReceipt, type PushRequest, type PushTransport, type Inspection } from '@repo-chap/github';
import { restoreCandidate, validateTestedCandidate } from '@repo-chap/execution';
import { applyPolicyDigest, requireApplyPolicy, RuntimeError, type Claim, type RuntimeStore } from '@repo-chap/runtime';
import { profileDigest } from './worker.js';
import type { DaemonDependencies } from './service.js';

export async function dispatchCandidatePush(store: RuntimeStore, claim: Claim, actionId: string, pkg: WorkflowPackage, dependencies: DaemonDependencies,
  reader: () => GitHubReader, now: () => number, signal: AbortSignal): Promise<void> {
  const run = store.run(claim.runId), saved = run.repair, repo = store.repository(run.repositoryId), action = pkg.workflow.actions[actionId]!;
  if (!saved?.checksCurrent) throw new RuntimeError('Push requires the current candidate and validated required checks.');
  const result = await store.readRepair(saved.result), inspection = await store.artifacts.get<Inspection>(saved.job.inspection), pr = inspection.evidence.pullRequest!;
  if (!result.candidate) throw new RuntimeError('The retained repair has no candidate.');
  const request: PushRequest = { schemaVersion: 1, repositoryId: repo.id, repository: repo.name, pullRequestId: run.subjectId, number: run.number,
    targetRef: `refs/heads/${pr.headRef}`, expectedHeadSha: saved.job.headSha, baseSha: saved.job.baseSha, candidateSha: result.candidate.sha, tree: result.candidate.tree, parents: result.candidate.parents };
  const payload = await store.artifacts.put(request), id = store.planEffect(claim, { kind: 'github.push_candidate', destination: `${repo.name}:${request.targetRef}`,
    evidenceKey: saved.job.evidenceKey, expectedRevision: request.expectedHeadSha, payload }, now());
  store.bindPush(claim, id, actionId, now());
  const park = (status: 'blocked' | 'waiting' | 'ready', reason: string, due: number | null, next = actionId) => store.park(claim, status, reason, due, run.control, next, now());
  const effect = store.effects(run.id).find(value => value.id === id)!;
  if (effect.state === 'confirmed') { park('ready', 'The tested commit is confirmed. Refresh current PR evidence.', now(), action.onSuccess); return; }
  if (['sending', 'unknown'].includes(effect.state)) { park('blocked', 'Push outcome is unknown or still sending. Inspect its receipt; reconciliation must finish before another write.', null); return; }
  if (effect.state === 'rejected' && !(effect.receipt as PushReceipt | null)?.retryable) { park('blocked', (effect.receipt as PushReceipt | null)?.reason ?? 'The planned push was rejected as stale. Inspect current evidence.', null); return; }
  await dependencies.onPlannedEffect?.(effect);
  if (dependencies.planOnly) { park('waiting', 'Planned push retained locally. Run apply without --plan to authorize dispatch using the current private policy.', now()); return; }
  const authorize = async () => {
    const policy = requireApplyPolicy(await dependencies.applyPolicy?.(repo.name) ?? null, repo.name, ['pr.push', 'checks.run']);
    const profile = await dependencies.profile(repo.profile), current = store.run(run.id);
    if (!policy.execution || applyPolicyDigest(policy) !== saved.job.applyPolicyDigest || profileDigest(profile) !== saved.job.profileDigest ||
      !action.capabilities.every(cap => profile.maximumCapabilities.includes(cap)) || !pkg.workflow.requestedCapabilities.includes('pr.push') ||
      current.repair?.result.digest !== saved.result.digest || !current.repair.checksCurrent || current.evidenceKey !== saved.job.evidenceKey ||
      !store.pushBudgetCurrent(run.id, pkg, policy, now())) throw new RuntimeError('The retained push no longer has current policy, ownership, required checks or remaining limits.');
    validateTestedCandidate(result, policy.execution); return policy;
  };
  const policy = await authorize();
  const root = await prepareCaptureDirectory(join(dependencies.directory, 'workers')), checkout = await mkdtemp(join(root, 'push-'));
  try {
    await restoreCandidate(join(dependencies.directory, 'repairs'), saved.result, checkout);
    const transport = dependencies.pushTransport ? await dependencies.pushTransport(repo.name, checkout, signal) :
      githubPushTransport(repo.name, checkout, await requiredCredentials(dependencies, repo.name), signal);
    const lease = store.beginEffect(claim, id, policy.maxPushAttempts, now());
    park('waiting', 'Sending the retained tested commit to the PR branch.', now() + store.limits.pollSeconds * 1000);
    const receipt = await conditionalPush(request, { transport,
      readTarget: async () => {
        const fresh = await inspectPullRequest(reader(), pkg, { repository: repo.name, pr: run.number, reviewers: repo.reviewers, previous: inspection });
        if (fresh.status !== 'complete' || fresh.evidenceDigest !== inspection.evidenceDigest) throw new RuntimeError('PR evidence changed before push.');
        return readPushTarget(reader(), repo.name, run.number);
      },
      authorize: async () => { await authorize(); return store.effectCurrent(lease, now()) && !signal.aborted; },
    });
    if (receipt.status === 'unknown') receipt.reconcileAfter = now();
    if (store.finishEffect(lease, receipt.status, receipt, now())) store.wakeAfterEffect(id, now(),
      receipt.status === 'rejected' && receipt.retryable && receipt.observedSha === null ? now() + store.limits.pollSeconds * 1000 : now());
  } finally { await rm(checkout, { recursive: true, force: true }); }
}
async function requiredCredentials(dependencies: DaemonDependencies, repository: string) {
  if (!dependencies.pushCredentials) throw new RuntimeError('Conditional push requires explicitly scoped contents-write credentials.');
  return dependencies.pushCredentials(repository);
}
export async function reconcilePendingPushes(store: RuntimeStore, dependencies: DaemonDependencies, now: () => number, signal: AbortSignal): Promise<void> {
  if (store.cooldown() > now()) return;
  for (const run of store.runs()) for (const effect of store.effects(run.id)) {
    const target = dependencies.target;
    if (target && (run.number !== target.number || store.repository(run.repositoryId).name.toLowerCase() !== target.repository.toLowerCase())) continue;
    if (effect.kind !== 'github.push_candidate' || effect.state !== 'unknown' || ((effect.receipt as PushReceipt | null)?.reconcileAfter ?? 0) > now()) continue;
    let directory: string | undefined;
    try {
      const request = await store.artifacts.get<PushRequest>(effect.payload);
      const root = await prepareCaptureDirectory(join(dependencies.directory, 'workers')); directory = await mkdtemp(join(root, 'reconcile-'));
      const transport: Pick<PushTransport, 'repository' | 'readRef'> = dependencies.pushTransport ? await dependencies.pushTransport(request.repository, directory, signal) : githubRefReader(request.repository, directory, dependencies.credentials, signal);
      const receipt = await reconcilePush(request, transport);
      if (receipt.status === 'unknown') receipt.reconcileAfter = now() + store.limits.pollSeconds * 1000;
      if (store.reconcileEffect(effect.id, receipt.status, receipt, now()) && receipt.status !== 'unknown') store.wakeAfterEffect(effect.id, now());
    } catch {
      store.reconcileEffect(effect.id, 'unknown', { reason: 'Cannot read the retained request or prepare ref reconciliation. Inspect private artifacts and access.', retryable: false, reconcileAfter: now() + store.limits.pollSeconds * 1000 }, now());
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }
}
