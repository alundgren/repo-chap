import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import schema from './workflow.schema.json' with { type: 'json' };
import { fail, normalizeId, record, WorkflowError } from './common.js';
import { actionRegistry, continuations, supportedCapabilities } from './registry.js';
import { factTypes, memoryFields, type Capability, type Condition, type Diagnostic, type Workflow } from './types.js';

export const limits = { fileBytes: 1024 * 1024, packageBytes: 8 * 1024 * 1024, files: 256, conditionDepth: 16, conditionNodes: 256, rules: 128, actions: 128, replaySteps: 256 } as const;
export function schemaValidator(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
  const addFormats = 'default' in addFormatsModule ? addFormatsModule.default : addFormatsModule;
  addFormats(ajv);
  return ajv;
}
const validateDocument = schemaValidator().compile(schema);
export function schemaDiagnostics(validate: ValidateFunction, path: string): Diagnostic[] {
  return (validate.errors ?? []).slice(0, 30).map(error => ({ code: 'schema', path: `${path}${error.instancePath}`, message: `${error.message ?? 'Invalid value'}${error.params.missingProperty ? `: ${error.params.missingProperty}` : ''}` }));
}

export function validateWorkflow(value: unknown, maximumCapabilities: readonly Capability[] = supportedCapabilities): Workflow {
  if (!record(value)) fail('schema', '/', 'Workflow must be a JSON object.');
  if (value.schemaVersion !== 1) fail('unsupported_schema', '/schemaVersion', 'Only workflow schemaVersion 1 is supported.');
  // Bound recursion before the recursive JSON Schema validator sees the input.
  let nodes = 0;
  const pending: [unknown, number][] = [[value.rules, 0]];
  while (pending.length) {
    const [item, depth] = pending.pop()!;
    if (depth > 40 || ++nodes > 12000) fail('size_limit', '/rules', 'Workflow conditions exceed the supported complexity.');
    if (item && typeof item === 'object') for (const child of Object.values(item)) pending.push([child, depth + 1]);
  }
  if (!validateDocument(value)) throw new WorkflowError(schemaDiagnostics(validateDocument, ''));
  const workflow = value as unknown as Workflow;
  const errors: Diagnostic[] = [];
  const error = (code: string, path: string, message: string) => errors.push({ code, path, message });
  if (workflow.rules.length > limits.rules || Object.keys(workflow.actions).length > limits.actions) error('size_limit', '/', 'At most 128 rules and 128 actions are supported.');
  const unique = (values: string[], path: string) => {
    const seen = new Set<string>();
    for (const id of values) {
      const normalized = normalizeId(id);
      if (!normalized || id.length > 128 || seen.has(normalized)) error('duplicate_id', path, `Empty, oversized, or normalized duplicate ID: ${id}`);
      seen.add(normalized);
    }
  };
  unique(workflow.rules.map(rule => rule.id), '/rules');
  unique(Object.keys(workflow.actions), '/actions');
  if (workflow.requestedCapabilities.some(c => (c as string) === 'pr.merge')) error('merge_forbidden', '/requestedCapabilities', 'Humans merge. pr.merge is not supported.');
  for (const capability of workflow.requestedCapabilities) if (!maximumCapabilities.includes(capability)) error('capability', '/requestedCapabilities', `Capability exceeds the operator maximum: ${capability}`);
  if (workflow.settings.reviewWaitSeconds > workflow.settings.reviewDeadlineSeconds) error('deadline', '/settings', 'reviewWaitSeconds must not exceed reviewDeadlineSeconds.');
  const hasAction = (id: string) => Object.hasOwn(workflow.actions, id);
  const target = (id: string, path: string, reserved: boolean) => {
    if (!hasAction(id) && !(reserved && continuations.has(id))) error('action_reference', path, `Unknown action or continuation: ${id}`);
  };
  let conditionNodes = 0;
  function checkCondition(condition: Condition, path: string, depth: number): void {
    if (++conditionNodes > limits.conditionNodes || depth > limits.conditionDepth) { error('condition_limit', path, 'Conditions allow at most 256 total nodes and depth 16.'); return; }
    if ('field' in condition) {
      const expected = condition.field === 'facts.lifecycle' ? 'string' : 'boolean';
      if (typeof condition.value !== expected) error('condition_type', path, `${condition.field} requires a ${expected} comparison value.`);
      if (condition.field === 'facts.lifecycle' && !['open', 'closed', 'merged'].includes(String(condition.value))) error('condition_type', path, 'Lifecycle must be open, closed, or merged.');
    } else if ('not' in condition) checkCondition(condition.not, `${path}/not`, depth + 1);
    else ('all' in condition ? condition.all : condition.any).forEach((c, i) => checkCondition(c, `${path}/${i}`, depth + 1));
  }
  workflow.rules.forEach((rule, i) => { target(rule.action, `/rules/${i}/action`, false); checkCondition(rule.when, `/rules/${i}/when`, 1); });
  target(workflow.otherwise, '/otherwise', false);
  for (const [id, action] of Object.entries(workflow.actions)) {
    const path = `/actions/${id}`;
    const definition = Object.hasOwn(actionRegistry, action.uses) ? actionRegistry[action.uses] : undefined;
    if (!definition) error('registry', `${path}/uses`, `Unsupported built-in action: ${action.uses}`);
    else {
      if (action.execution !== definition.execution) error('registry', `${path}/execution`, `${action.uses} requires execution ${definition.execution}.`);
      if (definition.capabilities.some(c => !action.capabilities.includes(c)) || action.capabilities.some(c => !definition.capabilities.includes(c))) error('capability', `${path}/capabilities`, `Required capabilities for ${action.uses}: ${definition.capabilities.join(', ') || 'none'}.`);
      if (definition.continuation && action.onSuccess !== definition.continuation) error('continuation', `${path}/onSuccess`, `${action.uses} must continue to ${definition.continuation}.`);
      if (definition.continuation && action.onFailure !== '$blocked') error('error_route', `${path}/onFailure`, 'Control-action failures must block.');
      if (action.uses === 'human.publish_packet' && action.onFailure !== '$blocked') error('error_route', `${path}/onFailure`, 'A failed handoff must block without another notification.');
    }
    for (const capability of action.capabilities) {
      if ((capability as string) === 'pr.merge') error('merge_forbidden', `${path}/capabilities`, 'Humans merge. pr.merge is not supported.');
      if (!workflow.requestedCapabilities.includes(capability)) error('capability', `${path}/capabilities`, `Capability was not requested: ${capability}`);
    }
    target(action.onSuccess, `${path}/onSuccess`, true); target(action.onFailure, `${path}/onFailure`, true);
    if (action.execution === 'agent' && (!action.prompt || !action.outputSchema)) error('agent_contract', path, 'Agent actions require prompt and outputSchema references.');
    if (action.execution === 'code' && (action.prompt || action.outputSchema || action.contextFiles)) error('code_contract', path, 'Code actions do not accept agent prompt, schema, or context references.');
  }
  const reachable = new Set<string>();
  function visit(id: string): void {
    if (!hasAction(id) || reachable.has(id)) return;
    reachable.add(id); const action = workflow.actions[id]!;
    visit(action.onSuccess); visit(action.onFailure);
  }
  workflow.rules.forEach(rule => visit(rule.action)); visit(workflow.otherwise);
  for (const id of Object.keys(workflow.actions)) if (!reachable.has(id)) error('unreachable_action', `/actions/${id}`, 'Action cannot be reached from any rule or fallback.');
  // Removing budget-consuming actions must leave an acyclic graph.
  const visiting = new Set<string>(), visited = new Set<string>();
  function checkCycle(id: string): void {
    const action = workflow.actions[id];
    if (!action || actionRegistry[action.uses]?.consumesAgentBudget || visited.has(id)) return;
    if (visiting.has(id)) { error('unbounded_cycle', `/actions/${id}`, 'Action cycle must consume an agent-action budget or reach a continuation.'); return; }
    visiting.add(id); checkCycle(action.onSuccess); checkCycle(action.onFailure); visiting.delete(id); visited.add(id);
  }
  Object.keys(workflow.actions).forEach(checkCycle);
  const checkedInputs = new Set<string>();
  function checkInputs(id: string, available: Set<string>): void {
    const action = workflow.actions[id];
    if (!action) return;
    const key = `${id}:${[...available].sort().join(',')}`;
    if (checkedInputs.has(key)) return;
    checkedInputs.add(key);
    const definition = Object.hasOwn(actionRegistry, action.uses) ? actionRegistry[action.uses] : undefined;
    if (definition?.requires && !available.has(definition.requires)) error('action_input', `/actions/${id}`, `${action.uses} requires a successful ${definition.requires} result on every incoming path.`);
    const retained = new Set(available);
    for (const kind of definition?.invalidates ?? []) retained.delete(kind);
    const success = new Set(retained);
    if (definition?.produces) success.add(definition.produces);
    checkInputs(action.onSuccess, success); checkInputs(action.onFailure, retained);
  }
  workflow.rules.forEach(rule => checkInputs(rule.action, new Set()));
  checkInputs(workflow.otherwise, new Set());
  if (workflow.slack) {
    unique(Object.keys(workflow.slack.users), '/slack/users');
    if (!Object.hasOwn(workflow.slack.channels, workflow.slack.defaultChannel)) error('slack_route', '/slack/defaultChannel', 'Default channel must name a configured channel.');
    for (const [outcome, route] of Object.entries(workflow.slack.routes)) if (route !== 'author_dm' && !Object.hasOwn(workflow.slack.channels, route)) error('slack_route', `/slack/routes/${outcome}`, 'Route must name a configured channel or author_dm.');
  }
  if (errors.length) throw new WorkflowError(errors);
  return workflow;
}
export const booleanFactFields = Object.keys(factTypes).filter(key => key !== 'lifecycle');
export { memoryFields };
