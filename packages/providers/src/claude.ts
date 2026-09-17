import { actionContracts, parseJson } from '@repo-chap/workflow';
import { object, processOutcome, runAction, type ProviderTransport } from './runner.js';
import type { Outcome, ProviderRequest, ProviderResult, Usage } from './types.js';

const validSession = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
const counter = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

// Claude validates draft-07 at generation time. Only our known canonical schemas
// are adapted here; complete workflow contracts remain unchanged in host validation.
function generationSchema(request: ProviderRequest): string {
  const { document, fragment } = actionContracts(request.package, request.actionId).canonical;
  const definitions = (document as { $defs: Record<string, unknown> }).$defs;
  const selected = definitions[fragment.slice('/$defs/'.length)];
  return JSON.stringify({ ...(selected as object), definitions }).replaceAll('"#/$defs/', '"#/definitions/');
}

const claude: ProviderTransport = {
  provider: 'claude', label: 'Claude Code', maxInputBytes: 10 * 1024 * 1024,
  resultInstruction: 'Return the JSON action result directly using structured output. It must satisfy both full action contracts below.',
  validSession,
  decode(output) {
    const result = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(output.stdout), 'Claude result');
    if (!object(result) || result.type !== 'result' || typeof result.subtype !== 'string' || typeof result.is_error !== 'boolean') throw new Error('Invalid Claude result.');
    let usage: Usage['actual'] = null;
    if (object(result.usage)) {
      const u = result.usage;
      if ([u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].every(counter)) {
        const total = Number(u.input_tokens) + Number(u.cache_read_input_tokens) + Number(u.cache_creation_input_tokens);
        if (counter(total)) usage = { inputTokens: total, cachedInputTokens: Number(u.cache_read_input_tokens), outputTokens: Number(u.output_tokens), cacheCreationInputTokens: Number(u.cache_creation_input_tokens) };
      }
    }
    const estimatedCostUsd = typeof result.total_cost_usd === 'number' && Number.isFinite(result.total_cost_usd) && result.total_cost_usd >= 0 ? result.total_cost_usd : undefined;
    return { payload: result.structured_output, usage, estimatedCostUsd,
      session: typeof result.session_id === 'string' && validSession(result.session_id) ? result.session_id : undefined,
      failed: result.is_error || result.subtype !== 'success', invalidOutput: result.subtype === 'error_max_structured_output_retries' };
  },
  async prepare(request, invoke) {
    const { profile } = request;
    let version: string | undefined;
    const fail = (outcome: Outcome, diagnostic: string) => ({ outcome, diagnostic, version });
    const found = await invoke(['--version'], 128 * 1024);
    if (processOutcome(found)) return fail(processOutcome(found)!, 'Cannot probe Claude Code. Check the executable path and CLI installation.');
    const versionText = found.stdout.toString().trim();
    if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)? \(Claude Code\)$/.test(versionText)) return fail('blocked', 'Claude did not report a recognized version. Install a supported Claude Code CLI.');
    version = versionText;
    const help = await invoke(['--help'], 128 * 1024);
    if (processOutcome(help)) return fail(processOutcome(help)!, 'Cannot inspect Claude Code capabilities. Check the CLI installation.');
    const text = help.stdout.toString();
    const required = ['--print', '--output-format', '--json-schema', '--model', '--settings', '--setting-sources', '--safe-mode', '--tools', '--allowedTools', '--permission-mode', '--strict-mcp-config', '--mcp-config', '--resume'];
    const hasFlag = (flag: string) => new RegExp(`(?:^|\\s)${flag}(?=[\\s,=]|$)`, 'm').test(text);
    const missing = required.filter(flag => !hasFlag(flag));
    if (missing.length) return fail('blocked', `Installed Claude Code lacks ${missing.join(', ')}. Update Claude Code before running this profile.`);
    if (!/--output-format\b[\s\S]*?\bjson\b/.test(text) || !/--permission-mode\b[\s\S]*?\bdontAsk\b/.test(text))
      return fail('blocked', 'Installed Claude Code does not advertise JSON output and noninteractive permission denial. Update the CLI.');
    const effort = profile.effort ?? 'medium';
    const effortHelp = text.match(/--effort\b([\s\S]*?)(?=\n\s*(?:--|-[a-zA-Z],)|$)/)?.[1];
    const levels = effortHelp?.match(/\(([^)]+)\)/)?.[1]?.split(',').map(value => value.trim());
    if (!hasFlag('--effort') || !levels?.includes(effort)) return fail('blocked', 'The installed Claude Code does not advertise the requested effort. Update the CLI or choose a listed effort.');
    const capabilities = request.package.workflow.actions[request.actionId]!.capabilities;
    const tools = request.mode === 'read' ? [] : ['Read', 'Glob', 'Grep', ...(capabilities.includes('workspace.write') ? ['Edit', 'Write'] : []), ...(capabilities.includes('checks.run') ? ['Bash'] : [])];
    const settings = { disableAllHooks: true };
    const args = ['--print', '--output-format', 'json', '--json-schema', generationSchema(request), '--model', profile.model, '--effort', effort,
      '--safe-mode', '--setting-sources', '', '--settings', JSON.stringify(settings), '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--permission-mode', 'dontAsk', '--tools', tools.join(','), ...(tools.length ? ['--allowedTools', tools.join(',')] : [])];
    return { version: versionText,
      identity: { effort, tools, settings, settingsSources: [], safeMode: true, authHome: process.env.CLAUDE_CONFIG_DIR ?? process.env.HOME ?? '' },
      run: (input, session) => invoke([...args, ...(session ? ['--resume', session] : [])], profile.maxOutputBytes, input),
    };
  },
};

export const runClaude = (request: ProviderRequest): Promise<ProviderResult> => runAction(request, claude);
