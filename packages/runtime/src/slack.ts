import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, digest } from '@repo-chap/workflow';
import { previewPacket, validatePacket, type DecisionPacket, type PacketPreview, type SlackConfiguration } from '@repo-chap/slack';
import { validReceipt, type SlackReceipt, type SlackResult } from '@repo-chap/slack/web-api';
import { ArtifactStore, RuntimeError } from './artifacts.js';
import type { ArtifactRef, Claim, EffectAttempt, EffectLease, EffectRequest, EffectState } from './types.js';
import type { RuntimeStore } from './store.js';

export interface SlackRequestRecord {
  id: string; runId: string; evidenceKey: string; headSha: string; destination: string;
  packet: ArtifactRef; preview: ArtifactRef; supersededPreview: ArtifactRef;
  status: 'open' | 'superseded'; receipt: SlackReceipt | null; resends: number; activation?: number;
}
interface DeliveryData {
  id: string; requestId: string; runId: string; operation: 'post' | 'update' | 'supersede';
  channelId: string | null; timestamp: string | null; dueAt: number; reason: string; preparationFailures: number; activation?: number;
}
export interface SlackDeliveryRecord extends DeliveryData {
  state: EffectState;
  attempts: (EffectAttempt & { status: EffectState; reason: string })[];
}
const json = (value: unknown) => canonicalJson(value);
const decode = <T>(row: unknown): T => JSON.parse((row as { data: string }).data) as T;
export class SlackOutbox {
  constructor(private readonly db: DatabaseSync, private readonly artifacts: ArtifactStore, private readonly store: RuntimeStore) {
    db.exec(`CREATE TABLE IF NOT EXISTS slack_requests (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS slack_deliveries (id TEXT PRIMARY KEY REFERENCES effects(id), request_id TEXT NOT NULL REFERENCES slack_requests(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS slack_rates (key TEXT PRIMARY KEY, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS slack_dms (key TEXT PRIMARY KEY, channel_id TEXT NOT NULL);`);
  }
  private transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  requests(runId?: string): SlackRequestRecord[] {
    return (runId ? this.db.prepare('SELECT data FROM slack_requests WHERE run_id=? ORDER BY rowid').all(runId) : this.db.prepare('SELECT data FROM slack_requests ORDER BY rowid').all()).map(row => decode<SlackRequestRecord>(row));
  }
  request(id: string): SlackRequestRecord {
    const row = this.db.prepare('SELECT data FROM slack_requests WHERE id=?').get(id);
    if (!row) throw new RuntimeError('Slack request does not exist.'); return decode(row);
  }
  deliveries(runId?: string): SlackDeliveryRecord[] {
    return this.db.prepare('SELECT slack_deliveries.data,effects.state,effects.receipt FROM slack_deliveries JOIN effects USING(id)').all().map(row => {
      const data = decode<DeliveryData>(row), receipt = row.receipt ? JSON.parse(String(row.receipt)) : null;
      return { ...data, state: row.state as EffectState, reason: receipt?.reason ?? (row.state === 'unknown' ? 'Slack may have accepted this operation. Reconcile delivery before resending.' : data.reason),
        attempts: this.store.effectAttempts(data.id).map(attempt => ({ ...attempt, status: attempt.state, reason: (attempt.receipt as { reason?: string } | null)?.reason ?? (attempt.state === 'unknown' ? 'The send outcome is unknown.' : attempt.state) })) };
    }).filter(row => !runId || row.runId === runId);
  }
  delivery(id: string): SlackDeliveryRecord {
    const found = this.deliveries().find(row => row.id === id); if (!found) throw new RuntimeError('Slack delivery does not exist.'); return found;
  }
  private saveRequest(request: SlackRequestRecord): void { this.db.prepare('INSERT INTO slack_requests VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(request.id, request.runId, json(request)); }
  private saveDelivery(delivery: DeliveryData): void {
    const { id, requestId, runId, operation, channelId, timestamp, dueAt, reason, preparationFailures, activation } = delivery;
    this.db.prepare('UPDATE slack_deliveries SET data=? WHERE id=?').run(json({ id, requestId, runId, operation, channelId, timestamp, dueAt, reason, preparationFailures, ...(activation === undefined ? {} : { activation }) }), id);
  }
  private rejectUnsent(delivery: SlackDeliveryRecord, reason: string, now: number): void {
    delivery.reason = reason; this.saveDelivery(delivery);
    this.db.prepare("UPDATE effects SET state='rejected',receipt=? WHERE id=? AND state IN ('planned','rejected')").run(json({ reason, noMessageSent: true, at: now }), delivery.id);
  }
  private createDelivery(request: SlackRequestRecord, operation: DeliveryData['operation'], now: number, receipt: SlackReceipt | null, authorization: string | null = null): SlackDeliveryRecord {
    const run = this.store.run(request.runId), activation = request.activation ?? 0;
    const effect: EffectRequest = { kind: `slack.${operation}`, destination: request.destination, evidenceKey: operation === 'supersede' ? run.evidenceKey : request.evidenceKey, payload: operation === 'supersede' ? request.supersededPreview : request.preview, expectedRevision: receipt ? `${receipt.channelId}:${receipt.timestamp}` : request.headSha };
    const id = digest(json({ repositoryId: run.repositoryId, runId: run.id, ...effect, ...(activation ? { activation } : {}), ...(authorization ? { authorization } : {}) })).slice(7);
    const prior = this.deliveries().find(delivery => delivery.id === id); if (prior) return prior;
    this.db.prepare("INSERT INTO effects VALUES (?,?,'planned',?,?,NULL)").run(id, run.id, run.token, json(effect));
    const delivery: DeliveryData = { id, requestId: request.id, runId: run.id, operation, channelId: receipt?.channelId ?? null, timestamp: receipt?.timestamp ?? null, dueAt: now, reason: 'Slack delivery is queued.', preparationFailures: 0, activation };
    this.db.prepare('INSERT INTO slack_deliveries VALUES (?,?,?)').run(id, request.id, json(delivery)); return this.delivery(id);
  }
  async queue(claim: Claim, packet: DecisionPacket, configuration: SlackConfiguration | undefined, now: number): Promise<SlackRequestRecord> {
    validatePacket(packet);
    const preview = previewPacket(packet, configuration), packetRef = await this.artifacts.put(packet), previewRef = await this.artifacts.put(preview), supersededRef = await this.artifacts.put(previewPacket(packet, configuration, true));
    return this.transaction(() => {
      const run = this.store.run(claim.runId);
      if (!this.store.isCurrent(claim, now) || !run.evidenceAvailable || run.headSha !== packet.headSha) throw new RuntimeError('Slack packet inputs or ownership changed before queuing.');
      const destination = json({ workspaceId: preview.route.workspaceId, destination: preview.route.destination });
      const id = digest(json({ runId: run.id, evidenceKey: run.evidenceKey, destination, packet: packetRef.digest, preview: previewRef.digest })).slice(7);
      const requests = this.requests(run.id), existing = requests.find(request => request.id === id);
      if (existing?.status === 'open') return existing;
      const prior = requests.reduce<SlackRequestRecord | undefined>((latest, request) =>
        !latest || (request.activation ?? 0) >= (latest.activation ?? 0) ? request : latest, undefined);
      const shared = prior?.headSha === packet.headSha && prior.destination === destination ? prior.receipt : null;
      const reuse = shared ?? existing?.receipt ?? null;
      if (prior && prior.id !== id) {
        this.supersede(prior, now, !shared);
        if (shared) this.cancelCleanup(prior.id, now);
      }
      const activation = prior ? (prior.activation ?? 0) + 1 : 0;
      if (!Number.isSafeInteger(activation) || activation < 0) throw new RuntimeError('Slack request activation limit reached. Inspect its retained history.');
      const request: SlackRequestRecord = existing ? { ...existing, status: 'open', receipt: reuse, activation } :
        { id, runId: run.id, evidenceKey: run.evidenceKey, headSha: packet.headSha, destination, packet: packetRef, preview: previewRef, supersededPreview: supersededRef, status: 'open', receipt: reuse, resends: 0, activation };
      this.cancelCleanup(request.id, now);
      this.saveRequest(request); this.createDelivery(request, reuse ? 'update' : 'post', now, reuse); return request;
    });
  }
  private cancelCleanup(requestId: string, now: number): void {
    for (const delivery of this.deliveries().filter(item => item.requestId === requestId && item.operation === 'supersede' && ['planned', 'rejected'].includes(item.state)))
      this.rejectUnsent(delivery, 'The current packet will replace the earlier message.', now);
  }
  private supersede(request: SlackRequestRecord, now: number, remote: boolean): void {
    request.status = 'superseded'; this.saveRequest(request);
    for (const delivery of this.deliveries(request.runId).filter(delivery => delivery.requestId === request.id && delivery.operation !== 'supersede')) {
      if (delivery.state === 'planned') this.rejectUnsent(delivery, 'A newer packet superseded this unsent request.', now);
    }
    if (remote && request.receipt) this.createDelivery(request, 'supersede', now, request.receipt);
  }
  supersedeStale(now: number): void {
    this.transaction(() => {
      for (const request of this.requests()) {
        const run = this.store.run(request.runId);
        if (request.status === 'open' && (run.evidenceKey !== request.evidenceKey || run.headSha !== request.headSha || ['closed', 'cancelled'].includes(run.status))) this.supersede(request, now, true);
        else if (request.status === 'superseded' && request.receipt && this.deliveries(run.id).some(value => value.requestId === request.id && value.operation === 'supersede' && (value.activation ?? 0) === (request.activation ?? 0) && value.state === 'rejected' && (this.store.effects(run.id).find(effect => effect.id === value.id)?.receipt as { noMessageSent?: boolean } | null)?.noMessageSent !== true)) this.createDelivery(request, 'supersede', now, request.receipt);
      }
    });
  }
  rate(key: string, until?: number): number {
    if (until !== undefined) {
      if (!Number.isSafeInteger(until) || until < 0) throw new RuntimeError('Slack rate deadline is invalid.');
      this.db.prepare('INSERT INTO slack_rates VALUES (?,?) ON CONFLICT(key) DO UPDATE SET until=MAX(until,excluded.until)').run(key, until);
    }
    return Number((this.db.prepare('SELECT until FROM slack_rates WHERE key=?').get(key) as { until: number } | undefined)?.until ?? 0);
  }
  dm(workspaceId: string, memberId: string, channelId?: string): string | null {
    if (!/^T[A-Z0-9]+$/.test(workspaceId) || !/^U[A-Z0-9]+$/.test(memberId) || channelId !== undefined && !/^D[A-Z0-9]+$/.test(channelId)) throw new RuntimeError('Invalid Slack conversation identity.');
    const key = `${workspaceId}:${memberId}`;
    if (channelId) this.db.prepare('INSERT INTO slack_dms VALUES (?,?) ON CONFLICT(key) DO UPDATE SET channel_id=excluded.channel_id').run(key, channelId);
    return (this.db.prepare('SELECT channel_id FROM slack_dms WHERE key=?').get(key) as { channel_id: string } | undefined)?.channel_id ?? null;
  }
  pending(now: number): SlackDeliveryRecord[] {
    const all = this.deliveries();
    return all.filter(delivery => (delivery.state === 'planned' || delivery.state === 'rejected' && (this.store.effects(delivery.runId).find(effect => effect.id === delivery.id)?.receipt as { retryable?: boolean } | null)?.retryable === true) && delivery.dueAt <= now && delivery.attempts.length < Math.min(3, this.store.limits.maxRetries + 1) && !all.some(other => other.runId === delivery.runId && ['unknown', 'sending'].includes(other.state))).sort((a, b) => Number(b.operation === 'supersede') - Number(a.operation === 'supersede'));
  }
  prepare(id: string, result: Exclude<SlackResult<unknown>, { status: 'confirmed' }>, now: number): void {
    this.transaction(() => {
      const delivery = this.delivery(id); if (!['planned', 'rejected'].includes(delivery.state)) return;
      delivery.reason = result.reason;
      if (result.status === 'deferred') {
        delivery.dueAt = result.retryAt;
        if (result.attempted && ++delivery.preparationFailures >= 3) this.rejectUnsent(delivery, 'Slack preparation reached its three-call retry limit. The complete request stays in the CLI inbox.', now);
        else this.saveDelivery(delivery);
      } else { delivery.preparationFailures++; this.rejectUnsent(delivery, delivery.reason, now); }
    });
  }
  begin(id: string, channelId: string, owner: string, now: number): EffectLease | null {
    return this.transaction(() => {
      const delivery = this.delivery(id), request = this.request(delivery.requestId), run = this.store.run(delivery.runId);
      if (!this.pending(now).some(item => item.id === id) || !/^[CGD][A-Z0-9]+$/.test(channelId)) return null;
      if ((delivery.activation ?? 0) !== (request.activation ?? 0) || (delivery.operation === 'supersede' ? request.status !== 'superseded' :
        request.status !== 'open' || run.evidenceKey !== request.evidenceKey || run.headSha !== request.headSha)) return null;
      const claim = this.store.claimForEffect(id, owner, now, 30); if (!claim) return null;
      const lease = this.store.beginEffect(claim, id, 3, now, 30);
      this.store.releaseEffectClaim(claim, now);
      delivery.channelId = channelId; delivery.reason = 'Slack call dispatched.'; this.saveDelivery(delivery); return lease;
    });
  }
  finish(lease: EffectLease, result: SlackResult<SlackReceipt>, now: number): boolean {
    return this.transaction(() => {
      const delivery = this.delivery(lease.effectId), request = this.request(delivery.requestId);
      const reason = result.status === 'confirmed' ? 'Slack delivery confirmed.' : result.reason;
      if (result.status === 'confirmed' && (!validReceipt(result.value) || result.value.channelId !== delivery.channelId || result.value.workspaceId !== JSON.parse(request.destination).workspaceId || delivery.timestamp && result.value.timestamp !== delivery.timestamp)) throw new RuntimeError('Slack returned an invalid delivery receipt.');
      const receipt = result.status === 'confirmed' ? { ...result.value, reason } : { reason, retryable: result.status === 'deferred', ...(result.status === 'deferred' ? { retryAt: result.retryAt, noMessageSent: !result.attempted } : {}) };
      if (!this.store.finishEffect(lease, result.status === 'deferred' ? 'rejected' : result.status, receipt, now)) return false;
      if (result.status === 'confirmed') { request.receipt = result.value; this.saveRequest(request); }
      if (result.status === 'deferred') delivery.dueAt = result.retryAt;
      delivery.reason = reason; this.saveDelivery(delivery); return true;
    });
  }
  recover(now: number): void { this.store.recover(now); }
  reconcile(id: string, resolution: { action: 'delivered'; receipt: SlackReceipt } | { action: 'resend' }, now: number): SlackDeliveryRecord {
    return this.transaction(() => {
      const delivery = this.delivery(id), request = this.request(delivery.requestId);
      if (delivery.state !== 'unknown' && !(delivery.state === 'rejected' && resolution.action === 'resend')) throw new RuntimeError('Only an unknown delivery can be marked delivered; unknown or rejected deliveries can request a bounded resend.');
      if (resolution.action === 'delivered') {
        const receipt = resolution.receipt;
        if (!validReceipt(receipt) || receipt.workspaceId !== JSON.parse(request.destination).workspaceId || delivery.channelId !== receipt.channelId || delivery.timestamp && delivery.timestamp !== receipt.timestamp) throw new RuntimeError('Use a matching workspace, channel and message timestamp receipt.');
        const reason = 'The operator confirmed delivery with a Slack receipt.';
        if (!this.store.reconcileEffect(id, 'confirmed', { ...receipt, reason, reconciledAt: now }, now, true)) throw new RuntimeError('The delivery changed before reconciliation.');
        request.receipt = receipt; this.saveRequest(request);
        if (request.status === 'superseded' && delivery.operation !== 'supersede') this.createDelivery(request, 'supersede', now, receipt);
        if (request.status === 'open' && (delivery.activation ?? 0) !== (request.activation ?? 0)) {
          const posts = this.deliveries(request.runId).filter(item => item.requestId === request.id && (item.activation ?? 0) === (request.activation ?? 0) && item.operation === 'post' && item.state === 'planned');
          for (const post of posts) this.rejectUnsent(post, 'The reconciled receipt lets the current decision reuse its message.', now);
          if (posts.length) this.createDelivery(request, 'update', now, receipt);
        }
        return this.delivery(id);
      }
      if (request.resends >= 3) throw new RuntimeError('This request has used its three explicit resends. Retain the request in the inbox and inspect Slack access.');
      const authorization = { authorization: 'resend', at: now, priorOutcome: delivery.state, reason: 'The operator authorized a resend and accepted the risk of a duplicate prior delivery.' };
      if (delivery.state === 'unknown') this.store.reconcileEffect(id, 'rejected', authorization, now, true);
      else this.db.prepare('UPDATE effects SET receipt=? WHERE id=?').run(json(authorization), id);
      request.resends++; this.saveRequest(request);
      if ((delivery.activation ?? 0) !== (request.activation ?? 0) || (delivery.operation === 'supersede' ? request.status !== 'superseded' : request.status !== 'open')) return this.delivery(id);
      return this.createDelivery(request, delivery.operation, now, delivery.timestamp && delivery.channelId ? { workspaceId: JSON.parse(request.destination).workspaceId, channelId: delivery.channelId, timestamp: delivery.timestamp } : null, `${delivery.id}:resend:${request.resends}`);
    });
  }
  async inbox(runId?: string): Promise<unknown[]> {
    const deliveries = this.deliveries(runId);
    return Promise.all(this.requests(runId).map(async request => ({ ...request, packet: await this.artifacts.get<DecisionPacket>(request.packet), preview: await this.artifacts.get<PacketPreview>(request.preview), deliveries: deliveries.filter(delivery => delivery.requestId === request.id) })));
  }
}
