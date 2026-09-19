import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { record } from './conversation-process.js';
import { ConversationError, conversationLimits } from './conversation-types.js';

const auditFailure = () => new ConversationError('session', 'Codex finished, but its private transcript could not verify the current turn. The answer is kept; start a fresh conversation.');
export const nativeOperationFailure = () => new ConversationError('unsupported', 'Codex requested a native operation. Discussion only supports registered application operations. Your drafts have been kept; start a fresh conversation.');

/** The transcript also records sandbox-denied native calls omitted from normal events. */
export async function auditCodexTranscript(path: unknown, sessionId: string, turnId: string, cwd: string, tools: readonly string[], signal: AbortSignal): Promise<void> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096) throw auditFailure();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat();
    const maxBytes = 32 * 1024 * 1024;
    if (!before.isFile() || before.size > maxBytes || before.size === 0 || process.getuid && before.uid !== process.getuid()) throw auditFailure();
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false, signal: deadline })) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw auditFailure();
      chunks.push(chunk);
    }
    const after = await file.stat();
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw auditFailure();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    if (!text.endsWith('\n')) throw auditFailure();
    const lines = text.trimEnd().split('\n');
    if (lines.length > 100_000) throw auditFailure();
    let active: string | undefined, last: string | undefined, started = 0, completed = 0, context = 0;
    const wrapperCalls = new Map<string, string>();
    for (let index = 0; index < lines.length; index++) {
      if (index % 64 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); deadline.throwIfAborted(); }
      const line = lines[index]!;
      if (Buffer.byteLength(line) > conversationLimits.protocolLineBytes) throw auditFailure();
      const value: unknown = JSON.parse(line);
      if (!record(value) || !record(value.payload) || typeof value.type !== 'string') throw auditFailure();
      const payload = value.payload;
      if (index === 0) {
        if (value.type !== 'session_meta' || payload.id !== sessionId || payload.session_id !== sessionId || payload.cwd !== cwd) throw auditFailure();
        continue;
      }
      if (value.type === 'session_meta') throw auditFailure();
      if (value.type === 'event_msg' && payload.type === 'task_started') {
        if (active || typeof payload.turn_id !== 'string') throw auditFailure();
        active = last = payload.turn_id;
        if (active === turnId) started++;
      } else if (value.type === 'event_msg' && payload.type === 'task_complete') {
        if (!active || payload.turn_id !== active) throw auditFailure();
        if (active === turnId) completed++;
        active = undefined;
      } else if (value.type === 'turn_context' && active === turnId) {
        if (payload.turn_id !== turnId || payload.cwd !== cwd) throw auditFailure();
        context++;
      } else if (value.type === 'response_item' && active === turnId) {
        if (payload.type === 'custom_tool_call' && payload.name === 'exec' || payload.type === 'function_call' && payload.name === 'wait') {
          if (typeof payload.call_id !== 'string' || !payload.call_id || wrapperCalls.has(payload.call_id)) throw auditFailure();
          wrapperCalls.set(payload.call_id, payload.type === 'custom_tool_call' ? 'custom_tool_call_output' : 'function_call_output');
        } else if (wrapperCalls.has(payload.call_id)) {
          if (wrapperCalls.get(payload.call_id) !== payload.type) throw auditFailure();
          wrapperCalls.delete(payload.call_id);
        } else if (payload.type === 'function_call') {
          if (typeof payload.name !== 'string' || !['request_user_input', ...tools].includes(payload.name)) throw nativeOperationFailure();
        } else if (payload.type === 'custom_tool_call' || typeof payload.type === 'string' && payload.type.endsWith('_call')) throw nativeOperationFailure();
        else if (!['message', 'reasoning', 'function_call_output'].includes(payload.type)) throw auditFailure();
      }
    }
    if (wrapperCalls.size || active || last !== turnId || started !== 1 || completed !== 1 || context !== 1) throw auditFailure();
    deadline.throwIfAborted();
  } catch (error) {
    throw error instanceof ConversationError ? error : auditFailure();
  } finally { await file?.close(); }
}
