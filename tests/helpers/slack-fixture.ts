import type { DecisionPacket, SlackConfiguration } from '@repo-chap/slack';

export const slackConfig: SlackConfiguration = {
  workspaceId: 'TFOREST', users: { Willow: 'UWILLOW' }, channels: { team: 'CPAPERBOAT', private: 'GENGINEERS' }, defaultChannel: 'team',
  routes: { needs_author: 'author_dm', needs_team: 'team', ready_for_human_merge: 'private', blocked_execution: 'team' },
  mentions: { needs_team: ['UROWAN'] },
};
export const decisionPacket: DecisionPacket = {
  schemaVersion: 1, repository: 'reef-labs/paperboat', prNumber: 42, headSha: 'c'.repeat(40), authorLogin: 'willow', outcome: 'ready_for_human_merge',
  reason: 'The ownership check is pushed. Current tests pass and review has no blocking findings.',
  recommendedDecision: 'Inspect the authorization change and merge on GitHub if the evidence is sufficient.',
  findings: [], attemptedFixes: ['Added ownership validation and a regression test. Conditional push confirmed.'],
  checks: [{ name: 'ownership-check', status: 'passed', evidence: 'Required check passed on the current commit.' }, { name: 'typecheck', status: 'passed', evidence: 'Required check passed on the current commit.' }],
  uncertainty: ['Production authorization configuration was not verified.'],
  evidenceLinks: [{ label: 'Current review', url: 'https://github.com/reef-labs/paperboat/pull/42#pullrequestreview-123' }],
};
