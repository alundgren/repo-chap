import { DatabaseSync } from 'node:sqlite';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareCaptureDirectory, validateTarget, type Inspection } from '@repo-chap/github';
import { buildPackage, canonicalJson, digest, parseFixture, referencePath, supportedCapabilities, validateActionPayload, type ControlState, type Diagnostic, type WorkflowPackage } from '@repo-chap/workflow';
import { readArtifact, readRepairResult, validateTestedCandidate, type ArtifactRef as ExecutionArtifact } from '@repo-chap/execution';
import { applyPolicyDigest, requireApplyPolicy, type ApplyPolicy } from './policy.js';
import { ArtifactStore, RuntimeError } from './artifacts.js';
import { defaultLimits, type AnalysisJob, type AnalysisResult, type ArtifactRef, type Claim, type EffectRecord, type EffectRequest, type EffectState, type EffectLease, type EffectAttempt, type RepairAttemptJob, type RepairAttemptResult, type MigrationRecord, type Registration, type RepositoryRecord, type RunRecord, type RuntimeLimits, type SourceRegistration, type WorkflowVersion } from './types.js';

const json = (value: unknown): string => canonicalJson(JSON.parse(JSON.stringify(value)));
const day = (now: number) => new Date(now).toISOString().slice(0, 10);
const decode = <T>(row: unknown): T => JSON.parse((row as { data: string }).data) as T;
export class StaleObservationError extends RuntimeError {
  constructor() { super('Workflow changed during PR collection. Discard this observation and collect its current pinned package.'); this.name = 'StaleObservationError'; }
}
export function validateLimits(input: Partial<RuntimeLimits> = {}): RuntimeLimits {
  const limits = { ...defaultLimits, ...input };
  const ceilings: RuntimeLimits = { concurrency: 32, repositoryConcurrency: 32, maxAttemptsPerLifecycle: 1000, maxRetries: 100,
    repositoryCostUnits: 1_000_000, dailyCostUnits: 1_000_000, attemptCostUnits: 100_000, maxAttemptSeconds: 3600, maxImmediateSteps: 256, pollSeconds: 3600 };
  if (Object.keys(input).some(key => !(key in ceilings))) throw new RuntimeError('Unknown runtime limit.');
  for (const key of Object.keys(ceilings) as (keyof RuntimeLimits)[])
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > ceilings[key]) throw new RuntimeError(`Invalid ${key}; use an integer from 1 to ${ceilings[key]}.`);
  return limits;
}
export class RuntimeStore {
  readonly artifacts: ArtifactStore;
  private readonly repairDirectory: string;
  private constructor(private readonly db: DatabaseSync, directory: string, readonly limits: RuntimeLimits) {
    this.artifacts = new ArtifactStore(join(directory, 'artifacts'));
    this.repairDirectory = join(directory, 'repairs');
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'").get()) {
      const version = db.prepare("SELECT value FROM metadata WHERE key='schema'").get() as { value: string } | undefined;
      if (!['1', '2', '3'].includes(version?.value ?? '')) { db.close(); throw new RuntimeError('Unsupported runtime database version.'); }
    }
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repositories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id), subject_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(repository_id, subject_id));
      CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), artifact TEXT NOT NULL, observed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), head_sha TEXT NOT NULL, token INTEGER NOT NULL, state TEXT NOT NULL, job TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS reservations (attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), repository_id TEXT NOT NULL REFERENCES repositories(id), day TEXT NOT NULL, units INTEGER NOT NULL, runtime_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notes (run_id TEXT NOT NULL REFERENCES runs(id), revision INTEGER NOT NULL, artifact TEXT NOT NULL, PRIMARY KEY(run_id, revision));
      CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), state TEXT NOT NULL, token INTEGER NOT NULL, request TEXT NOT NULL, receipt TEXT);
      CREATE TABLE IF NOT EXISTS effect_leases (effect_id TEXT PRIMARY KEY REFERENCES effects(id), owner TEXT NOT NULL, token INTEGER NOT NULL, until INTEGER NOT NULL, pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS effect_attempts (effect_id TEXT NOT NULL REFERENCES effects(id), token INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, state TEXT NOT NULL, receipt TEXT, PRIMARY KEY(effect_id,token));
      CREATE TABLE IF NOT EXISTS workflow_versions (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attempt_run ON attempts(run_id, head_sha);
      CREATE INDEX IF NOT EXISTS budget_day ON reservations(day, repository_id);`);
    this.transaction(() => {
      const schema = db.prepare("SELECT value FROM metadata WHERE key='schema'").get() as { value: string } | undefined;
      if (schema?.value === '1') {
        for (const repo of this.repositories()) {
          const version = this.saveVersion(repo.id, repo.package!, repo.packageDigest!, null, null, 0);
          repo.activeVersionId = version.id; repo.source = null; this.saveRepository(repo);
          for (const run of this.runs(repo.id)) { run.workflowVersionId = version.id; run.waitTiming = null; this.saveRun(run); }
        }
      }
      if (schema && schema.value !== '3') {
        // An older daemon could have sent a request without a durable effect lease.
        db.prepare("UPDATE effects SET state='unknown' WHERE state='sending'").run();
      }
      db.prepare("INSERT INTO metadata VALUES ('schema','3') ON CONFLICT(key) DO UPDATE SET value='3'").run();
    });
  }
  static async open(directory: string, input: Partial<RuntimeLimits> = {}): Promise<RuntimeStore> {
    const limits = validateLimits(input), root = await prepareCaptureDirectory(directory), file = join(root, 'runtime.sqlite');
    try { const handle = await open(file, 'wx', 0o600); await handle.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    for (const path of [file, `${file}-wal`, `${file}-shm`]) {
      const info = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
      if (info && (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid())) throw new RuntimeError('SQLite files must be private regular files owned by the daemon account.');
    }
    return new RuntimeStore(new DatabaseSync(file), root, limits);
  }
  close(): void { this.db.close(); }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  claimDaemon(): string {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT value FROM metadata WHERE key='daemon_owner'").get() as { value: string } | undefined;
      if (row) {
        const owner = JSON.parse(row.value) as { pid: number };
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new RuntimeError('The daemon ownership record is invalid. Inspect private runtime storage.');
        try { process.kill(owner.pid, 0); throw new RuntimeError('A daemon already owns this state directory. Use daemon status.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      const token = randomUUID();
      this.db.prepare("INSERT INTO metadata VALUES ('daemon_owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(json({ pid: process.pid, token })); return token;
    });
  }
  releaseDaemon(token: string): void {
    this.db.prepare("DELETE FROM metadata WHERE key='daemon_owner' AND json_extract(value,'$.token')=?").run(token);
  }
  repositories(): RepositoryRecord[] { return this.db.prepare('SELECT data FROM repositories ORDER BY name').all().map(row => decode<RepositoryRecord>(row)); }
  repository(id: string): RepositoryRecord {
    const row = this.db.prepare('SELECT data FROM repositories WHERE id=? OR name=? COLLATE NOCASE').get(id, id);
    if (!row) throw new RuntimeError('Repository is not registered.'); return decode(row);
  }
  runs(repositoryId?: string): RunRecord[] {
    return (repositoryId ? this.db.prepare('SELECT data FROM runs WHERE repository_id=?').all(repositoryId) : this.db.prepare('SELECT data FROM runs').all()).map(row => decode<RunRecord>(row));
  }
  run(id: string): RunRecord {
    const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id);
    if (!row) throw new RuntimeError('Run does not exist.'); return decode(row);
  }
  private saveRepository(repo: RepositoryRecord): void { this.db.prepare('UPDATE repositories SET name=?,data=? WHERE id=?').run(repo.name, json(repo), repo.id); }
  private saveRun(run: RunRecord): void { this.db.prepare('UPDATE runs SET data=? WHERE id=?').run(json(run), run.id); }
  async register(input: Registration, now: number): Promise<RepositoryRecord> {
    validateTarget(input.name, 1);
    if (!input.id || !input.profile || input.reviewers.some(value => !/^[a-z0-9][a-z0-9-]*(\[bot\])?$/i.test(value))) throw new RuntimeError('Registration requires repository identity, profile and valid reviewer logins.');
    const pkg = buildPackage(input.package.workflowPath, Object.fromEntries(input.package.files.map(file => [file.path, file.text])));
    if (pkg.digest !== input.package.digest) throw new RuntimeError('Workflow package digest mismatch.');
    const ref = await this.artifacts.put(pkg);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT data FROM repositories WHERE id=? OR name=? COLLATE NOCASE').get(input.id, input.name);
      if (existing) {
        const prior = decode<RepositoryRecord>(existing);
        if (prior.source || prior.id !== input.id || prior.packageDigest !== pkg.digest || prior.profile !== input.profile || json(prior.reviewers) !== json(input.reviewers)) throw new RuntimeError('Repository is already registered with different immutable settings. Inspect its workflow versions.');
        return prior;
      }
      const repo: RepositoryRecord = { id: input.id, name: input.name, package: ref, packageDigest: pkg.digest, profile: input.profile, reviewers: input.reviewers, paused: false, nextPollAt: now, diagnostic: null, lastPolledPr: 0, activeVersionId: null, source: null };
      this.db.prepare('INSERT INTO repositories VALUES (?,?,?)').run(repo.id, repo.name, json(repo));
      repo.activeVersionId = this.saveVersion(repo.id, ref, pkg.digest, null, null, now).id; this.saveRepository(repo); return repo;
    });
  }
  registerSource(input: SourceRegistration, now: number): RepositoryRecord {
    validateTarget(input.name, 1);
    const path = referencePath('workflow.json', input.workflowPath);
    if (path.fragment || !input.id || !input.profile || input.reviewers.some(value => !/^[a-z0-9][a-z0-9-]*(\[bot\])?$/i.test(value)) ||
      input.maximumCapabilities.some(value => !supportedCapabilities.includes(value))) throw new RuntimeError('Source registration requires a workflow path, operator profile and valid reviewer settings.');
    if (input.branch !== null && (typeof input.branch !== 'string' || !input.branch || input.branch.length > 255 || /[\s\x00-\x1f~^:?*\[\\]/.test(input.branch) || input.branch.includes('..') || input.branch.includes('@{') || input.branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')))) throw new RuntimeError('Use a Git branch name such as main or team/workflows.');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT data FROM repositories WHERE id=? OR name=? COLLATE NOCASE').get(input.id, input.name);
      if (row) {
        const prior = decode<RepositoryRecord>(row);
        if (prior.id !== input.id || !prior.source || prior.source.workflowPath !== path.path || prior.source.branch !== input.branch || prior.profile !== input.profile ||
          json(prior.reviewers) !== json(input.reviewers) || json(prior.source.maximumCapabilities) !== json(input.maximumCapabilities)) throw new RuntimeError('Repository is already registered with different immutable settings. Inspect its workflow versions.');
        return prior;
      }
      const repo: RepositoryRecord = { id: input.id, name: input.name, package: null, packageDigest: null, activeVersionId: null,
        profile: input.profile, reviewers: input.reviewers, paused: false, nextPollAt: now, diagnostic: null, lastPolledPr: 0,
        source: { workflowPath: path.path, branch: input.branch, maximumCapabilities: input.maximumCapabilities, resolvedBranch: null, observedRevision: null,
          checkedAt: null, status: 'pending', diagnostics: [], held: false } };
      this.db.prepare('INSERT INTO repositories VALUES (?,?,?)').run(repo.id, repo.name, json(repo)); return repo;
    });
  }
  private saveVersion(repositoryId: string, pkg: ArtifactRef, packageDigest: string, sourceRevision: string | null, sourceBranch: string | null, now: number): WorkflowVersion {
    const id = digest(json({ repositoryId, artifact: pkg.digest, sourceRevision, sourceBranch })).slice(7);
    const version: WorkflowVersion = { id, repositoryId, package: pkg, packageDigest, sourceRevision, sourceBranch, createdAt: now };
    this.db.prepare('INSERT OR IGNORE INTO workflow_versions VALUES (?,?,?)').run(id, repositoryId, json(version));
    return this.version(repositoryId, id);
  }
  versions(repository: string): { repository: RepositoryRecord; versions: WorkflowVersion[] } {
    const repo = this.repository(repository);
    return { repository: repo, versions: this.db.prepare('SELECT data FROM workflow_versions WHERE repository_id=? ORDER BY json_extract(data,\'$.createdAt\'),id').all(repo.id).map(row => decode<WorkflowVersion>(row)) };
  }
  version(repositoryId: string, id: string): WorkflowVersion {
    const row = this.db.prepare('SELECT data FROM workflow_versions WHERE repository_id=? AND id=?').get(repositoryId, id);
    if (!row) throw new RuntimeError('Retained workflow version does not exist for this repository. Use daemon versions.'); return decode(row);
  }
  private selectVersion(repo: RepositoryRecord, version: WorkflowVersion): void {
    repo.activeVersionId = version.id; repo.package = version.package; repo.packageDigest = version.packageDigest;
  }
  sourceFailure(repositoryId: string, revision: string | null, branch: string | null, status: 'invalid' | 'unavailable', diagnostics: Diagnostic[], now: number): void {
    this.transaction(() => {
      const repo = this.repository(repositoryId);
      if (!repo.source) throw new RuntimeError('Repository has no workflow source.');
      Object.assign(repo.source, { observedRevision: revision, resolvedBranch: branch, status, diagnostics, checkedAt: now }); this.saveRepository(repo);
    });
  }
  async activateSource(repositoryId: string, revision: string, branch: string, candidate: WorkflowPackage, now: number): Promise<WorkflowVersion> {
    const repo = this.repository(repositoryId);
    if (!repo.source || !/^[a-f0-9]{40}$/.test(revision) || repo.source.branch !== null && repo.source.branch !== branch || candidate.workflowPath !== repo.source.workflowPath) throw new RuntimeError('Workflow source identity does not match its registration.');
    const pkg = buildPackage(candidate.workflowPath, Object.fromEntries(candidate.files.map(file => [file.path, file.text])), { maximumCapabilities: repo.source.maximumCapabilities });
    if (pkg.digest !== candidate.digest) throw new RuntimeError('Workflow package digest mismatch.');
    const ref = await this.artifacts.put(pkg);
    return this.transaction(() => {
      const current = this.repository(repositoryId), version = this.saveVersion(repo.id, ref, pkg.digest, revision, branch, now);
      Object.assign(current.source!, { observedRevision: revision, resolvedBranch: branch, checkedAt: now, status: 'valid', diagnostics: [] });
      if (!current.source!.held) this.selectVersion(current, version);
      this.saveRepository(current); return version;
    });
  }
  sourceUnchanged(repositoryId: string, revision: string, branch: string, now: number): void {
    this.transaction(() => {
      const repo = this.repository(repositoryId);
      if (!repo.source || repo.source.observedRevision !== revision || repo.source.resolvedBranch !== branch) throw new RuntimeError('Source changed before activation. Poll it again.');
      repo.source.checkedAt = now;
      if (!repo.source.held && repo.source.status === 'valid') {
        const version = this.versions(repo.id).versions.find(value => value.sourceRevision === revision && value.sourceBranch === branch);
        if (!version) throw new RuntimeError('Validated source version is unavailable. Inspect private artifacts.');
        this.selectVersion(repo, version);
      }
      this.saveRepository(repo);
    });
  }
  rollback(repository: string, versionId: string): RepositoryRecord {
    return this.transaction(() => {
      const repo = this.repository(repository);
      if (!repo.source) throw new RuntimeError('Rollback requires a repository-owned workflow source.');
      this.selectVersion(repo, this.version(repo.id, versionId)); repo.source.held = true; this.saveRepository(repo); return repo;
    });
  }
  resumeAuto(repository: string, now: number): RepositoryRecord {
    return this.transaction(() => {
      const repo = this.repository(repository);
      if (!repo.source) throw new RuntimeError('Repository has no automatic workflow source.');
      repo.source.held = false; repo.nextPollAt = now; this.saveRepository(repo); return repo;
    });
  }
  async migrate(runId: string, versionId: string, now: number): Promise<MigrationRecord> {
    const prior = this.run(runId), version = this.version(prior.repositoryId, versionId);
    if (['closed', 'cancelled'].includes(prior.status)) throw new RuntimeError('Migration requires an open run. A cancelled run needs an explicit bounded retry first.');
    const [old, next, inspection] = await Promise.all([this.artifacts.get<WorkflowPackage>(prior.package), this.artifacts.get<WorkflowPackage>(version.package), this.artifacts.get<Inspection>(prior.inspection)]);
    const rebound = await this.artifacts.put({ ...inspection, packageDigest: next.digest });
    return this.transaction(() => {
      const run = this.run(runId);
      if (json(run) !== json(prior)) throw new RuntimeError('Run advanced during migration. Inspect its checkpoint and retry migration.');
      const changed = run.packageDigest !== version.packageDigest, observation = inspection.fixture.observations[0]!;
      const timing = run.waitTiming;
      run.waitTiming = {
        youngUntil: timing?.youngUntil ?? (observation.createdAt ? Date.parse(observation.createdAt) + old.workflow.settings.newPrDelaySeconds * 1000 : null),
        head: timing?.head?.headSha === run.headSha && timing.head.baseSha === run.baseSha ? timing.head : observation.headChangedAt ? { headSha: run.headSha, baseSha: run.baseSha, until: Date.parse(observation.headChangedAt) + old.workflow.settings.headDebounceSeconds * 1000 } : null,
        reviewer: timing?.reviewer && timing.reviewer.startedAt === observation.externalReviewStartedAt ? timing.reviewer : observation.externalReviewStartedAt ? { startedAt: observation.externalReviewStartedAt, until: Date.parse(observation.externalReviewStartedAt) + old.workflow.settings.reviewDeadlineSeconds * 1000 } : null,
      };
      // Migration fences workers without changing any effect receipt or semantic identity.
      run.token++; run.owner = null; run.leaseUntil = null;
      this.db.prepare("UPDATE attempts SET state='superseded' WHERE run_id=? AND state='running'").run(run.id);
      this.fenceEffects(run.id);
      if (changed) {
        run.control.memory = { ...run.control.memory, classificationCurrent: false, reviewCurrent: false, packetCurrent: false };
        delete run.control.review; delete run.control.classification; run.repair = null;
        for (const [id, evidence] of Object.entries(run.failedActions)) for (const [nextId, action] of Object.entries(next.workflow.actions))
          if (old.workflow.actions[id]?.uses === action.uses) run.failedActions[nextId] = evidence;
        const continuation = run.nextAction;
        const failure = run.retryAction && run.failedActions[run.retryAction] === run.evidenceKey;
        if (!failure) run.nextAction = null;
        else if (continuation && !continuation.startsWith('$') && old.workflow.actions[continuation]?.uses !== next.workflow.actions[continuation]?.uses) {
          run.nextAction = '$blocked'; run.status = 'blocked'; run.dueAt = null;
        }
        if (run.retryAction && old.workflow.actions[run.retryAction]?.uses !== next.workflow.actions[run.retryAction]?.uses) run.retryAction = null;
      }
      run.package = version.package; run.packageDigest = version.packageDigest; run.workflowVersionId = version.id; run.inspection = rebound;
      if (run.status === 'running' || run.status === 'ready') { run.status = 'waiting'; run.dueAt = now; }
      run.reason = `Migrated at an operator checkpoint. ${changed ? 'Derived analysis was invalidated.' : 'Compatible analysis was retained.'} Existing waits, suppression, receipts and charges remain recorded.`;
      const checkpoint: MigrationRecord = { id: randomUUID(), runId, fromVersionId: prior.workflowVersionId, toVersionId: version.id, at: now, ownershipToken: run.token, notesRevision: run.notesRevision, evidenceKey: run.evidenceKey, invalidatedResults: changed };
      this.db.prepare('INSERT INTO migrations VALUES (?,?,?)').run(checkpoint.id, runId, json(checkpoint)); this.saveRun(run); return checkpoint;
    });
  }
  pollFinished(id: string, nextPollAt: number, diagnostic: string | null): void {
    this.transaction(() => { const repo = this.repository(id); repo.nextPollAt = nextPollAt; repo.diagnostic = diagnostic; this.saveRepository(repo); });
  }
  pollProgress(id: string, number: number): void {
    this.transaction(() => { const repo = this.repository(id); repo.lastPolledPr = number; this.saveRepository(repo); });
  }
  cooldown(until?: number): number {
    if (until !== undefined) this.db.prepare("INSERT INTO metadata VALUES ('github_cooldown',?) ON CONFLICT(key) DO UPDATE SET value=MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER))").run(String(until));
    return Number((this.db.prepare("SELECT value FROM metadata WHERE key='github_cooldown'").get() as { value: string } | undefined)?.value ?? 0);
  }
  async observe(repositoryId: string, inspection: Inspection, now: number): Promise<RunRecord | null> {
    const repo = this.repository(repositoryId), pr = inspection.evidence.pullRequest;
    parseFixture(inspection.fixture);
    if (inspection.evidenceDigest !== digest(json(inspection.evidence))) throw new RuntimeError('Observation evidence digest mismatch.');
    if (!pr) return null;
    if (inspection.evidence.repository?.id !== repo.id || inspection.evidence.requested.repository.toLowerCase() !== repo.name.toLowerCase()) throw new RuntimeError('Observation belongs to another repository.');
    const observation = inspection.fixture.observations[0]!;
    if (observation.headSha !== pr.headSha || observation.baseSha !== pr.baseSha || observation.evidenceDigest !== inspection.evidenceDigest) throw new RuntimeError('Observation revisions do not match its evidence.');
    const ref = await this.artifacts.put(inspection), key = digest(json({ head: pr.headSha, base: pr.baseSha, evidence: inspection.evidenceDigest }));
    return this.transaction(() => {
      const row = this.db.prepare('SELECT data FROM runs WHERE repository_id=? AND subject_id=?').get(repo.id, pr.id);
      const currentRepo = this.repository(repo.id), pinned = row ? decode<RunRecord>(row).packageDigest : currentRepo.packageDigest;
      if (!pinned || inspection.packageDigest !== pinned) throw new StaleObservationError();
      let run: RunRecord;
      if (!row) {
        run = { id: randomUUID(), repositoryId: repo.id, subjectKind: 'pull_request', subjectId: pr.id, number: pr.number,
          package: currentRepo.package!, packageDigest: pinned, workflowVersionId: currentRepo.activeVersionId!, waitTiming: null, inspection: ref, evidenceKey: key, headSha: pr.headSha, baseSha: pr.baseSha, control: { memory: { classificationCurrent: false, reviewCurrent: false, packetCurrent: false } },
          status: 'ready', reason: 'New PR observed.', dueAt: now, nextAction: null, token: 0, owner: null, leaseUntil: null, notesRevision: 0, retries: 0, steps: 0, agents: 0, suppression: null, evidenceAvailable: true, failedActions: {}, retryAction: null };
        this.db.prepare('INSERT INTO runs VALUES (?,?,?,?)').run(run.id, repo.id, pr.id, json(run));
      } else {
        run = decode(row); run.inspection = ref;
        if (!run.evidenceAvailable && run.status !== 'cancelled') { run.status = 'ready'; run.dueAt = now; run.suppression = null; }
        run.evidenceAvailable = true;
        if (run.evidenceKey !== key) {
          this.invalidate(run, 'superseded');
          run.evidenceKey = key; run.headSha = pr.headSha; run.baseSha = pr.baseSha;
          run.control = { ...run.control, memory: { classificationCurrent: false, reviewCurrent: false, packetCurrent: false } };
          delete run.control.review; delete run.control.classification; run.repair = null;
          run.nextAction = this.threadContinuation(run);
          run.suppression = null; run.steps = 0; run.agents = 0;
          run.failedActions = {}; run.retryAction = null;
          if (run.status !== 'cancelled') { run.status = 'ready'; run.reason = 'Evidence changed.'; run.dueAt = now; }
        }
        this.saveRun(run);
      }
      this.db.prepare('INSERT INTO observations(run_id,artifact,observed_at) VALUES (?,?,?)').run(run.id, json(ref), now);
      return run;
    });
  }
  private invalidate(run: RunRecord, state: string, rejectPlanned = true): void {
    run.token++; run.owner = null; run.leaseUntil = null;
    this.db.prepare("UPDATE attempts SET state=? WHERE run_id=? AND state='running'").run(state, run.id);
    if (rejectPlanned) this.db.prepare("UPDATE effects SET state='rejected' WHERE run_id=? AND state='planned'").run(run.id);
    this.fenceEffects(run.id);
  }
  private threadContinuation(run: RunRecord): string | null {
    const resolution = run.threadResolution;
    if (!resolution || resolution.packageDigest !== run.packageDigest || !this.effects(run.id).some(effect => effect.id === resolution.pushEffectId && effect.state === 'confirmed')) return null;
    if (!resolution.completed) return resolution.actionId;
    return resolution.continuation === run.nextAction && !run.nextAction?.startsWith('$') ? run.nextAction : null;
  }
  unavailable(runId: string, reason: string, dueAt: number): void {
    this.transaction(() => {
      const run = this.run(runId); this.invalidate(run, 'superseded', false); run.evidenceAvailable = false;
      run.control.memory = { classificationCurrent: false, reviewCurrent: false, packetCurrent: false };
      delete run.control.review; delete run.control.classification;
      if (!['cancelled', 'closed'].includes(run.status)) { run.status = 'waiting'; run.reason = reason; run.dueAt = dueAt; if (!run.repair) run.nextAction = this.threadContinuation(run); }
      this.saveRun(run);
    });
  }
  recover(now: number): number {
    return this.transaction(() => {
      let count = 0;
      for (const run of this.runs()) if (run.owner && run.leaseUntil! <= now) {
        run.token++; run.owner = null; run.leaseUntil = null;
        this.db.prepare("UPDATE attempts SET state='abandoned' WHERE run_id=? AND state='running'").run(run.id); run.status = 'ready'; run.dueAt = now; run.reason = 'Expired attempt recovered; its reservation remains consumed.'; this.saveRun(run); count++;
      }
      const sending = this.db.prepare("SELECT effects.id, effect_leases.until, effect_leases.pid FROM effects LEFT JOIN effect_leases ON effects.id=effect_leases.effect_id WHERE effects.state='sending'").all();
      for (const row of sending) {
        let abandoned = row.until === null || Number(row.until) <= now;
        if (!abandoned) { try { process.kill(Number(row.pid), 0); } catch (error) { abandoned = (error as NodeJS.ErrnoException).code === 'ESRCH'; } }
        if (abandoned) this.unknownEffect(String(row.id), now);
      }
      return count;
    });
  }
  claim(runId: string, owner: string, now: number, seconds: number): Claim | null {
    if (!Number.isFinite(seconds) || seconds <= 0) throw new RuntimeError('A claim requires a positive bounded duration.');
    this.recover(now);
    return this.transaction(() => {
      const run = this.run(runId), repo = this.repository(run.repositoryId);
      if (!owner || repo.paused || run.owner || ['cancelled', 'closed'].includes(run.status) || run.dueAt === null || run.dueAt > now) return null;
      const sending = new Set(this.db.prepare("SELECT DISTINCT effects.run_id FROM effects JOIN effect_leases ON effects.id=effect_id WHERE effects.state='sending' AND effect_leases.until>?").all(now).map(row => String(row.run_id)));
      if (sending.has(run.id)) return null;
      const active = this.runs().filter(value => value.owner && value.leaseUntil! > now || sending.has(value.id));
      if (active.length >= this.limits.concurrency || active.filter(value => value.repositoryId === repo.id).length >= this.limits.repositoryConcurrency) return null;
      run.token++; run.owner = owner; run.leaseUntil = now + Math.min(seconds, this.limits.maxAttemptSeconds) * 1000;
      run.status = 'running'; this.saveRun(run);
      return { runId, owner, token: run.token, until: run.leaseUntil, evidenceKey: run.evidenceKey, notesRevision: run.notesRevision };
    });
  }
  isCurrent(claim: Claim, now: number): boolean {
    const run = this.run(claim.runId);
    return run.owner === claim.owner && run.token === claim.token && run.leaseUntil! > now && run.evidenceKey === claim.evidenceKey && run.notesRevision === claim.notesRevision;
  }
  private requireCurrent(claim: Claim, now: number): RunRecord {
    if (!this.isCurrent(claim, now)) throw new RuntimeError('Ownership or pinned inputs changed. The result is stale.'); return this.run(claim.runId);
  }
  park(claim: Claim, status: RunRecord['status'], reason: string, dueAt: number | null, control: ControlState, nextAction: string | null, now: number, suppress = false): void {
    this.transaction(() => {
      const run = this.requireCurrent(claim, now); run.status = status; run.reason = reason; run.dueAt = dueAt; run.control = control; run.nextAction = nextAction;
      run.owner = null; run.leaseUntil = null; run.steps = 0; run.agents = 0;
      if (suppress) run.suppression = run.evidenceKey;
      this.saveRun(run);
    });
  }
  step(claim: Claim, maximum: number, now: number): boolean {
    return this.transaction(() => { const run = this.requireCurrent(claim, now); if (run.steps >= Math.min(maximum, this.limits.maxImmediateSteps)) return false; run.steps++; this.saveRun(run); return true; });
  }
  reserve(claim: Claim, input: { actionId: string; sources: ArtifactRef; profile: string; profileDigest: string; package: WorkflowPackage }, now: number): AnalysisJob {
    return this.reserveAttempt(claim, input, now) as AnalysisJob;
  }
  reserveRepair(claim: Claim, input: { actionId: string; sources: ExecutionArtifact; profile: string; profileDigest: string; package: WorkflowPackage; applyPolicy: ApplyPolicy }, now: number): RepairAttemptJob {
    const policy = requireApplyPolicy(input.applyPolicy, this.repository(this.run(claim.runId).repositoryId).name, ['workspace.write', 'checks.run']);
    if (!policy.execution) throw new RuntimeError('Repair requires a private execution policy with required checks.');
    return this.reserveAttempt(claim, input, now, policy) as RepairAttemptJob;
  }
  private reserveAttempt(claim: Claim, input: { actionId: string; sources: ArtifactRef; profile: string; profileDigest: string; package: WorkflowPackage }, now: number, apply?: ApplyPolicy): AnalysisJob | RepairAttemptJob {
    return this.transaction(() => {
      const run = this.requireCurrent(claim, now), limits = input.package.workflow.limits;
      if (run.packageDigest !== input.package.digest || this.repository(run.repositoryId).paused) throw new RuntimeError('The repository is paused or package is not current.');
      const repair = !!apply, uses = input.package.workflow.actions[input.actionId]?.uses;
      if (!(repair ? ['agent.resolve_conflict', 'agent.address_review'] : ['agent.classify', 'agent.review']).includes(uses ?? '')) throw new RuntimeError('Cannot reserve this action in the selected execution mode.');
      if (repair && this.effects(run.id).some(effect => ['github.push_candidate', 'github.resolve_eligible_threads'].includes(effect.kind) && ['sending', 'unknown'].includes(effect.state))) throw new RuntimeError('Reconcile the pending remote effect before starting another provider attempt.');
      const repairs = Number((this.db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE run_id=? AND json_extract(job,'$.kind')='repair'").get(run.id) as { count: number }).count);
      if (repair && repairs >= Math.min(limits.maxRepairsPerLifecycle, apply!.maxRepairsPerLifecycle)) throw new RuntimeError('Total repair limit reached across all PR heads. A human decision is required.');
      if (run.suppression === run.evidenceKey || run.failedActions?.[input.actionId] === run.evidenceKey) throw new RuntimeError('Unchanged work is suppressed. Use a bounded retry or wait for new evidence.');
      if (this.db.prepare("SELECT id FROM attempts WHERE run_id=? AND state='running'").get(run.id)) throw new RuntimeError('This run already has a reserved attempt.');
      const count = this.db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN head_sha=? THEN 1 ELSE 0 END) AS head FROM attempts WHERE run_id=?').get(run.headSha, run.id) as { total: number; head: number };
      if (count.total >= this.limits.maxAttemptsPerLifecycle || count.head >= limits.maxAttemptsPerHead || run.agents >= limits.maxAgentActionsPerWake) throw new RuntimeError('Lifecycle, per-head, or per-wake attempt limit reached.');
      const spent = (sql: string, ...args: string[]) => Number((this.db.prepare(sql).get(...args) as { total: number }).total ?? 0);
      const units = this.limits.attemptCostUnits;
      if (spent('SELECT SUM(units) AS total FROM reservations WHERE repository_id=?', run.repositoryId) + units > this.limits.repositoryCostUnits) throw new RuntimeError('Repository cost-unit budget exhausted. Reservations remain consumed after retries and restarts.');
      if (spent('SELECT SUM(units) AS total FROM reservations WHERE day=?', day(now)) + units > this.limits.dailyCostUnits ||
        spent('SELECT SUM(units) AS total FROM reservations WHERE day=? AND repository_id=?', day(now), run.repositoryId) + units > limits.maxDailyCostUnits) throw new RuntimeError('Daily cost-unit budget exhausted. Wait until the next UTC day; previous reservations remain recorded.');
      const id = randomUUID(), deadline = Math.min(claim.until, now + limits.maxAttemptSeconds * 1000);
      const job: AnalysisJob | RepairAttemptJob = { schemaVersion: 1, runId: run.id, attemptId: id, ownershipToken: claim.token, deadline: new Date(deadline).toISOString(),
        repositoryId: run.repositoryId, subjectId: run.subjectId, actionId: input.actionId, headSha: run.headSha!, baseSha: run.baseSha!, package: run.package, packageDigest: run.packageDigest,
        inspection: run.inspection, sources: input.sources, evidenceKey: run.evidenceKey, notesRevision: run.notesRevision, profile: input.profile, profileDigest: input.profileDigest, workflowVersionId: run.workflowVersionId,
        ...(apply ? { kind: 'repair' as const, sources: input.sources as ExecutionArtifact, policy: apply.execution!, policyDigest: digest(canonicalJson(apply.execution!)), applyPolicyDigest: applyPolicyDigest(apply) } : {}) };
      this.db.prepare('INSERT INTO attempts VALUES (?,?,?,?,?,?,NULL)').run(id, run.id, job.headSha, claim.token, 'running', json(job));
      this.db.prepare('INSERT INTO reservations VALUES (?,?,?,?,?)').run(id, run.repositoryId, day(now), units, deadline - now);
      run.agents++; run.nextAction = input.actionId; run.control.attemptsThisHead = count.head + 1;
      if (repair) {
        run.repair = null; run.threadResolution = null; run.control.repairsThisLifecycle = repairs + 1;
        run.control.memory = { ...run.control.memory, packetCurrent: false, repairSuppressed: false };
      } else {
      run.control.memory = { ...run.control.memory, packetCurrent: false, [uses === 'agent.review' ? 'reviewCurrent' : 'classificationCurrent']: false };
      if (uses === 'agent.review') delete run.control.review; else delete run.control.classification;
      }
      this.saveRun(run); return job;
    });
  }
  async complete(claim: Claim, result: AnalysisResult, now: number, effects: EffectRequest[] = []): Promise<boolean> {
    const job = result.job;
    const pkg = await this.artifacts.get<WorkflowPackage>(job.package);
    if (result.schemaVersion !== 1 || result.provider.attempts.length > 1 || pkg.digest !== job.packageDigest) throw new RuntimeError('Result does not satisfy the reserved job contract.');
    if (result.provider.outcome === 'completed') {
      validateActionPayload(pkg, job.actionId, result.provider.payload);
      const payload = result.provider.payload as { headSha?: string; baseSha?: string };
      if (payload.headSha !== job.headSha || payload.baseSha && payload.baseSha !== job.baseSha) throw new RuntimeError('Result belongs to another revision.');
    }
    const ref = await this.artifacts.put(result);
    return this.transaction(() => {
      if (!this.isCurrent(claim, now) || job.runId !== claim.runId || job.ownershipToken !== claim.token || Date.parse(job.deadline) <= now) return false;
      const attempt = this.db.prepare('SELECT job,state FROM attempts WHERE id=?').get(job.attemptId) as { job: string; state: string } | undefined;
      if (!attempt || attempt.state !== 'running' || attempt.job !== json(job)) return false;
      const run = this.run(job.runId), action = pkg.workflow.actions[job.actionId]!;
      this.db.prepare('UPDATE attempts SET state=?,result=? WHERE id=?').run(result.provider.outcome, json(ref), job.attemptId);
      run.notesRevision++; this.db.prepare('INSERT INTO notes VALUES (?,?,?)').run(run.id, run.notesRevision, json(ref));
      run.reason = result.provider.diagnostic;
      if (result.provider.outcome === 'completed') {
        const payload = result.provider.payload as Record<string, unknown>;
        if (action.uses === 'agent.review') { run.control.memory = { ...run.control.memory, reviewCurrent: true }; run.control.review = { coverage: payload.coverage, verdict: payload.verdict } as NonNullable<ControlState['review']>; }
        else { run.control.memory = { ...run.control.memory, classificationCurrent: true }; run.control.classification = { uncertain: payload.uncertain as boolean }; }
        run.nextAction = action.onSuccess;
        if (run.failedActions) delete run.failedActions[job.actionId];
        if (run.retryAction === job.actionId) run.retryAction = null;
      } else {
        run.failedActions = { ...run.failedActions, [job.actionId]: run.evidenceKey };
        run.retryAction = job.actionId; run.nextAction = action.onFailure;
      }
      for (const request of effects) this.insertEffect(run, claim.token, request);
      run.owner = null; run.leaseUntil = null;
      run.status = 'ready'; run.dueAt = now;
      this.saveRun(run); return true;
    });
  }
  readRepair(reference: ExecutionArtifact) { return readRepairResult(this.repairDirectory, reference); }
  async failRepair(claim: Claim, job: RepairAttemptJob, reason: string, now: number): Promise<boolean> {
    const pkg = await this.artifacts.get<WorkflowPackage>(job.package), ref = await this.artifacts.put({ schemaVersion: 1, job, status: 'worker_error', diagnostic: reason });
    return this.transaction(() => {
      if (!this.isCurrent(claim, now)) return false;
      const attempt = this.db.prepare('SELECT state,job FROM attempts WHERE id=? AND run_id=?').get(job.attemptId, claim.runId) as { state: string; job: string } | undefined;
      if (attempt?.state !== 'running' || attempt.job !== json(job)) return false;
      const run = this.run(claim.runId);
      this.db.prepare("UPDATE attempts SET state='worker_error',result=? WHERE id=?").run(json(ref), job.attemptId);
      run.notesRevision++; this.db.prepare('INSERT INTO notes VALUES (?,?,?)').run(run.id, run.notesRevision, json(ref));
      run.failedActions[job.actionId] = run.evidenceKey; run.retryAction = job.actionId; run.nextAction = pkg.workflow.actions[job.actionId]!.onFailure;
      run.reason = reason; run.owner = null; run.leaseUntil = null; run.status = 'ready'; run.dueAt = now; this.saveRun(run); return true;
    });
  }
  async completeRepair(claim: Claim, value: RepairAttemptResult, now: number): Promise<boolean> {
    const job = value.job, result = await this.readRepair(value.reference);
    const pkg = await this.artifacts.get<WorkflowPackage>(job.package), inspection = await this.artifacts.get<Inspection>(job.inspection);
    if (value.schemaVersion !== 1 || job.kind !== 'repair' || json(result) !== json(value.repair) || (result.provider?.attempts.length ?? 0) > 1 ||
      result.runId !== job.runId || result.attemptId !== job.attemptId || result.ownershipToken !== String(job.ownershipToken) || result.deadline !== job.deadline ||
      result.repositoryId !== job.repositoryId || result.pullRequestId !== job.subjectId || result.headSha !== job.headSha || result.baseSha !== job.baseSha ||
      result.packageDigest !== job.packageDigest || pkg.digest !== job.packageDigest || result.policyDigest !== job.policyDigest ||
      result.profileDigest !== job.profileDigest || result.evidenceDigest !== inspection.evidenceDigest || result.fixtureDigest !== digest(canonicalJson(inspection.fixture)))
      throw new RuntimeError('Repair result does not satisfy its reserved job and pinned inputs.');
    if (result.payload) validateActionPayload(pkg, job.actionId, result.payload);
    if (result.status === 'candidate') {
      validateTestedCandidate(result, job.policy);
      for (const check of result.checks) await readArtifact(this.repairDirectory, check.log!);
      await readArtifact(this.repairDirectory, result.candidate!.bundle);
    }
    const ref = await this.artifacts.put(value);
    return this.transaction(() => {
      if (!this.isCurrent(claim, now) || job.runId !== claim.runId || job.ownershipToken !== claim.token || Date.parse(job.deadline) <= now) return false;
      const attempt = this.db.prepare('SELECT job,state FROM attempts WHERE id=?').get(job.attemptId) as { job: string; state: string } | undefined;
      if (!attempt || attempt.state !== 'running' || attempt.job !== json(job)) return false;
      const run = this.run(job.runId), action = pkg.workflow.actions[job.actionId]!;
      this.db.prepare('UPDATE attempts SET state=?,result=? WHERE id=?').run(result.status, json(ref), job.attemptId);
      run.notesRevision++; this.db.prepare('INSERT INTO notes VALUES (?,?,?)').run(run.id, run.notesRevision, json(ref));
      run.repair = { job, result: value.reference, candidateSha: result.candidate?.sha ?? null, checksCurrent: false, pushEffectId: null };
      run.reason = result.diagnostic;
      if (result.status === 'candidate') {
        run.nextAction = action.onSuccess; delete run.failedActions[job.actionId]; run.retryAction = null;
      } else {
        run.failedActions = { ...run.failedActions, [job.actionId]: run.evidenceKey }; run.retryAction = job.actionId; run.nextAction = action.onFailure;
        run.control.memory = { ...run.control.memory, repairSuppressed: true };
        run.control.repairSuppression = { evidenceDigest: inspection.evidenceDigest, reason: result.diagnostic };
      }
      run.owner = null; run.leaseUntil = null; run.status = 'ready'; run.dueAt = now; this.saveRun(run); return true;
    });
  }
  markChecks(claim: Claim, candidateSha: string, nextAction: string, now: number): void {
    this.transaction(() => {
      const run = this.requireCurrent(claim, now);
      if (!run.repair || run.repair.candidateSha !== candidateSha || run.repair.job.evidenceKey !== run.evidenceKey) throw new RuntimeError('No current tested candidate is retained.');
      run.repair.checksCurrent = true; run.nextAction = nextAction; run.status = 'ready'; run.dueAt = now;
      run.reason = 'Required checks passed on the retained candidate.'; run.owner = null; run.leaseUntil = null; this.saveRun(run);
    });
  }
  bindPush(claim: Claim, id: string, actionId: string, now: number, resolutionActionId?: string): void {
    this.transaction(() => {
      const run = this.requireCurrent(claim, now), effect = this.effects(run.id).find(value => value.id === id);
      if (!run.repair?.checksCurrent || !effect || effect.kind !== 'github.push_candidate') throw new RuntimeError('Push requires current tested candidate evidence.');
      run.repair.pushEffectId = id; run.retryAction = actionId;
      if (resolutionActionId && run.threadResolution?.pushEffectId !== id) run.threadResolution = {
        actionId: resolutionActionId, pushEffectId: id, repair: structuredClone(run.repair), packageDigest: run.packageDigest, completed: false, concerns: [],
      };
      this.saveRun(run);
    });
  }
  recordThreadConcerns(claim: Claim, concerns: NonNullable<RunRecord['threadResolution']>['concerns'], completed: boolean, now: number, continuation?: string): void {
    this.transaction(() => {
      const run = this.requireCurrent(claim, now);
      if (!run.threadResolution || run.threadResolution.packageDigest !== run.packageDigest) throw new RuntimeError('Thread resolution requires the pinned post-push repair.');
      run.threadResolution.concerns = concerns; run.threadResolution.completed = completed; run.threadResolution.observedAt = now; run.retryAction = run.threadResolution.actionId;
      run.threadResolution.continuation = continuation;
      this.saveRun(run);
    });
  }
  pushBudgetCurrent(runId: string, pkg: WorkflowPackage, policy: ApplyPolicy, now: number): boolean {
    const run = this.run(runId), total = this.db.prepare('SELECT COUNT(*) AS count FROM attempts WHERE run_id=?').get(runId) as { count: number };
    const repairs = this.db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE run_id=? AND json_extract(job,'$.kind')='repair'").get(runId) as { count: number };
    const units = (sql: string, ...args: string[]) => Number((this.db.prepare(sql).get(...args) as { total: number }).total ?? 0);
    return total.count <= this.limits.maxAttemptsPerLifecycle && repairs.count <= Math.min(pkg.workflow.limits.maxRepairsPerLifecycle, policy.maxRepairsPerLifecycle) &&
      units('SELECT SUM(units) AS total FROM reservations WHERE repository_id=?', run.repositoryId) <= this.limits.repositoryCostUnits &&
      units('SELECT SUM(units) AS total FROM reservations WHERE day=?', day(now)) <= this.limits.dailyCostUnits &&
      units('SELECT SUM(units) AS total FROM reservations WHERE day=? AND repository_id=?', day(now), run.repositoryId) <= pkg.workflow.limits.maxDailyCostUnits;
  }
  pause(repository: string, paused: boolean, now: number): RepositoryRecord {
    return this.transaction(() => { const repo = this.repository(repository); repo.paused = paused; if (!paused) repo.nextPollAt = now; this.saveRepository(repo); return repo; });
  }
  cancel(runId: string): RunRecord {
    return this.transaction(() => { const run = this.run(runId); this.invalidate(run, 'cancelled'); run.status = 'cancelled'; run.reason = 'Cancelled by the operator.'; run.dueAt = null; this.saveRun(run); return run; });
  }
  retry(runId: string, now: number): RunRecord {
    return this.transaction(() => {
      const run = this.run(runId);
      if (run.owner || run.status === 'closed' || run.retries >= this.limits.maxRetries) throw new RuntimeError('Retry requires an idle, open run with remaining operator retries.');
      run.retries++; run.suppression = null; run.failedActions = {}; run.nextAction = run.retryAction ?? null;
      if (!run.retryAction) { run.control.memory = { classificationCurrent: false, reviewCurrent: false, packetCurrent: false }; delete run.control.review; delete run.control.classification; }
      run.status = 'ready'; run.reason = 'Bounded retry requested; all attempt and cost limits are retained.'; run.dueAt = now; run.steps = 0; run.agents = 0; this.saveRun(run); return run;
    });
  }
  private insertEffect(run: RunRecord, token: number, request: EffectRequest): string {
    if (request.evidenceKey !== run.evidenceKey) throw new RuntimeError('Effect evidence is stale.');
    // Resolution itself changes PR evidence. Its immutable payload already binds the pushed commit and concern.
    const { evidenceKey: _evidenceKey, ...semantic } = request;
    const id = digest(json({ repositoryId: run.repositoryId, runId: run.id, ...(request.kind === 'github.resolve_eligible_threads' ? semantic : request) })).slice(7);
    this.db.prepare("INSERT OR IGNORE INTO effects VALUES (?,?, 'planned', ?,?,NULL)").run(id, run.id, token, json(request));
    if (request.kind === 'github.resolve_eligible_threads') this.db.prepare("UPDATE effects SET request=?,token=? WHERE id=? AND state='rejected' AND json_extract(receipt,'$.retryable')=1").run(json(request), token, id);
    return id;
  }
  private unknownEffect(id: string, now: number): void {
    this.db.prepare("UPDATE effects SET state='unknown' WHERE id=? AND state='sending'").run(id);
    this.db.prepare("UPDATE effect_attempts SET state='unknown',finished_at=? WHERE effect_id=? AND state='sending'").run(now, id);
    this.db.prepare('DELETE FROM effect_leases WHERE effect_id=?').run(id);
  }
  private fenceEffects(runId: string): void {
    for (const row of this.db.prepare("SELECT id FROM effects WHERE run_id=? AND state='sending'").all(runId)) this.unknownEffect(String(row.id), Date.now());
  }
  planEffect(claim: Claim, request: EffectRequest, now: number): string { return this.transaction(() => this.insertEffect(this.requireCurrent(claim, now), claim.token, request)); }
  effects(runId: string): EffectRecord[] {
    return this.db.prepare('SELECT * FROM effects WHERE run_id=?').all(runId).map(row => ({ ...JSON.parse(String(row.request)), id: row.id, runId: row.run_id, token: row.token, state: row.state, receipt: row.receipt ? JSON.parse(String(row.receipt)) : null })) as EffectRecord[];
  }
  transitionEffect(claim: Claim, id: string, expected: EffectState, next: EffectState, receipt: unknown, now: number): boolean {
    return this.transaction(() => {
      this.requireCurrent(claim, now);
      const allowed: Record<EffectState, EffectState[]> = { planned: ['sending', 'rejected'], sending: ['confirmed', 'rejected', 'unknown'], unknown: ['confirmed', 'rejected'], confirmed: [], rejected: [] };
      if (!allowed[expected].includes(next) || ['confirmed', 'rejected'].includes(next) && receipt == null) throw new RuntimeError('Invalid effect transition or missing receipt.');
      const changed = this.db.prepare('UPDATE effects SET state=?,receipt=?,token=? WHERE id=? AND run_id=? AND state=?').run(next, receipt == null ? null : json(receipt), claim.token, id, claim.runId, expected).changes === 1;
      if (changed && next === 'sending') this.saveEffectLease(id, claim.runId, claim.owner, now, claim.until);
      if (changed && next !== 'sending') {
        this.db.prepare('UPDATE effect_attempts SET state=?,receipt=?,finished_at=? WHERE effect_id=? AND state IN (\'sending\',\'unknown\')').run(next, receipt == null ? null : json(receipt), now, id);
        this.db.prepare('DELETE FROM effect_leases WHERE effect_id=?').run(id);
      }
      return changed;
    });
  }
  private saveEffectLease(id: string, runId: string, owner: string, now: number, until: number): EffectLease {
    const token = Number((this.db.prepare('SELECT MAX(token) AS token FROM effect_attempts WHERE effect_id=?').get(id) as { token: number | null }).token ?? 0) + 1;
    this.db.prepare('INSERT INTO effect_leases VALUES (?,?,?,?,?)').run(id, owner, token, until, process.pid);
    this.db.prepare("INSERT INTO effect_attempts VALUES (?,?,?,NULL,'sending',NULL)").run(id, token, now);
    return { effectId: id, runId, owner, token, until };
  }
  beginEffect(claim: Claim, id: string, maximumAttempts: number, now: number, seconds = 120): EffectLease {
    return this.transaction(() => {
      const run = this.requireCurrent(claim, now), effect = this.effects(run.id).find(value => value.id === id);
      if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 100 || !Number.isFinite(seconds) || seconds <= 0 || seconds > 3600 ||
        this.repository(run.repositoryId).paused || !effect || !(effect.state === 'planned' || effect.state === 'rejected' && (effect.receipt as { retryable?: boolean } | null)?.retryable === true) || effect.evidenceKey !== run.evidenceKey ||
        this.effects(run.id).some(value => value.id !== id && value.kind === effect.kind && ['sending', 'unknown'].includes(value.state) &&
          (effect.kind !== 'github.resolve_eligible_threads' || value.destination === effect.destination))) throw new RuntimeError('Effect dispatch requires current ownership, inputs and a planned request without an unresolved write.');
      if (this.effectAttempts(id).length >= Math.min(maximumAttempts, this.limits.maxRetries + 1)) throw new RuntimeError('Remote effect attempt limit reached. Inspect the retained candidate and receipts; a human decision is required.');
      this.db.prepare("UPDATE effects SET state='sending',receipt=NULL WHERE id=?").run(id);
      return this.saveEffectLease(id, run.id, claim.owner, now, now + seconds * 1000);
    });
  }
  effectCurrent(lease: EffectLease, now: number): boolean {
    const row = this.db.prepare('SELECT * FROM effect_leases WHERE effect_id=?').get(lease.effectId), run = this.run(lease.runId);
    const effect = this.effects(run.id).find(value => value.id === lease.effectId);
    return !!row && row.owner === lease.owner && row.token === lease.token && Number(row.until) > now && effect?.state === 'sending' &&
      effect.evidenceKey === run.evidenceKey && !['cancelled', 'closed'].includes(run.status) && !this.repository(run.repositoryId).paused;
  }
  ownsEffect(runId: string, owner: string, now: number): boolean {
    return this.db.prepare('SELECT effect_leases.* FROM effect_leases JOIN effects ON effects.id=effect_id WHERE effects.run_id=? AND effect_leases.owner=?').all(runId, owner)
      .some(row => this.effectCurrent({ effectId: String(row.effect_id), runId, owner, token: Number(row.token), until: Number(row.until) }, now));
  }
  finishEffect(lease: EffectLease, next: 'confirmed' | 'rejected' | 'unknown', receipt: unknown, now: number): boolean {
    return this.transaction(() => {
      if (receipt == null) return false;
      if (!this.effectCurrent(lease, now)) {
        const row = this.db.prepare('SELECT owner,token FROM effect_leases WHERE effect_id=?').get(lease.effectId);
        if (row?.owner === lease.owner && row.token === lease.token) this.unknownEffect(lease.effectId, now);
        return false;
      }
      this.db.prepare('UPDATE effects SET state=?,receipt=? WHERE id=?').run(next, json(receipt), lease.effectId);
      this.db.prepare('UPDATE effect_attempts SET state=?,receipt=?,finished_at=? WHERE effect_id=? AND token=?').run(next, json(receipt), now, lease.effectId, lease.token);
      this.db.prepare('DELETE FROM effect_leases WHERE effect_id=?').run(lease.effectId); return true;
    });
  }
  reconcileEffect(id: string, next: 'confirmed' | 'rejected' | 'unknown', receipt: unknown, now: number): boolean {
    return this.transaction(() => {
      if (receipt == null) throw new RuntimeError('Reconciliation requires an observed receipt.');
      const changed = this.db.prepare("UPDATE effects SET state=?,receipt=? WHERE id=? AND state='unknown'").run(next, json(receipt), id).changes === 1;
      if (changed) this.db.prepare("UPDATE effect_attempts SET state=?,receipt=?,finished_at=? WHERE effect_id=? AND state='unknown'").run(next, json(receipt), now, id);
      return changed;
    });
  }
  effectAttempts(id: string): EffectAttempt[] {
    return this.db.prepare('SELECT * FROM effect_attempts WHERE effect_id=? ORDER BY token').all(id).map(row => ({ effectId: String(row.effect_id), token: Number(row.token),
      startedAt: Number(row.started_at), finishedAt: row.finished_at === null ? null : Number(row.finished_at), state: row.state as EffectState, receipt: row.receipt ? JSON.parse(String(row.receipt)) : null }));
  }
  wakeAfterEffect(id: string, now: number, dueAt = now): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT run_id FROM effects WHERE id=?').get(id);
      if (!row) return;
      const run = this.run(String(row.run_id)), effect = this.effects(run.id).find(value => value.id === id)!;
      if (run.owner || ['closed', 'cancelled'].includes(run.status)) return;
      const resolution = run.threadResolution;
      if (resolution && !resolution.completed && resolution.packageDigest === run.packageDigest &&
        (resolution.pushEffectId === id && effect.state === 'confirmed' || effect.kind === 'github.resolve_eligible_threads')) run.nextAction = resolution.actionId;
      else if (effect.evidenceKey !== run.evidenceKey) return;
      run.status = dueAt > now ? 'waiting' : 'ready'; run.dueAt = dueAt; run.reason = 'Remote effect receipt updated. Inspect before continuing.'; this.saveRun(run);
    });
  }
  inspect(runId: string): { run: RunRecord; version: WorkflowVersion; migrations: MigrationRecord[]; attempts: unknown[]; reservations: unknown[]; notes: unknown[]; effects: EffectRecord[]; effectAttempts: EffectAttempt[] } {
    return { run: this.run(runId), attempts: this.db.prepare('SELECT * FROM attempts WHERE run_id=?').all(runId).map(row => ({ ...row, job: JSON.parse(String(row.job)), result: row.result ? JSON.parse(String(row.result)) : null })),
      version: this.version(this.run(runId).repositoryId, this.run(runId).workflowVersionId), migrations: this.db.prepare('SELECT data FROM migrations WHERE run_id=? ORDER BY json_extract(data,\'$.at\')').all(runId).map(row => decode<MigrationRecord>(row)),
      reservations: this.db.prepare('SELECT reservations.* FROM reservations JOIN attempts ON attempts.id=attempt_id WHERE attempts.run_id=?').all(runId),
      notes: this.db.prepare('SELECT revision,artifact FROM notes WHERE run_id=? ORDER BY revision').all(runId).map(row => ({ revision: row.revision, artifact: JSON.parse(String(row.artifact)) })), effects: this.effects(runId), effectAttempts: this.effects(runId).flatMap(effect => this.effectAttempts(effect.id)) };
  }
}
