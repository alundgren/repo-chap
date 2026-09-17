import { app, BrowserWindow, dialog, ipcMain, Menu, session as electronSession } from 'electron';
import { basename, join, resolve } from 'node:path';
import { realpath, writeFile } from 'node:fs/promises';
import { readFixtureText } from '@repo-chap/workflow';
import { pathToFileURL } from 'node:url';
import { DocumentSession } from './documents.js';
import type { DocumentToken, EditorResult, OpenKind, SimulationInputKind, VisualEdit } from './protocol.js';

let window: BrowserWindow | null = null;
let documents: DocumentSession | null = null;
let allowClose = false;
let operations = Promise.resolve();
const pagePath = join(__dirname, 'index.html');
const pageUrl = pathToFileURL(pagePath).href;
app.setName('Repo Chap');
// Explicit paths support local launch and keep Electron's profile outside the managed repository.
if (process.env.REPO_CHAP_DESKTOP_DATA) app.setPath('userData', resolve(process.env.REPO_CHAP_DESKTOP_DATA));

function current(): EditorResult { return { snapshot: documents?.snapshot() ?? null }; }
function requireDocuments(token: DocumentToken): DocumentSession {
  if (!documents) throw new Error('Open a workflow first.');
  documents.assertCurrent(token);
  return documents;
}
function register(name: string, operation: (...args: any[]) => Promise<void | EditorResult> | void | EditorResult): void {
  ipcMain.handle(`editor:${name}`, (event, ...args: unknown[]) => {
    if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== pageUrl) throw new Error('This editor operation is unavailable.');
    const response = operations.then(async (): Promise<EditorResult> => {
      try { return await operation(...args) ?? current(); }
      catch (error) { return { ...current(), error: error instanceof Error ? error.message : 'The operation failed. Your drafts have been kept.' }; }
    });
    operations = response.then(() => {});
    return response;
  });
}

register('current', current);
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
  documents = next;
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
register('close', (token: DocumentToken | null, discard: boolean) => {
  if (documents) {
    documents.assertCurrent(token!);
    if (documents.dirty && discard !== true) throw new Error('Save or discard your drafts before closing.');
  }
  allowClose = true;
  window?.close();
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
  window.on('closed', () => { window = null; documents = null; });
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
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!window) void createWindow(); });
