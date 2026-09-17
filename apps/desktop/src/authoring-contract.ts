import type { AuthoringOperation } from './authoring-protocol.js';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const keys = (value: Record<string, unknown>, names: string[]): boolean => Object.keys(value).every(key => names.includes(key)) && names.every(key => Object.hasOwn(value, key));
const fail = (): never => { throw new Error('Use a supported authoring operation with an operation ID, current document token and stable target paths or IDs.'); };

export function parseAuthoringOperation(value: unknown): AuthoringOperation {
  if (!object(value) || Buffer.byteLength(JSON.stringify(value)) > 32 * 1024 || !keys(value, ['operationId', 'expected', 'action']) || !text(value.operationId) || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value.operationId)) return fail();
  const token = value.expected, action = value.action;
  if (!object(token) || !keys(token, ['sessionId', 'revision']) || !text(token.sessionId) || token.sessionId.length > 128 || !Number.isSafeInteger(token.revision) || (token.revision as number) < 0 || !object(action)) return fail();
  if (action.kind === 'read') {
    if (!keys(action, ['kind', 'paths']) || !Array.isArray(action.paths) || action.paths.length > 16 || !action.paths.every(text)) return fail();
  } else if (action.kind === 'edit') {
    if (!keys(action, ['kind', 'changes']) || !Array.isArray(action.changes) || !action.changes.length || action.changes.length > 16 || !action.changes.every(change => object(change) && keys(change, ['path', 'text']) && text(change.path) && text(change.text))) return fail();
  } else if (action.kind === 'createFixture') {
    if (!keys(action, ['kind', 'path', 'text']) || !text(action.path) || !text(action.text)) return fail();
  } else if (action.kind === 'test') {
    if (!keys(action, ['kind', 'fixturePath']) || !text(action.fixturePath)) return fail();
  } else if (action.kind === 'validate') {
    if (!keys(action, ['kind'])) return fail();
  } else if (action.kind === 'visual') {
    const edit = action.edit;
    if (!keys(action, ['kind', 'edit']) || !object(edit)) return fail();
    if (edit.kind === 'moveRule') {
      if (!keys(edit, ['kind', 'ruleId', 'toIndex']) || !text(edit.ruleId) || !Number.isSafeInteger(edit.toIndex)) return fail();
    } else if (edit.kind === 'ruleAction') {
      if (!keys(edit, ['kind', 'ruleId', 'actionId']) || !text(edit.ruleId) || !text(edit.actionId)) return fail();
    } else if (edit.kind === 'action') {
      if (!keys(edit, ['kind', 'actionId', 'field', 'value']) || !text(edit.actionId) || !['onSuccess', 'onFailure', 'prompt'].includes(String(edit.field)) || !text(edit.value)) return fail();
    } else if (edit.kind === 'context') {
      if (!keys(edit, ['kind', 'actionId', 'value']) || !text(edit.actionId) || !Array.isArray(edit.value) || !edit.value.every(text)) return fail();
    } else if (edit.kind === 'setting') {
      if (!keys(edit, ['kind', 'field', 'value']) || !['newPrDelaySeconds', 'headDebounceSeconds', 'reviewWaitSeconds', 'reviewDeadlineSeconds'].includes(String(edit.field)) || typeof edit.value !== 'number' || !Number.isFinite(edit.value)) return fail();
    } else return fail();
  } else return fail();
  return structuredClone(value) as unknown as AuthoringOperation;
}

const string = { type: 'string' };
const objectSchema = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const choice = (kind: string, properties: Record<string, unknown> = {}) => objectSchema({ kind: { const: kind }, ...properties });
export const authoringInputSchema = objectSchema({
  operationId: { type: 'string', pattern: '^[a-zA-Z0-9_.:-]{1,128}$' },
  expected: objectSchema({ sessionId: string, revision: { type: 'integer', minimum: 0 } }),
  action: { oneOf: [
    choice('read', { paths: { type: 'array', maxItems: 16, items: string } }),
    choice('edit', { changes: { type: 'array', minItems: 1, maxItems: 16, items: objectSchema({ path: string, text: string }) } }),
    choice('createFixture', { path: string, text: string }), choice('validate'), choice('test', { fixturePath: string }),
    choice('visual', { edit: { oneOf: [
      choice('moveRule', { ruleId: string, toIndex: { type: 'integer', minimum: 0 } }),
      choice('ruleAction', { ruleId: string, actionId: string }),
      choice('action', { actionId: string, field: { enum: ['onSuccess', 'onFailure', 'prompt'] }, value: string }),
      choice('context', { actionId: string, value: { type: 'array', items: string } }),
      choice('setting', { field: { enum: ['newPrDelaySeconds', 'headDebounceSeconds', 'reviewWaitSeconds', 'reviewDeadlineSeconds'] }, value: { type: 'number' } }),
    ] } }),
  ] },
});
