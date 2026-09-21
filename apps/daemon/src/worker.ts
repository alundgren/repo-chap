import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, digest, buildPackage, type WorkflowPackage } from '@repo-chap/workflow';
import { prepareCaptureDirectory, type CredentialSource, type Inspection } from '@repo-chap/github';
import { collectSources, runProcess, runProvider, type ProviderProfile, type SourceBundle } from '@repo-chap/providers';
import { captureRepairSource, restoreRepairSource, createRepairJob, runRepair, type ReviewEvidence, type ArtifactRef as ExecutionArtifact } from '@repo-chap/execution';
import { ArtifactStore, RuntimeError, type AnalysisJob, type AnalysisResult, type RepairAttemptJob, type RepairAttemptResult } from '@repo-chap/runtime';

export const profileDigest = (profile: ProviderProfile): string => digest(canonicalJson(profile));
export async function fetchSources(directory: string, repository: string, inspection: Inspection, credentials: CredentialSource, signal: AbortSignal): Promise<SourceBundle> {
  return fetchPinned(directory, repository, inspection, credentials, signal, cache => collectSources(cache, inspection.evidence.pullRequest!.headSha, inspection.evidence.pullRequest!.baseSha, signal));
}
async function fetchPinned<T>(directory: string, repository: string, inspection: Inspection, credentials: CredentialSource, signal: AbortSignal, consume: (cache: string) => Promise<T>): Promise<T> {
  const pr = inspection.evidence.pullRequest;
  if (!pr || !/^[a-f0-9]{40}$/.test(pr.headSha) || !/^[a-f0-9]{40}$/.test(pr.baseSha)) throw new RuntimeError('Pinned Git revisions are unavailable.');
  const root = await prepareCaptureDirectory(directory), cache = await mkdtemp(join(root, 'fetch-'));
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env)) if (/^GIT_(CONFIG_(COUNT|KEY_|VALUE_)|DIR$|WORK_TREE$|INDEX_FILE$|OBJECT_DIRECTORY$|ALTERNATE_OBJECT_DIRECTORIES$)/.test(key)) delete env[key];
  const git = async (args: string[], environment = env) => {
    const result = await runProcess('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: cache, timeoutMs: 30_000, maxBytes: 2_097_152, env: environment, signal });
    if (result.status !== 'exited' || result.exitCode !== 0) throw new RuntimeError('Cannot fetch pinned Git objects. Check GitHub App contents access, repository history, and the attempt deadline.');
  };
  try {
    await git(['init', '--bare', '--quiet']);
    const token = await credentials.token(signal);
    await git(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', `https://github.com/${repository}.git`, pr.headSha, pr.baseSha], {
      ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    });
    return await consume(cache);
  } finally { await rm(cache, { recursive: true, force: true }); }
}
export async function executeAnalysis(job: AnalysisJob, options: {
  artifacts: ArtifactStore; profile: ProviderProfile; workerDirectory: string; signal?: AbortSignal; isCurrent: () => boolean;
}): Promise<AnalysisResult> {
  const saved = JSON.parse(JSON.stringify(job)) as AnalysisJob;
  if (saved.schemaVersion !== 1 || profileDigest(options.profile) !== saved.profileDigest || saved.profile !== options.profile.name) throw new RuntimeError('Worker profile does not match the pinned job.');
  const pkg = await options.artifacts.get<WorkflowPackage>(saved.package), inspection = await options.artifacts.get<Inspection>(saved.inspection), sources = await options.artifacts.get<SourceBundle>(saved.sources);
  const rebuilt = buildPackage(pkg.workflowPath, Object.fromEntries(pkg.files.map(file => [file.path, file.text])), { maximumCapabilities: options.profile.maximumCapabilities });
  if (rebuilt.digest !== saved.packageDigest || inspection.packageDigest !== saved.packageDigest || inspection.evidence.repository?.id !== saved.repositoryId ||
    inspection.evidence.pullRequest?.id !== saved.subjectId || sources.headSha !== saved.headSha || sources.baseSha !== saved.baseSha ||
    digest(canonicalJson({ head: saved.headSha, base: saved.baseSha, evidence: inspection.evidenceDigest })) !== saved.evidenceKey) throw new RuntimeError('Worker input identity or digest mismatch.');
  const remaining = Date.parse(saved.deadline) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new RuntimeError('Worker deadline expired.');
  const root = await prepareCaptureDirectory(options.workerDirectory), cwd = await mkdtemp(join(root, 'analysis-'));
  const deadline = AbortSignal.timeout(remaining), signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  try {
    const provider = await runProvider({ package: rebuilt, actionId: saved.actionId, profile: { ...options.profile, maxAttempts: 1, timeoutMs: Math.min(options.profile.timeoutMs, remaining) },
      mode: 'read', workingDirectory: cwd, artifactDirectory: cwd, sources, evidence: inspection.evidence, evidenceDigest: inspection.evidenceDigest,
      fixtureDigest: digest(canonicalJson(inspection.fixture)), missingEvidence: [...sources.missingEvidence, ...(inspection.status === 'complete' ? [] : ['GitHub evidence is incomplete.'])], signal, isCurrent: options.isCurrent });
    if (deadline.aborted && provider.outcome === 'cancelled') provider.outcome = 'timeout';
    return { schemaVersion: 1, job: saved, provider };
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

export async function fetchRepairSources(directory: string, repository: string, inspection: Inspection, credentials: CredentialSource, artifactDirectory: string, signal: AbortSignal): Promise<ExecutionArtifact> {
  return fetchPinned(directory, repository, inspection, credentials, signal, cache => captureRepairSource(cache, inspection.evidence.pullRequest!.headSha, inspection.evidence.pullRequest!.baseSha, artifactDirectory, signal));
}
export async function executeRepair(job: RepairAttemptJob, options: {
  artifacts: ArtifactStore; profile: ProviderProfile; artifactDirectory: string; workerDirectory: string; signal?: AbortSignal; isCurrent: () => boolean;
}): Promise<RepairAttemptResult> {
  const saved = structuredClone(job);
  if (saved.kind !== 'repair' || profileDigest(options.profile) !== saved.profileDigest || saved.profile !== options.profile.name) throw new RuntimeError('Worker profile does not match the reserved repair.');
  const pkg = await options.artifacts.get<WorkflowPackage>(saved.package), inspection = await options.artifacts.get<Inspection>(saved.inspection);
  if (pkg.digest !== saved.packageDigest || inspection.packageDigest !== saved.packageDigest || inspection.evidence.repository?.id !== saved.repositoryId ||
    inspection.evidence.pullRequest?.id !== saved.subjectId || inspection.evidence.pullRequest?.headSha !== saved.headSha || inspection.evidence.pullRequest?.baseSha !== saved.baseSha ||
    digest(canonicalJson({ head: saved.headSha, base: saved.baseSha, evidence: inspection.evidenceDigest })) !== saved.evidenceKey) throw new RuntimeError('Repair inputs do not match the durable job.');
  let review: ReviewEvidence | undefined;
  if (saved.review) {
    const accepted = await options.artifacts.get<AnalysisResult>(saved.review);
    if (accepted.provider.outcome !== 'completed' || accepted.job.runId !== saved.runId || accepted.job.repositoryId !== saved.repositoryId ||
        accepted.job.subjectId !== saved.subjectId || accepted.job.packageDigest !== saved.packageDigest || accepted.job.evidenceKey !== saved.evidenceKey ||
        accepted.job.headSha !== saved.headSha || accepted.job.baseSha !== saved.baseSha || pkg.workflow.actions[accepted.job.actionId]?.uses !== 'agent.review')
      throw new RuntimeError('Accepted review does not match the reserved repair.');
    review = { actionId: accepted.job.actionId, packageDigest: saved.packageDigest, evidenceDigest: inspection.evidenceDigest,
      headSha: saved.headSha, baseSha: saved.baseSha, payload: accepted.provider.payload };
  }
  const root = await prepareCaptureDirectory(options.workerDirectory), source = await mkdtemp(join(root, 'repair-source-'));
  try {
    await restoreRepairSource(options.artifactDirectory, saved.sources, source, options.signal);
    const execution = createRepairJob(pkg, inspection, options.profile, saved.policy, saved.actionId, { runId: saved.runId, attemptId: saved.attemptId, ownershipToken: String(saved.ownershipToken), deadline: saved.deadline, ...(review ? { review } : {}) });
    if (execution.policyDigest !== saved.policyDigest) throw new RuntimeError('Execution policy changed after reservation.');
    const value = await runRepair(execution, { sourceRepository: source, artifactDirectory: options.artifactDirectory, profile: options.profile, signal: options.signal, isCurrent: options.isCurrent, maximumProviderAttempts: 1 });
    return { schemaVersion: 1, job: saved, repair: value.result, reference: value.reference };
  } finally { await rm(source, { recursive: true, force: true }); }
}
