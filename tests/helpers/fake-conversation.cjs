const fs = require('node:fs');
const readline = require('node:readline');
const cp = require('node:child_process');
const { provider, log, childPid, modeFile, noTools } = global.fixture;
const mode = modeFile ? fs.readFileSync(modeFile, 'utf8').trim() : global.fixture.mode;
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const save = value => fs.appendFileSync(log, JSON.stringify(value) + '\n');
save({ args });
if (args.includes('--version')) { console.log(provider === 'codex' ? `codex-cli ${mode === 'upgraded' ? '9.0.0-preview.1' : '0.154.0'}` : `${mode === 'upgraded' ? '9.0.0-preview.1' : '2.1.236'} (Claude Code)`); process.exit(); }
if (args.includes('--help')) {
  if (mode === 'unsupported') { console.log('Required conversation controls unavailable'); process.exit(); }
  console.log('--stdio --strict-config generate-json-schema --print --input-format --output-format --include-partial-messages --verbose --resume --session-id --model --settings --setting-sources --strict-mcp-config --mcp-config --tools --allowedTools --permission-mode --disable-slash-commands --no-chrome --system-prompt stream-json\n--effort <level> (low, medium, high)\n--next'); process.exit();
}
if (args.includes('--bundled')) { send({ models: [{ slug: 'fictional-model', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium' }] }] }); process.exit(); }
const session = provider === 'codex' ? 'fictional-session' : 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const transcript = require('node:path').join(process.cwd(), 'provider-transcript.jsonl');
const writeTranscript = () => {
  if (mode === 'audit-missing') return;
  const item = (type, payload) => ({ type, payload });
  const lines = [item('session_meta', { id: mode === 'audit-session' ? 'other-session' : session, session_id: session, cwd: process.cwd(), cli_version: mode === 'audit-version' || mode === 'upgraded' ? '9.0.0-preview.1' : '0.154.0' }),
    item('event_msg', { type: 'task_started', turn_id: 'turn-1' }), item('turn_context', { turn_id: mode === 'audit-turn' ? 'other-turn' : 'turn-1', cwd: process.cwd() })];
  if (mode === 'native-denial' || mode === 'author-native-denial') lines.push(item('response_item', { type: 'custom_tool_call', name: 'apply_patch', input: 'fictional denied edit' }));
  lines.push(item('response_item', { type: 'message', role: 'assistant', content: [] }));
  if (mode !== 'audit-incomplete') lines.push(item('event_msg', { type: 'task_complete', turn_id: 'turn-1' }));
  if (mode === 'audit-ambiguous') lines.push(item('event_msg', { type: 'task_started', turn_id: 'other-turn' }));
  fs.writeFileSync(transcript, lines.map(value => JSON.stringify(value)).join('\n') + (mode === 'audit-truncated' ? '' : '\n'), { mode: 0o600 });
  if (mode === 'audit-oversize') fs.truncateSync(transcript, 33 * 1024 * 1024);
};
const notify = (method, params) => send({ method, params: { threadId: session, turnId: 'turn-1', ...params } });
let pending;
let currentInput = '';
const authoringReplies = new Map();
const authoring = async () => {
  const plan = JSON.parse(fs.readFileSync(global.fixture.planFile, 'utf8'));
  const context = JSON.parse(currentInput.split('Current immutable workflow context:\n')[1].split('\n\nQuestion:\n')[0].split('\n\nEarlier visible conversation excerpt.')[0]);
  const initial = context.document.token;
  let token = initial;
  const requests = [], results = [];
  const config = provider === 'claude' ? JSON.parse(option('--mcp-config')).mcpServers.repo_chap : null;
  const rpc = async (id, method, params) => {
    const response = await fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    return response.json();
  };
  if (config) { await rpc(0, 'initialize', { protocolVersion: '2025-03-26' }); save({ tools: await rpc(1, 'tools/list', {}) }); }
  text('I will use the typed authoring operations. ');
  for (let index = 0; index < plan.steps.length; index++) {
    const step = plan.steps[index];
    if (step.gate) { save({ waitingForStep: index }); while (!fs.existsSync(step.gate)) await new Promise(resolve => setTimeout(resolve, 50)); }
    if (step.delayMs) { save({ waitingForStep: index }); await new Promise(resolve => setTimeout(resolve, step.delayMs)); }
    const operation = step.duplicateOf !== undefined ? requests[step.duplicateOf] : step.tool ? { ...step.arguments, expected: step.stale ? initial : token } : { operationId: `${plan.id}-${index}`, expected: step.stale ? initial : token, action: step.action };
    const tool = step.tool ?? 'author';
    requests.push(operation);
    let response;
    if (provider === 'codex') {
      const id = 1000 + index;
      const waiting = new Promise(resolve => authoringReplies.set(id, resolve));
      send({ id, method: 'item/tool/call', params: { threadId: session, turnId: 'turn-1', callId: `author-${index}`, tool, arguments: operation } });
      response = await waiting;
      response = response.result.contentItems[0].text;
    } else response = (await rpc(1000 + index, 'tools/call', { name: tool, arguments: operation })).result.content[0].text;
    const result = JSON.parse(response); results.push(result); save({ authoringResult: result, step: index });
    if (result.context) token = result.context.token;
    if (result.prepared) text('Prepared only. Review the proposal in Live trial and press Start when ready. ');
    if (result.data?.comparison) text(`The actual offline test ${result.data.comparison.passed ? 'passed' : 'failed'}: ${JSON.stringify(result.data.comparison.checks)}. `);
  }
  save({ authoringDone: true, results: results.length });
  if (mode === 'author-cancel') { text('The edits are applied; this fictional provider is waiting.'); setInterval(() => {}, 1000); return; }
  finish();
};
const text = value => provider === 'codex' ? notify('item/agentMessage/delta', { delta: value }) : send({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: value } } });
const finish = () => {
  if (mode === 'burst') for (let i = 0; i < 6000; i++) text('x');
  text('The waiting rule uses the recorded test clock.');
  if (provider === 'codex') { writeTranscript(); notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } }); }
  else send({ type: 'result', subtype: 'success', is_error: false, session_id: session, permission_denials: [] });
  if (mode === 'unfinished-session') setInterval(() => {}, 1000);
};
const run = async () => {
  if (mode.startsWith('author')) { await authoring(); return; }
  if (mode === 'exit') { process.exit(1); return; }
  if (mode === 'malformed') { process.stdout.write('invalid json\n'); return; }
  if (mode === 'flood') { process.stdout.write('x'.repeat(2 * 1024 * 1024)); return; }
  if (mode === 'hang') {
    const child = cp.spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
    fs.writeFileSync(childPid, String(child.pid)); setInterval(() => {}, 1000); return;
  }
  if (mode === 'stream') { text('A partial answer about this workflow. '); setTimeout(finish, 800); return; }
  if (mode === 'long') { text('Long fictional answer. '.repeat(8000)); finish(); return; }
  if (mode === 'native-edit') { notify('item/started', { item: { id: 'native-file-1', type: 'fileChange', status: 'inProgress', changes: [] } }); finish(); return; }
  if (mode === 'input' || mode === 'unsupported-input' || mode === 'approval') {
    pending = 'input';
    if (provider === 'codex') send({ id: 77, method: mode === 'unsupported-input' ? 'item/commandExecution/requestApproval' : 'item/tool/requestUserInput', params: { threadId: session, turnId: 'turn-1', isBlocking: true, questions: [{ id: 'scope', header: 'Scope', question: 'Which rule?', isOther: true, options: [{ label: 'Waiting', description: 'Use the waiting rule.' }] }] } });
    else send({ type: 'control_request', request_id: 'input-1', request: { subtype: 'can_use_tool', tool_name: mode === 'unsupported-input' ? 'Bash' : mode === 'approval' ? 'mcp__repo_chap__read_context' : 'AskUserQuestion', input: { questions: [{ header: 'Scope', question: 'Which rule?', multiSelect: false, options: [{ label: 'Waiting', description: 'Use the waiting rule.' }] }] } } });
    return;
  }
  if (noTools && mode !== 'unknown-tool') { finish(); return; }
  const name = mode === 'unknown-tool' ? 'change_files' : 'read_context';
  if (provider === 'codex') { pending = 'tool'; send({ id: 78, method: 'item/tool/call', params: { threadId: session, turnId: 'turn-1', callId: 'call-context', tool: name, arguments: {} } }); }
  else {
    const config = JSON.parse(option('--mcp-config')).mcpServers.repo_chap;
    const rpc = async (id, method, params) => {
      const response = await fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      return response.json();
    };
    await rpc(0, 'initialize', { protocolVersion: '2025-03-26' });
    save({ tools: await rpc(1, 'tools/list', {}) });
    save({ toolResult: await rpc(2, 'tools/call', { name, arguments: {} }) });
    finish();
  }
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); save({ message });
  if (authoringReplies.has(message.id)) { authoringReplies.get(message.id)(message); authoringReplies.delete(message.id); return; }
  if (provider === 'codex') {
    const respond = result => send({ id: message.id, result });
    if (message.method === 'initialize') respond({ userAgent: 'fictional-codex' });
    if (message.method === 'account/read') respond({ requiresOpenaiAuth: true, account: mode === 'login' ? null : { type: 'chatgpt' } });
    if (message.method === 'config/read') respond({ config: { instructions: mode === 'base-instructions' ? 'Fictional ambient instructions.' : null, model_instructions_file: mode === 'base-instructions-file' ? '/fictional/base-instructions.md' : null, mcp_servers: { 'ambient.with.dot': { enabled: true, url: 'https://example.invalid/mcp' } } }, origins: {} });
    if (message.method === 'skills/list') respond({ data: [{ cwd: message.params.cwds[0], skills: [{ path: '/fictional/ambient-skill/SKILL.md', enabled: true }], errors: mode === 'skills-error' ? [{ message: 'Cannot read a fictional skill.' }] : [] }] });
    if (message.method === 'thread/start' || message.method === 'thread/resume') respond({ thread: { id: session, path: transcript }, model: 'fictional-model', ...(mode === 'missing-instruction-sources' ? {} : { instructionSources: mode === 'ambient-instructions' ? ['/fictional/AGENTS.md'] : [] }) });
    if (message.method === 'turn/start') { currentInput = message.params.input[0].text; respond({ turn: { id: 'turn-1' } }); notify('turn/started', { turn: { id: 'turn-1' } }); void run(); }
    if ((message.id === 77 || message.id === 78) && pending) { pending = null; finish(); }
  } else {
    if (message.type === 'control_request' && message.request.subtype === 'initialize') send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { account: { tokenSource: mode === 'login' ? 'none' : 'oauth', apiKeySource: 'none' } } } });
    if (message.type === 'user') { currentInput = message.message.content; send({ type: 'system', subtype: 'init', session_id: session, tools: ['AskUserQuestion', ...(mode.startsWith('author') ? [...new Set(JSON.parse(fs.readFileSync(global.fixture.planFile, 'utf8')).steps.map(step => `mcp__repo_chap__${step.tool ?? 'author'}`))] : noTools ? [] : ['mcp__repo_chap__read_context'])], mcp_servers: [{ name: 'repo_chap', status: 'connected' }] }); void run(); }
    if (message.type === 'control_response' && pending) { pending = null; finish(); }
  }
});
