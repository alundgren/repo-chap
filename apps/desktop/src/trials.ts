import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GitHubReader, inspectPullRequest, localCredentials, prepareCaptureDirectory, readCapture, saveCapture, validateTarget } from '@repo-chap/github';
import type { Inspection } from '@repo-chap/github';
import { runAnalysis, validateProfile } from '@repo-chap/providers';
import type { ProviderProfile } from '@repo-chap/providers';
import { buildPackage, canonicalJson, digest, parseFixture } from '@repo-chap/workflow';
import type { WorkflowPackage } from '@repo-chap/workflow';
import type { DocumentSnapshot } from './protocol.js';
import { publicProfile } from './trial-protocol.ts';
import type { TrialProposal, TrialRecord, TrialSelection, TrialSnapshot } from './trial-protocol.js';

export const trialLimits = { retained: 10, recordBytes: 16 * 1024 * 1024, deadlineMs: 600_000 } as const;
export function trialProfileDigest(profile: ProviderProfile): string { return digest(canonicalJson(profile)); }
interface TrialOptions {
  directory: string;
  getDocument(): DocumentSnapshot;
  onChange(snapshot: TrialSnapshot): void;
  inspect?: (pkg: WorkflowPackage, selection: TrialSelection, signal: AbortSignal) => Promise<Inspection>;
  analyze?: typeof runAnalysis;
  deadlineMs?: number;
}
export function trialWorkflowIdentity(snapshot: DocumentSnapshot): string { return digest(canonicalJson([snapshot.repositoryRoot, snapshot.workflowPath])); }
export function trialDraftDigest(snapshot: DocumentSnapshot): string {
  return digest(canonicalJson(snapshot.files.map(({ path, text, error }) => ({ path, text, error })).sort((a, b) => a.path.localeCompare(b.path))));
}
function selected(value: TrialSelection): TrialSelection {
  if (!value || typeof value.repository !== 'string' || value.repository.length > 256 || typeof value.sourceRepository !== 'string' || !value.sourceRepository || value.sourceRepository.length > 4096 || typeof value.profile !== 'string' || !value.profile || value.profile.length > 256) throw new Error('Choose a repository, PR, local Git source and named provider profile.');
  try { validateTarget(value.repository, value.pr); } catch { throw new Error('Enter a GitHub repository as owner/name and a positive PR number.'); }
  return structuredClone(value);
}
async function boundedJson(file: string): Promise<any> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > trialLimits.recordBytes || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw new Error('The private trial record is unavailable or too large.');
    const buffer = Buffer.alloc(trialLimits.recordBytes + 1);
    let length = 0;
    while (length < buffer.length) { const part = await handle.read(buffer, length, buffer.length - length, null); if (!part.bytesRead) break; length += part.bytesRead; }
    if (length > trialLimits.recordBytes) throw new Error('The private trial record is too large.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
  } finally { await handle.close(); }
}

/** Only the main-process Start handler calls start. Assistant operations may prepare proposals. */
export class TrialController {
  private revision = 0;
  private proposal: TrialProposal | null = null;
  private records: TrialRecord[] = [];
  private active: { id: string; controller: AbortController; done: Promise<void> } | null = null;
  private refreshing: { id: string; controller: AbortController; done: Promise<void> } | null = null;
  private closed = false;
  private readonly options: TrialOptions;
  constructor(options: TrialOptions) { this.options = options; }

  async restore(): Promise<void> {
    const root = await prepareCaptureDirectory(this.options.directory);
    const identity = trialWorkflowIdentity(this.options.getDocument());
    const candidates = (await readdir(root)).filter(name => /^trial-[a-f0-9-]{36}$/.test(name));
    const retained: TrialRecord[] = [];
    for (const name of candidates) {
      const directory = join(root, name), info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const record = await boundedJson(join(directory, 'record.json')).catch(() => null) as TrialRecord | null;
      if (!record || record.schemaVersion !== 1 || record.id !== name.slice(6) || record.workflowIdentity !== identity || record.recordPath !== join(directory, 'record.json')) continue;
      if (record.status === 'running') { record.status = 'blocked'; record.phase = 'finished'; record.diagnostic = 'The app stopped before this trial completed. Start a new trial; unfinished work is never resumed automatically.'; record.finishedAt = new Date().toISOString(); await this.save(record); }
      retained.push(record);
    }
    this.records = retained.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, trialLimits.retained);
    this.changed();
  }

  snapshot(): TrialSnapshot {
    const document = this.options.getDocument();
    return structuredClone({ documentSessionId: document.sessionId, revision: this.revision, proposal: this.proposal,
      activeId: this.active?.id ?? null, refreshing: !!this.refreshing, refreshingId: this.refreshing?.id ?? null, records: this.records,
      currentIds: this.records.filter(record => !record.invalidated && record.draftDigest === trialDraftDigest(document) && record.remote.status === 'current').map(record => record.id),
    });
  }

  prepare(document: DocumentSnapshot, selection: TrialSelection, profile: ProviderProfile, preparedBy: TrialProposal['preparedBy'] = 'person'): void {
    if (this.closed) throw new Error('Open the workflow again before preparing a trial.');
    if (this.active || this.refreshing) throw new Error('Wait for the active trial or evidence read before preparing a proposal.');
    const current = this.options.getDocument();
    if (document.sessionId !== current.sessionId || document.revision !== current.revision) throw new Error('The workflow changed. Prepare the trial for the current draft.');
    selection = selected(selection); validateProfile(profile);
    if (profile.name !== selection.profile) throw new Error('Choose a loaded provider profile.');
    for (const record of this.records) if (canonicalJson(record.selection) !== canonicalJson(selection) || record.profileDigest !== trialProfileDigest(profile)) record.invalidated = true;
    this.proposal = { document: { sessionId: document.sessionId, revision: document.revision }, selection, provider: publicProfile(profile), profileDigest: trialProfileDigest(profile), preparedBy };
    this.changed();
  }

  start(document: DocumentSnapshot, selection: TrialSelection, profile: ProviderProfile): void {
    if (this.active || this.refreshing) throw new Error('Cancel the active trial or wait for the current read before starting another.');
    this.prepare(document, selection, profile);
    if (document.readOnlyReason || document.diagnostics.length) throw new Error('Fix the workflow validation errors before starting a live trial.');
    const pkg = buildPackage(document.workflowPath, Object.fromEntries(document.files.filter(file => !file.error).map(file => [file.path, file.text])), { maximumCapabilities: profile.maximumCapabilities });
    const actions = ['agent.classify', 'agent.review'].map(uses => Object.values(pkg.workflow.actions).filter(action => action.uses === uses));
    if (actions.some(matches => matches.length !== 1)) throw new Error('Live analysis requires exactly one classification action and one review action.');
    const id = randomUUID(), directory = join(this.options.directory, `trial-${id}`);
    const record: TrialRecord = { schemaVersion: 1, id, workflowIdentity: trialWorkflowIdentity(document), document: { sessionId: document.sessionId, revision: document.revision },
      selection: selected(selection), provider: publicProfile(profile), profileDigest: trialProfileDigest(profile), draftDigest: trialDraftDigest(document), packageDigest: pkg.digest,
      startedAt: new Date().toISOString(), finishedAt: null, status: 'running', phase: 'capture', diagnostic: 'Reading current GitHub PR evidence.', invalidated: false, capture: null, inspection: null,
      remote: { status: 'unchecked', checkedAt: null, headSha: null, baseSha: null }, analysis: null, recordPath: join(directory, 'record.json') };
    this.proposal = null; this.records.unshift(record);
    const active = { id, controller: new AbortController(), done: Promise.resolve() };
    this.active = active;
    active.done = Promise.resolve().then(() => this.run(record, pkg, structuredClone(profile), active.controller)).finally(() => { if (this.active === active) this.active = null; this.changed(); });
    this.changed();
  }

  invalidate(): void {
    for (const record of this.records) record.invalidated = true;
    this.active?.controller.abort('superseded'); this.changed();
  }
  profilesChanged(profiles: ProviderProfile[]): void {
    if (this.proposal && !profiles.some(profile => profile.name === this.proposal!.selection.profile && trialProfileDigest(profile) === this.proposal!.profileDigest)) this.proposal = null;
    for (const record of this.records) {
      const profile = profiles.find(profile => profile.name === record.selection.profile);
      if (!profile || trialProfileDigest(profile) !== record.profileDigest) { record.invalidated = true; if (this.active?.id === record.id) this.active.controller.abort('superseded'); }
    }
    this.changed();
  }
  documentChanged(): void {
    const record = this.records.find(item => item.id === this.active?.id);
    if (record && record.draftDigest !== trialDraftDigest(this.options.getDocument())) this.invalidate();
    else this.changed();
  }
  async cancel(id: string): Promise<void> {
    if (this.active?.id === id) { this.active.controller.abort('cancelled'); await this.active.done; }
    else if (this.refreshing?.id === id) { this.refreshing.controller.abort('cancelled'); await this.refreshing.done; }
    else throw new Error('This trial or evidence read is no longer running.');
  }
  async close(): Promise<void> {
    this.closed = true;
    this.active?.controller.abort('cancelled'); this.refreshing?.controller.abort('cancelled');
    await Promise.all([this.active?.done, this.refreshing?.done]);
  }
  async settled(): Promise<void> { await this.active?.done; }
  private changed(): void { this.revision++; this.options.onChange(this.snapshot()); }
  private async inspect(pkg: WorkflowPackage, selection: TrialSelection, signal: AbortSignal): Promise<Inspection> {
    return this.options.inspect?.(pkg, selection, signal) ?? inspectPullRequest(new GitHubReader(await localCredentials(), { signal }), pkg, { repository: selection.repository, pr: selection.pr });
  }
  private async save(record: TrialRecord): Promise<void> {
    const text = JSON.stringify(record, null, 2);
    if (Buffer.byteLength(text) > trialLimits.recordBytes) throw new Error('The trial result exceeds the private record limit. Its bounded analysis files remain available.');
    const path = `${record.recordPath}.pending`;
    await writeFile(path, `${text}\n`, { mode: 0o600 }); await rename(path, record.recordPath);
  }
  private async prune(): Promise<void> {
    const root = await prepareCaptureDirectory(this.options.directory);
    const directories: { path: string; time: number }[] = [];
    for (const name of await readdir(root)) if (/^trial-[a-f0-9-]{36}$/.test(name)) {
      const path = join(root, name), info = await lstat(path);
      if (info.isDirectory() && !info.isSymbolicLink()) directories.push({ path, time: info.mtimeMs });
    }
    const remove = directories.sort((a, b) => b.time - a.time).slice(trialLimits.retained);
    for (const item of remove) await rm(item.path, { recursive: true });
    const removed = new Set(remove.map(item => join(item.path, 'record.json')));
    this.records = this.records.filter(item => !removed.has(item.recordPath)).slice(0, trialLimits.retained);
  }
  private async run(record: TrialRecord, pkg: WorkflowPackage, profile: ProviderProfile, controller: AbortController): Promise<void> {
    const timeout = setTimeout(() => controller.abort('timeout'), Math.min(trialLimits.deadlineMs, this.options.deadlineMs ?? trialLimits.deadlineMs));
    const current = (): boolean => !record.invalidated && !this.closed && trialDraftDigest(this.options.getDocument()) === record.draftDigest;
    try {
      await prepareCaptureDirectory(this.options.directory); await mkdir(dirname(record.recordPath), { mode: 0o700 });
      await this.save(record); await writeFile(join(dirname(record.recordPath), 'package.json'), canonicalJson(pkg), { mode: 0o600, flag: 'wx' });
      await this.prune();
      if (controller.signal.aborted || !current()) controller.abort(controller.signal.reason ?? 'superseded');
      const inspection = await this.inspect(pkg, record.selection, controller.signal);
      record.capture = (await saveCapture(dirname(record.recordPath), inspection)).directory;
      record.inspection = { status: inspection.status, evidenceDigest: inspection.evidenceDigest, headSha: inspection.evidence.pullRequest?.headSha ?? null, baseSha: inspection.evidence.pullRequest?.baseSha ?? null };
      if (!inspection.evidence.pullRequest) {
        record.status = 'blocked'; record.diagnostic = inspection.evidence.metadata.failure?.message ?? 'The selected PR could not be read. Check GitHub login and repository access.';
      } else {
        record.analysis = await (this.options.analyze ?? runAnalysis)(pkg, profile, { capture: record.capture, sourceRepository: record.selection.sourceRepository, directory: dirname(record.recordPath), signal: controller.signal, isCurrent: current,
          onProgress: async (phase, analysis) => { record.phase = phase; record.analysis = analysis; record.diagnostic = phase === 'sources' ? 'Reading pinned local Git objects. No fetch or checkout runs.' : `Running ${phase === 'classify' ? 'classification' : 'review'} with ${record.provider.provider}.`; await this.save(record); this.changed(); },
        });
        record.status = record.analysis.status; record.diagnostic = record.analysis.diagnostic;
        if (record.status === 'completed' && !controller.signal.aborted && current()) {
          record.phase = 'verify'; record.diagnostic = 'Checking whether the captured PR evidence is still current.'; this.changed();
          await this.verify(record, pkg, controller.signal);
          record.diagnostic = record.remote.status === 'current' ? 'Completed read-only analysis for the captured inputs.' : record.remote.status === 'stale' ? 'GitHub evidence changed during the trial. Start again for the current PR.' : 'Analysis completed, but current GitHub evidence could not be verified. Refresh evidence or start again.';
        }
      }
    } catch (error) {
      record.status = 'blocked'; record.diagnostic = error instanceof Error ? error.message : 'The trial could not retain its private inputs or results. Check the application data directory.';
    } finally {
      clearTimeout(timeout);
      if (controller.signal.aborted || !current()) {
        record.status = controller.signal.reason === 'timeout' ? 'timeout' : controller.signal.reason === 'cancelled' ? 'cancelled' : controller.signal.reason === 'superseded' || !current() ? 'superseded' : 'cancelled';
        record.invalidated ||= record.status === 'superseded';
        record.diagnostic = record.status === 'timeout' ? 'The trial reached its ten-minute deadline. Start again when ready.' : record.status === 'superseded' ? 'The selected inputs changed. Start again for the current draft, PR and provider.' : 'Trial cancelled. Captured evidence and completed analysis remain private.';
      }
      record.phase = 'finished'; record.finishedAt = new Date().toISOString();
      try { await this.save(record); } catch { record.diagnostic += ' The final trial summary could not be saved; any existing analysis files remain private.'; }
      this.changed();
    }
  }
  private async package(record: TrialRecord): Promise<WorkflowPackage> {
    const raw = await boundedJson(join(dirname(record.recordPath), 'package.json')) as WorkflowPackage;
    const pkg = buildPackage(raw.workflowPath, Object.fromEntries(raw.files.map(file => [file.path, file.text])));
    if (pkg.digest !== record.packageDigest) throw new Error('The retained workflow package does not match this trial.');
    return pkg;
  }
  private async verify(record: TrialRecord, pkg: WorkflowPackage, signal: AbortSignal): Promise<void> {
    record.remote = { status: 'unknown', checkedAt: new Date().toISOString(), headSha: null, baseSha: null };
    try {
      const observed = await this.inspect(pkg, record.selection, signal);
      const pr = observed.evidence.pullRequest;
      const changed = pr && (pr.headSha !== record.inspection?.headSha || pr.baseSha !== record.inspection?.baseSha);
      record.remote = { status: changed || observed.evidence.revision.status === 'changed' ? 'stale' : observed.status === 'unavailable' || observed.evidence.revision.status !== 'stable' ? 'unknown' : observed.evidenceDigest === record.inspection?.evidenceDigest ? 'current' : 'stale', checkedAt: new Date().toISOString(), headSha: pr?.headSha ?? null, baseSha: pr?.baseSha ?? null };
    } catch { /* A failed refresh keeps the completed analysis and clears current remote knowledge. */ }
  }
  async refresh(id: string): Promise<void> {
    if (this.active || this.refreshing) throw new Error('Wait for the current trial or read to finish first.');
    const record = this.records.find(item => item.id === id);
    if (!record?.inspection) throw new Error('Choose a retained trial with captured PR evidence.');
    const pending = { id, controller: new AbortController(), done: Promise.resolve() }; this.refreshing = pending;
    pending.done = (async () => {
      try { await this.verify(record, await this.package(record), pending.controller.signal); await this.save(record); }
      finally { this.refreshing = null; this.changed(); }
    })(); this.changed(); await pending.done;
  }
  async fixture(id: string): Promise<{ text: string; provenance: string }> {
    const record = this.records.find(item => item.id === id);
    if (!record?.capture || record.status === 'running') throw new Error('Choose a finished trial with a retained capture.');
    const pkg = await this.package(record), capture = await readCapture(record.capture, pkg);
    const fixture = parseFixture({ ...capture.fixture, results: Object.fromEntries(Object.entries(record.analysis?.results ?? {}).filter(([, result]) => result.outcome === 'completed').map(([id, result]) => [id, [{ status: 'success', payload: result.payload }]])) });
    return { text: `${JSON.stringify(fixture, null, 2)}\n`, provenance: `${JSON.stringify({ schemaVersion: 1, kind: 'explicit-live-trial-fixture-export', trial: record, fixtureDigest: digest(canonicalJson(fixture)), note: 'This copy is an offline fixture. Editing it does not alter the retained live evidence or establish a new provider run.' }, null, 2)}\n` };
  }
}
