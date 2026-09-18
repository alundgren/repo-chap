import { randomUUID } from 'node:crypto';
import { access, link, lstat, mkdir, open, realpath, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  actionRegistry, buildPackage, limits, loadWorkflow, parseJson, readFixtureText,
  referencePath, WorkflowError, parseFixture, replay, digest, compareReplay,
} from '@repo-chap/workflow';
import { previewReplayHandoffs } from '@repo-chap/slack';
import type { DecisionPacket } from '@repo-chap/slack';
import type { WorkflowPackage } from '@repo-chap/workflow';
import type { AuthoringContext, AuthoringOperation, AuthoringReceipt, AuthoringResponse } from './authoring-protocol.js';
import { parseAuthoringOperation } from './authoring-contract.ts';
import { editWorkflow, semanticChanges } from './authoring.ts';
import type { DocumentSnapshot, DocumentToken, EditorDiagnostic, SimulationInput, SimulationInputKind, SimulationRecord, SourceDocument, VisualEdit } from './protocol.js';

interface DirectoryIdentity { dev: number; ino: number }
const sameDirectory = (a: DirectoryIdentity, b: DirectoryIdentity): boolean => a.dev === b.dev && a.ino === b.ino;
async function existingEntry(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

interface DiskSource { target: string; text: string; mode: number }
interface BufferSource extends SourceDocument { saved: DiskSource | null; created?: boolean }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const within = (root: string, path: string): boolean => {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};
const message = (error: unknown): string => error instanceof Error ? error.message : 'File operation failed.';

export async function repositoryFor(file: string): Promise<string> {
  for (let directory = dirname(resolve(file)); ; directory = dirname(directory)) {
    try { await access(resolve(directory, '.git')); return directory; } catch { /* Try the next ancestor. */ }
    if (dirname(directory) === directory) return dirname(resolve(file));
  }
}

/** Owns one repository's source buffers. Revisions change only through explicit document operations. */
export class DocumentSession {
  readonly sessionId = randomUUID();
  revision = 0;
  private files = new Map<string, BufferSource>();
  private readOnlyReason: string | null = null;
  private savedTexts: Record<string, string> = Object.create(null);
  private inputs: Record<SimulationInputKind, (SimulationInput & { loadedText: string }) | null> = { fixture: null, packets: null };
  private simulation: SimulationRecord | null = null;
  private undoGroups: { path: string; source: BufferSource | null }[][] = [];
  private receipts = new Map<string, AuthoringResponse>();
  private creationDirectories: { root: DirectoryIdentity; metadata: DirectoryIdentity | null } | null = null;
  readonly repositoryRoot: string;
  readonly workflowPath: string;

  private constructor(repositoryRoot: string, workflowPath: string) {
    this.repositoryRoot = repositoryRoot;
    this.workflowPath = workflowPath;
  }

  static async open(file: string, repositoryRoot?: string): Promise<DocumentSession> {
    const root = await realpath(repositoryRoot ?? await repositoryFor(file));
    const absolute = resolve(file);
    if (!within(root, absolute)) throw new Error('Choose a workflow inside the selected repository.');
    const path = relative(root, absolute).split(sep).join('/');
    const session = new DocumentSession(root, path);
    // The shared loader checks a valid package. Invalid source still needs an editor recovery path.
    try {
      const pkg = await loadWorkflow(absolute, { repositoryRoot: root });
      for (const file of pkg.files) await session.add(file.path);
    } catch (error) {
      if (!(error instanceof WorkflowError)) throw error;
      await session.add(path);
    }
    if (session.files.get(path)?.saved === null) throw new Error(session.files.get(path)!.error!);
    await session.refreshReferences();
    session.setReadOnly();
    return session;
  }

  static async create(repositoryRoot: string): Promise<DocumentSession> {
    const root = await realpath(repositoryRoot);
    const info = await lstat(root);
    if (!info.isDirectory()) throw new Error('Choose a repository directory.');
    const session = new DocumentSession(root, '.repo-chap/workflow.json');
    const metadata = await existingEntry(resolve(root, '.repo-chap'));
    if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink())) throw new Error('.repo-chap must be a directory inside the repository.');
    session.creationDirectories = { root: info, metadata };
    await session.checkCreationDestination();
    const text = JSON.stringify({
      schemaVersion: 1, id: 'repository-pr', version: '0.1.0',
      settings: { newPrDelaySeconds: 120, headDebounceSeconds: 30, reviewWaitSeconds: 300, reviewDeadlineSeconds: 1800, mergeMode: 'human' },
      limits: { maxAttemptsPerHead: 1, maxRepairsPerLifecycle: 1, maxAgentActionsPerWake: 1, maxAttemptSeconds: 300, maxDailyCostUnits: 1 },
      requestedCapabilities: [], labels: [],
      rules: [{ id: 'closed', when: { any: [
        { field: 'facts.lifecycle', op: 'eq', value: 'closed' },
        { field: 'facts.lifecycle', op: 'eq', value: 'merged' },
      ] }, action: 'stop' }],
      otherwise: 'park',
      actions: {
        stop: { uses: 'control.close', execution: 'code', capabilities: [], onSuccess: '$closed', onFailure: '$blocked' },
        park: { uses: 'control.wait_signal', execution: 'code', capabilities: [], onSuccess: '$wait', onFailure: '$blocked' },
      },
    }, null, 2) + '\n';
    buildPackage(session.workflowPath, { [session.workflowPath]: text });
    session.files.set(session.workflowPath, { path: session.workflowPath, text, created: true, saved: null, dirty: true, external: false, error: null });
    return session;
  }

  get isNewWorkflow(): boolean { return !!this.files.get(this.workflowPath)?.created; }

  private async checkCreationDestination(): Promise<void> {
    const expected = this.creationDirectories;
    if (!expected) return;
    const root = await lstat(this.repositoryRoot);
    if (!root.isDirectory() || !sameDirectory(root, expected.root) || await realpath(this.repositoryRoot) !== this.repositoryRoot) throw new Error('The repository directory changed. Keep the draft and reopen the intended repository.');
    const path = resolve(this.repositoryRoot, '.repo-chap');
    const metadata = await existingEntry(path);
    if (expected.metadata ? !metadata || !metadata.isDirectory() || !sameDirectory(metadata, expected.metadata) : metadata !== null) throw new Error('The .repo-chap destination changed. Restore the original directory before saving.');
    if (metadata && await realpath(path) !== path) throw new Error('The .repo-chap directory must not redirect outside its original path.');
    if (await existingEntry(resolve(this.repositoryRoot, this.workflowPath))) throw new Error('The workflow destination already exists. Your draft has been kept; open the existing workflow separately.');
  }

  assertCurrent(token: DocumentToken): void {
    if (token?.sessionId !== this.sessionId || token.revision !== this.revision) {
      throw new Error('The document revision changed. Your newer draft has been kept; try the operation again.');
    }
  }

  get dirty(): boolean { return [...this.files.values()].some(file => file.dirty); }

  private async capture(path: string): Promise<DiskSource> {
    const normalized = referencePath('workflow.json', path);
    if (normalized.path !== path || normalized.fragment) throw new Error('Use a repository-relative file path.');
    const target = await realpath(resolve(this.repositoryRoot, path));
    if (!within(this.repositoryRoot, target)) throw new Error(`${path}: file resolves outside the repository.`);
    const text = await readFixtureText(target);
    const info = await stat(target);
    if (await realpath(resolve(this.repositoryRoot, path)) !== target) throw new Error(`${path}: file changed while reading. Reload it.`);
    return { target, text, mode: info.mode };
  }

  private async add(path: string): Promise<void> {
    if (this.files.has(path)) return;
    if (this.files.size >= limits.files) return;
    try {
      const saved = await this.capture(path);
      if ([...this.files.values()].reduce((sum, file) => sum + Buffer.byteLength(file.text), Buffer.byteLength(saved.text)) > limits.packageBytes) throw new Error('Source files exceed 8 MiB.');
      this.files.set(path, { path, text: saved.text, saved, dirty: false, external: false, error: null });
      this.savedTexts[path] = saved.text;
    } catch (error) {
      this.files.set(path, { path, text: '', saved: null, dirty: false, external: false, error: `Cannot read ${path}. ${message(error)}` });
    }
  }

  private references(): string[] | null {
    if (!this.files.has(this.workflowPath)) return null;
    try {
      const value = parseJson(this.files.get(this.workflowPath)!.text, this.workflowPath);
      if (!record(value) || !record(value.actions)) return null;
      const paths: string[] = [];
      for (const action of Object.values(value.actions)) {
        if (!record(action)) continue;
        for (const ref of [action.prompt, action.outputSchema, ...(Array.isArray(action.contextFiles) ? action.contextFiles : [])]) {
          if (typeof ref !== 'string') continue;
          try { paths.push(referencePath(this.workflowPath, ref).path); } catch { /* Shared validation reports invalid references. */ }
        }
      }
      return [...new Set(paths)];
    } catch { return null; }
  }

  private async refreshReferences(): Promise<void> {
    const references = this.references();
    if (!references) return;
    const needed = new Set([this.workflowPath, ...references]);
    // Keep removed references until their drafts have been saved or explicitly discarded.
    for (const [path, file] of this.files) if (!needed.has(path) && !file.dirty && file.kind !== 'fixture') this.files.delete(path);
    for (const path of references) await this.add(path);
  }

  private setReadOnly(): void {
    this.readOnlyReason = null;
    try {
      const value = parseJson(this.files.get(this.workflowPath)!.text, this.workflowPath);
      if (!record(value)) return;
      if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
        this.readOnlyReason = 'This workflow version is not supported. The original files are open read-only.';
      } else if (record(value.actions) && Object.values(value.actions).some(action => record(action) && typeof action.uses === 'string' && !Object.hasOwn(actionRegistry, action.uses))) {
        this.readOnlyReason = 'This workflow uses an unsupported action. The original files are open read-only.';
      }
    } catch { /* Invalid JSON remains editable for repair. */ }
  }

  private diagnosticFile(path: string): string {
    if (this.files.has(path)) return path;
    try {
      const resolved = referencePath(this.workflowPath, path).path;
      if (this.files.has(resolved)) return resolved;
    } catch { /* JSON paths and invalid references belong to the workflow source. */ }
    return this.workflowPath;
  }

  snapshot(): DocumentSnapshot {
    const texts: Record<string, string> = Object.create(null);
    for (const [path, file] of this.files) if ((file.saved || file.created) && file.kind !== 'fixture') texts[path] = file.text;
    let diagnostics: EditorDiagnostic[] = [];
    let packageDigest: string | null = null;
    let workflow: DocumentSnapshot['workflow'] = null;
    try { const pkg = buildPackage(this.workflowPath, texts); packageDigest = pkg.digest; workflow = pkg.workflow; }
    catch (error) {
      const items = error instanceof WorkflowError ? error.diagnostics : [{ code: 'validation', path: this.workflowPath, message: message(error) }];
      diagnostics = items.map(item => ({ ...item, file: this.diagnosticFile(item.path) }));
    }
    for (const file of this.files.values()) if (file.kind === 'fixture') {
      try { parseFixture(parseJson(file.text, file.path)); }
      catch (error) {
        const errors = error instanceof WorkflowError ? error.diagnostics : [{ code: 'fixture', path: file.path, message: message(error) }];
        diagnostics.push(...errors.map(item => ({ ...item, file: file.path })));
      }
    }
    const needed = new Set([this.workflowPath, ...this.references() ?? []]);
    for (const file of this.files.values()) if (file.error && needed.has(file.path)) {
      if (!diagnostics.some(item => item.file === file.path)) diagnostics.push({ code: 'file_read', path: file.path, file: file.path, message: file.error });
    }
    let changes: DocumentSnapshot['semanticChanges'] = [], semanticError: string | null = null;
    try { changes = this.isNewWorkflow ? [{ path: this.workflowPath, before: 'Not saved', after: 'New workflow' }] : semanticChanges(this.workflowPath, this.savedTexts, texts); }
    catch { semanticError = 'Repair the JSON source to compare execution changes against saved files.'; }
    const simulationInputs = Object.fromEntries(Object.entries(this.inputs).map(([kind, input]) => [kind, input ? { name: input.name, text: input.text, changed: input.changed } : null])) as DocumentSnapshot['simulationInputs'];
    return {
      sessionId: this.sessionId, revision: this.revision, repositoryRoot: this.repositoryRoot,
      workflowPath: this.workflowPath, isNewWorkflow: this.isNewWorkflow, readOnlyReason: this.readOnlyReason, diagnostics, packageDigest,
      files: [...this.files.values()].map(({ saved: _saved, created: _created, ...file }) => ({ ...file })),
      workflow, semanticChanges: changes, semanticError, simulationInputs, simulation: structuredClone(this.simulation),
      undoCount: this.undoGroups.length, authoringReceipts: [...this.receipts.values()].map(value => structuredClone(value.receipt)),
      simulationCurrent: !!this.simulation && this.simulation.packageDigest === packageDigest &&
        this.simulation.fixtureDigest === (this.simulation.fixturePath ? this.fixtureDigest(this.simulation.fixturePath) : this.inputDigest('fixture')) && this.simulation.packetsDigest === this.inputDigest('packets'),
    };
  }

  private package(token: DocumentToken): WorkflowPackage {
    this.assertCurrent(token);
    if (this.readOnlyReason) throw new Error(this.readOnlyReason);
    const snapshot = this.snapshot();
    if (!snapshot.packageDigest || snapshot.diagnostics.length) throw new Error('Fix the workflow validation errors before simulation or export. Your drafts are still here.');
    return buildPackage(this.workflowPath, Object.fromEntries([...this.files].filter(([, file]) => (file.saved || file.created) && file.kind !== 'fixture').map(([path, file]) => [path, file.text])));
  }

  async visualEdit(token: DocumentToken, edit: VisualEdit): Promise<void> {
    this.assertCurrent(token);
    await this.edit(token, this.workflowPath, editWorkflow(this.files.get(this.workflowPath)!.text, this.workflowPath, edit));
  }

  async reset(token: DocumentToken): Promise<void> {
    this.assertCurrent(token);
    for (const file of this.files.values()) {
      if (file.created) this.files.delete(file.path);
      else if (file.saved) { file.text = file.saved.text; file.dirty = false; }
    }
    this.undoGroups = [];
    this.revision++;
    await this.refreshReferences();
  }

  private inputKind(kind: SimulationInputKind): void {
    if (kind !== 'fixture' && kind !== 'packets') throw new Error('Choose fixture or packet input.');
  }

  private inputDigest(kind: SimulationInputKind): string | null {
    const input = this.inputs[kind];
    return input ? digest(input.text) : null;
  }

  setSimulationInput(token: DocumentToken, kind: SimulationInputKind, text: string, name?: string): void {
    this.assertCurrent(token);
    this.inputKind(kind);
    if (typeof text !== 'string' || Buffer.byteLength(text) > limits.fileBytes) throw new Error('Simulation input must fit within 1 MiB.');
    const previous = this.inputs[kind];
    if (name === undefined && !previous) throw new Error('Load a local simulation input first.');
    const loadedText = name === undefined ? previous!.loadedText : text;
    this.inputs[kind] = { name: name ?? previous!.name, text, loadedText, changed: text !== loadedText };
    this.revision++;
  }

  resetSimulationInput(token: DocumentToken, kind: SimulationInputKind): void {
    this.assertCurrent(token);
    this.inputKind(kind);
    const input = this.inputs[kind];
    if (input) this.setSimulationInput(token, kind, input.loadedText);
  }

  setClock(token: DocumentToken, now: string): void {
    this.assertCurrent(token);
    const input = this.inputs.fixture;
    if (!input) throw new Error('Load a fixture before changing fake time.');
    const fixture = parseFixture(parseJson(input.text, input.name));
    const next = { ...fixture, now };
    parseFixture(next);
    this.setSimulationInput(token, 'fixture', `${JSON.stringify(next, null, 2)}\n`);
  }

  simulate(token: DocumentToken): void {
    const pkg = this.package(token);
    const input = this.inputs.fixture;
    if (!input) throw new Error('Load a fictional or privately captured fixture first.');
    const fixture = parseFixture(parseJson(input.text, input.name));
    const result = replay(pkg, fixture);
    let handoffs: SimulationRecord['handoffs'] = [], previewError: string | null = null;
    try {
      const packets = this.inputs.packets ? parseJson(this.inputs.packets.text, this.inputs.packets.name) : [];
      handoffs = previewReplayHandoffs(result, (Array.isArray(packets) ? packets : [packets]) as DecisionPacket[], pkg.workflow.slack);
    } catch (error) { previewError = message(error); }
    this.simulation = { token: { sessionId: this.sessionId, revision: this.revision }, packageDigest: pkg.digest, fixtureDigest: this.inputDigest('fixture')!, packetsDigest: this.inputDigest('packets'), result, handoffs, previewError };
  }

  exportText(token: DocumentToken): string {
    this.package(token);
    return this.files.get(this.workflowPath)!.text;
  }

  async edit(token: DocumentToken, path: string, text: string): Promise<void> {
    await this.editDocuments(token, [{ path, text }]);
  }

  private remember(paths: string[]): void {
    const group = paths.map(path => ({ path, source: structuredClone(this.files.get(path) ?? null) }));
    if (Buffer.byteLength(JSON.stringify(group)) > limits.packageBytes) throw new Error('This undo group exceeds 8 MiB. Edit fewer files together.');
    this.undoGroups.push(group);
    while (this.undoGroups.length > 32 || this.undoGroups.length > 1 && Buffer.byteLength(JSON.stringify(this.undoGroups)) > limits.packageBytes) this.undoGroups.shift();
  }

  async editDocuments(token: DocumentToken, changes: { path: string; text: string }[]): Promise<void> {
    this.assertCurrent(token);
    if (this.readOnlyReason) throw new Error(this.readOnlyReason);
    if (!changes.length || new Set(changes.map(change => change.path)).size !== changes.length) throw new Error('Choose each target file once.');
    for (const { path, text } of changes) {
      const file = this.files.get(path);
      if (!file || file.error || !file.saved && !file.created) throw new Error('Choose a loaded readable source or fixture file.');
      if (typeof text !== 'string' || Buffer.byteLength(text) > limits.fileBytes) throw new Error('A source file must fit within 1 MiB. Your text has not been saved.');
    }
    const replacements = new Map(changes.map(change => [change.path, change.text]));
    if ([...this.files.values()].reduce((sum, file) => sum + Buffer.byteLength(replacements.get(file.path) ?? file.text), 0) > limits.packageBytes) throw new Error('The document session exceeds 8 MiB. Your text has not been saved.');
    this.remember(changes.map(change => change.path));
    for (const { path, text } of changes) { const file = this.files.get(path)!; file.text = text; file.dirty = file.created || text !== file.saved!.text; }
    this.revision++;
    await this.refreshReferences();
  }

  async undo(token: DocumentToken): Promise<void> {
    this.assertCurrent(token);
    const group = this.undoGroups.pop();
    if (!group) throw new Error('There is no draft operation to undo.');
    for (const { path, source } of group) {
      const file = this.files.get(path);
      if (source === null) { if (file?.created) this.files.delete(path); }
      else this.files.set(path, source);
    }
    this.revision++;
    await this.refreshReferences();
  }

  private fixtureDigest(path: string): string | null {
    const file = this.files.get(path);
    return file?.kind === 'fixture' ? digest(file.text) : null;
  }

  async createFixture(token: DocumentToken, path: string, text: string, signal?: AbortSignal): Promise<void> {
    this.assertCurrent(token);
    if (this.readOnlyReason) throw new Error(this.readOnlyReason);
    const normalized = referencePath('workflow.json', path);
    if (normalized.path !== path || normalized.fragment || !path.endsWith('.json')) throw new Error('Choose a repository-relative JSON fixture path.');
    if (this.files.has(path) || await lstat(resolve(this.repositoryRoot, path)).catch(() => null)) throw new Error('That path already exists. Edit its loaded buffer or choose a new fixture path.');
    const parent = await realpath(dirname(resolve(this.repositoryRoot, path)));
    if (!within(this.repositoryRoot, parent)) throw new Error('Keep fixtures inside the repository.');
    if (this.files.size >= limits.files || Buffer.byteLength(text) > limits.fileBytes || [...this.files.values()].reduce((sum, file) => sum + Buffer.byteLength(file.text), Buffer.byteLength(text)) > limits.packageBytes) throw new Error('The fixture exceeds the document session limits.');
    const fixture = parseFixture(parseJson(text, path));
    if (!fixture.expected) throw new Error('A test fixture needs explicit expected status, selectedRuleIds and proposedEffects.');
    this.assertCurrent(token);
    if (signal?.aborted) throw new Error('Cancelled before creating the fixture. Earlier applied edits remain in the draft.');
    this.remember([path]);
    this.files.set(path, { path, text, kind: 'fixture', created: true, saved: null, dirty: true, external: false, error: null });
    this.revision++;
  }

  async openTestFixture(token: DocumentToken, absolute: string): Promise<void> {
    this.assertCurrent(token);
    const path = relative(this.repositoryRoot, resolve(absolute)).split(sep).join('/');
    if (!within(this.repositoryRoot, resolve(absolute)) || this.files.has(path)) throw new Error('Choose a repository fixture that is not already open.');
    const saved = await this.capture(path);
    parseFixture(parseJson(saved.text, path));
    if (this.files.size >= limits.files || [...this.files.values()].reduce((sum, file) => sum + Buffer.byteLength(file.text), Buffer.byteLength(saved.text)) > limits.packageBytes) throw new Error('The fixture exceeds the document session limits.');
    this.assertCurrent(token);
    this.files.set(path, { path, text: saved.text, kind: 'fixture', saved, dirty: false, external: false, error: null });
    this.revision++;
  }

  testFixture(token: DocumentToken, path: string): SimulationRecord {
    const pkg = this.package(token), file = this.files.get(path);
    if (file?.kind !== 'fixture') throw new Error('Choose an authored fixture document.');
    const fixture = parseFixture(parseJson(file.text, path));
    if (!fixture.expected) throw new Error('Add explicit expectations before running this test.');
    const result = replay(pkg, fixture);
    this.simulation = { token: { sessionId: this.sessionId, revision: this.revision }, packageDigest: pkg.digest, fixtureDigest: digest(file.text), fixturePath: path, packetsDigest: this.inputDigest('packets'), result, comparison: compareReplay(result, fixture.expected), handoffs: [], previewError: null };
    try {
      const packets = this.inputs.packets ? parseJson(this.inputs.packets.text, this.inputs.packets.name) : [];
      this.simulation.handoffs = previewReplayHandoffs(result, (Array.isArray(packets) ? packets : [packets]) as DecisionPacket[], pkg.workflow.slack);
    } catch (error) { this.simulation.previewError = message(error); }
    return structuredClone(this.simulation);
  }

  authoringContext(): AuthoringContext {
    const snapshot = this.snapshot();
    const files: AuthoringContext['files'] = [];
    for (const file of snapshot.files) {
      const entry = { path: file.path, kind: file.kind ?? 'source' as const, digest: digest(file.text), dirty: file.dirty };
      if (Buffer.byteLength(JSON.stringify([...files, entry])) > 24 * 1024) break;
      files.push(entry);
    }
    return { token: { sessionId: this.sessionId, revision: this.revision }, workflowPath: this.workflowPath, packageDigest: snapshot.packageDigest,
      files, filesOmitted: snapshot.files.length - files.length };
  }

  authoringReceipt(id: string): AuthoringResponse | undefined {
    const previous = this.receipts.get(id);
    return previous ? { ...structuredClone(previous), context: this.authoringContext() } : undefined;
  }

  confirmDisplay(id: string): void { const response = this.receipts.get(id); if (response) response.receipt.display = 'confirmed'; }

  async author(value: unknown, signal?: AbortSignal): Promise<AuthoringResponse> {
    const operation = parseAuthoringOperation(value), previous = this.authoringReceipt(operation.operationId);
    if (previous) return previous;
    if (this.receipts.size >= 128) throw new Error('This document session reached 128 authoring receipts. Save and reopen the workflow to continue.');
    const before = { sessionId: this.sessionId, revision: this.revision };
    const receipt: AuthoringReceipt = { operationId: operation.operationId, kind: operation.action.kind, before, after: before, status: 'rejected', changedPaths: [], message: '', display: 'not-needed' };
    let data: unknown;
    try {
      if (signal?.aborted) { receipt.status = 'cancelled'; throw new Error('Cancelled before the operation. Earlier applied edits remain in the draft.'); }
      this.assertCurrent(operation.expected);
      const action = operation.action;
      if (action.kind === 'read') {
        data = action.paths.map(path => { const file = this.files.get(path); if (!file || file.error) throw new Error('Choose loaded readable source or fixture paths.'); return { path, text: file.text }; });
        if (Buffer.byteLength(JSON.stringify(data)) > 40 * 1024) throw new Error('Selected documents exceed the tool result limit. Read fewer files; full source stays in the editor.');
      } else if (action.kind === 'edit') {
        await this.editDocuments(operation.expected, action.changes); receipt.changedPaths = action.changes.map(change => change.path);
      } else if (action.kind === 'visual') {
        await this.visualEdit(operation.expected, action.edit); receipt.changedPaths = [this.workflowPath];
      } else if (action.kind === 'createFixture') {
        await this.createFixture(operation.expected, action.path, action.text, signal); receipt.changedPaths = [action.path];
      } else if (action.kind === 'test') data = this.testFixture(operation.expected, action.fixturePath);
      else data = { valid: this.snapshot().diagnostics.length === 0, diagnostics: this.snapshot().diagnostics };
      receipt.after = { sessionId: this.sessionId, revision: this.revision };
      receipt.status = receipt.changedPaths.length ? 'applied' : 'completed';
      receipt.display = receipt.status === 'applied' || action.kind === 'test' ? 'unconfirmed' : 'not-needed';
      receipt.message = receipt.status === 'applied' ? 'Applied to unsaved drafts. Save remains explicit; Undo reverses this operation.' : action.kind === 'test' ? `Offline test ${this.simulation!.comparison!.passed ? 'passed' : 'failed'}. No model, network or effect adapter ran.` : 'Operation completed.';
    } catch (error) { receipt.message = message(error); data = undefined; if (signal?.aborted && this.revision === before.revision) receipt.status = 'cancelled'; }
    const response: AuthoringResponse = { receipt, context: this.authoringContext(), ...(data === undefined ? {} : { data }) };
    if (Buffer.byteLength(JSON.stringify(response)) > 60 * 1024) response.data = { detailsOmitted: true, message: 'The complete result exceeds the provider result limit and remains visible in the editor.', ...(operation.action.kind === 'test' && this.simulation ? { token: this.simulation.token, packageDigest: this.simulation.packageDigest, fixtureDigest: this.simulation.fixtureDigest, status: this.simulation.result.status, passed: this.simulation.comparison?.passed } : {}) };
    this.receipts.set(receipt.operationId, structuredClone(response));
    return response;
  }

  async checkExternal(): Promise<void> {
    for (const file of this.files.values()) {
      if (file.created) { file.external = !!await lstat(resolve(this.repositoryRoot, file.path)).catch(() => null); continue; }
      try {
        const current = await this.capture(file.path);
        file.external = !file.saved || current.target !== file.saved.target || current.text !== file.saved.text;
      } catch { file.external = true; }
    }
  }

  async reload(token: DocumentToken, path: string): Promise<void> {
    this.assertCurrent(token);
    const file = this.files.get(path);
    if (!file) throw new Error('Choose a listed file.');
    const saved = await this.capture(path);
    Object.assign(file, { saved, text: saved.text, dirty: false, external: false, error: null });
    this.savedTexts[path] = saved.text;
    this.undoGroups = [];
    delete file.created;
    this.revision++;
    await this.refreshReferences();
    if (path === this.workflowPath) this.setReadOnly();
  }

  async discard(token: DocumentToken, path: string): Promise<void> {
    this.assertCurrent(token);
    const file = this.files.get(path);
    if (file?.created) { if (path === this.workflowPath) this.files.clear(); else this.files.delete(path); this.undoGroups = []; this.revision++; return; }
    if (!file?.saved) throw new Error('Choose a readable file.');
    this.undoGroups = [];
    file.text = file.saved.text;
    file.dirty = false;
    this.revision++;
    await this.refreshReferences();
  }

  async save(token: DocumentToken): Promise<void> {
    this.assertCurrent(token);
    if (this.readOnlyReason) throw new Error(this.readOnlyReason);
    const snapshot = this.snapshot();
    for (const file of this.files.values()) if (file.kind === 'fixture') parseFixture(parseJson(file.text, file.path));
    if (snapshot.diagnostics.length) throw new Error('Fix the validation errors before saving. Your drafts are still here.');
    if (this.isNewWorkflow) await this.checkCreationDestination();
    await this.checkExternal();
    if ([...this.files.values()].some(file => file.external)) throw new Error('Files changed on disk. Reload each changed file before saving; your drafts are still here.');
    const dirty = [...this.files.values()].filter(file => file.dirty).sort((a, b) => Number(a.path === this.workflowPath) - Number(b.path === this.workflowPath));
    const staged: { file: BufferSource; temporary: string }[] = [];
    let savedCount = 0;
    let createdDirectory: DirectoryIdentity | null = null;
    const metadataPath = resolve(this.repositoryRoot, '.repo-chap');
    try {
      if (this.isNewWorkflow && this.creationDirectories && !this.creationDirectories.metadata) {
        await mkdir(metadataPath);
        createdDirectory = await lstat(metadataPath);
        this.creationDirectories.metadata = createdDirectory;
      }
      if (this.isNewWorkflow) await this.checkCreationDestination();
      for (const file of dirty) {
        if (dirty.some(other => other !== file && other.saved?.target === file.saved?.target && !!file.saved)) throw new Error('Two edited references point to the same file. Reload one of them before saving.');
        const temporary = resolve(dirname(file.saved?.target ?? resolve(this.repositoryRoot, file.path)), `.repo-chap-${randomUUID()}.tmp`);
        const handle = await open(temporary, 'wx', (file.saved?.mode ?? 0o644) & 0o777);
        staged.push({ file, temporary });
        try { await handle.writeFile(file.text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      }
      await this.checkExternal();
      if ([...this.files.values()].some(file => file.external)) throw new Error('Files changed while preparing the save. Reload the changed files before saving.');
      for (const { file, temporary } of staged) {
        if (this.isNewWorkflow) await this.checkCreationDestination();
        const current = file.created ? null : await this.capture(file.path);
        if (current && (current.text !== file.saved!.text || current.target !== file.saved!.target)) {
          file.external = true;
          throw new Error(`${file.path} changed on disk. Reload it before saving.`);
        }
        if (file.created) {
          const target = resolve(this.repositoryRoot, file.path);
          if (await realpath(dirname(target)) !== dirname(target)) throw new Error('The fixture parent directory changed. Reload before saving.');
          await link(temporary, target);
          file.saved = { target, text: file.text, mode: 0o644 }; delete file.created;
          if (file.path === this.workflowPath) this.creationDirectories = null;
        } else { await rename(temporary, file.saved!.target); file.saved = { ...file.saved!, text: file.text }; }
        this.savedTexts[file.path] = file.text;
        file.dirty = false;
        savedCount++;
      }
    } catch (error) {
      throw new Error(`${savedCount ? `Saved ${savedCount} of ${dirty.length} files. ` : ''}${message(error)} Remaining drafts have been kept.`);
    } finally {
      for (const { temporary } of staged) await rm(temporary, { force: true }).catch(() => {});
      if (createdDirectory && this.isNewWorkflow) {
        try {
          const root = await lstat(this.repositoryRoot), directory = await lstat(metadataPath);
          if (sameDirectory(root, this.creationDirectories!.root) && sameDirectory(directory, createdDirectory) && directory.isDirectory() && await realpath(metadataPath) === metadataPath) {
            await rmdir(metadataPath);
            this.creationDirectories!.metadata = null;
          }
        } catch { /* Keep directories that changed or gained content. */ }
      }
      if (savedCount) { this.undoGroups = []; this.revision++; await this.refreshReferences(); }
    }
  }
}
