import { realpath } from 'node:fs/promises';
import { ConversationProcess, record } from './conversation-process.js';
import type { Outcome, ProviderRequest } from './types.js';

const options = {
  model_provider: 'openai', web_search: 'disabled', project_doc_max_bytes: 0,
  'features.skip_host_skill_discovery': true, 'features.apps': false,
  'features.plugins': false, 'features.hooks': false, 'features.memories': false,
  'features.skill_search': false, 'features.skill_mcp_dependency_install': false,
};
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  if (record(value)) return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const codexConfigArguments = (config: Record<string, unknown>): string[] => Object.entries(config).flatMap(([key, value]) => ['--config', `${key}=${toml(value)}`]);

/** Inspect native effective inputs without starting a model turn or changing operator settings. */
export async function codexActionSettings(request: ProviderRequest, deadline: number): Promise<
  { config: Record<string, unknown> } | { outcome: Outcome; diagnostic: string }
> {
  let peer: ConversationProcess | undefined, timer: NodeJS.Timeout | undefined;
  let outcome: Outcome = 'blocked';
  let diagnostic = 'Cannot verify Codex analysis settings. Use the supported CLI and an instruction-free CODEX_HOME with its normal local login.';
  let rejectStop!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  void stopped.catch(() => {});
  const stop = (next: Outcome) => { outcome = next; rejectStop(new Error('Codex settings inspection stopped.')); };
  const cancel = () => stop(request.signal?.reason === 'superseded' ? 'superseded' : 'cancelled');
  request.signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (request.signal?.aborted) { cancel(); throw new Error(); }
    if (deadline <= Date.now()) { stop('timeout'); throw new Error(); }
    timer = setTimeout(() => stop('timeout'), deadline - Date.now());
    const cwd = await realpath(request.workingDirectory);
    const nativeOptions = { ...options, approval_policy: 'never', sandbox_mode: request.mode === 'read' ? 'read-only' : 'workspace-write',
      ...(request.mode === 'workspace' ? { projects: { [cwd]: { trust_level: 'trusted' } } } : {}) };
    peer = new ConversationProcess(request.profile.executable, ['app-server', '--stdio', '--strict-config', ...codexConfigArguments(nativeOptions)], cwd, 4 * 1024 * 1024);
    const inspect = async () => {
      await peer!.request('initialize', { clientInfo: { name: 'repo_chap', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      peer!.send({ method: 'initialized', params: {} });
      const settings = await peer!.request('config/read', { cwd, includeLayers: false });
      if (!record(settings.config)) throw new Error();
      if (settings.config.instructions != null || settings.config.model_instructions_file != null) {
        diagnostic = 'Codex has custom base instructions enabled. Use an instruction-free CODEX_HOME without instructions or model_instructions_file settings, and log in there with Codex. Analysis inputs were not sent.';
        throw new Error();
      }
      const mcp = settings.config.mcp_servers ?? {};
      if (!record(mcp)) throw new Error();
      const disabledMcp = Object.fromEntries(Object.entries(mcp).map(([name, value]) => {
        if (!record(value) || typeof value.command !== 'string' && typeof value.url !== 'string') throw new Error();
        return [name, { enabled: false, ...(typeof value.command === 'string' ? { command: value.command } : { url: value.url }) }];
      }));
      const skills = await peer!.request('skills/list', { cwds: [cwd], forceReload: true });
      if (!Array.isArray(skills.data) || skills.data.length !== 1 || !record(skills.data[0]) || skills.data[0].cwd !== cwd || !Array.isArray(skills.data[0].skills) || !Array.isArray(skills.data[0].errors) || skills.data[0].errors.length) throw new Error();
      const disabledSkills = skills.data[0].skills.map((skill: unknown) => {
        if (!record(skill) || typeof skill.path !== 'string' || !skill.path.startsWith('/') || skill.path.length > 4096) throw new Error();
        return { path: skill.path, enabled: false };
      }).sort((a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path));
      const config = { ...nativeOptions, mcp_servers: disabledMcp, skills: { config: disabledSkills } };
      if (Buffer.byteLength(JSON.stringify(config)) > 64 * 1024) throw new Error();
      const thread = await peer!.request('thread/start', { model: request.profile.model, cwd, approvalPolicy: 'never', sandbox: 'read-only', config,
        allowProviderModelFallback: false, ephemeral: true });
      if (thread.model !== request.profile.model || !Array.isArray(thread.instructionSources)) throw new Error();
      if (thread.instructionSources.length) {
        diagnostic = 'Codex has ambient instructions enabled. Use an instruction-free CODEX_HOME and log in there with Codex. Analysis inputs were not sent.';
        throw new Error();
      }
      return { config };
    };
    return await Promise.race([inspect(), peer.closed, stopped]);
  } catch {
    if (outcome !== 'blocked') diagnostic = outcome === 'timeout' ? 'The provider deadline expired while checking Codex settings.' : 'Codex settings inspection was stopped before analysis.';
    return { outcome, diagnostic };
  } finally {
    clearTimeout(timer); request.signal?.removeEventListener('abort', cancel); peer?.close();
  }
}
