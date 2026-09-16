import { app, BrowserWindow, dialog, ipcMain, Menu, session as electronSession } from 'electron';
import { basename, dirname, join, resolve } from 'node:path';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { readFixtureText } from '@repo-chap/workflow';
import { prepareCaptureDirectory } from '@repo-chap/github';
import { readProfiles } from '@repo-chap/providers';
import type { ConversationInputAnswer, ProviderProfile } from '@repo-chap/providers';
import { pathToFileURL } from 'node:url';
import { AuthoringTools } from './authoring-tools.js';
import type { AuthoringOperation } from './authoring-protocol.js';
import { DocumentSession } from './documents.js';
import { ConversationController } from './conversations.js';
import { TrialController } from './trials.js';
import type { TrialResult, TrialSelection } from './trial-protocol.js';
import { captureConversationContext } from './conversation-context.js';
import type { ConversationContextSelection, ConversationResult } from './conversation-protocol.js';
import type { DocumentToken, EditorResult, OpenKind, SimulationInputKind, VisualEdit } from './protocol.js';

let window: BrowserWindow | null = null;
let documents: DocumentSession | null = null;
let conversation: ConversationController | null = null;
let trials: TrialController | null = null;
let trialLoading: Promise<TrialController> | null = null;
let sourceRepositories = new Set<string>();
let conversationDirectory: string | null = null;
let conversationCleanup = Promise.resolve();
let profiles: ProviderProfile[] = [];
const authoring = new AuthoringTools(() => documents, id => window?.webContents.send('authoring:requested', id));
let allowClose = false;
let operations = Promise.resolve();
const pagePath = join(__dirname, 'index.html');
const pageUrl = pathToFileURL(pagePath).href;
app.setName('Repo Chap');
// Explicit paths support local launch and keep Electron's profile outside the managed repository.
if (process.env.REPO_CHAP_DESKTOP_DATA) app.setPath('userData', resolve(process.env.REPO_CHAP_DESKTOP_DATA));

function current(): EditorResult { return { snapshot: documents?.snapshot() ?? null }; }
function currentConversation(): ConversationResult {
  return { ...current(), conversation: conversation?.snapshot() ?? null, profiles: profiles.map(({ provider, name, model, effort }) => ({ provider, name, model, ...(effort ? { effort } : {}) })) };
}
function requireDocuments(token: DocumentToken): DocumentSession {
  if (!documents) throw new Error('Open a workflow first.');
  documents.assertCurrent(token);
  return documents;
}

function registerConversation(name: string, operation: (...args: any[]) => Promise<void | ConversationResult> | void | ConversationResult, queued = true): void {
  ipcMain.handle(`conversation:${name}`, (event, ...args: unknown[]) => {
    if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== pageUrl) throw new Error('This conversation operation is unavailable.');
    const run = async (): Promise<ConversationResult> => {
      try { return await operation(...args) ?? currentConversation(); }
      catch (error) { return { ...currentConversation(), error: error instanceof Error ? error.message : 'The conversation operation failed. Your drafts have been kept.' }; }
    };
    if (!queued) return run();
    const response = operations.then(run);
    operations = response.then(() => {});
    return response;
  });
}
function requireConversation(id?: string): ConversationController {
  if (!conversation || id !== undefined && conversation.snapshot().id !== id) throw new Error('This conversation is no longer active. Choose a provider for the open workflow.');
  return conversation;
}
async function closeConversation(): Promise<void> {
  const closing = conversation, directory = conversationDirectory;
  conversation = null; conversationDirectory = null;
  if (closing || directory) {
    const cleanup = conversationCleanup.then(async () => {
      await closing?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    // Report this failure to its caller without preventing a later explicit recovery.
    conversationCleanup = cleanup.catch(() => {});
    await cleanup;
    return;
  }
  await conversationCleanup;
}
async function startConversation(profile: ProviderProfile): Promise<void> {
  await conversationCleanup;
  if (!documents) throw new Error('Open a workflow first.');
  const root = await realpath(app.getPath('userData'));
  for (let path = root; ; path = dirname(path)) {
    if (await lstat(join(path, '.git')).catch(() => null)) throw new Error('Keep the desktop application data directory outside Git.');
    if (dirname(path) === path) break;
  }
  const parent = join(root, 'conversations');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== parent || await lstat(join(parent, '.git')).catch(() => null)) throw new Error('Keep the private conversation directory outside Git and do not redirect it with a symbolic link.');
  const source = documents;
  const directory = await mkdtemp(join(parent, 'session-'));
  try {
    conversation = new ConversationController({
      documentSessionId: documents.sessionId, workingDirectory: directory, profile, tools: () => authoring.tools(source),
      onChange(snapshot) { if (window && !window.isDestroyed() && documents?.sessionId === snapshot.documentSessionId) window.webContents.send('conversation:changed', snapshot); },
    });
    conversationDirectory = directory;
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

registerConversation('current', currentConversation, false);
registerConversation('load-profiles', async () => {
  if (!window) return;
  const choice = await dialog.showOpenDialog(window, { title: 'Load private Repo Chap provider settings', properties: ['openFile'], filters: [{ name: 'Provider settings JSON', extensions: ['json'] }] });
  if (choice.canceled || !choice.filePaths[0]) return { ...currentConversation(), cancelled: true };
  const next = await readProfiles(choice.filePaths[0]);
  if (next.some(profile => Buffer.byteLength(JSON.stringify(profile)) > 8192)) throw new Error('Each conversation profile must fit within 8 KiB.');
  trials?.profilesChanged(next); profiles = next;
});
registerConversation('select-profile', async (documentSessionId: string, name: string) => {
  if (!documents || documentSessionId !== documents.sessionId) throw new Error('The open workflow changed. Choose its provider again.');
  const selected = profiles.find(profile => profile.name === name);
  if (!selected) throw new Error('Load provider settings and choose one of their named profiles.');
  if (conversation) await conversation.selectProvider(selected);
  else await startConversation(selected);
});
registerConversation('send', (token: DocumentToken, prompt: string, selection: ConversationContextSelection) => {
  const source = requireDocuments(token), chat = requireConversation();
  const captured = captureConversationContext(source.snapshot(), selection, trials?.snapshot());
  void chat.send(prompt, captured);
});
// Replies and cancellation must remain available during pending or rejected document capture.
registerConversation('cancel', async (id: string, turnId: string) => {
  const chat = requireConversation(id);
  if (chat.snapshot().activeTurnId !== turnId) throw new Error('That turn is no longer running.');
  await chat.cancel();
}, false);
registerConversation('answer', (id: string, turnId: string, requestId: string, answer: ConversationInputAnswer) => requireConversation(id).answer(turnId, requestId, answer), false);
registerConversation('fresh', async (id: string) => requireConversation(id).fresh(), false);
function register(name: string, operation: (...args: any[]) => Promise<void | EditorResult> | void | EditorResult): void {
  ipcMain.handle(`editor:${name}`, (event, ...args: unknown[]) => {
    if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== pageUrl) throw new Error('This editor operation is unavailable.');
    const response = operations.then(async (): Promise<EditorResult> => {
      try { const result = await operation(...args); trials?.documentChanged(); return result ?? current(); }
      catch (error) { return { ...current(), error: error instanceof Error ? error.message : 'The operation failed. Your drafts have been kept.' }; }
    });
    operations = response.then(() => {});
    return response;
  });
}

register('current', current);
register('author', async (operation: AuthoringOperation) => {
  if (!documents) throw new Error('Open a workflow first.');
  const result = await documents.author(operation);
  return { ...current(), authoringOperationId: operation.operationId, ...(result.receipt.status === 'rejected' ? { error: result.receipt.message } : {}) };
});
register('open-test-fixture', async (token: DocumentToken) => {
  const source = requireDocuments(token);
  if (!window) return;
  const choice = await dialog.showOpenDialog(window, { title: 'Open repository test fixture', defaultPath: source.repositoryRoot, properties: ['openFile'], filters: [{ name: 'Fixture JSON', extensions: ['json'] }] });
  if (choice.canceled || !choice.filePaths[0]) return { ...current(), cancelled: true };
  await source.openTestFixture(token, choice.filePaths[0]);
});
register('undo', (token: DocumentToken) => requireDocuments(token).undo(token));
register('apply-authoring', async (id: string, token: DocumentToken) => authoring.apply(id, token));
registerConversation('reject-authoring', (id: string, pending: { field: string; value: string }[]) => authoring.reject(id, pending), false);
registerConversation('confirm-operation', (id: string) => documents?.confirmDisplay(id), false);
registerConversation('confirm-authoring', (id: string) => authoring.confirm(id), false);
register('open', async (kind: OpenKind, token: DocumentToken | null, discard: boolean) => {
  if (!window || (kind !== 'repository' && kind !== 'workflow')) throw new Error('Choose a repository or workflow.');
  if (documents) {
    documents.assertCurrent(token!);
    if (documents.dirty && discard !== true) throw new Error('Save or discard your drafts before opening another workflow.');
  }
  let repositoryRoot: string | undefined;
  if (kind === 'repository') {
    const result = await dialog.showOpenDialog(window, { title: 'Open repository', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { ...current(), cancelled: true };
    repositoryRoot = result.filePaths[0];
  }
  const result = await dialog.showOpenDialog(window, {
    title: 'Choose workflow JSON', properties: ['openFile'],
    ...(repositoryRoot ? { defaultPath: repositoryRoot } : {}),
    filters: [{ name: 'Workflow JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { ...current(), cancelled: true };
  const next = await DocumentSession.open(result.filePaths[0], repositoryRoot);
  await closeConversation();
  await trials?.close();
  documents = next; trials = null; sourceRepositories = new Set([next.repositoryRoot]);
});
register('edit', async (token: DocumentToken, path: string, text: string) => requireDocuments(token).edit(token, path, text));
register('save', async (token: DocumentToken) => requireDocuments(token).save(token));
register('reload', async (token: DocumentToken, path: string) => requireDocuments(token).reload(token, path));
register('discard', (token: DocumentToken, path: string) => requireDocuments(token).discard(token, path));
register('visual-edit', (token: DocumentToken, edit: VisualEdit) => requireDocuments(token).visualEdit(token, edit));
register('reset', (token: DocumentToken) => requireDocuments(token).reset(token));
register('load-simulation-input', async (token: DocumentToken, kind: SimulationInputKind) => {
  const session = requireDocuments(token);
  if (!window || !['fixture', 'packets'].includes(kind)) throw new Error('Choose fixture or packet input.');
  const choice = await dialog.showOpenDialog(window, { title: kind === 'fixture' ? 'Load offline fixture JSON' : 'Load decision packet JSON', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (choice.canceled || !choice.filePaths[0]) return { ...current(), cancelled: true };
  session.setSimulationInput(token, kind, await readFixtureText(choice.filePaths[0]), basename(choice.filePaths[0]));
});
register('edit-simulation-input', (token: DocumentToken, kind: SimulationInputKind, text: string) => requireDocuments(token).setSimulationInput(token, kind, text));
register('reset-simulation-input', (token: DocumentToken, kind: SimulationInputKind) => requireDocuments(token).resetSimulationInput(token, kind));
register('set-clock', (token: DocumentToken, now: string) => requireDocuments(token).setClock(token, now));
register('simulate', (token: DocumentToken) => requireDocuments(token).simulate(token));
register('export-workflow', async (token: DocumentToken) => {
  const session = requireDocuments(token);
  const text = session.exportText(token);
  if (!window) return;
  const choice = await dialog.showSaveDialog(window, { title: 'Export workflow JSON copy', defaultPath: `${basename(session.workflowPath, '.json')}-export.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (choice.canceled || !choice.filePath) return { ...current(), cancelled: true };
  const target = await realpath(choice.filePath).catch(() => resolve(choice.filePath!));
  for (const file of session.snapshot().files) {
    const source = resolve(session.repositoryRoot, file.path);
    if (target === source || target === await realpath(source).catch(() => source)) throw new Error('Use Save all to update an open source file. Export must be a separate copy.');
  }
  await writeFile(choice.filePath, text, 'utf8');
});
register('check-external', async () => { await documents?.checkExternal(); });
register('close', async (token: DocumentToken | null, discard: boolean) => {
  if (documents) {
    documents.assertCurrent(token!);
    if (documents.dirty && discard !== true) throw new Error('Save or discard your drafts before closing.');
  }
  await closeConversation();
  await trials?.close();
  allowClose = true;
  window?.close();
});

function currentTrial(): TrialResult {
  return { ...current(), trial: trials?.snapshot() ?? null, profiles: currentConversation().profiles };
}
async function trialController(): Promise<TrialController> {
  if (!documents) throw new Error('Open a workflow first.');
  if (trials) return trials;
  if (trialLoading) return trialLoading;
  const owner = documents;
  sourceRepositories.add(owner.repositoryRoot);
  const controller = new TrialController({ directory: join(app.getPath('userData'), 'live-trials'), getDocument: () => owner.snapshot(),
    onChange(snapshot) { if (window && !window.isDestroyed() && documents?.sessionId === snapshot.documentSessionId) window.webContents.send('trial:changed', snapshot); },
  });
  trialLoading = controller.restore().then(() => {
    if (documents !== owner) throw new Error('The open workflow changed. Load its trial history again.');
    trials = controller; return controller;
  }).finally(() => { trialLoading = null; });
  return trialLoading;
}
function requireTrialSession(id: string): TrialController {
  if (!documents || id !== documents.sessionId || !trials) throw new Error('This trial belongs to a different workflow session.');
  return trials;
}
function trialProfile(selection: TrialSelection): ProviderProfile {
  const profile = profiles.find(item => item.name === selection?.profile);
  if (!profile) throw new Error('Load private provider settings and choose a named profile.');
  if (!sourceRepositories.has(selection.sourceRepository)) throw new Error('Choose the local Git source using the source picker first.');
  return profile;
}
function registerTrial(name: string, operation: (...args: any[]) => Promise<void | TrialResult> | void | TrialResult, queued = true): void {
  ipcMain.handle(`trial:${name}`, (event, ...args: unknown[]) => {
    if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== pageUrl) throw new Error('This trial operation is unavailable.');
    const run = async (): Promise<TrialResult> => {
      try { return await operation(...args) ?? currentTrial(); }
      catch (error) { return { ...currentTrial(), error: error instanceof Error ? error.message : 'The trial operation could not finish. Your drafts remain unchanged.' }; }
    };
    if (!queued) return run();
    const response = operations.then(run); operations = response.then(() => {}); return response;
  });
}
registerTrial('current', async () => { if (documents) await trialController(); return currentTrial(); }, false);
registerTrial('load-profiles', async () => {
  if (!window) return;
  const choice = await dialog.showOpenDialog(window, { title: 'Load private Repo Chap provider settings', properties: ['openFile'], filters: [{ name: 'Provider settings JSON', extensions: ['json'] }] });
  if (choice.canceled || !choice.filePaths[0]) return { ...currentTrial(), cancelled: true };
  const next = await readProfiles(choice.filePaths[0]);
  if (next.some(profile => Buffer.byteLength(JSON.stringify(profile)) > 8192)) throw new Error('Each provider profile must fit within 8 KiB.');
  trials?.profilesChanged(next); profiles = next;
});
registerTrial('choose-source', async (id: string) => {
  if (id !== documents?.sessionId || !window) throw new Error('Open the workflow before choosing its local Git source.');
  const choice = await dialog.showOpenDialog(window, { title: 'Choose local Git objects for the PR', properties: ['openDirectory'], defaultPath: documents.repositoryRoot });
  if (choice.canceled || !choice.filePaths[0]) return { ...currentTrial(), cancelled: true };
  const sourceRepository = await realpath(choice.filePaths[0]); sourceRepositories.add(sourceRepository); trials?.invalidate();
  return { ...currentTrial(), sourceRepository };
});
registerTrial('prepare', async (token: DocumentToken, selection: TrialSelection) => {
  const source = requireDocuments(token); const controller = await trialController(); source.assertCurrent(token);
  controller.prepare(source.snapshot(), selection, trialProfile(selection));
});
registerTrial('start', async (token: DocumentToken, selection: TrialSelection) => {
  const source = requireDocuments(token); const controller = await trialController(); source.assertCurrent(token);
  controller.start(source.snapshot(), selection, trialProfile(selection));
});
registerTrial('invalidate', (id: string) => requireTrialSession(id).invalidate(), false);
registerTrial('cancel', async (id: string, trialId: string) => requireTrialSession(id).cancel(trialId), false);
registerTrial('refresh', async (id: string, trialId: string) => requireTrialSession(id).refresh(trialId), false);
registerTrial('export-fixture', async (id: string, trialId: string) => {
  const controller = requireTrialSession(id); const exported = await controller.fixture(trialId);
  if (!window) return;
  const choice = await dialog.showOpenDialog(window, { title: 'Choose a private fixture export directory outside Git', defaultPath: app.getPath('userData'), properties: ['openDirectory', 'createDirectory'] });
  if (choice.canceled || !choice.filePaths[0]) return { ...currentTrial(), cancelled: true };
  const parent = await prepareCaptureDirectory(choice.filePaths[0]);
  const directory = await mkdtemp(join(parent, 'fixture-export-'));
  await writeFile(join(directory, 'fixture.json'), exported.text, { mode: 0o600, flag: 'wx' });
  await writeFile(join(directory, 'provenance.json'), exported.provenance, { mode: 0o600, flag: 'wx' });
  return { ...currentTrial(), exportedDirectory: directory };
});

async function createWindow(): Promise<void> {
  allowClose = false;
  window = new BrowserWindow({
    width: 1200, height: 850, minWidth: 360, minHeight: 480, title: 'Repo Chap',
    backgroundColor: '#F2EADE',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('close', event => {
    if (allowClose) return;
    event.preventDefault();
    window?.webContents.send('editor:close-requested');
  });
  window.on('closed', () => {
    window = null; const owner = documents;
    void Promise.all([trials?.close(), closeConversation()]).finally(() => { if (documents === owner) { documents = null; trials = null; sourceRepositories.clear(); } }).catch(() => {});
  });
  window.webContents.on('render-process-gone', () => { void trials?.close().catch(() => {}); void closeConversation().catch(() => {}); });
  await window.loadFile(pagePath);
}

void app.whenReady().then(async () => {
  electronSession.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  electronSession.defaultSession.setPermissionCheckHandler(() => false);
  electronSession.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(pathToFileURL(`${__dirname}/`).href) });
  });
  const fileIndex = process.argv.indexOf('--workflow');
  const rootIndex = process.argv.indexOf('--repo-root');
  let openingError: string | undefined;
  if (fileIndex >= 0 && process.argv[fileIndex + 1]) {
    try { documents = await DocumentSession.open(resolve(process.argv[fileIndex + 1]!), rootIndex >= 0 ? process.argv[rootIndex + 1] : undefined); }
    catch (error) { openingError = error instanceof Error ? error.message : 'Cannot open the workflow.'; }
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { label: 'File', submenu: [{ label: 'Close window', accelerator: 'CmdOrCtrl+W', click: () => window?.close() }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ]));
  await createWindow();
  if (openingError && window) void dialog.showMessageBox(window, { type: 'error', title: 'Cannot open workflow', message: openingError });
});
app.on('window-all-closed', () => { void Promise.all([closeConversation(), trials?.close()]).finally(() => { if (process.platform !== 'darwin') app.quit(); }).catch(() => {}); });
app.on('activate', () => { if (!window) void createWindow(); });
