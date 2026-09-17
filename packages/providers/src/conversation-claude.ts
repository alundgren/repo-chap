import { randomUUID } from 'node:crypto';
import { ConversationError, type ConversationQuestion, type ConversationSessionIdentity } from './conversation-types.js';
import { record } from './conversation-process.js';
import type { ConversationProcess } from './conversation-process.js';
import { openConversationMcp } from './conversation-mcp.js';
import type { ConversationRuntime } from './conversation.js';

export async function runClaudeConversation(runtime: ConversationRuntime): Promise<ConversationSessionIdentity> {
  const { request, probe, emit } = runtime;
  const help = await probe(['--help']);
  const flags = ['--print', '--input-format', '--output-format', '--include-partial-messages', '--verbose', '--resume', '--session-id', '--model', '--effort', '--settings', '--setting-sources', '--strict-mcp-config', '--mcp-config', '--tools', '--allowedTools', '--permission-mode', '--disable-slash-commands', '--no-chrome', '--system-prompt'];
  if (flags.some(flag => !help.includes(flag)) || !help.includes('stream-json')) throw new ConversationError('unsupported', 'The installed Claude Code lacks the required streaming, resume or local-tool controls.');
  const effort = request.profile.effort ?? 'medium';
  const supported = help.match(/--effort\b([\s\S]*?)(?=\n\s*(?:--|-[a-zA-Z],)|$)/)?.[1]?.match(/\(([^)]+)\)/)?.[1]?.split(',').map(value => value.trim());
  if (!supported?.includes(effort)) throw new ConversationError('settings', 'Claude Code does not advertise the selected effort. Choose a supported profile.');
  if (request.session && !/^[a-f0-9-]{36}$/i.test(request.session.id)) throw new ConversationError('session', 'This is not a Claude conversation session. Start fresh.');
  const tools = request.tools ?? [];
  let peer: ConversationProcess | undefined;
  const bridge = await openConversationMcp(tools, async (id, name, args) => {
    try { return await runtime.callTool(id, name, args); }
    catch (error) { peer?.fail(error instanceof Error ? error : new ConversationError('provider', 'The local tool was interrupted.')); throw error; }
  });
  if (runtime.signal.aborted) { bridge.close(); throw runtime.signal.reason; }
  let session: ConversationSessionIdentity | undefined, hasText = false;
  let complete!: (session: ConversationSessionIdentity) => void;
  const completed = new Promise<ConversationSessionIdentity>(resolve => { complete = resolve; });
  const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', request.profile.model, '--effort', effort,
    '--setting-sources', '', '--settings', JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }), '--strict-mcp-config', '--mcp-config', JSON.stringify(bridge.config),
    '--permission-mode', 'manual', '--permission-prompt-tool', 'stdio', '--tools', 'AskUserQuestion',
    ...(tools.length ? ['--allowedTools', tools.map(tool => `mcp__repo_chap__${tool.name}`).join(',')] : []),
    '--disable-slash-commands', '--no-chrome', '--system-prompt', runtime.instruction,
    ...(request.session ? ['--resume', request.session.id] : ['--session-id', randomUUID()])];
  peer = runtime.spawn(args);
  const process_ = peer;
  peer.onMessage = message => {
    if (message.type === 'control_request') {
      void (async () => {
        const input = message.request;
        if (typeof message.request_id !== 'string' || message.request_id.length > 128 || !record(input) || input.subtype !== 'can_use_tool' || !record(input.input)) throw new ConversationError('unsupported', 'Claude requested an unsupported interaction. Start a fresh conversation.');
        let response: Record<string, unknown>;
        if (input.tool_name === 'AskUserQuestion') {
          if (!Array.isArray(input.input.questions) || !input.input.questions.length || input.input.questions.length > 4) throw new ConversationError('unsupported', 'Claude requested unsupported user input.');
          const questions: ConversationQuestion[] = input.input.questions.map((value: unknown, index: number) => {
            if (!record(value) || typeof value.question !== 'string' || value.question.length > 2048 || typeof value.header !== 'string' || value.header.length > 128 || !Array.isArray(value.options) || value.options.length > 8) throw new ConversationError('protocol', 'Claude returned invalid input choices.');
            const options = value.options.map((option: unknown) => {
              if (!record(option) || typeof option.label !== 'string' || option.label.length > 256 || typeof option.description !== 'string' || option.description.length > 2048) throw new ConversationError('protocol', 'Claude returned invalid input choices.');
              return { label: option.label, description: option.description };
            });
            return { id: `question-${index}`, header: value.header, question: value.question, options, multiple: value.multiSelect === true, freeform: true };
          });
          if (new Set(questions.map(question => question.question)).size !== questions.length) throw new ConversationError('protocol', 'Claude repeated the same question.');
          const answer = await runtime.ask({ id: message.request_id, kind: 'questions', questions });
          if (!('answers' in answer)) throw new ConversationError('protocol', 'The input response is invalid.');
          response = { behavior: 'allow', updatedInput: { ...input.input, answers: Object.fromEntries(questions.map(question => [question.question, answer.answers[question.id]!.join(', ')])) } };
        } else if (tools.some(tool => `mcp__repo_chap__${tool.name}` === input.tool_name)) {
          const name = input.tool_name.slice('mcp__repo_chap__'.length);
          const answer = await runtime.ask({ id: message.request_id, kind: 'approval', tool: name, description: tools.find(tool => tool.name === name)!.description });
          response = 'decision' in answer && answer.decision === 'allow' ? { behavior: 'allow', updatedInput: input.input } : { behavior: 'deny', message: 'The person declined this local tool.' };
        } else {
          process_.send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { behavior: 'deny', message: 'Only registered local authoring tools are supported.' } } });
          throw new ConversationError('unsupported', 'Claude requested an unsupported tool. This conversation cannot run commands, change files or contact other services.');
        }
        process_.send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } });
      })().catch(error => process_.fail(error));
      return;
    }
    if (message.type === 'system' && message.subtype === 'init') {
      session = runtime.identify(message.session_id);
      const allowed = ['AskUserQuestion', ...tools.map(tool => `mcp__repo_chap__${tool.name}`)];
      if (!Array.isArray(message.tools) || message.tools.some((name: unknown) => typeof name !== 'string' || !allowed.includes(name))) throw new ConversationError('settings', 'Claude enabled tools outside this conversation. Check the local CLI configuration.');
      if (tools.length && (!Array.isArray(message.mcp_servers) || !message.mcp_servers.some((server: unknown) => record(server) && server.name === 'repo_chap' && server.status === 'connected'))) throw new ConversationError('settings', 'Claude could not connect to the local authoring tools. Start fresh.');
      emit({ type: 'session', session });
    }
    if (message.type === 'stream_event' && record(message.event) && message.event.type === 'content_block_delta' && record(message.event.delta) && message.event.delta.type === 'text_delta') {
      if (typeof message.event.delta.text !== 'string') throw new ConversationError('protocol', 'Claude returned invalid streamed text.');
      hasText = true; emit({ type: 'text', text: message.event.delta.text });
    }
    if (message.type === 'result') {
      if (message.is_error !== false || message.subtype !== 'success') throw new ConversationError('provider', 'Claude could not complete the answer. Check the selected model and local login, then start fresh.');
      if (Array.isArray(message.permission_denials) && message.permission_denials.length) throw new ConversationError('unsupported', 'Claude requested tools outside this authoring conversation. Start fresh.');
      session = runtime.identify(message.session_id);
      if (!hasText && typeof message.result === 'string') emit({ type: 'text', text: message.result });
      complete(session);
    }
  };
  const cancel = () => { try { process_.send({ type: 'control_request', request_id: 'cancel', request: { subtype: 'interrupt' } }); } catch {} };
  runtime.signal.addEventListener('abort', cancel, { once: true });
  try {
    const initialized = await peer.control({ subtype: 'initialize' });
    if (!record(initialized.account) || (!initialized.account.tokenSource || initialized.account.tokenSource === 'none') && (!initialized.account.apiKeySource || initialized.account.apiKeySource === 'none')) throw new ConversationError('login', 'Claude Code is not logged in. Use its supported local login, then start fresh.');
    peer.send({ type: 'user', message: { role: 'user', content: runtime.input } });
    const finished = await Promise.race([completed, peer.closed]);
    await peer.finishInput();
    return finished;
  } finally { runtime.signal.removeEventListener('abort', cancel); bridge.close(); }
}
