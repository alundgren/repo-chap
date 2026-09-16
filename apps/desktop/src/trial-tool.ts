import { randomUUID } from 'node:crypto';
import type { ConversationTool } from '@repo-chap/providers';
import type { AuthoringResponse } from './authoring-protocol.js';
import type { DocumentToken } from './protocol.js';
import type { TrialProposal } from './trial-protocol.js';

interface ProposalInput { repository: string; pr: number; profile: string; sourceId?: string; expected?: DocumentToken }

/** Preparing a proposal uses the same human-input capture as the read-only author operation. */
export function prepareLiveTrialTool(document: DocumentToken, author: ConversationTool, prepare: (token: DocumentToken, input: ProposalInput, signal: AbortSignal) => Promise<TrialProposal>): ConversationTool {
  return {
    name: 'prepare_live_trial',
    description: 'Prepare an unstarted read-only trial proposal for the current unsaved workflow. Choose an available profile and source ID from trialSetup. Omitted sourceId means workspace; omitted expected means the token captured when this turn started. After authoring changes, pass the latest author context token. Pending human input is captured first; stale, cancelled or rejected capture never prepares a proposal. This consumes one host read receipt, subject to the 128-receipt session limit. Only the person can Start in Live trial. No GitHub read, model analysis, repair, effect, export or send occurs here.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['repository', 'pr', 'profile'], properties: {
      repository: { type: 'string' }, pr: { type: 'integer', minimum: 1 }, profile: { type: 'string' }, sourceId: { type: 'string' },
      expected: { type: 'object', additionalProperties: false, required: ['sessionId', 'revision'], properties: { sessionId: { type: 'string' }, revision: { type: 'integer', minimum: 0 } } },
    } },
    execute: async (value, operation) => {
      try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provide a repository, PR number and loaded profile.');
        const input = value as ProposalInput;
        if (Object.keys(input).some(key => !['repository', 'pr', 'profile', 'sourceId', 'expected'].includes(key)) || typeof input.repository !== 'string' || !Number.isSafeInteger(input.pr) || typeof input.profile !== 'string' || input.sourceId !== undefined && typeof input.sourceId !== 'string') throw new Error('Use only repository, pr, profile, sourceId and an optional current expected token.');
        const captured = await author.execute({ operationId: `trial-read-${randomUUID()}`, expected: input.expected ?? document, action: { kind: 'read', paths: [] } }, operation);
        const result = JSON.parse(captured.text) as AuthoringResponse;
        if (captured.isError || result.receipt?.status !== 'completed') return { text: JSON.stringify({ prepared: false, started: false, ...result }), isError: true };
        if (operation.signal.aborted) throw new Error('Cancelled before proposal preparation.');
        const proposal = await prepare(result.context.token, input, operation.signal);
        return { text: JSON.stringify({ prepared: true, started: false, proposal, context: result.context }) };
      } catch (error) { return { text: JSON.stringify({ prepared: false, started: false, error: error instanceof Error ? error.message : 'Proposal preparation failed.' }), isError: true }; }
    },
  };
}
