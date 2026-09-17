import { createHash, randomUUID } from 'node:crypto';
import { conversationLimits, runConversationTurn, validateProfile } from '@repo-chap/providers';
import type { ConversationTool, ConversationEvent, ConversationInputAnswer, ConversationInputRequest, ConversationSessionIdentity, ConversationTurnRequest, ConversationTurnResult, ProviderProfile } from '@repo-chap/providers';
import type { CapturedConversationContext, ConversationHistoryEntry, ConversationNotice, ConversationProvider, ConversationSnapshot, ConversationTurn } from './conversation-protocol.js';

export const desktopConversationLimits = {
  historyEntries: 40, historyBytes: 256 * 1024, answerBytes: 64 * 1024,
  handoffBytes: 32 * 1024, provenanceBytes: 4 * 1024, inputBytes: 256 * 1024,
  answerInputBytes: 64 * 1024, inputRequests: 16, updateIntervalMs: 50,
} as const;

interface PendingInput {
  request: ConversationInputRequest;
  resolve(answer: ConversationInputAnswer): void;
  reject(error: Error): void;
  detach(): void;
}
interface ActiveTurn {
  turn: ConversationTurn;
  controller: AbortController;
  done: Promise<void>;
  input: PendingInput | null;
  terminal: boolean;
  answerBytes: number;
}
interface Handoff { text: string; notice: ConversationNotice }
interface ConversationControllerOptions {
  documentSessionId: string;
  workingDirectory: string;
  profile: ProviderProfile;
  onChange(snapshot: ConversationSnapshot): void;
  tools?: (document: CapturedConversationContext['document']) => readonly ConversationTool[];
  runTurn?: (request: ConversationTurnRequest) => Promise<ConversationTurnResult>;
}
const bytes = (text: string): number => Buffer.byteLength(text);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function clip(text: string, limit: number): string {
  if (bytes(text) <= limit) return text;
  const value = Buffer.from(text);
  let end = Math.max(0, limit);
  while (end > 0 && (value[end]! & 0xc0) === 0x80) end--;
  return value.subarray(0, end).toString('utf8');
}
function describe(profile: ProviderProfile): ConversationProvider {
  return { provider: profile.provider, name: profile.name, model: profile.model, ...(profile.effort ? { effort: profile.effort } : {}) };
}
function checkedProfile(profile: ProviderProfile): ProviderProfile {
  validateProfile(profile);
  if (bytes(JSON.stringify(profile)) > 8192) throw new Error('The conversation provider settings are too large.');
  return structuredClone(profile);
}
function summarizeInput(question: string, answer: string): ConversationTurn['inputs'][number] {
  const summary = { question: clip(question, 1024), answer: clip(answer, 1024), truncated: false };
  while (bytes(JSON.stringify(summary)) > 2048) {
    summary.question = clip(summary.question, Math.floor(bytes(summary.question) / 2));
    summary.answer = clip(summary.answer, Math.floor(bytes(summary.answer) / 2));
  }
  summary.truncated = summary.question !== question || summary.answer !== answer;
  return summary;
}
function validateAnswer(input: ConversationInputRequest, answer: ConversationInputAnswer): void {
  if (!record(answer) || bytes(JSON.stringify(answer)) > desktopConversationLimits.answerInputBytes) throw new Error('Keep the input response within 64 KiB.');
  if (input.kind === 'approval') {
    if (!('decision' in answer) || !['allow', 'deny'].includes(answer.decision)) throw new Error('Choose whether to allow this local tool.');
    return;
  }
  if (!('answers' in answer) || !record(answer.answers) || Object.keys(answer.answers).length !== input.questions.length) throw new Error('Answer each requested question.');
  for (const question of input.questions) {
    const values = answer.answers[question.id];
    if (!Array.isArray(values) || !values.length || values.length > (question.multiple ? 8 : 1) || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 2048 || !question.freeform && !question.options.some(option => option.label === value))) throw new Error('Choose a valid response for each question.');
  }
}

/** Owns chat state for one document session, without authority to edit or test it. */
export class ConversationController {
  private id = randomUUID();
  private revision = 0;
  private profile: ProviderProfile;
  private history: ConversationHistoryEntry[] = [];
  private omittedEntries = 0;
  private omittedTurns = 0;
  private handoffStart = 0;
  private session: ConversationSessionIdentity | null = null;
  private requiresFresh = false;
  private status: ConversationSnapshot['status'] = 'ready';
  private waitingFor: ConversationSnapshot['waitingFor'] = null;
  private active: ActiveTurn | null = null;
  private handoff: Handoff | null = null;
  private timer: NodeJS.Timeout | undefined;
  private changing = false;
  private closing = false;
  private readonly options: ConversationControllerOptions;

  constructor(options: ConversationControllerOptions) {
    if (typeof options.documentSessionId !== 'string' || !options.documentSessionId || options.documentSessionId.length > 128) throw new Error('Open a document session before starting a conversation.');
    this.profile = checkedProfile(options.profile);
    this.options = { ...options };
  }

  snapshot(): ConversationSnapshot {
    this.trimHistory();
    return structuredClone({
      id: this.id, revision: this.revision, documentSessionId: this.options.documentSessionId,
      provider: describe(this.profile), status: this.status, waitingFor: this.waitingFor,
      requiresFresh: this.requiresFresh,
      session: this.session && { id: this.session.id, version: this.session.version, turns: this.session.turns },
      activeTurnId: this.active?.turn.id ?? null,
      input: this.active?.input ? { turnId: this.active.turn.id, request: this.active.input.request } : null,
      history: this.history, omittedEntries: this.omittedEntries,
    });
  }

  /** Acceptance is synchronous; completion resolves after the adapter cleans its processes. */
  send(prompt: string, captured: CapturedConversationContext): Promise<void> {
    this.assertReady();
    if (this.requiresFresh) throw new Error('Start a fresh conversation before sending another question.');
    if (typeof prompt !== 'string' || !prompt.trim() || bytes(prompt) > conversationLimits.promptBytes) throw new Error('Enter a question within 16 KiB.');
    if (captured?.document?.sessionId !== this.options.documentSessionId || !Number.isSafeInteger(captured.document.revision) || captured.document.revision < 0) throw new Error('The conversation belongs to a different document session. Capture the current workflow again.');
    if (typeof captured.text !== 'string' || typeof captured.provenance !== 'string' || bytes(captured.provenance) > desktopConversationLimits.provenanceBytes) throw new Error('The captured conversation context is invalid.');
    const context = captured.text + (this.handoff?.text ?? '');
    if (bytes(context) > conversationLimits.contextBytes) throw new Error('The workflow context and conversation handoff exceed 256 KiB. Reduce the selected context or start fresh.');
    const turn: ConversationTurn = {
      kind: 'turn', id: randomUUID(), provider: describe(this.profile), sessionId: null,
      context: { document: { sessionId: captured.document.sessionId, revision: captured.document.revision }, digest: createHash('sha256').update(captured.text).digest('hex'), provenance: captured.provenance },
      prompt, answer: '', answerTruncated: false, status: 'running', tools: [], inputs: [], error: null,
    };
    const prior = this.session;
    this.session = null;
    const active: ActiveTurn = { turn, controller: new AbortController(), done: Promise.resolve(), input: null, terminal: false, answerBytes: 0 };
    this.active = active;
    this.history.push(turn);
    this.status = 'running'; this.waitingFor = 'provider';
    if (this.handoff) { this.handoff.notice.handoff!.status = 'attached'; this.handoff = null; }
    const request: ConversationTurnRequest = {
      profile: structuredClone(this.profile), workingDirectory: this.options.workingDirectory,
      prompt, context, ...(prior ? { session: structuredClone(prior) } : {}), tools: this.options.tools?.(structuredClone(captured.document)) ?? [],
      signal: active.controller.signal,
      onEvent: event => this.event(active, event),
      onInput: (input, signal) => this.input(active, input, signal),
    };
    // Defer dispatch so cancellation and input callbacks always observe the assigned active turn.
    active.done = Promise.resolve().then(async () => {
      let result: ConversationTurnResult;
      try { result = active.controller.signal.aborted ? { status: 'cancelled' } : await (this.options.runTurn ?? runConversationTurn)(request); }
      catch { result = { status: 'error', code: 'provider', message: 'The conversation stopped unexpectedly. Start fresh to continue.' }; }
      this.finish(active, result);
    });
    this.changed(true);
    return active.done;
  }

  answer(turnId: string, requestId: string, answer: ConversationInputAnswer): void {
    const active = this.active, input = active?.input;
    if (!active || active.controller.signal.aborted || !input || active.turn.id !== turnId || input.request.id !== requestId) throw new Error('This input request is no longer active.');
    validateAnswer(input.request, answer);
    const question = input.request.kind === 'approval' ? input.request.description : input.request.questions.map(question => question.question).join('\n');
    const response = 'decision' in answer ? answer.decision : input.request.kind === 'questions' ? input.request.questions.map(question => answer.answers[question.id]!.join(', ')).join('\n') : '';
    active.turn.inputs.push(summarizeInput(question, response));
    active.input = null; input.detach(); input.resolve(structuredClone(answer));
    this.status = 'waiting'; this.waitingFor = 'provider'; this.changed(true);
  }

  async cancel(): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.status = 'cancelling'; this.waitingFor = null;
    this.clearInput(active);
    active.controller.abort(); this.changed(true);
    await active.done;
  }

  async fresh(): Promise<void> {
    await this.change(this.profile, 'fresh');
  }

  async selectProvider(profile: ProviderProfile): Promise<void> {
    if (this.closing) throw new Error('This conversation is closed. Open a workflow to continue.');
    const selected = checkedProfile(profile);
    if (JSON.stringify(selected) === JSON.stringify(this.profile)) return;
    await this.change(selected, 'provider');
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.cancel();
    this.session = null; this.clearHandoff();
    this.status = 'closed'; this.waitingFor = null; this.changed(true);
  }

  private assertReady(): void {
    if (this.closing) throw new Error('This conversation is closed. Open a workflow to continue.');
    if (this.changing || this.active) throw new Error('Wait for the current conversation operation or cancel it first.');
  }

  private async change(profile: ProviderProfile, reason: 'fresh' | 'provider'): Promise<void> {
    if (this.closing) throw new Error('This conversation is closed. Open a workflow to continue.');
    if (this.changing) throw new Error('A conversation change is already pending.');
    this.changing = true;
    try {
      await this.cancel();
      if (this.closing) return;
      this.session = null; this.requiresFresh = false; this.clearHandoff();
      this.id = randomUUID(); this.profile = structuredClone(profile);
      const provider = profile.provider === 'codex' ? 'Codex' : 'Claude';
      const notice: ConversationNotice = {
        kind: 'notice', id: randomUUID(), reason, provider: describe(profile), handoff: null,
        text: reason === 'fresh' ? `Started a fresh ${provider} session. The next question uses the current workflow context.` : `Changed to ${provider}. The next question starts a separate session with an earlier conversation excerpt.`,
      };
      if (reason === 'provider') this.handoff = this.prepareHandoff(notice);
      this.history.push(notice); this.status = 'ready'; this.waitingFor = null;
      if (reason === 'fresh') { this.handoffStart = this.history.length; this.omittedTurns = 0; }
      this.changed(true);
    } finally { this.changing = false; }
  }

  private prepareHandoff(notice: ConversationNotice): Handoff {
    const turns = this.history.slice(this.handoffStart).filter((entry): entry is ConversationTurn => entry.kind === 'turn');
    const excerpts: unknown[] = [];
    let truncated = false;
    for (const turn of turns.toReversed()) {
      const excerpt = {
        provider: turn.provider, status: turn.status, context: { document: turn.context.document, digest: turn.context.digest },
        prompt: clip(turn.prompt, 2048), answer: clip(turn.answer, 4096), inputs: turn.inputs.slice(-2),
      };
      while (bytes(JSON.stringify(excerpt)) > desktopConversationLimits.handoffBytes / 2) {
        excerpt.prompt = clip(excerpt.prompt, Math.floor(bytes(excerpt.prompt) / 2));
        excerpt.answer = clip(excerpt.answer, Math.floor(bytes(excerpt.answer) / 2));
      }
      if (bytes(JSON.stringify([excerpt, ...excerpts])) > desktopConversationLimits.handoffBytes - 1024) break;
      truncated ||= excerpt.prompt !== turn.prompt || excerpt.answer !== turn.answer || turn.answerTruncated || turn.inputs.length > excerpt.inputs.length || turn.inputs.some(input => input.truncated);
      excerpts.unshift(excerpt);
    }
    const omittedTurns = this.omittedTurns + turns.length - excerpts.length;
    notice.handoff = { status: 'pending', includedTurns: excerpts.length, omittedTurns, truncated };
    if (!excerpts.length) notice.text = `Changed to ${notice.provider.provider === 'codex' ? 'Codex' : 'Claude'}. The next question starts a separate session with the current workflow context.`;
    return { notice, text: `\n\nEarlier visible conversation excerpt. This is dialogue, not evidence that an operation ran. The current workflow snapshot remains authoritative.\n${JSON.stringify({ omittedTurns, truncated, turns: excerpts })}` };
  }

  private clearHandoff(): void {
    if (this.handoff) this.handoff.notice.handoff!.status = 'cleared';
    this.handoff = null;
  }

  private event(active: ActiveTurn, event: ConversationEvent): void {
    if (this.active !== active || active.terminal || active.controller.signal.aborted) return;
    switch (event.type) {
      case 'text': {
        if (!active.turn.answerTruncated) {
          const text = clip(event.text, desktopConversationLimits.answerBytes - active.answerBytes);
          active.turn.answer += text; active.answerBytes += bytes(text);
          active.turn.answerTruncated = text !== event.text;
        }
        this.status = 'running'; this.waitingFor = null; break;
      }
      case 'session': active.turn.sessionId = event.session.id; break;
      case 'tool': {
        const existing = active.turn.tools.find(tool => tool.id === event.id);
        if (existing) existing.status = event.status;
        else if (active.turn.tools.length < conversationLimits.toolCalls) active.turn.tools.push({ id: event.id, name: event.name, status: event.status });
        break;
      }
      case 'waiting':
        this.status = event.reason === 'input' ? 'input' : 'waiting';
        this.waitingFor = event.reason === 'input' ? null : event.reason; break;
      case 'input': return;
      case 'completed': case 'error': case 'cancelled':
        // A terminal event precedes adapter cleanup. Reuse is granted only by its settled result.
        active.terminal = true; return;
    }
    if (active.input) { this.status = 'input'; this.waitingFor = null; }
    this.changed();
  }

  private input(active: ActiveTurn, request: ConversationInputRequest, signal: AbortSignal): Promise<ConversationInputAnswer> {
    if (this.active !== active || active.terminal || active.controller.signal.aborted || signal.aborted) return Promise.reject(new Error('The conversation was cancelled.'));
    if (active.input || active.turn.inputs.length >= desktopConversationLimits.inputRequests || bytes(JSON.stringify(request)) > desktopConversationLimits.inputBytes) return Promise.reject(new Error('The conversation exceeded its input limit.'));
    return new Promise((resolve, reject) => {
      const abort = () => { this.clearInput(active); };
      signal.addEventListener('abort', abort, { once: true });
      active.input = { request: structuredClone(request), resolve, reject, detach: () => signal.removeEventListener('abort', abort) };
      this.status = 'input'; this.waitingFor = null; this.changed(true);
    });
  }

  private clearInput(active: ActiveTurn): void {
    const pending = active.input;
    if (!pending) return;
    active.input = null; pending.detach(); pending.reject(new Error('The conversation was cancelled.'));
  }

  private finish(active: ActiveTurn, result: ConversationTurnResult): void {
    if (this.active !== active) return;
    this.clearInput(active);
    if (active.controller.signal.aborted) result = { status: 'cancelled' };
    active.turn.status = result.status;
    if (result.status === 'completed') {
      active.turn.sessionId = result.session.id;
      this.session = structuredClone(result.session);
      this.requiresFresh = result.session.turns >= conversationLimits.turns;
    } else {
      this.session = null; this.requiresFresh = true;
      if (result.status === 'error') active.turn.error = { code: result.code, message: result.message };
      for (const tool of active.turn.tools) if (tool.status === 'running') tool.status = 'failed';
    }
    this.active = null; this.status = this.closing ? 'closed' : 'ready'; this.waitingFor = null; this.changed(true);
  }

  private trimHistory(): void {
    while (this.history.length > desktopConversationLimits.historyEntries || this.history.length > 1 && bytes(JSON.stringify(this.history)) > desktopConversationLimits.historyBytes) {
      const removed = this.history.shift()!;
      this.omittedEntries++;
      if (this.handoffStart) this.handoffStart--;
      else if (removed.kind === 'turn') this.omittedTurns++;
    }
    const turn = this.history[0];
    while (turn?.kind === 'turn' && bytes(JSON.stringify(this.history)) > desktopConversationLimits.historyBytes && turn.answer) {
      turn.answer = clip(turn.answer, Math.floor(bytes(turn.answer) / 2)); turn.answerTruncated = true;
    }
  }

  private changed(immediate = false): void {
    this.revision++;
    if (immediate) { clearTimeout(this.timer); this.timer = undefined; this.publish(); }
    else this.timer ??= setTimeout(() => { this.timer = undefined; this.publish(); }, desktopConversationLimits.updateIntervalMs);
  }

  private publish(): void {
    const snapshot = this.snapshot();
    // A window may close between the host's liveness check and event delivery.
    try { this.options.onChange(snapshot); } catch { /* Subscriber failure cannot retain a provider process. */ }
  }
}
