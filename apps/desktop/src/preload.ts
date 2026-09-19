import { contextBridge, ipcRenderer } from 'electron';
import type { CompanionState } from '@repo-chap/companion';
import type { CompanionBridge } from './protocol.js';

const bridge: CompanionBridge = {
  current: () => ipcRenderer.invoke('companion:current'),
  command: command => ipcRenderer.invoke('companion:command', command),
  chooseRepository: () => ipcRenderer.invoke('companion:choose-repository'),
  chooseInput: mode => ipcRenderer.invoke('companion:choose-input', mode),
  choosePackets: () => ipcRenderer.invoke('companion:choose-packets'),
  onChange: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: CompanionState): void => callback(state);
    ipcRenderer.on('companion:changed', listener);
    return () => ipcRenderer.removeListener('companion:changed', listener);
  },
};
contextBridge.exposeInMainWorld('repoChap', bridge);
