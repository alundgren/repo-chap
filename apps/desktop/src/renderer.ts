import type { DocumentSnapshot, DocumentToken, EditorBridge, EditorResult, OpenKind } from './protocol.js';

declare global { interface Window { repoChap: EditorBridge } }
const bridge = window.repoChap;
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const source = element<HTMLTextAreaElement>('source');
let state: DocumentSnapshot | null = null;
let selected = '';
let queue = Promise.resolve();
let queuedEdits = 0;
let prompting = false;
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
const dirty = (): boolean => !!state?.files.some(file => file.dirty) || unsent.size > 0;
function say(text: string, error = false): void {
  const message = element('message');
  message.textContent = text;
  message.classList.toggle('danger', error);
}

function render(replaceSource = false): void {
  element('welcome').hidden = !!state;
  element('workspace').hidden = !state;
  if (!state) return;
  if (!state.files.some(file => file.path === selected)) selected = state.workflowPath;
  const file = state.files.find(file => file.path === selected)!;
  element('workflow-name').textContent = basename(state.workflowPath);
  element('repository-path').textContent = state.repositoryRoot;
  element('read-only').hidden = !state.readOnlyReason;
  element('read-only').textContent = state.readOnlyReason;
  element('dirty-state').textContent = queuedEdits ? 'Validating draft…' : dirty() ? `${state.files.filter(file => file.dirty || unsent.has(file.path)).length} unsaved file(s)` : 'All changes saved';
  element<HTMLButtonElement>('save').disabled = !!state.readOnlyReason || !dirty() || !!state.diagnostics.length;
  element<HTMLButtonElement>('discard').disabled = !file.dirty && !unsent.has(selected);
  element<HTMLButtonElement>('reload').disabled = false;
  element('source-label').textContent = selected;
  element('file-state').textContent = state.readOnlyReason ? 'Read-only' : file.dirty || unsent.has(selected) ? 'Unsaved' : 'Saved';
  const readOnly = !!state.readOnlyReason || !!file.error;
  if (source.readOnly !== readOnly) source.readOnly = readOnly;
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
    button.addEventListener('click', () => { selected = diagnostic.file; render(true); source.focus(); });
    const text = document.createElement('span');
    text.textContent = `${diagnostic.path === diagnostic.file ? '' : `${diagnostic.path}: `}${diagnostic.message}`;
    li.append(button, text);
    return li;
  }));
  element('footer-detail').textContent = state.readOnlyReason ? 'Read-only source' : 'Save explicitly · Ctrl/Cmd+S';
  document.title = `${dirty() ? '• ' : ''}${basename(state.workflowPath)} · Repo Chap`;
}

function receive(result: EditorResult, replaceSource = false): boolean {
  if (result.snapshot?.sessionId !== state?.sessionId) { unsent.clear(); selected = result.snapshot?.workflowPath ?? ''; replaceSource = true; }
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
  await queue;
  if (!state) return false;
  if (unsent.size) { say('Some draft text could not be accepted. Correct it or discard it before saving.', true); return false; }
  const ok = await enqueue(async () => receive(await bridge.save(token())));
  if (ok) say('Saved all changed files.');
  return ok;
}

async function leave(action: 'open' | 'close'): Promise<'continue' | 'discard' | 'cancel'> {
  await queue;
  if (!dirty()) return 'continue';
  const paths = state!.files.filter(file => file.dirty || unsent.has(file.path)).map(file => file.path).join('\n');
  const choice = await confirm('Keep your unsaved changes?', `These files have unsaved changes:\n${paths}`, [
    { id: 'save', label: `Save all and ${action}`, style: 'primary', disabled: !!state!.diagnostics.length || !!state!.readOnlyReason || !!unsent.size },
    { id: 'discard', label: `Discard and ${action}`, style: 'danger' },
    { id: 'cancel', label: 'Cancel' },
  ]);
  if (choice === 'save') return await save() ? 'continue' : 'cancel';
  return choice === 'discard' ? 'discard' : 'cancel';
}

async function openWorkflow(kind: OpenKind): Promise<void> {
  if (prompting) return;
  prompting = true;
  try {
    const choice = await leave('open');
    if (choice === 'cancel') return;
    await enqueue(async () => {
      const result = await bridge.open(kind, state ? token() : null, choice === 'discard');
      if (receive(result, true)) say('Workflow opened.');
    });
  } finally { prompting = false; }
}
element('open-workflow').onclick = () => { void openWorkflow('workflow'); };
element('open-repository').onclick = () => { void openWorkflow('repository'); };
element('save').onclick = () => { void save(); };
element('reload').onclick = () => {
  void (async () => {
    if (prompting || !state) return;
    prompting = true;
    try {
      await queue;
      const path = selected;
      const file = state!.files.find(file => file.path === path)!;
      if ((file.dirty || unsent.has(path)) && await confirm('Reload file from disk?', `This replaces your unsaved changes to ${path} with the current disk version.`, [{ id: 'reload', label: 'Reload from disk', style: 'danger' }, { id: 'cancel', label: 'Cancel' }]) !== 'reload') return;
      await enqueue(async () => {
        const result = await bridge.reload(token(), path);
        if (!result.error) unsent.delete(path);
        if (receive(result, true)) say('File reloaded from disk. Other drafts have been kept.');
      });
    } finally { prompting = false; }
  })();
};
element('discard').onclick = () => {
  void (async () => {
    if (prompting || !state) return;
    prompting = true;
    try {
      await queue;
      const path = selected;
      if (await confirm('Discard changes to this file?', `This restores the last loaded or saved text of ${path}. External disk changes are loaded only when you choose Reload file.`, [{ id: 'discard', label: 'Discard changes', style: 'danger' }, { id: 'cancel', label: 'Cancel' }]) !== 'discard') return;
      await enqueue(async () => {
        const result = await bridge.discard(token(), path);
        if (!result.error) unsent.delete(path);
        if (receive(result, true)) say('Changes to this file discarded.');
      });
    } finally { prompting = false; }
  })();
};
bridge.onCloseRequested(() => {
  void (async () => {
    if (prompting) return;
    prompting = true;
    try {
      const choice = await leave('close');
      if (choice === 'cancel') return;
      await enqueue(async () => receive(await bridge.close(state ? token() : null, choice === 'discard')));
    } finally { prompting = false; }
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
