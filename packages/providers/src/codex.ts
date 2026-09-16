import { randomUUID } from 'node:crypto';
import { realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { actionContracts, canonicalJson, digest, parseJson, referencePath, validateActionPayload } from '@repo-chap/workflow';
import { prepareCaptureDirectory } from '@repo-chap/github';
import { runProcess, type ProcessResult } from './process.js';
import { validateProfile } from './profile.js';
import { validateCitations, validateSourceBundle } from './sources.js';
import type { Outcome, ProviderRequest, ProviderResult, Usage } from './types.js';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const diagnostic = (status: Outcome): string => ({ completed: 'Validated result recorded.',
  provider_error: 'Codex failed. Check the installed CLI, supported login, requested model access, and output-schema support.',
  invalid_output: 'Codex returned output that does not satisfy the result contract, input revisions, or source citations.',
  blocked: 'Required provider capabilities or inputs are unavailable.', timeout: 'The provider deadline expired; its process group was stopped.',
  cancelled: 'Analysis was cancelled; its process group was stopped.', superseded: 'Inputs changed; the result was discarded and its process group stopped.' })[status];
function processOutcome(result: ProcessResult): Outcome | undefined {
  if (result.status === 'output_limit') return 'invalid_output';
  if (result.status !== 'exited') return result.status;
  if (result.exitCode !== 0) return 'provider_error';
  return undefined;
}
function decode(result: ProcessResult): { payload: unknown; session?: string; usage: Usage['actual']; failed: boolean } {
  let text: string | undefined, session: string | undefined, usage: Usage['actual'] = null, completed = false, failed = false;
  for (const line of new TextDecoder('utf-8', { fatal: true }).decode(result.stdout).split('\n').filter(line => line.trim())) {
    const event = parseJson(line, 'provider event');
    if (!object(event)) throw new Error('Invalid provider event.');
    if (event.type === 'thread.started') {
      if (typeof event.thread_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(event.thread_id)) throw new Error('Invalid session ID.');
      session = event.thread_id;
    }
    if (event.type === 'item.completed' && object(event.item) && event.item.type === 'agent_message') {
      if (completed || typeof event.item.text !== 'string') throw new Error('Invalid final message.');
      text = event.item.text;
    }
    if (event.type === 'turn.failed' || event.type === 'error') failed = true;
    if (event.type === 'turn.completed') {
      if (completed) throw new Error('Multiple completed turns.');
      completed = true;
      if (object(event.usage)) {
        const u = event.usage;
        if ([u.input_tokens, u.cached_input_tokens, u.output_tokens].every(v => Number.isSafeInteger(v) && Number(v) >= 0)) {
          usage = { inputTokens: Number(u.input_tokens), cachedInputTokens: Number(u.cached_input_tokens), outputTokens: Number(u.output_tokens) };
          if (Number.isSafeInteger(u.reasoning_output_tokens) && Number(u.reasoning_output_tokens) >= 0) usage.reasoningOutputTokens = Number(u.reasoning_output_tokens);
        }
      }
    }
  }
  if (failed) return { payload: undefined, session, usage, failed };
  if (!completed || text === undefined) throw new Error('No completed structured result.');
  return { payload: text, session, usage, failed: false };
}

export async function runCodex(request: ProviderRequest): Promise<ProviderResult> {
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
  const result: ProviderResult = { schemaVersion: 1, provider: 'codex', profile: profile.name, providerVersion: null, providerDigest: null,
    inputDigest, outcome: 'blocked', diagnostic: diagnostic('blocked'), attempts: [] };
  const end = (outcome: Outcome, message = diagnostic(outcome)) => { result.outcome = outcome; result.diagnostic = message; return result; };
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
  const probe = async (args: string[], bytes = 128 * 1024) => invoke(args, bytes);
  const version = await probe(['--version']);
  if (processOutcome(version)) return end(processOutcome(version)!, 'Cannot probe Codex. Check the executable path and CLI installation.');
  const versionText = version.stdout.toString().trim();
  if (!/^codex-cli [\w.+-]+$/.test(versionText)) return end('blocked', 'Codex did not report a recognized version. Install a supported Codex CLI.');
  result.providerVersion = versionText;
  const help = await probe(['exec', '--help']);
  if (processOutcome(help)) return end(processOutcome(help)!);
  const required = ['--json', '--output-schema', '--model', '--config', '--sandbox', '--ignore-user-config', '--skip-git-repo-check', '--strict-config'];
  const missing = required.filter(flag => !help.stdout.toString().includes(flag));
  const top = await probe(['--help']);
  if (processOutcome(top)) return end(processOutcome(top)!);
  if (!top.stdout.toString().includes('--ask-for-approval')) missing.push('--ask-for-approval');
  if (missing.length) return end('blocked', `Installed Codex lacks ${missing.join(', ')}. Update Codex before running this profile.`);
  const catalog = await probe(['debug', 'models', '--bundled'], 4 * 1024 * 1024);
  const catalogFailure = processOutcome(catalog);
  if (catalogFailure) return end(['cancelled', 'timeout', 'superseded'].includes(catalogFailure) ? catalogFailure : 'blocked', 'This Codex cannot provide its local model catalog. Update Codex to verify the required model and effort without a model call.');
  let effectiveEffort: string | undefined;
  try {
    const document = parseJson(catalog.stdout.toString(), 'Codex model catalog');
    const model = object(document) && Array.isArray(document.models) ? document.models.find(value => object(value) && value.slug === profile.model) : undefined;
    if (!object(model)) return end('blocked', 'The requested model is absent from the installed Codex catalog. Update Codex or choose a listed model.');
    effectiveEffort = profile.effort ?? (typeof model.default_reasoning_level === 'string' ? model.default_reasoning_level : undefined);
    if (!effectiveEffort || !Array.isArray(model.supported_reasoning_levels) || !model.supported_reasoning_levels.some(level => object(level) && level.effort === effectiveEffort))
      return end('blocked', 'The installed Codex catalog does not support the requested effort for this model. Choose a supported profile setting.');
  } catch { return end('blocked', 'The installed Codex returned an unreadable model catalog. Update Codex.'); }
  result.providerDigest = digest(canonicalJson({ provider: 'codex', version: versionText, profile, effectiveEffort,
    authHome: process.env.CODEX_HOME ?? process.env.HOME ?? '', userConfig: 'ignored' }));
  const prompt = [
    `Perform ${action.uses} on the pinned inputs below. Return an object with exactly one string field, resultJson. That string must contain the JSON result satisfying both full action contracts below.`,
    'Use only the supplied evidence. Source citations use repository paths and 1-based inclusive lines in sources.files. The base side is comparisonBaseSha; baseSha remains the captured target branch revision.',
    request.mode === 'read' ? 'This is read analysis. Do not modify files, push, publish reviews, change labels, send messages, or merge. No tool use is necessary.' : 'Work only in the caller-owned workspace. Do not push, publish reviews, change labels, send messages, or merge.',
    'If evidence is missing, classification must be uncertain and review must be partial and inconclusive, with every supplied missingEvidence entry retained. Do not invent source citations.',
    'Classification labels must come from allowedLabels below. An empty label list is allowed when none applies.',
    canonicalJson({ actionContract: schema, allowedLabels: pkg.workflow.labels, instructions: pinned, evidence: request.evidence, sources, missingEvidence: request.missingEvidence }),
  ].join('\n\n');
  if (Buffer.byteLength(prompt) > 16 * 1024 * 1024) return end('blocked', 'Pinned inputs exceed the 16 MiB provider input limit. Reduce the workflow context or PR size.');
  const artifacts = await prepareCaptureDirectory(request.artifactDirectory);
  const schemaPath = join(artifacts, `schema-${randomUUID()}.json`);
  await writeFile(schemaPath, JSON.stringify({ type: 'object', properties: { resultJson: { type: 'string' } }, required: ['resultJson'], additionalProperties: false }), { flag: 'wx', mode: 0o600 });
  try {
    let session = request.session?.provider === 'codex' && request.session.providerDigest === result.providerDigest && request.session.inputDigest === inputDigest && /^[a-zA-Z0-9_-]{1,128}$/.test(request.session.id) ? request.session : undefined;
    if (session) {
      const resume = await probe(['exec', 'resume', '--help']);
      if (processOutcome(resume) || ['--json', '--output-schema'].some(flag => !resume.stdout.toString().includes(flag))) session = undefined;
    }
    const maximum = Math.min(profile.maxAttempts, pkg.workflow.limits.maxAttemptsPerHead, pkg.workflow.limits.maxAgentActionsPerWake);
    for (let index = 0; index < maximum; index++) {
      if (request.signal?.aborted) return end(request.signal.reason === 'superseded' ? 'superseded' : 'cancelled');
      if (request.isCurrent && !await request.isCurrent()) return end('superseded');
      const id = randomUUID(), startedAt = new Date().toISOString();
      const args = ['--ask-for-approval', 'never', 'exec', '--strict-config', '--ignore-user-config', '--model', profile.model,
        '--config', `model_reasoning_effort=${JSON.stringify(effectiveEffort)}`, '--sandbox', request.mode === 'read' ? 'read-only' : 'workspace-write',
        '--skip-git-repo-check', ...(session ? ['resume'] : []), '--json', '--output-schema', schemaPath, ...(session ? [session.id] : []), '-'];
      const output = await invoke(args, profile.maxOutputBytes, index ? `${prompt}\nThe previous attempt failed. Produce one fresh valid result using exactly these inputs.` : prompt);
      let outcome = processOutcome(output), payload: unknown, returnedSession: string | undefined, actual: Usage['actual'] = null;
      try {
        const parsed = decode(output); actual = parsed.usage; returnedSession = parsed.session;
        if (!outcome && parsed.failed) outcome = 'provider_error';
        if (!outcome) {
          const envelope = parseJson(String(parsed.payload), 'provider transport result');
          if (!object(envelope) || Object.keys(envelope).length !== 1 || typeof envelope.resultJson !== 'string') throw new Error('Invalid transport result.');
          payload = parseJson(envelope.resultJson, 'action result');
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
      const message = output.status === 'output_limit' ? 'Provider output exceeded its byte limit; its process group was stopped.' : diagnostic(outcome);
      result.attempts.push({ id, outcome, resumed: !!session, startedAt, finishedAt: new Date().toISOString(), diagnostic: message, exitCode: output.exitCode,
        outputBytes: output.stdout.length + output.stderr.length, usage: { actual,
          estimated: { inputTokens: Math.ceil(Buffer.byteLength(prompt) / 4), outputTokens: Math.ceil(output.stdout.length / 4), method: 'utf8_bytes_divided_by_four' } } });
      if (returnedSession && !['cancelled', 'timeout', 'superseded'].includes(outcome)) result.session = { provider: 'codex', providerDigest: result.providerDigest, inputDigest, id: returnedSession };
      if (outcome === 'completed' || outcome === 'blocked') { result.payload = payload; return end(outcome, message); }
      if (!(outcome === 'invalid_output' || session && outcome === 'provider_error') || index + 1 === maximum || Date.now() >= deadline) return end(outcome, message);
      session = undefined;
    }
    return end('blocked', 'The workflow does not permit another provider attempt.');
  } finally { await rm(schemaPath, { force: true }); }
}
