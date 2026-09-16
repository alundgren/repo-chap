import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { conversationLimits, runConversationTurn, type ConversationEvent, type ConversationInputRequest, type ConversationTurnRequest } from '@repo-chap/providers';

async function setup(provider: 'codex' | 'claude', mode = 'valid') {
  const root = await mkdtemp(join(tmpdir(), 'repo-chap-conversation-'));
  const log = join(root, 'calls.jsonl'), childPid = join(root, 'child.pid'), executable = join(root, 'provider');
  await writeFile(executable, `#!${process.execPath}\nglobal.fixture=${JSON.stringify({ provider, mode, log, childPid })};require(${JSON.stringify(resolve('tests/helpers/fake-conversation.cjs'))});`, { mode: 0o700 });
  const events: ConversationEvent[] = [], inputs: ConversationInputRequest[] = [];
  const request: ConversationTurnRequest = {
    profile: { provider, executable, name: 'authoring', model: 'fictional-model', effort: 'medium', timeoutMs: 5000, maxOutputBytes: 4 * 1024 * 1024, maxAttempts: 1, maximumCapabilities: [] },
    workingDirectory: root, prompt: 'Why is this rule waiting?', context: JSON.stringify({ sessionId: 'draft-1', revision: 3, test: { revision: 2, status: 'waiting' } }),
    tools: [{ name: 'read_context', description: 'Read the captured workflow context.', inputSchema: { type: 'object', additionalProperties: false }, execute: async () => ({ text: 'actual test revision 2; waiting' }) }],
    onEvent: event => events.push(event), onInput: async input => {
      inputs.push(input);
      return input.kind === 'approval' ? { decision: 'deny' } : { answers: Object.fromEntries(input.questions.map(question => [question.id, ['Waiting']])) };
    },
  };
  return { root, request, events, inputs, childPid, calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), cleanup: () => rm(root, { recursive: true, force: true }) };
}

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider} conversation streams a host tool result and resumes with new context`, async () => {
    const f = await setup(provider);
    try {
      const first = await runConversationTurn(f.request); assert.equal(first.status, 'completed');
      assert(f.events.some(event => event.type === 'text' && event.text.includes('recorded test clock')));
      assert(f.events.some(event => event.type === 'tool' && event.status === 'completed'));
      if (first.status !== 'completed') return;
      const second = await runConversationTurn({ ...f.request, session: first.session, context: 'draft revision 4; test revision 2 is stale' });
      assert.equal(second.status, 'completed'); if (second.status === 'completed') assert.equal(second.session.turns, 2);
      const calls = await f.calls();
      assert(JSON.stringify(calls).includes('draft revision 4; test revision 2 is stale'));
      if (provider === 'codex') {
        assert(calls.some(call => call.message?.method === 'thread/resume' && call.message.params.threadId === first.session.id));
        assert(calls.some(call => call.message?.method === 'thread/start' && call.message.params.config.mcp_servers['ambient.with.dot'].enabled === false));
      } else {
        assert(calls.some(call => call.args?.includes('--resume') && call.args.includes(first.session.id)));
        assert(calls.some(call => call.toolResult?.result.content[0].text === 'actual test revision 2; waiting'));
        assert(calls.every(call => !call.args?.includes('--safe-mode') && !call.args?.includes('--bare')));
      }
      const wrongProvider = { ...first.session, provider: provider === 'codex' ? 'claude' as const : 'codex' as const };
      assert.equal((await runConversationTurn({ ...f.request, session: wrongProvider })).status, 'error');
      assert.equal((await runConversationTurn({ ...f.request, session: { ...first.session, turns: conversationLimits.turns } })).status, 'error');
    } finally { await f.cleanup(); }
  });
  test(`${provider} maps supported user input to its own protocol`, async () => {
    const f = await setup(provider, 'input');
    try {
      assert.equal((await runConversationTurn(f.request)).status, 'completed');
      assert.equal(f.inputs[0]?.kind, 'questions');
      const calls = await f.calls();
      if (provider === 'codex') assert(calls.some(call => call.message?.result?.answers?.scope?.answers[0] === 'Waiting'));
      else assert(calls.some(call => call.message?.response?.response?.updatedInput?.answers?.['Which rule?'] === 'Waiting'));
    } finally { await f.cleanup(); }
  });
  for (const [mode, code] of [['unsupported', 'unsupported'], ['login', 'login'], ['unsupported-input', 'unsupported'], ['unknown-tool', 'unsupported'], ['malformed', 'protocol'], ['flood', 'limit'], ['exit', 'provider']] as const) {
    test(`${provider} conversation reports ${mode} without completing`, async () => {
      const f = await setup(provider, mode);
      try {
        const result = await runConversationTurn(f.request);
        assert.equal(result.status, 'error'); if (result.status === 'error') assert.equal(result.code, code);
        assert(!f.events.some(event => event.type === 'completed'));
      } finally { await f.cleanup(); }
    });
  }
  test(`${provider} cancellation stops a pending input and a provider child process`, async () => {
    for (const mode of ['input', 'hang']) {
      const f = await setup(provider, mode), controller = new AbortController();
      try {
        let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
        const turn = runConversationTurn({ ...f.request, signal: controller.signal, onInput: (_input, signal) => { ready(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); } });
        if (mode === 'input') await started;
        else for (let i = 0; i < 100; i++) { if (await readFile(f.childPid, 'utf8').catch(() => '')) break; await new Promise(resolve => setTimeout(resolve, 10)); }
        controller.abort(); assert.equal((await turn).status, 'cancelled');
        if (mode === 'hang') {
          const pid = Number(await readFile(f.childPid, 'utf8'));
          for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await new Promise(resolve => setTimeout(resolve, 10)); }
          assert.throws(() => process.kill(pid, 0));
        }
      } finally { await f.cleanup(); }
    }
  });
  test(`${provider} event bursts yield to the host event loop and honor the output ceiling`, async () => {
    const f = await setup(provider, 'burst'); let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      assert.equal((await runConversationTurn(f.request)).status, 'completed'); assert(ticks > 0);
      assert.equal(f.events.filter(event => event.type === 'text').length, 6001);
      const bounded = await runConversationTurn({ ...f.request, profile: { ...f.request.profile, maxOutputBytes: 16 * 1024 } });
      assert.equal(bounded.status, 'error'); if (bounded.status === 'error') assert.equal(bounded.code, 'limit');
    } finally { clearInterval(timer); await f.cleanup(); }
  });
  test(`${provider} input deadline cancels the pending response`, async () => {
    const f = await setup(provider, 'input'); let inputCancelled = false;
    try {
      const result = await runConversationTurn({ ...f.request, profile: { ...f.request.profile, timeoutMs: 750 }, onInput: (_input, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => { inputCancelled = true; reject(new Error('deadline')); }, { once: true })) });
      assert.equal(result.status, 'error'); if (result.status === 'error') assert.equal(result.code, 'timeout');
      assert(inputCancelled);
    } finally { await f.cleanup(); }
  });
  test(`${provider} keeps the answer but refuses resume when session completion does not finish`, async () => {
    const f = await setup(provider, 'unfinished-session');
    try {
      const result = await runConversationTurn(f.request);
      assert.equal(result.status, 'error'); if (result.status === 'error') assert.equal(result.code, 'session');
      assert(f.events.some(event => event.type === 'text'));
      assert(!f.events.some(event => event.type === 'completed'));
    } finally { await f.cleanup(); }
  });
}

test('Claude local-tool approval denial returns the supported protocol response', async () => {
  const f = await setup('claude', 'approval');
  try {
    assert.equal((await runConversationTurn(f.request)).status, 'completed');
    assert.equal(f.inputs[0]?.kind, 'approval');
    assert((await f.calls()).some(call => call.message?.response?.response?.behavior === 'deny'));
  } finally { await f.cleanup(); }
});

test('conversation rejects oversized context before starting the provider', async () => {
  const f = await setup('codex');
  try {
    const result = await runConversationTurn({ ...f.request, context: 'x'.repeat(conversationLimits.contextBytes + 1) });
    assert.equal(result.status, 'error'); if (result.status === 'error') assert.equal(result.code, 'limit');
    assert.equal(await f.calls().catch(() => null), null);
  } finally { await f.cleanup(); }
});
