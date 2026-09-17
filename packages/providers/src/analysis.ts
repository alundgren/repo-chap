import { mkdtemp, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareCaptureDirectory, readCapture } from '@repo-chap/github';
import { canonicalJson, digest, evaluate, parseJson, type ControlState, type WorkflowPackage } from '@repo-chap/workflow';
import { collectSources } from './sources.js';
import { runProvider } from './provider.js';
import type { Outcome, ProviderProfile, ProviderResult, SessionIdentity } from './types.js';

export interface AnalysisRecord {
  schemaVersion: 1; status: 'running' | Outcome; decision: 'incomplete' | 'concerns' | 'analysis_acceptable';
  packageDigest: string; evidenceDigest: string; fixtureDigest: string; sourceDigest: string | null;
  repositoryId: string | null; pullRequestId: string | null; headSha: string | null; baseSha: string | null; comparisonBaseSha: string | null;
  startedAt: string; finishedAt: string | null; missingEvidence: string[]; diagnostic: string;
  control: ControlState; results: Record<string, ProviderResult>; workflowDecision?: ReturnType<typeof evaluate>;
}
async function immutableFile(path: string, text: string): Promise<void> {
  try { await writeFile(path, text, { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(path, 'utf8') !== text) throw new Error('Private pinned inputs changed. Choose a new output directory.');
  }
}
async function readResume(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat(), maximum = 32 * 1024 * 1024;
    if (!info.isFile() || info.size > maximum) throw new Error('Resume requires a regular decision file below 32 MiB.');
    const buffer = Buffer.alloc(maximum + 1); let length = 0;
    while (length < buffer.length) {
      const chunk = await handle.read(buffer, length, buffer.length - length, null);
      if (!chunk.bytesRead) break; length += chunk.bytesRead;
    }
    if (length > maximum) throw new Error('Resume decision exceeds 32 MiB.');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await handle.close(); }
}
export interface AnalysisOptions {
  capture: string; sourceRepository: string; directory: string; resume?: string;
  signal?: AbortSignal; isCurrent?: () => boolean | Promise<boolean>;
  onProgress?: (phase: 'sources' | 'classify' | 'review', record: AnalysisRecord & { recordPath: string }) => void | Promise<void>;
}
export async function runAnalysis(pkg: WorkflowPackage, profile: ProviderProfile, options: AnalysisOptions): Promise<AnalysisRecord & { recordPath: string }> {
  pkg = structuredClone(pkg); profile = structuredClone(profile); options = { ...options };
  const interrupted = (): Outcome => options.signal?.reason === 'superseded' ? 'superseded' : options.signal?.reason === 'timeout' ? 'timeout' : 'cancelled';
  const root = await prepareCaptureDirectory(options.directory);
  const inspection = await readCapture(options.capture, pkg);
  const pr = inspection.evidence.pullRequest;
  const directory = await mkdtemp(join(root, 'analysis-')), recordPath = join(directory, 'decision.json');
  const control: ControlState = { memory: { classificationCurrent: false, reviewCurrent: false, packetCurrent: false } };
  const record: AnalysisRecord = { schemaVersion: 1, status: 'running', decision: 'incomplete', packageDigest: pkg.digest,
    evidenceDigest: inspection.evidenceDigest, fixtureDigest: digest(canonicalJson(inspection.fixture)), sourceDigest: null,
    repositoryId: inspection.evidence.repository?.id ?? null, pullRequestId: pr?.id ?? null, headSha: pr?.headSha ?? null, baseSha: pr?.baseSha ?? null, comparisonBaseSha: null,
    startedAt: new Date().toISOString(), finishedAt: null, missingEvidence: [], diagnostic: 'Analysis started; earlier readiness is not reused.', control, results: {} };
  const save = async () => { const temporary = join(directory, 'decision.pending'); await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, recordPath); };
  await save();
  try {
    if (options.signal?.aborted) {
      record.status = interrupted(); record.diagnostic = 'Analysis stopped before source collection.';
    } else if (!pr || inspection.evidence.revision.status !== 'stable') {
      record.status = inspection.evidence.revision.status === 'changed' ? 'superseded' : 'blocked';
      record.diagnostic = 'Captured revisions are unavailable or no longer stable. Inspect again before analysis.';
    } else {
      await options.onProgress?.('sources', { ...structuredClone(record), recordPath });
      const source = await collectSources(options.sourceRepository, pr.headSha, pr.baseSha, options.signal);
      record.sourceDigest = source.digest; record.comparisonBaseSha = source.comparisonBaseSha;
      record.missingEvidence = [...source.missingEvidence];
      if (inspection.status !== 'complete') record.missingEvidence.push('The GitHub capture has partial or unknown metadata, checks, reviews, or discussion evidence.');
      const inputId = digest(canonicalJson({ source: source.digest, evidence: inspection.evidenceDigest, fixture: record.fixtureDigest, package: pkg.digest })).slice(7);
      const inputs = await prepareCaptureDirectory(join(root, `inputs-${inputId}`));
      await immutableFile(join(inputs, 'sources.json'), canonicalJson(source));
      await immutableFile(join(inputs, 'evidence.json'), canonicalJson(inspection.evidence));
      await immutableFile(join(inputs, 'package.json'), canonicalJson(pkg));
      let prior: Record<string, ProviderResult> = {};
      if (options.resume) {
        const text = await readResume(options.resume);
        const previous = parseJson(text, 'resume decision') as AnalysisRecord;
        if (previous.schemaVersion !== 1 || !previous.results || typeof previous.results !== 'object') throw new Error('Resume requires a version-1 decision record.');
        prior = previous.results;
      }
      const ids = ['agent.classify', 'agent.review'].map(uses => Object.entries(pkg.workflow.actions).filter(([, action]) => action.uses === uses));
      if (ids.some(matches => matches.length !== 1)) {
        record.status = 'blocked'; record.diagnostic = 'Analysis requires exactly one classify action and one review action in the workflow.';
      } else if (!source.comparisonBaseSha || !source.diff) {
        record.status = options.signal?.aborted ? interrupted() : 'blocked'; record.diagnostic = 'Pinned PR code is unavailable. Read missingEvidence, fetch the captured commits locally, and retry.';
      } else {
        let remainingAttempts = Math.min(pkg.workflow.limits.maxAttemptsPerHead, pkg.workflow.limits.maxAgentActionsPerWake);
        for (const matches of ids) {
          const [actionId, action] = matches[0]!;
          if (remainingAttempts < 1) { record.status = 'blocked'; record.diagnostic = 'The workflow agent-attempt limit was reached before analysis completed.'; break; }
          if (options.signal?.aborted || options.isCurrent && !await options.isCurrent()) {
            record.status = options.signal?.aborted ? interrupted() : 'superseded'; record.diagnostic = 'The selected inputs changed or analysis was stopped.'; break;
          }
          await options.onProgress?.(action.uses === 'agent.classify' ? 'classify' : 'review', { ...structuredClone(record), recordPath });
          const session: SessionIdentity | undefined = prior[actionId]?.session;
          const result = await runProvider({ package: pkg, profile: { ...profile, maxAttempts: Math.min(profile.maxAttempts, remainingAttempts) }, actionId, mode: 'read',
            workingDirectory: inputs, artifactDirectory: directory, sources: source, evidence: inspection.evidence,
            evidenceDigest: inspection.evidenceDigest, fixtureDigest: record.fixtureDigest, missingEvidence: record.missingEvidence, signal: options.signal, isCurrent: options.isCurrent, session });
          remainingAttempts -= result.attempts.length;
          record.results[actionId] = result; record.status = result.outcome === 'completed' && action.uses !== 'agent.review' ? 'running' : result.outcome; record.diagnostic = result.diagnostic;
          if (result.outcome === 'completed') {
            const payload = result.payload as Record<string, unknown>;
            if (action.uses === 'agent.classify') { control.memory!.classificationCurrent = true; control.classification = { uncertain: payload.uncertain as boolean }; }
            else { control.memory!.reviewCurrent = true; control.review = { verdict: payload.verdict as NonNullable<ControlState['review']>['verdict'], coverage: payload.coverage as 'complete' | 'partial' }; }
          }
          await save();
          if (result.outcome !== 'completed') break;
        }
        if (record.status === 'completed' && control.memory?.classificationCurrent && control.memory.reviewCurrent) {
          record.decision = record.missingEvidence.length || control.classification?.uncertain || control.review?.coverage !== 'complete' || control.review.verdict === 'inconclusive' ? 'incomplete' : control.review.verdict === 'acceptable' ? 'analysis_acceptable' : 'concerns';
        }
      }
    }
    record.workflowDecision = evaluate(pkg.workflow, inspection.fixture.observations[0]!, control, new Date().toISOString());
  } catch {
    record.status = options.signal?.aborted ? interrupted() : 'blocked';
    record.diagnostic = 'Cannot prepare or save analysis inputs. Check private paths, the resume record, and local Git objects.';
  } finally {
    if (options.signal?.aborted || options.isCurrent && !await options.isCurrent()) {
      record.status = options.signal?.aborted ? interrupted() : 'superseded'; record.decision = 'incomplete';
      record.control.memory = { classificationCurrent: false, reviewCurrent: false, packetCurrent: false };
      record.diagnostic = record.status === 'superseded' ? 'The selected inputs changed. Start again for the current draft and PR.' : record.status === 'timeout' ? 'The live analysis deadline expired.' : 'Analysis was cancelled.';
    }
    record.finishedAt = new Date().toISOString(); await save();
  }
  return { ...record, recordPath };
}
