import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron, expect } from '@playwright/test';
import { loadWorkflow } from '@repo-chap/workflow';
import type { ConversationTurn } from '../apps/desktop/src/conversation-protocol.ts';

const workflowPath = 'docs/pr-workflows/examples/team-pr/workflow.json';
const markdownPath = 'docs/pr-workflows/examples/team-pr/review.md';
const packaged = process.env.REPO_CHAP_DESKTOP_EXECUTABLE;
const proof = join(process.env.REPO_CHAP_DESKTOP_PROOF ?? await mkdtemp(join(tmpdir(), 'repo-chap-author-proof-')), 'authoring');
await mkdir(proof, { recursive: true });
const fixture = { schemaVersion: 1, now: '2026-05-01T12:00:00Z', observations: [{ facts: { lifecycle: 'open', draft: false, evidenceComplete: true, young: false, headDebouncing: false, conflict: false, unaddressedReview: false, externalReviewPending: false } }], control: { memory: { classificationCurrent: true, reviewCurrent: false, packetCurrent: false, repairSuppressed: false } }, expected: { status: 'waiting', selectedRuleIds: ['review_current_head'], proposedEffects: [] } };

async function launch(t: { after(fn: () => Promise<void>): void }, name: string, provider: 'codex' | 'claude') {
  const workspace = await mkdtemp(join(tmpdir(), 'repo-chap-author-ui-')), root = join(workspace, 'cedar-labs', 'fictional-project');
  const pkg = await loadWorkflow(resolve(workflowPath));
  for (const file of pkg.files) { await mkdir(dirname(join(root, file.path)), { recursive: true }); await writeFile(join(root, file.path), file.text); }
  const executable = join(workspace, 'provider'), log = join(workspace, 'calls.jsonl'), planFile = join(workspace, 'plan.json'), modeFile = join(workspace, 'mode');
  await writeFile(modeFile, 'author');
  await writeFile(executable, `#!${process.execPath}\nglobal.fixture=${JSON.stringify({ provider, modeFile, planFile, log, childPid: join(workspace, 'child.pid') })};require(${JSON.stringify(resolve('tests/helpers/fake-conversation.cjs'))});`, { mode: 0o700 });
  const settings = join(workspace, 'providers.json');
  await writeFile(settings, JSON.stringify({ schemaVersion: 1, profiles: { author: { provider, executable, model: 'fictional-model', effort: 'medium', timeoutMs: 60_000, maxOutputBytes: 4 * 1024 * 1024, maxAttempts: 1, maximumCapabilities: [] } } }), { mode: 0o600 });
  const env: Record<string, string> = { REPO_CHAP_DESKTOP_DATA: join(workspace, 'private') };
  for (const key of ['PATH', 'DISPLAY', 'HOME', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[key]) env[key] = process.env[key]!;
  const electron = await _electron.launch({ executablePath: packaged ?? createRequire(resolve('apps/desktop/package.json'))('electron'), args: [...(packaged ? [] : [resolve('apps/desktop')]), '--no-sandbox', '--inspect=0', '--remote-debugging-port=0', '--workflow', join(root, workflowPath), '--repo-root', root], env });
  const page = await electron.firstWindow(); const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await electron.context().setOffline(true);
  t.after(async () => {
    if (!page.isClosed()) await page.screenshot({ path: join(proof, `${name}-last.png`), fullPage: true, timeout: 2000 }).catch(() => {});
    await writeFile(join(proof, `${name}-calls.jsonl`), await readFile(log, 'utf8').catch(() => ''));
    await page.evaluate(async () => { const { conversation } = await window.repoChapConversation.current(); if (conversation?.activeTurnId) await window.repoChapConversation.cancel(conversation.id, conversation.activeTurnId); }).catch(() => {});
    await electron.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
    await electron.close().catch(() => {}); await rm(workspace, { recursive: true, force: true });
  });
  await expect(page.locator('#validation-title')).toHaveText('Validation passed');
  const snapshot = () => page.evaluate(async () => (await window.repoChap.current()).snapshot!);
  const last = () => page.evaluate(async () => (await window.repoChapConversation.current()).conversation!.history.findLast((entry): entry is ConversationTurn => entry.kind === 'turn')!);
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const results = async () => (await calls()).filter(item => item.authoringResult).map(item => item.authoringResult);
  const send = async (id: string, steps: unknown[], mode = 'author') => {
    await writeFile(planFile, JSON.stringify({ id, steps })); await writeFile(modeFile, mode);
    await page.locator('#conversation-question').fill(id); await page.locator('#conversation-send').click();
    await expect.poll(async () => (await last())?.prompt).toBe(id);
  };
  const fresh = async () => { await page.locator('#conversation-fresh').click(); await expect.poll(async () => (await page.evaluate(() => window.repoChapConversation.current())).conversation!.requiresFresh).toBe(false); };
  await page.locator('#conversation-tab').click();
  await electron.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, settings);
  await page.locator('#conversation-load-profiles').click(); await page.locator('#conversation-profile').selectOption('author'); await page.locator('#conversation-use-profile').click();
  return { workspace, root, page, electron, snapshot, last, calls, results, send, fresh, errors, requests, pkg };
}

for (const provider of ['codex', 'claude'] as const) test(`actual Electron ${provider} authors, observes failure, revises and reruns with saved CLI parity`, { timeout: 180_000 }, async t => {
  const f = await launch(t, `${provider}-cycle`, provider), { page } = f;
  const gate = join(f.workspace, 'revise');
  await f.send(`${provider}-cycle`, [
    { action: { kind: 'read', paths: [markdownPath] } },
    { action: { kind: 'visual', edit: { kind: 'action', actionId: 'classify', field: 'onSuccess', value: 'review' } } },
    { action: { kind: 'visual', edit: { kind: 'ruleAction', ruleId: 'review_current_head', actionId: 'handoff' } } },
    { action: { kind: 'edit', changes: [{ path: markdownPath, text: '# Fictional review\n\nExplain the actual test outcome.\n' }] } },
    { action: { kind: 'createFixture', path: 'review-test.json', text: JSON.stringify(fixture, null, 2) + '\n' } },
    { action: { kind: 'test', fixturePath: 'review-test.json' } },
    { gate, action: { kind: 'visual', edit: { kind: 'ruleAction', ruleId: 'review_current_head', actionId: 'park' } } },
    { action: { kind: 'test', fixturePath: 'review-test.json' } },
    { duplicateOf: 3 }, { action: { kind: 'validate' } },
  ]);
  await expect.poll(async () => (await f.snapshot()).simulation?.comparison?.passed, { timeout: 15000 }).toBe(false);
  await page.locator('#simulation-tab').click();
  await expect(page.locator('#simulation-result')).toContainText('Offline test failed');
  await expect(page.getByRole('table', { name: 'Expected and actual outcomes' })).toContainText('needs_result');
  await page.screenshot({ path: join(proof, `${provider}-01-failed-test.png`), fullPage: true });
  assert.equal((await f.snapshot()).files.filter(file => file.dirty).length, 3);
  assert.equal(await readFile(join(f.root, markdownPath), 'utf8'), f.pkg.files.find(file => file.path === markdownPath)!.text);
  await writeFile(gate, 'continue'); await expect.poll(async () => (await f.last()).status).toBe('completed');
  const results = await f.results(); assert.equal(results.length, 10);
  assert.equal(results[5].data.comparison.passed, false); assert.equal(results[7].data.comparison.passed, true);
  assert.deepEqual(results[3].receipt, results[8].receipt);
  await expect(page.locator('#simulation-result')).toContainText('Offline test passed');
  await expect(page.locator('#simulation-result')).toContainText('review_current_head');
  await page.screenshot({ path: join(proof, `${provider}-02-passed-test.png`), fullPage: true });
  await page.locator('#conversation-tab').click(); await expect(page.locator('.turn-answer').last()).toContainText('actual offline test failed'); await expect(page.locator('.turn-answer').last()).toContainText('actual offline test passed');
  await page.screenshot({ path: join(proof, `${provider}-03-conversation-evidence.png`), fullPage: true });
  await page.locator('#undo').focus(); await page.keyboard.press('Enter');
  assert.equal((await f.snapshot()).workflow!.rules.find(rule => rule.id === 'review_current_head')!.action, 'handoff');
  assert.equal((await f.snapshot()).simulationCurrent, false);
  await page.locator('#source-tab').click(); await page.getByRole('button', { name: workflowPath, exact: true }).first().click();
  const source = JSON.parse(await page.locator('#source').inputValue()); source.rules.find((rule: any) => rule.id === 'review_current_head').action = 'park';
  await page.locator('#source').fill(JSON.stringify(source, null, 2)); await expect(page.locator('#validation-title')).toHaveText('Validation passed');
  await page.getByRole('button', { name: 'review-test.json', exact: true }).first().click();
  const expectations = JSON.parse(await page.locator('#source').inputValue()); expectations.expected.status = 'closed';
  await page.locator('#source').fill(JSON.stringify(expectations, null, 2)); await expect(page.locator('#dirty-state')).toContainText('unsaved');
  assert.equal((await f.snapshot()).simulationCurrent, false);
  await page.locator('#simulation-tab').click(); await page.locator('#run-test').click(); await expect(page.locator('#simulation-result')).toContainText('Offline test failed');
  await page.locator('#undo').click(); await page.locator('#run-test').click(); await expect(page.locator('#simulation-result')).toContainText('Offline test passed');
  await page.locator('#save').click(); await expect(page.locator('#message')).toHaveText('Saved all changed files.');
  const record = (await f.snapshot()).simulation!;
  const cli = JSON.parse(execFileSync(process.execPath, [resolve('apps/cli/dist/cli.js'), 'replay', join(f.root, workflowPath), '--repo-root', f.root, '--fixture', join(f.root, 'review-test.json'), '--json'], { encoding: 'utf8' }));
  assert.deepEqual(cli, { ...record.result, comparison: record.comparison });
  await page.locator('#source-tab').click(); await page.getByRole('button', { name: workflowPath, exact: true }).first().click(); await page.locator('#source').fill('{ broken intermediate JSON');
  await expect(page.locator('#validation-title')).toContainText('validation error'); await page.screenshot({ path: join(proof, `${provider}-04-invalid-recovery.png`), fullPage: true });
  await page.locator('#undo').click(); await expect(page.locator('#validation-title')).toHaveText('Validation passed');
  await page.getByRole('button', { name: markdownPath, exact: true }).first().click(); await page.locator('#source').fill('# Discard this local draft');
  await page.locator('#discard').click(); await page.getByRole('dialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
  assert.equal((await f.snapshot()).files.find(file => file.path === markdownPath)!.text, '# Fictional review\n\nExplain the actual test outcome.\n');
  await f.electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(390, 820));
  await page.locator('#simulation-tab').click(); await page.locator('#run-test').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#simulation-result')).toContainText('Offline test passed');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(proof, `${provider}-05-narrow-keyboard.png`), fullPage: true });
  const chatRequests = (await f.calls()).filter(call => call.message?.method === 'turn/start' || call.message?.type === 'user');
  assert.equal(chatRequests.length, 1); assert.deepEqual(f.errors, []); assert.deepEqual(f.requests, []);
});

test('actual Electron preserves focused newer human fields, partial capture, reversal and cancellation', { timeout: 150_000 }, async t => {
  const f = await launch(t, 'human-input', 'codex'), { page } = f;
  const gate = join(f.workspace, 'edit');
  await f.send('capture-newer-human-input', [{ gate, action: { kind: 'visual', edit: { kind: 'setting', field: 'reviewWaitSeconds', value: 500 } } }]);
  await expect.poll(async () => (await f.calls()).some(call => call.waitingForStep === 0)).toBe(true);
  await page.locator('#process-tab').click(); await page.locator('#action-select').selectOption('wait_review');
  await page.locator('#setting-reviewWaitSeconds').fill('60'); await page.locator('#setting-reviewDeadlineSeconds').fill('');
  await writeFile(gate, 'continue'); await expect.poll(async () => (await f.last()).status).toBe('completed');
  const result = (await f.results()).at(-1);
  assert.equal(result.receipt.status, 'rejected'); assert.equal(result.context.pendingHumanInput[0].value, '');
  assert.equal((await f.snapshot()).workflow!.settings.reviewWaitSeconds, 60);
  await expect(page.locator('#setting-reviewDeadlineSeconds')).toHaveValue('');
  await page.locator('#setting-reviewWaitSeconds').fill(String(f.pkg.workflow.settings.reviewWaitSeconds));
  await page.locator('#setting-reviewDeadlineSeconds').fill(String(f.pkg.workflow.settings.reviewDeadlineSeconds));
  await page.locator('#apply-settings').click();
  assert.equal((await f.snapshot()).workflow!.settings.reviewWaitSeconds, f.pkg.workflow.settings.reviewWaitSeconds);
  await page.screenshot({ path: join(proof, 'human-01-partial-capture-reversal.png'), fullPage: true });
  await page.locator('#conversation-tab').click();
  const gate2 = join(f.workspace, 'stale');
  await f.send('stale-human-text', [{ gate: gate2, action: { kind: 'visual', edit: { kind: 'setting', field: 'reviewWaitSeconds', value: 900 } } }]);
  await page.locator('#process-tab').click(); await page.locator('#setting-reviewWaitSeconds').fill('77');
  await writeFile(gate2, 'continue'); await expect.poll(async () => (await f.last()).status).toBe('completed');
  assert.equal((await f.results()).at(-1).receipt.status, 'rejected'); assert.match((await f.results()).at(-1).receipt.message, /revision changed/);
  assert.equal((await f.snapshot()).workflow!.settings.reviewWaitSeconds, 77);
  await page.locator('#conversation-tab').click();
  await f.send('cancel-after-edit', [{ action: { kind: 'edit', changes: [{ path: markdownPath, text: '# Kept after cancellation\n' }] } }], 'author-cancel');
  await expect.poll(async () => (await f.snapshot()).files.find(file => file.path === markdownPath)!.text).toBe('# Kept after cancellation\n');
  await page.locator('#process-tab').click(); await page.locator('#setting-reviewWaitSeconds').fill('');
  await page.locator('#conversation-cancel').focus(); await page.keyboard.press('Enter'); await expect.poll(async () => (await f.last()).status).toBe('cancelled');
  await expect(page.locator('#setting-reviewWaitSeconds')).toHaveValue('');
  assert.equal((await f.snapshot()).files.find(file => file.path === markdownPath)!.text, '# Kept after cancellation\n');
  await page.screenshot({ path: join(proof, 'human-02-cancel-keeps-edit-and-field.png'), fullPage: true });
  await page.locator('#discard-settings').click(); await page.locator('#undo').click();
  assert.notEqual((await f.snapshot()).files.find(file => file.path === markdownPath)!.text, '# Kept after cancellation\n');
  assert.deepEqual(f.errors, []); assert.deepEqual(f.requests, []);
});

test('actual Electron retains applied tool receipts after a late native transcript failure', { timeout: 90_000 }, async t => {
  const f = await launch(t, 'late-failure', 'codex'), { page } = f;
  await f.send('late-provider-failure', [{ action: { kind: 'edit', changes: [{ path: markdownPath, text: '# Applied before failed audit\n' }] } }], 'author-native-denial');
  await expect.poll(async () => (await f.last()).status).toBe('error');
  await expect(page.locator('#conversation-failure')).toContainText('native');
  assert.equal((await f.snapshot()).files.find(file => file.path === markdownPath)!.text, '# Applied before failed audit\n');
  assert.equal((await f.snapshot()).authoringReceipts[0]!.status, 'applied');
  await expect(page.locator('#authoring-summary')).toContainText(markdownPath);
  await page.screenshot({ path: join(proof, 'late-01-applied-edits-survive-failure.png'), fullPage: true });
  await f.fresh(); await f.send('duplicate-after-failed-provider', [{ action: { kind: 'read', paths: [markdownPath] } }]);
  await expect.poll(async () => (await f.last()).status).toBe('completed');
  assert.equal((await f.snapshot()).undoCount, 1);
  await page.locator('#undo').click(); assert.notEqual((await f.snapshot()).files.find(file => file.path === markdownPath)!.text, '# Applied before failed audit\n');
  assert.deepEqual(f.errors, []); assert.deepEqual(f.requests, []);
});

test('actual Electron keeps unconfirmed display receipts and never repeats an undone duplicate', { timeout: 90_000 }, async t => {
  const f = await launch(t, 'display-ack', 'claude'), { page } = f;
  await f.electron.evaluate(({ ipcMain }) => { ipcMain.removeHandler('conversation:confirm-authoring'); ipcMain.handle('conversation:confirm-authoring', () => {}); });
  const steps = [{ action: { kind: 'edit', changes: [{ path: markdownPath, text: '# Applied with missing acknowledgment\n' }] } }];
  await f.send('lost-display-ack', steps); await expect.poll(async () => (await f.last()).status).toBe('completed');
  const first = (await f.snapshot()).authoringReceipts[0]!;
  assert.equal(first.status, 'applied'); assert.equal(first.display, 'unconfirmed');
  assert.equal((await f.snapshot()).undoCount, 1);
  await page.locator('.authoring-receipts summary').click(); await expect(page.locator('#authoring-activity')).toContainText('Display unconfirmed');
  await page.screenshot({ path: join(proof, 'display-01-unconfirmed-host-receipt.png'), fullPage: true });
  await page.locator('#undo').click();
  await f.send('lost-display-ack', steps); await expect.poll(async () => (await f.last()).status).toBe('completed');
  assert.equal((await f.snapshot()).undoCount, 0);
  assert.notEqual((await f.snapshot()).files.find(file => file.path === markdownPath)!.text, '# Applied with missing acknowledgment\n');
  assert.deepEqual((await f.results()).at(-1).receipt, first);
  await page.locator('#simulation-tab').click(); await page.locator('#new-fixture-path').fill('manual-test.json'); await page.locator('#create-fixture').click();
  await expect(page.locator('#source-label')).toHaveText('manual-test.json');
  assert.equal((await f.snapshot()).files.find(file => file.path === 'manual-test.json')!.dirty, true);
  await assert.rejects(readFile(join(f.root, 'manual-test.json')));
  await page.locator('#undo').click(); assert.equal((await f.snapshot()).files.some(file => file.path === 'manual-test.json'), false);
  assert.deepEqual(f.errors, []); assert.deepEqual(f.requests, []);
});

test('actual Electron Undo restores human Markdown after a batch removes its final reference', { timeout: 90_000 }, async t => {
  const f = await launch(t, 'orphan-undo', 'claude'), { page } = f;
  const saved = f.pkg.files.find(file => file.path === markdownPath)!.text;
  await page.locator('#source-tab').click(); await page.getByRole('button', { name: markdownPath, exact: true }).first().click();
  await page.locator('#source').fill('# Unsaved human work\n');
  await expect.poll(async () => (await f.snapshot()).files.find(file => file.path === markdownPath)!.text).toBe('# Unsaved human work\n');
  const workflow = JSON.parse((await f.snapshot()).files.find(file => file.path === workflowPath)!.text); workflow.actions.review.contextFiles = [];
  await page.locator('#conversation-tab').click();
  await f.send('remove-last-reference', [{ action: { kind: 'edit', changes: [{ path: workflowPath, text: JSON.stringify(workflow) }, { path: markdownPath, text: saved }] } }]);
  await expect.poll(async () => (await f.last()).status).toBe('completed');
  assert.equal((await f.snapshot()).files.some(file => file.path === markdownPath), false);
  await page.locator('#undo').focus(); await page.keyboard.press('Enter');
  await page.locator('#source-tab').click(); await page.getByRole('button', { name: markdownPath, exact: true }).first().click();
  await expect(page.locator('#source')).toHaveValue('# Unsaved human work\n');
  assert.equal((await f.snapshot()).files.find(file => file.path === markdownPath)!.dirty, true);
  assert.equal(await readFile(join(f.root, markdownPath), 'utf8'), saved);
  await page.screenshot({ path: join(proof, 'recovery-01-restored-human-draft.png'), fullPage: true });
  await page.locator('#save').click(); await expect(page.locator('#message')).toHaveText('Saved all changed files.');
  await expect(page.locator('#undo')).toBeDisabled();
  await expect(page.locator('#authoring-summary')).toContainText('All changes are saved. No draft operations are available to undo.');
  assert.equal(await readFile(join(f.root, markdownPath), 'utf8'), '# Unsaved human work\n');
  await page.screenshot({ path: join(proof, 'recovery-02-saved-receipt-history.png'), fullPage: true });
  assert.deepEqual(f.errors, []); assert.deepEqual(f.requests, []);
});

test('actual Electron reports the receipt limit and keeps retry, Cancel and manual Save responsive', { timeout: 90_000 }, async t => {
  const f = await launch(t, 'receipt-limit', 'codex'), { page } = f;
  await page.evaluate(async () => {
    const snapshot = (await window.repoChap.current()).snapshot!;
    for (let index = 0; index < 128; index++) {
      const result = await window.repoChap.author({ operationId: `prepare-limit-${index}`, expected: { sessionId: snapshot.sessionId, revision: snapshot.revision }, action: { kind: 'read', paths: [] } });
      if (result.error) throw new Error(result.error);
    }
  });
  const steps = [{ action: { kind: 'edit', changes: [{ path: markdownPath, text: 'must not apply' }] } }];
  for (let attempt = 1; attempt <= 2; attempt++) {
    await f.send('receipt-limit', steps);
    await expect.poll(async () => (await f.results()).length, { timeout: 10000 }).toBe(attempt);
    await expect.poll(async () => (await f.last()).status).toBe('completed');
    assert.equal((await f.results()).at(-1).receipt.status, 'rejected');
    assert.match((await f.results()).at(-1).receipt.message, /128 authoring receipts/);
  }
  await expect(page.locator('#message')).toContainText('Save and reopen the workflow');
  await page.screenshot({ path: join(proof, 'recovery-03-receipt-limit.png'), fullPage: true });
  await f.send('cancel-after-limit', [{ gate: join(f.workspace, 'never-continue'), action: { kind: 'validate' } }]);
  await expect.poll(async () => (await f.calls()).some(call => call.waitingForStep === 0)).toBe(true);
  await page.locator('#conversation-cancel').focus(); await page.keyboard.press('Enter');
  await expect.poll(async () => (await f.last()).status).toBe('cancelled');
  await page.locator('#source-tab').click(); await page.getByRole('button', { name: markdownPath, exact: true }).first().click();
  await page.locator('#source').fill('# Manual Save after the receipt limit\n');
  await page.locator('#save').click(); await expect(page.locator('#message')).toHaveText('Saved all changed files.');
  assert.equal(await readFile(join(f.root, markdownPath), 'utf8'), '# Manual Save after the receipt limit\n');
  assert.equal((await f.snapshot()).authoringReceipts.length, 128);
  await page.screenshot({ path: join(proof, 'recovery-04-manual-save-after-limit.png'), fullPage: true });
  assert.deepEqual(f.errors, []); assert.deepEqual(f.requests, []);
});
