import { SlackError, type PacketOutcome, type RoutePreview, type SlackConfiguration } from './types.js';

export const normalizeLogin = (login: string): string => login.trim().toLowerCase();
export function memberMappings(users: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = Object.create(null);
  for (const [login, member] of Object.entries(users)) {
    const key = normalizeLogin(login);
    if (!/^[a-z0-9][a-z0-9-]*(\[bot\])?$/.test(key) || !/^U[A-Z0-9]+$/.test(member)) throw new SlackError('Use GitHub logins and stable Slack member IDs in user mappings.');
    if (normalized[key] && normalized[key] !== member) throw new SlackError(`Conflicting Slack member mappings for ${key}.`);
    normalized[key] = member;
  }
  return normalized;
}
export function previewRoute(config: SlackConfiguration | undefined, outcome: PacketOutcome, authorLogin: string | null): RoutePreview {
  if (!config) return { workspaceId: null, destination: null, fallback: false, mentions: [], explanation: 'Slack is not configured. The complete request stays in the CLI inbox.' };
  const users = memberMappings(config.users), mentions = [...new Set(config.mentions?.[outcome] ?? [])];
  if (!/^T[A-Z0-9]+$/.test(config.workspaceId) || mentions.length > 10 || mentions.some(member => !/^U[A-Z0-9]{1,30}$/.test(member))) throw new SlackError('Slack workspace and mentions require stable IDs.');
  const result = { workspaceId: config.workspaceId, fallback: false, mentions };
  const member = authorLogin && users[normalizeLogin(authorLogin)];
  if (outcome === 'needs_author' && member) return { ...result, destination: { kind: 'dm', memberId: member, authorLogin: normalizeLogin(authorLogin!) }, explanation: `Author DM for ${normalizeLogin(authorLogin!)} using member ${member}. The conversation is resolved only on delivery.` };
  const fallback = outcome === 'needs_author', route = fallback ? config.defaultChannel : config.routes[outcome], channel = config.channels[route];
  const labels = { needs_author: 'Author requests', needs_team: 'Team requests', ready_for_human_merge: 'Merge handoffs', blocked_execution: 'Blocked requests' };
  const explanation = fallback ? `No Slack member mapping for ${authorLogin ? normalizeLogin(authorLogin) : 'the unknown author'}. Use default channel ${config.defaultChannel}.` : `${labels[outcome]} go to ${route}.`;
  if (!channel || !/^[CG][A-Z0-9]+$/.test(channel)) return { ...result, fallback, destination: null, explanation: `${explanation} No usable channel destination. The complete request stays in the CLI inbox.` };
  return { ...result, fallback, destination: { kind: 'channel', channelId: channel, name: route }, explanation };
}
