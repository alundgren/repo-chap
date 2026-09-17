import { SlackError, type DecisionPacket, type PacketOutcome, type PacketPreview, type SlackConfiguration } from './types.js';
import { previewRoute } from './route.js';

export const outcomeTitles: Record<PacketOutcome, string> = {
  needs_author: 'Author decision needed', needs_team: 'Team decision needed',
  ready_for_human_merge: 'Ready for human merge', blocked_execution: 'Execution blocked',
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const clean = (text: string): string => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\r/g, '').replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
export function escapeMrkdwn(text: string): string {
  // Neutralize source formatting as well as Slack's link and mention syntax.
  return clean(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[*_~`]/g, value => ({ '*': '＊', '_': '＿', '~': '～', '`': '｀' })[value]!);
}
function githubUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !/[&<>|\s]/.test(value); } catch { return false; }
}
export function validatePacket(value: unknown): DecisionPacket {
  if (!record(value) || value.schemaVersion !== 1 || Object.keys(value).some(key => !['schemaVersion', 'repository', 'prNumber', 'headSha', 'authorLogin', 'outcome', 'reason', 'recommendedDecision', 'findings', 'attemptedFixes', 'checks', 'uncertainty', 'evidenceLinks'].includes(key))) throw new SlackError('Use a version-1 decision packet with supported fields.');
  const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 100_000;
  if (!text(value.repository) || String(value.repository).length > 100 || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(String(value.repository)) || !Number.isSafeInteger(value.prNumber) || Number(value.prNumber) < 1 || !/^[a-f0-9]{40}$/.test(String(value.headSha)) || value.authorLogin !== null && (!text(value.authorLogin) || !/^[a-z0-9][a-z0-9-]*(\[bot\])?$/i.test(String(value.authorLogin))) || !Object.hasOwn(outcomeTitles, String(value.outcome)) || !text(value.reason) || !text(value.recommendedDecision)) throw new SlackError('The packet needs a repository, PR number, exact head, author, outcome, reason and requested decision.');
  for (const key of ['findings', 'attemptedFixes', 'uncertainty']) if (!Array.isArray(value[key]) || value[key].length > 1000 || !value[key].every(text)) throw new SlackError(`Packet ${key} must contain at most 1000 nonempty text entries.`);
  if (!Array.isArray(value.checks) || value.checks.length > 1000 || !value.checks.every(item => record(item) && Object.keys(item).every(key => ['name', 'status', 'evidence'].includes(key)) && text(item.name) && text(item.evidence) && ['passed', 'failed', 'pending', 'not_run'].includes(String(item.status)))) throw new SlackError('Packet checks need a name, status and evidence.');
  if (!Array.isArray(value.evidenceLinks) || value.evidenceLinks.length > 1000 || !value.evidenceLinks.every(item => record(item) && Object.keys(item).every(key => ['label', 'url'].includes(key)) && text(item.label) && text(item.url) && String(item.url).length <= 256 && githubUrl(String(item.url)))) throw new SlackError('Packet evidence links require a label and an HTTPS GitHub URL.');
  if (JSON.stringify(value).length > 1_000_000) throw new SlackError('The complete packet exceeds 1,000,000 characters. Retain detailed evidence as local artifacts.');
  return value as unknown as DecisionPacket;
}
export function previewPacket(input: DecisionPacket, config?: SlackConfiguration, superseded = false): PacketPreview {
  const packet = validatePacket(input), route = previewRoute(config, packet.outcome, packet.authorLogin), omissions: string[] = [];
  const clip = (value: string, maximum: number, field: string) => {
    const text = clean(value);
    if (escapeMrkdwn(text).length <= maximum) return text;
    omissions.push(`${field} shortened`);
    let prefix = '', length = 0;
    for (const character of text) { const count = escapeMrkdwn(character).length; if (length + count > maximum - 14) break; prefix += character; length += count; }
    return prefix + '… [shortened]';
  };
  const list = (values: string[], maximum: number, field: string, empty: string): string => {
    if (!values.length) return empty;
    const selected: string[] = []; let remaining = maximum - 55;
    for (const value of values) {
      if (selected.length >= 4 || remaining < 70) break;
      const item = clip(value, Math.min(remaining - 2, 240), field); selected.push(`• ${item}`); remaining -= escapeMrkdwn(item).length + 3;
    }
    if (selected.length < values.length) { const note = `${values.length - selected.length} ${field.toLowerCase()} omitted`; omissions.push(note); selected.push(`… ${note}.`); }
    return selected.join('\n');
  };
  const prUrl = `https://github.com/${packet.repository}/pull/${packet.prNumber}`;
  const links = [{ label: 'Pull request', url: prUrl }, { label: 'Current commit', url: `https://github.com/${packet.repository}/commit/${packet.headSha}` }, ...packet.evidenceLinks.slice(0, 2).map(link => ({ ...link, label: clip(link.label, 60, 'Link label') }))];
  if (packet.evidenceLinks.length > 2) omissions.push(`${packet.evidenceLinks.length - 2} evidence links omitted`);
  const sections = [
    { heading: superseded ? 'Superseded request' : outcomeTitles[packet.outcome], text: `${packet.repository} · PR #${packet.prNumber} · head ${packet.headSha}\n${superseded ? 'The PR or request changed. Do not act on this earlier decision.' : clip(packet.reason, 250, 'Reason')}` },
    { heading: 'Decision', text: superseded ? 'Open the pull request and use the latest decision packet.' : clip(packet.recommendedDecision, 320, 'Decision') },
    { heading: 'Findings', text: list(packet.findings, 400, 'Findings', 'No findings recorded.') },
    { heading: 'Attempted changes', text: list(packet.attemptedFixes, 280, 'Attempted changes', 'No changes attempted.') },
    { heading: 'Tests', text: list(packet.checks.map(check => `${check.name}: ${check.status.replace('_', ' ')}. ${check.evidence}`), 360, 'Tests', 'No test evidence recorded.') },
    { heading: 'Uncertainty', text: list(packet.uncertainty, 280, 'Uncertainty', 'No additional uncertainty recorded. A person checks GitHub before merging.') },
    { heading: 'Route', text: clip(route.explanation, 200, 'Route') },
  ];
  if (omissions.length) sections.push({ heading: 'Full evidence', text: 'Some content was shortened or omitted. The complete request is in the CLI inbox.' });
  const blocks = sections.map(section => ({ type: 'section' as const, text: { type: 'mrkdwn' as const, text: `*${section.heading}*\n${escapeMrkdwn(section.text)}`, verbatim: true as const } }));
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: links.map(link => `<${link.url}|${escapeMrkdwn(link.label)}>`).join(' · ') + (!superseded && route.mentions.length ? `\n${route.mentions.map(id => `<@${id}>`).join(' ')}` : ''), verbatim: true } });
  const text = sections.map(section => `${section.heading}\n${section.text}`).join('\n\n') + '\n\n' + links.map(link => `${link.label}: ${link.url}`).join('\n') + (!superseded && route.mentions.length ? `\nRecipients: ${route.mentions.join(', ')}` : '');
  return { schemaVersion: 1, route, message: { text: text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), blocks, mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false }, omissions: [...new Set(omissions)], sections, links, superseded };
}
