import type { DocumentSnapshot, DocumentToken, EditorBridge, EditorResult, OpenKind } from './protocol.js';
import { processView } from './process-view.ts';
import { conversationView } from './conversation-view.ts';
import type { ConversationBridge } from './conversation-protocol.js';

declare global { interface Window { repoChap: EditorBridge; repoChapConversation: ConversationBridge } }
const bridge = window.repoChap;
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const source = element<HTMLTextAreaElement>('source');
let state: DocumentSnapshot | null = null;
let selected = '';
let queue = Promise.resolve();
let queuedEdits = 0;
let prompting = false;
let view: 'source' | 'process' | 'simulation' | 'conversation' = 'source';
const unsent = new Map<string, string>();
const basename = (path: string): string => path.split('/').at(-1)!;
function referenceName(path: string): string {
  if (path === state!.workflowPath) return basename(path);
  const base = state!.workflowPath.split('/').slice(0, -1);
  const parts = path.split('/');
  while (base.length && parts.length && base[0] === parts[0]) { base.shift(); parts.shift(); }
  return [...base.map(() => '..'), ...parts].join('/');
}
const token = (): DocumentToken => ({ sessionId: state!.sessionId, revision: state!.revision });
const dirty = (): boolean => !!state?.files.some(file => file.dirty) || unsent.size > 0 || process.pending() > 0;
function say(text: string, error = false): void {
  const message = element('message');
  message.textContent = text;
  message.classList.toggle('danger', error);
}
const process = processView(bridge, perform, () => state, message => { say(message); render(); });
const conversation = conversationView(window.repoChapConversation, perform, () => state);

async function perform(operation: () => Promise<EditorResult>, message?: string, captureInspector = true): Promise<boolean> {
  if ((prompting && captureInspector) || !state) return false;
  if (captureInspector && !await process.flush()) return false;
  const previous = document.activeElement as HTMLElement | null;
  const focusId = previous?.id, focusKey = previous?.dataset.focus;
  const wasPrompting = prompting;
  setPrompting(true);
  say('');
  try {
    return await enqueue(async () => {
      if (unsent.size) { say('Correct or discard the unaccepted source text before continuing.', true); return false; }
      const ok = receive(await operation(), true);
      if (ok && message) say(message);
      return ok;
    });
  } finally {
    setPrompting(wasPrompting);
    if (focusId) document.getElementById(focusId)?.focus();
    else if (focusKey) [...document.querySelectorAll<HTMLElement>('[data-focus]')].find(item => item.dataset.focus === focusKey)?.focus();
  }
}

function render(replaceSource = false): void {
  element('welcome').hidden = !!state;
  element('workspace').hidden = !state;
  if (!state) return;
  for (const name of ['source', 'process', 'simulation', 'conversation'] as const) {
    element(`${name}-view`).hidden = view !== name;
    element(`${name}-tab`).setAttribute('aria-pressed', String(view === name));
  }
  element('reload').hidden = view !== 'source';
  element('discard').hidden = view !== 'source';
  element<HTMLButtonElement>('reset').disabled = prompting || !dirty();
  element<HTMLButtonElement>('export').disabled = prompting || queuedEdits > 0 || !!unsent.size || !!state.diagnostics.length || !!state.readOnlyReason;
  if (!state.files.some(file => file.path === selected)) selected = state.workflowPath;
  const file = state.files.find(file => file.path === selected)!;
  element('workflow-name').textContent = basename(state.workflowPath);
  element('repository-path').textContent = state.repositoryRoot;
  element('read-only').hidden = !state.readOnlyReason;
  element('read-only').textContent = state.readOnlyReason;
  const dirtyFiles = state.files.filter(file => file.dirty || unsent.has(file.path)).length;
  element('dirty-state').textContent = queuedEdits ? 'Validating draft…' : dirty() ? [dirtyFiles ? `${dirtyFiles} unsaved file(s)` : '', process.pending() ? `${process.pending()} unsaved action setting(s)` : ''].filter(Boolean).join(' · ') : 'All changes saved';
  element<HTMLButtonElement>('save').disabled = prompting || !!state.readOnlyReason || !dirty() || !!state.diagnostics.length;
  element<HTMLButtonElement>('discard').disabled = !file.dirty && !unsent.has(selected);
  element<HTMLButtonElement>('reload').disabled = false;
  element('source-label').textContent = selected;
  element('file-state').textContent = state.readOnlyReason ? 'Read-only' : file.dirty || unsent.has(selected) ? 'Unsaved' : 'Saved';
  const readOnly = prompting || !!state.readOnlyReason || !!file.error;
  if (source.readOnly !== readOnly) source.readOnly = readOnly;
  source.setAttribute('aria-busy', String(prompting));
  if (replaceSource) source.value = unsent.get(selected) ?? file.text;
  element('external').hidden = !file.external;
  element('file-error').hidden = !file.error;
  element('file-error').textContent = file.error;
  const list = element('file-list');
  const focusedFile = list.contains(document.activeElement) ? document.activeElement?.getAttribute('aria-label') : null;
  const listKey = JSON.stringify([selected, state.files.map(item => [item.path, item.dirty, item.external, item.error, unsent.has(item.path)])]);
  const orderedFiles = [...state.files].sort((a, b) => Number(b.path === state!.workflowPath) - Number(a.path === state!.workflowPath));
  if (list.dataset.key !== listKey) list.replaceChildren(...orderedFiles.map(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-current', item.path === selected ? 'page' : 'false');
    button.setAttribute('aria-label', item.path);
    button.title = item.path;
    const title = document.createElement('span');
    title.textContent = referenceName(item.path);
    const detail = document.createElement('span');
    detail.className = 'file-kind';
    detail.textContent = item.error ? 'Cannot read' : item.external ? 'Changed on disk' : item.dirty || unsent.has(item.path) ? 'Unsaved' : item.path === state!.workflowPath ? 'Workflow' : 'Referenced file';
    button.append(title, detail);
    button.addEventListener('click', () => { selected = item.path; render(true); source.focus(); });
    return button;
  }));
  list.dataset.key = listKey;
  if (focusedFile) [...list.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === focusedFile)?.focus();
  element('validation-title').textContent = state.diagnostics.length ? `${state.diagnostics.length} validation error(s)` : 'Validation passed';
  element('revision').textContent = `Document revision ${state.revision}`;
  element('validation-ok').hidden = !!state.diagnostics.length;
  element('diagnostics').replaceChildren(...state.diagnostics.map(diagnostic => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.textContent = diagnostic.file;
    button.addEventListener('click', () => { selected = diagnostic.file; view = 'source'; render(true); source.focus(); });
    const text = document.createElement('span');
    text.textContent = `${diagnostic.path === diagnostic.file ? '' : `${diagnostic.path}: `}${diagnostic.message}`;
    li.append(button, text);
    return li;
  }));
  element('footer-detail').textContent = state.readOnlyReason ? 'Read-only source' : 'Save explicitly · Ctrl/Cmd+S';
  element('footer-mode').textContent = view === 'conversation' ? 'Local files · CLI conversation' : 'Local files · Offline simulation';
  document.title = `${dirty() ? '• ' : ''}${basename(state.workflowPath)} · Repo Chap`;
  process.render(state, prompting || queuedEdits > 0 || !!unsent.size);
  conversation.render(state, prompting, process.pending());
}

function setPrompting(value: boolean): void { prompting = value; render(); }

function receive(result: EditorResult, replaceSource = false): boolean {
  if (result.snapshot?.sessionId !== state?.sessionId) { unsent.clear(); process.discardDrafts(); selected = result.snapshot?.workflowPath ?? ''; replaceSource = true; }
  state = result.snapshot;
  render(replaceSource);
  if (result.error) say(result.error, true);
  return !result.error && !result.cancelled;
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const next = queue.then(operation);
  queue = next.then(() => {}, error => { say(error instanceof Error ? error.message : 'The operation failed. Your text has been kept.', true); });
  return next;
}

source.addEventListener('input', () => {
  const path = selected, text = source.value;
  if (text === (unsent.get(path) ?? state?.files.find(file => file.path === path)?.text)) return;
  say('');
  unsent.set(path, text);
  queuedEdits++;
  render();
  void enqueue(async () => {
    const result = await bridge.edit(token(), path, text);
    queuedEdits--;
    if (!result.error && unsent.get(path) === text) unsent.delete(path);
    receive(result);
  });
});

async function confirm(title: string, detail: string, choices: { id: string; label: string; style?: string; disabled?: boolean }[]): Promise<string> {
  const dialog = element<HTMLDialogElement>('confirmation');
  const previous = document.activeElement as HTMLElement | null;
  element('confirm-title').textContent = title;
  element('confirm-detail').textContent = detail;
  return new Promise(resolve => {
    const finish = (choice: string): void => { dialog.close(); dialog.oncancel = null; previous?.focus(); resolve(choice); };
    element('confirm-actions').replaceChildren(...choices.map(choice => {
      const button = document.createElement('button');
      button.textContent = choice.label;
      button.className = choice.style ?? '';
      button.disabled = choice.disabled ?? false;
      if (choice.id === 'cancel') button.autofocus = true;
      button.onclick = () => finish(choice.id);
      return button;
    }));
    dialog.oncancel = event => { event.preventDefault(); finish('cancel'); };
    dialog.showModal();
  });
}

async function save(): Promise<boolean> {
  const focused = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const focusId = focused?.id, selectionStart = focused?.selectionStart, selectionEnd = focused?.selectionEnd;
  const wasPrompting = prompting;
  setPrompting(true);
  try {
    await queue;
    if (!state || !await process.flush()) return false;
    if (unsent.size) { say('Some draft text could not be accepted. Correct it or discard it before saving.', true); return false; }
    const ok = await enqueue(async () => receive(await bridge.save(token())));
    if (ok) say('Saved all changed files.');
    return ok;
  } finally {
    setPrompting(wasPrompting);
    const field = focusId ? document.getElementById(focusId) : null;
    field?.focus();
    if (selectionStart != null && selectionEnd != null && (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) field.setSelectionRange(selectionStart, selectionEnd);
  }
}

async function leave(action: 'open' | 'close'): Promise<'continue' | 'discard' | 'cancel'> {
  await queue;
  let choice: 'continue' | 'discard' = 'continue';
  if (dirty()) {
    const paths = [...state!.files.filter(file => file.dirty || unsent.has(file.path)).map(file => file.path), ...(process.pending() ? [`Action inspector: ${process.pending()} unsaved setting(s)`] : [])].join('\n');
    const result = await confirm('Keep your unsaved changes?', `These files have unsaved changes:\n${paths}`, [
      { id: 'save', label: `Save all and ${action}`, style: 'primary', disabled: !!state!.diagnostics.length || !!state!.readOnlyReason || !!unsent.size },
      { id: 'discard', label: `Discard and ${action}`, style: 'danger' },
      { id: 'cancel', label: 'Cancel' },
    ]);
    if (result === 'save') { if (!await save()) return 'cancel'; }
    else if (result === 'discard') choice = 'discard';
    else return 'cancel';
  }
  if (conversation.running() && await confirm('Stop the running conversation?', `The current answer will stop when you ${action}. Visible conversation history is cleared when you leave this workflow.`, [{ id: 'stop', label: `Stop and ${action}` }, { id: 'cancel', label: 'Cancel' }]) !== 'stop') return 'cancel';
  return choice;
}

async function openWorkflow(kind: OpenKind): Promise<void> {
  if (prompting) return;
  setPrompting(true);
  try {
    const choice = await leave('open');
    if (choice === 'cancel') return;
    await enqueue(async () => {
      const result = await bridge.open(kind, state ? token() : null, choice === 'discard');
      if (receive(result, true)) say('Workflow opened.');
    });
  } finally { setPrompting(false); }
}
element('open-workflow').onclick = () => { void openWorkflow('workflow'); };
element('open-repository').onclick = () => { void openWorkflow('repository'); };
element('save').onclick = () => { void save(); };
for (const name of ['source', 'process', 'simulation', 'conversation'] as const) element(`${name}-tab`).onclick = () => { void (async () => { if (name !== view && !await process.flush()) return; view = name; render(true); })(); };
element('export').onclick = () => { void perform(() => bridge.exportWorkflow(token()), 'Workflow JSON copy exported. Referenced files were not copied; keep their relative paths when using it.'); };
element('reset').onclick = () => {
  void (async () => {
    if (prompting || !state) return;
    setPrompting(true);
    try {
      await queue;
      if (await confirm('Reset all workflow drafts?', 'Discard unapplied action settings and restore every workflow source file to its last loaded or saved text. Temporary simulation inputs and current disk changes are kept.', [{ id: 'reset', label: 'Reset workflow', style: 'danger' }, { id: 'cancel', label: 'Cancel' }]) !== 'reset') return;
      await enqueue(async () => { const result = await bridge.reset(token()); if (!result.error) { unsent.clear(); process.discardDrafts(); } if (receive(result, true)) say('Workflow drafts restored to saved source.'); });
    } finally { setPrompting(false); }
  })();
};
element('reload').onclick = () => {
  void (async () => {
    if (prompting || !state) return;
    setPrompting(true);
    try {
      await queue;
      const path = selected;
      const file = state!.files.find(file => file.path === path)!;
      if ((file.dirty || unsent.has(path)) && await confirm('Reload file from disk?', `This replaces your unsaved changes to ${path} with the current disk version.`, [{ id: 'reload', label: 'Reload from disk', style: 'danger' }, { id: 'cancel', label: 'Cancel' }]) !== 'reload') return;
      await enqueue(async () => {
        say('Reloading file…');
        const result = await bridge.reload(token(), path);
        if (!result.error) unsent.delete(path);
        if (receive(result, true)) say('File reloaded from disk. Other drafts have been kept.');
      });
    } finally { setPrompting(false); }
  })();
};
element('discard').onclick = () => {
  void (async () => {
    if (prompting || !state) return;
    setPrompting(true);
    try {
      await queue;
      const path = selected;
      if (await confirm('Discard changes to this file?', `This restores the last loaded or saved text of ${path}. External disk changes are loaded only when you choose Reload file.`, [{ id: 'discard', label: 'Discard changes', style: 'danger' }, { id: 'cancel', label: 'Cancel' }]) !== 'discard') return;
      await enqueue(async () => {
        say('Discarding changes…');
        const result = await bridge.discard(token(), path);
        if (!result.error) unsent.delete(path);
        if (receive(result, true)) say('Changes to this file discarded.');
      });
    } finally { setPrompting(false); }
  })();
};
bridge.onCloseRequested(() => {
  void (async () => {
    if (prompting) return;
    setPrompting(true);
    try {
      const choice = await leave('close');
      if (choice === 'cancel') return;
      await enqueue(async () => receive(await bridge.close(state ? token() : null, choice === 'discard')));
    } finally { setPrompting(false); }
  })();
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') { event.preventDefault(); if (!prompting) void save(); }
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'o') { event.preventDefault(); void openWorkflow('workflow'); }
});
const checkExternal = (): void => {
  if (state && !prompting && !queuedEdits) void enqueue(async () => { receive(await bridge.checkExternal()); });
};
window.addEventListener('focus', checkExternal);
setInterval(checkExternal, 3000);
void enqueue(async () => { receive(await bridge.current(), true); });
