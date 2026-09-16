import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { controlDecision, currentFacts, evaluate, hasCompleteEvidence, WorkflowError, type Capability, type WorkflowPackage, type Observation, type Workflow } from '@repo-chap/workflow';
import { GitHubReader, GitHubReadError, inspectPullRequest, listOpenPullRequests, resolveWorkflowSource, type CredentialSource, type Inspection, type ReadOptions, type PushCredentials, type PushTransport, type PullRequestWriteCredentials, type ThreadTransport } from '@repo-chap/github';
import { ExecutionError, validateTestedCandidate, type ArtifactRef as ExecutionArtifact } from '@repo-chap/execution';
import type { ProviderProfile, SourceBundle } from '@repo-chap/providers';
import { RuntimeError, RuntimeStore, StaleObservationError, requireApplyPolicy, applyPolicyDigest, type ApplyPolicy, type EffectRecord, type RepairAttemptJob, type RepairAttemptResult, type AnalysisJob, type AnalysisResult, type Claim, type Registration, type RepositoryRecord, type RunRecord, type SourceRegistration } from '@repo-chap/runtime';
import { executeAnalysis, fetchSources, executeRepair, fetchRepairSources, profileDigest } from './worker.js';
import { dispatchCandidatePush, reconcilePendingPushes } from './push.js';
import { dispatchThreadResolutions, reconcilePendingThreads } from './threads.js';
import { fetchWorkflowCommit } from './source.js';

export interface DaemonDependencies {
  credentials: CredentialSource; profile: (name: string) => Promise<ProviderProfile>; directory: string;
  readOptions?: ReadOptions; now?: () => number;
  sources?: (repository: string, inspection: Inspection, signal: AbortSignal) => Promise<SourceBundle>;
  workflowSource?: (repository: string, revision: string, path: string, maximumCapabilities: readonly Capability[], signal: AbortSignal) => Promise<WorkflowPackage>;
  applyPolicy?: (repository: string) => Promise<ApplyPolicy | null>;
  pushCredentials?: (repository: string) => Promise<PushCredentials>;
  threadCredentials?: (repository: string) => Promise<PullRequestWriteCredentials>;
  threadTransport?: (repository: string, signal: AbortSignal) => Promise<ThreadTransport>;
  repairSources?: (repository: string, inspection: Inspection, signal: AbortSignal) => Promise<ExecutionArtifact>;
  repair?: (job: RepairAttemptJob, profile: ProviderProfile, signal: AbortSignal, isCurrent: () => boolean) => Promise<RepairAttemptResult>;
  pushTransport?: (repository: string, checkout: string, signal: AbortSignal) => Promise<PushTransport>;
  target?: { repository: string; number: number };
  planOnly?: boolean;
  onPlannedEffect?: (effect: EffectRecord) => void | Promise<void>;
  execute?: (job: AnalysisJob, profile: ProviderProfile, signal: AbortSignal, isCurrent: () => boolean) => Promise<AnalysisResult>;
}
export class DaemonService {
  private readonly owner = randomUUID();
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void>; claim: Claim }>();
  private readonly sourceReads = new Map<string, Promise<void>>();
  private polling = false;
  private stopped = false;
  private readonly shutdown = new AbortController();
  private cycle: Promise<void> | null = null;
  readonly now: () => number;
  constructor(readonly store: RuntimeStore, private readonly dependencies: DaemonDependencies) { this.now = dependencies.now ?? Date.now; }
  private reader(): GitHubReader { return new GitHubReader(this.dependencies.credentials, { ...this.dependencies.readOptions, now: this.now, signal: this.shutdown.signal,
    cooldown: { read: () => this.store.cooldown(), extend: until => { this.store.cooldown(until); } } }); }
  async register(input: Omit<Registration, 'id'>): Promise<RepositoryRecord> {
    const profile = await this.dependencies.profile(input.profile);
    if (input.package.workflow.requestedCapabilities.some(cap => !profile.maximumCapabilities.includes(cap))) throw new RuntimeError('The operator profile does not permit the requested workflow capabilities.');
    if (this.store.cooldown() > this.now()) throw new RuntimeError('GitHub is in a persisted cooldown. Register after the retry time shown in status.');
    const reader = this.reader(), listing = await listOpenPullRequests(reader, input.name);
    this.store.cooldown(Math.max(reader.nextRequestAt, Date.parse(listing.coverage.failure?.retryAt ?? '') || 0));
    if (!listing.repository || listing.coverage.status !== 'complete') throw new RuntimeError('Cannot verify repository access. Check the GitHub App installation and retry after any rate limit.');
    return this.store.register({ ...input, id: listing.repository.id, name: listing.repository.name }, this.now());
  }
  async registerSource(input: Omit<SourceRegistration, 'id' | 'maximumCapabilities'>): Promise<RepositoryRecord> {
    const profile = await this.dependencies.profile(input.profile);
    if (this.store.cooldown() > this.now()) throw new RuntimeError('GitHub is in a persisted cooldown. Register after the retry time shown in status.');
    const reader = this.reader(), listing = await listOpenPullRequests(reader, input.name);
    this.store.cooldown(Math.max(reader.nextRequestAt, Date.parse(listing.coverage.failure?.retryAt ?? '') || 0));
    if (!listing.repository || listing.coverage.status !== 'complete') throw new RuntimeError('Cannot verify repository access. Check the GitHub App installation and retry after any rate limit.');
    const repo = this.store.registerSource({ ...input, id: listing.repository.id, name: listing.repository.name, maximumCapabilities: [...profile.maximumCapabilities] }, this.now());
    await this.pollSource(repo); return this.store.repository(repo.id);
  }
  private async pollSource(repo: RepositoryRecord): Promise<void> {
    const existing = this.sourceReads.get(repo.id);
    if (existing) return existing;
    const read = this.readSource(this.store.repository(repo.id)); this.sourceReads.set(repo.id, read);
    try { await read; } finally { this.sourceReads.delete(repo.id); }
  }
  private async readSource(repo: RepositoryRecord): Promise<void> {
    const source = repo.source;
    if (!source || this.store.cooldown() > this.now()) return;
    const reader = this.reader(); let revision: string | null = null, branch: string | null = null;
    try {
      const current = await resolveWorkflowSource(reader, repo.name, source.branch);
      revision = current.revision; branch = current.branch;
      if (current.repositoryId !== repo.id) throw new RuntimeError('Repository identity changed. Inspect its source registration.');
      if (source.observedRevision === revision && source.resolvedBranch === branch && ['valid', 'invalid'].includes(source.status)) {
        this.store.sourceUnchanged(repo.id, revision, branch, this.now()); return;
      }
      const profile = await this.dependencies.profile(repo.profile), maximum = source.maximumCapabilities.filter(cap => profile.maximumCapabilities.includes(cap));
      if (this.store.cooldown() > this.now()) throw new GitHubReadError('rate_limit', new Date(this.store.cooldown()).toISOString());
      const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(120_000)]);
      const pkg = await (this.dependencies.workflowSource?.(repo.name, revision, source.workflowPath, source.maximumCapabilities, signal) ??
        fetchWorkflowCommit(join(this.dependencies.directory, 'git-cache'), repo.name, revision, source.workflowPath, source.maximumCapabilities, this.dependencies.credentials, signal, () => this.store.cooldown() <= this.now()));
      if (pkg.workflow.requestedCapabilities.some(cap => !maximum.includes(cap))) throw new RuntimeError('Operator capabilities no longer permit this workflow.');
      await this.store.activateSource(repo.id, revision, branch, pkg, this.now());
    } catch (error) {
      const diagnostics = error instanceof WorkflowError ? error.diagnostics.map(item => ({ ...item, path: item.path.startsWith('/') ? `${source.workflowPath}${item.path}` : item.path })) :
        [{ code: error instanceof GitHubReadError ? error.failure.code : 'source_unavailable', path: source.workflowPath,
          message: error instanceof GitHubReadError ? error.failure.message : error instanceof RuntimeError ? error.message : 'Cannot read or validate the workflow source. Check repository access, provider settings and private storage.' }];
      this.store.sourceFailure(repo.id, revision, branch, error instanceof WorkflowError ? 'invalid' : 'unavailable', diagnostics, this.now());
    } finally { this.store.cooldown(reader.nextRequestAt); }
  }
  tick(): Promise<void> {
    if (this.stopped || this.polling) return this.cycle ?? Promise.resolve();
    this.cycle = this.runCycle(); return this.cycle;
  }
  private async runCycle(): Promise<void> {
    this.polling = true;
    try {
      this.store.recover(this.now()); this.abortStale();
      await reconcilePendingPushes(this.store, this.dependencies, this.now, this.shutdown.signal);
      await reconcilePendingThreads(this.store, this.dependencies, () => this.reader(), this.now);
      for (const repo of this.store.repositories().sort((a, b) => a.nextPollAt - b.nextPollAt)) {
        if (this.dependencies.target && repo.name.toLowerCase() !== this.dependencies.target.repository.toLowerCase()) continue;
        if (this.stopped || this.store.cooldown() > this.now()) break;
        if (repo.nextPollAt <= this.now()) await this.poll(repo);
      }
      this.abortStale(); this.dispatch();
    } finally { this.polling = false; }
  }
  async poll(repo: RepositoryRecord): Promise<void> {
    if (this.store.cooldown() > this.now()) return;
    const reader = this.reader(), next = () => this.now() + this.store.limits.pollSeconds * 1000;
    try {
      await this.pollSource(repo); repo = this.store.repository(repo.id);
      if (repo.paused || !repo.package || this.store.cooldown() > this.now()) { this.store.pollFinished(repo.id, Math.max(next(), this.store.cooldown()), repo.diagnostic); return; }
      const listing = await listOpenPullRequests(reader, repo.name);
      let diagnostic = listing.coverage.status === 'complete' ? null : listing.coverage.failure?.message ?? 'PR listing is incomplete.';
      if (listing.repository && listing.repository.id !== repo.id) throw new RuntimeError('Repository identity changed; registration must be inspected.');
      this.store.cooldown(Math.max(reader.nextRequestAt, Date.parse(listing.coverage.failure?.retryAt ?? '') || 0));
      const known = this.store.runs(repo.id), ordered = this.dependencies.target ? [this.dependencies.target.number] : [...new Set([...listing.numbers, ...known.filter(run => run.status !== 'closed').map(run => run.number)])].sort((a, b) => a - b);
      const after = this.store.repository(repo.id).lastPolledPr ?? 0, numbers = [...ordered.filter(number => number > after), ...ordered.filter(number => number <= after)];
      for (const number of numbers) {
        if (this.stopped || this.store.cooldown() > this.now()) break;
        const inspectionReader = this.reader();
        const prior = this.store.runs(repo.id).find(run => run.number === number), previous = prior && await this.store.artifacts.get<Inspection>(prior.inspection);
        const pkg = await this.store.artifacts.get<WorkflowPackage>(prior?.package ?? this.store.repository(repo.id).package!);
        const inspection = await inspectPullRequest(inspectionReader, pkg, { repository: repo.name, pr: number, reviewers: repo.reviewers, previous, reviewerDeadline: prior?.waitTiming?.reviewer ?? undefined });
        this.store.cooldown(Math.max(inspectionReader.nextRequestAt, retryAt(inspection)));
        if (inspection.evidence.pullRequest) {
          try { await this.store.observe(repo.id, inspection, this.now()); }
          catch (error) {
            if (!(error instanceof StaleObservationError)) throw error;
            diagnostic ??= 'A workflow changed during PR collection. The affected PR will refresh on the next poll.';
          }
        }
        else if (prior) this.store.unavailable(prior.id, 'GitHub evidence is unavailable. Refresh access before analysis continues.', next());
        if (inspection.status !== 'complete') diagnostic ??= 'Some PR evidence is incomplete. Inspect the run for collection coverage.';
        this.store.pollProgress(repo.id, number);
        if (this.store.cooldown() > this.now()) break;
      }
      this.store.cooldown(Math.max(reader.nextRequestAt, Date.parse(listing.coverage.failure?.retryAt ?? '') || 0));
      this.store.pollFinished(repo.id, Math.max(next(), this.store.cooldown()), diagnostic);
    } catch {
      this.store.cooldown(reader.nextRequestAt);
      for (const run of this.store.runs(repo.id)) if (run.status !== 'closed' && (!this.dependencies.target || run.number === this.dependencies.target.number)) this.store.unavailable(run.id, 'Repository polling failed. Check GitHub access and retained evidence.', Math.max(next(), this.store.cooldown()));
      this.store.pollFinished(repo.id, Math.max(next(), this.store.cooldown()), 'Repository polling failed. Check GitHub App access and private artifact storage.');
    }
  }
  dispatch(): void {
    if (this.stopped) return;
    for (const run of this.store.runs()) {
      const target = this.dependencies.target;
      if (target && (run.number !== target.number || this.store.repository(run.repositoryId).name.toLowerCase() !== target.repository.toLowerCase())) continue;
      if (this.active.has(run.id)) continue;
      const claim = this.store.claim(run.id, this.owner, this.now(), this.store.limits.maxAttemptSeconds);
      if (!claim) continue;
      const controller = new AbortController();
      const done = this.advance(claim, controller.signal).catch(() => {
        if (this.store.isCurrent(claim, this.now())) {
          const current = this.store.run(run.id);
          this.store.park(claim, 'blocked', 'Work could not prepare or persist its inputs. Inspect private policy, storage and retained artifacts, then retry within the existing limits.', null, current.control, current.nextAction, this.now(), true);
        }
      }).finally(() => { this.active.delete(run.id); });
      this.active.set(run.id, { controller, done, claim });
    }
  }
  private async advance(claim: Claim, signal: AbortSignal): Promise<void> {
    let run = this.store.run(claim.runId);
    const pkg = await this.store.artifacts.get<WorkflowPackage>(run.package), inspection = await this.store.artifacts.get<Inspection>(run.inspection);
    const observation = inspection.fixture.observations[0]!, clock = new Date(this.now()).toISOString(), workflow = waitingWorkflow(pkg.workflow, run, observation);
    const park = (status: RunRecord['status'], reason: string, dueAt: number | null, nextAction: string | null = null, suppress = false) =>
      this.store.park(claim, status, reason, dueAt, run.control, nextAction, this.now(), suppress);
    if (!run.evidenceAvailable) { park('waiting', 'Current GitHub evidence is unavailable. Check access and wait for a successful poll.', this.now() + this.store.limits.pollSeconds * 1000); return; }
    if (!this.store.step(claim, this.store.limits.maxImmediateSteps, this.now())) { park('blocked', 'Immediate step limit reached.', null, run.nextAction, true); return; }
    if (run.nextAction?.startsWith('$')) {
      if (run.nextAction === '$observe') { this.store.pollFinished(run.repositoryId, this.now(), null); park('waiting', 'Refresh GitHub evidence before continuing.', this.now() + this.store.limits.pollSeconds * 1000); return; }
      park(run.nextAction === '$wait' ? 'waiting' : 'blocked', `${run.reason} The action chain stopped at ${run.nextAction}.`, run.nextAction === '$wait' ? this.now() + this.store.limits.pollSeconds * 1000 : null); return;
    }
    const actionId = run.nextAction ?? evaluate(workflow, observation, run.control, clock).actionId, action = pkg.workflow.actions[actionId]!;
    const scheduling = controlDecision(workflow, action.uses, observation, run.control, clock);
    if (scheduling) {
      if (scheduling.refreshAttempts !== undefined) run.control.refreshAttempts = scheduling.refreshAttempts;
      const status = scheduling.status === 'needs_observation' ? 'waiting' : scheduling.status;
      park(status, scheduling.reason, scheduling.nextWakeAt ? Math.max(Date.parse(scheduling.nextWakeAt), retryAt(inspection)) : status === 'waiting' ? this.now() + this.store.limits.pollSeconds * 1000 : null);
      return;
    }
    const repairing = ['agent.resolve_conflict', 'agent.address_review'].includes(action.uses);
    const applying = repairing || ['checks.validate_candidate', 'github.push_candidate', 'github.resolve_eligible_threads'].includes(action.uses);
    if (!['agent.classify', 'agent.review'].includes(action.uses) && !(applying && this.dependencies.applyPolicy)) { park('blocked', `Analysis mode stopped before ${action.uses}. Review retained analysis locally.`, null, actionId, true); return; }
    if (action.uses === 'github.resolve_eligible_threads') {
      try { await dispatchThreadResolutions(this.store, claim, actionId, pkg, this.dependencies, () => this.reader(), this.now, signal); }
      catch (error) { if (this.store.isCurrent(claim, this.now())) park('blocked', error instanceof RuntimeError ? error.message : 'Thread resolution could not validate its retained repair and receipts. Inspect the individual concerns.', null, actionId); }
      return;
    }
    const facts = currentFacts(workflow, observation, clock);
    if (!hasCompleteEvidence(facts) || facts.lifecycle !== 'open' || facts.draft !== false || facts.young !== false || facts.headDebouncing !== false) {
      park('waiting', 'Analysis requires complete evidence and an open, non-draft PR after its delays.', Math.max(this.now() + this.store.limits.pollSeconds * 1000, retryAt(inspection))); return;
    }
    const repo = this.store.repository(run.repositoryId), profile = await this.dependencies.profile(repo.profile);
    if (!action.capabilities.every(cap => profile.maximumCapabilities.includes(cap) && pkg.workflow.requestedCapabilities.includes(cap))) { park('blocked', 'Current operator capabilities do not permit this action.', null, actionId); return; }
    if (action.uses === 'github.push_candidate') {
      try { await dispatchCandidatePush(this.store, claim, actionId, pkg, this.dependencies, () => this.reader(), this.now, signal); }
      catch (error) { if (this.store.isCurrent(claim, this.now())) park('blocked', error instanceof RuntimeError ? error.message : 'Push validation failed. Inspect the retained candidate, checks and policy.', null, actionId); }
      return;
    }
    if (applying) {
      try {
        const policy = requireApplyPolicy(await this.dependencies.applyPolicy!(repo.name), repo.name, repairing ? ['workspace.write', 'checks.run'] : ['checks.run']);
        if (!policy.execution) throw new RuntimeError('Repair and checks require a private execution policy.');
        if (action.uses === 'checks.validate_candidate') {
          if (!run.repair || run.repair.job.evidenceKey !== run.evidenceKey || run.repair.job.applyPolicyDigest !== applyPolicyDigest(policy) || run.repair.job.profileDigest !== profileDigest(profile)) throw new RuntimeError('No tested candidate matches the current policy, profile and PR evidence.');
          const result = await this.store.readRepair(run.repair.result); validateTestedCandidate(result, policy.execution);
          this.store.markChecks(claim, result.candidate!.sha, action.onSuccess, this.now()); return;
        }
        if (this.store.cooldown() > this.now()) { park('waiting', 'GitHub reads are waiting for the installation cooldown.', this.store.cooldown(), actionId); return; }
        const repairSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, claim.until - this.now()))]);
        const source = await (this.dependencies.repairSources?.(repo.name, inspection, repairSignal) ?? fetchRepairSources(join(this.dependencies.directory, 'git-cache'), repo.name, inspection, this.dependencies.credentials, join(this.dependencies.directory, 'repairs'), repairSignal));
        const currentPolicy = requireApplyPolicy(await this.dependencies.applyPolicy!(repo.name), repo.name, ['workspace.write', 'checks.run']);
        if (applyPolicyDigest(currentPolicy) !== applyPolicyDigest(policy)) throw new RuntimeError('Apply policy changed while repair inputs were prepared.');
        const job = this.store.reserveRepair(claim, { actionId, sources: source, profile: profile.name, profileDigest: profileDigest(profile), package: pkg, applyPolicy: policy }, this.now());
        const isCurrent = () => this.store.isCurrent(claim, this.now());
        try {
          const result = await (this.dependencies.repair?.(job, profile, repairSignal, isCurrent) ?? executeRepair(job, { artifacts: this.store.artifacts, profile, artifactDirectory: join(this.dependencies.directory, 'repairs'), workerDirectory: join(this.dependencies.directory, 'workers'), signal: repairSignal, isCurrent }));
          await this.store.completeRepair(claim, result, this.now());
        } catch { await this.store.failRepair(claim, job, 'Repair could not retain a valid result. Inspect its attempt and private storage; any retry keeps the consumed reservation.', this.now()); }
      } catch (error) {
        if (this.store.isCurrent(claim, this.now())) {
          const reason = error instanceof RuntimeError || error instanceof ExecutionError ? error.message : 'Cannot prepare repair with the current private policy. Check private settings and storage.';
          if (reason.startsWith('Daily cost-unit')) { const date = new Date(this.now()); date.setUTCHours(24, 0, 0, 0); park('waiting', reason, date.getTime(), actionId); }
          else park('blocked', reason, null, actionId);
        }
      }
      return;
    }
    if (this.store.cooldown() > this.now()) { park('waiting', 'GitHub reads are waiting for the installation cooldown.', this.store.cooldown(), actionId); return; }
    const sourceSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, claim.until - this.now()))]);
    const sources = await (this.dependencies.sources?.(this.store.repository(run.repositoryId).name, inspection, sourceSignal) ?? fetchSources(join(this.dependencies.directory, 'git-cache'), this.store.repository(run.repositoryId).name, inspection, this.dependencies.credentials, sourceSignal));
    const sourceRef = await this.store.artifacts.put(sources);
    let job: AnalysisJob;
    try { job = this.store.reserve(claim, { actionId, sources: sourceRef, profile: profile.name, profileDigest: profileDigest(profile), package: pkg }, this.now()); }
    catch (error) {
      const reason = error instanceof RuntimeError ? error.message : 'Attempt reservation failed.';
      if (reason.startsWith('Daily cost-unit')) { const date = new Date(this.now()); date.setUTCHours(24, 0, 0, 0); park('waiting', reason, date.getTime(), actionId); }
      else park('blocked', reason, null, actionId, true);
      return;
    }
    const isCurrent = () => this.store.isCurrent(claim, this.now());
    let result: AnalysisResult;
    try { result = await (this.dependencies.execute?.(job, profile, signal, isCurrent) ?? executeAnalysis(job, { artifacts: this.store.artifacts, profile, workerDirectory: join(this.dependencies.directory, 'workers'), signal, isCurrent })); }
    catch { result = { schemaVersion: 1, job, provider: { schemaVersion: 1, provider: profile.provider, providerVersion: null, profile: profile.name, providerDigest: null, inputDigest: job.evidenceKey,
      outcome: signal.aborted ? 'cancelled' : 'provider_error', diagnostic: 'The analysis worker failed. Check provider access and private storage, then request a bounded retry.', attempts: [] } }; }
    await this.store.complete(claim, result, this.now());
    run = this.store.run(claim.runId);
  }
  abortStale(): void { for (const active of this.active.values()) if (!this.store.isCurrent(active.claim, this.now()) && !this.store.ownsEffect(active.claim.runId, this.owner, this.now())) active.controller.abort('superseded'); }
  async idle(): Promise<void> { await Promise.all([...this.active.values()].map(value => value.done)); }
  async stop(): Promise<void> { this.stopped = true; this.shutdown.abort(); for (const active of this.active.values()) active.controller.abort(); await this.cycle; await Promise.all(this.sourceReads.values()); await this.idle(); }
  status(): unknown { return { schemaVersion: 1, mode: this.dependencies.applyPolicy ? 'apply' : 'analysis', githubRetryAt: this.store.cooldown() || null, limits: this.store.limits, repositories: this.store.repositories(), runs: this.store.runs() }; }
}
function waitingWorkflow(workflow: Workflow, run: RunRecord, observation: Observation): Workflow {
  const timing = run.waitTiming;
  if (!timing) return workflow;
  const settings = { ...workflow.settings };
  if (timing.youngUntil !== null && observation.createdAt) settings.newPrDelaySeconds = Math.max(0, (timing.youngUntil - Date.parse(observation.createdAt)) / 1000);
  if (timing.head && timing.head.headSha === observation.headSha && timing.head.baseSha === observation.baseSha && observation.headChangedAt) settings.headDebounceSeconds = Math.max(0, (timing.head.until - Date.parse(observation.headChangedAt)) / 1000);
  if (timing.reviewer && timing.reviewer.startedAt === observation.externalReviewStartedAt) settings.reviewDeadlineSeconds = Math.max(0, (timing.reviewer.until - Date.parse(timing.reviewer.startedAt)) / 1000);
  return { ...workflow, settings };
}
function retryAt(inspection: Inspection): number {
  const coverage = [inspection.evidence.metadata, inspection.evidence.labels.coverage, inspection.evidence.checks.coverage, inspection.evidence.reviews.coverage,
    inspection.evidence.threads.coverage, inspection.evidence.reviewerActivity.coverage, ...inspection.evidence.threads.items.map(thread => thread.comments.coverage)];
  return Math.max(0, ...coverage.map(value => Date.parse(value.failure?.retryAt ?? '') || 0), Date.parse(inspection.evidence.revision.failure?.retryAt ?? '') || 0);
}
