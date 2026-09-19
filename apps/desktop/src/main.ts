import { app, BrowserWindow, dialog, ipcMain, Menu, session } from 'electron';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { controlDirectory, privateDirectory, serveCompanion } from '@repo-chap/companion';
import type { CompanionCommand, CompanionRequest, CompanionResponse, InputMode } from '@repo-chap/companion';
import { CompanionSession } from './companion.js';

app.setName('Repo Chap');
if (process.env.REPO_CHAP_DESKTOP_DATA) app.setPath('userData', resolve(process.env.REPO_CHAP_DESKTOP_DATA));
const pagePath = join(__dirname, 'index.html'), pageUrl = pathToFileURL(pagePath).href;
let window: BrowserWindow | null = null;
let stopControl: (() => Promise<void>) | undefined;
let poll: ReturnType<typeof setInterval> | undefined;
let closing = false, polling = false;
let savedSelection = '';
let persistence = Promise.resolve();
const companion = new CompanionSession(state => {
  if (window && !window.isDestroyed()) window.webContents.send('companion:changed', state);
  const selection = JSON.stringify({ repositoryRoot: state.repositoryRoot, workflowPath: state.workflowPath });
  if (selection === savedSelection) return;
  savedSelection = selection;
  persistence = persistence.then(async () => {
    const file = join(app.getPath('userData'), 'companion', 'selection.json');
    await writeFile(`${file}.tmp`, selection, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }).catch(() => { savedSelection = ''; });
});

async function run(request: CompanionRequest): Promise<CompanionResponse> {
  const response = await companion.execute(request);
  if (response.ok && ['open', 'show', 'highlight', 'select'].includes(request.command.kind)) {
    if (!window) await createWindow();
    if (window?.isMinimized()) window.restore();
    window?.show(); window?.focus();
  }
  return response;
}
function register(name: string, handler: (...args: any[]) => unknown): void {
  ipcMain.handle(`companion:${name}`, (event, ...args: unknown[]) => {
    if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== pageUrl) throw new Error('This companion operation is unavailable.');
    return handler(...args);
  });
}
register('current', () => companion.snapshot());
register('command', (command: CompanionCommand) => run({ schemaVersion: 1, command }));
register('choose-repository', async () => {
  if (!window) return null;
  const choice = await dialog.showOpenDialog(window, { title: 'Open repository', properties: ['openDirectory'] });
  return choice.canceled || !choice.filePaths[0] ? null : run({ schemaVersion: 1, command: { kind: 'open', repositoryRoot: choice.filePaths[0] } });
});
register('choose-input', async (mode: InputMode) => {
  if (!window || !['tests', 'pr'].includes(mode)) return null;
  const before = companion.snapshot();
  const choice = await dialog.showOpenDialog(window, { title: mode === 'tests' ? 'Choose test fixture' : 'Choose captured PR directory',
    properties: [mode === 'tests' ? 'openFile' : 'openDirectory'],
    ...(mode === 'tests' ? { defaultPath: before.repositoryRoot ?? undefined, filters: [{ name: 'Test fixture', extensions: ['json'] }] } : {}) });
  return choice.canceled || !choice.filePaths[0] ? null : run({ schemaVersion: 1, repositoryRoot: before.repositoryRoot ?? undefined, workflowPath: before.workflowPath ?? undefined, command: { kind: 'input', mode, path: choice.filePaths[0] } });
});
register('choose-packets', async () => {
  if (!window) return null;
  const before = companion.snapshot();
  const choice = await dialog.showOpenDialog(window, { title: 'Choose Slack decision packets', properties: ['openFile'], filters: [{ name: 'Decision packets', extensions: ['json'] }] });
  if (companion.snapshot().mode !== before.mode) return { schemaVersion: 1, ok: false, error: 'Simulation data changed. Choose packets for the current selection.' };
  return choice.canceled || !choice.filePaths[0] ? null : run({ schemaVersion: 1, repositoryRoot: before.repositoryRoot ?? undefined, workflowPath: before.workflowPath ?? undefined, command: { kind: 'packets', path: choice.filePaths[0] } });
});

async function createWindow(): Promise<void> {
  window = new BrowserWindow({ width: 1200, height: 850, minWidth: 360, minHeight: 480, title: 'Repo Chap', backgroundColor: '#F2EADE',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('closed', () => { window = null; });
  await window.loadFile(pagePath);
}

void app.whenReady().then(async () => {
  await privateDirectory(join(app.getPath('userData'), 'companion'), true);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(pathToFileURL(`${__dirname}/`).href) }));
  const value = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  let opening: CompanionResponse | undefined;
  const workflowPath = value('--workflow'), root = value('--repo-root');
  if (root || workflowPath) opening = await companion.execute({ schemaVersion: 1, command: { kind: 'open', repositoryRoot: resolve(root ?? dirname(workflowPath!)), ...(workflowPath ? { workflowPath: resolve(workflowPath) } : {}) } });
  else {
    try {
      const saved = JSON.parse(await readFile(join(app.getPath('userData'), 'companion', 'selection.json'), 'utf8'));
      if (typeof saved.repositoryRoot === 'string') opening = await companion.execute({ schemaVersion: 1, command: { kind: 'open', repositoryRoot: saved.repositoryRoot, ...(typeof saved.workflowPath === 'string' ? { workflowPath: saved.workflowPath } : {}) } });
    } catch { /* A missing or incomplete selection opens the repository picker. */ }
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { label: 'File', submenu: [{ label: 'Close window', accelerator: 'CmdOrCtrl+W', click: () => window?.close() }] },
    { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ]));
  await createWindow();
  stopControl = await serveCompanion(controlDirectory(), run);
  if (opening && !opening.ok && window) void dialog.showMessageBox(window, { type: 'error', title: 'Cannot open repository', message: opening.error });
  poll = setInterval(() => {
    if (polling) return;
    polling = true;
    void companion.refresh().finally(() => { polling = false; });
  }, 1500);
}).catch(error => { dialog.showErrorBox('Cannot start Repo Chap', error instanceof Error ? error.message : 'Desktop startup failed.'); app.quit(); });
app.on('before-quit', event => {
  if (closing) return;
  closing = true; event.preventDefault(); clearInterval(poll);
  void Promise.all([stopControl?.(), persistence]).finally(() => app.quit());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!window) void createWindow(); });
