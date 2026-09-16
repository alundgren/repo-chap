import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { conversationLimits } from '@repo-chap/providers';
import type { ConversationInputRequest, ConversationSessionIdentity, ConversationTurnRequest, ConversationTurnResult, ProviderProfile } from '@repo-chap/providers';
import { ConversationController, desktopConversationLimits } from '../apps/desktop/src/conversations.ts';
import type { CapturedConversationContext, ConversationSnapshot, ConversationTurn } from '../apps/desktop/src/conversation-protocol.ts';

const profile = (provider: 'codex' | 'claude' = 'codex'): ProviderProfile => ({
  provider, name: `${provider}-author`, executable: '/fictional/provider', model: 'fictional-model', effort: 'medium',
  timeoutMs: 120_000, maxOutputBytes: 1024 * 1024, maxAttempts: 1, maximumCapabilities: [],
});
const context = (revision = 1, text = 'Captured fictional workflow and actual caller-supplied evidence.'): CapturedConversationContext => ({
  text, document: { sessionId: 'fictional-document', revision }, provenance: `Document revision ${revision}.`,
});
const input: ConversationInputRequest = {
  id: 'question-1', kind: 'questions',
  questions: [{ id: 'reason', header: 'Reason', question: 'Which path?', options: [{ label: 'Waiting', description: 'Wait for another observation.' }], multiple: false, freeform: false }],
};
interface Call { request: ConversationTurnRequest; resolve(result: ConversationTurnResult): void }
function setup(onChange?: (snapshot: ConversationSnapshot) => void) {
  const calls: Call[] = [], snapshots: ConversationSnapshot[] = [];
  const selected = profile();
  const controller = new ConversationController({
    documentSessionId: 'fictional-document', workingDirectory: '/fictional/private-conversation', profile: selected,
    onChange(snapshot) { snapshots.push(snapshot); onChange?.(snapshot); },
    runTurn: request => new Promise(resolve => { calls.push({ request, resolve }); }),
  });
  return { controller, calls, snapshots, selected };
}
async function dispatched(fixture: ReturnType<typeof setup>): Promise<Call> {
  await Promise.resolve();
  return fixture.calls.at(-1)!;
}
function complete(call: Call, id = 'native-session'): ConversationSessionIdentity {
  const session: ConversationSessionIdentity = {
    provider: call.request.profile.provider, version: 'fixture-version', binding: 'private-binding', id, turns: (call.request.session?.turns ?? 0) + 1,
  };
  call.request.onEvent({ type: 'session', session });
  call.request.onEvent({ type: 'completed', session });
  call.resolve({ status: 'completed', session });
  return session;
}
function turns(controller: ConversationController): ConversationTurn[] {
  return controller.snapshot().history.filter((entry): entry is ConversationTurn => entry.kind === 'turn');
}

test('conversation captures immutable context, keeps provider identity private, and resumes only completed turns', async () => {
  const fixture = setup(), captured = context();
  const done = fixture.controller.send('Why is this rule waiting?', captured);
  captured.text = 'changed after dispatch'; captured.document.revision = 999; fixture.selected.model = 'changed';
  assert.throws(() => fixture.controller.send('Overlapping question', context()), /current conversation operation/);
  const call = await dispatched(fixture);
  assert.equal(call.request.context, context().text);
  assert.equal(call.request.profile.model, 'fictional-model');
  assert.deepEqual(call.request.tools, []);
  assert.equal(call.request.session, undefined);
  call.request.onEvent({ type: 'text', text: 'It awaits another observation.' });
  const session = complete(call);
  assert.equal(fixture.controller.snapshot().session, null);
  await done;
  const snapshot = fixture.controller.snapshot(), turn = turns(fixture.controller)[0]!;
  assert.equal(turn.context.document.revision, 1);
  assert.equal(turn.context.digest, createHash('sha256').update(context().text).digest('hex'));
  assert.equal(turn.answer, 'It awaits another observation.');
  assert.equal(turn.sessionId, session.id);
  assert.equal(turn.status, 'completed');
  assert.deepEqual(snapshot.session, { id: session.id, version: session.version, turns: 1 });
  assert.doesNotMatch(JSON.stringify(snapshot), /private-binding|private-conversation|\/fictional\/provider/);
  snapshot.history.length = 0;
  assert.equal(fixture.controller.snapshot().history.length, 1);
  const next = fixture.controller.send('And now?', context(2, 'Updated captured workflow.'));
  const resumed = await dispatched(fixture);
  assert.deepEqual(resumed.request.session, session);
  assert.equal(resumed.request.context, 'Updated captured workflow.');
  complete(resumed); await next;
  assert.equal(turns(fixture.controller)[0]!.context.document.revision, 1);
  assert.equal(turns(fixture.controller)[1]!.context.document.revision, 2);
});

test('provider failure retains partial text and provenance and requires an explicit fresh session', async () => {
  const fixture = setup();
  const first = fixture.controller.send('First question', context());
  complete(await dispatched(fixture)); await first;
  const failed = fixture.controller.send('Second question', context(2));
  const call = await dispatched(fixture);
  call.request.onEvent({ type: 'text', text: 'Partial answer' });
  call.request.onEvent({ type: 'error', code: 'session', message: 'Session could not be persisted. Start fresh.' });
  call.request.onEvent({ type: 'text', text: 'late text' });
  call.resolve({ status: 'error', code: 'session', message: 'Session could not be persisted. Start fresh.' });
  await failed;
  assert.equal(turns(fixture.controller)[1]!.answer, 'Partial answer');
  assert.equal(turns(fixture.controller)[1]!.error?.code, 'session');
  assert.equal(fixture.controller.snapshot().session, null);
  assert.equal(fixture.controller.snapshot().requiresFresh, true);
  assert.throws(() => fixture.controller.send('Unsafe resume', context()), /Start a fresh/);
  await fixture.controller.fresh();
  assert.equal(turns(fixture.controller).length, 2);
  assert.equal(fixture.controller.snapshot().history.at(-1)?.kind, 'notice');
  const recovery = fixture.controller.send('Recover', context(3));
  const fresh = await dispatched(fixture);
  assert.equal(fresh.request.session, undefined);
  assert.equal(fresh.request.context, context(3).text);
  complete(fresh, 'different-session'); await recovery;
});

test('provider changes keep attributed visible history and attach dialogue to a new native session', async () => {
  const fixture = setup();
  const first = fixture.controller.send('Explain the rule', context());
  const call = await dispatched(fixture);
  call.request.onEvent({ type: 'text', text: 'The rule is waiting.' });
  const answer = call.request.onInput(input, call.request.signal!);
  fixture.controller.answer(fixture.controller.snapshot().activeTurnId!, input.id, { answers: { reason: ['Waiting'] } });
  await answer;
  complete(call, 'codex-session'); await first;
  const oldId = fixture.controller.snapshot().id;
  await fixture.controller.selectProvider(profile('claude'));
  let snapshot = fixture.controller.snapshot();
  assert.notEqual(snapshot.id, oldId);
  assert.equal(snapshot.session, null);
  const notice = snapshot.history.at(-1)!;
  assert.equal(notice.kind, 'notice');
  if (notice.kind === 'notice') assert.deepEqual(notice.handoff, { status: 'pending', includedTurns: 1, omittedTurns: 0, truncated: false });
  const switched = fixture.controller.send('Discuss the new test', context(2, 'Current captured test evidence.'));
  const claude = await dispatched(fixture);
  assert.equal(claude.request.profile.provider, 'claude');
  assert.equal(claude.request.session, undefined);
  assert.match(claude.request.context, /^Current captured test evidence\./);
  assert.match(claude.request.context, /dialogue, not evidence/);
  assert.match(claude.request.context, /"provider":"codex"/);
  assert.match(claude.request.context, /Which path\?/);
  assert.match(claude.request.context, /"answer":"Waiting"/);
  assert.doesNotMatch(claude.request.context, /codex-session|private-binding/);
  complete(claude, 'claude-session'); await switched;
  snapshot = fixture.controller.snapshot();
  const attached = snapshot.history.find(entry => entry.kind === 'notice');
  if (attached?.kind === 'notice') assert.equal(attached.handoff?.status, 'attached');
  await fixture.controller.selectProvider(profile());
  const back = fixture.controller.send('Return to Codex', context(3));
  const codex = await dispatched(fixture);
  assert.equal(codex.request.session, undefined);
  complete(codex, 'new-codex-session'); await back;
});

test('invalid questions or captured context fail before adding history or invoking a provider', () => {
  const fixture = setup();
  for (const prompt of ['', '  ', 'q'.repeat(conversationLimits.promptBytes + 1)]) assert.throws(() => fixture.controller.send(prompt, context()), /16 KiB/);
  assert.throws(() => fixture.controller.send('Question', { ...context(), document: { sessionId: 'other-document', revision: 1 } }), /different document/);
  assert.throws(() => fixture.controller.send('Question', { ...context(), document: { sessionId: 'fictional-document', revision: -1 } }), /different document/);
  assert.throws(() => fixture.controller.send('Question', context(1, 'x'.repeat(conversationLimits.contextBytes + 1))), /256 KiB/);
  assert.throws(() => fixture.controller.send('Question', { ...context(), provenance: 'x'.repeat(desktopConversationLimits.provenanceBytes + 1) }), /context is invalid/);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.controller.snapshot().history.length, 0);
});

test('cancelling before dispatch starts no provider and keeps the submitted question', async () => {
  const fixture = setup();
  const done = fixture.controller.send('Keep this question', context());
  await fixture.controller.cancel(); await done;
  assert.equal(fixture.calls.length, 0);
  assert.equal(turns(fixture.controller)[0]!.prompt, 'Keep this question');
  assert.equal(turns(fixture.controller)[0]!.status, 'cancelled');
  assert.equal(fixture.controller.snapshot().requiresFresh, true);
});

test('input answers must match the active turn and choices without terminating the request on a mistake', async () => {
  const fixture = setup();
  const done = fixture.controller.send('Ask for a path', context());
  const call = await dispatched(fixture), turnId = fixture.controller.snapshot().activeTurnId!;
  const response = call.request.onInput(input, call.request.signal!);
  call.request.onEvent({ type: 'waiting', reason: 'tool' });
  call.request.onEvent({ type: 'text', text: 'While waiting for input.' });
  assert.equal(fixture.controller.snapshot().status, 'input');
  assert.throws(() => fixture.controller.answer('old-turn', input.id, { answers: { reason: ['Waiting'] } }), /no longer active/);
  assert.throws(() => fixture.controller.answer(turnId, input.id, { answers: { reason: ['Unknown'] } }), /valid response/);
  assert.throws(() => fixture.controller.answer(turnId, input.id, { answers: {} }), /each requested question/);
  assert.equal(fixture.controller.snapshot().input?.request.id, input.id);
  const submitted = { answers: { reason: ['Waiting'] } };
  fixture.controller.answer(turnId, input.id, submitted);
  submitted.answers.reason[0] = 'changed';
  assert.deepEqual(await response, { answers: { reason: ['Waiting'] } });
  assert.equal(fixture.controller.snapshot().input, null);
  assert.equal(fixture.controller.snapshot().waitingFor, 'provider');
  assert.throws(() => fixture.controller.answer(turnId, input.id, { answers: { reason: ['Waiting'] } }), /no longer active/);
  assert.deepEqual(turns(fixture.controller)[0]!.inputs, [{ question: 'Which path?', answer: 'Waiting', truncated: false }]);
  const approval = call.request.onInput({ id: 'approval', kind: 'approval', tool: 'fictional_tool', description: 'Allow the registered local tool?' }, call.request.signal!);
  fixture.controller.answer(turnId, 'approval', { decision: 'deny' });
  assert.deepEqual(await approval, { decision: 'deny' });
  complete(call); await done;
});

test('cancellation clears pending input immediately and waits for owned adapter cleanup', async () => {
  const fixture = setup();
  const done = fixture.controller.send('Question with input', context());
  const call = await dispatched(fixture), turnId = fixture.controller.snapshot().activeTurnId!;
  const inputRejected = assert.rejects(call.request.onInput(input, call.request.signal!), /cancelled/);
  const cancelled = fixture.controller.cancel();
  assert.equal(call.request.signal?.aborted, true);
  assert.equal(fixture.controller.snapshot().input, null);
  assert.equal(fixture.controller.snapshot().status, 'cancelling');
  assert.throws(() => fixture.controller.answer(turnId, input.id, { answers: { reason: ['Waiting'] } }), /no longer active/);
  assert.throws(() => fixture.controller.send('Too early', context()), /current conversation operation/);
  call.request.onEvent({ type: 'text', text: 'Late answer' });
  complete(call);
  await cancelled; await done; await inputRejected;
  assert.equal(turns(fixture.controller)[0]!.answer, '');
  assert.equal(turns(fixture.controller)[0]!.status, 'cancelled');
  assert.equal(fixture.controller.snapshot().session, null);
});

test('closing during a provider change wins after cleanup and cannot restart the conversation', async () => {
  const fixture = setup();
  const done = fixture.controller.send('Pending question', context());
  const call = await dispatched(fixture);
  const switching = fixture.controller.selectProvider(profile('claude'));
  const closed = fixture.controller.close();
  call.resolve({ status: 'cancelled' });
  await done; await switching; await closed;
  assert.equal(fixture.controller.snapshot().status, 'closed');
  assert.equal(fixture.controller.snapshot().provider.provider, 'codex');
  assert.equal(fixture.controller.snapshot().history.length, 1);
  assert.equal(fixture.controller.snapshot().session, null);
  assert.throws(() => fixture.controller.send('Late question', context()), /closed/);
  await assert.rejects(fixture.controller.fresh(), /closed/);
  await assert.rejects(fixture.controller.selectProvider(profile()), /closed/);
  await fixture.controller.close();
  call.request.onEvent({ type: 'text', text: 'Discard late event' });
  assert.equal(turns(fixture.controller)[0]!.answer, '');
});

test('provider switching cancels the old turn before handing off its attributed partial answer', async () => {
  const fixture = setup();
  const done = fixture.controller.send('Pending question', context());
  const call = await dispatched(fixture);
  call.request.onEvent({ type: 'text', text: 'Partial Codex answer' });
  const switching = fixture.controller.selectProvider(profile('claude'));
  assert.equal(fixture.controller.snapshot().status, 'cancelling');
  assert.equal(fixture.controller.snapshot().provider.provider, 'codex');
  assert.equal(call.request.signal?.aborted, true);
  call.resolve({ status: 'cancelled' }); await done; await switching;
  const next = fixture.controller.send('Continue with Claude', context(2));
  const claude = await dispatched(fixture);
  assert.equal(claude.request.session, undefined);
  assert.match(claude.request.context, /"status":"cancelled"/);
  assert.match(claude.request.context, /Partial Codex answer/);
  complete(claude, 'new-claude'); await next;
});

test('fresh keeps history visible but excludes it from all later provider handoffs', async () => {
  const fixture = setup();
  const first = fixture.controller.send('Old private question', context());
  complete(await dispatched(fixture)); await first;
  await fixture.controller.selectProvider(profile('claude'));
  await fixture.controller.fresh();
  const notice = fixture.controller.snapshot().history.find(entry => entry.kind === 'notice' && entry.reason === 'provider');
  if (notice?.kind === 'notice') assert.equal(notice.handoff?.status, 'cleared');
  const recent = fixture.controller.send('New question after fresh', context(2));
  complete(await dispatched(fixture), 'after-fresh'); await recent;
  await fixture.controller.selectProvider(profile());
  const next = fixture.controller.send('Continue', context(3));
  const call = await dispatched(fixture);
  assert.doesNotMatch(call.request.context, /Old private question/);
  assert.match(call.request.context, /New question after fresh/);
  assert.equal(turns(fixture.controller).length, 3);
  complete(call, 'fresh-codex'); await next;
});

test('stream bursts are coalesced while their bounded UTF-8 text remains available', async () => {
  const fixture = setup();
  const done = fixture.controller.send('Long answer', context());
  const call = await dispatched(fixture);
  for (let index = 0; index < 6000; index++) call.request.onEvent({ type: 'text', text: '🌿 fictional text ' });
  assert.equal(fixture.snapshots.length, 1);
  await new Promise(resolve => setTimeout(resolve, desktopConversationLimits.updateIntervalMs + 20));
  assert.equal(fixture.snapshots.length, 2);
  const turn = turns(fixture.controller)[0]!;
  assert.ok(Buffer.byteLength(turn.answer) <= desktopConversationLimits.answerBytes);
  assert.equal(turn.answerTruncated, true);
  assert.doesNotMatch(turn.answer, /\uFFFD/);
  complete(call); await done;
  assert.equal(fixture.snapshots.length, 3);
  assert.equal(turns(fixture.controller)[0]!.status, 'completed');
});

test('history bounds retain current turns and report omitted entries and handoff excerpts', async () => {
  const fixture = setup();
  for (let index = 0; index < 8; index++) {
    const done = fixture.controller.send(`Question ${index}`, context(index));
    const call = await dispatched(fixture);
    call.request.onEvent({ type: 'text', text: 'x'.repeat(desktopConversationLimits.answerBytes) });
    complete(call); await done;
  }
  const snapshot = fixture.controller.snapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.history)) <= desktopConversationLimits.historyBytes);
  assert.ok(snapshot.omittedEntries > 0);
  assert.equal(turns(fixture.controller).at(-1)!.prompt, 'Question 7');
  await fixture.controller.selectProvider(profile('claude'));
  const notice = fixture.controller.snapshot().history.at(-1)!;
  assert.equal(notice.kind, 'notice');
  if (notice.kind === 'notice') { assert.ok(notice.handoff!.omittedTurns > 0); assert.equal(notice.handoff!.truncated, true); }
  const done = fixture.controller.send('Continue', context(9));
  const call = await dispatched(fixture);
  assert.ok(Buffer.byteLength(call.request.context) <= Buffer.byteLength(context(9).text) + desktopConversationLimits.handoffBytes);
  assert.match(call.request.context, /Question 7/);
  complete(call, 'claude-history'); await done;
  for (let index = 0; index < 50; index++) await fixture.controller.fresh();
  assert.equal(fixture.controller.snapshot().history.length, desktopConversationLimits.historyEntries);
});

test('serialized bounds include JSON escaping and interaction summaries', async () => {
  const fixture = setup();
  const done = fixture.controller.send('\u0000'.repeat(conversationLimits.promptBytes), { ...context(), provenance: '\u0000'.repeat(desktopConversationLimits.provenanceBytes) });
  const call = await dispatched(fixture), turnId = fixture.controller.snapshot().activeTurnId!;
  const question: ConversationInputRequest = { id: 'large-input', kind: 'questions', questions: [{ id: 'text', header: 'Text', question: '\u0000'.repeat(2048), options: [], multiple: false, freeform: true }] };
  for (let index = 0; index < desktopConversationLimits.inputRequests; index++) {
    const response = call.request.onInput(question, call.request.signal!);
    fixture.controller.answer(turnId, question.id, { answers: { text: ['x' + '\u0000'.repeat(2047)] } });
    await response;
  }
  await assert.rejects(call.request.onInput(question, call.request.signal!), /input limit/);
  call.request.onEvent({ type: 'text', text: '\u0000'.repeat(desktopConversationLimits.answerBytes) });
  const snapshot = fixture.controller.snapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.history)) <= desktopConversationLimits.historyBytes);
  assert.equal(turns(fixture.controller)[0]!.answerTruncated, true);
  assert.ok(turns(fixture.controller)[0]!.inputs.every(input => input.truncated && Buffer.byteLength(JSON.stringify(input)) <= 2048));
  complete(call); await done;
});

test('a handoff exceeding the shared context bound fails before dispatch and fresh removes it', async () => {
  const fixture = setup();
  const done = fixture.controller.send('Prior question', context());
  complete(await dispatched(fixture)); await done;
  await fixture.controller.selectProvider(profile('claude'));
  assert.throws(() => fixture.controller.send('Question', context(2, 'x'.repeat(conversationLimits.contextBytes))), /handoff exceed/);
  assert.equal(fixture.calls.length, 1);
  await fixture.controller.fresh();
  const next = fixture.controller.send('Question', context(2, 'x'.repeat(conversationLimits.contextBytes)));
  const call = await dispatched(fixture);
  assert.equal(Buffer.byteLength(call.request.context), conversationLimits.contextBytes);
  complete(call, 'fresh-claude'); await next;
});

test('a terminal event does not permit resume until the adapter finishes cleanup', async () => {
  const fixture = setup();
  const done = fixture.controller.send('Question', context());
  const call = await dispatched(fixture);
  const session = { provider: 'codex' as const, id: 'not-durable-yet', binding: 'binding', version: 'fixture', turns: 1 };
  call.request.onEvent({ type: 'session', session });
  call.request.onEvent({ type: 'text', text: 'Answer text' });
  call.request.onEvent({ type: 'completed', session });
  assert.equal(fixture.controller.snapshot().session, null);
  assert.throws(() => fixture.controller.send('Follow-up', context()), /current conversation operation/);
  call.resolve({ status: 'error', code: 'session', message: 'Native transcript did not finish. Start fresh.' });
  await done;
  assert.equal(fixture.controller.snapshot().requiresFresh, true);
  assert.equal(turns(fixture.controller)[0]!.answer, 'Answer text');
  assert.equal(turns(fixture.controller)[0]!.status, 'error');
});

test('turn limits and provider timeout errors have explicit fresh-session recovery', async () => {
  const fixture = setup();
  const done = fixture.controller.send('Last turn', context());
  const call = await dispatched(fixture);
  call.resolve({ status: 'completed', session: { provider: 'codex', id: 'full-session', version: 'fixture', binding: 'binding', turns: conversationLimits.turns } });
  await done;
  assert.equal(fixture.controller.snapshot().requiresFresh, true);
  assert.throws(() => fixture.controller.send('Past limit', context()), /fresh/);
  await fixture.controller.fresh();
  const timeout = fixture.controller.send('Slow question', context());
  const slow = await dispatched(fixture);
  slow.resolve({ status: 'error', code: 'timeout', message: 'Deadline expired. Start fresh.' });
  await timeout;
  assert.equal(turns(fixture.controller).at(-1)!.error?.code, 'timeout');
  assert.equal(fixture.controller.snapshot().requiresFresh, true);
});

test('unexpected runner and subscriber failures leave a recoverable controller', async () => {
  const controller = new ConversationController({
    documentSessionId: 'fictional-document', workingDirectory: '/fictional/private', profile: profile(),
    onChange() { throw new Error('Window already closed'); },
    async runTurn() { throw new Error('private raw provider details'); },
  });
  await controller.send('Question', context());
  assert.equal(controller.snapshot().requiresFresh, true);
  assert.equal(controller.snapshot().activeTurnId, null);
  assert.doesNotMatch(JSON.stringify(controller.snapshot()), /private raw provider details/);
  await controller.close();
  assert.equal(controller.snapshot().status, 'closed');
});
