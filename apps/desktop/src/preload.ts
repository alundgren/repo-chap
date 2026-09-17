import { contextBridge, ipcRenderer } from 'electron';
import type { EditorBridge } from './protocol.js';

const bridge: EditorBridge = {
  current: () => ipcRenderer.invoke('editor:current'),
  open: (kind, token, discard) => ipcRenderer.invoke('editor:open', kind, token, discard),
  edit: (token, path, text) => ipcRenderer.invoke('editor:edit', token, path, text),
  save: token => ipcRenderer.invoke('editor:save', token),
  reload: (token, path) => ipcRenderer.invoke('editor:reload', token, path),
  discard: (token, path) => ipcRenderer.invoke('editor:discard', token, path),
  checkExternal: () => ipcRenderer.invoke('editor:check-external'),
  close: (token, discard) => ipcRenderer.invoke('editor:close', token, discard),
  onCloseRequested: callback => {
    const listener = (): void => callback();
    ipcRenderer.on('editor:close-requested', listener);
    return () => ipcRenderer.removeListener('editor:close-requested', listener);
  },
};
contextBridge.exposeInMainWorld('repoChap', bridge);
