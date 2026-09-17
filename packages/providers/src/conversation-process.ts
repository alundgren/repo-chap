import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ConversationError, conversationLimits } from './conversation-types.js';

export const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Providers may leave tools running after exit, so the host owns their process group. */
export class ConversationProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private bytes = 0;
  private events = 0;
  private ended = false;
  private exited = false;
  private finishing = false;
  private exitCode: number | null = null;
  private resolveExit!: (code: number | null) => void;
  private readonly exit: Promise<number | null>;
  private scheduled = false;
  private nextId = 1;
  private readonly pending = new Map<string | number, { resolve(value: Record<string, any>): void; reject(error: Error): void }>();
  private failClosed!: (error: Error) => void;
  readonly closed: Promise<never>;
  onMessage: (message: Record<string, any>) => void = () => {};

  constructor(executable: string, args: string[], cwd: string, private readonly maxBytes: number) {
    this.exit = new Promise(resolve => { this.resolveExit = resolve; });
    this.closed = new Promise((_, reject) => { this.failClosed = reject; });
    // A process can exit while the caller is still preparing another resource.
    void this.closed.catch(() => {});
    this.child = spawn(executable, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    this.child.stdout.on('data', (data: Buffer) => {
      if (this.ended || !this.count(data.length)) return;
      try { this.buffer += this.decoder.decode(data, { stream: true }); }
      catch { this.fail(new ConversationError('protocol', 'The provider returned invalid text. Start a fresh conversation.')); return; }
      this.drain();
    });
    this.child.stderr.on('data', (data: Buffer) => this.count(data.length));
    this.child.stdin.on('error', () => this.fail(new ConversationError('provider', 'The provider input closed. Start a fresh conversation.')));
    this.child.once('error', () => this.fail(new ConversationError('unavailable', 'Cannot start the selected local CLI. Check its executable path and installation.')));
    this.child.once('close', code => { this.exitCode = code; this.exited = true; this.drain(); });
  }

  private count(bytes: number): boolean {
    this.bytes += bytes;
    if (this.bytes > this.maxBytes) { this.fail(new ConversationError('limit', 'The provider exceeded the turn output limit. Start a fresh conversation.')); return false; }
    return true;
  }
  private drain(): void {
    if (this.scheduled || this.ended) return;
    let processed = 0;
    while (processed++ < 64) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) {
        if (Buffer.byteLength(this.buffer) > conversationLimits.protocolLineBytes) this.fail(new ConversationError('limit', 'The provider sent an oversized protocol message.'));
        else if (this.exited) {
          this.resolveExit(this.exitCode);
          if (!this.finishing) this.fail(new ConversationError('provider', 'The provider exited before the turn completed. Check local login, then start a fresh conversation.'));
        }
        return;
      }
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > conversationLimits.protocolLineBytes || ++this.events > conversationLimits.protocolEvents) {
        this.fail(new ConversationError('limit', 'The provider exceeded the protocol event limit.')); return;
      }
      if (!line.trim()) continue;
      try {
        const message: unknown = JSON.parse(line);
        if (!record(message)) throw new Error();
        if (message.id !== undefined && !(typeof message.id === 'string' && message.id.length <= 128) && !Number.isSafeInteger(message.id)) throw new Error();
        const control = message.type === 'control_response' && record(message.response) ? message.response : null;
        if (control && (typeof control.request_id !== 'string' || control.request_id.length > 128)) throw new Error();
        const id = control?.request_id ?? message.id;
        const pending = this.pending.get(id);
        if (pending && (!message.method && message.type !== 'control_request')) {
          this.pending.delete(id);
          if (message.error || control?.subtype === 'error') pending.reject(new ConversationError('provider', 'The provider rejected a conversation request. Check its model, login and settings, then start fresh.'));
          else {
            const result = control?.response ?? message.result;
            if (!record(result)) throw new Error();
            pending.resolve(result);
          }
        } else this.onMessage(message);
      } catch (error) {
        this.fail(error instanceof ConversationError ? error : new ConversationError('protocol', 'The provider returned an unsupported protocol message.')); return;
      }
      if (this.ended) return;
    }
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; this.drain(); });
  }
  send(message: unknown): void {
    if (this.ended) throw new ConversationError('provider', 'The provider process is no longer running.');
    const text = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(text) > 2 * conversationLimits.contextBytes) throw new ConversationError('limit', 'The conversation input exceeds the provider message limit.');
    this.child.stdin.write(text);
  }
  request(method: string, params: unknown): Promise<Record<string, any>> {
    const id = this.nextId++;
    return this.waitFor(id, { id, method, params });
  }
  control(request: unknown): Promise<Record<string, any>> {
    const id = `request-${this.nextId++}`;
    return this.waitFor(id, { type: 'control_request', request_id: id, request });
  }
  private waitFor(id: string | number, message: unknown): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      if (this.pending.size >= 8) { reject(new ConversationError('limit', 'Too many pending provider requests.')); return; }
      this.pending.set(id, { resolve, reject });
      try { this.send(message); } catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  /** A result can precede the provider's transcript flush. EOF lets it finish that write. */
  async finishInput(): Promise<void> {
    this.finishing = true;
    this.child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    try {
      const code = await Promise.race([this.exit, this.closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ConversationError('session', 'The answer arrived, but the provider did not finish saving its session. Start a fresh conversation.')), 2000);
      })]);
      if (code !== 0) throw new ConversationError('session', 'The answer arrived, but the provider could not close its session cleanly. Start a fresh conversation.');
    } finally { clearTimeout(timer); }
  }
  fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear(); this.buffer = '';
    try { if (this.child.pid) process.kill(-this.child.pid, 'SIGKILL'); } catch { this.child.kill('SIGKILL'); }
    this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
    this.failClosed(error);
  }
  close(): void { this.fail(new ConversationError('session', 'The provider process has closed.')); }
}
