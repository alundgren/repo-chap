import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron, expect } from '@playwright/test';
import type { TrialResult } from '../apps/desktop/src/trial-protocol.ts';
import { setup, git } from './helpers/provider-fixture.ts';

const proof = process.env.REPO_CHAP_DESKTOP_PROOF;
if (!proof) throw new Error('Set REPO_CHAP_DESKTOP_PROOF to a private proof directory outside the checkout.');
await mkdir(proof, { recursive: true });
const packaged = process.env.REPO_CHAP_DESKTOP_EXECUTABLE;
const executablePath = packaged ?? createRequire(resolve('apps/desktop/package.json'))('electron') as string;
async function launch(t: { after(callback: () => Promise<void>): void }, name: string, loadProfiles = true) {
  const source = await setup();
  for (const file of source.pkg.files) { await mkdir(dirname(join(source.repository, file.path)), { recursive: true }); await writeFile(join(source.repository, file.path), file.text); }
  const codexMode = join(source.temporary, 'codex.mode'), claudeMode = join(source.temporary, 'claude.mode');
  await writeFile(codexMode, 'valid'); await writeFile(claudeMode, 'valid');
  await writeFile(source.executable, (await readFile(source.executable, 'utf8')).replace('mode = "valid"', `mode = fs.readFileSync(${JSON.stringify(codexMode)}, 'utf8').trim()`), { mode: 0o700 });
  const claude = join(source.temporary, 'fake-claude'), claudeLog = join(source.temporary, 'claude.jsonl');
  await writeFile(claude, `#!${process.execPath}\nglobal.fixture=${JSON.stringify({ mode: 'valid', log: claudeLog, marker: join(source.temporary, 'claude-started'), childPid: join(source.temporary, 'claude.pid') })};global.fixture.mode=require('node:fs').readFileSync(${JSON.stringify(claudeMode)},'utf8').trim();require(${JSON.stringify(resolve('tests/helpers/fake-claude.cjs'))});`, { mode: 0o700 });
  const { name: _name, ...profile } = source.profile;
  const profiles: Record<string, unknown> = { codex_trial: profile, claude_trial: { ...profile, provider: 'claude', executable: claude } };
  for (const provider of ['codex', 'claude']) {
    const executable = join(source.temporary, `${provider}-chat`), modeFile = join(source.temporary, `${provider}-chat.mode`);
    await writeFile(modeFile, 'plain');
    await writeFile(executable, `#!${process.execPath}\nglobal.fixture=${JSON.stringify({ provider, modeFile, planFile: join(source.temporary, `${provider}-plan.json`), noTools: true, log: join(source.temporary, `${provider}-chat.jsonl`), childPid: join(source.temporary, `${provider}-chat.pid`) })};require(${JSON.stringify(resolve('tests/helpers/fake-conversation.cjs'))});`, { mode: 0o700 });
    profiles[`${provider}_author`] = { ...profile, provider, executable, timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 };
  }
  await writeFile(source.settings, JSON.stringify({ schemaVersion: 1, profiles }), { mode: 0o600 });
  const bin = join(source.temporary, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const env: Record<string, string> = { REPO_CHAP_DESKTOP_DATA: join(source.temporary, 'desktop-data'), GH_TOKEN: 'fictional-desktop-read-token', PATH: `${bin}:${process.env.PATH}` };
  for (const key of ['HOME', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[key]) env[key] = process.env[key]!;
  const electron = await _electron.launch({ executablePath, args: [...(packaged ? [] : [resolve('apps/desktop')]), '--workflow', join(source.repository, source.pkg.workflowPath), '--repo-root', source.repository], env });
  const page = await electron.firstWindow(), errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await electron.context().setOffline(true);
  await electron.evaluate((_electron, input) => {
    const state = { head: input.head, base: input.base, mode: 'complete', queries: [] as string[], mutations: 0, effects: [] as string[] };
    (globalThis as any).trialFixture = state;
    globalThis.fetch = (async (url: any, init: any) => {
      const query = JSON.parse(String(init.body)).query as string; state.queries.push(query);
      if (String(url) !== 'https://api.github.com/graphql' || !query.startsWith('query ')) { state.mutations++; throw new Error('A non-read request was attempted.'); }
      const connection = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      let data: any;
      if (query.includes('InspectMetadata')) data = { repository: { id: 'R_paperboat', nameWithOwner: 'reef-labs/paperboat', isPrivate: true, pullRequest: {
        id: 'PR_42', number: 42, url: 'https://github.com/reef-labs/paperboat/pull/42', title: 'Update value', body: 'Fictional trial evidence.', author: { login: 'river' }, state: 'OPEN', isDraft: false,
        headRefOid: state.head, baseRefOid: state.base, headRefName: 'update', baseRefName: 'main', headRepository: { id: 'R_paperboat', nameWithOwner: 'reef-labs/paperboat' },
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T01:00:00Z', mergeable: 'MERGEABLE', reviewDecision: null,
      } } };
      else if (query.includes('InspectChecks')) data = { repository: { object: { statusCheckRollup: null } } };
      else if (query.includes('Inspectlabels')) data = { repository: { pullRequest: { labels: connection } } };
      else if (query.includes('Inspectreviews')) data = { repository: { pullRequest: { reviews: connection } } };
      else if (query.includes('InspectreviewThreads')) data = { repository: { pullRequest: { reviewThreads: connection } } };
      else throw new Error('Unexpected fictional GraphQL read.');
      return new Response(JSON.stringify({ data, ...(state.mode === 'partial' && query.includes('Inspectreviews') ? { errors: [{ message: 'Fictional partial collection.' }] } : {}) }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }, { head: source.head, base: source.base });
  const trial = (): Promise<TrialResult> => page.evaluate(() => window.repoChapTrial.current());
  const last = async () => (await trial()).trial!.records[0]!;
  const calls = async (provider = 'codex') => (await readFile(provider === 'codex' ? source.log : claudeLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const pick = async (path: string) => electron.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, path);
  const mode = (provider: string, value: string) => writeFile(provider === 'codex' ? codexMode : claudeMode, value);
  const finished = async (status = 'completed') => { await expect.poll(async () => (await last()).status, { timeout: 40_000 }).toBe(status); };
  const start = async () => { const previous = (await trial()).trial?.records[0]?.id; await page.locator('#trial-start').click(); await expect.poll(async () => (await last())?.id).not.toBe(previous); };
  t.after(async () => {
    if (!page.isClosed()) {
      await page.screenshot({ path: join(proof!, `${name}-last.png`), fullPage: true, timeout: 2000 }).catch(() => {});
      await writeFile(join(proof!, `${name}-last.txt`), await page.locator('body').innerText({ timeout: 2000 }).catch(() => 'Window unavailable.'));
      await page.evaluate(async () => { const state = await window.repoChapTrial.current(); if (state.trial?.activeId) await window.repoChapTrial.cancel(state.trial.documentSessionId, state.trial.activeId); }).catch(() => {});
    }
    await writeFile(join(proof!, `${name}-codex-calls.json`), JSON.stringify(await calls())); await writeFile(join(proof!, `${name}-claude-calls.json`), JSON.stringify(await calls('claude')));
    for (const provider of ['codex', 'claude']) await writeFile(join(proof!, `${name}-${provider}-chat.jsonl`), await readFile(join(source.temporary, `${provider}-chat.jsonl`), 'utf8').catch(() => ''));
    await electron.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {}); await electron.close().catch(() => {}); await source.cleanup();
  });
  await expect(page.locator('#validation-title')).toHaveText('Validation passed');
  await page.locator('#trial-tab').click();
  if (loadProfiles) { await pick(source.settings); await page.locator('#trial-load-profiles').click(); await page.locator('#trial-profile').selectOption('codex_trial'); }
  await page.locator('#trial-repository').fill('reef-labs/paperboat'); await page.locator('#trial-pr').fill('42');
  return { source, page, electron, trial, last, calls, pick, mode, finished, start, errors, requests };
}

test('Electron runs both explicit provider trials, retains unsaved evidence and discusses actual findings', { timeout: 150_000 }, async t => {
  const f = await launch(t, 'trial-success'), { page } = f;
  const reviewPath = f.source.pkg.files.find(file => file.path.endsWith('/review.md'))!.path;
  await page.locator('#source-tab').click(); await page.getByRole('button', { name: reviewPath, exact: true }).first().click(); await page.locator('#source').fill('# Current unsaved review\nCheck the changed value.\n');
  await page.locator('#trial-tab').click(); await page.locator('#trial-prepare').click();
  await expect(page.locator('#trial-proposal')).toContainText('Prepared only'); assert.equal((await f.calls()).length, 0);
  assert.equal(await f.electron.evaluate(() => (globalThis as any).trialFixture.queries.length), 0);
  await page.screenshot({ path: join(proof!, 'trial-01-prepared.png'), fullPage: true });
  const before = git(f.source.repository, 'status', '--porcelain');
  await page.locator('#trial-start').focus(); await page.keyboard.press('Enter'); await f.finished();
  const codex = await f.last(); assert.equal(codex.analysis!.headSha, f.source.head); assert.equal(codex.provider.provider, 'codex');
  await expect(page.locator('#trial-result')).toContainText('Reviewed the pinned value change.');
  await page.screenshot({ path: join(proof!, 'trial-02-codex-result.png'), fullPage: true });
  const pinned = JSON.parse(await readFile(join(dirname(codex.recordPath), 'package.json'), 'utf8'));
  assert.equal(pinned.files.find((file: any) => file.path === reviewPath).text, '# Current unsaved review\nCheck the changed value.\n');
  assert.notEqual(await readFile(join(f.source.repository, reviewPath), 'utf8'), '# Current unsaved review\nCheck the changed value.\n');
  await f.mode('claude', 'findings'); await page.locator('#trial-profile').selectOption('claude_trial'); await expect(page.locator('#trial-result')).toContainText('Stale or unverified');
  await f.start(); await f.finished(); const claude = await f.last(); assert.equal(claude.provider.provider, 'claude');
  await expect(page.locator('#trial-result')).toContainText('Estimated cost'); await expect(page.locator('#trial-result')).toContainText('The changed value needs a boundary test');
  await page.screenshot({ path: join(proof!, 'trial-03-claude-result.png'), fullPage: true });
  assert.equal(git(f.source.repository, 'status', '--porcelain'), before); assert.equal(git(f.source.repository, 'rev-parse', 'HEAD'), f.source.head);
  for (const provider of ['codex', 'claude']) {
    await page.locator('#conversation-tab').click(); await f.pick(f.source.settings); await page.locator('#conversation-load-profiles').click();
    await page.locator('#conversation-profile').selectOption(`${provider}_author`); await page.locator('#conversation-use-profile').click();
    await page.locator('#conversation-question').fill('Discuss the actual completed trial evidence.'); await page.locator('#conversation-send').click();
    await expect.poll(() => page.evaluate(async () => (await window.repoChapConversation.current()).conversation?.history.findLast(entry => entry.kind === 'turn')?.status), { timeout: 20_000 }).toBe('completed');
    const calls = (await readFile(join(f.source.temporary, `${provider}-chat.jsonl`), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.ok(calls.some(call => JSON.stringify(call).includes(claude.id) && JSON.stringify(call).includes('The changed value needs a boundary test')));
  }
  await page.screenshot({ path: join(proof!, 'trial-04-discussion-evidence.png'), fullPage: true });
  await page.locator('#trial-tab').click();
  const count = (await f.calls('claude')).length;
  await f.electron.evaluate(() => { (globalThis as any).trialFixture.head = 'b'.repeat(40); });
  await page.locator('#trial-refresh').click(); await expect.poll(async () => (await f.last()).remote.status).toBe('stale');
  assert.equal((await f.calls('claude')).length, count); assert.equal((await f.last()).inspection!.headSha, f.source.head);
  await page.screenshot({ path: join(proof!, 'trial-05-changed-head.png'), fullPage: true });
  const exports = join(f.source.temporary, 'exports'); await mkdir(exports, { mode: 0o700 }); await f.pick(exports); await page.locator('#trial-export').click();
  await expect(page.locator('#trial-exported')).toBeVisible(); const directory = join(exports, (await readdir(exports))[0]!);
  assert.equal(JSON.parse(await readFile(join(directory, 'provenance.json'), 'utf8')).trial.id, claude.id);
  assert.ok(JSON.parse(await readFile(join(directory, 'fixture.json'), 'utf8')).results.review[0].payload);
  for (const [name, width, height] of [['laptop', 1024, 768], ['narrow', 390, 844]] as const) {
    await f.electron.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]!.setBounds(bounds), { width, height });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await page.screenshot({ path: join(proof!, `trial-06-${name}.png`), fullPage: true });
  }
  assert.equal(await f.electron.evaluate(() => (globalThis as any).trialFixture.mutations), 0); assert.deepEqual(f.errors, []); assert.deepEqual(f.requests, []);
});

test('Electron explains auth, partial reads and provider failure, and cancels changed or pending inputs', { timeout: 180_000 }, async t => {
  const f = await launch(t, 'trial-recovery'), { page } = f;
  await f.electron.evaluate(() => { delete process.env.GH_TOKEN; delete process.env.GITHUB_TOKEN; });
  await f.start(); await f.finished('blocked'); await expect(page.locator('#trial-result')).toContainText('credentials'); assert.equal((await f.calls()).length, 0);
  await page.screenshot({ path: join(proof!, 'trial-07-missing-auth.png'), fullPage: true });
  await f.electron.evaluate(() => { process.env.GH_TOKEN = 'fictional-desktop-read-token'; (globalThis as any).trialFixture.mode = 'partial'; });
  await f.start(); await f.finished(); assert.equal((await f.last()).analysis!.decision, 'incomplete'); await expect(page.locator('#trial-result')).toContainText('Missing evidence');
  await page.screenshot({ path: join(proof!, 'trial-08-partial-evidence.png'), fullPage: true });
  await f.electron.evaluate(() => { (globalThis as any).trialFixture.mode = 'complete'; });
  await f.mode('codex', 'error'); await f.start(); await f.finished('provider_error'); await page.screenshot({ path: join(proof!, 'trial-09-provider-failure.png'), fullPage: true });
  await f.mode('codex', 'hang'); await f.start(); await expect(page.locator('#trial-cancel')).toBeEnabled();
  await page.locator('#trial-pr').fill('43'); await f.finished('superseded'); await expect(page.locator('#trial-result')).toContainText('selected inputs changed');
  await page.locator('#trial-pr').fill('42'); await f.start();
  await page.locator('#simulation-tab').click();
  await f.electron.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => { (globalThis as any).trialPickerPending = true; await new Promise<void>(resolve => { (globalThis as any).releaseTrialPicker = resolve; }); return { canceled: true, filePaths: [] }; }; });
  await page.locator('#load-fixture').click(); await expect.poll(() => f.electron.evaluate(() => (globalThis as any).trialPickerPending)).toBe(true);
  await page.locator('#trial-cancel').focus(); await page.keyboard.press('Enter'); await f.finished('cancelled');
  await page.screenshot({ path: join(proof!, 'trial-10-keyboard-cancel-pending-picker.png'), fullPage: true });
  await f.electron.evaluate(() => { (globalThis as any).releaseTrialPicker(); }); await expect(page.locator('#load-fixture')).toBeEnabled();
  await page.locator('#trial-tab').click(); await f.start();
  await page.locator('#process-tab').click(); await page.locator('#action-select').selectOption('wait_review'); await page.locator('#setting-reviewWaitSeconds').fill(''); await f.finished('superseded');
  await expect(page.locator('#setting-reviewWaitSeconds')).toHaveValue(''); await page.screenshot({ path: join(proof!, 'trial-11-incomplete-inspector.png'), fullPage: true });
  await page.locator('#discard-settings').click(); await page.locator('#trial-tab').click(); await f.start();
  const record = await f.last(); await f.pick(join(f.source.repository, f.source.pkg.workflowPath)); await page.locator('#open-workflow').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Stop and open' }).click();
  await expect.poll(async () => (await f.trial()).snapshot?.sessionId).not.toBe(record.document.sessionId);
  assert.equal(JSON.parse(await readFile(record.recordPath, 'utf8')).status, 'cancelled');
  await page.locator('#trial-tab').click(); await expect(page.locator('#trial-result')).toContainText('cancelled');
  await page.locator('#trial-repository').fill('reef-labs/paperboat'); await page.locator('#trial-pr').fill('42'); await page.locator('#trial-profile').selectOption('codex_trial'); await f.start();
  const closing = await f.last();
  assert.equal(await f.electron.evaluate(() => (globalThis as any).trialFixture.mutations), 0);
  await f.electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect(page.getByRole('dialog')).toBeVisible(); await page.screenshot({ path: join(proof!, 'trial-12-close-confirmation.png'), fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: 'Stop and close' }).click(); await expect.poll(() => page.isClosed()).toBe(true);
  assert.equal(JSON.parse(await readFile(closing.recordPath, 'utf8')).status, 'cancelled');
  assert.deepEqual(f.errors, []); assert.deepEqual(f.requests, []);
});

for (const provider of ['codex', 'claude'] as const) test(`Electron ${provider} prepares through actual tools, preserves pending input and requires human Start`, { timeout: 150_000 }, async t => {
  const f = await launch(t, `trial-${provider}-proposal`, false), { page } = f;
  const reviewPath = f.source.pkg.files.find(file => file.path.endsWith('/review.md'))!.path;
  const chatCalls = async () => (await readFile(join(f.source.temporary, `${provider}-chat.jsonl`), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const replies = async () => (await chatCalls()).filter(item => item.authoringResult).map(item => item.authoringResult);
  const send = async (name: string, steps: unknown[]) => {
    await writeFile(join(f.source.temporary, `${provider}-plan.json`), JSON.stringify({ id: name.replace(/[^a-zA-Z0-9_.:-]/g, '-'), steps })); await writeFile(join(f.source.temporary, `${provider}-chat.mode`), 'author');
    await page.locator('#conversation-question').fill(name); await page.locator('#conversation-send').click();
  };
  const done = () => expect.poll(() => page.evaluate(async () => (await window.repoChapConversation.current()).conversation?.history.findLast(entry => entry.kind === 'turn')?.status), { timeout: 20_000 }).toBe('completed');
  const proposal = { tool: 'prepare_live_trial', arguments: { repository: 'reef-labs/paperboat', pr: 42, profile: `${provider}_trial`, sourceId: 'workspace' } };
  await page.locator('#conversation-tab').click(); await f.pick(f.source.settings); await page.locator('#conversation-load-profiles').click(); await page.locator('#conversation-profile').selectOption(`${provider}_author`); await page.locator('#conversation-use-profile').click();
  await send('Prepare after an unsaved edit', [
    { action: { kind: 'edit', changes: [{ path: reviewPath, text: '# Assistant staged review\nKeep this unsaved.\n' }] } },
    { ...proposal, arguments: { ...proposal.arguments, profile: 'unknown-profile' } },
    { ...proposal, arguments: { ...proposal.arguments, sourceId: 'unapproved-source' } }, proposal,
  ]); await done();
  let results = await replies(); assert.equal(results[0].receipt.status, 'applied'); assert.equal(results[1].prepared, false); assert.equal(results[2].prepared, false); assert.equal(results[3].prepared, true); assert.equal(results[3].started, false);
  const prepared = (await f.trial()).trial!.proposal!; assert.equal(prepared.preparedBy, 'assistant'); assert.equal(prepared.document.revision, (await f.trial()).snapshot!.revision);
  const unsaved = (await f.trial()).snapshot!.files.find(file => file.path === reviewPath)!;
  assert.equal(unsaved.text, '# Assistant staged review\nKeep this unsaved.\n'); assert.equal(unsaved.dirty, true); assert.ok(prepared.document.revision > 0);
  assert.equal((await f.calls()).length, 0); assert.equal((await f.calls('claude')).length, 0); assert.equal(await f.electron.evaluate(() => (globalThis as any).trialFixture.queries.length), 0);
  assert.notEqual(await readFile(join(f.source.repository, reviewPath), 'utf8'), '# Assistant staged review\nKeep this unsaved.\n');
  await page.locator('#trial-tab').click(); await expect(page.locator('#trial-proposal')).toContainText('Prepared only'); await expect(page.locator('#trial-profile')).toHaveValue(`${provider}_trial`);
  await page.screenshot({ path: join(proof!, `trial-13-${provider}-assistant-proposal.png`), fullPage: true });
  await page.locator('#trial-start').focus(); await page.keyboard.press('Enter'); await f.finished(); const retained = await f.last();
  assert.equal(retained.document.revision, prepared.document.revision); assert.equal(retained.provider.provider, provider);
  const pinned = JSON.parse(await readFile(join(dirname(retained.recordPath), 'package.json'), 'utf8'));
  assert.equal(pinned.files.find((file: any) => file.path === reviewPath).text, unsaved.text);
  const beforeCalls = (await f.calls(provider)).length, beforeReads = await f.electron.evaluate(() => (globalThis as any).trialFixture.queries.length);
  await page.locator('#conversation-tab').click(); const gate = join(f.source.temporary, 'capture-proposal');
  await send('Preserve text typed after Send', [{ ...proposal, gate }]);
  await expect.poll(async () => (await chatCalls()).some(item => item.waitingForStep === 0)).toBe(true);
  await page.locator('#source-tab').click(); await page.getByRole('button', { name: reviewPath, exact: true }).first().click(); await page.locator('#source').fill('# Newer human review\nPreserve these bytes.\n');
  await writeFile(gate, 'continue'); await done(); results = await replies(); assert.equal(results.at(-1).prepared, false); assert.equal(results.at(-1).started, false);
  assert.equal((await f.trial()).snapshot!.files.find(file => file.path === reviewPath)!.text, '# Newer human review\nPreserve these bytes.\n');
  assert.equal((await f.trial()).trial!.proposal, null); assert.equal((await f.last()).id, retained.id);
  await page.locator('#conversation-tab').click(); await page.locator('#conversation-fresh').click();
  assert.equal((await f.last()).id, retained.id); assert.equal(JSON.parse(await readFile(retained.recordPath, 'utf8')).id, retained.id);
  assert.equal((await f.calls(provider)).length, beforeCalls); assert.equal(await f.electron.evaluate(() => (globalThis as any).trialFixture.queries.length), beforeReads);
  assert.equal(await f.electron.evaluate(() => (globalThis as any).trialFixture.mutations), 0); assert.deepEqual(f.errors, []); assert.deepEqual(f.requests, []);
  await page.screenshot({ path: join(proof!, `trial-14-${provider}-preserved-evidence.png`), fullPage: true });
});
