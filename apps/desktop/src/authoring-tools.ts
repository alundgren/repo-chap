import { randomUUID } from 'node:crypto';
import type { ConversationTool } from '@repo-chap/providers';
import type { DocumentSession } from './documents.js';
import { authoringInputSchema, parseAuthoringOperation } from './authoring-contract.ts';
import type { AuthoringOperation, AuthoringResponse } from './authoring-protocol.js';
import type { DocumentToken } from './protocol.js';

interface Pending {
  source: DocumentSession;
  operation: AuthoringOperation;
  signal: AbortSignal;
  execution?: Promise<AuthoringResponse>;
  result?: AuthoringResponse;
  finish(result: AuthoringResponse): void;
}

/** Main requests renderer input capture. Only the captured request can enter the document queue. */
export class AuthoringTools {
  private pending = new Map<string, Pending>();
  private current: () => DocumentSession | null;
  private requestCapture: (id: string) => void;
  constructor(current: () => DocumentSession | null, requestCapture: (id: string) => void) { this.current = current; this.requestCapture = requestCapture; }

  tools(source: DocumentSession): ConversationTool[] {
    return [{
      name: 'author', inputSchema: authoringInputSchema,
      description: 'Read loaded documents, stage source/Markdown/fixture edits, validate, or run an offline fixture test. Use the current context token and a unique operationId. Duplicate IDs return the existing receipt. read with paths [] returns current file IDs. Stale or pending-human-input rejection requires fresh context. createFixture requires explicit expected status, selectedRuleIds and proposedEffects in version-1 fixture JSON. Edits stay unsaved and undoable. No save, shell, live trial, network, publication or daemon operation exists.',
      execute: async (args, { signal }) => {
        try {
          const operation = parseAuthoringOperation(args);
          if (source !== this.current()) throw new Error('The workflow was closed. This tool cannot edit another document session.');
          const result = source.authoringReceipt(operation.operationId) ?? await this.capture(source, operation, signal);
          return { text: JSON.stringify(result), isError: ['rejected', 'cancelled'].includes(result.receipt.status) };
        } catch (error) { return { text: JSON.stringify({ error: error instanceof Error ? error.message : 'Authoring failed.' }), isError: true }; }
      },
    }];
  }

  private capture(source: DocumentSession, operation: AuthoringOperation, signal: AbortSignal): Promise<AuthoringResponse> {
    const duplicate = [...this.pending.values()].find(item => item.source === source && item.operation.operationId === operation.operationId);
    if (duplicate) return Promise.resolve(this.rejected(source, operation, 'This operation is already pending. Read its existing receipt after it finishes.'));
    return new Promise(resolve => {
      const id = randomUUID();
      let timer: NodeJS.Timeout;
      const finish = (result: AuthoringResponse): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); this.pending.delete(id); resolve(result); };
      const pending: Pending = { source, operation, signal, finish };
      const abort = (): void => {
        if (pending.execution) return;
        const result = this.rejected(source, operation, 'Cancelled before capture. Earlier applied edits remain in the draft.');
        result.receipt.status = 'cancelled'; finish(result);
      };
      this.pending.set(id, pending);
      timer = setTimeout(() => {
        if (pending.execution) return;
        finish(this.rejected(source, operation, 'The editor could not capture current input. No operation was applied. Correct pending fields and try again.'));
      }, 5000);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else this.requestCapture(id);
    });
  }

  async apply(id: string, captured: DocumentToken): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending || pending.source !== this.current()) throw new Error('This authoring request is no longer pending.');
    try {
      pending.source.assertCurrent(captured);
      pending.execution ??= pending.source.author(pending.operation, pending.signal);
      pending.result = await pending.execution;
    } catch (error) {
      // A recorded mutation remains authoritative even if a later step throws.
      pending.finish(pending.source.authoringReceipt(pending.operation.operationId) ?? this.rejected(pending.source, pending.operation, error instanceof Error ? error.message : 'Authoring failed.'));
      throw error;
    }
    // Mutation receipts are already recorded. Losing the display acknowledgment never reverses them.
    const result = pending.result;
    setTimeout(() => { if (this.pending.get(id) === pending) pending.finish(pending.source.authoringReceipt(result.receipt.operationId) ?? result); }, 1500);
  }

  confirm(id: string): void {
    const pending = this.pending.get(id);
    if (!pending?.result) return;
    pending.source.confirmDisplay(pending.result.receipt.operationId);
    pending.finish(pending.source.authoringReceipt(pending.result.receipt.operationId)!);
  }

  reject(id: string, input: { field: string; value: string }[]): void {
    const pending = this.pending.get(id);
    if (!pending || pending.execution) return;
    const result = this.rejected(pending.source, pending.operation, 'Current human input could not be captured. Correct or discard it before authoring; no requested edit was applied.');
    result.context.pendingHumanInput = Array.isArray(input) ? input.slice(0, 16).filter(item => typeof item?.field === 'string' && typeof item.value === 'string').map(item => ({ field: item.field.slice(0, 128), value: item.value.slice(0, 1024) })) : [];
    pending.finish(result);
  }

  private rejected(source: DocumentSession, operation: AuthoringOperation, message: string): AuthoringResponse {
    const context = source.authoringContext();
    return { context, receipt: { operationId: operation.operationId, kind: operation.action.kind, before: operation.expected, after: context.token, status: 'rejected', changedPaths: [], message, display: 'not-needed' } };
  }
}
