import type { PacketOutcome, Workflow } from '@repo-chap/workflow';

export type { PacketOutcome };
export type SlackConfiguration = NonNullable<Workflow['slack']>;
export interface DecisionPacket {
  schemaVersion: 1;
  repository: string;
  prNumber: number;
  headSha: string;
  authorLogin: string | null;
  outcome: PacketOutcome;
  reason: string;
  recommendedDecision: string;
  findings: string[];
  attemptedFixes: string[];
  checks: { name: string; status: 'passed' | 'failed' | 'pending' | 'not_run'; evidence: string }[];
  uncertainty: string[];
  evidenceLinks: { label: string; url: string }[];
}
export type SlackDestination = { kind: 'channel'; channelId: string; name: string } | { kind: 'dm'; memberId: string; authorLogin: string };
export interface RoutePreview {
  workspaceId: string | null;
  destination: SlackDestination | null;
  fallback: boolean;
  explanation: string;
  mentions: string[];
}
export interface SlackMessage {
  text: string;
  blocks: { type: 'section'; text: { type: 'mrkdwn'; text: string; verbatim: true } }[];
  mrkdwn: false;
  parse: 'none';
  link_names: false;
  unfurl_links: false;
  unfurl_media: false;
}
export interface PacketPreview {
  schemaVersion: 1;
  route: RoutePreview;
  message: SlackMessage;
  omissions: string[];
  sections: { heading: string; text: string }[];
  links: { label: string; url: string }[];
  superseded: boolean;
}
export class SlackError extends Error {
  constructor(message: string) { super(message); this.name = 'SlackError'; }
}
