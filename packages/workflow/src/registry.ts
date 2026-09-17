import { freeze } from './common.js';
import type { Capability } from './types.js';

type ActionInput = 'candidate' | 'checks' | 'push' | 'classification' | 'review';
export interface ActionDefinition {
  execution: 'code' | 'agent'; capabilities: readonly Capability[];
  consumesAgentBudget?: true; repair?: true; requires?: ActionInput;
  result?: 'candidate' | 'classification' | 'review';
  invalidates?: readonly ActionInput[];
  produces?: ActionInput; continuation?: '$wait' | '$closed';
}
export const actionRegistry: Readonly<Record<string, ActionDefinition>> = freeze({
  'control.close': { execution: 'code', capabilities: [], continuation: '$closed' },
  'control.wait_signal': { execution: 'code', capabilities: [], continuation: '$wait' },
  'control.wait_refresh': { execution: 'code', capabilities: [], continuation: '$wait' },
  'control.wait_debounce': { execution: 'code', capabilities: [], continuation: '$wait' },
  'control.wait_reviewer': { execution: 'code', capabilities: [], continuation: '$wait' },
  'agent.resolve_conflict': { execution: 'agent', capabilities: ['workspace.read', 'workspace.write'], consumesAgentBudget: true, repair: true, result: 'candidate', invalidates: ['candidate', 'checks', 'push', 'review', 'classification'], produces: 'candidate' },
  'agent.address_review': { execution: 'agent', capabilities: ['workspace.read', 'workspace.write'], consumesAgentBudget: true, repair: true, result: 'candidate', invalidates: ['candidate', 'checks', 'push', 'review', 'classification'], produces: 'candidate' },
  'agent.classify': { execution: 'agent', capabilities: ['workspace.read'], consumesAgentBudget: true, result: 'classification', invalidates: ['classification'], produces: 'classification' },
  'agent.review': { execution: 'agent', capabilities: ['workspace.read'], consumesAgentBudget: true, result: 'review', invalidates: ['review'], produces: 'review' },
  'checks.validate_candidate': { execution: 'code', capabilities: ['checks.run'], requires: 'candidate', invalidates: ['checks', 'push'], produces: 'checks' },
  'github.push_candidate': { execution: 'code', capabilities: ['pr.push'], requires: 'checks', invalidates: ['push'], produces: 'push' },
  'github.resolve_eligible_threads': { execution: 'code', capabilities: ['review.resolve'], requires: 'push' },
  'github.publish_review': { execution: 'code', capabilities: ['review.publish'], requires: 'review' },
  'github.set_labels': { execution: 'code', capabilities: ['labels.set'], requires: 'classification' },
  'human.publish_packet': { execution: 'code', capabilities: ['notify.send'] },
});
export const supportedCapabilities: readonly Capability[] = freeze(['workspace.read', 'workspace.write', 'checks.run', 'pr.push', 'review.resolve', 'labels.set', 'review.publish', 'notify.send']);
export const continuations = new Set(['$observe', '$wait', '$closed', '$blocked']);
