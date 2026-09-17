import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { actionContracts, canonicalJson, digest, referencePath, validateActionPayload } from '@repo-chap/workflow';
import { runProcess, type ProcessResult } from './process.js';
import { validateProfile } from './profile.js';
import { validateCitations, validateSourceBundle } from './sources.js';
import type { Outcome, ProviderRequest, ProviderResult, Usage } from './types.js';

export type Invoke = (args: string[], maxBytes: number, input?: string) => Promise<ProcessResult>;
export interface PreparedTransport {
  version: string; identity: Record<string, unknown>;
  run(input: string, session?: string): Promise<ProcessResult>;
  canResume?(): Promise<boolean>;
  dispose?(): Promise<void>;
}
export interface ProviderTransport {
  provider: ProviderRequest['profile']['provider']; label: string; maxInputBytes: number; resultInstruction: string;
  validSession(id: string): boolean;
  prepare(request: ProviderRequest, invoke: Invoke, deadline: number): Promise<PreparedTransport | { outcome: Outcome; diagnostic: string; version?: string }>;
  decode(result: ProcessResult): { payload: unknown; session?: string; usage: Usage['actual']; estimatedCostUsd?: number; failed: boolean; invalidOutput?: boolean };
}
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const diagnostic = (status: Outcome, provider: string): string => ({ completed: 'Validated result recorded.',
  provider_error: `${provider} failed. Check the installed CLI, supported login, requested model access, and structured-output support.`,
  invalid_output: `${provider} returned output that does not satisfy the result contract, input revisions, or source citations.`,
  blocked: 'Required provider capabilities or inputs are unavailable.', timeout: 'The provider deadline expired; its process group was stopped.',
  cancelled: 'Analysis was cancelled; its process group was stopped.', superseded: 'Inputs changed; the result was discarded and its process group stopped.' })[status];
export function processOutcome(result: ProcessResult): Outcome | undefined {
  if (result.status === 'output_limit') return 'invalid_output';
  if (result.status !== 'exited') return result.status;
  if (result.exitCode !== 0) return 'provider_error';
  return undefined;
}

export async function runAction(request: ProviderRequest, transport: ProviderTransport): Promise<ProviderResult> {
  request = { ...request, package: structuredClone(request.package), profile: structuredClone(request.profile), sources: structuredClone(request.sources),
    evidence: structuredClone(request.evidence), missingEvidence: [...new Set([...request.missingEvidence, ...request.sources.missingEvidence])], session: request.session && { ...request.session } };
  validateProfile(request.profile);
  const { package: pkg, actionId, profile, sources } = request;
  const action = pkg.workflow.actions[actionId];
  const schema = actionContracts(pkg, actionId);
  const pinned = [action?.prompt, ...action?.contextFiles ?? []].filter((ref): ref is string => !!ref).map(ref => {
    const path = referencePath(pkg.workflowPath, ref).path; return pkg.files.find(file => file.path === path)!;
  });
  const cwd = await realpath(request.workingDirectory);
  const inputDigest = digest(canonicalJson({ packageDigest: pkg.digest, actionId, mode: request.mode, cwd, sourceDigest: sources.digest,
    evidenceDigest: request.evidenceDigest, fixtureDigest: request.fixtureDigest, missingEvidence: request.missingEvidence, schema }));
  const result: ProviderResult = { schemaVersion: 1, provider: transport.provider, profile: profile.name, providerVersion: null, providerDigest: null,
    inputDigest, outcome: 'blocked', diagnostic: diagnostic('blocked', transport.label), attempts: [] };
  const end = (outcome: Outcome, message = diagnostic(outcome, transport.label)) => {
    result.outcome = outcome; result.diagnostic = message;
    if (['cancelled', 'timeout', 'superseded'].includes(outcome)) delete result.session;
    return result;
  };
  if (profile.provider !== transport.provider) return end('blocked', 'The selected profile belongs to another provider. Use runProvider or the matching adapter.');
  try {
    validateSourceBundle(sources);
    if (request.evidenceDigest !== digest(canonicalJson(request.evidence))) throw new Error('Evidence digest mismatch.');
  } catch { return end('blocked', 'Pinned source or evidence digests do not match their contents. Capture the inputs again.'); }
  if (!sources.comparisonBaseSha || !sources.diff) return end('blocked', 'A pinned common ancestor and complete diff are required before a provider action.');
  if (!action || action.execution !== 'agent' || request.mode === 'read' && action.capabilities.some(capability => capability !== 'workspace.read'))
    return end('blocked', 'Read analysis only permits agent actions with workspace.read capability.');
  if (action.capabilities.some(capability => !profile.maximumCapabilities.includes(capability))) return end('blocked', 'The operator profile does not permit the action capabilities.');
  if (request.signal?.aborted) return end(request.signal.reason === 'superseded' ? 'superseded' : 'cancelled');
  if (request.isCurrent && !await request.isCurrent()) return end('superseded');
  const deadline = Date.now() + Math.min(profile.timeoutMs, pkg.workflow.limits.maxAttemptSeconds * 1000);
  const invoke = (args: string[], maxBytes: number, input?: string) => runProcess(profile.executable, args, {
    cwd, timeoutMs: Math.max(0, deadline - Date.now()), maxBytes, input, signal: request.signal,
  });
  const prepared = await transport.prepare(request, invoke, deadline);
  result.providerVersion = prepared.version ?? null;
  if ('outcome' in prepared) return end(prepared.outcome, prepared.diagnostic);
  result.providerDigest = digest(canonicalJson({ provider: transport.provider, version: prepared.version, profile, ...prepared.identity }));
  try {
    const prompt = [
      `Perform ${action.uses} on the pinned inputs below. ${transport.resultInstruction}`,
      'Use only the supplied evidence. Source citations use repository paths and 1-based inclusive lines in sources.files. The base side is comparisonBaseSha; baseSha remains the captured target branch revision.',
      request.mode === 'read' ? 'This is read analysis. Do not modify files, push, publish reviews, change labels, send messages, or merge. No tool use is necessary.' : 'Work only in the caller-owned workspace. Do not push, publish reviews, change labels, send messages, or merge.',
      'If evidence is missing, classification must be uncertain and review must be partial and inconclusive, with every supplied missingEvidence entry retained. Do not invent source citations.',
      'Classification labels must come from allowedLabels below. An empty label list is allowed when none applies.',
      canonicalJson({ actionContract: schema, allowedLabels: pkg.workflow.labels, instructions: pinned, evidence: request.evidence, sources, missingEvidence: request.missingEvidence }),
    ].join('\n\n');
    if (Buffer.byteLength(prompt) > transport.maxInputBytes) return end('blocked', `Pinned inputs exceed the ${transport.maxInputBytes / 1024 / 1024} MiB provider input limit. Reduce the workflow context or PR size.`);
    let session = request.session?.provider === transport.provider && request.session.providerDigest === result.providerDigest && request.session.inputDigest === inputDigest && transport.validSession(request.session.id) ? request.session : undefined;
    if (session && prepared.canResume && !await prepared.canResume()) session = undefined;
    const maximum = Math.min(profile.maxAttempts, pkg.workflow.limits.maxAttemptsPerHead, pkg.workflow.limits.maxAgentActionsPerWake);
    for (let index = 0; index < maximum; index++) {
      if (request.signal?.aborted) return end(request.signal.reason === 'superseded' ? 'superseded' : 'cancelled');
      if (request.isCurrent && !await request.isCurrent()) return end('superseded');
      const id = randomUUID(), startedAt = new Date().toISOString();
      const input = index ? `${prompt}\nThe previous attempt failed. Produce one fresh valid result using exactly these inputs.` : prompt;
      const output = await prepared.run(input, session?.id);
      let outcome = processOutcome(output), payload: unknown, returnedSession: string | undefined, actual: Usage['actual'] = null, costUsd: number | undefined;
      try {
        const parsed = transport.decode(output); actual = parsed.usage; returnedSession = parsed.session; costUsd = parsed.estimatedCostUsd;
        if (output.status === 'exited' && parsed.invalidOutput) outcome = 'invalid_output';
        if (!outcome && parsed.failed) outcome = 'provider_error';
        if (!outcome) {
          payload = parsed.payload;
          validateActionPayload(pkg, actionId, payload); validateCitations(payload, sources);
          if (!object(payload) || ('headSha' in payload && payload.headSha !== sources.headSha) || ('expectedHeadSha' in payload && payload.expectedHeadSha !== sources.headSha) || ('baseSha' in payload && payload.baseSha !== sources.baseSha)) throw new Error('Revision mismatch.');
          if (action.uses === 'agent.classify') {
            const labels = (payload.labels as { name: string }[]).map(label => label.name);
            if (new Set(labels).size !== labels.length || labels.some(label => !pkg.workflow.labels.includes(label))) throw new Error('Duplicate or unconfigured label.');
            if (request.missingEvidence.length && payload.uncertain !== true) throw new Error('Missing classification evidence.');
          }
          if (action.uses === 'agent.review') {
            const missing = payload.missingEvidence as string[];
            const ids = (payload.findings as { id: string }[]).map(finding => finding.id);
            if (new Set(ids).size !== ids.length || payload.coverage === 'partial' && !missing.length) throw new Error('Duplicate finding or unexplained missing evidence.');
            if (payload.coverage === 'complete' && (payload.missingEvidence as string[]).length) throw new Error('Contradictory coverage.');
            if (payload.verdict === 'acceptable' && ((payload.findings as unknown[]).length || payload.coverage !== 'complete')) throw new Error('Contradictory verdict.');
            if (request.missingEvidence.length && (payload.coverage !== 'partial' || payload.verdict !== 'inconclusive' || request.missingEvidence.some(item => !missing.includes(item)))) throw new Error('Missing review evidence.');
          }
          outcome = payload.outcome === 'blocked' || payload.outcome === 'no_change' ? 'blocked' : 'completed';
        }
      } catch { outcome ??= 'invalid_output'; }
      outcome ??= 'invalid_output';
      if (request.signal?.aborted) outcome = request.signal.reason === 'superseded' ? 'superseded' : 'cancelled';
      if (request.isCurrent && !await request.isCurrent()) outcome = 'superseded';
      const message = output.status === 'output_limit' ? 'Provider output exceeded its byte limit; its process group was stopped.' : diagnostic(outcome, transport.label);
      result.attempts.push({ id, outcome, resumed: !!session, startedAt, finishedAt: new Date().toISOString(), diagnostic: message, exitCode: output.exitCode,
        outputBytes: output.stdout.length + output.stderr.length, usage: { actual,
          estimated: { inputTokens: Math.ceil(Buffer.byteLength(input) / 4), outputTokens: Math.ceil(output.stdout.length / 4), method: 'utf8_bytes_divided_by_four', ...(costUsd === undefined ? {} : { costUsd, costMethod: 'provider_reported_estimate' as const }) } } });
      if (returnedSession && !['cancelled', 'timeout', 'superseded'].includes(outcome)) result.session = { provider: transport.provider, providerDigest: result.providerDigest, inputDigest, id: returnedSession };
      if (outcome === 'completed' || outcome === 'blocked') { result.payload = payload; return end(outcome, message); }
      if (!(outcome === 'invalid_output' || session && outcome === 'provider_error') || index + 1 === maximum || Date.now() >= deadline) return end(outcome, message);
      session = undefined;
    }
    return end('blocked', 'The workflow does not permit another provider attempt.');
  } finally { await prepared.dispose?.(); }
}
