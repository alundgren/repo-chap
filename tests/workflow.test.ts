import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { buildPackage, evaluate, evaluateCondition, loadWorkflow, parseFixture, parseJson, replay, validateWorkflow, WorkflowError, type ReplayFixture, type Workflow } from '@repo-chap/workflow';

const root = resolve('.');
const workflowPath = 'docs/pr-workflows/examples/team-pr/workflow.json';
const pkg = await loadWorkflow(join(root, workflowPath));
const source = Object.fromEntries(pkg.files.map(file => [file.path, file.text]));
const copy = (): Workflow => structuredClone(pkg.workflow);
const compile = (workflow: Workflow) => buildPackage(workflowPath, { ...source, [workflowPath]: JSON.stringify(workflow) });
const fixture = async (name: string): Promise<ReplayFixture> => parseFixture(JSON.parse(await readFile(`fixtures/replay/${name}.json`, 'utf8')));
function rejectsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof WorkflowError && error.diagnostics.some(d => d.code === code));
}

test('supplied example loads as an immutable package with explicit references only', () => {
  assert.equal(pkg.files.length, 7);
  assert.ok(Object.isFrozen(pkg.workflow.actions.review));
  assert.ok(Object.isFrozen(pkg.files));
  const text = source['docs/pr-workflows/examples/team-pr/review.md']!;
  const changed = { ...source, 'docs/pr-workflows/examples/team-pr/review.md': `${text}\n[Absent](absent.md)\n` };
  assert.equal(buildPackage(workflowPath, changed).files.length, 7);
});

test('canonical digest ignores formatting, object order and layout but includes context bytes and rule order', () => {
  const reorderedKeys = Object.fromEntries(Object.entries(copy()).reverse()) as unknown as Workflow;
  reorderedKeys.layout = { nodes: { review: { x: 999, y: -1 } } };
  assert.equal(compile(reorderedKeys).digest, pkg.digest);
  const changed = { ...source, 'docs/pr-workflows/examples/team-pr/review.md': 'Different review instructions.\n' };
  assert.notEqual(buildPackage(workflowPath, changed).digest, pkg.digest);
  const reorderedRules = copy(); reorderedRules.rules.reverse();
  assert.notEqual(compile(reorderedRules).digest, pkg.digest);
  assert.equal(pkg.files.find(file => file.path === 'docs/pr-workflows/examples/team-pr/review.md')?.text, source['docs/pr-workflows/examples/team-pr/review.md']);
});

test('unknown negation and typed comparisons preserve unknown; all and any use three values', () => {
  const leaf = { field: 'facts.conflict', op: 'eq' as const, value: true };
  assert.equal(evaluateCondition({ not: leaf }, {}, {}).value, 'unknown');
  assert.equal(evaluateCondition({ not: leaf }, { conflict: null }, {}).value, 'unknown');
  assert.equal(evaluateCondition(leaf, { conflict: 'true' } as never, {}).value, 'unknown');
  assert.equal(evaluateCondition({ all: [leaf, { field: 'facts.draft', op: 'eq', value: true }] }, { draft: false }, {}).value, false);
  assert.equal(evaluateCondition({ any: [leaf, { field: 'facts.draft', op: 'eq', value: true }] }, { draft: true }, {}).value, true);
});

test('moving overlapping rules changes priority without changing IDs', async () => {
  const input = await fixture('conflict'); input.observations[0]!.facts.draft = true;
  assert.equal(evaluate(pkg.workflow, input.observations[0]!, input.control!, input.now).ruleId, 'draft');
  const workflow = copy();
  const conflict = workflow.rules.find(rule => rule.id === 'conflict')!;
  workflow.rules = [conflict, ...workflow.rules.filter(rule => rule !== conflict)];
  assert.equal(evaluate(compile(workflow).workflow, input.observations[0]!, input.control!, input.now).ruleId, 'conflict');
});

for (const [name, rule, status] of [
  ['conflict', 'conflict', 'needs_observation'],
  ['review-wait', 'reviewer_active', 'waiting'],
  ['incomplete-evidence', 'missing_evidence', 'waiting'],
  ['suppressed-repair', 'repair_waiting_human', 'waiting'],
  ['handoff', 'request_human_decision', 'waiting'],
] as const) test(`${name} fixture produces a deterministic explanation`, async () => {
  const input = await fixture(name), before = JSON.stringify(input);
  const result = replay(pkg, input);
  assert.equal(result.decisions[0]?.ruleId, rule); assert.equal(result.status, status);
  assert.ok(result.decisions[0]?.rules.every(rule => rule.selected || rule.condition.value !== true));
  assert.deepEqual(replay(pkg, input), result); assert.equal(JSON.stringify(input), before);
  if (name === 'handoff') assert.equal(result.proposedEffects.at(-1)?.outcome, 'ready_for_human_merge');
  if (name === 'conflict') assert.deepEqual(result.actions.map(a => a.actionId), ['resolve_conflict', 'validate_candidate', 'push_candidate', 'resolve_threads']);
});

test('reviewer wait uses a fixed deadline, expires, and cannot restart without time evidence', async () => {
  const input = await fixture('review-wait'); input.now = '2026-05-01T12:24:00Z';
  assert.equal(replay(pkg, input).nextWakeAt, '2026-05-01T12:25:00.000Z');
  input.now = '2026-05-01T12:25:00Z';
  assert.equal(replay(pkg, input).decisions[0]?.ruleId, 'request_human_decision');
  delete input.observations[0]!.externalReviewStartedAt;
  assert.match(replay(pkg, input).reason, /requires externalReviewStartedAt/);
});

test('debounce waits for the later age or head deadline using the explicit clock', async () => {
  const input = await fixture('handoff');
  input.observations[0]!.createdAt = '2026-05-01T11:59:00Z';
  input.observations[0]!.headChangedAt = '2026-05-01T11:59:50Z';
  assert.equal(replay(pkg, input).nextWakeAt, '2026-05-01T12:01:00.000Z');
});

test('unknown evidence cannot authorize repairs even when an unsafe fallback requests one', async () => {
  const input = await fixture('conflict'); delete input.observations[0]!.facts.evidenceComplete;
  assert.equal(replay(pkg, input).status, 'blocked');
  assert.equal(replay(pkg, input).proposedEffects.length, 0);
});

test('current analysis alone, partial review, concerns and uncertainty cannot produce ready handoff', async () => {
  for (const change of ['missing', 'partial', 'concerns', 'inconclusive', 'uncertain'] as const) {
    const input = await fixture('handoff');
    if (change === 'missing') delete input.control!.review;
    if (change === 'partial') input.control!.review!.coverage = 'partial';
    if (change === 'concerns' || change === 'inconclusive') input.control!.review!.verdict = change;
    if (change === 'uncertain') input.control!.classification!.uncertain = true;
    assert.notEqual(replay(pkg, input).proposedEffects.at(-1)?.outcome, 'ready_for_human_merge', change);
  }
});

test('failed, blocked and no-change repair routes never propose a push or a ready handoff', async () => {
  const blocked = JSON.parse(await readFile('docs/pr-workflows/examples/results/blocked-repair.json', 'utf8'));
  for (const outcome of ['failure', 'blocked', 'no_change']) {
    const input = await fixture('conflict');
    input.results!.resolve_conflict = [outcome === 'failure' ? { status: 'failure', reason: 'Provider stopped.' } : { status: 'success', payload: { ...blocked, outcome } }];
    input.results!.handoff = [{ status: 'success' }];
    const result = replay(pkg, input);
    assert.equal(result.status, 'waiting');
    assert.equal(result.proposedEffects.at(-1)?.outcome, 'blocked_execution');
    assert.ok(!result.proposedEffects.some(effect => effect.uses === 'github.push_candidate'));
    if (outcome !== 'failure') assert.equal(result.control.repairSuppression?.evidenceDigest, 'fictional-evidence-1');
  }
});

test('unknown remote outcomes block without following success or failure routes', async () => {
  const input = await fixture('conflict'); input.results!.push_candidate = [{ status: 'unknown' }];
  const result = replay(pkg, input);
  assert.equal(result.status, 'blocked'); assert.match(result.reason, /Reconciliation/);
  assert.equal(result.actions.at(-1)?.actionId, 'push_candidate');
});

test('stale stub head and malformed payload cannot authorize a push', async () => {
  const input = await fixture('conflict'); input.observations[0]!.headSha = 'd'.repeat(40);
  assert.match(replay(pkg, input).reason, /different PR head/);
  input.results!.resolve_conflict![0]!.payload = {};
  rejectsCode(() => replay(pkg, input), 'schema');
});

test('repair and attempt budgets survive additional fixture observations', async () => {
  const input = await fixture('conflict');
  input.control!.repairsThisLifecycle = pkg.workflow.limits.maxRepairsPerLifecycle;
  assert.match(replay(pkg, input).reason, /Lifecycle repair budget/);
  input.control!.repairsThisLifecycle = 0;
  input.observations.push(structuredClone(input.observations[0]!), structuredClone(input.observations[0]!));
  for (const [id, stubs] of Object.entries(input.results!)) input.results![id] = [stubs[0]!, stubs[0]!, stubs[0]!];
  const result = replay(pkg, input);
  assert.match(result.reason, /budget is exhausted/); assert.equal(result.control.repairsThisLifecycle, 2);
});

test('head changes invalidate current analysis without clearing lifecycle repair counts', async () => {
  const input = await fixture('conflict'), next = structuredClone(input.observations[0]!);
  next.headSha = 'c'.repeat(40); next.facts.conflict = false; input.observations.push(next);
  const result = replay(pkg, input);
  assert.equal(result.decisions.at(-1)?.ruleId, 'classify_current_head');
  assert.equal(result.control.repairsThisLifecycle, 1);
  assert.equal(result.control.memory?.reviewCurrent, false);
});

test('workflow semantic errors give actionable diagnostic codes', () => {
  const cases: [string, (w: Workflow) => void][] = [
    ['unsupported_schema', w => { (w as { schemaVersion: number }).schemaVersion = 2; }],
    ['duplicate_id', w => { w.rules[1]!.id = ` ${w.rules[0]!.id.toUpperCase()} `; }],
    ['condition_type', w => { w.rules[1]!.when = { field: 'facts.draft', op: 'eq', value: 'true' }; }],
    ['action_reference', w => { w.actions.review!.onFailure = 'missing'; }],
    ['registry', w => { w.actions.review!.uses = 'agent.unknown'; }],
    ['registry', w => { w.actions.review!.execution = 'code'; }],
    ['capability', w => { w.actions.review!.capabilities = []; }],
    ['error_route', w => { w.actions.handoff!.onFailure = 'handoff'; }],
    ['unbounded_cycle', w => { w.actions.resolve_threads!.onSuccess = 'resolve_threads'; }],
    ['action_input', w => { w.rules[0]!.action = 'push_candidate'; }],
    ['merge_forbidden', w => { w.requestedCapabilities.push('pr.merge' as never); }],
    ['schema', w => { delete (w.actions.review as Partial<typeof w.actions.review>)!.onFailure; }],
    ['slack_route', w => { w.slack!.routes.needs_team = 'missing'; }],
  ];
  for (const [code, mutate] of cases) { const workflow = copy(); mutate(workflow); rejectsCode(() => compile(workflow), code); }
  rejectsCode(() => validateWorkflow(copy(), []), 'capability');
});

test('unreachable actions, excessive expressions, and duplicate JSON properties are rejected', () => {
  const workflow = copy(); workflow.actions.unused = structuredClone(workflow.actions.park!);
  rejectsCode(() => compile(workflow), 'unreachable_action');
  const deep = copy();
  for (let i = 0; i < 18; i++) deep.rules[0]!.when = { not: deep.rules[0]!.when };
  assert.throws(() => compile(deep), WorkflowError);
  rejectsCode(() => parseJson('{"actions":{"x":{},"x":{}}}', 'workflow.json'), 'duplicate_key');
});

test('bounded agent cycles stop at their finite budget', async () => {
  const workflow = copy(); workflow.actions.review!.onSuccess = 'review';
  const input = await fixture('handoff'); input.control!.memory!.reviewCurrent = false;
  const payload = JSON.parse(await readFile('docs/pr-workflows/examples/results/review.json', 'utf8'));
  input.results = { review: [{ status: 'success', payload }, { status: 'success', payload }] };
  assert.match(replay(compile(workflow), input).reason, /budget is exhausted/);
});

test('references reject traversal, missing files, unsupported schemas, remote refs and oversized files', () => {
  for (const path of ['../../../../../../secret.md', '/tmp/secret.md', 'https://example.test/prompt']) {
    const workflow = copy(); workflow.actions.review!.prompt = path; assert.throws(() => compile(workflow), WorkflowError);
  }
  const missing = { ...source }; delete missing['docs/pr-workflows/examples/team-pr/review.md'];
  rejectsCode(() => buildPackage(workflowPath, missing), 'missing_file');
  rejectsCode(() => buildPackage(workflowPath, { ...source, 'docs/pr-workflows/examples/team-pr/review.md': 'x'.repeat(1024 * 1024 + 1) }), 'size_limit');
  const badFragment = copy(); badFragment.actions.review!.outputSchema += '/missing';
  rejectsCode(() => compile(badFragment), 'schema_reference');
  const contractPath = 'docs/pr-workflows/schemas/results.schema.json';
  const contract = JSON.parse(source[contractPath]!); contract.$schema = 'http://json-schema.org/draft-07/schema#';
  rejectsCode(() => buildPackage(workflowPath, { ...source, [contractPath]: JSON.stringify(contract) }), 'unsupported_schema');
  contract.$schema = 'https://json-schema.org/draft/2020-12/schema'; contract.$defs.review.$ref = 'https://example.test/remote.json';
  rejectsCode(() => buildPackage(workflowPath, { ...source, [contractPath]: JSON.stringify(contract) }), 'schema_reference');
});

test('filesystem loader rejects out-of-root symlinks and pins data before later edits', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'repo-chap-load-'));
  try {
    const repository = join(temporary, 'repository'); await mkdir(repository);
    for (const [path, text] of Object.entries(source)) { await mkdir(join(repository, path, '..'), { recursive: true }); await writeFile(join(repository, path), text); }
    const loaded = await loadWorkflow(join(repository, workflowPath), { repositoryRoot: repository });
    const context = join(repository, 'docs/pr-workflows/examples/team-pr/review.md');
    await writeFile(context, '\uFEFFNew instructions.');
    assert.equal(loaded.digest, pkg.digest); assert.notEqual((await loadWorkflow(join(repository, workflowPath), { repositoryRoot: repository })).digest, pkg.digest);
    assert.equal((await loadWorkflow(join(repository, workflowPath), { repositoryRoot: repository })).files.find(file => file.path === 'docs/pr-workflows/examples/team-pr/review.md')?.text, '\uFEFFNew instructions.');
    await writeFile(context, Buffer.from([0xff]));
    await assert.rejects(loadWorkflow(join(repository, workflowPath), { repositoryRoot: repository }), (error: unknown) => error instanceof WorkflowError && error.diagnostics[0]?.code === 'invalid_encoding');
    await rm(context); await writeFile(join(temporary, 'outside.md'), 'Outside.'); await symlink(join(temporary, 'outside.md'), context);
    await assert.rejects(loadWorkflow(join(repository, workflowPath), { repositoryRoot: repository }), (error: unknown) => error instanceof WorkflowError && error.diagnostics[0]?.code === 'outside_repository');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('fixture parsing rejects missing time, coerced booleans and unsupported versions', async () => {
  const input = await fixture('handoff');
  for (const invalid of [{ ...input, now: undefined }, { ...input, schemaVersion: 2 }, { ...input, observations: [{ facts: { conflict: 'false' } }] }, { ...input, now: '2026-02-30T12:00:00Z' }]) rejectsCode(() => parseFixture(invalid), 'schema');
});

test('replacement candidates and failed retries cannot reuse earlier checks or push results', async () => {
  const candidate = JSON.parse(await readFile('docs/pr-workflows/examples/results/candidate.json', 'utf8'));
  for (const stage of ['repair-success', 'repair-failure', 'checks-failure', 'push-failure']) {
    const workflow = copy();
    const input = await fixture('conflict');
    if (stage.startsWith('repair')) {
      workflow.actions.second_repair = { ...workflow.actions.resolve_conflict!, onSuccess: 'push_candidate', onFailure: 'push_candidate' };
      workflow.actions.validate_candidate!.onSuccess = 'second_repair';
      input.results!.second_repair = [stage === 'repair-success' ? { status: 'success', payload: { ...candidate, candidateSha: 'd'.repeat(40) } } : { status: 'failure' }];
    } else if (stage === 'checks-failure') {
      workflow.actions.recheck = { ...workflow.actions.validate_candidate!, onFailure: 'push_candidate' };
      workflow.actions.validate_candidate!.onSuccess = 'recheck';
      input.results!.recheck = [{ status: 'failure' }];
    } else {
      workflow.actions.retry_push = { ...workflow.actions.push_candidate!, onFailure: 'resolve_threads' };
      workflow.actions.push_candidate!.onSuccess = 'retry_push';
      input.results!.retry_push = [{ status: 'failure' }];
    }
    rejectsCode(() => compile(workflow), 'action_input');
    // Old serialized packages may predate the current validator's checks.
    const result = replay({ ...pkg, workflow }, input);
    assert.equal(result.status, 'blocked', stage);
    assert.match(result.reason, /requires a successful/);
    assert.ok(!result.actions.some(action => action.actionId === 'resolve_threads'), stage);
    if (stage !== 'push-failure') assert.ok(!result.actions.some(action => action.actionId === 'push_candidate'), stage);
  }
});

test('a replacement candidate succeeds only after its own checks', async () => {
  const workflow = copy();
  workflow.actions.second_repair = { ...workflow.actions.resolve_conflict!, onSuccess: 'second_checks' };
  workflow.actions.second_checks = { ...workflow.actions.validate_candidate! };
  workflow.actions.validate_candidate!.onSuccess = 'second_repair';
  const input = await fixture('conflict');
  const candidate = JSON.parse(await readFile('docs/pr-workflows/examples/results/candidate.json', 'utf8'));
  input.results!.second_repair = [{ status: 'success', payload: { ...candidate, candidateSha: 'd'.repeat(40) } }];
  input.results!.second_checks = [{ status: 'success' }];
  const result = replay(compile(workflow), input);
  assert.equal(result.status, 'needs_observation');
  assert.deepEqual(result.actions.map(action => action.actionId), ['resolve_conflict', 'validate_candidate', 'second_repair', 'second_checks', 'push_candidate', 'resolve_threads']);
});

test('failed analysis stays invalid after observation even when an old acceptable result exists', async () => {
  for (const id of ['review', 'classify']) {
    const workflow = copy();
    workflow.rules.unshift(
      { id: 'refresh_analysis', when: { field: 'facts.conflict', op: 'eq', value: true }, action: id },
      { id: 'handoff_after_refresh', when: { field: 'facts.conflict', op: 'eq', value: false }, action: 'handoff' },
    );
    workflow.actions[id]!.onFailure = '$observe';
    const input = await fixture('handoff');
    input.observations[0]!.facts.conflict = true;
    const next = structuredClone(input.observations[0]!); next.facts.conflict = false;
    input.observations.push(next);
    input.results![id] = [{ status: 'failure' }];
    const result = replay(compile(workflow), input);
    assert.equal(result.proposedEffects.at(-1)?.outcome, 'blocked_execution', id);
    assert.equal(result.control.memory?.[id === 'review' ? 'reviewCurrent' : 'classificationCurrent'], false);
    assert.equal(result.control[id === 'review' ? 'review' : 'classification'], undefined);
  }
});

test('successful replacement analysis can restore readiness after a failed attempt', async () => {
  for (const id of ['review', 'classify']) {
    const workflow = copy(); workflow.actions[id]!.onFailure = '$observe';
    const input = await fixture('handoff');
    input.control!.memory![id === 'review' ? 'reviewCurrent' : 'classificationCurrent'] = false;
    input.observations.push(structuredClone(input.observations[0]!), structuredClone(input.observations[0]!));
    const name = id === 'review' ? 'review' : 'classification';
    const payload = JSON.parse(await readFile(`docs/pr-workflows/examples/results/${name}.json`, 'utf8'));
    input.results![id] = [{ status: 'failure' }, { status: 'success', payload }];
    const result = replay(compile(workflow), input);
    assert.equal(result.proposedEffects.at(-1)?.outcome, 'ready_for_human_merge', id);
    assert.deepEqual(result.actions.slice(0, 2).map(action => action.status), ['failure', 'success']);
  }
});

test('custom schemas cannot remove the required built-in result contract', async () => {
  for (const [id, payload] of [['resolve_conflict', null], ['classify', {}], ['review', {}]] as const) {
    const workflow = copy(); workflow.actions[id]!.outputSchema = 'permissive.json';
    const permissive = buildPackage(workflowPath, {
      ...source, [workflowPath]: JSON.stringify(workflow),
      'docs/pr-workflows/examples/team-pr/permissive.json': '{"$schema":"https://json-schema.org/draft/2020-12/schema"}',
    });
    const input = await fixture(id === 'resolve_conflict' ? 'conflict' : 'handoff');
    if (id !== 'resolve_conflict') input.control!.memory![id === 'review' ? 'reviewCurrent' : 'classificationCurrent'] = false;
    input.results![id] = [{ status: 'success', payload }];
    rejectsCode(() => replay(permissive, input), 'schema');
  }
});

test('schema fragments validate their own constraints and retain internal references', async () => {
  const contractPath = 'docs/pr-workflows/schemas/results.schema.json';
  const contract = JSON.parse(source[contractPath]!);
  contract.type = 'null';
  contract.$defs.originalCandidate = contract.$defs.candidate;
  contract.$defs.candidate = { $ref: '#/$defs/originalCandidate' };
  const selected = buildPackage(workflowPath, { ...source, [contractPath]: JSON.stringify(contract) });
  const result = replay(selected, await fixture('conflict'));
  assert.equal(result.status, 'needs_observation');
  assert.equal(result.actions.at(-1)?.actionId, 'resolve_threads');
  const constrained = copy(); constrained.actions.resolve_conflict!.outputSchema = 'narrow.json';
  const narrow = buildPackage(workflowPath, {
    ...source, [workflowPath]: JSON.stringify(constrained),
    'docs/pr-workflows/examples/team-pr/narrow.json': JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { candidateSha: { const: 'd'.repeat(40) } } }),
  });
  const input = await fixture('conflict');
  rejectsCode(() => replay(narrow, input), 'schema');
});
