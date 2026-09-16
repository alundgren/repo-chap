import { canonicalJson, digest, validateActionPayload, type WorkflowPackage } from '@repo-chap/workflow';
import { validateCitations, validateSourceBundle, type SourceBundle } from '@repo-chap/providers';
import { validateTarget, type Inspection, type LabelPublication, type PublicationTarget, type ReviewPublication } from '@repo-chap/github';
import type { AnalysisResult, RunRecord } from './types.js';
import { RuntimeError } from './artifacts.js';

interface Citation { path: string; side: 'base' | 'head'; startLine: number; endLine: number; explanation: string }
interface ReviewPayload {
  schemaVersion: 1; headSha: string; baseSha: string; summary: string;
  coverage: ReviewPublication['analysis']['coverage']; verdict: ReviewPublication['analysis']['verdict']; missingEvidence: string[];
  findings: { id: string; kind: string; severity: string; confidence: number; title: string; reason: string; evidence: Citation[] }[];
}
interface ClassificationPayload {
  schemaVersion: 1; headSha: string; labels: { name: string; reason: string; evidence: Citation[] }[]; uncertain: boolean;
}
export interface PublicationInput {
  run: Pick<RunRecord, 'id' | 'repositoryId' | 'subjectId' | 'number' | 'headSha' | 'baseSha' | 'packageDigest' | 'evidenceKey' | 'control'>;
  result: AnalysisResult; package: WorkflowPackage; inspection: Inspection; sources: SourceBundle;
}
function validateInput(input: PublicationInput, uses: 'agent.review' | 'agent.classify'): PublicationTarget {
  const { run, result, package: pkg, sources, inspection } = input, job = result.job, pr = inspection.evidence.pullRequest, repo = inspection.evidence.repository;
  if (result.schemaVersion !== 1 || result.provider.outcome !== 'completed' || !pr || !repo ||
    job.runId !== run.id || job.repositoryId !== run.repositoryId || repo.id !== run.repositoryId || job.subjectId !== run.subjectId || pr.id !== run.subjectId || pr.number !== run.number ||
    pkg.digest !== run.packageDigest || job.packageDigest !== run.packageDigest || inspection.packageDigest !== run.packageDigest ||
    job.package.digest !== digest(canonicalJson(pkg)) || job.inspection.digest !== digest(canonicalJson(inspection)) || job.sources.digest !== digest(canonicalJson(sources)) ||
    pkg.workflow.actions[job.actionId]?.uses !== uses || job.evidenceKey !== run.evidenceKey ||
    inspection.evidenceDigest !== digest(canonicalJson(inspection.evidence)) ||
    run.evidenceKey !== digest(canonicalJson({ head: pr.headSha, base: pr.baseSha, evidence: inspection.evidenceDigest })) ||
    job.headSha !== run.headSha || job.baseSha !== run.baseSha || sources.headSha !== run.headSha || sources.baseSha !== run.baseSha || pr.headSha !== run.headSha || pr.baseSha !== run.baseSha ||
    inspection.evidence.revision.status !== 'stable' || pr.lifecycle !== 'open' || pr.draft ||
    run.control.memory?.[uses === 'agent.review' ? 'reviewCurrent' : 'classificationCurrent'] !== true)
    throw new RuntimeError('Publication requires a completed, current analysis result with its pinned workflow, observation, and source revisions.');
  validateTarget(repo.name, pr.number);
  validateSourceBundle(sources); validateActionPayload(pkg, job.actionId, result.provider.payload); validateCitations(result.provider.payload, sources);
  if (!sources.diff || !sources.comparisonBaseSha) throw new RuntimeError('Publication requires the captured diff and its common ancestor. The analysis remains local.');
  const payload = result.provider.payload as { headSha: string; baseSha?: string };
  if (payload.headSha !== pr.headSha || payload.baseSha && payload.baseSha !== pr.baseSha) throw new RuntimeError('Publication result belongs to another revision.');
  return { repository: repo.name, repositoryId: repo.id, pullRequestId: pr.id, number: pr.number, headSha: pr.headSha, baseSha: pr.baseSha };
}
function pathName(text: string, prefix: 'a/' | 'b/'): string | null {
  if (text === '/dev/null') return null;
  let path = text;
  if (path.startsWith('"')) {
    if (!path.endsWith('"')) throw new RuntimeError('The pinned diff contains an unsupported file header.');
    const values: number[] = [];
    const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
    for (let index = 1; index < path.length - 1;) {
      if (path[index] !== '\\') {
        const point = path.codePointAt(index)!; values.push(...Buffer.from(String.fromCodePoint(point))); index += point > 0xffff ? 2 : 1; continue;
      }
      index++;
      const octal = /^[0-7]{1,3}/.exec(path.slice(index));
      if (octal) { values.push(Number.parseInt(octal[0], 8)); index += octal[0].length; }
      else { const value = escapes[path[index++]!]; if (value === undefined) throw new RuntimeError('The pinned diff contains an unsupported path escape.'); values.push(value); }
    }
    path = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(values));
  }
  if (!path.startsWith(prefix)) throw new RuntimeError('The pinned diff contains an unsupported file header.');
  return path.slice(2);
}
function diffLines(source: SourceBundle): Map<string, Set<number>> {
  const mapped = new Map<string, Set<number>>();
  let base: string | null = null, head: string | null = null, oldLine = 0, newLine = 0, oldLeft = 0, newLeft = 0;
  const remember = (side: 'base' | 'head', path: string | null, line: number) => {
    if (path === null) throw new RuntimeError('The pinned diff has a line without a file identity.');
    const key = `${side}:${path}`, lines = mapped.get(key) ?? new Set<number>(); lines.add(line); mapped.set(key, lines);
  };
  for (const line of source.diff!.text.split('\n')) {
    if (oldLeft || newLeft) {
      if (line.startsWith('\\ No newline at end of file')) continue;
      if (line[0] === ' ' || line[0] === '-') { if (!oldLeft--) throw new RuntimeError('The pinned diff hunk is incomplete.'); remember('base', base, oldLine++); }
      if (line[0] === ' ' || line[0] === '+') { if (!newLeft--) throw new RuntimeError('The pinned diff hunk is incomplete.'); remember('head', head, newLine++); }
      if (![' ', '-', '+'].includes(line[0] ?? '')) throw new RuntimeError('The pinned diff hunk is incomplete.');
    } else if (line.startsWith('diff --git ')) { base = null; head = null; }
    else if (line.startsWith('--- ')) base = pathName(line.slice(4), 'a/');
    else if (line.startsWith('+++ ')) head = pathName(line.slice(4), 'b/');
    else if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) throw new RuntimeError('The pinned diff hunk is unsupported.');
      oldLine = Number(match[1]); newLine = Number(match[3]); oldLeft = Number(match[2] ?? 1); newLeft = Number(match[4] ?? 1);
    }
  }
  if (oldLeft || newLeft) throw new RuntimeError('The pinned diff hunk is incomplete.');
  return mapped;
}
function validateDiffCitations(citations: Citation[], sources: SourceBundle): void {
  const mapped = diffLines(sources);
  for (const citation of citations) {
    const lines = mapped.get(`${citation.side}:${citation.path}`);
    for (let line = citation.startLine; line <= citation.endLine; line++) if (!lines?.has(line))
      throw new RuntimeError(`Cannot publish citation ${citation.path}:${citation.startLine}-${citation.endLine} on the ${citation.side} side. It is outside the pinned diff. The complete analysis remains local.`);
  }
}
function marker(input: PublicationInput, target: PublicationTarget, kind: 'review.publish' | 'labels.set', payload: unknown): string {
  const identity = { runId: input.run.id, target, kind, comparisonBaseSha: input.sources.comparisonBaseSha, diffDigest: input.sources.diff!.digest, payload };
  return `<!-- repo-chap:${kind}:${digest(canonicalJson(identity)).slice(7)} -->`;
}
function text(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('@', '&#64;').replaceAll('\r', '').replace(/[\\`*_[\]#]/g, '\\$&');
}
function citationLink(target: PublicationTarget, source: SourceBundle, citation: Citation): string {
  const revision = citation.side === 'head' ? source.headSha : source.comparisonBaseSha;
  const path = citation.path.split('/').map(encodeURIComponent).join('/');
  const lines = citation.startLine === citation.endLine ? `L${citation.startLine}` : `L${citation.startLine}-L${citation.endLine}`;
  return `[${text(citation.path)}:${citation.startLine}-${citation.endLine} ${citation.side}](https://github.com/${target.repository}/blob/${revision}/${path}#${lines})`;
}
export function prepareReviewPublication(input: PublicationInput): ReviewPublication {
  const target = validateInput(input, 'agent.review'), payload = input.result.provider.payload as ReviewPayload;
  const omissions = [...input.sources.missingEvidence, ...(input.inspection.status === 'complete' ? [] : ['GitHub evidence is incomplete.'])];
  if (new Set(payload.findings.map(finding => finding.id)).size !== payload.findings.length ||
    payload.coverage === 'partial' && !payload.missingEvidence.length || payload.coverage === 'complete' && payload.missingEvidence.length ||
    payload.verdict === 'acceptable' && (payload.coverage !== 'complete' || payload.findings.length) ||
    omissions.length && (payload.coverage !== 'partial' || payload.verdict !== 'inconclusive' || omissions.some(item => !payload.missingEvidence.includes(item))))
    throw new RuntimeError('Review coverage or verdict contradicts its retained findings or missing evidence. The complete analysis remains local.');
  validateDiffCitations(payload.findings.flatMap(finding => finding.evidence), input.sources);
  const semanticMarker = marker(input, target, 'review.publish', payload);
  const body = [
    '## Repo Chap review',
    `Reviewed commit [${target.headSha}](https://github.com/${target.repository}/commit/${target.headSha}).`,
    `Evidence: ${payload.coverage}. Verdict: ${payload.verdict}.`,
    'This comment review does not approve or merge the PR.', text(payload.summary),
    ...(payload.missingEvidence.length ? ['### Missing evidence', ...payload.missingEvidence.map(item => `- ${text(item)}`)] : []),
    ...payload.findings.flatMap(finding => [`### ${text(finding.severity)}: ${text(finding.title)}`, text(finding.reason),
      ...finding.evidence.map(citation => `- ${citationLink(target, input.sources, citation)}: ${text(citation.explanation)}`)]),
    semanticMarker,
  ].join('\n\n');
  if (Buffer.byteLength(body) > 60 * 1024) throw new RuntimeError('The complete review exceeds the publication size limit. It remains local without truncation.');
  return { schemaVersion: 1, kind: 'review.publish', target, marker: semanticMarker, body,
    analysis: { coverage: payload.coverage, verdict: payload.verdict, missingEvidence: [...payload.missingEvidence] } };
}
export function prepareLabelPublication(input: PublicationInput): LabelPublication {
  const target = validateInput(input, 'agent.classify'), payload = input.result.provider.payload as ClassificationPayload;
  const names = payload.labels.map(label => label.name);
  if (new Set(names).size !== names.length || names.some(name => !input.package.workflow.labels.includes(name)))
    throw new RuntimeError('Classification labels must be unique names from the pinned workflow configuration.');
  if (payload.uncertain || input.sources.missingEvidence.length || input.inspection.status !== 'complete')
    throw new RuntimeError('Uncertain classification cannot publish labels. Its evidence remains local.');
  validateDiffCitations(payload.labels.flatMap(label => label.evidence), input.sources);
  return { schemaVersion: 1, kind: 'labels.set', target, marker: marker(input, target, 'labels.set', [...names].sort()), labels: [...names].sort() };
}
