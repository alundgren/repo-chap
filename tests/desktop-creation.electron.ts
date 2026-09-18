import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron, expect } from '@playwright/test';

const executablePath: string = process.env.REPO_CHAP_DESKTOP_EXECUTABLE ?? createRequire(resolve('apps/desktop/package.json'))('electron');

test('create workflow cancels safely, opens an unsaved editor, saves and reopens', { timeout: 90_000 }, async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'repo-chap-create-electron-'));
  const root = join(workspace, 'fictional-repository');
  await mkdir(root);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const env: Record<string, string> = { REPO_CHAP_DESKTOP_DATA: join(workspace, 'profile') };
  for (const key of ['PATH', 'DISPLAY', 'HOME', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[key]) env[key] = process.env[key]!;
  const electron = await _electron.launch({ executablePath, args: process.env.REPO_CHAP_DESKTOP_EXECUTABLE ? [] : [resolve('apps/desktop')], env });
  t.after(async () => {
    await electron.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
    await electron.close().catch(() => {});
  });
  const page = await electron.firstWindow();
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await electron.context().setOffline(true);
  const create = page.getByRole('button', { name: 'Create workflow', exact: true });
  await expect(create).toBeVisible();

  // Exercise a cancelled picker, with no successful path supplied for this operation.
  await electron.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async (_window: unknown, options?: any) => {
      if (options.properties.join(',') !== 'openDirectory') throw new Error('Expected a directory picker only.');
      return { canceled: true, filePaths: [] };
    };
  });
  await create.focus();
  await page.keyboard.press('Enter');
  await expect(create).toBeFocused();
  await expect(page.locator('#welcome')).toBeVisible();
  assert.deepEqual(await page.evaluate(() => (window as any).repoChap.current()), { snapshot: null });
  assert.deepEqual(await readdir(root), []);

  await electron.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  }, root);
  await create.click();
  await expect(page.locator('#validation-title')).toHaveText('Validation passed');
  await expect(page.locator('#dirty-state')).toHaveText('1 unsaved file(s)');
  await expect(page.locator('#source-label')).toHaveText('.repo-chap/workflow.json');
  await expect(page.locator('#source')).toBeFocused();
  for (const name of ['Source', 'Process', 'Simulate', 'Discuss']) {
    await page.getByRole('button', { name, exact: true }).click();
    const id = { Source: 'source', Process: 'process', Simulate: 'simulation', Discuss: 'conversation' }[name]!;
    await expect(page.locator(`#${id}-view`)).toBeVisible();
  }
  assert.deepEqual(await readdir(root), []);
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  const source = page.locator('#source');
  const starter = await source.inputValue();
  const changed = JSON.parse(starter); changed.settings.newPrDelaySeconds = 180;
  const text = JSON.stringify(changed, null, 2) + '\n';
  await source.fill(text);
  await expect(page.locator('#validation-title')).toHaveText('Validation passed');
  assert.deepEqual(await readdir(root), []);

  await electron.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await page.getByRole('button', { name: 'Open workflow', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard and open', exact: true }).click();
  await expect(source).toHaveValue(text);
  await expect(page.locator('#dirty-state')).toHaveText('1 unsaved file(s)');
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(source).toHaveValue(text);

  await page.getByRole('button', { name: 'Save all', exact: true }).click();
  await expect(page.locator('#dirty-state')).toHaveText('All changes saved');
  assert.equal(await readFile(join(root, '.repo-chap/workflow.json'), 'utf8'), text);
  await electron.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, join(root, '.repo-chap/workflow.json'));
  await page.getByRole('button', { name: 'Open workflow', exact: true }).click();
  await expect(source).toHaveValue(text);
  await expect(page.locator('#validation-title')).toHaveText('Validation passed');

  const secondRoot = join(workspace, 'another-fictional-repository'); await mkdir(secondRoot);
  await electron.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, secondRoot);
  await create.click();
  await expect(page.locator('#dirty-state')).toHaveText('1 unsaved file(s)');
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('all unsaved file edits');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#workspace')).toBeVisible();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page.locator('#welcome')).toBeVisible();
  await expect(create).toBeFocused();
  assert.deepEqual(await readdir(secondRoot), []);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
});
