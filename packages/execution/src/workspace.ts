import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { ciFacts, prepareCaptureDirectory, type Inspection } from '@repo-chap/github';
import { buildPackage, canonicalJson, digest, parseFixture, validateActionPayload, WorkflowError, type WorkflowPackage } from '@repo-chap/workflow';
import { collectSources, runProcess, runProvider, validateProfile, type ProviderProfile, type SourceBundle } from '@repo-chap/providers';
import { artifactLimit, putArtifact, putJson, readArtifact, readRepairResult } from './artifacts.js';
import { ExecutionError, permittedPath, validatePolicy } from './policy.js';
import { ExecutionFailure, git, gitEnvironment, gitProcess, initializeCheckout } from './git.js';
import type { ArtifactRef, Candidate, CheckReceipt, ExecutionPolicy, RepairJob, RepairResult, RepairStop, ReviewEvidence, ThreadDecision } from './types.js';

const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
export const profileDigest = (profile: ProviderProfile) => digest(canonicalJson(profile));
export function createRepairJob(pkg: WorkflowPackage, inspection: Inspection, profile: ProviderProfile, policy: ExecutionPolicy, actionId: string, identity: {
  runId?: string; attemptId?: string; ownershipToken?: string; deadline?: string; review?: ReviewEvidence;
} = {}): RepairJob {
  const pr = inspection.evidence.pullRequest, repository = inspection.evidence.repository;
  if (!pr || !repository) throw new ExecutionError('Repair needs captured PR and repository identities. Inspect again.');
  const job: RepairJob = { schemaVersion: 1, runId: identity.runId ?? randomUUID(), attemptId: identity.attemptId ?? randomUUID(), ownershipToken: identity.ownershipToken ?? randomUUID(),
    deadline: identity.deadline ?? new Date(Date.now() + pkg.workflow.limits.maxAttemptSeconds * 1000).toISOString(),
    repositoryId: repository.id, pullRequestId: pr.id, headSha: pr.headSha, baseSha: pr.baseSha, package: structuredClone(pkg), inspection: structuredClone(inspection), actionId,
    ...(identity.review ? { review: structuredClone(identity.review) } : {}),
    profile: profile.name, profileDigest: profileDigest(profile), policy: structuredClone(policy), policyDigest: digest(canonicalJson(policy)) };
  validateJob(job, profile); return job;
}
function validateJob(job: RepairJob, profile: ProviderProfile): void {
  validateProfile(profile); validatePolicy(job.policy);
  if (job.schemaVersion !== 1 || ![job.runId, job.attemptId, job.ownershipToken].every(id => typeof id === 'string' && idPattern.test(id)) ||
    ![job.headSha, job.baseSha].every(sha => /^[a-f0-9]{40}$/.test(sha)) || !Number.isFinite(Date.parse(job.deadline))) throw new ExecutionError('Repair jobs require version 1, stable IDs, full commit IDs and an absolute deadline.');
  const pkg = buildPackage(job.package.workflowPath, Object.fromEntries(job.package.files.map(file => [file.path, file.text])), { maximumCapabilities: profile.maximumCapabilities });
  if (pkg.digest !== job.package.digest || canonicalJson(pkg) !== canonicalJson(job.package) || job.profile !== profile.name || job.profileDigest !== profileDigest(profile) || job.policyDigest !== digest(canonicalJson(job.policy)))
    throw new ExecutionError('Repair package, profile or execution policy changed after the job was pinned.');
  const inspection = job.inspection, pr = inspection.evidence.pullRequest;
  const fixture = parseFixture(inspection.fixture), observation = fixture.observations[0];
  if (inspection.schemaVersion !== 1 || inspection.packageDigest !== pkg.digest || inspection.evidenceDigest !== digest(canonicalJson(inspection.evidence)) ||
    job.repositoryId !== inspection.evidence.repository?.id || job.pullRequestId !== pr?.id || job.headSha !== pr?.headSha || job.baseSha !== pr?.baseSha ||
    fixture.observations.length !== 1 || observation?.evidenceDigest !== inspection.evidenceDigest || observation.headSha !== job.headSha || observation.baseSha !== job.baseSha)
    throw new ExecutionError('Repair capture identities or digests do not match the job.');
  if (job.review) {
    const review = job.review;
    if (review.packageDigest !== pkg.digest || review.evidenceDigest !== inspection.evidenceDigest || review.headSha !== job.headSha || review.baseSha !== job.baseSha ||
        pkg.workflow.actions[review.actionId]?.uses !== 'agent.review') throw new ExecutionError('Review evidence does not match the pinned repair inputs.');
    validateActionPayload(pkg, review.actionId, review.payload);
    const payload = review.payload as { headSha: string; baseSha: string };
    if (payload.headSha !== job.headSha || payload.baseSha !== job.baseSha) throw new ExecutionError('Review payload belongs to another revision.');
  }
  const action = pkg.workflow.actions[job.actionId];
  if (!action || !['agent.resolve_conflict', 'agent.address_review', 'agent.fix_ci'].includes(action.uses) || !action.capabilities.includes('workspace.write') ||
    !pkg.workflow.requestedCapabilities.includes('checks.run') || !profile.maximumCapabilities.includes('checks.run')) throw new ExecutionError('Choose a repair action and permit host-owned checks.run in the workflow and operator profile.');
}
interface RepairOptions {
  sourceRepository: string; artifactDirectory: string; profile: ProviderProfile; signal?: AbortSignal;
  isCurrent?: (job: RepairJob) => boolean | Promise<boolean>;
  maximumProviderAttempts?: number;
}
const actionableReview = (job: RepairJob): boolean => {
  const review = job.review?.payload as { coverage: string; verdict: string; findings: unknown[] } | undefined;
  return !!review && review.coverage === 'complete' && ['concerns', 'blocking'].includes(review.verdict) && review.findings.length > 0;
};
const unresolvedThreads = (job: RepairJob) => job.inspection.evidence.threads.items.filter(thread => !thread.resolved);
function verifyThreads(job: RepairJob, payload: Candidate | RepairStop, source: SourceBundle): void {
  const expected = unresolvedThreads(job), seen = new Set<string>();
  const refs = new Set([`evidence:${job.inspection.evidenceDigest}`, `source:${source.digest}`, ...expected.map(thread => `thread:${thread.id}`)]);
  for (const thread of payload.threads) {
    if (seen.has(thread.threadId) || !expected.some(item => item.id === thread.threadId) || thread.evidenceRefs.some(ref => !refs.has(ref)) || thread.disposition === 'addressed' && !thread.evidenceRefs.length)
      throw new ExecutionFailure('invalid_output', 'Repair thread decisions must refer once to captured unresolved threads and supplied evidence references.');
    if (payload.outcome !== 'candidate' && thread.disposition === 'addressed') throw new ExecutionFailure('invalid_output', 'A blocked or no-change repair cannot claim an addressed thread.');
    seen.add(thread.threadId);
  }
  if (expected.some(thread => !seen.has(thread.id))) throw new ExecutionFailure('invalid_output', 'Repair omitted a captured unresolved thread decision.');
}
async function changedPaths(checkout: string, head: string, deadline: number, signal: AbortSignal): Promise<string[]> {
  const text = await git(checkout, ['diff', '--cached', '--name-only', '-z', '--no-renames', head, '--'], deadline, signal);
  return text.split('\0').filter(Boolean).sort();
}
async function verifyUnchanged(checkout: string, sha: string, tree: string, deadline: number, signal: AbortSignal): Promise<boolean> {
  return await git(checkout, ['rev-parse', 'HEAD'], deadline, signal) === sha &&
    await git(checkout, ['write-tree'], deadline, signal) === tree &&
    await git(checkout, ['status', '--porcelain', '--untracked-files=all'], deadline, signal) === '';
}
export async function runRepair(input: RepairJob, options: RepairOptions): Promise<{ result: RepairResult; reference: ArtifactRef }> {
  const job = structuredClone(input), profile = structuredClone(options.profile);
  validateJob(job, profile);
  const root = await prepareCaptureDirectory(options.artifactDirectory), jobRef = await putJson(root, 'job', job);
  const receiptPath = join(root, `attempt-${job.attemptId}.json`);
  try { await writeFile(receiptPath, canonicalJson({ schemaVersion: 1, state: 'running', job: jobRef }), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ExecutionError('This attempt already exists. Read its saved receipt; do not execute it twice.'); throw error; }
  const result: RepairResult = { schemaVersion: 1, runId: job.runId, attemptId: job.attemptId, ownershipToken: job.ownershipToken, deadline: job.deadline,
    repositoryId: job.repositoryId, pullRequestId: job.pullRequestId, headSha: job.headSha, baseSha: job.baseSha, packageDigest: job.package.digest,
    policyDigest: job.policyDigest, profileDigest: job.profileDigest, evidenceDigest: job.inspection.evidenceDigest, fixtureDigest: digest(canonicalJson(job.inspection.fixture)), job: jobRef,
    status: 'blocked', startedAt: new Date().toISOString(), finishedAt: '', diagnostic: 'Repair did not complete.', requiredChecksPassed: false, checks: [] };
  const controller = new AbortController(), deadline = Math.min(Date.parse(job.deadline), Date.now() + job.package.workflow.limits.maxAttemptSeconds * 1000);
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort('deadline'), Math.max(0, deadline - Date.now()));
  let worker: string | undefined;
  const current = async () => {
    if (Date.now() >= deadline || controller.signal.reason === 'deadline') throw new ExecutionFailure('timeout', 'The repair deadline expired; child processes were stopped.');
    if (controller.signal.aborted) throw new ExecutionFailure(controller.signal.reason === 'superseded' ? 'superseded' : 'cancelled', 'Repair was cancelled; child processes were stopped.');
    if (options.isCurrent && !await options.isCurrent(job)) { controller.abort('superseded'); throw new ExecutionFailure('superseded', 'The repair no longer owns its pinned inputs. Its result cannot be applied.'); }
  };
  try {
    await current();
    const inspection = job.inspection, evidence = inspection.evidence, pr = evidence.pullRequest!;
    if (inspection.status !== 'complete' || evidence.revision.status !== 'stable' || evidence.revision.headSha !== job.headSha || evidence.revision.baseSha !== job.baseSha || pr.lifecycle !== 'open' || pr.draft ||
      evidence.metadata.status !== 'complete' || ['labels', 'checks', 'reviews', 'threads', 'reviewerActivity'].some(key => evidence[key as 'threads'].coverage.status !== 'complete') ||
      unresolvedThreads(job).some(thread => thread.comments.coverage.status !== 'complete'))
      throw new ExecutionFailure('blocked', 'Repair requires complete evidence for an open, non-draft PR at stable captured head and base revisions. Inspect again.');
    const uses = job.package.workflow.actions[job.actionId]!.uses;
    const conflict = uses === 'agent.resolve_conflict', ci = uses === 'agent.fix_ci';
    const checks = ciFacts(evidence);
    if (ci && (checks.ciFailed !== true || checks.ciPending !== false)) throw new ExecutionFailure('blocked', 'CI repair requires a confirmed failure on the captured head and no pending or unknown checks.');
    if (conflict ? pr.mergeability !== 'conflicting' : !ci && !unresolvedThreads(job).length && !actionableReview(job)) throw new ExecutionFailure('blocked', 'Select a confirmed conflict, captured unresolved review threads, or current actionable review findings before starting repair.');
    const repository = await realpath(options.sourceRepository);
    if (!(await lstat(repository)).isDirectory() || !relative(repository, root).startsWith('..')) throw new ExecutionFailure('blocked', 'Keep execution artifacts outside the source repository.');
    const source = await collectSources(repository, job.headSha, job.baseSha, controller.signal); await current();
    result.source = await putJson(root, 'source', source);
    if (!source.comparisonBaseSha || !source.diff) throw new ExecutionFailure('blocked', 'Pinned Git objects or their common ancestor are missing. Fetch captured commits locally and start a new attempt.');
    worker = await mkdtemp(join(root, 'worker-')); const checkout = join(worker, 'checkout'); await mkdir(checkout, { mode: 0o700 });
    await initializeCheckout(checkout, repository, job.headSha, job.baseSha, deadline, controller.signal);
    let conflicts: string[] = [];
    if (conflict) {
      const merge = await gitProcess(checkout, ['merge', '--no-commit', '--no-ff', job.baseSha], deadline, controller.signal);
      await current();
      conflicts = (await git(checkout, ['diff', '--name-only', '--diff-filter=U', '-z'], deadline, controller.signal)).split('\0').filter(Boolean);
      if (merge.status !== 'exited' || merge.exitCode !== 1 || !conflicts.length) throw new ExecutionFailure('blocked', 'The pinned commits do not reproduce the captured conflict. Inspect again before repair.');
    }
    const evidenceRefs = [`evidence:${inspection.evidenceDigest}`, `source:${source.digest}`, ...unresolvedThreads(job).map(thread => `thread:${thread.id}`)];
    const providerEvidence = { ...evidence, ...(job.review ? { review: job.review } : {}), workspace: { expectedHeadSha: job.headSha, baseSha: job.baseSha, conflictingPaths: conflicts,
      allowedPaths: job.policy.allowedPaths, excludedPaths: job.policy.excludedPaths, requiredChecks: job.policy.requiredChecks.map(check => check.id), evidenceRefs,
      instructions: (ci ? 'Diagnose the captured failed CI checks using the pinned source and local reproduction. Check names, statuses and URLs are supplied; remote failure logs are not. Do not claim to have read unavailable logs. Return blocked when the cause cannot be established locally, or requires credentials, infrastructure changes or a rerun rather than repository edits. Do not weaken checks to make them pass. ' : '') + 'Address supplied review findings as well as unresolved threads. Review findings are local evidence, not GitHub threads; do not invent thread IDs for them. If tools cannot read or edit the checkout, return blocked with the tool failure instead of claiming a candidate. Edit only permitted repository files. Read and follow checked-out repository instructions. Do not commit or change HEAD. The host owns staging, final commit creation and required checks. For a candidate proposal set candidateSha to expectedHeadSha and list the actual paths changed relative to that head, including merged base changes. Account for every supplied unresolved thread using only the evidenceRefs listed here. Unknown product intent must return blocked, with the question in its reason. Suggested checks are advisory only. Keep notes in notesMarkdown, never create runtime files in the checkout. Do not access credentials or perform any remote effect.' } };
    const providerDirectory = join(worker, 'provider');
    result.provider = await runProvider({ package: job.package, actionId: job.actionId, profile: { ...profile, maxAttempts: Math.min(profile.maxAttempts, options.maximumProviderAttempts ?? profile.maxAttempts), timeoutMs: Math.max(1, Math.min(profile.timeoutMs, deadline - Date.now())) }, mode: 'workspace',
      workingDirectory: checkout, artifactDirectory: providerDirectory, sources: source, evidence: providerEvidence, evidenceDigest: digest(canonicalJson(providerEvidence)), fixtureDigest: result.fixtureDigest,
      missingEvidence: source.missingEvidence, signal: controller.signal, isCurrent: options.isCurrent ? () => options.isCurrent!(job) : undefined });
    await current();
    if (!result.provider.payload || !['completed', 'blocked'].includes(result.provider.outcome)) {
      result.status = result.provider.outcome === 'completed' ? 'invalid_output' : result.provider.outcome; result.diagnostic = result.provider.diagnostic;
    } else {
      const proposal = result.provider.payload as Candidate | RepairStop;
      verifyThreads(job, proposal, source);
      if (await git(checkout, ['rev-parse', 'HEAD'], deadline, controller.signal) !== job.headSha) throw new ExecutionFailure('invalid_output', 'The provider changed HEAD. The host must create the candidate commit.');
      if (proposal.outcome !== 'candidate') { result.payload = proposal; result.status = proposal.outcome; result.diagnostic = proposal.reason; }
      else if (proposal.threads.some(thread => thread.disposition === 'blocked') || !conflict && !ci && !actionableReview(job) && !proposal.threads.some(thread => thread.disposition === 'addressed')) {
        result.status = 'blocked'; result.diagnostic = 'Unresolved product intent or declined-only review decisions require a human handoff.';
        const stop: RepairStop = { schemaVersion: 1, outcome: 'blocked', expectedHeadSha: job.headSha, reason: result.diagnostic,
          threads: proposal.threads.map(thread => thread.disposition === 'addressed' ? { ...thread, disposition: 'blocked', response: `Proposed edit was not finalized. ${thread.response}` } : thread), notesMarkdown: proposal.notesMarkdown };
        validateActionPayload(job.package, job.actionId, stop); result.payload = stop;
      } else {
        if (proposal.candidateSha !== job.headSha) throw new ExecutionFailure('invalid_output', 'Candidate proposals must reference the pinned head; the host finalizes the new commit.');
        await git(checkout, ['add', '--all', '--', '.'], deadline, controller.signal);
        const paths = await changedPaths(checkout, job.headSha, deadline, controller.signal);
        if (!conflict && !paths.length) throw new ExecutionFailure('invalid_output', 'A repair candidate proposal made no change. Return no_change with its reason.');
        if (await git(checkout, ['ls-files', '--unmerged', '-z'], deadline, controller.signal)) throw new ExecutionFailure('invalid_output', 'The candidate index still contains unresolved conflicts.');
        if (canonicalJson(paths) !== canonicalJson([...proposal.changedPaths].sort()) || paths.some(path => !permittedPath(path, job.policy))) throw new ExecutionFailure('invalid_output', 'Candidate changed paths do not match the proposal or execution policy.');
        for (const path of paths) {
          const entry = await git(checkout, ['ls-files', '--stage', '--', path], deadline, controller.signal);
          if (entry && !entry.split('\n').every(line => /^100(644|755) [a-f0-9]{40} 0\t/.test(line))) throw new ExecutionFailure('invalid_output', 'Changed files must be regular files with all conflicts resolved.');
        }
        for (const path of conflicts) {
          const text = await readFile(join(checkout, path), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
          if (/^(<<<<<<< |=======$|>>>>>>> )/m.test(text)) throw new ExecutionFailure('invalid_output', 'Conflict markers remain in a repaired file.');
        }
        const tree = await git(checkout, ['write-tree'], deadline, controller.signal), parents = conflict ? [job.headSha, job.baseSha] : [job.headSha];
        const sha = await git(checkout, ['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent])], deadline, controller.signal, 1024, `Repo Chap: ${conflict ? 'resolve conflict' : ci ? 'fix CI' : 'address review'}\n`);
        const candidate: Candidate = { ...proposal, candidateSha: sha, changedPaths: paths };
        validateActionPayload(job.package, job.actionId, candidate);
        await git(checkout, ['reset', '--hard', sha], deadline, controller.signal);
        if (!await verifyUnchanged(checkout, sha, tree, deadline, controller.signal)) throw new ExecutionFailure('invalid_output', 'The finalized candidate has uncommitted files.');
        for (const ancestor of parents) await git(checkout, ['merge-base', '--is-ancestor', ancestor, sha], deadline, controller.signal);
        await git(checkout, ['update-ref', 'refs/heads/repo-chap-candidate', sha], deadline, controller.signal);
        const bundled = await gitProcess(checkout, ['bundle', 'create', '-', 'refs/heads/repo-chap-candidate'], deadline, controller.signal, artifactLimit);
        if (bundled.status !== 'exited' || bundled.exitCode !== 0) throw new ExecutionFailure('blocked', 'Cannot retain a complete candidate Git bundle within the byte/time limit.');
        const patch = await gitProcess(checkout, ['diff', '--binary', '--no-ext-diff', '--no-textconv', job.headSha, sha, '--'], deadline, controller.signal, artifactLimit);
        if (patch.status !== 'exited' || patch.exitCode !== 0) throw new ExecutionFailure('blocked', 'Cannot retain the candidate patch within the byte/time limit.');
        result.payload = candidate; result.candidate = { sha, tree, parents, bundle: await putArtifact(root, 'bundle', bundled.stdout), patch: await putArtifact(root, 'patch', patch.stdout) };
        let failed = false;
        for (const check of job.policy.requiredChecks) {
          await current();
          const receipt: CheckReceipt = { id: check.id, candidateSha: sha, commandDigest: digest(canonicalJson(check)), status: 'skipped', exitCode: null,
            startedAt: new Date().toISOString(), finishedAt: '', diagnostic: 'An earlier required check failed.' };
          if (!failed) {
            const output = await runProcess(check.executable, check.args, { cwd: checkout, env: { ...gitEnvironment(), REPO_CHAP_CANDIDATE_SHA: sha },
              timeoutMs: Math.min(check.timeoutMs, deadline - Date.now()), maxBytes: check.maxOutputBytes, signal: controller.signal });
            receipt.exitCode = output.exitCode; receipt.log = await putArtifact(root, 'log', Buffer.concat([output.stdout, output.stderr]));
            receipt.status = output.status === 'exited' ? output.exitCode === 0 ? 'passed' : 'failed' : output.status === 'provider_error' ? 'failed' : output.status;
            receipt.diagnostic = receipt.status === 'passed' ? 'Required check passed on the finalized commit.' : 'Required check failed or exceeded its limit.';
            if (receipt.status === 'passed' && !await verifyUnchanged(checkout, sha, tree, deadline, controller.signal)) { receipt.status = 'failed'; receipt.diagnostic = 'The check changed the candidate checkout. Its success is not valid test evidence.'; }
          }
          receipt.finishedAt = new Date().toISOString(); result.checks.push(receipt); failed ||= receipt.status !== 'passed';
          await current();
        }
        result.requiredChecksPassed = !failed; result.status = failed ? 'checks_failed' : 'candidate';
        result.diagnostic = failed ? 'The retained candidate failed required checks and cannot be applied.' : 'Candidate finalized and required checks passed on that exact commit. No remote effect was performed.';
      }
    }
    await current();
  } catch (error) {
    result.requiredChecksPassed = false;
    result.status = error instanceof ExecutionFailure ? error.status : error instanceof WorkflowError ? 'invalid_output' : 'blocked';
    result.diagnostic = error instanceof ExecutionError ? error.message : error instanceof WorkflowError ? 'The host-finalized repair payload does not satisfy the canonical or configured action contract.' : 'Cannot prepare or retain the local repair. Check private storage, execution settings and local Git objects.';
    if (Date.now() >= deadline || controller.signal.reason === 'deadline') { result.status = 'timeout'; result.diagnostic = 'The repair deadline expired; child processes were stopped.'; }
    else if (controller.signal.aborted) { result.status = controller.signal.reason === 'superseded' ? 'superseded' : 'cancelled'; result.diagnostic = 'Repair stopped and its child processes were terminated.'; }
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    if (worker) {
      try { await rm(worker, { recursive: true, force: true }); }
      catch { result.status = 'blocked'; result.requiredChecksPassed = false; result.diagnostic = 'Cannot remove the owned disposable checkout. Inspect private worker storage before starting another attempt.'; }
    }
  }
  result.finishedAt = new Date().toISOString();
  const reference = await putJson(root, 'result', result), pending = `${receiptPath}.pending`;
  await writeFile(pending, canonicalJson({ schemaVersion: 1, state: 'completed', job: jobRef, result: reference }), { mode: 0o600, flag: 'wx' }); await rename(pending, receiptPath);
  return { result, reference };
}
export async function readRepairAttempt(directory: string, attemptId: string): Promise<{ state: 'running'; job: ArtifactRef } | { state: 'completed'; reference: ArtifactRef; result: RepairResult }> {
  if (!idPattern.test(attemptId)) throw new ExecutionError('Invalid attempt identity.');
  const root = await prepareCaptureDirectory(directory), info = await lstat(join(root, `attempt-${attemptId}.json`));
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 || info.mode & 0o077) throw new ExecutionError('Invalid private attempt receipt.');
  const receipt = JSON.parse(await readFile(join(root, `attempt-${attemptId}.json`), 'utf8'));
  if (receipt.schemaVersion !== 1 || !['running', 'completed'].includes(receipt.state)) throw new ExecutionError('Invalid attempt receipt.');
  const job = JSON.parse((await readArtifact(root, receipt.job)).toString('utf8'));
  if (job.attemptId !== attemptId) throw new ExecutionError('Attempt receipt does not match its job.');
  return receipt.state === 'running' ? { state: 'running', job: receipt.job } : { state: 'completed', reference: receipt.result, result: await readRepairResult(root, receipt.result) };
}
export async function restoreCandidate(directory: string, reference: ArtifactRef, destination: string): Promise<RepairResult> {
  const result = await readRepairResult(directory, reference);
  if (!result.candidate) throw new ExecutionError('The repair has no retained candidate.');
  const root = await prepareCaptureDirectory(destination);
  if ((await readdir(root)).length) throw new ExecutionError('Restore requires an empty private destination directory.');
  const temporary = await mkdtemp(join(root, 'restore-')), bundle = join(temporary, 'candidate.bundle');
  try {
    await writeFile(bundle, await readArtifact(directory, result.candidate.bundle), { mode: 0o600, flag: 'wx' });
    const deadline = Date.now() + 30_000;
    await git(root, ['init', '--quiet', '--template='], deadline);
    await git(root, ['fetch', '--quiet', '--no-tags', bundle, 'refs/heads/repo-chap-candidate'], deadline);
    await git(root, ['checkout', '--quiet', '--detach', result.candidate.sha], deadline);
    const parents = (await git(root, ['show', '-s', '--format=%P', 'HEAD'], deadline)).split(' ');
    if (await git(root, ['rev-parse', 'HEAD^{tree}'], deadline) !== result.candidate.tree || canonicalJson(parents) !== canonicalJson(result.candidate.parents)) throw new ExecutionError('Retained candidate ancestry or tree does not match its result.');
    return result;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
