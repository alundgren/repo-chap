import { posix } from 'node:path';
import builtinSchemas from './builtin-results.schema.json' with { type: 'json' };
import { actionRegistry } from './registry.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { canonicalJson, digest, fail, freeze, parseJson, record, WorkflowError } from './common.js';
import { limits, schemaDiagnostics, schemaValidator, validateWorkflow } from './validate.js';
import type { Capability, PinnedFile, Workflow, WorkflowPackage } from './types.js';

export function referencePath(workflowPath: string, reference: string): { path: string; fragment: string } {
  const [filename, fragment = '', ...rest] = reference.split('#');
  if (!filename || rest.length || filename.includes('\\') || filename.includes('\0') || filename.startsWith('/') || /^[a-z]+:/i.test(filename)) fail('invalid_path', reference, 'Use a relative repository file path.');
  const path = posix.normalize(posix.join(posix.dirname(workflowPath), filename));
  if (path === '..' || path.startsWith('../')) fail('outside_repository', reference, 'Reference leaves the repository root.');
  if (fragment && !fragment.startsWith('/')) fail('schema_reference', reference, 'Use a JSON Pointer fragment beginning with /.');
  return { path, fragment };
}
export function workflowReferences(workflow: Workflow): string[] {
  return Object.values(workflow.actions).flatMap(action => [action.prompt, action.outputSchema, ...action.contextFiles ?? []].filter((v): v is string => v !== undefined));
}
function contractValidator(pkg: WorkflowPackage, actionId: string): ValidateFunction {
  const reference = pkg.workflow.actions[actionId]?.outputSchema;
  if (!reference) fail('agent_contract', actionId, 'Action does not have an output contract.');
  const { path, fragment } = referencePath(pkg.workflowPath, reference);
  const file = pkg.files.find(f => f.path === path);
  if (!file) fail('missing_file', path, 'Output contract is missing from the pinned package.');
  const document = parseJson(file.text, path);
  if (!record(document) || document.$schema !== 'https://json-schema.org/draft/2020-12/schema') fail('unsupported_schema', path, 'Output contracts require JSON Schema draft 2020-12.');
  const pending: unknown[] = [document];
  let count = 0;
  while (pending.length) {
    const item = pending.pop();
    if (++count > 20000) fail('size_limit', path, 'Output contract is too complex.');
    if (!item || typeof item !== 'object') continue;
    for (const [key, child] of Object.entries(item)) {
      if ((key === '$ref' || key === '$dynamicRef') && (typeof child !== 'string' || !child.startsWith('#'))) fail('schema_reference', path, 'Output contracts support only references within their own file.');
      pending.push(child);
    }
  }
  let selected: unknown = document;
  try {
    for (const raw of fragment.split('/').slice(1)) {
      const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
      if (!record(selected) || !Object.hasOwn(selected, key)) fail('schema_reference', reference, 'Output contract fragment does not exist.');
      selected = selected[key];
    }
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    fail('schema_reference', reference, 'Invalid JSON Pointer encoding.');
  }
  if (typeof selected !== 'boolean' && !record(selected)) fail('schema_reference', reference, 'Output contract fragment must select a schema.');
  try {
    const ajv = schemaValidator();
    const key = 'urn:repo-chap:output-contract';
    ajv.addSchema(document, key);
    const validate = ajv.getSchema(`${key}${fragment ? `#${fragment}` : ''}`);
    if (!validate) fail('schema_reference', reference, 'Output contract fragment could not be resolved.');
    return validate;
  }
  catch (error) { return fail('invalid_schema', reference, `Invalid output contract: ${error instanceof Error ? error.message : String(error)}`); }
}
const builtinValidator = schemaValidator().addSchema(builtinSchemas);
export function validateActionPayload(pkg: WorkflowPackage, actionId: string, payload: unknown): void {
  const action = pkg.workflow.actions[actionId];
  const requiredResult = action && actionRegistry[action.uses]?.result;
  if (requiredResult) {
    const required = builtinValidator.getSchema(`${builtinSchemas.$id}#/$defs/${requiredResult}`)!;
    if (!required(payload)) throw new WorkflowError(schemaDiagnostics(required, `/results/${actionId}/payload`));
  }
  const validate = contractValidator(pkg, actionId);
  if (!validate(payload)) throw new WorkflowError(schemaDiagnostics(validate, `/results/${actionId}/payload`));
}

export function buildPackage(workflowPath: string, sourceFiles: Readonly<Record<string, string>>, options: { maximumCapabilities?: readonly Capability[] } = {}): WorkflowPackage {
  const normalized = referencePath('workflow.json', workflowPath);
  if (normalized.fragment) fail('invalid_path', workflowPath, 'Workflow path cannot contain a fragment.');
  workflowPath = normalized.path;
  const workflowText = sourceFiles[workflowPath];
  if (typeof workflowText !== 'string') fail('missing_file', workflowPath, 'Workflow file is missing.');
  if (Buffer.byteLength(workflowText) > limits.fileBytes) fail('size_limit', workflowPath, 'File exceeds 1 MiB.');
  const workflow = validateWorkflow(parseJson(workflowText, workflowPath), options.maximumCapabilities);
  const references = workflowReferences(workflow);
  for (const action of Object.values(workflow.actions)) for (const ref of [action.prompt, ...action.contextFiles ?? []]) if (ref?.includes('#')) fail('invalid_path', ref, 'Markdown references cannot contain fragments.');
  const paths = [...new Set([workflowPath, ...references.map(ref => referencePath(workflowPath, ref).path)])].sort();
  if (paths.length > limits.files) fail('size_limit', workflowPath, 'Package exceeds 256 files.');
  let total = 0;
  const files: PinnedFile[] = paths.map(path => {
    const text = sourceFiles[path];
    if (typeof text !== 'string') fail('missing_file', path, 'Referenced file is missing.');
    const bytes = Buffer.byteLength(text); total += bytes;
    if (bytes > limits.fileBytes) fail('size_limit', path, 'File exceeds 1 MiB.');
    return { path, text, digest: digest(text) };
  });
  if (total > limits.packageBytes) fail('size_limit', workflowPath, 'Package exceeds 8 MiB.');
  const { layout: _layout, ...execution } = workflow;
  const packageDigest = digest(canonicalJson({ schemaVersion: 1, workflowPath, workflow: execution, files: files.filter(f => f.path !== workflowPath).map(f => ({ path: f.path, text: f.text })) }));
  const pkg = { schemaVersion: 1 as const, workflowPath, workflow, files, digest: packageDigest };
  for (const [id, action] of Object.entries(workflow.actions)) if (action.outputSchema) contractValidator(pkg, id);
  return freeze(pkg);
}
