import { canonicalJson, parseJson, workflowReferences, referencePath } from '@repo-chap/workflow';
import type { Workflow } from '@repo-chap/workflow';
import type { SemanticChange, VisualEdit } from './protocol.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const summary = (value: unknown): string => value === undefined ? 'Absent' : typeof value === 'string' ? value : JSON.stringify(value);
const equal = (a: unknown, b: unknown): boolean => a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b);

/** Compare execution fields and referenced bytes; layout and JSON whitespace have no runtime meaning. */
export function semanticChanges(path: string, saved: Record<string, string>, current: Record<string, string>): SemanticChange[] {
  const before = parseJson(saved[path]!, path), after = parseJson(current[path]!, path);
  if (!object(before) || !object(after)) throw new Error('The workflow must be a JSON object to compare changes.');
  const changes: SemanticChange[] = [];
  const compare = (a: unknown, b: unknown, key: string): void => {
    if (equal(a, b)) return;
    if (object(a) && object(b)) {
      for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) compare(a[field], b[field], `${key}/${field}`);
    } else changes.push({ path: key, before: summary(a), after: summary(b) });
  };
  const withoutPresentation = (value: Record<string, unknown>): Record<string, unknown> => {
    const { layout: _layout, rules: _rules, ...rest } = value;
    return rest;
  };
  compare(withoutPresentation(before), withoutPresentation(after), '');
  if (Array.isArray(before.rules) && Array.isArray(after.rules) && [...before.rules, ...after.rules].every(rule => object(rule) && typeof rule.id === 'string')) {
    compare(before.rules.map(rule => rule.id), after.rules.map(rule => rule.id), '/rules/order');
    const ids = new Set([...before.rules, ...after.rules].map(rule => rule.id));
    for (const id of ids) compare(before.rules.find(rule => rule.id === id), after.rules.find(rule => rule.id === id), `/rules/${id}`);
  } else compare(before.rules, after.rules, '/rules');
  const refs = (value: Record<string, unknown>): string[] => {
    try { return workflowReferences(value as unknown as Workflow).map(ref => referencePath(path, ref).path); }
    catch { return []; }
  };
  const oldRefs = new Set(refs(before)), newRefs = new Set(refs(after));
  for (const file of new Set([...oldRefs, ...newRefs])) {
    const a = oldRefs.has(file) ? saved[file] : undefined, b = newRefs.has(file) ? current[file] : undefined;
    if (a !== b) changes.push({ path: file, before: a === undefined ? 'Not referenced or unavailable' : 'Saved referenced text', after: b === undefined ? 'Not referenced or unavailable' : a === undefined ? 'Referenced text added' : 'Referenced text changed' });
  }
  return changes;
}

export function editWorkflow(text: string, path: string, edit: VisualEdit): string {
  const value = parseJson(text, path);
  if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.rules) || !object(value.actions)) throw new Error('Repair the workflow source before using visual controls.');
  if (edit.kind === 'moveRule') {
    const index = value.rules.findIndex(rule => object(rule) && rule.id === edit.ruleId);
    if (index < 0 || !Number.isInteger(edit.toIndex) || edit.toIndex < 0 || edit.toIndex >= value.rules.length) throw new Error('Choose an existing rule and position.');
    const [rule] = value.rules.splice(index, 1);
    value.rules.splice(edit.toIndex, 0, rule);
  } else if (edit.kind === 'action' || edit.kind === 'context') {
    const action = Object.hasOwn(value.actions, edit.actionId) ? value.actions[edit.actionId] : null;
    if (!object(action)) throw new Error('Choose an existing action.');
    if (edit.kind === 'context') {
      if (!Array.isArray(edit.value) || edit.value.some(ref => typeof ref !== 'string')) throw new Error('Context references must be text paths.');
      action.contextFiles = edit.value;
    } else {
      if (!['onSuccess', 'onFailure', 'prompt'].includes(edit.field) || typeof edit.value !== 'string') throw new Error('Choose a supported action field.');
      action[edit.field] = edit.value;
    }
  } else if (edit.kind === 'setting') {
    if (!object(value.settings) || !['newPrDelaySeconds', 'headDebounceSeconds', 'reviewWaitSeconds', 'reviewDeadlineSeconds'].includes(edit.field) || !Number.isFinite(edit.value)) throw new Error('Choose a timing setting and a finite number of seconds.');
    value.settings[edit.field] = edit.value;
  } else throw new Error('Choose a supported visual edit.');
  return `${JSON.stringify(value, null, 2)}\n`;
}
