import type { ConversationInputAnswer } from '@repo-chap/providers';
import type { ConversationBridge, ConversationContextSelection, ConversationHistoryEntry, ConversationProvider, ConversationResult, ConversationSnapshot } from './conversation-protocol.js';
import type { DocumentSnapshot, EditorResult } from './protocol.js';

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] => {
  const value = document.createElement(tag); value.textContent = text; value.className = className; return value;
};
const providerName = (name: string): string => name === 'codex' ? 'Codex' : 'Claude';

export function conversationView(bridge: ConversationBridge, perform: (operation: () => Promise<EditorResult>) => Promise<boolean>, getDocument: () => DocumentSnapshot | null): {
  render(state: DocumentSnapshot, locked: boolean, pendingInspector: number): void;
  running(): boolean;
} {
  let current: ConversationSnapshot | null = null;
  let documentId = '', profilesKey = '', markdownKey = '', rulesKey = '', historyKey = '', inputKey = '';
  let locked = false, settingsBusy = false;
  const entries = new Map<string, HTMLElement>();
  const question = element<HTMLTextAreaElement>('conversation-question');
  const profile = element<HTMLSelectElement>('conversation-profile');
  const setupProvider = element<HTMLSelectElement>('setup-provider');
  const setupModel = element<HTMLSelectElement>('setup-model');
  let modelsLoading = false;
  async function loadModels(): Promise<void> {
    const provider = setupProvider.value;
    modelsLoading = true; renderControls();
    setupModel.replaceChildren(node('option', provider ? 'Loading models…' : 'Choose a provider first')); setupModel.options[0]!.value = '';
    element('setup-status').textContent = '';
    element('setup-retry').hidden = true;
    try {
      if (!provider) return;
      const result = await bridge.models(provider);
      setupModel.replaceChildren();
      for (const model of result.models) { const option = node('option', model.label); option.value = model.id; setupModel.append(option); }
      if (result.error) { element('setup-status').textContent = result.error; element('setup-retry').hidden = false; }
    } catch { element('setup-status').textContent = 'Cannot load models. Retry to continue.'; element('setup-retry').hidden = false; }
    finally { modelsLoading = false; renderControls(); }
  }
  setupProvider.onchange = () => { void loadModels(); };
  setupModel.onchange = renderControls;
  element('setup-retry').onclick = () => { void loadModels(); };
  element<HTMLFormElement>('provider-setup').onsubmit = event => {
    event.preventDefault();
    if (!getDocument() || !setupModel.value || modelsLoading || locked) return;
    void action(async () => {
      const result = await bridge.saveProvider(getDocument()!.sessionId, { provider: setupProvider.value as 'codex' | 'claude', model: setupModel.value });
      if (!result.error) element('setup-status').textContent = 'Saved. Ready for your next question.';
      return result;
    });
  };
  const history = element('conversation-history');
  const showError = (message = ''): void => { element('conversation-error').textContent = message; element('conversation-error').hidden = !message; };

  function accept(snapshot: ConversationSnapshot | null): void {
    if (!snapshot && current) return;
    if (snapshot && snapshot.documentSessionId !== getDocument()?.sessionId) return;
    if (snapshot && current && current.status !== 'closed' && snapshot.documentSessionId === current.documentSessionId && snapshot.revision < current.revision) return;
    current = snapshot;
    if (snapshot && [...profile.options].some(option => option.value === snapshot.provider.name)) profile.value = snapshot.provider.name;
    renderConversation();
  }
  function updateProfiles(profiles: ConversationProvider[]): void {
    const key = JSON.stringify(profiles);
    if (key !== profilesKey) {
      const previous = profile.value;
      profile.replaceChildren(node('option', 'Choose a saved profile'));
      profile.options[0]!.value = '';
      for (const item of profiles) {
        const option = node('option', `${item.name} · ${providerName(item.provider)} · ${item.model}${item.effort ? ` · ${item.effort}` : ''}`);
        option.value = item.name; profile.append(option);
      }
      profile.value = profiles.some(item => item.name === previous) ? previous : '';
      profilesKey = key;
    }
  }
  function receive(result: ConversationResult): boolean {
    updateProfiles(result.profiles);
    accept(result.conversation);
    if (result.error) showError(result.error);
    renderControls();
    return !result.error && !result.cancelled;
  }
  async function action(operation: () => Promise<ConversationResult>): Promise<void> {
    if (settingsBusy) return;
    settingsBusy = true; showError(); renderControls();
    try { receive(await operation()); }
    catch { showError('The conversation operation could not finish. Your source drafts have been kept.'); }
    finally { settingsBusy = false; renderControls(); }
  }
  function selection(): ConversationContextSelection {
    return {
      ruleId: element<HTMLSelectElement>('conversation-rule').value || null,
      markdownPaths: [...element('conversation-markdown').querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value),
      includeSimulation: element<HTMLInputElement>('conversation-simulation').checked,
      includeLiveTrial: element<HTMLInputElement>('conversation-live-trial').checked,
    };
  }
  async function send(): Promise<void> {
    if (locked || !current || current.status === 'closed' || current.activeTurnId || current.requiresFresh || !question.value.trim()) return;
    const prompt = question.value;
    showError();
    try {
      const accepted = await perform(async () => {
        const state = getDocument()!;
        const result = await bridge.send({ sessionId: state.sessionId, revision: state.revision }, prompt, selection());
        receive(result); return result;
      });
      if (accepted && question.value === prompt) question.value = '';
    } catch { showError('The question could not be submitted. Its text and your source drafts have been kept.'); }
    renderControls(); question.focus();
  }
  element('conversation-send').onclick = () => { void send(); };
  question.oninput = renderControls;
  question.onkeydown = event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void send(); } };
  element('conversation-load-profiles').onclick = () => { void action(() => bridge.loadProfiles()); };
  element('conversation-use-profile').onclick = () => { if (getDocument() && profile.value) void action(() => bridge.selectProfile(getDocument()!.sessionId, profile.value)); };
  profile.onchange = renderControls;
  element('conversation-fresh').onclick = () => { if (current) void action(() => bridge.fresh(current!.id)); };
  element('conversation-cancel').onclick = () => {
    if (!current?.activeTurnId) return;
    const { id, activeTurnId } = current;
    showError();
    void bridge.cancel(id, activeTurnId).then(receive).catch(() => showError('Cancellation could not be confirmed. Try Cancel again.'));
  };
  bridge.onChange(accept);
  bridge.onProfilesChange(profiles => { updateProfiles(profiles); renderControls(); });

  function renderControls(): void {
    const running = !!current?.activeTurnId;
    setupProvider.disabled = modelsLoading || settingsBusy || locked;
    setupModel.disabled = modelsLoading || settingsBusy || locked || !setupModel.value;
    element<HTMLButtonElement>('setup-save').disabled = modelsLoading || settingsBusy || locked || !setupModel.value;
    element<HTMLButtonElement>('setup-retry').disabled = modelsLoading || settingsBusy || locked;
    element<HTMLButtonElement>('conversation-send').disabled = locked || settingsBusy || !current || current.status === 'closed' || running || current.requiresFresh || !question.value.trim();
    element<HTMLButtonElement>('conversation-cancel').disabled = !running || current?.status === 'cancelling';
    element<HTMLButtonElement>('conversation-fresh').disabled = !current || current.status === 'closed' || settingsBusy;
    element('conversation-fresh').classList.toggle('primary', !!current?.requiresFresh);
    element<HTMLButtonElement>('conversation-load-profiles').disabled = settingsBusy || locked;
    element<HTMLButtonElement>('conversation-use-profile').disabled = settingsBusy || locked || !profile.value;
    profile.disabled = settingsBusy || locked || profile.options.length < 2;
    question.readOnly = locked;
    element('conversation-controls').hidden = !current;
    const lastTurn = current?.history.findLast(entry => entry.kind === 'turn');
    const failure = current?.requiresFresh && lastTurn?.kind === 'turn' ? lastTurn.error?.message ?? '' : '';
    element('conversation-failure').hidden = !failure;
    element('conversation-failure').textContent = failure;
    element('conversation-recovery').hidden = !current?.requiresFresh;
    element('conversation-selected-provider').textContent = current ? `${providerName(current.provider.provider)} · ${current.provider.model}${current.provider.effort ? ` · ${current.provider.effort}` : ''} · Profile ${current.provider.name}` : 'Choose a provider and model above, then save to start chatting.';
    const status = settingsBusy ? 'Updating provider settings…' : !current ? 'No provider selected' : current.status === 'closed' ? 'Conversation closed. Choose a profile to continue.' : current.status === 'input' ? 'Needs your reply' : current.status === 'cancelling' ? 'Stopping the current turn…' : current.status === 'running' ? 'Receiving an answer…' : current.status === 'waiting' ? current.waitingFor === 'tool' ? 'Waiting for a local tool…' : 'Waiting for the provider…' : current.requiresFresh ? 'Fresh session required' : current.session ? `Ready · ${current.session.turns} completed turn(s)` : 'Ready for a new session';
    element('conversation-status').textContent = current ? `${providerName(current.provider.provider)} · ${status}` : status;
    element('conversation-tab').textContent = current?.input ? 'Discuss · Reply needed' : running ? 'Discuss · Running' : current?.requiresFresh ? 'Discuss · Fresh needed' : 'Discuss';
  }
  function createEntry(entry: ConversationHistoryEntry): HTMLElement {
    const article = node('article', '', entry.kind === 'notice' ? 'conversation-notice' : 'conversation-turn');
    article.dataset.entry = entry.id;
    if (entry.kind === 'notice') { article.append(node('p', '', 'notice-text'), node('p', '', 'secondary handoff-detail')); return article; }
    const context = node('details'); context.append(node('summary', 'Context and session'), node('pre', '', 'turn-context'));
    article.append(node('p', 'You', 'secondary'), node('p', entry.prompt, 'turn-question'), node('h3', '', 'turn-provider'), node('p', '', 'turn-answer'), node('p', '', 'turn-truncated secondary'), node('p', '', 'turn-tools secondary'), node('p', '', 'turn-inputs secondary'), node('p', '', 'turn-error danger'), node('p', '', 'turn-status secondary'), context);
    return article;
  }
  function renderEntry(article: HTMLElement, entry: ConversationHistoryEntry): void {
    const text = (selector: string, value: string): void => { const item = article.querySelector<HTMLElement>(selector)!; if (item.textContent !== value) item.textContent = value; item.hidden = !value; };
    if (entry.kind === 'notice') {
      text('.notice-text', entry.text);
      text('.handoff-detail', entry.handoff ? `${entry.handoff.status === 'pending' ? 'Next question' : entry.handoff.status === 'attached' ? 'Attached to the question' : 'Cleared'} · ${entry.handoff.includedTurns} earlier turn(s) · ${entry.handoff.omittedTurns} omitted${entry.handoff.truncated ? ' · Excerpt shortened' : ''}` : 'Earlier messages remain visible and are excluded from future provider context.');
      return;
    }
    text('.turn-provider', `${providerName(entry.provider.provider)} · ${entry.provider.model}`);
    text('.turn-answer', entry.answer);
    text('.turn-truncated', entry.answerTruncated ? 'The displayed answer reached its 64 KiB limit. Ask a narrower follow-up to continue.' : '');
    text('.turn-tools', entry.tools.map(tool => `${tool.name}: ${tool.status}`).join(' · '));
    text('.turn-inputs', entry.inputs.map(input => `${input.question}\nYour reply: ${input.answer}${input.truncated ? '\nEarlier input display shortened.' : ''}`).join('\n\n'));
    text('.turn-error', entry.error?.message ?? '');
    text('.turn-status', entry.status === 'running' ? 'Turn in progress' : entry.status === 'completed' ? 'Answer complete' : entry.status === 'cancelled' ? 'Cancelled. Partial text has been kept.' : 'Turn ended with an error.');
    text('.turn-context', `${entry.context.provenance}\nDocument session: ${entry.context.document.sessionId}\nContext digest: ${entry.context.digest}\nProvider session: ${entry.sessionId ?? 'Not established'}\nProfile: ${entry.provider.name}`);
  }
  function renderConversation(): void {
    const atEnd = history.scrollHeight - history.scrollTop - history.clientHeight < 80;
    const visible = current?.history ?? [];
    const ids = new Set(visible.map(entry => entry.id));
    for (const id of entries.keys()) if (!ids.has(id)) entries.delete(id);
    for (const entry of visible) {
      if (!entries.has(entry.id)) entries.set(entry.id, createEntry(entry));
      renderEntry(entries.get(entry.id)!, entry);
    }
    const nextKey = visible.map(entry => entry.id).join(',');
    if (nextKey !== historyKey) { history.replaceChildren(...visible.map(entry => entries.get(entry.id)!)); historyKey = nextKey; }
    if (atEnd) history.scrollTop = history.scrollHeight;
    element('conversation-empty').hidden = !!visible.length;
    element('conversation-omissions').hidden = !current?.omittedEntries;
    element('conversation-omissions').textContent = `${current?.omittedEntries ?? 0} earlier history entries are no longer shown.`;
    renderInput(); renderControls();
  }
  function renderInput(): void {
    const pending = current?.input;
    const key = pending ? `${current!.id}:${pending.turnId}:${pending.request.id}` : '';
    const area = element('conversation-input');
    area.hidden = !pending;
    if (key === inputKey) return;
    inputKey = key; area.replaceChildren();
    if (!pending || !current) return;
    const conversationId = current.id;
    const replyError = node('p', '', 'danger'); replyError.setAttribute('role', 'alert');
    const submit = async (answer: ConversationInputAnswer): Promise<void> => {
      for (const control of area.querySelectorAll<HTMLButtonElement>('button')) control.disabled = true;
      replyError.textContent = '';
      try {
        const result = await bridge.answer(conversationId, pending.turnId, pending.request.id, answer);
        receive(result);
        if (result.error) replyError.textContent = result.error;
      } catch { replyError.textContent = 'The reply could not be submitted. Try again or cancel the turn.'; }
      finally { for (const control of area.querySelectorAll<HTMLButtonElement>('button')) control.disabled = false; }
    };
    area.append(node('h3', 'The provider needs your reply'));
    if (pending.request.kind === 'approval') {
      area.append(node('p', pending.request.description));
      const controls = node('div', '', 'controls');
      for (const [value, label] of [['allow', 'Allow local tool'], ['deny', 'Decline']] as const) { const button = node('button', label); button.onclick = () => { void submit({ decision: value }); }; controls.append(button); }
      area.append(controls, replyError);
    } else {
      const readers: { id: string; read(): string[] }[] = [];
      for (const item of pending.request.questions) {
        const group = node('fieldset'); group.append(node('legend', item.question));
        const choices: HTMLInputElement[] = [];
        for (const option of item.options) {
          const label = node('label', '', 'conversation-choice');
          const input = node('input'); input.type = item.multiple ? 'checkbox' : 'radio'; input.name = `reply-${item.id}`; input.value = option.label;
          const text = node('span'); text.append(node('span', option.label), node('span', option.description, 'secondary'));
          label.append(input, text); group.append(label); choices.push(input);
        }
        let freeform: HTMLTextAreaElement | null = null;
        if (item.freeform) {
          const label = node('label', item.options.length ? 'Another answer' : 'Your answer');
          freeform = node('textarea'); freeform.maxLength = 2048; freeform.rows = 2;
          freeform.oninput = () => { if (!item.multiple && freeform!.value.trim()) for (const choice of choices) choice.checked = false; };
          for (const choice of choices) choice.onchange = () => { if (!item.multiple) freeform!.value = ''; };
          label.append(freeform); group.append(label);
        }
        readers.push({ id: item.id, read: () => [...choices.filter(choice => choice.checked).map(choice => choice.value), ...(freeform?.value.trim() ? [freeform.value.trim()] : [])] });
        area.append(group);
      }
      const button = node('button', 'Send reply', 'primary');
      button.onclick = () => { void submit({ answers: Object.fromEntries(readers.map(reader => [reader.id, reader.read()])) }); };
      area.append(button, replyError);
    }
    if (!element('conversation-view').hidden) area.querySelector<HTMLElement>('input,textarea,button')?.focus();
  }
  function render(state: DocumentSnapshot, nextLocked: boolean, pendingInspector: number): void {
    locked = nextLocked;
    if (documentId !== state.sessionId) {
      documentId = state.sessionId; current = null; markdownKey = ''; rulesKey = ''; question.value = ''; showError();
      renderConversation();
      void bridge.current().then(receive).catch(() => showError('Cannot read conversation state.'));
    }
    const rule = element<HTMLSelectElement>('conversation-rule');
    const nextRules = JSON.stringify(state.workflow?.rules.map(rule => rule.id) ?? []);
    if (rulesKey !== nextRules) {
      const previous = rule.value;
      rule.replaceChildren(node('option', 'Whole workflow')); rule.options[0]!.value = '';
      for (const item of state.workflow?.rules ?? []) { const option = node('option', item.id); option.value = item.id; rule.append(option); }
      rule.value = [...rule.options].some(option => option.value === previous) ? previous : ''; rulesKey = nextRules;
    }
    const markdown = state.files.filter(file => /\.(md|markdown)$/i.test(file.path));
    const nextMarkdown = JSON.stringify(markdown.map(file => [file.path, file.error]));
    if (markdownKey !== nextMarkdown) {
      const selected = new Set(selection().markdownPaths), existed = !!markdownKey;
      element('conversation-markdown').replaceChildren(...markdown.map(file => {
        const label = node('label', '', 'conversation-choice'); const input = node('input'); input.type = 'checkbox'; input.value = file.path;
        input.checked = !file.error && (!existed || selected.has(file.path)); input.disabled = !!file.error;
        label.append(input, node('span', `${file.path}${file.error ? ' · Cannot read' : ''}`)); return label;
      }));
      markdownKey = nextMarkdown;
    }
    element('conversation-markdown-empty').hidden = !!markdown.length;
    element<HTMLInputElement>('conversation-simulation').disabled = !state.simulation;
    element('conversation-simulation-detail').textContent = state.simulation ? `${state.simulationCurrent ? 'Current' : 'Stale'} simulation · Tested document revision ${state.simulation.token.revision}. Sending retains this result and does not run simulation.` : 'No simulation has completed in this workflow session.';
    element('conversation-context-summary').textContent = `Next question uses document revision ${state.revision}${state.packageDigest ? '' : ' · Source needs repair'}.${pendingInspector ? ' Pending inspector settings must be accepted before sending.' : ''}`;
    renderControls();
  }
  return { render, running: () => !!current?.activeTurnId };
}
