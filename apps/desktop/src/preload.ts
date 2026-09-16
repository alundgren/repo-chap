import { contextBridge, ipcRenderer } from 'electron';
import type { TrialBridge, TrialSnapshot } from './trial-protocol.js';
import type { EditorBridge } from './protocol.js';
import type { ConversationBridge, ConversationSnapshot } from './conversation-protocol.js';

const bridge: EditorBridge = {
  current: () => ipcRenderer.invoke('editor:current'),
  author: operation => ipcRenderer.invoke('editor:author', operation),
  openTestFixture: token => ipcRenderer.invoke('editor:open-test-fixture', token),
  undo: token => ipcRenderer.invoke('editor:undo', token),
  applyAuthoringRequest: (id, token) => ipcRenderer.invoke('editor:apply-authoring', id, token),
  rejectAuthoringRequest: (id, pending) => ipcRenderer.invoke('conversation:reject-authoring', id, pending),
  confirmAuthoringOperation: id => ipcRenderer.invoke('conversation:confirm-operation', id),
  confirmAuthoringDisplay: id => ipcRenderer.invoke('conversation:confirm-authoring', id),
  onAuthoringRequest: callback => {
    const listener = (_event: Electron.IpcRendererEvent, id: string): void => callback(id);
    ipcRenderer.on('authoring:requested', listener);
    return () => ipcRenderer.removeListener('authoring:requested', listener);
  },
  open: (kind, token, discard) => ipcRenderer.invoke('editor:open', kind, token, discard),
  edit: (token, path, text) => ipcRenderer.invoke('editor:edit', token, path, text),
  save: token => ipcRenderer.invoke('editor:save', token),
  reload: (token, path) => ipcRenderer.invoke('editor:reload', token, path),
  discard: (token, path) => ipcRenderer.invoke('editor:discard', token, path),
  visualEdit: (token, edit) => ipcRenderer.invoke('editor:visual-edit', token, edit),
  reset: token => ipcRenderer.invoke('editor:reset', token),
  loadSimulationInput: (token, kind) => ipcRenderer.invoke('editor:load-simulation-input', token, kind),
  editSimulationInput: (token, kind, text) => ipcRenderer.invoke('editor:edit-simulation-input', token, kind, text),
  resetSimulationInput: (token, kind) => ipcRenderer.invoke('editor:reset-simulation-input', token, kind),
  setClock: (token, now) => ipcRenderer.invoke('editor:set-clock', token, now),
  simulate: token => ipcRenderer.invoke('editor:simulate', token),
  exportWorkflow: token => ipcRenderer.invoke('editor:export-workflow', token),
  checkExternal: () => ipcRenderer.invoke('editor:check-external'),
  close: (token, discard) => ipcRenderer.invoke('editor:close', token, discard),
  onCloseRequested: callback => {
    const listener = (): void => callback();
    ipcRenderer.on('editor:close-requested', listener);
    return () => ipcRenderer.removeListener('editor:close-requested', listener);
  },
};
contextBridge.exposeInMainWorld('repoChap', bridge);

const conversation: ConversationBridge = {
  current: () => ipcRenderer.invoke('conversation:current'),
  loadProfiles: () => ipcRenderer.invoke('conversation:load-profiles'),
  selectProfile: (documentSessionId, name) => ipcRenderer.invoke('conversation:select-profile', documentSessionId, name),
  send: (token, prompt, selection) => ipcRenderer.invoke('conversation:send', token, prompt, selection),
  cancel: (id, turnId) => ipcRenderer.invoke('conversation:cancel', id, turnId),
  fresh: id => ipcRenderer.invoke('conversation:fresh', id),
  answer: (id, turnId, requestId, answer) => ipcRenderer.invoke('conversation:answer', id, turnId, requestId, answer),
  onChange: callback => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: ConversationSnapshot): void => callback(snapshot);
    ipcRenderer.on('conversation:changed', listener);
    return () => ipcRenderer.removeListener('conversation:changed', listener);
  },
};
contextBridge.exposeInMainWorld('repoChapConversation', conversation);

const trial: TrialBridge = {
  current: () => ipcRenderer.invoke('trial:current'),
  loadProfiles: () => ipcRenderer.invoke('trial:load-profiles'),
  chooseSource: id => ipcRenderer.invoke('trial:choose-source', id),
  prepare: (token, selection) => ipcRenderer.invoke('trial:prepare', token, selection),
  start: (token, selection) => ipcRenderer.invoke('trial:start', token, selection),
  invalidate: id => ipcRenderer.invoke('trial:invalidate', id),
  cancel: (id, trialId) => ipcRenderer.invoke('trial:cancel', id, trialId),
  refresh: (id, trialId) => ipcRenderer.invoke('trial:refresh', id, trialId),
  exportFixture: (id, trialId) => ipcRenderer.invoke('trial:export-fixture', id, trialId),
  onChange: callback => { const listener = (_event: Electron.IpcRendererEvent, snapshot: TrialSnapshot): void => callback(snapshot); ipcRenderer.on('trial:changed', listener); return () => ipcRenderer.removeListener('trial:changed', listener); },
};
contextBridge.exposeInMainWorld('repoChapTrial', trial);
