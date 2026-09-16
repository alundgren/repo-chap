import type { Condition, ConditionTrace } from '@repo-chap/workflow';
import type { DocumentSnapshot, EditorBridge, EditorResult, VisualEdit } from './protocol.js';

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] => {
  const item = document.createElement(tag); item.textContent = text; item.className = className; return item;
};
function conditionText(condition: Condition): string {
  if ('field' in condition) return `${condition.field} ${condition.op === 'eq' ? '=' : '≠'} ${JSON.stringify(condition.value)}`;
  if ('not' in condition) return `Not (${conditionText(condition.not)})`;
  return ('all' in condition ? condition.all : condition.any).map(child => 'field' in child ? conditionText(child) : `(${conditionText(child)})`).join('all' in condition ? ' and ' : ' or ');
}
function traceNode(trace: ConditionTrace): HTMLElement {
  const item = node('li', `${trace.value}: ${trace.reason}`);
  if (trace.children) { const children = node('ul'); children.append(...trace.children.map(traceNode)); item.append(children); }
  return item;
}

export function processView(bridge: EditorBridge, perform: (operation: () => Promise<EditorResult>, message?: string, captureInspector?: boolean) => Promise<boolean>, getState: () => DocumentSnapshot | null, changed: (message: string) => void): { render: (state: DocumentSnapshot, locked: boolean) => void; pending: () => number; flush: () => Promise<boolean>; discardDrafts: () => void } {
  let actionId = '';
  let controlsLocked = false;
  let inspectorKey = '', rulesKey = '', resultKey = '';
  const drafts = new Map<string, { edit: VisualEdit; value: string }>();
  let flushing: Promise<boolean> | null = null;
  const notify = (message = ''): void => {
    const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const id = active?.id, start = active?.selectionStart, end = active?.selectionEnd;
    changed(message);
    const replacement = id === 'apply-settings' || id === 'discard-settings' ? element('action-select') : id ? document.getElementById(id) : null;
    if (replacement && replacement !== active) {
      replacement.focus();
      if (start != null && end != null && (replacement instanceof HTMLInputElement || replacement instanceof HTMLTextAreaElement)) replacement.setSelectionRange(start, end);
    }
  };
  const discardDrafts = (): void => { drafts.clear(); inspectorKey = ''; };
  const track = (input: HTMLInputElement | HTMLTextAreaElement, edit: () => VisualEdit): void => {
    input.defaultValue = input.value;
    input.oninput = () => { if (input.value === input.defaultValue) drafts.delete(input.id); else drafts.set(input.id, { edit: edit(), value: input.value }); notify(); };
  };
  function flush(): Promise<boolean> {
    if (flushing) return flushing;
    const pending = [...drafts];
    if (!pending.length) return Promise.resolve(true);
    flushing = (async () => {
      for (const [id, draft] of pending) {
        if (!await perform(() => bridge.visualEdit(getState()!, draft.edit), undefined, false)) return false;
        element<HTMLInputElement | HTMLTextAreaElement>(id).defaultValue = draft.value;
        if (drafts.get(id) === draft) drafts.delete(id);
        notify('Action settings staged. Save all writes the workflow.');
      }
      return !drafts.size;
    })().finally(() => { flushing = null; });
    return flushing;
  }
  const apply = (edit: VisualEdit): void => { void perform(() => bridge.visualEdit(getState()!, edit), 'Visual change staged. Save all writes the workflow.'); };
  element<HTMLSelectElement>('action-select').onchange = () => {
    const next = element<HTMLSelectElement>('action-select').value;
    element<HTMLSelectElement>('action-select').value = actionId;
    void (async () => { if (!await flush()) return; actionId = next; inspectorKey = ''; render(getState()!, controlsLocked); })();
  };
  element('apply-settings').onclick = () => { void flush(); };
  element('discard-settings').onclick = () => { discardDrafts(); notify('Unapplied action settings discarded.'); };
  for (const kind of ['fixture', 'packets'] as const) element(`load-${kind}`).onclick = () => { void perform(() => bridge.loadSimulationInput(getState()!, kind), 'Local simulation input loaded.'); };
  element('simulate').onclick = () => { void perform(() => bridge.simulate(getState()!), 'Simulation finished. Nothing was sent.'); };
  element('set-clock').onclick = () => { const now = element<HTMLInputElement>('fake-clock').value; void perform(() => bridge.setClock(getState()!, now), 'Fake time updated. Run simulation to test it.'); };
  element('reset-fixture').onclick = () => { void perform(() => bridge.resetSimulationInput(getState()!, 'fixture'), 'Fixture restored to its loaded text.'); };

  function render(state: DocumentSnapshot, locked: boolean): void {
    controlsLocked = locked;
    const workflow = state.workflow;
    const unavailable = !workflow || !!state.readOnlyReason;
    element('process-unavailable').hidden = !unavailable;
    element('process-content').hidden = unavailable;
    element('simulation-blocked').hidden = !unavailable;
    for (const id of ['apply-settings', 'discard-settings']) { element(id).hidden = !drafts.size; element<HTMLButtonElement>(id).disabled = locked; }
    for (const id of ['load-fixture', 'load-packets']) element<HTMLButtonElement>(id).disabled = locked;
    element<HTMLButtonElement>('simulate').disabled = locked || unavailable || !state.simulationInputs.fixture;
    for (const id of ['set-clock', 'reset-fixture']) element<HTMLButtonElement>(id).disabled = locked || !state.simulationInputs.fixture;
    element<HTMLInputElement>('fake-clock').disabled = locked || !state.simulationInputs.fixture;
    for (const kind of ['fixture', 'packets'] as const) {
      const input = state.simulationInputs[kind];
      element(`${kind}-name`).textContent = input ? `${kind === 'fixture' ? 'Fixture' : 'Packet context'}: ${input.name}${input.changed ? ' · Temporary changes' : ''}` : kind === 'fixture' ? 'No fixture loaded.' : 'No decision packets loaded. A proposed Slack handoff needs matching packet context.';
      element(`${kind}-preview`).textContent = input?.text ?? 'Nothing loaded.';
    }
    const clock = element<HTMLInputElement>('fake-clock');
    if (document.activeElement !== clock) { try { clock.value = JSON.parse(state.simulationInputs.fixture?.text ?? '{}').now ?? ''; } catch { clock.value = ''; } }
    element('changes-title').textContent = `Changes against saved source · ${state.semanticChanges.length}`;
    element('changes-note').textContent = state.semanticError ?? (state.semanticChanges.length ? 'Execution changes include rule order and referenced file text. Layout and JSON formatting are excluded.' : 'No execution changes. Layout and JSON formatting do not affect execution.');
    element('semantic-changes').replaceChildren(...state.semanticChanges.map(change => {
      const item = node('li'); item.append(node('strong', change.path), node('p', `Saved: ${change.before}`), node('p', `Draft: ${change.after}`)); return item;
    }));
    if (workflow) {
      if (!workflow.actions[actionId]) actionId = workflow.rules[0]?.action ?? workflow.otherwise;
      const nextRulesKey = JSON.stringify([state.sessionId, workflow.rules, actionId, locked]);
      if (nextRulesKey !== rulesKey) {
        const focus = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focus : undefined;
        element('rules').replaceChildren(...workflow.rules.map((rule, index) => {
          const item = node('li');
          const select = node('button'); select.className = 'rule-select'; select.dataset.focus = `select-${rule.id}`;
          select.disabled = locked;
          select.setAttribute('aria-pressed', String(rule.action === actionId)); select.append(node('strong', `${index + 1}. ${rule.id}`), node('span', conditionText(rule.when), 'secondary'), node('span', `→ ${rule.action}`));
          select.onclick = () => { void (async () => { if (!await flush()) return; actionId = rule.action; inspectorKey = ''; render(getState()!, controlsLocked); })(); };
          const controls = node('div', '', 'rule-move');
          for (const [label, offset] of [['up', -1], ['down', 1]] as const) {
            const button = node('button', label === 'up' ? '↑' : '↓'); button.setAttribute('aria-label', `Move ${rule.id} ${label}`); button.dataset.focus = `${label}-${rule.id}`;
            button.disabled = locked || index + offset < 0 || index + offset >= workflow.rules.length;
            button.onclick = () => apply({ kind: 'moveRule', ruleId: rule.id, toIndex: index + offset }); controls.append(button);
          }
          item.append(select, controls); return item;
        }));
        rulesKey = nextRulesKey;
        if (focus) [...element('rules').querySelectorAll('button')].find(button => button.dataset.focus === focus)?.focus();
      }
      element('otherwise').textContent = `If no rule matches: ${workflow.otherwise}`;
      const select = element<HTMLSelectElement>('action-select');
      const nextInspectorKey = JSON.stringify([state.sessionId, workflow.actions, workflow.settings, actionId]);
      if (nextInspectorKey !== inspectorKey && !drafts.size) {
        select.replaceChildren(...Object.keys(workflow.actions).map(id => { const option = node('option', id); option.value = id; return option; })); select.value = actionId;
        const action = workflow.actions[actionId]!;
        const inspectedAction = actionId;
        const fields = element('action-fields');
        fields.replaceChildren(node('h2', action.uses), node('p', `${action.execution === 'agent' ? 'Agent action' : 'Built-in action'} · ${action.capabilities.length ? action.capabilities.join(', ') : 'No requested capabilities'}`, 'secondary'));
        const field = (label: string, input: HTMLElement): void => { const wrapper = node('label', label); wrapper.append(input); fields.append(wrapper); };
        for (const [key, label] of [['onSuccess', 'After success'], ['onFailure', 'After failure']] as const) {
          const input = node('select'); input.id = `action-${key}`;
          input.append(...[...Object.keys(workflow.actions), '$observe', '$wait', '$blocked', '$closed'].map(id => { const option = node('option', id); option.value = id; return option; }));
          input.value = action[key]; input.onchange = () => apply({ kind: 'action', actionId, field: key, value: input.value }); field(label, input);
        }
        if (action.prompt !== undefined) {
          const input = node('input'); input.value = action.prompt; input.id = 'action-prompt'; track(input, () => ({ kind: 'action', actionId: inspectedAction, field: 'prompt', value: input.value })); field('Prompt file', input);
          const context = node('textarea'); context.id = 'action-context'; context.value = (action.contextFiles ?? []).join('\n'); context.rows = 3;
          track(context, () => ({ kind: 'context', actionId: inspectedAction, value: context.value.split('\n').map(line => line.trim()).filter(Boolean) })); field('Context files, one path per line', context);
        }
        const timing = action.uses === 'control.wait_reviewer' ? ['reviewWaitSeconds', 'reviewDeadlineSeconds'] as const : action.uses === 'control.wait_debounce' ? ['newPrDelaySeconds', 'headDebounceSeconds'] as const : [];
        const timingLabels = { reviewWaitSeconds: 'Reviewer recheck, seconds', reviewDeadlineSeconds: 'Reviewer deadline, seconds', newPrDelaySeconds: 'New PR delay, seconds', headDebounceSeconds: 'Head debounce, seconds' };
        for (const key of timing) { const input = node('input'); input.type = 'number'; input.min = '0'; input.step = '1'; input.id = `setting-${key}`; input.value = String(workflow.settings[key]); track(input, () => ({ kind: 'setting', field: key, value: input.valueAsNumber })); field(timingLabels[key], input); }
        fields.append(node('p', 'Apply settings or Save all to capture typed values. Switching views also captures them. Shared validation checks the workflow JSON.', 'secondary'));
        inspectorKey = nextInspectorKey;
      }
      for (const control of element('process-content').querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')) control.disabled = locked || unavailable;
    }
    const nextResultKey = JSON.stringify([state.simulation, state.simulationCurrent]);
    if (nextResultKey !== resultKey) {
      resultKey = nextResultKey;
      const area = element('simulation-result'), record = state.simulation;
      area.replaceChildren();
      if (!record) { area.append(node('p', 'Load a fixture, then run simulation to see the chosen rule and proposed effects.', 'notice')); return; }
      const result = record.result;
      area.append(node('p', state.simulationCurrent ? 'Current for these execution inputs.' : 'Stale result. The workflow or simulation inputs changed. Run again.', state.simulationCurrent ? 'success' : 'notice'));
      area.append(node('h2', `${result.status.replaceAll('_', ' ')} · ${result.reason}`), node('p', `Fake time ${result.now}${result.nextWakeAt ? ` · Next wake ${result.nextWakeAt}` : ''}`));
      area.append(node('p', `Tested document revision ${record.token.revision} · Package ${record.packageDigest}`, 'secondary path'));
      const trace = node('section', '', 'decision-trace'); trace.setAttribute('aria-label', 'Decision trace'); trace.append(node('h2', 'Why this path'));
      result.decisions.forEach((decision, index) => {
        trace.append(node('h3', `${index + 1}. ${decision.ruleId ?? 'Otherwise'} → ${decision.actionId}`));
        const list = node('ol');
        for (const rule of decision.rules) {
          const item = node('li'); item.append(node('strong', `${rule.id} · ${rule.selected ? 'Selected' : rule.condition.value === 'unknown' ? 'Not selected, evidence unknown' : 'Rejected'}`));
          const reasons = node('ul'); reasons.append(traceNode(rule.condition)); item.append(reasons); list.append(item);
        }
        trace.append(list);
      });
      area.append(trace);
      const effects = node('section', '', 'proposed-effects'); effects.setAttribute('aria-label', 'Proposed effects'); effects.append(node('h2', 'Proposed actions and effects'));
      if (!result.proposedEffects.length) effects.append(node('p', 'No action or remote effect is proposed.'));
      const effectsList = node('ul');
      for (const effect of result.proposedEffects) effectsList.append(node('li', `${effect.actionId} · ${effect.uses}: ${effect.reason}${effect.outcome ? ` Outcome ${effect.outcome}.` : ''}`));
      effects.append(effectsList);
      for (const action of result.actions) effects.append(node('p', `${action.actionId}: ${action.status}. ${action.reason}`));
      effects.append(node('p', `Fixture counters after replay: ${result.control.attemptsThisHead ?? 0} attempts for this head, ${result.control.repairsThisLifecycle ?? 0} repairs for this lifecycle.`, 'secondary'));
      area.append(effects);
      const slack = node('section', '', 'slack-preview'); slack.setAttribute('aria-label', 'Local Slack preview'); slack.append(node('h2', 'Local Slack preview'), node('p', 'No message was sent. This uses the shared Slack content renderer; actual Slack client rendering and delivery need pilot verification.', 'secondary'));
      if (record.previewError) slack.append(node('p', record.previewError, 'notice'));
      else if (!record.handoffs.length) slack.append(node('p', 'This replay proposes no human handoff.'));
      for (const { preview, packet } of record.handoffs) {
        const destination = preview.route.destination;
        slack.append(node('h3', destination?.kind === 'dm' ? `DM to ${destination.authorLogin} · ${destination.memberId}` : destination ? `${destination.name} · ${destination.channelId}` : 'No destination configured'));
        slack.append(node('p', preview.route.explanation, preview.route.fallback || !destination ? 'notice' : 'secondary'));
        const article = node('article'); article.setAttribute('aria-label', 'Proposed Slack message');
        for (const section of preview.sections) article.append(node('h3', section.heading), node('p', section.text));
        if (preview.route.mentions.length) article.append(node('p', `Configured mentions: ${preview.route.mentions.join(', ')}`));
        for (const omission of preview.omissions) article.append(node('p', omission, 'notice'));
        if (preview.omissions.length) article.append(node('p', 'For this simulation, open Complete decision packet below to read the full supplied input.', 'secondary'));
        for (const link of preview.links) article.append(node('p', `${link.label}: ${link.url}`, 'path'));
        slack.append(article);
        for (const [label, content] of [['Accessible message text', preview.message.text], ['Complete decision packet', JSON.stringify(packet, null, 2)]]) { const detail = node('details'); detail.append(node('summary', label), node('pre', content)); slack.append(detail); }
      }
      area.append(slack);
    }
  }
  return { render, pending: () => drafts.size, flush, discardDrafts };
}
