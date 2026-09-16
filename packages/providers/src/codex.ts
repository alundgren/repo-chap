import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJson } from '@repo-chap/workflow';
import { prepareCaptureDirectory } from '@repo-chap/github';
import type { ProcessResult } from './process.js';
import { object, processOutcome, runAction, type ProviderTransport, type Invoke } from './runner.js';
import type { Outcome, ProviderProfile, ProviderRequest, ProviderResult, Usage } from './types.js';
import { codexActionSettings, codexConfigArguments } from './codex-action-settings.js';

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
  let payload: unknown;
  try {
    const envelope = parseJson(text, 'provider transport result');
    if (object(envelope) && Object.keys(envelope).length === 1 && typeof envelope.resultJson === 'string') payload = parseJson(envelope.resultJson, 'action result');
  } catch { /* Reported usage remains useful when the action payload is invalid. */ }
  return { payload, session, usage, failed: false };
}

export async function probeCodex(profile: ProviderProfile, invoke: Invoke) {
    let version: string | undefined;
    const end = (outcome: Outcome, diagnostic: string) => ({ outcome, diagnostic, version });
    const probe = async (args: string[], bytes = 128 * 1024) => invoke(args, bytes);
    const versionOutput = await probe(['--version']);
    if (processOutcome(versionOutput)) return end(processOutcome(versionOutput)!, 'Cannot probe Codex. Check the executable path and CLI installation.');
    const versionText = versionOutput.stdout.toString().trim();
    if (!/^codex-cli [\w.+-]+$/.test(versionText)) return end('blocked', 'Codex did not report a recognized version. Install a supported Codex CLI.');
    version = versionText;
    const help = await probe(['exec', '--help']);
    if (processOutcome(help)) return end(processOutcome(help)!, 'Cannot inspect Codex execution capabilities. Check the installation.');
    const required = ['--json', '--output-schema', '--model', '--config', '--sandbox', '--ignore-user-config', '--skip-git-repo-check', '--strict-config'];
    const missing = required.filter(flag => !help.stdout.toString().includes(flag));
    const top = await probe(['--help']);
    if (processOutcome(top)) return end(processOutcome(top)!, 'Cannot inspect Codex settings capabilities. Check the installation.');
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
    return { version: versionText, effectiveEffort };
}

const codex: ProviderTransport = {
  provider: 'codex', label: 'Codex', maxInputBytes: 16 * 1024 * 1024,
  resultInstruction: 'Return an object with exactly one string field, resultJson. That string must contain the JSON result satisfying both full action contracts below.',
  validSession: id => /^[a-zA-Z0-9_-]{1,128}$/.test(id), decode,
  async prepare(request, invoke, deadline) {
    const { profile } = request;
    const checked = await probeCodex(profile, invoke);
    if ('outcome' in checked) return checked;
    const { version: versionText, effectiveEffort } = checked;
    const help = await invoke(['app-server', '--help'], 128 * 1024);
    if (processOutcome(help) || !['--stdio', '--strict-config'].every(flag => help.stdout.toString().includes(flag)))
      return { outcome: processOutcome(help) ?? 'blocked', version: versionText, diagnostic: 'This Codex lacks the native settings inspection required for analysis. Install a supported Codex CLI.' };
    const settings = await codexActionSettings(request, deadline);
    if ('outcome' in settings) return { ...settings, version: versionText };
    const artifacts = await prepareCaptureDirectory(request.artifactDirectory);
    const schemaPath = join(artifacts, `schema-${randomUUID()}.json`);
    await writeFile(schemaPath, JSON.stringify({ type: 'object', properties: { resultJson: { type: 'string' } }, required: ['resultJson'], additionalProperties: false }), { flag: 'wx', mode: 0o600 });
    return {
      version: versionText,
      identity: { effectiveEffort, authHome: process.env.CODEX_HOME ?? process.env.HOME ?? '', userConfig: 'ignored', isolationVersion: 1, isolation: settings.config },
      canResume: async () => {
        const resume = await invoke(['exec', 'resume', '--help'], 128 * 1024);
        return !processOutcome(resume) && ['--json', '--output-schema', '--ignore-user-config', '--strict-config', '--model', '--config', '--skip-git-repo-check'].every(flag => resume.stdout.toString().includes(flag));
      },
      run: (input, session) => invoke(['--ask-for-approval', 'never', 'exec', ...(session ? ['resume'] : []), '--strict-config', '--ignore-user-config', '--model', profile.model,
        ...codexConfigArguments(settings.config), '--config', `model_reasoning_effort=${JSON.stringify(effectiveEffort)}`,
        ...(session ? [] : ['--sandbox', request.mode === 'read' ? 'read-only' : 'workspace-write']),
        '--skip-git-repo-check', '--json', '--output-schema', schemaPath, ...(session ? [session] : []), '-'], profile.maxOutputBytes, input),
      dispose: () => rm(schemaPath, { force: true }),
    };
  },
};
export const runCodex = (request: ProviderRequest): Promise<ProviderResult> => runAction(request, codex);
