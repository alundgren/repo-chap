import { canonicalJson, digest } from '@repo-chap/workflow';
import { createHash } from 'node:crypto';
import { runProcess } from './process.js';

export interface SourceFile {
  path: string; side: 'base' | 'head'; revision: string; blob: string; digest: string; text: string; lines: number;
}
export interface SourceBundle {
  schemaVersion: 1; headSha: string; baseSha: string; comparisonBaseSha: string | null;
  diff: { text: string; digest: string } | null; files: SourceFile[];
  missingEvidence: string[]; digest: string;
}
export const sourceLimits = { timeoutMs: 30_000, filesPerRevision: 256, fileBytes: 256 * 1024, totalBytes: 4 * 1024 * 1024, diffBytes: 1024 * 1024 };

export async function collectSources(repository: string, headSha: string, baseSha: string, signal?: AbortSignal): Promise<SourceBundle> {
  if (![headSha, baseSha].every(sha => /^[a-f0-9]{40}$/.test(sha))) throw new Error('Source revisions must be full Git commit IDs.');
  const started = Date.now(); let total = 0;
  const missingEvidence: string[] = [], files: SourceFile[] = [];
  const git = (args: string[], maxBytes: number) => runProcess('git', ['--no-replace-objects', '-c', 'core.quotePath=false', ...args],
    { cwd: repository, timeoutMs: sourceLimits.timeoutMs - (Date.now() - started), maxBytes, signal,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' } });
  let comparisonBaseSha: string | null = null, diff: SourceBundle['diff'] = null;
  const mergeBase = await git(['merge-base', baseSha, headSha], 1024);
  if (mergeBase.status === 'exited' && mergeBase.exitCode === 0 && /^[a-f0-9]{40}$/.test(mergeBase.stdout.toString().trim())) comparisonBaseSha = mergeBase.stdout.toString().trim();
  else missingEvidence.push('Cannot read a common ancestor for the captured head/base. Fetch both commits into --source-repo and inspect again.');
  if (comparisonBaseSha) {
    const result = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', comparisonBaseSha, headSha, '--'], sourceLimits.diffBytes);
    if (result.status === 'exited' && result.exitCode === 0) {
      try { const text = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout); diff = { text, digest: digest(text) }; }
      catch { missingEvidence.push('The captured change list contains non-UTF-8 paths.'); }
    } else missingEvidence.push('The complete diff is unavailable or exceeds its byte/time limit.');
    for (const [side, revision] of [['base', comparisonBaseSha], ['head', headSha]] as const) {
      const tree = await git(['ls-tree', '-rlz', '--full-tree', revision], sourceLimits.diffBytes);
      if (tree.status !== 'exited' || tree.exitCode !== 0) { missingEvidence.push(`The ${side} file list is unavailable or exceeds its byte/time limit.`); continue; }
      let entries: string[];
      try { entries = new TextDecoder('utf-8', { fatal: true }).decode(tree.stdout).split('\0').filter(Boolean); }
      catch { missingEvidence.push(`The ${side} file list contains non-UTF-8 paths.`); continue; }
      if (entries.length > sourceLimits.filesPerRevision) missingEvidence.push(`The ${side} tree exceeds ${sourceLimits.filesPerRevision} files; later paths were omitted.`);
      for (const entry of entries.slice(0, sourceLimits.filesPerRevision)) {
        const match = /^(\d+) (\w+) ([a-f0-9]{40}) +([\d-]+)\t(.+)$/.exec(entry);
        if (!match) { missingEvidence.push(`An unreadable ${side} tree entry was omitted.`); continue; }
        const [, mode, type, blob, size, path] = match as unknown as [string, string, string, string, string, string];
        if (!/^(100644|100755)$/.test(mode) || type !== 'blob') { missingEvidence.push(`${side}:${path}: symlink or submodule content is unavailable.`); continue; }
        if (/[\x00-\x1f\x7f]/.test(path) || path.startsWith('/') || path.split('/').some(p => p === '..')) { missingEvidence.push(`An unsupported ${side} source path was omitted.`); continue; }
        if (Number(size) > sourceLimits.fileBytes || total + Number(size) > sourceLimits.totalBytes) { missingEvidence.push(`${side}:${path}: source byte limit reached.`); continue; }
        const content = await git(['cat-file', 'blob', blob], sourceLimits.fileBytes);
        if (content.status !== 'exited' || content.exitCode !== 0) { missingEvidence.push(`${side}:${path}: source could not be read within the deadline.`); continue; }
        try {
          const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content.stdout);
          if (text.includes('\0')) throw new Error('binary');
          total += content.stdout.length;
          files.push({ path, side, revision, blob, text, digest: digest(text), lines: text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0 });
        } catch { missingEvidence.push(`${side}:${path}: binary or non-UTF-8 content is unavailable.`); }
      }
    }
  }
  const body = { schemaVersion: 1 as const, headSha, baseSha, comparisonBaseSha, diff, files, missingEvidence };
  return { ...body, digest: digest(canonicalJson(body)) };
}

export function validateSourceBundle(source: SourceBundle): void {
  const { digest: expected, ...body } = source;
  if (expected !== digest(canonicalJson(body)) || source.diff && source.diff.digest !== digest(source.diff.text)) throw new Error('Source bundle digest mismatch.');
  const names = new Set<string>();
  for (const file of source.files) {
    const key = `${file.side}:${file.path}`;
    const blob = createHash('sha1').update(`blob ${Buffer.byteLength(file.text)}\0`).update(file.text).digest('hex');
    const lines = file.text ? file.text.split('\n').length - (file.text.endsWith('\n') ? 1 : 0) : 0;
    if (names.has(key) || file.digest !== digest(file.text) || file.blob !== blob || file.lines !== lines || file.revision !== (file.side === 'head' ? source.headSha : source.comparisonBaseSha)) throw new Error('Source file identity mismatch.');
    names.add(key);
  }
}

export function validateCitations(payload: unknown, source: SourceBundle): void {
  const pending: unknown[] = [payload];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) { pending.push(...item); continue; }
    const value = item as Record<string, unknown>;
    if ('startLine' in value || 'endLine' in value) {
      const file = source.files.find(file => file.path === value.path && file.side === value.side);
      if (!file || !Number.isSafeInteger(value.startLine) || !Number.isSafeInteger(value.endLine) || Number(value.startLine) < 1 || Number(value.endLine) < Number(value.startLine) || Number(value.endLine) > file.lines)
        throw new Error('A source citation does not match a pinned file, side, or line range.');
    }
    pending.push(...Object.values(value));
  }
}
