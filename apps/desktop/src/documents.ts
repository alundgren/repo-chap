import { randomUUID } from 'node:crypto';
import { access, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  actionRegistry, buildPackage, limits, loadWorkflow, parseJson, readFixtureText,
  referencePath, WorkflowError,
} from '@repo-chap/workflow';
import type { DocumentSnapshot, DocumentToken, EditorDiagnostic, SourceDocument } from './protocol.js';

interface DiskSource { target: string; text: string; mode: number }
interface BufferSource extends SourceDocument { saved: DiskSource | null }
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
    } catch (error) {
      this.files.set(path, { path, text: '', saved: null, dirty: false, external: false, error: `Cannot read ${path}. ${message(error)}` });
    }
  }

  private references(): string[] | null {
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
    for (const [path, file] of this.files) if (!needed.has(path) && !file.dirty) this.files.delete(path);
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

  snapshot(): DocumentSnapshot {
    const texts: Record<string, string> = Object.create(null);
    for (const [path, file] of this.files) if (file.saved) texts[path] = file.text;
    let diagnostics: EditorDiagnostic[] = [];
    let packageDigest: string | null = null;
    try { packageDigest = buildPackage(this.workflowPath, texts).digest; }
    catch (error) {
      const items = error instanceof WorkflowError ? error.diagnostics : [{ code: 'validation', path: this.workflowPath, message: message(error) }];
      diagnostics = items.map(item => ({ ...item, file: this.files.has(item.path) ? item.path : this.workflowPath }));
    }
    const needed = new Set([this.workflowPath, ...this.references() ?? []]);
    for (const file of this.files.values()) if (file.error && needed.has(file.path)) {
      if (!diagnostics.some(item => item.file === file.path)) diagnostics.push({ code: 'file_read', path: file.path, file: file.path, message: file.error });
    }
    return {
      sessionId: this.sessionId, revision: this.revision, repositoryRoot: this.repositoryRoot,
      workflowPath: this.workflowPath, readOnlyReason: this.readOnlyReason, diagnostics, packageDigest,
      files: [...this.files.values()].map(({ saved: _saved, ...file }) => ({ ...file })),
    };
  }

  async edit(token: DocumentToken, path: string, text: string): Promise<void> {
    this.assertCurrent(token);
    if (this.readOnlyReason) throw new Error(this.readOnlyReason);
    const file = this.files.get(path);
    if (!file?.saved) throw new Error('Reload the file after correcting its read error.');
    if (typeof text !== 'string' || Buffer.byteLength(text) > limits.fileBytes) throw new Error('A source file must fit within 1 MiB. Your text has not been saved.');
    const total = [...this.files.values()].reduce((sum, item) => sum + Buffer.byteLength(item === file ? text : item.text), 0);
    if (total > limits.packageBytes) throw new Error('The document session exceeds 8 MiB. Your text has not been saved.');
    file.text = text;
    file.dirty = text !== file.saved.text;
    this.revision++;
    await this.refreshReferences();
  }

  async checkExternal(): Promise<void> {
    for (const file of this.files.values()) {
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
    this.revision++;
    await this.refreshReferences();
    if (path === this.workflowPath) this.setReadOnly();
  }

  async discard(token: DocumentToken, path: string): Promise<void> {
    this.assertCurrent(token);
    const file = this.files.get(path);
    if (!file?.saved) throw new Error('Choose a readable file.');
    file.text = file.saved.text;
    file.dirty = false;
    this.revision++;
    await this.refreshReferences();
  }

  async save(token: DocumentToken): Promise<void> {
    this.assertCurrent(token);
    if (this.readOnlyReason) throw new Error(this.readOnlyReason);
    const snapshot = this.snapshot();
    if (snapshot.diagnostics.length) throw new Error('Fix the validation errors before saving. Your drafts are still here.');
    await this.checkExternal();
    if ([...this.files.values()].some(file => file.external)) throw new Error('Files changed on disk. Reload each changed file before saving; your drafts are still here.');
    const dirty = [...this.files.values()].filter(file => file.dirty).sort((a, b) => Number(a.path === this.workflowPath) - Number(b.path === this.workflowPath));
    const staged: { file: BufferSource; temporary: string }[] = [];
    let savedCount = 0;
    try {
      for (const file of dirty) {
        if (dirty.some(other => other !== file && other.saved!.target === file.saved!.target)) throw new Error('Two edited references point to the same file. Reload one of them before saving.');
        const temporary = resolve(dirname(file.saved!.target), `.repo-chap-${randomUUID()}.tmp`);
        const handle = await open(temporary, 'wx', file.saved!.mode & 0o777);
        staged.push({ file, temporary });
        try { await handle.writeFile(file.text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      }
      await this.checkExternal();
      if ([...this.files.values()].some(file => file.external)) throw new Error('Files changed while preparing the save. Reload the changed files before saving.');
      for (const { file, temporary } of staged) {
        const current = await this.capture(file.path);
        if (current.text !== file.saved!.text || current.target !== file.saved!.target) {
          file.external = true;
          throw new Error(`${file.path} changed on disk. Reload it before saving.`);
        }
        await rename(temporary, file.saved!.target);
        file.saved = { ...file.saved!, text: file.text };
        file.dirty = false;
        savedCount++;
      }
    } catch (error) {
      throw new Error(`${savedCount ? `Saved ${savedCount} of ${dirty.length} files. ` : ''}${message(error)} Remaining drafts have been kept.`);
    } finally {
      for (const { temporary } of staged) await rm(temporary, { force: true }).catch(() => {});
      if (savedCount) { this.revision++; await this.refreshReferences(); }
    }
  }
}
