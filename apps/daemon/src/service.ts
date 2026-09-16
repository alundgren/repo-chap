import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { controlDecision, currentFacts, evaluate, hasCompleteEvidence, type WorkflowPackage } from '@repo-chap/workflow';
import { GitHubReader, inspectPullRequest, listOpenPullRequests, type CredentialSource, type Inspection, type ReadOptions } from '@repo-chap/github';
import type { ProviderProfile, SourceBundle } from '@repo-chap/providers';
import { RuntimeError, RuntimeStore, type AnalysisJob, type AnalysisResult, type Claim, type Registration, type RepositoryRecord, type RunRecord } from '@repo-chap/runtime';
import { executeAnalysis, fetchSources, profileDigest } from './worker.js';

export interface DaemonDependencies {
  credentials: CredentialSource; profile: (name: string) => Promise<ProviderProfile>; directory: string;
  readOptions?: ReadOptions; now?: () => number;
  sources?: (repository: string, inspection: Inspection, signal: AbortSignal) => Promise<SourceBundle>;
  execute?: (job: AnalysisJob, profile: ProviderProfile, signal: AbortSignal, isCurrent: () => boolean) => Promise<AnalysisResult>;
}
export class DaemonService {
  private readonly owner = randomUUID();
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void>; claim: Claim }>();
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
  tick(): Promise<void> {
    if (this.stopped || this.polling) return this.cycle ?? Promise.resolve();
    this.cycle = this.runCycle(); return this.cycle;
  }
  private async runCycle(): Promise<void> {
    this.polling = true;
    try {
      this.store.recover(this.now()); this.abortStale();
      for (const repo of this.store.repositories().sort((a, b) => a.nextPollAt - b.nextPollAt)) {
        if (this.stopped || this.store.cooldown() > this.now()) break;
        if (!repo.paused && repo.nextPollAt <= this.now()) await this.poll(repo);
      }
      this.abortStale(); this.dispatch();
    } finally { this.polling = false; }
  }
  async poll(repo: RepositoryRecord): Promise<void> {
    if (this.store.cooldown() > this.now()) return;
    const reader = this.reader(), next = () => this.now() + this.store.limits.pollSeconds * 1000;
    try {
      const pkg = await this.store.artifacts.get<WorkflowPackage>(repo.package), listing = await listOpenPullRequests(reader, repo.name);
      let diagnostic = listing.coverage.status === 'complete' ? null : listing.coverage.failure?.message ?? 'PR listing is incomplete.';
      if (listing.repository && listing.repository.id !== repo.id) throw new RuntimeError('Repository identity changed; registration must be inspected.');
      this.store.cooldown(Math.max(reader.nextRequestAt, Date.parse(listing.coverage.failure?.retryAt ?? '') || 0));
      const known = this.store.runs(repo.id), ordered = [...new Set([...listing.numbers, ...known.filter(run => run.status !== 'closed').map(run => run.number)])].sort((a, b) => a - b);
      const after = this.store.repository(repo.id).lastPolledPr ?? 0, numbers = [...ordered.filter(number => number > after), ...ordered.filter(number => number <= after)];
      for (const number of numbers) {
        if (this.stopped || this.store.cooldown() > this.now()) break;
        const inspectionReader = this.reader();
        const prior = known.find(run => run.number === number), previous = prior && await this.store.artifacts.get<Inspection>(prior.inspection);
        const inspection = await inspectPullRequest(inspectionReader, pkg, { repository: repo.name, pr: number, reviewers: repo.reviewers, previous });
        this.store.cooldown(Math.max(inspectionReader.nextRequestAt, retryAt(inspection)));
        if (inspection.evidence.pullRequest) await this.store.observe(repo.id, inspection, this.now());
        else if (prior) this.store.unavailable(prior.id, 'GitHub evidence is unavailable. Refresh access before analysis continues.', next());
        if (inspection.status !== 'complete') diagnostic ??= 'Some PR evidence is incomplete. Inspect the run for collection coverage.';
        this.store.pollProgress(repo.id, number);
        if (this.store.cooldown() > this.now()) break;
      }
      this.store.cooldown(Math.max(reader.nextRequestAt, Date.parse(listing.coverage.failure?.retryAt ?? '') || 0));
      this.store.pollFinished(repo.id, Math.max(next(), this.store.cooldown()), diagnostic);
    } catch {
      this.store.cooldown(reader.nextRequestAt);
      for (const run of this.store.runs(repo.id)) if (run.status !== 'closed') this.store.unavailable(run.id, 'Repository polling failed. Check GitHub App access and retained evidence.', Math.max(next(), this.store.cooldown()));
      this.store.pollFinished(repo.id, Math.max(next(), this.store.cooldown()), 'Repository polling failed. Check GitHub App access and private artifact storage.');
    }
  }
  dispatch(): void {
    if (this.stopped) return;
    for (const run of this.store.runs()) {
      if (this.active.has(run.id)) continue;
      const claim = this.store.claim(run.id, this.owner, this.now(), this.store.limits.maxAttemptSeconds);
      if (!claim) continue;
      const controller = new AbortController();
      const done = this.advance(claim, controller.signal).catch(() => {
        if (this.store.isCurrent(claim, this.now())) {
          const current = this.store.run(run.id);
          this.store.park(claim, 'blocked', 'Analysis could not prepare or persist its inputs. Inspect private storage and retry within the retained limits.', null, current.control, current.nextAction, this.now(), true);
        }
      }).finally(() => { this.active.delete(run.id); });
      this.active.set(run.id, { controller, done, claim });
    }
  }
  private async advance(claim: Claim, signal: AbortSignal): Promise<void> {
    let run = this.store.run(claim.runId);
    const pkg = await this.store.artifacts.get<WorkflowPackage>(run.package), inspection = await this.store.artifacts.get<Inspection>(run.inspection);
    const observation = inspection.fixture.observations[0]!, clock = new Date(this.now()).toISOString();
    const park = (status: RunRecord['status'], reason: string, dueAt: number | null, nextAction: string | null = null, suppress = false) =>
      this.store.park(claim, status, reason, dueAt, run.control, nextAction, this.now(), suppress);
    if (!run.evidenceAvailable) { park('waiting', 'Current GitHub evidence is unavailable. Check access and wait for a successful poll.', this.now() + this.store.limits.pollSeconds * 1000); return; }
    if (!this.store.step(claim, this.store.limits.maxImmediateSteps, this.now())) { park('blocked', 'Immediate step limit reached.', null, run.nextAction, true); return; }
    if (run.nextAction?.startsWith('$')) {
      if (run.nextAction === '$observe') { this.store.pollFinished(run.repositoryId, this.now(), null); park('waiting', 'Refresh GitHub evidence before continuing.', this.now() + this.store.limits.pollSeconds * 1000); return; }
      park(run.nextAction === '$wait' ? 'waiting' : 'blocked', `${run.reason} The action chain stopped at ${run.nextAction}.`, run.nextAction === '$wait' ? this.now() + this.store.limits.pollSeconds * 1000 : null); return;
    }
    const actionId = run.nextAction ?? evaluate(pkg.workflow, observation, run.control, clock).actionId, action = pkg.workflow.actions[actionId]!;
    const scheduling = controlDecision(pkg.workflow, action.uses, observation, run.control, clock);
    if (scheduling) {
      if (scheduling.refreshAttempts !== undefined) run.control.refreshAttempts = scheduling.refreshAttempts;
      const status = scheduling.status === 'needs_observation' ? 'waiting' : scheduling.status;
      park(status, scheduling.reason, scheduling.nextWakeAt ? Math.max(Date.parse(scheduling.nextWakeAt), retryAt(inspection)) : status === 'waiting' ? this.now() + this.store.limits.pollSeconds * 1000 : null);
      return;
    }
    if (!['agent.classify', 'agent.review'].includes(action.uses)) { park('blocked', `Analysis mode stopped before ${action.uses}. Review retained analysis locally.`, null, actionId, true); return; }
    const facts = currentFacts(pkg.workflow, observation, clock);
    if (!hasCompleteEvidence(facts) || facts.lifecycle !== 'open' || facts.draft !== false || facts.young !== false || facts.headDebouncing !== false) {
      park('waiting', 'Analysis requires complete evidence and an open, non-draft PR after its delays.', Math.max(this.now() + this.store.limits.pollSeconds * 1000, retryAt(inspection))); return;
    }
    const profile = await this.dependencies.profile(this.store.repository(run.repositoryId).profile);
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
  abortStale(): void { for (const active of this.active.values()) if (!this.store.isCurrent(active.claim, this.now())) active.controller.abort('superseded'); }
  async idle(): Promise<void> { await Promise.all([...this.active.values()].map(value => value.done)); }
  async stop(): Promise<void> { this.stopped = true; this.shutdown.abort(); for (const active of this.active.values()) active.controller.abort(); await this.cycle; await this.idle(); }
  status(): unknown { return { schemaVersion: 1, mode: 'analysis', githubRetryAt: this.store.cooldown() || null, limits: this.store.limits, repositories: this.store.repositories(), runs: this.store.runs() }; }
}
function retryAt(inspection: Inspection): number {
  const coverage = [inspection.evidence.metadata, inspection.evidence.labels.coverage, inspection.evidence.checks.coverage, inspection.evidence.reviews.coverage,
    inspection.evidence.threads.coverage, inspection.evidence.reviewerActivity.coverage, ...inspection.evidence.threads.items.map(thread => thread.comments.coverage)];
  return Math.max(0, ...coverage.map(value => Date.parse(value.failure?.retryAt ?? '') || 0), Date.parse(inspection.evidence.revision.failure?.retryAt ?? '') || 0);
}
