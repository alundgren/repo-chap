import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, digest } from '@repo-chap/workflow';
import { previewPacket, validatePacket, type DecisionPacket, type PacketPreview, type SlackConfiguration } from '@repo-chap/slack';
import { validReceipt, type SlackReceipt, type SlackResult } from '@repo-chap/slack/web-api';
import { ArtifactStore, RuntimeError } from './artifacts.js';
import type { ArtifactRef, Claim, EffectRequest, EffectState, RunRecord } from './types.js';

export interface SlackRequestRecord {
  id: string; runId: string; evidenceKey: string; headSha: string; destination: string;
  packet: ArtifactRef; preview: ArtifactRef; supersededPreview: ArtifactRef;
  status: 'open' | 'superseded'; receipt: SlackReceipt | null; resends: number;
}
export interface SlackDeliveryRecord {
  id: string; requestId: string; runId: string; operation: 'post' | 'update' | 'supersede';
  state: EffectState; channelId: string | null; timestamp: string | null;
  dueAt: number; owner: string | null; leaseUntil: number | null; reason: string;
  attempts: { startedAt: number; finishedAt: number | null; status: EffectState | 'rate_limited'; receipt: SlackReceipt | null; reason: string }[];
  preparationFailures: number;
}
const json = (value: unknown) => canonicalJson(value);
const decode = <T>(row: unknown): T => JSON.parse((row as { data: string }).data) as T;
export class SlackOutbox {
  constructor(private readonly db: DatabaseSync, private readonly artifacts: ArtifactStore, private readonly run: (id: string) => RunRecord) {
    db.exec(`CREATE TABLE IF NOT EXISTS slack_requests (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS slack_deliveries (id TEXT PRIMARY KEY REFERENCES effects(id), request_id TEXT NOT NULL REFERENCES slack_requests(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS slack_rates (key TEXT PRIMARY KEY, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS slack_dms (key TEXT PRIMARY KEY, channel_id TEXT NOT NULL);`);
  }
  private transaction<T>(fn: () => T): T {
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
    return this.db.prepare('SELECT slack_deliveries.data,effects.state FROM slack_deliveries JOIN effects USING(id)').all().map(row => ({ ...decode<SlackDeliveryRecord>(row), state: row.state as EffectState })).filter(row => !runId || row.runId === runId);
  }
  delivery(id: string): SlackDeliveryRecord {
    const found = this.deliveries().find(row => row.id === id); if (!found) throw new RuntimeError('Slack delivery does not exist.'); return found;
  }
  private saveRequest(request: SlackRequestRecord): void { this.db.prepare('INSERT INTO slack_requests VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(request.id, request.runId, json(request)); }
  private saveDelivery(delivery: SlackDeliveryRecord, receipt: unknown = null): void {
    this.db.prepare('UPDATE slack_deliveries SET data=? WHERE id=?').run(json(delivery), delivery.id);
    this.db.prepare('UPDATE effects SET state=?,receipt=COALESCE(?,receipt) WHERE id=?').run(delivery.state, receipt === null ? null : json(receipt), delivery.id);
  }
  private createDelivery(request: SlackRequestRecord, operation: SlackDeliveryRecord['operation'], now: number, receipt: SlackReceipt | null, authorization: string | null = null): SlackDeliveryRecord {
    const run = this.run(request.runId);
    const effect: EffectRequest = { kind: `slack.${operation}`, destination: request.destination, evidenceKey: request.evidenceKey, payload: operation === 'supersede' ? request.supersededPreview : request.preview, expectedRevision: receipt ? `${receipt.channelId}:${receipt.timestamp}` : request.headSha };
    const id = digest(json({ repositoryId: run.repositoryId, runId: run.id, ...effect, ...(authorization ? { authorization } : {}) })).slice(7);
    const prior = this.deliveries().find(delivery => delivery.id === id); if (prior) return prior;
    this.db.prepare("INSERT INTO effects VALUES (?,?,'planned',?,?,NULL)").run(id, run.id, run.token, json(effect));
    const delivery: SlackDeliveryRecord = { id, requestId: request.id, runId: run.id, operation, state: 'planned', channelId: receipt?.channelId ?? null, timestamp: receipt?.timestamp ?? null, dueAt: now, owner: null, leaseUntil: null, reason: 'Slack delivery is queued.', attempts: [], preparationFailures: 0 };
    this.db.prepare('INSERT INTO slack_deliveries VALUES (?,?,?)').run(id, request.id, json(delivery)); return delivery;
  }
  async queue(claim: Claim, packet: DecisionPacket, configuration: SlackConfiguration | undefined, now: number): Promise<SlackRequestRecord> {
    validatePacket(packet);
    const preview = previewPacket(packet, configuration), packetRef = await this.artifacts.put(packet), previewRef = await this.artifacts.put(preview), supersededRef = await this.artifacts.put(previewPacket(packet, configuration, true));
    return this.transaction(() => {
      const run = this.run(claim.runId);
      if (run.token !== claim.token || run.owner !== claim.owner || run.evidenceKey !== claim.evidenceKey || run.notesRevision !== claim.notesRevision || (run.leaseUntil ?? 0) <= now || run.headSha !== packet.headSha) throw new RuntimeError('Slack packet inputs or ownership changed before queuing.');
      const destination = json({ workspaceId: preview.route.workspaceId, destination: preview.route.destination });
      const id = digest(json({ runId: run.id, evidenceKey: run.evidenceKey, destination, packet: packetRef.digest, preview: previewRef.digest })).slice(7);
      const existing = this.requests(run.id).find(request => request.id === id); if (existing) return existing;
      const prior = this.requests(run.id).at(-1);
      const reuse = prior?.headSha === packet.headSha && prior.destination === destination ? prior.receipt : null;
      if (prior) {
        this.supersede(prior, now, !reuse);
        if (reuse) for (const cleanup of this.deliveries(run.id).filter(item => item.requestId === prior.id && item.operation === 'supersede' && item.state === 'planned')) { cleanup.state = 'rejected'; cleanup.reason = 'The current packet will replace the earlier message.'; this.saveDelivery(cleanup, { reason: cleanup.reason }); }
      }
      const request: SlackRequestRecord = { id, runId: run.id, evidenceKey: run.evidenceKey, headSha: packet.headSha, destination, packet: packetRef, preview: previewRef, supersededPreview: supersededRef, status: 'open', receipt: reuse ?? null, resends: 0 };
      this.saveRequest(request); this.createDelivery(request, reuse ? 'update' : 'post', now, reuse ?? null); return request;
    });
  }
  private supersede(request: SlackRequestRecord, now: number, remote: boolean): void {
    request.status = 'superseded'; this.saveRequest(request);
    for (const delivery of this.deliveries(request.runId).filter(delivery => delivery.requestId === request.id && delivery.operation !== 'supersede')) {
      if (delivery.state === 'planned') { delivery.state = 'rejected'; delivery.reason = 'A newer packet superseded this unsent request.'; this.saveDelivery(delivery, { reason: delivery.reason }); }
      else if (delivery.state === 'sending') { delivery.state = 'unknown'; delivery.reason = 'Inputs changed during Slack delivery. Reconcile the prior send before continuing.'; this.saveDelivery(delivery); }
    }
    if (remote && request.receipt) this.createDelivery(request, 'supersede', now, request.receipt);
  }
  supersedeStale(now: number): void {
    this.transaction(() => {
      for (const request of this.requests().filter(request => request.status === 'open')) {
        const run = this.run(request.runId);
        if (run.evidenceKey !== request.evidenceKey || run.headSha !== request.headSha || ['closed', 'cancelled'].includes(run.status) || !run.evidenceAvailable) this.supersede(request, now, true);
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
    return all.filter(delivery => delivery.state === 'planned' && delivery.dueAt <= now && !all.some(other => other.runId === delivery.runId && ['unknown', 'sending'].includes(other.state))).sort((a, b) => Number(b.operation === 'supersede') - Number(a.operation === 'supersede'));
  }
  prepare(id: string, result: Exclude<SlackResult<unknown>, { status: 'confirmed' }>, now: number): void {
    this.transaction(() => {
      const delivery = this.delivery(id); if (delivery.state !== 'planned') return;
      delivery.reason = result.reason;
      if (result.status === 'deferred') { delivery.dueAt = result.retryAt; if (result.attempted && ++delivery.preparationFailures >= 3) { delivery.state = 'rejected'; delivery.reason = 'Slack preparation reached its three-call retry limit. The complete request stays in the CLI inbox.'; } }
      else { delivery.state = 'rejected'; delivery.preparationFailures++; }
      this.saveDelivery(delivery, delivery.state === 'rejected' ? { reason: delivery.reason, phase: 'preparation', noMessageSent: true, at: now } : null);
    });
  }
  begin(id: string, channelId: string, owner: string, now: number): SlackDeliveryRecord | null {
    return this.transaction(() => {
      const delivery = this.delivery(id), request = this.request(delivery.requestId), run = this.run(delivery.runId);
      if (!this.pending(now).some(item => item.id === id) || delivery.attempts.length >= 3 || !owner || !/^[CGD][A-Z0-9]+$/.test(channelId)) return null;
      if (delivery.operation !== 'supersede' && (request.status !== 'open' || run.evidenceKey !== request.evidenceKey || run.headSha !== request.headSha || !run.evidenceAvailable || ['closed', 'cancelled'].includes(run.status))) return null;
      delivery.state = 'sending'; delivery.channelId = channelId; delivery.owner = owner; delivery.leaseUntil = now + 30_000;
      delivery.attempts.push({ startedAt: now, finishedAt: null, status: 'sending', receipt: null, reason: 'Slack call dispatched.' }); this.saveDelivery(delivery); return delivery;
    });
  }
  finish(id: string, owner: string, result: SlackResult<SlackReceipt>, now: number): boolean {
    return this.transaction(() => {
      const delivery = this.delivery(id);
      if (delivery.state !== 'sending' || delivery.owner !== owner || (delivery.leaseUntil ?? 0) <= now) return false;
      const attempt = delivery.attempts.at(-1)!; attempt.finishedAt = now;
      delivery.owner = null; delivery.leaseUntil = null;
      if (result.status === 'confirmed') {
        if (!validReceipt(result.value) || result.value.channelId !== delivery.channelId || delivery.timestamp && result.value.timestamp !== delivery.timestamp) throw new RuntimeError('Slack returned an invalid delivery receipt.');
        delivery.state = 'confirmed'; delivery.reason = 'Slack delivery confirmed.'; attempt.receipt = result.value;
        const request = this.request(delivery.requestId); request.receipt = result.value; this.saveRequest(request);
      } else if (result.status === 'deferred') {
        if (!result.attempted) delivery.attempts.pop();
        delivery.state = delivery.attempts.length >= 3 ? 'rejected' : 'planned'; delivery.dueAt = result.retryAt;
        delivery.reason = delivery.state === 'rejected' ? 'Slack delivery reached its three-call limit. The complete request stays in the CLI inbox.' : result.reason;
      } else { delivery.state = result.status; delivery.reason = result.reason; }
      attempt.status = result.status === 'deferred' ? 'rate_limited' : delivery.state; attempt.reason = delivery.reason;
      this.saveDelivery(delivery, result.status === 'confirmed' ? result.value : result.status === 'unknown' ? null : { reason: delivery.reason, at: now }); return true;
    });
  }
  recover(now: number, abandonedProcess = false): void {
    this.transaction(() => {
      for (const delivery of this.deliveries()) if (delivery.state === 'unknown' && delivery.attempts.at(-1)?.status === 'sending' || delivery.state === 'sending' && (abandonedProcess || (delivery.leaseUntil ?? 0) <= now)) {
        delivery.state = 'unknown'; delivery.owner = null; delivery.leaseUntil = null; delivery.reason = 'The daemon stopped before saving a Slack receipt. Reconcile delivery before resending.';
        const attempt = delivery.attempts.at(-1); if (attempt) { attempt.status = 'unknown'; attempt.finishedAt = now; attempt.reason = delivery.reason; }
        this.saveDelivery(delivery);
      }
    });
  }
  reconcile(id: string, resolution: { action: 'delivered'; receipt: SlackReceipt } | { action: 'resend' }, now: number): SlackDeliveryRecord {
    return this.transaction(() => {
      const delivery = this.delivery(id), request = this.request(delivery.requestId);
      if (delivery.state !== 'unknown' && !(delivery.state === 'rejected' && resolution.action === 'resend')) throw new RuntimeError('Only an unknown delivery can be marked delivered; unknown or rejected deliveries can request a bounded resend.');
      if (resolution.action === 'delivered') {
        const receipt = resolution.receipt;
        const destination = JSON.parse(request.destination) as { workspaceId: string };
        if (!validReceipt(receipt) || receipt.workspaceId !== destination.workspaceId || delivery.channelId !== receipt.channelId || delivery.timestamp && delivery.timestamp !== receipt.timestamp) throw new RuntimeError('Use a matching workspace, channel and message timestamp receipt.');
        delivery.state = 'confirmed'; delivery.reason = 'The operator confirmed delivery with a Slack receipt.'; request.receipt = receipt; this.saveRequest(request); this.saveDelivery(delivery, { ...receipt, reconciledAt: now });
        if (request.status === 'superseded' && delivery.operation !== 'supersede') this.createDelivery(request, 'supersede', now, receipt);
        return delivery;
      }
      if (request.resends >= 3) throw new RuntimeError('This request has used its three explicit resends. Retain the request in the inbox and inspect Slack access.');
      request.resends++; this.saveRequest(request); delivery.state = 'rejected'; delivery.reason = 'The operator authorized a resend and accepted the risk of a duplicate prior delivery.'; this.saveDelivery(delivery, { authorization: 'resend', at: now, priorOutcome: 'unknown_or_rejected' });
      if (request.status === 'superseded' && delivery.operation !== 'supersede') return delivery;
      return this.createDelivery(request, delivery.operation, now, delivery.timestamp && delivery.channelId ? { workspaceId: JSON.parse(request.destination).workspaceId, channelId: delivery.channelId, timestamp: delivery.timestamp } : null, `${delivery.id}:resend:${request.resends}`);
    });
  }
  async inbox(runId?: string): Promise<unknown[]> {
    const deliveries = this.deliveries(runId);
    return Promise.all(this.requests(runId).map(async request => ({ ...request, packet: await this.artifacts.get<DecisionPacket>(request.packet), preview: await this.artifacts.get<PacketPreview>(request.preview), deliveries: deliveries.filter(delivery => delivery.requestId === request.id) })));
  }
}
