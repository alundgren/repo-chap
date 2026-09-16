import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron, expect, chromium } from '@playwright/test';
import { loadWorkflow } from '@repo-chap/workflow';
import { decisionPacket } from './helpers/slack-fixture.ts';

const workflowPath = 'docs/pr-workflows/examples/team-pr/workflow.json';
const reviewPath = 'docs/pr-workflows/examples/team-pr/review.md';
const packaged = process.env.REPO_CHAP_DESKTOP_EXECUTABLE;
const executablePath: string = packaged ?? createRequire(resolve('apps/desktop/package.json'))('electron');
const proof = join(process.env.REPO_CHAP_DESKTOP_PROOF ?? await mkdtemp(join(tmpdir(), 'repo-chap-proof-')), 'simulation');
await mkdir(proof, { recursive: true });

test('actual Electron edits priority and timing, replays offline with CLI parity, shows Slack and recovers invalid source', { timeout: 180_000 }, async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'repo-chap-simulation-ui-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const root = join(workspace, 'willow-labs', 'sample-project');
  const original = await loadWorkflow(resolve(workflowPath));
  const workflow = structuredClone(original.workflow);
  workflow.rules.unshift({ id: 'fixture_handoff', when: { field: 'memory.packetCurrent', op: 'eq', value: true }, action: 'handoff' });
  workflow.layout = { futureCoordinates: { conflict: [100, 200] } };
  for (const file of original.files) { await mkdir(dirname(join(root, file.path)), { recursive: true }); await writeFile(join(root, file.path), file.path === workflowPath ? JSON.stringify(workflow, null, 2) + '\n' : file.text); }
  const baseFixture = JSON.parse(await readFile('fixtures/replay/handoff.json', 'utf8'));
  const both = structuredClone(baseFixture); both.observations[0].facts.conflict = true; both.observations[0].facts.unaddressedReview = true; both.results = {};
  const author = structuredClone(baseFixture); author.observations[0].facts.conflict = true; author.control.memory.packetCurrent = true;
  const pending = structuredClone(baseFixture); pending.observations[0].facts.externalReviewPending = true; pending.observations[0].externalReviewStartedAt = '2026-05-01T11:55:00Z';
  const incomplete = structuredClone(baseFixture); incomplete.observations[0].facts.evidenceComplete = false;
  const limit = structuredClone(both); limit.control.repairsThisLifecycle = 99;
  const packet = { ...decisionPacket, repository: 'willow-labs/sample-project', headSha: baseFixture.observations[0].headSha, authorLogin: 'unmapped-cedar', outcome: 'needs_author', reason: 'The captured PR has an ownership conflict that needs an author decision.', recommendedDecision: 'Resolve the ownership conflict, then request a fresh review.', findings: ['The ownership check has incomplete coverage. '.repeat(400)], attemptedFixes: [], checks: [{ name: 'ownership-check', status: 'not_run', evidence: 'No candidate was produced in this fixture.' }], evidenceLinks: [], uncertainty: ['Captured evidence does not establish current readiness.'] };
  for (const [name, value] of Object.entries({ both, author, pending, incomplete, limit, packet })) await writeFile(join(workspace, `${name}.json`), JSON.stringify(value));
  await writeFile(join(workspace, 'invalid.json'), '{ broken fixture');
  const env: Record<string, string> = { REPO_CHAP_DESKTOP_DATA: join(workspace, 'profile') };
  for (const key of ['PATH', 'DISPLAY', 'HOME', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[key]) env[key] = process.env[key]!;
  const electron = await _electron.launch({ executablePath, args: [...(packaged ? [] : [resolve('apps/desktop')]), '--workflow', join(root, workflowPath), '--repo-root', root], env, recordVideo: { dir: join(proof, 'video'), size: { width: 1200, height: 850 } } });
  t.after(async () => { const page = electron.windows()[0]; if (page && !page.isClosed()) { await page.screenshot({ path: join(proof, 'last-window.png'), fullPage: true }).catch(() => {}); await writeFile(join(proof, 'last-window.txt'), await page.locator('body').innerText().catch(() => 'Unavailable')); } await electron.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.destroy(); }).catch(() => {}); await electron.close().catch(() => {}); });
  const page = await electron.firstWindow(), errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await electron.context().setOffline(true);
  await expect(page.locator('#validation-title')).toHaveText('Validation passed');
  await electron.evaluate(() => {
    const calls: string[] = []; (globalThis as any).offlineGuardCalls = calls;
    globalThis.fetch = (() => { calls.push('fetch'); throw new Error('Network forbidden during simulation'); }) as typeof fetch;
    for (const [module, names] of [['node:child_process', ['spawn', 'exec', 'execFile']], ['node:http', ['request', 'get']], ['node:https', ['request', 'get']]] as const) {
      const api = process.getBuiltinModule(module) as any;
      for (const name of names) api[name] = () => { calls.push(`${module}.${name}`); throw new Error('Adapter forbidden during simulation'); };
    }
  });
  const snapshot = () => page.evaluate(async () => (await window.repoChap.current()).snapshot!);
  const load = async (name: string, kind: 'fixture' | 'packets' = 'fixture'): Promise<void> => {
    await electron.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, join(workspace, `${name}.json`));
    await page.locator(`#load-${kind}`).click(); await expect(page.locator(`#${kind}-name`)).toContainText(`${name}.json`);
  };
  const run = async (): Promise<void> => { await page.locator('#simulate').click(); await expect(page.locator('#message')).toHaveText('Simulation finished. Nothing was sent.'); };
  await page.locator('#simulation-tab').click(); await load('both'); await run();
  assert.equal((await snapshot()).simulation!.result.decisions[0]!.actionId, 'resolve_conflict');
  await expect(page.getByRole('region', { name: 'Decision trace' })).toContainText('Rejected');
  await expect(page.locator('#simulation-result')).toContainText('fixture.results.resolve_conflict[0]');
  await page.screenshot({ path: join(proof, '01-conflict-trace.png'), fullPage: true });
  await page.locator('#process-tab').click();
  await expect(page.locator('#rules')).toContainText('memory.repairSuppressed = true and (facts.conflict = true or facts.unaddressedReview = true)');
  await page.locator('#action-select').selectOption('wait_review');
  const wait = page.locator('#setting-reviewWaitSeconds'); await wait.fill('60'); await page.locator('#apply-settings').click();
  await expect.poll(async () => (await snapshot()).workflow!.settings.reviewWaitSeconds).toBe(60);
  const move = page.getByRole('button', { name: 'Move review_to_address up', exact: true }); await move.focus(); await move.press('Enter');
  await expect.poll(async () => (await snapshot()).workflow!.rules.findIndex(rule => rule.id === 'review_to_address')).toBe(workflow.rules.findIndex(rule => rule.id === 'conflict'));
  await expect(move).toBeFocused();
  await page.screenshot({ path: join(proof, '02-process-keyboard.png'), fullPage: true });
  await page.locator('#source-tab').click();
  const edited = JSON.parse(await page.locator('#source').inputValue());
  assert.deepEqual(edited.layout, workflow.layout); assert.deepEqual(edited.rules.map((r: any) => r.id).sort(), workflow.rules.map(r => r.id).sort());
  await page.locator('#simulation-tab').click(); await expect(page.locator('#simulation-result')).toContainText('Stale result'); await run();
  assert.equal((await snapshot()).simulation!.result.decisions[0]!.actionId, 'address');
  await page.locator('#save').click(); await expect(page.locator('#message')).toHaveText('Saved all changed files.');
  const exportPath = join(workspace, 'workflow-copy.json');
  await electron.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, exportPath);
  await page.locator('#export').click(); await expect(page.locator('#message')).toContainText('Referenced files were not copied');
  assert.equal(await readFile(exportPath, 'utf8'), await readFile(join(root, workflowPath), 'utf8'));
  await load('pending'); await run(); await expect(page.locator('#simulation-result')).toContainText('Next wake 2026-05-01T12:01:00.000Z');
  await page.locator('#fake-clock').fill('2026-05-01T12:10:00Z'); await page.locator('#set-clock').click(); await expect(page.locator('#simulation-result')).toContainText('Stale result'); await run();
  await expect(page.locator('#simulation-result')).toContainText('Next wake 2026-05-01T12:11:00.000Z');
  await page.screenshot({ path: join(proof, '03-wait-fake-time.png'), fullPage: true });
  await page.locator('#reset-fixture').click(); await expect(page.locator('#fake-clock')).toHaveValue(pending.now);
  await load('incomplete'); await run(); await expect(page.locator('#simulation-result')).toContainText('Required evidence is incomplete');
  await page.screenshot({ path: join(proof, '04-incomplete-evidence.png'), fullPage: true });
  await load('limit'); await run(); await expect(page.locator('#simulation-result')).toContainText('Lifecycle repair budget is exhausted');
  await load('author'); await run(); await expect(page.getByRole('region', { name: 'Local Slack preview' })).toContainText('Supply exactly one packet');
  await load('packet', 'packets'); await run();
  const result = (await snapshot()).simulation!; assert.equal(result.handoffs[0]!.preview.route.fallback, true); assert.ok(result.handoffs[0]!.preview.omissions.length);
  const cli = JSON.parse(execFileSync(process.execPath, [resolve('apps/cli/dist/cli.js'), 'replay', join(root, workflowPath), '--repo-root', root, '--fixture', join(workspace, 'author.json'), '--packet', join(workspace, 'packet.json'), '--json'], { encoding: 'utf8' }));
  assert.deepEqual(cli, { ...result.result, handoffs: result.handoffs });
  await page.getByRole('region', { name: 'Local Slack preview' }).screenshot({ path: join(proof, '05-slack-fallback-long.png') });
  await page.getByText('Complete decision packet', { exact: true }).click(); await expect(page.getByRole('region', { name: 'Local Slack preview' })).toContainText(packet.findings[0]!);
  await page.getByText('Complete decision packet', { exact: true }).click();
  await load('invalid'); await page.locator('#simulate').click(); await expect(page.locator('#message')).toContainText('Invalid JSON. Check commas, quotes, and braces.');
  await expect(page.locator('#simulation-result')).toContainText('Stale result'); await load('author'); await run();
  await page.locator('#source-tab').click();
  await page.getByRole('button', { name: reviewPath, exact: true }).first().click(); await page.locator('#source').fill('# Context changed in the editor\n');
  await expect(page.locator('#dirty-state')).toHaveText('1 unsaved file(s)');
  await page.locator('#simulation-tab').click(); await expect(page.locator('#simulation-result')).toContainText('Stale result');
  await page.locator('#changes-title').click(); await expect(page.locator('#semantic-changes')).toContainText('Referenced text changed');
  await page.screenshot({ path: join(proof, '06-context-change.png'), fullPage: true });
  await page.locator('#source-tab').click(); await page.getByRole('button', { name: workflowPath, exact: true }).first().click(); await page.locator('#source').fill('{ invalid source');
  await expect(page.locator('#validation-title')).toHaveText('1 validation error(s)'); await page.locator('#simulation-tab').click();
  await expect(page.locator('#simulate')).toBeDisabled(); await expect(page.locator('#export')).toBeDisabled(); await expect(page.locator('#simulation-blocked')).toBeVisible();
  await page.screenshot({ path: join(proof, '07-invalid-source.png'), fullPage: true });
  await page.locator('#reset').click(); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await snapshot()).files.find(file => file.path === workflowPath)!.text, '{ invalid source');
  await page.locator('#reset').click(); await page.getByRole('dialog').getByRole('button', { name: 'Reset workflow', exact: true }).click();
  await page.locator('#simulation-tab').click();
  await electron.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => { (globalThis as any).fixturePickerPending = true; await new Promise<void>(resolve => { (globalThis as any).finishFixturePicker = resolve; }); return { canceled: false, filePaths: [path] }; };
  }, join(workspace, 'author.json'));
  await page.locator('#load-fixture').click(); await expect.poll(() => electron.evaluate(() => (globalThis as any).fixturePickerPending)).toBe(true);
  await page.locator('#source-tab').click(); await expect(page.locator('#source')).toHaveAttribute('readonly', '');
  await page.locator('#process-tab').click(); await expect(page.locator('#action-select')).toBeDisabled(); await expect(page.getByRole('button', { name: 'Move conflict up', exact: true })).toBeDisabled();
  await page.screenshot({ path: join(proof, '11-input-loading.png'), fullPage: true });
  await electron.evaluate(() => { (globalThis as any).finishFixturePicker(); }); await expect(page.locator('#action-select')).toBeEnabled();
  await page.locator('#source-tab').click(); await expect(page.locator('#source')).not.toHaveAttribute('readonly', '');
  await expect(page.locator('#validation-title')).toHaveText('Validation passed'); await expect(page.locator('#dirty-state')).toHaveText('All changes saved');
  assert.equal((await snapshot()).workflow!.settings.reviewWaitSeconds, 60); await page.locator('#simulation-tab').click(); await run();
  await page.locator('#source-tab').click(); const saved = await page.locator('#source').inputValue();
  await page.locator('#source').fill(JSON.stringify({ ...JSON.parse(saved), unsupportedSetting: { keep: true } })); await expect(page.locator('#validation-title')).toContainText('validation error');
  await page.locator('#process-tab').click(); await expect(page.locator('#process-unavailable')).toBeVisible(); await expect(page.locator('#export')).toBeDisabled();
  await page.screenshot({ path: join(proof, '08-unsupported-field.png'), fullPage: true });
  await page.locator('#reset').click(); await page.getByRole('dialog').getByRole('button', { name: 'Reset workflow', exact: true }).click();
  for (const [name, width, height] of [['laptop', 1024, 768], ['narrow', 390, 844]] as const) {
    await electron.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]!.setBounds(bounds), { width, height });
    for (const view of ['process', 'simulation'] as const) {
      await page.locator(`#${view}-tab`).click(); await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${name}/${view} horizontal overflow`);
      await page.screenshot({ path: join(proof, `09-${name}-${view}.png`), fullPage: true });
    }
  }
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ width: 1200, height: 850 })); await page.locator('#process-tab').click(); await page.locator('#action-select').selectOption('wait_review');
  await page.screenshot({ path: join(proof, '10-process-comparison.png'), fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(requests, []); assert.deepEqual(await electron.evaluate(() => (globalThis as any).offlineGuardCalls), []);
  await writeFile(join(proof, 'result.json'), JSON.stringify({ platform: process.platform, packaged: !!packaged, launchArguments: electron.process().spawnargs.slice(1), checks: ['priority preserves IDs/layout and updates source', 'keyboard reorder focus', 'timing edit', 'CLI/Electron exact replay and Slack parity', 'waits and fake time', 'incomplete evidence', 'limits', 'missing packet context', 'Slack fallback and long findings', 'invalid fixture recovery', 'context changes mark stale', 'invalid source disables simulation/export', 'reset cancel and restore saved files', 'unsupported runtime fields preserved', 'explicit JSON copy export', 'pending fixture picker protects source and visual controls', 'laptop/narrow process and simulation', 'network/process guards unused'], errors, requests }, null, 2));
  await electron.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.destroy(); }); await electron.close();
});

test('capture approved process reference and actual Electron comparison', { timeout: 30_000 }, async () => {
  await readFile(join(proof, '10-process-comparison.png'));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    await page.goto(`file://${resolve('docs/pr-workflows/presentation.html')}`); await page.locator('#contents-open').click(); await page.locator('#contents-list button').filter({ hasText: 'Interactive visual editor' }).click();
    await page.screenshot({ path: join(proof, 'reference-process.png'), fullPage: true });
    await writeFile(join(proof, 'comparison.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><title>Process comparison</title><style>body{margin:24px;background:#F2EADE;color:#604939;font:16px system-ui}main{display:grid;grid-template-columns:1fr 1fr;gap:24px}img{width:100%}h1{font-size:24px}h2{font-size:18px}</style><h1>Repo Chap ordered process editor</h1><main><section><h2>Approved presentation reference</h2><img src="reference-process.png" alt="Approved process and action inspector concept"></section><section><h2>Actual Electron application</h2><img src="10-process-comparison.png" alt="Actual ordered rule editor and action inspector"></section></main></html>');
    await page.setViewportSize({ width: 1800, height: 1100 }); await page.goto(`file://${join(proof, 'comparison.html')}`); await page.screenshot({ path: join(proof, 'comparison-process.png'), fullPage: true });
  } finally { await browser.close(); }
});

test('focused inspector drafts participate in save, leave protection, reset, export and simulation', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'repo-chap-inspector-ui-'));
  const original = await loadWorkflow(resolve(workflowPath));
  for (const file of original.files) { await mkdir(dirname(join(root, file.path)), { recursive: true }); await writeFile(join(root, file.path), file.text); }
  const env: Record<string, string> = { REPO_CHAP_DESKTOP_DATA: join(root, 'profile') };
  for (const key of ['PATH', 'DISPLAY', 'HOME', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[key]) env[key] = process.env[key]!;
  const electron = await _electron.launch({ executablePath, args: [...(packaged ? [] : [resolve('apps/desktop')]), '--workflow', join(root, workflowPath), '--repo-root', root], env });
  t.after(async () => { await electron.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.destroy(); }).catch(() => {}); await electron.close().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const page = await electron.firstWindow(); await electron.context().setOffline(true);
  const snapshot = () => page.evaluate(async () => (await window.repoChap.current()).snapshot!);
  const disk = async () => JSON.parse(await readFile(join(root, workflowPath), 'utf8'));
  await expect(page.locator('#validation-title')).toHaveText('Validation passed'); await page.locator('#process-tab').click(); await page.locator('#action-select').selectOption('wait_review');
  const time = page.locator('#setting-reviewWaitSeconds');
  await time.fill('77'); await expect(page.locator('#dirty-state')).toHaveText('1 unsaved action setting(s)'); await expect(page.locator('#save')).toBeEnabled();
  await time.press('Control+s'); await expect(page.locator('#message')).toHaveText('Saved all changed files.');
  assert.equal((await snapshot()).workflow!.settings.reviewWaitSeconds, 77); assert.equal((await disk()).settings.reviewWaitSeconds, 77); await expect(time).toHaveValue('77'); await expect(time).toBeFocused();
  await time.press('End'); await time.press('8'); await expect(time).toHaveValue('778'); await expect(page.locator('#dirty-state')).toHaveText('1 unsaved action setting(s)');
  await page.locator('#save').click(); await expect(page.locator('#message')).toHaveText('Saved all changed files.'); assert.equal((await disk()).settings.reviewWaitSeconds, 778); await expect(time).toHaveValue('778');
  await page.screenshot({ path: join(proof, '12-focused-inspector-saved.png'), fullPage: true });
  await page.locator('#action-select').selectOption('review'); const prompt = page.locator('#action-prompt'), context = page.locator('#action-context');
  await prompt.fill('review.md'); await prompt.press('Control+s'); await expect(page.locator('#message')).toHaveText('Saved all changed files.');
  assert.equal((await snapshot()).workflow!.actions.review!.prompt, 'review.md'); assert.equal((await disk()).actions.review.prompt, 'review.md'); await expect(prompt).toBeFocused(); await expect(prompt).toHaveValue('review.md');
  await context.fill('review.md\nprompts/review.md'); await context.press('Control+s'); await expect(page.locator('#message')).toHaveText('Saved all changed files.');
  assert.deepEqual((await snapshot()).workflow!.actions.review!.contextFiles, ['review.md', 'prompts/review.md']); assert.deepEqual((await disk()).actions.review.contextFiles, ['review.md', 'prompts/review.md']); await expect(context).toHaveValue('review.md\nprompts/review.md'); await expect(context).toBeFocused();
  await page.locator('#action-select').selectOption('wait_review'); await time.fill('91');
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close()); await expect(page.getByRole('dialog')).toContainText('Action inspector: 1 unsaved setting(s)'); await page.keyboard.press('Escape'); await expect(time).toHaveValue('91'); await expect(page.locator('#dirty-state')).toHaveText('1 unsaved action setting(s)');
  await page.locator('#open-workflow').click(); await expect(page.getByRole('dialog')).toContainText('Action inspector: 1 unsaved setting(s)'); await page.keyboard.press('Escape'); await expect(time).toHaveValue('91');
  await page.locator('#reset').click(); await page.keyboard.press('Escape'); await expect(time).toHaveValue('91');
  await page.locator('#reset').click(); await page.getByRole('dialog').getByRole('button', { name: 'Reset workflow', exact: true }).click(); await expect(time).toHaveValue('778'); await expect(page.locator('#dirty-state')).toHaveText('All changes saved');
  await time.fill(''); await time.press('Control+s'); await expect(page.locator('#message')).toContainText('finite number'); await expect(time).toHaveValue(''); await expect(page.locator('#dirty-state')).toHaveText('1 unsaved action setting(s)'); assert.equal((await disk()).settings.reviewWaitSeconds, 778);
  await page.locator('#action-select').selectOption('review'); await expect(page.locator('#action-select')).toHaveValue('wait_review'); await expect(time).toHaveValue('');
  await page.screenshot({ path: join(proof, '13-partial-setting-retained.png'), fullPage: true });
  await page.locator('#discard-settings').click(); await expect(time).toHaveValue('778'); await expect(page.locator('#dirty-state')).toHaveText('All changes saved');
  const exported = join(root, 'workflow-copy.json'); await electron.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, exported);
  await time.fill('88'); await page.locator('#export').click(); await expect(page.locator('#message')).toContainText('Referenced files were not copied');
  assert.equal(JSON.parse(await readFile(exported, 'utf8')).settings.reviewWaitSeconds, 88); assert.equal((await snapshot()).workflow!.settings.reviewWaitSeconds, 88); assert.equal((await disk()).settings.reviewWaitSeconds, 778);
  await page.locator('#simulation-tab').click();
  const pending = JSON.parse(await readFile('fixtures/replay/handoff.json', 'utf8')); pending.observations[0].facts.externalReviewPending = true; pending.observations[0].externalReviewStartedAt = '2026-05-01T11:55:00Z';
  const fixturePath = join(root, 'pending.json'); await writeFile(fixturePath, JSON.stringify(pending)); await electron.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, fixturePath);
  await page.locator('#load-fixture').click(); await expect(page.locator('#fixture-name')).toContainText('pending.json');
  await page.locator('#process-tab').click(); await time.fill('92'); await page.locator('#simulation-tab').click(); await page.locator('#simulate').click(); await expect(page.locator('#message')).toHaveText('Simulation finished. Nothing was sent.');
  await expect(page.locator('#simulation-result')).toContainText('Next wake 2026-05-01T12:01:32.000Z'); assert.equal((await snapshot()).workflow!.settings.reviewWaitSeconds, 92);
  await page.locator('#process-tab').click(); await time.fill('93');
  await electron.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await page.locator('#open-workflow').click(); await page.getByRole('dialog').getByRole('button', { name: 'Save all and open', exact: true }).click(); await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(time).toHaveValue('93'); await expect(page.locator('#dirty-state')).toHaveText('All changes saved'); assert.equal((await disk()).settings.reviewWaitSeconds, 93);
  await time.fill('94'); await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close()); await page.getByRole('dialog').getByRole('button', { name: 'Save all and close', exact: true }).click();
  await expect.poll(async () => (await disk()).settings.reviewWaitSeconds).toBe(94);
  assert.equal((await loadWorkflow(join(root, workflowPath), { repositoryRoot: root })).workflow.settings.reviewWaitSeconds, 94);
  await writeFile(join(proof, 'inspector-result.json'), JSON.stringify({ passed: true, packaged: !!packaged, checks: ['focused numeric Ctrl+S and continued typing', 'Save button accepts focused text', 'focused prompt/context Ctrl+S', 'close/open/reset cancel retains pending field', 'reset discards pending field', 'invalid partial value retained and blocks inspector replacement', 'explicit discard', 'export captures pending value without changing original disk', 'simulation uses pending settings', 'save-and-open cancelled picker preserves saved value', 'save-and-close persists pending value', 'reopened package matches saved value'] }, null, 2));
});
