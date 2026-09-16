import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron, expect } from '@playwright/test';
import { loadWorkflow } from '@repo-chap/workflow';
import type { ConversationResult, ConversationTurn } from '../apps/desktop/src/conversation-protocol.ts';

const workflowPath = 'docs/pr-workflows/examples/team-pr/workflow.json';
const reviewPath = 'docs/pr-workflows/examples/team-pr/review.md';
const packagedExecutable = process.env.REPO_CHAP_DESKTOP_EXECUTABLE;
const executablePath: string = packagedExecutable ?? createRequire(resolve('apps/desktop/package.json'))('electron');
const proof = process.env.REPO_CHAP_DESKTOP_PROOF ?? await mkdtemp(join(tmpdir(), 'repo-chap-chat-proof-'));
await mkdir(proof, { recursive: true });
async function launch(t: { after(fn: () => Promise<void>): void }, name: string) {
  const workspace = await mkdtemp(join(tmpdir(), 'repo-chap-chat-electron-'));
  const root = join(workspace, 'starlight-labs', 'workflow-discussion');
  const pkg = await loadWorkflow(resolve(workflowPath));
  for (const file of pkg.files) { await mkdir(dirname(join(root, file.path)), { recursive: true }); await writeFile(join(root, file.path), file.text); }
  const profiles: Record<string, unknown> = {};
  for (const provider of ['codex', 'claude']) {
    const executable = join(workspace, `${provider}-fixture`), modeFile = join(workspace, `${provider}.mode`);
    await writeFile(modeFile, 'plain');
    await writeFile(executable, `#!${process.execPath}\nglobal.fixture=${JSON.stringify({ provider, modeFile, noTools: true, log: join(workspace, `${provider}.jsonl`), childPid: join(workspace, `${provider}.pid`) })};require(${JSON.stringify(resolve('tests/helpers/fake-conversation.cjs'))});`, { mode: 0o700 });
    profiles[`${provider}_author`] = { provider, executable, model: 'fictional-model', effort: 'medium', timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024, maxAttempts: 1, maximumCapabilities: [] };
  }
  const settings = join(workspace, 'providers.json');
  await writeFile(settings, JSON.stringify({ schemaVersion: 1, profiles }), { mode: 0o600 });
  const env: Record<string, string> = { REPO_CHAP_DESKTOP_DATA: join(workspace, 'profile') };
  for (const key of ['PATH', 'DISPLAY', 'HOME', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[key]) env[key] = process.env[key]!;
  const electron = await _electron.launch({ executablePath, args: [...(packagedExecutable ? [] : [resolve('apps/desktop')]), '--workflow', join(root, workflowPath), '--repo-root', root], env });
  const page = await electron.firstWindow();
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await electron.context().setOffline(true);
  t.after(async () => {
    if (!page.isClosed()) {
      await page.screenshot({ path: join(proof, `${name}-last.png`), fullPage: true, timeout: 2000 }).catch(() => {});
      await writeFile(join(proof, `${name}-last.txt`), await page.locator('body').innerText({ timeout: 2000 }).catch(() => 'Window unavailable.'));
      await page.evaluate(async () => { const { conversation } = await window.repoChapConversation.current(); if (conversation?.activeTurnId) await window.repoChapConversation.cancel(conversation.id, conversation.activeTurnId); }).catch(() => {});
    }
    for (const provider of ['codex', 'claude']) {
      const data = await readFile(join(workspace, `${provider}.jsonl`), 'utf8').catch(() => '');
      await writeFile(join(proof, `${name}-${provider}-calls.jsonl`), data);
    }
    await electron.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
    await electron.close().catch(() => {});
    await rm(workspace, { recursive: true, force: true });
  });
  await expect(page.locator('#validation-title')).toHaveText('Validation passed');
  const document = () => page.evaluate(async () => (await window.repoChap.current()).snapshot!);
  const chat = (): Promise<ConversationResult> => page.evaluate(() => window.repoChapConversation.current());
  const last = async (): Promise<ConversationTurn | undefined> => (await chat()).conversation?.history.findLast((entry): entry is ConversationTurn => entry.kind === 'turn');
  const mode = (provider: string, value: string) => writeFile(join(workspace, `${provider}.mode`), value);
  const calls = async (provider: string) => (await readFile(join(workspace, `${provider}.jsonl`), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const pick = async (path: string) => electron.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, path);
  const choose = async (provider: string) => {
    await page.locator('#conversation-profile').selectOption(`${provider}_author`);
    await page.locator('#conversation-use-profile').click();
    await expect(page.locator('#conversation-selected-provider')).toContainText(`Profile ${provider}_author`);
  };
  const send = async (provider: string, value: string, prompt: string) => {
    await mode(provider, value); await page.locator('#conversation-question').fill(prompt); await page.locator('#conversation-send').click();
    await expect.poll(async () => (await last())?.prompt).toBe(prompt);
  };
  const completed = async () => { await expect.poll(async () => (await last())?.status).toBe('completed'); };
  const fresh = async () => { const previous = (await chat()).conversation!.id; await page.locator('#conversation-fresh').click(); await expect.poll(async () => (await chat()).conversation?.id).not.toBe(previous); await expect.poll(async () => (await chat()).conversation?.requiresFresh).toBe(false); };
  const pid = (provider: string) => readFile(join(workspace, `${provider}.pid`), 'utf8').then(Number).catch(() => 0);
  const gone = async (child: number) => { await expect.poll(() => { try { process.kill(child, 0); return false; } catch { return true; } }).toBe(true); };
  await page.locator('#conversation-tab').click(); await pick(settings); await page.locator('#conversation-load-profiles').click();
  await expect(page.locator('#conversation-profile option')).toHaveCount(3);
  assert.equal((await calls('codex')).length + (await calls('claude')).length, 0);
  return { workspace, root, pkg, electron, page, errors, requests, document, chat, last, mode, calls, pick, choose, send, completed, fresh, pid, gone };
}
function contexts(calls: any[]): any[] {
  return calls.flatMap(call => {
    const message = call.message;
    const text = message?.method === 'turn/start' ? message.params.input[0].text : message?.type === 'user' ? message.message.content : null;
    if (typeof text !== 'string') return [];
    const captured = text.split('Current immutable workflow context:\n')[1]?.split('\n\nQuestion:\n')[0]?.split('\n\nEarlier visible conversation excerpt.')[0];
    return captured ? [JSON.parse(captured)] : [];
  });
}

test('actual Electron discusses current drafts and actual simulation evidence through both provider adapters', { timeout: 180_000 }, async t => {
  const f = await launch(t, 'conversation-flow'), { page } = f;
  await f.choose('codex'); assert.equal((await f.calls('codex')).length, 0);
  await page.locator('#simulation-tab').click(); await f.pick(resolve('fixtures/replay/conflict.json')); await page.locator('#load-fixture').click();
  await page.locator('#simulate').click(); await expect(page.locator('#message')).toHaveText('Simulation finished. Nothing was sent.');
  const tested = (await f.document()).simulation!;
  await page.locator('#source-tab').click(); await page.getByRole('button', { name: reviewPath, exact: true }).first().click();
  const draft = '# Fictional review guidance\n\nKeep the actual test clock in the explanation.\n';
  await page.locator('#source').fill(draft); await expect(page.locator('#dirty-state')).toContainText('unsaved');
  await page.locator('#conversation-tab').click(); await page.locator('.conversation-context summary').click();
  await page.locator('#conversation-rule').selectOption('conflict');
  for (const choice of await page.locator('#conversation-markdown input').all()) if (await choice.inputValue() !== reviewPath) await choice.uncheck();
  await expect(page.locator('#conversation-simulation-detail')).toContainText('Stale simulation');
  await f.send('codex', 'stream', 'Why does the conflict rule use this recorded clock?');
  await expect(page.locator('.turn-answer').last()).toContainText('A partial answer');
  await page.screenshot({ path: join(proof, 'conversation-01-codex-stream.png'), fullPage: true });
  await f.completed();
  const first = contexts(await f.calls('codex')).at(-1);
  assert.equal(first.selectedRule.id, 'conflict'); assert.equal(first.markdown[0].text, draft);
  assert.equal(first.simulation.status, 'stale'); assert.deepEqual(first.simulation.record, tested);
  const firstSession = (await f.chat()).conversation!.session!.id;
  await page.locator('#process-tab').click(); await page.locator('#action-select').selectOption('wait_review');
  await page.locator('#setting-reviewWaitSeconds').fill('60');
  await page.locator('#conversation-tab').evaluate(button => (button as HTMLButtonElement).click());
  await expect(page.locator('#conversation-view')).toBeVisible();
  assert.equal((await f.document()).workflow!.settings.reviewWaitSeconds, 60);
  await f.mode('codex', 'plain'); await page.locator('#conversation-question').fill('Use the newly captured wait setting.');
  await page.locator('#conversation-question').press('Control+Enter'); await expect.poll(async () => (await f.last())?.prompt).toBe('Use the newly captured wait setting.'); await f.completed();
  await expect(page.locator('#conversation-question')).toBeFocused();
  const followup = contexts(await f.calls('codex')).at(-1);
  assert.equal(JSON.parse(followup.workflow.text).settings.reviewWaitSeconds, 60);
  assert.ok(followup.document.token.revision > first.document.token.revision);
  assert.deepEqual(followup.simulation.record.token, tested.token);
  assert.equal((await f.chat()).conversation!.session!.id, firstSession);
  assert.ok((await f.calls('codex')).some(call => call.message?.method === 'thread/resume'));
  await page.locator('#process-tab').click();
  await page.locator('#setting-reviewWaitSeconds').fill('77');
  await page.locator('#setting-reviewDeadlineSeconds').fill('');
  const beforeCapture = (await f.calls('codex')).length;
  await page.locator('#conversation-tab').click();
  await expect(page.locator('#process-view')).toBeVisible();
  await expect(page.locator('#message')).toContainText('finite number');
  assert.equal((await f.document()).workflow!.settings.reviewWaitSeconds, 77);
  await expect(page.locator('#setting-reviewDeadlineSeconds')).toHaveValue('');
  assert.equal((await f.calls('codex')).length, beforeCapture);
  await page.locator('#setting-reviewWaitSeconds').fill('60');
  await page.locator('#setting-reviewWaitSeconds').press('End');
  await page.locator('#setting-reviewWaitSeconds').press('Backspace');
  await page.locator('#setting-reviewWaitSeconds').press('1');
  await page.locator('#setting-reviewDeadlineSeconds').fill('1800');
  await page.locator('#conversation-tab').click();
  await f.send('codex', 'plain', 'Use the newer value after partial inspector capture.'); await f.completed();
  assert.equal(JSON.parse(contexts(await f.calls('codex')).at(-1).workflow.text).settings.reviewWaitSeconds, 61);
  assert.equal((await f.document()).workflow!.settings.reviewWaitSeconds, 61);
  assert.equal(JSON.parse(await readFile(join(f.root, workflowPath), 'utf8')).settings.reviewWaitSeconds, f.pkg.workflow.settings.reviewWaitSeconds);
  await f.choose('claude'); assert.equal((await f.calls('claude')).length, 0);
  await expect(page.locator('.conversation-notice').last()).toContainText('separate session');
  await f.send('claude', 'stream', 'Explain this retained simulation using Claude.');
  await expect(page.locator('.turn-answer').last()).toContainText('A partial answer'); await f.completed();
  const claude = await f.calls('claude');
  assert.ok(claude.some(call => call.message?.type === 'user' && call.message.message.content.includes('"provider":"codex"')));
  assert.ok(claude.every(call => !call.args?.includes('--resume')));
  assert.notEqual((await f.chat()).conversation!.session!.id, firstSession);
  await page.locator('.conversation-turn details').last().locator('summary').click();
  await page.screenshot({ path: join(proof, 'conversation-02-provider-handoff.png'), fullPage: true });
  await f.send('claude', 'plain', 'Keep the same Claude session.'); await f.completed();
  assert.ok((await f.calls('claude')).some(call => call.args?.includes('--resume')));
  for (const provider of ['codex', 'claude']) {
    await f.choose(provider); await f.send(provider, 'input', `Ask for a rule using ${provider}.`);
    await expect(page.locator('#conversation-input')).toBeVisible();
    await page.screenshot({ path: join(proof, `conversation-03-${provider}-input.png`), fullPage: true });
    await page.locator('#conversation-input').getByRole('radio', { name: /Waiting/ }).check();
    await page.locator('#conversation-input').getByRole('button', { name: 'Send reply' }).click(); await f.completed();
  }
  await page.locator('.conversation-context summary').click();
  for (const [name, width, height] of [['laptop', 1024, 768], ['narrow', 390, 844]] as const) {
    await f.electron.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]!.setBounds(bounds), { width, height });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await page.screenshot({ path: join(proof, `conversation-05-${name}.png`), fullPage: true });
  }
  await f.electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ width: 1200, height: 850 }));
  await page.evaluate(() => { const sample = { count: 0, maxGap: 0, previous: performance.now(), timer: 0 }; sample.timer = window.setInterval(() => { const now = performance.now(); sample.count++; sample.maxGap = Math.max(sample.maxGap, now - sample.previous); sample.previous = now; }, 5); (window as any).conversationHeartbeat = sample; });
  await f.send('claude', 'burst', 'Show a burst of streamed text.'); await f.completed();
  const heartbeat = await page.evaluate(() => { const sample = (window as any).conversationHeartbeat; clearInterval(sample.timer); return { count: sample.count, maxGap: sample.maxGap }; });
  assert.ok(heartbeat.count >= 5); assert.ok(heartbeat.maxGap < 500, JSON.stringify(heartbeat));
  for (let index = 0; index < 5; index++) { await f.send('claude', 'long', `Bounded answer ${index}`); await f.completed(); }
  assert.ok(Buffer.byteLength(JSON.stringify((await f.chat()).conversation!.history)) <= 256 * 1024);
  await expect(page.locator('#conversation-omissions')).toBeVisible();
  await expect(page.locator('.turn-truncated').last()).toContainText('64 KiB');
  await page.locator('#source-tab').click(); await page.locator('#source').fill('x'.repeat(256 * 1024));
  await page.locator('#conversation-tab').click();
  const beforeLimit = (await f.calls('claude')).length;
  await page.locator('#conversation-question').fill('Keep this question after context rejection.'); await page.locator('#conversation-send').click();
  await expect(page.locator('#conversation-error')).toContainText('exceeds 256 KiB');
  assert.equal((await f.calls('claude')).length, beforeLimit);
  await expect(page.locator('#conversation-question')).toHaveValue('Keep this question after context rejection.');
  await page.screenshot({ path: join(proof, 'conversation-04-context-limit.png'), fullPage: true });
  await page.locator('#source-tab').click(); await page.locator('#source').fill(draft); await page.locator('#conversation-tab').click();
  assert.equal((await f.document()).files.find(file => file.path === reviewPath)!.text, draft);
  assert.notEqual(await readFile(join(f.root, reviewPath), 'utf8'), draft);
  assert.deepEqual(f.errors, []); assert.deepEqual(f.requests, []);
});

test('actual Electron recovers from unavailable settings, binaries and private directory cleanup without losing drafts', { timeout: 90_000 }, async t => {
  const f = await launch(t, 'conversation-startup'), { page } = f;
  await f.choose('codex');
  const invalidSettings = join(f.workspace, 'invalid-settings.json');
  await writeFile(invalidSettings, '{}', { mode: 0o600 });
  await f.pick(invalidSettings); await page.locator('#conversation-load-profiles').click();
  await expect(page.locator('#conversation-error')).toContainText('schemaVersion 1');
  await expect(page.locator('#conversation-selected-provider')).toContainText('Profile codex_author');
  assert.equal((await f.calls('codex')).length, 0);
  for (const provider of ['codex', 'claude']) {
    await f.choose(provider);
    const executable = join(f.workspace, `${provider}-fixture`);
    await rename(executable, `${executable}.unavailable`);
    try {
      await f.send(provider, 'plain', `Keep the question when ${provider} is missing.`);
      await expect.poll(async () => (await f.last())?.status).toBe('error');
      assert.equal((await f.last())!.error!.code, 'unavailable');
      await expect(page.locator('#conversation-failure')).toBeVisible();
      await page.screenshot({ path: join(proof, `conversation-12-${provider}-unavailable.png`), fullPage: true });
    } finally { await rename(`${executable}.unavailable`, executable); }
    await f.fresh();
  }
  await f.send('claude', 'plain', 'Complete before the workspace cleanup check.'); await f.completed();
  await page.locator('#source-tab').click(); await page.getByRole('button', { name: reviewPath, exact: true }).first().click();
  const draft = '# Keep after a failed workspace transition\n';
  await page.locator('#source').fill(draft); await expect(page.locator('#dirty-state')).toContainText('unsaved');
  await f.electron.evaluate(() => {
    const fs = process.getBuiltinModule('node:fs/promises'), original = fs.rm;
    fs.rm = (async (...args: Parameters<typeof original>) => {
      if (String(args[0]).includes('/conversations/session-')) {
        fs.rm = original;
        throw new Error('Fictional conversation cleanup failure.');
      }
      return original(...args);
    }) as typeof original;
  });
  await f.pick(join(f.root, workflowPath)); await page.locator('#open-workflow').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard and open' }).click();
  await expect(page.locator('#message')).toHaveText('Fictional conversation cleanup failure.');
  await expect(page.locator('#source')).toHaveValue(draft);
  assert.equal((await f.document()).files.find(file => file.path === reviewPath)!.text, draft);
  assert.notEqual(await readFile(join(f.root, reviewPath), 'utf8'), draft);
  await page.locator('#conversation-tab').click(); await expect(page.locator('#conversation-status')).toContainText('Conversation closed');
  await f.choose('claude'); await expect(page.locator('#conversation-status')).toContainText('Ready for a new session');
  await f.send('claude', 'plain', 'Continue after explicit profile recovery.'); await f.completed();
  assert.equal((await f.document()).files.find(file => file.path === reviewPath)!.text, draft);
  assert.deepEqual(f.errors, []); assert.deepEqual(f.requests, []);
});

test('actual Electron preserves rejected drafts and keeps cancellation and replies available during document operations', { timeout: 210_000 }, async t => {
  const f = await launch(t, 'conversation-recovery'), { page } = f;
  const draft = '# Unsaved discussion notes\n';
  await page.locator('#source-tab').click(); await page.getByRole('button', { name: reviewPath, exact: true }).first().click(); await page.locator('#source').fill(draft);
  await page.getByRole('button', { name: workflowPath, exact: true }).first().click(); const original = await page.locator('#source').inputValue();
  await page.locator('#source').fill('{ unfinished source'); await page.locator('#conversation-tab').click();
  for (const provider of ['codex', 'claude']) {
    await f.choose(provider);
    for (const [mode, code] of [['unsupported', 'unsupported'], ['login', 'login'], ['exit', 'provider'], ['unsupported-input', 'unsupported'], ['flood', 'limit']] as const) {
      await f.send(provider, mode, `${provider} ${mode} recovery`);
      await expect.poll(async () => (await f.last())?.status).toBe('error');
      assert.equal((await f.last())!.error!.code, code);
      await expect(page.locator('#conversation-failure')).toBeVisible();
      assert.equal((await f.document()).files.find(file => file.path === workflowPath)!.text, '{ unfinished source');
      assert.equal((await f.document()).files.find(file => file.path === reviewPath)!.text, draft);
      if (mode === 'login') await page.screenshot({ path: join(proof, `conversation-06-${provider}-login-recovery.png`), fullPage: true });
      await f.fresh();
    }
  }
  await f.send('claude', 'input', 'Reply while invalid workflow source remains visible.');
  await expect(page.locator('#conversation-input')).toBeVisible(); await page.locator('#source-tab').click();
  await page.locator('#conversation-input').getByRole('radio', { name: /Waiting/ }).focus(); await page.keyboard.press('Space');
  await page.locator('#conversation-input').getByRole('button', { name: 'Send reply' }).focus(); await page.keyboard.press('Enter'); await f.completed();
  await expect(page.locator('#source')).toHaveValue('{ unfinished source');
  await page.locator('#conversation-tab').click(); await rm(join(f.workspace, 'claude.pid'), { force: true });
  await f.send('claude', 'hang', 'Cancel while invalid workflow source remains visible.');
  await expect.poll(() => f.pid('claude')).not.toBe(0); const sourceChild = await f.pid('claude');
  await page.locator('#source-tab').click(); await page.locator('#conversation-cancel').focus(); await page.keyboard.press('Enter');
  await expect.poll(async () => (await f.last())?.status).toBe('cancelled'); await f.gone(sourceChild);
  await expect(page.locator('#source')).toHaveValue('{ unfinished source');
  assert.equal((await f.document()).files.find(file => file.path === workflowPath)!.text, '{ unfinished source');
  assert.equal(await readFile(join(f.root, workflowPath), 'utf8'), original);
  await page.screenshot({ path: join(proof, 'conversation-13-cancel-with-invalid-source.png'), fullPage: true });
  await f.fresh();
  await page.locator('#source-tab').click(); await page.locator('#source').fill(original); await page.locator('#conversation-tab').click();
  await f.choose('codex'); await f.send('codex', 'input', 'Reply while the inspector holds incomplete text.');
  await expect(page.locator('#conversation-input')).toBeVisible(); await page.locator('#process-tab').click(); await page.locator('#action-select').selectOption('wait_review');
  const acceptedWait = (await f.document()).workflow!.settings.reviewWaitSeconds;
  await page.locator('#setting-reviewWaitSeconds').fill(''); await page.locator('#apply-settings').click();
  await expect(page.locator('#dirty-state')).toContainText('unsaved action setting');
  await expect(page.locator('#setting-reviewWaitSeconds')).toHaveValue('');
  await page.locator('#conversation-input').getByRole('radio', { name: /Waiting/ }).focus(); await page.keyboard.press('Space');
  await page.screenshot({ path: join(proof, 'conversation-07-reply-with-rejected-inspector.png'), fullPage: true });
  await page.locator('#conversation-input').getByRole('button', { name: 'Send reply' }).focus(); await page.keyboard.press('Enter'); await f.completed();
  await expect(page.locator('#setting-reviewWaitSeconds')).toHaveValue('');
  assert.equal((await f.document()).workflow!.settings.reviewWaitSeconds, acceptedWait);
  assert.equal(JSON.parse(await readFile(join(f.root, workflowPath), 'utf8')).settings.reviewWaitSeconds, acceptedWait);
  await page.locator('#conversation-fresh').focus(); await page.keyboard.press('Enter');
  await expect.poll(async () => (await f.chat()).conversation!.session).toBe(null);
  await expect(page.locator('#setting-reviewWaitSeconds')).toHaveValue('');
  await page.locator('#discard-settings').click(); await page.locator('#conversation-tab').click();
  await f.send('codex', 'hang', 'Cancel while invalid inspector text remains.');
  await expect.poll(() => f.pid('codex')).not.toBe(0); const firstChild = await f.pid('codex');
  await page.locator('#process-tab').click(); await page.locator('#setting-reviewWaitSeconds').fill(''); await page.locator('#apply-settings').click();
  await page.locator('#conversation-cancel').focus(); await page.keyboard.press('Enter');
  await expect.poll(async () => (await f.last())?.status).toBe('cancelled'); await f.gone(firstChild);
  await expect(page.locator('#setting-reviewWaitSeconds')).toHaveValue('');
  await page.screenshot({ path: join(proof, 'conversation-08-cancel-with-rejected-inspector.png'), fullPage: true });
  await page.locator('#discard-settings').click(); await page.locator('#conversation-tab').click(); await f.fresh();
  const pendingPicker = async () => {
    await f.electron.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => { (globalThis as any).conversationPickerPending = true; await new Promise<void>(resolve => { (globalThis as any).releaseConversationPicker = resolve; }); (globalThis as any).conversationPickerPending = false; return { canceled: true, filePaths: [] }; }; });
    await page.locator('#simulation-tab').click(); await page.locator('#load-fixture').click();
    await expect.poll(() => f.electron.evaluate(() => (globalThis as any).conversationPickerPending)).toBe(true);
  };
  const releasePicker = async () => { await f.electron.evaluate(() => { (globalThis as any).releaseConversationPicker(); }); await expect(page.locator('#load-fixture')).toBeEnabled(); };
  await f.choose('claude'); await f.send('claude', 'input', 'Reply during a pending document picker.'); await expect(page.locator('#conversation-input')).toBeVisible();
  await pendingPicker();
  await page.locator('#conversation-input').getByRole('radio', { name: /Waiting/ }).check();
  await page.locator('#conversation-input').getByRole('button', { name: 'Send reply' }).focus(); await page.keyboard.press('Enter');
  await f.completed(); assert.equal(await f.electron.evaluate(() => (globalThis as any).conversationPickerPending), true);
  await page.screenshot({ path: join(proof, 'conversation-09-reply-during-document-operation.png'), fullPage: true });
  await releasePicker(); await page.locator('#conversation-tab').click();
  await f.send('claude', 'hang', 'Cancel during a pending document picker.'); await expect.poll(() => f.pid('claude')).not.toBe(0); const secondChild = await f.pid('claude');
  await pendingPicker(); await page.locator('#conversation-cancel').focus(); await page.keyboard.press('Enter');
  await expect.poll(async () => (await f.last())?.status).toBe('cancelled'); await f.gone(secondChild);
  assert.equal(await f.electron.evaluate(() => (globalThis as any).conversationPickerPending), true);
  assert.equal((await f.chat()).snapshot!.files.find(file => file.path === reviewPath)!.text, draft);
  await page.screenshot({ path: join(proof, 'conversation-10-cancel-during-document-operation.png'), fullPage: true });
  await releasePicker(); await page.locator('#conversation-tab').click(); await f.fresh();
  await rm(join(f.workspace, 'claude.pid'), { force: true });
  await f.send('claude', 'hang', 'Keep drafts when leaving is cancelled.'); await expect.poll(() => f.pid('claude')).not.toBe(0); const thirdChild = await f.pid('claude');
  await page.locator('#open-workflow').click(); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await f.document()).files.find(file => file.path === reviewPath)!.text, draft);
  assert.ok((await f.chat()).conversation!.activeTurnId);
  await page.locator('#save').click(); await expect(page.locator('#message')).toHaveText('Saved all changed files.');
  const other = join(f.workspace, 'other-workflow');
  for (const file of f.pkg.files) { await mkdir(dirname(join(other, file.path)), { recursive: true }); await writeFile(join(other, file.path), file.text); }
  await f.pick(join(other, workflowPath)); await page.locator('#open-workflow').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Stop and open' }).click();
  await expect.poll(async () => { const opened = await f.document(); return resolve(opened.repositoryRoot, opened.workflowPath); }).toBe(join(other, workflowPath)); await f.gone(thirdChild);
  assert.equal((await f.chat()).conversation, null);
  assert.equal(await readFile(join(f.root, reviewPath), 'utf8'), draft);
  await page.screenshot({ path: join(proof, 'conversation-11-workspace-switch.png'), fullPage: true });
  await f.choose('codex'); await rm(join(f.workspace, 'codex.pid'), { force: true });
  await f.send('codex', 'hang', 'Stop the provider on window close.'); await expect.poll(() => f.pid('codex')).not.toBe(0); const finalChild = await f.pid('codex');
  await f.electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await page.getByRole('dialog').getByRole('button', { name: 'Stop and close' }).click();
  await expect.poll(() => page.isClosed()).toBe(true); await f.gone(finalChild);
  assert.deepEqual(f.errors, []); assert.deepEqual(f.requests, []);
});
