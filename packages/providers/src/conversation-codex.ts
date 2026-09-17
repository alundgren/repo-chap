import { ConversationError, type ConversationQuestion, type ConversationSessionIdentity } from './conversation-types.js';
import { record } from './conversation-process.js';
import type { ConversationRuntime } from './conversation.js';
import { auditCodexTranscript, nativeOperationFailure } from './conversation-codex-transcript.js';

const disabledFeatures = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'multi_agent', 'multi_agent_v2', 'code_mode', 'code_mode_only', 'code_mode_host', 'view_image', 'image_generation', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'memories', 'skill_search', 'skill_mcp_dependency_install', 'goals', 'sleep_tool', 'tool_suggest', 'worktrees'];

export async function runCodexConversation(runtime: ConversationRuntime): Promise<ConversationSessionIdentity> {
  const { request, probe, emit } = runtime;
  const help = await probe(['app-server', '--help']);
  if (!['--stdio', '--strict-config', 'generate-json-schema'].every(flag => help.includes(flag))) throw new ConversationError('unsupported', 'The installed Codex lacks the required app-server stdio and configuration controls.');
  let catalog: unknown;
  try { catalog = JSON.parse(await probe(['debug', 'models', '--bundled'], 4 * 1024 * 1024)); } catch { throw new ConversationError('unsupported', 'Cannot read the installed Codex model catalog.'); }
  const model = record(catalog) && Array.isArray(catalog.models) ? catalog.models.find(value => record(value) && value.slug === request.profile.model) : undefined;
  const effort = request.profile.effort ?? model?.default_reasoning_level;
  if (!record(model) || !Array.isArray(model.supported_reasoning_levels) || !model.supported_reasoning_levels.some(level => record(level) && level.effort === effort)) throw new ConversationError('settings', 'The installed Codex catalog does not support the selected model and effort. Choose a supported profile.');
  const options = { 'web_search': 'disabled', 'project_doc_max_bytes': 0, 'features.skip_host_skill_discovery': true, 'features.default_mode_request_user_input': true, ...Object.fromEntries(disabledFeatures.map(name => [`features.${name}`, false])) };
  const peer = runtime.spawn(['app-server', '--stdio', '--strict-config', ...Object.entries(options).flatMap(([key, value]) => ['--config', `${key}=${JSON.stringify(value)}`])]);
  let session: ConversationSessionIdentity | undefined, turnId: string | undefined;
  let complete!: (session: ConversationSessionIdentity) => void;
  const completed = new Promise<ConversationSessionIdentity>(resolve => { complete = resolve; });
  peer.onMessage = message => {
    const params = record(message.params) ? message.params : {};
    if (message.id !== undefined && typeof message.method === 'string') {
      void (async () => {
        if (!session || params.threadId !== session.id) throw new ConversationError('protocol', 'Codex requested an operation for a different conversation.');
        if (turnId && params.turnId !== turnId) throw new ConversationError('protocol', 'Codex requested an operation for a different turn.');
        if (message.method === 'item/tool/call') {
          if (typeof params.callId !== 'string' || typeof params.tool !== 'string' || params.namespace != null) throw new ConversationError('protocol', 'Codex returned an unsupported tool request.');
          const result = await runtime.callTool(params.callId, params.tool, params.arguments);
          peer.send({ id: message.id, result: { contentItems: [{ type: 'inputText', text: result.text }], success: !result.isError } });
        } else if (message.method === 'item/tool/requestUserInput') {
          if (!Array.isArray(params.questions) || !params.questions.length || params.questions.length > 4) throw new ConversationError('unsupported', 'Codex requested unsupported user input.');
          const questions: ConversationQuestion[] = params.questions.map((value: unknown) => {
            if (!record(value) || typeof value.id !== 'string' || value.id.length > 128 || typeof value.question !== 'string' || value.question.length > 2048 || typeof value.header !== 'string' || value.header.length > 128 || value.isSecret || value.options != null && (!Array.isArray(value.options) || value.options.length > 8)) throw new ConversationError('unsupported', 'Codex requested unsupported or secret user input. Use its local CLI for that interaction.');
            const options = (value.options ?? []).map((option: unknown) => {
              if (!record(option) || typeof option.label !== 'string' || option.label.length > 256 || typeof option.description !== 'string' || option.description.length > 2048) throw new ConversationError('protocol', 'Codex returned invalid input choices.');
              return { label: option.label, description: option.description };
            });
            return { id: value.id, header: value.header, question: value.question, options, multiple: false, freeform: Boolean(value.isOther) || !options.length };
          });
          if (new Set(questions.map(question => question.id)).size !== questions.length) throw new ConversationError('protocol', 'Codex returned duplicate question identifiers.');
          const answer = await runtime.ask({ id: String(message.id), kind: 'questions', questions });
          if (!('answers' in answer)) throw new ConversationError('protocol', 'The input response is invalid.');
          peer.send({ id: message.id, result: { answers: Object.fromEntries(Object.entries(answer.answers).map(([key, answers]) => [key, { answers }])) } });
        } else {
          peer.send({ id: message.id, error: { code: -32601, message: 'This conversation does not support that operation.' } });
          throw new ConversationError('unsupported', 'Codex requested an unsupported approval or operation. This conversation cannot run commands, change files or contact other services.');
        }
      })().catch(error => peer.fail(error));
      return;
    }
    if (message.method === 'error') throw new ConversationError('provider', 'Codex could not continue. Check the selected model and local login, then start fresh.');
    if (!session || params.threadId !== session.id) return;
    if (message.method === 'turn/started' && record(params.turn)) turnId = params.turn.id;
    if (turnId && params.turnId && params.turnId !== turnId) return;
    if (['item/started', 'item/completed'].includes(message.method) && record(params.item) && params.item.type === 'fileChange') throw nativeOperationFailure();
    if (message.method === 'item/agentMessage/delta') {
      if (typeof params.delta !== 'string') throw new ConversationError('protocol', 'Codex returned an invalid text event.');
      emit({ type: 'text', text: params.delta });
    }
    if (message.method === 'turn/completed') {
      if (!record(params.turn) || params.turn.id !== turnId) throw new ConversationError('protocol', 'Codex completed a different turn.');
      if (params.turn.status !== 'completed') throw new ConversationError('provider', 'Codex stopped before completing the answer. Start a fresh conversation.');
      complete(session);
    }
  };
  const cancel = () => {
    if (session && turnId) { try { peer.send({ id: 'cancel', method: 'turn/interrupt', params: { threadId: session.id, turnId } }); } catch {} }
  };
  runtime.signal.addEventListener('abort', cancel, { once: true });
  try {
    await peer.request('initialize', { clientInfo: { name: 'repo_chap', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    peer.send({ method: 'initialized', params: {} });
    const account = await peer.request('account/read', { refreshToken: false });
    if (account.requiresOpenaiAuth !== false && !record(account.account)) throw new ConversationError('login', 'Codex is not logged in. Use the supported local Codex login, then start fresh.');
    const settings = await peer.request('config/read', { cwd: request.workingDirectory, includeLayers: false });
    if (!record(settings.config)) throw new ConversationError('settings', 'Cannot verify Codex conversation settings.');
    if (settings.config.instructions != null || settings.config.model_instructions_file != null) throw new ConversationError('settings', 'Codex has custom base instructions enabled. Use an instruction-free CODEX_HOME without instructions or model_instructions_file settings. Your question has not been sent.');
    const mcp = settings.config.mcp_servers ?? {};
    if (!record(mcp)) throw new ConversationError('settings', 'Cannot verify Codex MCP configuration.');
    const disabledMcp = Object.fromEntries(Object.entries(mcp).map(([name, value]) => {
      if (!record(value) || typeof value.command !== 'string' && typeof value.url !== 'string') throw new ConversationError('settings', 'Cannot disable an unsupported Codex MCP configuration.');
      return [name, { enabled: false, ...(typeof value.command === 'string' ? { command: value.command } : { url: value.url }) }];
    }));
    const skills = await peer.request('skills/list', { cwds: [request.workingDirectory], forceReload: true });
    if (!Array.isArray(skills.data) || skills.data.length !== 1 || !record(skills.data[0]) || skills.data[0].cwd !== request.workingDirectory || !Array.isArray(skills.data[0].skills) || !Array.isArray(skills.data[0].errors) || skills.data[0].errors.length) throw new ConversationError('settings', 'Cannot verify Codex skill configuration. Repair the local skill configuration before discussing this workflow.');
    const disabledSkills = skills.data[0].skills.map((skill: unknown) => {
      if (!record(skill) || typeof skill.path !== 'string' || !skill.path.startsWith('/') || skill.path.length > 4096) throw new ConversationError('settings', 'Cannot disable an unsupported Codex skill configuration.');
      return { path: skill.path, enabled: false };
    });
    const config = { ...options, mcp_servers: disabledMcp, skills: { config: disabledSkills } };
    const common = { model: request.profile.model, cwd: request.workingDirectory, approvalPolicy: 'never', sandbox: 'read-only', config, developerInstructions: runtime.instruction };
    const thread = request.session
      ? await peer.request('thread/resume', { ...common, threadId: request.session.id, excludeTurns: true })
      : await peer.request('thread/start', { ...common, allowProviderModelFallback: false, ephemeral: false, dynamicTools: (request.tools ?? []).map(({ name, description, inputSchema }) => ({ type: 'function', name, description, inputSchema })) });
    if (thread.model !== request.profile.model) throw new ConversationError('settings', 'Codex changed the requested model. The conversation has stopped without sending the question.');
    if (!Array.isArray(thread.instructionSources) || thread.instructionSources.length) throw new ConversationError('settings', 'Codex has ambient instructions enabled. Start Repo Chap with a separate instruction-free CODEX_HOME and log in there with the local Codex CLI. Your question has not been sent.');
    session = runtime.identify(thread.thread?.id); emit({ type: 'session', session });
    const turn = await peer.request('turn/start', { threadId: session.id, model: request.profile.model, effort, input: [{ type: 'text', text: runtime.input, text_elements: [] }] });
    if (!record(turn.turn) || typeof turn.turn.id !== 'string') throw new ConversationError('protocol', 'Codex did not start a supported turn.');
    turnId ??= turn.turn.id;
    const finished = await Promise.race([completed, peer.closed]);
    await peer.finishInput();
    await auditCodexTranscript(thread.thread?.path, finished.id, turnId!, request.workingDirectory, (request.tools ?? []).map(tool => tool.name), runtime.signal);
    return finished;
  } finally { runtime.signal.removeEventListener('abort', cancel); }
}
