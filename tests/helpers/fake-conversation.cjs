const fs = require('node:fs');
const readline = require('node:readline');
const cp = require('node:child_process');
const { provider, mode, log, childPid } = global.fixture;
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const save = value => fs.appendFileSync(log, JSON.stringify(value) + '\n');
save({ args });
if (args.includes('--version')) { console.log(mode === 'unsupported' ? 'old-provider' : provider === 'codex' ? 'codex-cli 0.154.0' : '2.1.236 (Claude Code)'); process.exit(); }
if (args.includes('--help')) {
  console.log('--stdio --strict-config generate-json-schema --print --input-format --output-format --include-partial-messages --verbose --resume --session-id --model --settings --setting-sources --strict-mcp-config --mcp-config --tools --allowedTools --permission-mode --disable-slash-commands --no-chrome --system-prompt stream-json\n--effort <level> (low, medium, high)\n--next'); process.exit();
}
if (args.includes('--bundled')) { send({ models: [{ slug: 'fictional-model', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium' }] }] }); process.exit(); }
const session = provider === 'codex' ? 'fictional-session' : 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const notify = (method, params) => send({ method, params: { threadId: session, turnId: 'turn-1', ...params } });
let pending;
const text = value => provider === 'codex' ? notify('item/agentMessage/delta', { delta: value }) : send({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: value } } });
const finish = () => {
  if (mode === 'burst') for (let i = 0; i < 6000; i++) text('x');
  text('The waiting rule uses the recorded test clock.');
  if (provider === 'codex') notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  else send({ type: 'result', subtype: 'success', is_error: false, session_id: session, permission_denials: [] });
  if (mode === 'unfinished-session') setInterval(() => {}, 1000);
};
const run = async () => {
  if (mode === 'exit') { process.exit(1); return; }
  if (mode === 'malformed') { process.stdout.write('invalid json\n'); return; }
  if (mode === 'flood') { process.stdout.write('x'.repeat(2 * 1024 * 1024)); return; }
  if (mode === 'hang') {
    const child = cp.spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
    fs.writeFileSync(childPid, String(child.pid)); setInterval(() => {}, 1000); return;
  }
  if (mode === 'input' || mode === 'unsupported-input' || mode === 'approval') {
    pending = 'input';
    if (provider === 'codex') send({ id: 77, method: mode === 'unsupported-input' ? 'item/commandExecution/requestApproval' : 'item/tool/requestUserInput', params: { threadId: session, turnId: 'turn-1', isBlocking: true, questions: [{ id: 'scope', header: 'Scope', question: 'Which rule?', isOther: true, options: [{ label: 'Waiting', description: 'Use the waiting rule.' }] }] } });
    else send({ type: 'control_request', request_id: 'input-1', request: { subtype: 'can_use_tool', tool_name: mode === 'unsupported-input' ? 'Bash' : mode === 'approval' ? 'mcp__repo_chap__read_context' : 'AskUserQuestion', input: { questions: [{ header: 'Scope', question: 'Which rule?', multiSelect: false, options: [{ label: 'Waiting', description: 'Use the waiting rule.' }] }] } } });
    return;
  }
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
  if (provider === 'codex') {
    const respond = result => send({ id: message.id, result });
    if (message.method === 'initialize') respond({ userAgent: 'fictional-codex' });
    if (message.method === 'account/read') respond({ requiresOpenaiAuth: true, account: mode === 'login' ? null : { type: 'chatgpt' } });
    if (message.method === 'config/read') respond({ config: { mcp_servers: { 'ambient.with.dot': { enabled: true, url: 'https://example.invalid/mcp' } } }, origins: {} });
    if (message.method === 'thread/start' || message.method === 'thread/resume') respond({ thread: { id: session }, model: 'fictional-model' });
    if (message.method === 'turn/start') { respond({ turn: { id: 'turn-1' } }); notify('turn/started', { turn: { id: 'turn-1' } }); void run(); }
    if ((message.id === 77 || message.id === 78) && pending) { pending = null; finish(); }
  } else {
    if (message.type === 'control_request' && message.request.subtype === 'initialize') send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { account: { tokenSource: mode === 'login' ? 'none' : 'oauth', apiKeySource: 'none' } } } });
    if (message.type === 'user') { send({ type: 'system', subtype: 'init', session_id: session, tools: ['AskUserQuestion', 'mcp__repo_chap__read_context'], mcp_servers: [{ name: 'repo_chap', status: 'connected' }] }); void run(); }
    if (message.type === 'control_response' && pending) { pending = null; finish(); }
  }
});
