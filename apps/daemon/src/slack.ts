import { randomUUID } from 'node:crypto';
import { SlackApi } from '@repo-chap/slack/web-api';
import type { PacketPreview } from '@repo-chap/slack';
import type { RuntimeStore, RunRecord, EffectLease } from '@repo-chap/runtime';

export { packetForRun } from './packet.js';

export async function deliverSlack(store: RuntimeStore, api: SlackApi, now: () => number, signal: AbortSignal, permitted: (run: RunRecord) => Promise<boolean>, selected: (run: RunRecord) => boolean = () => true): Promise<void> {
  if (store.recovery().paused) return;
  store.slack.recover(now()); store.slack.supersedeStale(now());
  for (const pending of store.slack.pending(now())) {
    if (signal.aborted) return;
    let lease: EffectLease | null = null;
    try {
      const request = store.slack.request(pending.requestId), run = store.run(pending.runId);
      if (!selected(run) || store.recovery().paused || store.repository(run.repositoryId).paused) continue;
      if (!await permitted(run)) { store.slack.prepare(pending.id, { status: 'rejected', reason: 'Current operator permissions do not allow Slack delivery. The complete request stays in the CLI inbox.' }, now()); continue; }
      const preview = await store.artifacts.get<PacketPreview>(pending.operation === 'supersede' ? request.supersededPreview : request.preview);
      if (preview.route.workspaceId !== api.workspaceId || !preview.route.destination) { store.slack.prepare(pending.id, { status: 'rejected', reason: 'No configured Slack destination matches this installation. The complete request stays in the CLI inbox.' }, now()); continue; }
      const verified = await api.verify(signal);
      if (verified.status !== 'confirmed') { store.slack.prepare(pending.id, verified, now()); continue; }
      const destination = preview.route.destination;
      let channel = pending.channelId ?? (destination.kind === 'channel' ? destination.channelId : store.slack.dm(api.workspaceId, destination.memberId));
      if (!channel && destination.kind === 'dm') {
        const opened = await api.openDm(destination.memberId, signal);
        if (opened.status !== 'confirmed') { store.slack.prepare(pending.id, opened, now()); continue; }
        channel = opened.value; store.slack.dm(api.workspaceId, destination.memberId, channel);
      }
      if (!channel) continue;
      if (!await permitted(store.run(pending.runId))) { store.slack.prepare(pending.id, { status: 'rejected', reason: 'Slack permission changed during preparation. The complete request stays in the CLI inbox.' }, now()); continue; }
      const retryAt = api.messageRetryAt(channel, pending.timestamp !== null);
      if (retryAt > now()) { store.slack.prepare(pending.id, { status: 'deferred', retryAt, reason: 'Slack delivery is waiting for the persisted rate limit.' }, now()); continue; }
      lease = store.slack.begin(pending.id, channel, randomUUID(), now());
      if (!lease) continue;
      if (!store.effectCurrent(lease, now())) { store.slack.finish(lease, { status: 'unknown', reason: 'Slack ownership changed before dispatch. Inspect the retained attempt.' }, now()); continue; }
      const result = await api.send(channel, preview.message, pending.timestamp ?? undefined, signal);
      store.slack.finish(lease, result, now());
    } catch {
      const current = store.slack.delivery(pending.id);
      if (current.state === 'sending' && lease) store.slack.finish(lease, { status: 'unknown', reason: 'Slack delivery stopped without a saved outcome. Reconcile the receipt before resending.' }, now());
      else if (current.state === 'planned') store.slack.prepare(pending.id, { status: 'rejected', reason: 'Slack delivery could not read its private configuration or packet. Fix the input, then explicitly retry this delivery from the inbox.' }, now());
    }
  }
}
