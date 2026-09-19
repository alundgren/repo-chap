import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { _electron, expect } from '@playwright/test';
import { loadWorkflow } from '@repo-chap/workflow';

const { values } = parseArgs({ options: {
  provider: { type: 'string' }, model: { type: 'string' }, executable: { type: 'string' },
  'allow-model-calls': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('Usage: node run.mjs --provider codex|claude --model MODEL [--executable PATH] --allow-model-calls\nRuns two real model turns in an isolated Electron workflow. Reports stay outside Git.');
  process.exit(0);
}
if (!values['allow-model-calls'] || !['codex', 'claude'].includes(values.provider) || !values.model?.trim()) {
  console.error('Explicit --allow-model-calls, --provider codex|claude and --model are required. No model call was made.');
  process.exit(2);
}
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const executable = values.executable ?? values.provider;
const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
const directory = await realpath(await mkdtemp(join(tmpdir(), 'repo-chap-real-cli-')));
const repo = join(directory, 'fictional-repository');
const workflowPath = 'docs/pr-workflows/examples/team-pr/workflow.json';
const markdownPath = 'docs/pr-workflows/examples/team-pr/review.md';
const pkg = await loadWorkflow(join(root, workflowPath));
for (const file of pkg.files) {
  await mkdir(dirname(join(repo, file.path)), { recursive: true, mode: 0o700 });
  await writeFile(join(repo, file.path), file.text, { mode: 0o600 });
}
const settings = join(directory, 'providers.json');
await writeFile(settings, JSON.stringify({ schemaVersion: 1, profiles: { integration: {
  provider: values.provider, executable, model: values.model, timeoutMs: 180_000,
  maxOutputBytes: 4 * 1024 * 1024, maxAttempts: 1, maximumCapabilities: [],
} } }), { mode: 0o600 });
const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
env.REPO_CHAP_DESKTOP_DATA = join(directory, 'app-data');
const report = { provider: values.provider, model: values.model, executable, version, stages: [], passed: false };
const stage = name => { report.stages.push(name); console.log(`Passed: ${name}`); };
let electron, page;
console.log(`Real CLI integration: ${values.provider} / ${values.model}\nPrivate evidence: ${directory}`);
try {
  electron = await _electron.launch({ executablePath: createRequire(join(root, 'apps/desktop/package.json'))('electron'),
    args: [join(root, 'apps/desktop'), '--workflow', join(repo, workflowPath), '--repo-root', repo], env });
  page = await electron.firstWindow();
  page.setDefaultTimeout(15_000);
  await expect(page.locator('#validation-title')).toHaveText('Validation passed');
  stage('open fictional workflow');
  await page.locator('#conversation-tab').click();
  await electron.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, settings);
  await page.locator('#conversation-load-profiles').click();
  await page.locator('#conversation-profile').selectOption('integration');
  await page.locator('#conversation-use-profile').click();
  await expect(page.locator('#conversation-selected-provider')).toContainText(values.model);
  stage('select real provider');
  const snapshot = () => page.evaluate(async () => (await window.repoChap.current()).snapshot);
  const chat = () => page.evaluate(() => window.repoChapConversation.current());
  const nonce = randomUUID();
  let firstSession, firstText;
  for (let index = 1; index <= 2; index++) {
    const text = `# Fictional integration ${nonce}\n\nTurn ${index}.\n`;
    const prompt = `This is an integration test on a fictional workflow. Use the registered author tool to read ${markdownPath}, replace its draft text with exactly ${JSON.stringify(text)}, then validate. Include the current document token as expected and use unique operationIds. After each operation use the returned context token for the next operation. Make these app tool calls now; a proposed edit in your answer does not count. Keep changes unsaved. Reply briefly when the tool receipts confirm completion.`;
    const previousReceipts = new Set((await snapshot()).authoringReceipts.map(receipt => receipt.operationId));
    await page.locator('#conversation-question').fill(prompt);
    await page.locator('#conversation-send').click();
    await expect.poll(async () => {
      const turn = (await chat()).conversation?.history.findLast(entry => entry.kind === 'turn');
      return turn?.prompt === prompt && ['completed', 'error', 'cancelled'].includes(turn.status);
    }, { timeout: 195_000 }).toBe(true);
    const conversation = (await chat()).conversation;
    const turn = conversation.history.findLast(entry => entry.kind === 'turn');
    assert.equal(turn.status, 'completed', JSON.stringify(turn.error));
    const state = await snapshot();
    assert.equal(state.files.find(file => file.path === markdownPath).text, text);
    assert.equal(state.files.find(file => file.path === markdownPath).dirty, true);
    const receipts = state.authoringReceipts.filter(receipt => !previousReceipts.has(receipt.operationId));
    for (const kind of ['read', 'edit', 'validate']) assert(receipts.some(receipt => receipt.kind === kind && ['applied', 'completed'].includes(receipt.status)), `Missing successful ${kind} receipt`);
    assert.equal(await readFile(join(repo, markdownPath), 'utf8'), pkg.files.find(file => file.path === markdownPath).text);
    if (index === 1) { firstSession = conversation.session.id; firstText = text; }
    else { assert.equal(conversation.session.id, firstSession); assert.equal(conversation.session.turns, 2); }
    stage(`turn ${index}: real author read, draft edit and validation${index === 2 ? ', resumed session' : ''}`);
  }
  await page.locator('#undo').click();
  assert.equal((await snapshot()).files.find(file => file.path === markdownPath).text, firstText);
  stage('undo restores first draft');
  await page.locator('#save').click();
  await expect(page.locator('#message')).toHaveText('Saved all changed files.');
  assert.equal(await readFile(join(repo, markdownPath), 'utf8'), firstText);
  stage('explicit save writes only the temporary workflow');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(directory, 'desktop.png'), fullPage: true }).catch(() => {});
    report.conversation = await page.evaluate(() => window.repoChapConversation.current()).catch(() => null);
    await page.evaluate(async () => {
      const { conversation } = await window.repoChapConversation.current();
      if (conversation?.activeTurnId) await window.repoChapConversation.cancel(conversation.id, conversation.activeTurnId);
    }).catch(() => {});
  }
  await electron?.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await electron?.close().catch(() => {});
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`${report.passed ? 'PASS' : 'FAIL'}: ${join(directory, 'report.json')}`);
  if (report.error) console.error(report.error);
}
