import { freeze } from './common.js';
import type { Capability } from './types.js';

export interface ActionDefinition {
  execution: 'code' | 'agent'; capabilities: readonly Capability[];
  consumesAgentBudget?: true; repair?: true; requires?: 'candidate' | 'checks' | 'push';
  produces?: 'candidate' | 'checks' | 'push'; continuation?: '$wait' | '$closed';
}
export const actionRegistry: Readonly<Record<string, ActionDefinition>> = freeze({
  'control.close': { execution: 'code', capabilities: [], continuation: '$closed' },
  'control.wait_signal': { execution: 'code', capabilities: [], continuation: '$wait' },
  'control.wait_refresh': { execution: 'code', capabilities: [], continuation: '$wait' },
  'control.wait_debounce': { execution: 'code', capabilities: [], continuation: '$wait' },
  'control.wait_reviewer': { execution: 'code', capabilities: [], continuation: '$wait' },
  'agent.resolve_conflict': { execution: 'agent', capabilities: ['workspace.read', 'workspace.write'], consumesAgentBudget: true, repair: true, produces: 'candidate' },
  'agent.address_review': { execution: 'agent', capabilities: ['workspace.read', 'workspace.write'], consumesAgentBudget: true, repair: true, produces: 'candidate' },
  'agent.classify': { execution: 'agent', capabilities: ['workspace.read'], consumesAgentBudget: true },
  'agent.review': { execution: 'agent', capabilities: ['workspace.read'], consumesAgentBudget: true },
  'checks.validate_candidate': { execution: 'code', capabilities: ['checks.run'], requires: 'candidate', produces: 'checks' },
  'github.push_candidate': { execution: 'code', capabilities: ['pr.push'], requires: 'checks', produces: 'push' },
  'github.resolve_eligible_threads': { execution: 'code', capabilities: ['review.resolve'], requires: 'push' },
  'human.publish_packet': { execution: 'code', capabilities: ['notify.send'] },
});
export const supportedCapabilities: readonly Capability[] = freeze(['workspace.read', 'workspace.write', 'checks.run', 'pr.push', 'review.resolve', 'labels.set', 'review.publish', 'notify.send']);
export const continuations = new Set(['$observe', '$wait', '$closed', '$blocked']);
