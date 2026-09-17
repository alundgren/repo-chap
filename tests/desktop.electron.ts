import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron, expect, chromium } from '@playwright/test';
import { loadWorkflow } from '@repo-chap/workflow';

const workflowPath = 'docs/pr-workflows/examples/team-pr/workflow.json';
const reviewPath = 'docs/pr-workflows/examples/team-pr/review.md';
const packagedExecutable = process.env.REPO_CHAP_DESKTOP_EXECUTABLE;
const electronExecutable: string = packagedExecutable ?? createRequire(resolve('apps/desktop/package.json'))('electron');
const proof = process.env.REPO_CHAP_DESKTOP_PROOF ?? await mkdtemp(join(tmpdir(), 'repo-chap-desktop-proof-'));
await mkdir(proof, { recursive: true });

test('actual Electron opens, edits, saves and recovers local workflow sources without remote requests', { timeout: 150_000 }, async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'repo-chap-electron-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const root = join(workspace, 'starlight-labs', 'a-repository-with-a-long-name-for-workflow-authoring-and-local-review');
  const pkg = await loadWorkflow(resolve(workflowPath));
  for (const file of pkg.files) {
    await mkdir(dirname(join(root, file.path)), { recursive: true });
    await writeFile(join(root, file.path), file.text);
  }
  const env: Record<string, string> = { REPO_CHAP_DESKTOP_DATA: join(workspace, 'profile') };
  for (const key of ['PATH', 'DISPLAY', 'HOME', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[key]) env[key] = process.env[key]!;
  const electron = await _electron.launch({ executablePath: electronExecutable, args: packagedExecutable ? [] : [resolve('apps/desktop')], env, recordVideo: { dir: join(proof, 'video'), size: { width: 1280, height: 900 } } });
  t.after(async () => {
    const remaining = electron.windows()[0];
    if (remaining && !remaining.isClosed()) {
      await remaining.screenshot({ path: join(proof, 'last-window.png'), fullPage: true, timeout: 2000 }).catch(() => {});
      await writeFile(join(proof, 'last-window.txt'), await remaining.locator('body').innerText({ timeout: 2000 }).catch(() => 'Window unavailable.'));
    }
    await electron.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
    await electron.close().catch(() => {});
  });
  const page = await electron.firstWindow();
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await electron.context().setOffline(true);
  await expect(page.getByRole('heading', { name: 'Edit your workflow.' })).toBeVisible();
  await page.screenshot({ path: join(proof, '01-welcome.png'), fullPage: true });
  await electron.evaluate(({ dialog }, choices) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [choices.shift()!] });
  }, [root, join(root, workflowPath)]);
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  await expect(page.locator('#validation-title')).toHaveText('Validation passed');
  await expect(page.getByRole('button', { name: reviewPath, exact: true }).first()).toBeVisible();
  assert.equal(await page.evaluate(() => typeof (window as any).require), 'undefined');
  assert.equal(await page.evaluate(() => typeof (window as any).process), 'undefined');
  await page.screenshot({ path: join(proof, '02-workflow-laptop.png'), fullPage: true });

  const text = page.locator('#source');
  const originalWorkflow = await text.inputValue();
  const value = JSON.parse(originalWorkflow);
  value.layout = { futureEditorData: { note: 'Preserve this exact value', x: 12, y: 4 } };
  const editedWorkflow = JSON.stringify(value, null, 4) + '\n\n';
  await text.fill(editedWorkflow);
  await expect(page.locator('#dirty-state')).toHaveText('1 unsaved file(s)');
  await page.getByRole('button', { name: reviewPath, exact: true }).first().click();
  const markdown = '# Review instructions\n\nKeep checks tied to the tested commit.\n\n[Text only](absent.md)\n<img src="https://example.invalid/no-request">\n';
  await text.fill(markdown);
  await expect(page.locator('#dirty-state')).toHaveText('2 unsaved file(s)');
  await page.screenshot({ path: join(proof, '03-markdown-unsaved.png'), fullPage: true });
  await page.getByRole('button', { name: workflowPath, exact: true }).first().click();
  await expect(text).toHaveValue(editedWorkflow);
  await text.press('Control+s');
  await expect(page.locator('#message')).toHaveText('Saved all changed files.');
  assert.equal(await readFile(join(root, workflowPath), 'utf8'), editedWorkflow);
  assert.equal(await readFile(join(root, reviewPath), 'utf8'), markdown);
  assert.deepEqual(JSON.parse(editedWorkflow).rules.map((rule: { id: string }) => rule.id), pkg.workflow.rules.map(rule => rule.id));

  await text.fill('{ invalid JSON');
  await expect(page.locator('#validation-title')).toHaveText('1 validation error(s)');
  await expect(page.locator('#message')).toHaveText('');
  await expect(page.getByRole('button', { name: 'Save all', exact: true })).toBeDisabled();
  await page.screenshot({ path: join(proof, '04-invalid-json.png'), fullPage: true });
  await text.press('Control+s');
  await expect(page.locator('#message')).toContainText('validation errors');
  await page.getByRole('button', { name: reviewPath, exact: true }).first().click();
  await page.getByRole('button', { name: workflowPath, exact: true }).first().click();
  await expect(text).toHaveValue('{ invalid JSON');
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: join(proof, '05-close-protection.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(text).toHaveValue('{ invalid JSON');
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(text).toHaveValue('{ invalid JSON');
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(text).toHaveValue(editedWorkflow);

  await page.getByRole('button', { name: reviewPath, exact: true }).first().click();
  await text.fill('# My unsaved draft\n');
  await expect(page.locator('#dirty-state')).toHaveText('1 unsaved file(s)');
  await writeFile(join(root, reviewPath), '# External edit\n');
  await page.getByRole('button', { name: 'Save all', exact: true }).click();
  await expect(page.locator('#message')).toContainText('changed on disk');
  await expect(text).toHaveValue('# My unsaved draft\n');
  await expect(page.locator('#external')).toBeVisible();
  await page.screenshot({ path: join(proof, '06-external-change.png'), fullPage: true });
  await page.getByRole('button', { name: 'Reload file', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(text).toHaveValue('# My unsaved draft\n');
  await page.getByRole('button', { name: 'Reload file', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reload from disk', exact: true }).click();
  await expect(text).toHaveValue('# External edit\n');
  await expect(page.locator('#external')).toBeHidden();

  await electron.evaluate(() => {
    const fs = process.getBuiltinModule('node:fs/promises');
    const original = fs.realpath;
    fs.realpath = (async (...args: Parameters<typeof original>) => {
      fs.realpath = original;
      (globalThis as any).desktopReadPending = true;
      await new Promise<void>(resolve => { (globalThis as any).releaseDesktopRead = resolve; });
      return original(...args);
    }) as typeof original;
  });
  await page.getByRole('button', { name: 'Reload file', exact: true }).click();
  await expect.poll(() => electron.evaluate(() => (globalThis as any).desktopReadPending)).toBe(true);
  await expect(text).toHaveAttribute('readonly', '');
  await expect(text).toHaveAttribute('aria-busy', 'true');
  await text.press('x');
  await expect(text).toHaveValue('# External edit\n');
  await page.screenshot({ path: join(proof, '10-reload-busy.png'), fullPage: true });
  await electron.evaluate(() => { (globalThis as any).releaseDesktopRead(); });
  await expect(text).not.toHaveAttribute('readonly', '');
  await text.fill('# Typed after reload\n');
  await expect(page.locator('#dirty-state')).toHaveText('1 unsaved file(s)');
  const captured = await page.evaluate(async path => (await window.repoChap.current()).snapshot!.files.find(file => file.path === path)!.text, reviewPath);
  assert.equal(await text.inputValue(), captured);
  await text.press('End');
  await text.press('x');
  await text.press('Control+s');
  await expect(page.locator('#message')).toHaveText('Saved all changed files.');
  assert.equal(await readFile(join(root, reviewPath), 'utf8'), '# Typed after reload\nx');
  assert.equal(await text.inputValue(), '# Typed after reload\nx');

  const schemaPath = 'docs/pr-workflows/schemas/results.schema.json';
  await page.getByRole('button', { name: schemaPath, exact: true }).first().click();
  const invalidSchema = JSON.parse(await text.inputValue());
  invalidSchema.$defs.review.type = 'not-a-json-schema-type';
  const schemaText = JSON.stringify(invalidSchema, null, 2);
  await text.fill(schemaText);
  await expect(page.getByRole('button', { name: 'Save all', exact: true })).toBeDisabled();
  const schemaError = page.locator('#diagnostics').getByRole('button', { name: schemaPath, exact: true });
  await expect(schemaError).toBeVisible();
  await page.getByRole('button', { name: workflowPath, exact: true }).first().click();
  await schemaError.click();
  await expect(page.locator('#source-label')).toHaveText(schemaPath);
  await expect(text).toHaveValue(schemaText);
  await page.screenshot({ path: join(proof, '11-schema-diagnostic.png'), fullPage: true });
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page.locator('#validation-title')).toHaveText('Validation passed');
  await page.getByRole('button', { name: reviewPath, exact: true }).first().click();

  await text.fill('# Keep when chooser cancels\n');
  await expect(page.locator('#dirty-state')).toHaveText('1 unsaved file(s)');
  await electron.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await page.getByRole('button', { name: 'Open workflow', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard and open', exact: true }).click();
  await expect(text).toHaveValue('# Keep when chooser cancels\n');
  await expect(page.locator('#dirty-state')).toHaveText('1 unsaved file(s)');
  await text.press('Control+s');
  await expect(page.locator('#dirty-state')).toHaveText('All changes saved');

  for (const [name, width, height] of [['laptop', 1024, 768], ['narrow', 390, 844]] as const) {
    await electron.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setBounds(size), { width, height });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(layout.scroll <= layout.width + 1, `${name} page overflow: ${JSON.stringify(layout)}`);
    await page.screenshot({ path: join(proof, `07-${name}-long-path.png`), fullPage: true });
  }
  await page.getByRole('button', { name: 'Open repository', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Open workflow', exact: true })).toBeFocused();
  await page.getByRole('button', { name: workflowPath, exact: true }).first().focus();
  await page.keyboard.press('Enter');
  await expect(text).toBeFocused();
  await page.screenshot({ path: join(proof, '08-keyboard-focus.png'), fullPage: true });

  const unsupported = JSON.stringify({ ...value, schemaVersion: 999, futureSettings: { preserved: true } }, null, 2) + '\n';
  await writeFile(join(root, workflowPath), unsupported);
  await page.getByRole('button', { name: 'Reload file', exact: true }).click();
  await expect(text).toHaveAttribute('readonly', '');
  await expect(text).toHaveValue(unsupported);
  await expect(page.locator('#read-only')).toContainText('read-only');
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ width: 1200, height: 850 }));
  await page.screenshot({ path: join(proof, '09-unsupported-preserved.png'), fullPage: true });
  assert.equal(await readFile(join(root, workflowPath), 'utf8'), unsupported);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  await writeFile(join(proof, 'result.json'), JSON.stringify({ platform: process.platform, packaged: !!packagedExecutable, launchArguments: electron.process().spawnargs.slice(1), checks: ['native picker integration', 'JSON and Markdown save', 'unknown layout fields and stable IDs', 'invalid source recovery', 'switching retains drafts', 'cancelled close', 'cancelled discard', 'external conflict and reload cancellation', 'pending reload protects source input and subsequent save', 'referenced schema diagnostic selects source', 'cancelled chooser retains drafts', 'laptop and narrow layout', 'keyboard focus', 'unsupported version preserves source', 'isolated renderer', 'offline context, no remote requests'], pageErrors: errors, remoteRequests: requests }, null, 2));
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await electron.close();
});

test('capture the approved source editor reference and labeled comparison', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    await page.goto(`file://${resolve('docs/pr-workflows/presentation.html')}`);
    await page.locator('#contents-open').click();
    await page.locator('#contents-list button').filter({ hasText: 'Interactive visual editor' }).click();
    await page.locator('#source-tab').click();
    await page.screenshot({ path: join(proof, 'reference-source-editor.png'), fullPage: true });
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Source editor comparison</title><style>body{margin:24px;background:#F2EADE;color:#604939;font:16px system-ui}main{display:grid;grid-template-columns:1fr 1fr;gap:24px}img{width:100%;display:block}h1{font-size:24px}h2{font-size:18px}</style><h1>Repo Chap source editor</h1><main><section><h2>Approved presentation reference</h2><img src="reference-source-editor.png" alt="The approved offline presentation source editor"></section><section><h2>Actual Electron implementation</h2><img src="02-workflow-laptop.png" alt="The implemented Electron workflow source editor"></section></main></html>`;
    await writeFile(join(proof, 'comparison.html'), html);
    await page.setViewportSize({ width: 1800, height: 1050 });
    await page.goto(`file://${join(proof, 'comparison.html')}`);
    await page.screenshot({ path: join(proof, 'comparison-source-editor.png'), fullPage: true });
  } finally { await browser.close(); }
});
