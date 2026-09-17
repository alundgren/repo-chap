import { loadWorkflow, parseJson, readFixtureText } from '@repo-chap/workflow';
import { previewHtml, previewPacket, validatePacket } from '@repo-chap/slack';
import { requestControl, type ControlRequest } from '@repo-chap/daemon';
import { resolve } from 'node:path';
import { RuntimeStore } from '@repo-chap/runtime';

export const slackHelp = `Preview a Slack handoff without network access, tokens or providers.

  repo-chap slack-preview <workflow.json> --packet <packet.json> [--repo-root <directory>] [--json | --html]

Text shows the destination and accessible message. JSON contains the same route,
Block Kit message and omissions. HTML prints a standalone local preview.
The complete packet remains in your input file. Nothing is sent to Slack.
`;
export async function slackPreviewCommand(args: string[]): Promise<void> {
  const json = args.includes('--json');
  try {
    if (args.includes('--help')) { process.stdout.write(slackHelp); return; }
    const file = args.shift(); if (!file || file.startsWith('-')) throw new Error('Slack preview requires a workflow path. See slack-preview --help.');
    const options: Record<string, string> = {}; const seen = new Set<string>();
    while (args.length) {
      const key = args.shift()!;
      if (!['--packet', '--repo-root', '--json', '--html'].includes(key) || seen.has(key)) throw new Error(`Unknown or repeated option: ${key}.`);
      seen.add(key); if (key === '--json' || key === '--html') continue;
      const value = args.shift(); if (!value || value.startsWith('-')) throw new Error(`${key} requires a value.`); options[key] = value;
    }
    if (!options['--packet'] || seen.has('--json') && seen.has('--html')) throw new Error('Provide --packet and choose at most one of --json or --html.');
    const pkg = await loadWorkflow(file, { repositoryRoot: options['--repo-root'] });
    const packet = validatePacket(parseJson(await readFixtureText(options['--packet']), options['--packet']));
    const preview = previewPacket(packet, pkg.workflow.slack);
    process.stdout.write(seen.has('--html') ? previewHtml(preview) : json ? JSON.stringify(preview, null, 2) + '\n' : `Local Slack preview. Nothing was sent.\n${preview.route.explanation}\n\n${preview.message.text}\n`);
  } catch (error) {
    process.exitCode = 8; const message = error instanceof Error ? error.message : 'Slack preview failed.';
    if (json) process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, error: message }) + '\n'); else process.stderr.write(message + '\n');
  }
}

export const slackInboxHelp = `  repo-chap daemon inbox [run-id] --state-dir <private-directory> [--json]
  repo-chap daemon slack-reconcile <delivery-id> --state-dir <private-directory> --delivered --workspace <T...> --channel <C...|G...|D...> --timestamp <message-timestamp> [--json]
  repo-chap daemon slack-reconcile <delivery-id> --state-dir <private-directory> --resend [--json]

Inbox retains complete packets, delivery attempts and receipts. Unknown means Slack
may have accepted the message. Mark delivered only with its actual receipt.
Resend explicitly accepts possible duplicate delivery and retains the prior attempt.
Neither command reruns analysis or code repairs.
`;
export async function slackInboxCommand(command: 'inbox' | 'slack-reconcile', args: string[], local = false): Promise<void> {
  const json = args.includes('--json');
  try {
    if (args.includes('--help')) { process.stdout.write(local ? slackInboxHelp.replaceAll('daemon ', 'apply ') : slackInboxHelp); return; }
    const id = args[0] && !args[0].startsWith('-') ? args.shift() : undefined;
    const options: Record<string, string> = {}, seen = new Set<string>();
    const allowed = command === 'inbox' ? ['--state-dir', '--json'] : ['--state-dir', '--json', '--delivered', '--resend', '--workspace', '--channel', '--timestamp'];
    while (args.length) {
      const key = args.shift()!;
      if (!allowed.includes(key) || seen.has(key)) throw new Error(`Unknown or repeated option: ${key}.`);
      seen.add(key); if (['--json', '--delivered', '--resend'].includes(key)) continue;
      const value = args.shift(); if (!value || value.startsWith('-')) throw new Error(`${key} requires a value.`); options[key] = value;
    }
    if (!options['--state-dir']) throw new Error('Slack inbox commands require --state-dir.');
    let request: ControlRequest;
    if (command === 'inbox') request = { method: 'inbox', ...(id ? { runId: id } : {}) };
    else {
      if (!id || seen.has('--delivered') === seen.has('--resend')) throw new Error('Reconciliation requires a delivery ID and exactly one of --delivered or --resend.');
      if (seen.has('--delivered') && ['--workspace', '--channel', '--timestamp'].some(key => !options[key])) throw new Error('Delivered requires --workspace, --channel and --timestamp from the Slack receipt.');
      if (seen.has('--resend') && ['--workspace', '--channel', '--timestamp'].some(key => seen.has(key))) throw new Error('Receipt fields belong to --delivered.');
      request = { method: 'slack-reconcile', deliveryId: id, resolution: seen.has('--resend') ? { action: 'resend' } : { action: 'delivered', receipt: { workspaceId: options['--workspace']!, channelId: options['--channel']!, timestamp: options['--timestamp']! } } };
    }
    const response = local ? await localSlackControl(resolve(options['--state-dir']), request) : await requestControl(resolve(options['--state-dir']), request);
    if (!response.ok) throw new Error(response.error);
    if (json) { process.stdout.write(JSON.stringify(response, null, 2) + '\n'); return; }
    if (command === 'inbox') {
      const requests = response.result as { id: string; runId: string; status: string; packet: unknown; deliveries: { id: string; state: string; reason: string; channelId: string | null; timestamp: string | null }[] }[];
      if (!requests.length) { process.stdout.write('The Slack inbox is empty.\n'); return; }
      for (const entry of requests) {
        const packet = validatePacket(entry.packet);
        const lines = [`Request ${entry.id}: ${entry.status}`, `Run ${entry.runId}`, `${packet.repository} PR #${packet.prNumber} at ${packet.headSha}`, `Outcome ${packet.outcome}`, packet.reason, `Decision: ${packet.recommendedDecision}`, ...packet.findings.map(item => `Finding: ${item}`), ...packet.attemptedFixes.map(item => `Attempted change: ${item}`), ...packet.checks.map(item => `Test ${item.name}: ${item.status}. ${item.evidence}`), ...packet.uncertainty.map(item => `Uncertainty: ${item}`), ...packet.evidenceLinks.map(item => `${item.label}: ${item.url}`), ...entry.deliveries.map(item => `Delivery ${item.id}: ${item.state}. ${item.reason}${item.channelId ? ` Channel ${item.channelId}.` : ''}${item.timestamp ? ` Message ${item.timestamp}.` : ''}`)];
        process.stdout.write(lines.join('\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '') + '\n\n');
      }
    } else {
      const delivery = response.result as { id: string; state: string; reason: string };
      process.stdout.write(`Delivery ${delivery.id}: ${delivery.state}. ${delivery.reason}\n`);
    }
  } catch (error) {
    process.exitCode = 8; const message = error instanceof Error ? error.message : 'Slack inbox command failed.';
    if (json) process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, error: message }) + '\n'); else process.stderr.write(message + '\n');
  }
}

async function localSlackControl(directory: string, request: Extract<ControlRequest, { method: 'inbox' | 'slack-reconcile' }>) {
  const store = await RuntimeStore.open(directory); let ownership: string | undefined;
  try {
    ownership = store.claimDaemon(); store.slack.recover(Date.now());
    const result = request.method === 'inbox' ? await store.slack.inbox(request.runId) : store.slack.reconcile(request.deliveryId, request.resolution, Date.now());
    return { ok: true as const, result };
  } finally { if (ownership) store.releaseDaemon(ownership); store.close(); }
}
