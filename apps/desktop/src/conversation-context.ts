import { conversationLimits } from '@repo-chap/providers';
import type { CapturedConversationContext, ConversationContextSelection } from './conversation-protocol.js';
import type { DocumentSnapshot } from './protocol.js';

/** Called only after the renderer captures pending input and main checks its document token. */
export function captureConversationContext(snapshot: DocumentSnapshot, selection: ConversationContextSelection): CapturedConversationContext {
  if (!selection || !Array.isArray(selection.markdownPaths) || selection.markdownPaths.length > snapshot.files.length || new Set(selection.markdownPaths).size !== selection.markdownPaths.length || typeof selection.includeSimulation !== 'boolean' || selection.ruleId !== null && typeof selection.ruleId !== 'string') throw new Error('Choose the rule, referenced Markdown and simulation context for this question.');
  const workflow = snapshot.files.find(file => file.path === snapshot.workflowPath);
  if (!workflow) throw new Error('The open workflow source is unavailable.');
  const selectedRule = selection.ruleId === null ? null : snapshot.workflow?.rules.find(rule => rule.id === selection.ruleId);
  if (selection.ruleId !== null && !selectedRule) throw new Error('That rule is no longer available. Choose a current rule or the whole workflow.');
  const markdown = selection.markdownPaths.map(path => {
    if (typeof path !== 'string' || !/\.(md|markdown)$/i.test(path)) throw new Error('Choose explicitly loaded Markdown references.');
    const file = snapshot.files.find(file => file.path === path);
    if (!file || file.error) throw new Error('A selected Markdown reference cannot be read. Reload it or remove it from the question context.');
    return file;
  });
  const simulation = !selection.includeSimulation ? { status: 'excluded' } : !snapshot.simulation ? { status: 'none', note: 'No simulation has completed in this document session.' } : {
    status: snapshot.simulationCurrent ? 'current' : 'stale',
    note: 'Retained offline simulation. Its tested token identifies the run; conversation does not run it again. Proposed effects and previews do not prove remote effects.',
    record: snapshot.simulation,
  };
  const text = JSON.stringify({
    schemaVersion: 1,
    document: { token: { sessionId: snapshot.sessionId, revision: snapshot.revision }, packageDigest: snapshot.packageDigest, readOnlyReason: snapshot.readOnlyReason, diagnostics: snapshot.diagnostics },
    workflow, selectedRule, markdown, simulation,
  });
  if (Buffer.byteLength(text) > conversationLimits.contextBytes) throw new Error('The selected workflow context exceeds 256 KiB. Remove Markdown or simulation context, or reduce the source before sending.');
  return {
    text, document: { sessionId: snapshot.sessionId, revision: snapshot.revision },
    provenance: [
      `Document revision ${snapshot.revision}`, snapshot.packageDigest ? 'Valid workflow' : 'Workflow needs repair',
      selectedRule ? `Rule ${selectedRule.id}` : 'Whole workflow', `${markdown.length} Markdown reference(s)`,
      !selection.includeSimulation ? 'Simulation excluded' : snapshot.simulation ? `${snapshot.simulationCurrent ? 'Current' : 'Stale'} simulation, tested revision ${snapshot.simulation.token.revision}` : 'No completed simulation',
    ].join(' · '),
  };
}
