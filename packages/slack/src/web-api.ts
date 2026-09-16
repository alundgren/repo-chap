import { SlackError, type SlackMessage } from './types.js';

export interface SlackReceipt { workspaceId: string; channelId: string; timestamp: string }
export type SlackResult<T> = { status: 'confirmed'; value: T } |
  { status: 'deferred'; retryAt: number; reason: string; attempted?: boolean } |
  { status: 'rejected' | 'unknown'; reason: string };
export interface SlackRateStore {
  read(key: string): number;
  extend(key: string, until: number): void;
}
export interface SlackApiOptions {
  workspaceId: string;
  token: () => Promise<string>;
  rates: SlackRateStore;
  now?: () => number;
  transport?: typeof fetch;
  timeoutMs?: number;
}
const rejected = new Set(['account_inactive', 'not_authed', 'invalid_auth', 'token_revoked', 'token_expired', 'missing_scope', 'no_permission', 'not_allowed_token_type', 'channel_not_found', 'not_in_channel', 'is_archived', 'user_not_found', 'user_disabled', 'cannot_dm_bot', 'cannot_dm_self', 'restricted_action', 'restricted_action_read_only_channel', 'restricted_action_thread_only_channel', 'msg_too_long', 'invalid_blocks', 'invalid_arguments', 'invalid_arg_name', 'message_not_found', 'cant_update_message']);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validReceipt(value: unknown): value is SlackReceipt {
  return object(value) && typeof value.workspaceId === 'string' && /^T[A-Z0-9]+$/.test(value.workspaceId) && typeof value.channelId === 'string' && /^[CGD][A-Z0-9]+$/.test(value.channelId) && typeof value.timestamp === 'string' && /^\d{1,20}\.\d{1,10}$/.test(value.timestamp);
}
export class SlackApi {
  private readonly now: () => number;
  private readonly transport: typeof fetch;
  private readonly timeoutMs: number;
  private verifiedToken: string | null = null;
  constructor(private readonly options: SlackApiOptions) {
    if (!/^T[A-Z0-9]+$/.test(options.workspaceId)) throw new SlackError('Slack installation needs a workspace ID.');
    this.now = options.now ?? Date.now; this.transport = options.transport ?? fetch; this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) throw new SlackError('Slack request timeout must be between 1 and 30000 milliseconds.');
  }
  get workspaceId(): string { return this.options.workspaceId; }
  async verify(signal?: AbortSignal): Promise<SlackResult<true>> {
    let token: string;
    try { token = await this.options.token(); } catch { this.verifiedToken = null; return { status: 'rejected', reason: 'Cannot read the Slack token. Check the private installation settings.' }; }
    if (!token || /\s/.test(token)) { this.verifiedToken = null; return { status: 'rejected', reason: 'The private Slack token is missing or invalid.' }; }
    if (token === this.verifiedToken) return { status: 'confirmed', value: true };
    this.verifiedToken = null;
    const response = await this.call('auth.test', {}, token, signal);
    if (response.status !== 'confirmed') return response;
    if (response.value.team_id !== this.workspaceId) return { status: 'rejected', reason: 'The Slack token belongs to a different workspace. Check the private installation settings.' };
    this.verifiedToken = token; return { status: 'confirmed', value: true };
  }
  async openDm(memberId: string, signal?: AbortSignal): Promise<SlackResult<string>> {
    if (!/^U[A-Z0-9]+$/.test(memberId)) throw new SlackError('A DM needs one stable Slack member ID.');
    if (!this.verifiedToken) throw new SlackError('Verify the installation workspace before opening a Slack DM.');
    const response = await this.call('conversations.open', { users: memberId, return_im: false }, this.verifiedToken, signal);
    if (response.status !== 'confirmed') return response;
    if (!object(response.value.channel) || !/^D[A-Z0-9]+$/.test(String(response.value.channel.id))) return { status: 'unknown', reason: 'Slack returned no usable DM conversation receipt. Retry conversation lookup before any message send.' };
    return { status: 'confirmed', value: String(response.value.channel.id) };
  }
  async send(channelId: string, message: SlackMessage, timestamp?: string, signal?: AbortSignal): Promise<SlackResult<SlackReceipt>> {
    if (!/^[CGD][A-Z0-9]+$/.test(channelId) || timestamp !== undefined && !/^\d{1,20}\.\d{1,10}$/.test(timestamp)) throw new SlackError('Slack delivery requires a channel ID and a valid update timestamp.');
    if (!message.text || message.text.length > 4000 || message.blocks.length > 12 || message.blocks.some(block => block.text.text.length > 3000)) throw new SlackError('Slack message exceeds the bounded renderer limits.');
    if (!this.verifiedToken) throw new SlackError('Verify the installation workspace before sending a Slack message.');
    const response = await this.call(timestamp ? 'chat.update' : 'chat.postMessage', { ...message, channel: channelId, ...(timestamp ? { ts: timestamp } : {}) }, this.verifiedToken, signal, channelId);
    if (response.status !== 'confirmed') return response;
    const receipt = { workspaceId: this.workspaceId, channelId: response.value.channel, timestamp: response.value.ts };
    if (!validReceipt(receipt) || receipt.channelId !== channelId || timestamp && receipt.timestamp !== timestamp) return { status: 'unknown', reason: 'Slack accepted the call without a matching message receipt. Reconcile delivery in the CLI inbox.' };
    return { status: 'confirmed', value: receipt };
  }
  private async call(method: string, payload: Record<string, unknown>, token: string, signal?: AbortSignal, channel?: string): Promise<SlackResult<Record<string, unknown>>> {
    const keys = [`${this.workspaceId}:all`, `${this.workspaceId}:${method}`, ...(channel ? [`${this.workspaceId}:channel:${channel}`] : [])];
    const blockedUntil = () => Math.max(0, ...keys.map(key => this.options.rates.read(key)));
    const deferred = (): SlackResult<never> => ({ status: 'deferred', retryAt: blockedUntil(), reason: 'Slack delivery is waiting for the persisted rate limit.' });
    if (blockedUntil() > this.now()) return deferred();
    if (signal?.aborted) return { status: 'rejected', reason: 'Slack delivery was cancelled before dispatch.' };
    for (const key of keys) this.options.rates.extend(key, this.now() + 1200);
    try {
      const response = await this.transport(`https://slack.com/api/${method}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]) });
      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after'));
        const until = Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(this.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.max(1, seconds) : 60) * 1000));
        for (const key of keys) this.options.rates.extend(key, until);
        await response.body?.cancel(); return { status: 'deferred', retryAt: until, attempted: true, reason: 'Slack rate limited this call. Its Retry-After time is retained.' };
      }
      if (response.status >= 500) { await response.body?.cancel(); return { status: 'unknown', reason: 'Slack returned a server error after dispatch. Delivery may have been accepted; reconcile it before resending.' }; }
      if (!response.ok) { await response.body?.cancel(); return { status: 'unknown', reason: 'Slack returned an unexpected HTTP response after dispatch. Reconcile delivery before resending.' }; }
      const reader = response.body?.getReader(); if (!reader) throw new Error();
      let bytes = 0, text = ''; const decoder = new TextDecoder();
      while (true) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 256 * 1024) { await reader.cancel(); throw new Error(); }
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode(); const data: unknown = JSON.parse(text);
      if (!object(data)) throw new Error();
      if (data.ok === true) return { status: 'confirmed', value: data };
      if (data.ok === false && (data.error === 'ratelimited' || data.error === 'rate_limited')) {
        const seconds = Number(response.headers.get('retry-after'));
        const until = Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(this.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.max(1, seconds) : 60) * 1000)); for (const key of keys) this.options.rates.extend(key, until);
        return { status: 'deferred', retryAt: until, attempted: true, reason: 'Slack rate limited this call. Retry after the saved delay.' };
      }
      if (data.ok === false && typeof data.error === 'string' && rejected.has(data.error)) return { status: 'rejected', reason: `Slack rejected delivery: ${data.error}. Check the token scopes, destination and bot membership. The complete request stays in the CLI inbox.` };
      throw new Error();
    } catch { return { status: 'unknown', reason: 'The Slack response was lost, timed out, or invalid. Delivery may have been accepted; reconcile it before resending.' }; }
  }
}
