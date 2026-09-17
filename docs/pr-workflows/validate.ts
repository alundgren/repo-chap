import assert from 'node:assert/strict';
import { readFileSync, readdirSync, realpathSync, statSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { parse, type DefaultTreeAdapterMap } from 'parse5';

const root = dirname(fileURLToPath(import.meta.url));
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

// These are proposal examples, checked against their own documented schemas.
interface ExampleWorkflow {
  actions: Record<string, {
    capabilities: string[];
    onSuccess: string;
    onFailure: string;
    prompt?: string;
    outputSchema?: string;
    contextFiles?: string[];
    execution: string;
  }>;
  rules: { id: string; action: string }[];
  otherwise: string;
  requestedCapabilities: string[];
  settings: { reviewWaitSeconds: number; reviewDeadlineSeconds: number };
}

function localReference(reference: string): void {
  const [filename, fragment] = reference.split('#');
  const target = realpathSync(resolve(root, 'examples/team-pr', filename!));
  const path = relative(root, target);
  assert(path !== '..' && !path.startsWith('../') && !isAbsolute(path) && statSync(target).isFile(),
    `Invalid local reference: ${reference}`);
  if (fragment) {
    let value = readJson(target);
    for (const segment of fragment.replace(/^\//, '').split('/')) {
      const key = decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~');
      assert(value !== null && typeof value === 'object' && Object.hasOwn(value, key),
        `Missing schema fragment: ${reference}`);
      value = value[key];
    }
  }
}

function checkMarkdown(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) checkMarkdown(path);
    else if (entry.name.endsWith('.md')) {
      for (const match of readFileSync(path, 'utf8').matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1]!;
        if (target.includes('://') || target.startsWith('#')) continue;
        assert(existsSync(resolve(directory, target.split('#')[0]!)),
          `Broken local link in ${entry.name}: ${target}`);
      }
    }
  }
}

function main(): void {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const addFormats = 'default' in addFormatsModule ? addFormatsModule.default : addFormatsModule;
  addFormats(ajv);
  const workflowSchema = readJson(join(root, 'schemas/workflow.schema.json'));
  const resultSchema = readJson(join(root, 'schemas/results.schema.json'));
  assert(ajv.validateSchema(workflowSchema), ajv.errorsText());
  assert(ajv.validateSchema(resultSchema), ajv.errorsText());
  const workflow: ExampleWorkflow = readJson(join(root, 'examples/team-pr/workflow.json'));
  assert(ajv.validate(workflowSchema, workflow), `Workflow example: ${ajv.errorsText()}`);
  ajv.addSchema(resultSchema);
  const examples = {
    review: 'review', classification: 'classification', candidate: 'candidate',
    'blocked-repair': 'candidate', 'decision-packet': 'decisionPacket', state: 'controlState',
  };
  for (const [name, definition] of Object.entries(examples)) {
    const value = readJson(join(root, `examples/results/${name}.json`));
    assert(ajv.validate(`${resultSchema.$id}#/$defs/${definition}`, value),
      `${name} example: ${ajv.errorsText()}`);
    for (const finding of value.findings ?? []) {
      for (const evidence of finding.evidence) {
        assert(evidence.startLine <= evidence.endLine, 'Reversed source location');
      }
    }
  }
  const actionIds = new Set(Object.keys(workflow.actions));
  const continuations = new Set([...actionIds, '$observe', '$wait', '$closed', '$blocked']);
  assert(new Set(workflow.rules.map(rule => rule.id)).size === workflow.rules.length, 'Duplicate rule ID');
  for (const rule of workflow.rules) assert(actionIds.has(rule.action), `Unknown rule action: ${rule.action}`);
  assert(actionIds.has(workflow.otherwise), 'Unknown fallback action');
  assert(!workflow.requestedCapabilities.includes('pr.merge'), 'V1 must not grant merge');
  assert(workflow.settings.reviewWaitSeconds <= workflow.settings.reviewDeadlineSeconds, 'Wait exceeds deadline');
  assert(workflow.rules.some(rule => rule.id === 'repair_waiting_human'), 'Missing unchanged-concern suppression');
  for (const action of Object.values(workflow.actions)) {
    assert(action.capabilities.every(capability => workflow.requestedCapabilities.includes(capability)),
      'Action exceeds requested grant');
    assert(continuations.has(action.onSuccess) && continuations.has(action.onFailure), 'Unknown continuation');
    for (const reference of [action.prompt, action.outputSchema, ...action.contextFiles ?? []]) {
      if (reference !== undefined) localReference(reference);
    }
    if (action.execution === 'agent') assert(action.prompt && action.outputSchema, 'Agent action missing contract');
  }
  checkMarkdown(root);

  const output = join(root, 'presentation.html');
  const artifact = readFileSync(output, 'utf8');
  assert(statSync(output).size < 10 * 1024 * 1024, 'Presentation exceeds its 10 MiB size budget');
  assert(!artifact.includes('@@'), 'Unresolved build marker');
  assert(artifact.includes('data:font/woff2;base64,') && artifact.includes('SIL OPEN FONT LICENSE'),
    'Missing embedded fonts/licence');
  const ids = new Set<string>();
  let slides = 0;
  let diagrams = 0;
  function visit(node: DefaultTreeAdapterMap['node']): void {
    if ('tagName' in node) {
      const attrs = Object.fromEntries(node.attrs.map(attr => [attr.name, attr.value]));
      if (attrs.id !== undefined) {
        assert(!ids.has(attrs.id), `Duplicate HTML ID: ${attrs.id}`);
        ids.add(attrs.id);
      }
      if (attrs.src !== undefined) assert(/^(data:|blob:)/.test(attrs.src), 'External artifact asset');
      if (node.tagName === 'section' && attrs.class?.split(/\s+/).includes('slide')) slides++;
      if (node.tagName === 'svg') {
        diagrams++;
        assert(attrs['aria-label'], 'Architecture drawing needs an accessible name');
      }
      if (node.tagName === 'template' && 'content' in node) visit(node.content);
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
  }
  visit(parse(artifact));
  assert(slides === 22 && diagrams === 5, 'Missing slides or architecture drawings');
  const embedded = artifact.match(/<script id="initial-workflow" type="application\/json">(.*?)<\/script>/s);
  assert(embedded && isDeepStrictEqual(JSON.parse(embedded[1]!), workflow),
    'Rebuild the presentation after changing workflow.json');
  console.log(`PASS document contracts, ${Object.keys(examples).length} result examples, references, 22 slides, 5 diagrams, offline assets`);
}

try {
  main();
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
