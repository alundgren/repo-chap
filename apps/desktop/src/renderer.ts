import type { CompanionCommand, CompanionResponse, CompanionState, Guidance } from '@repo-chap/companion';
import type { Condition, ConditionTrace } from '@repo-chap/workflow';
import type { CompanionBridge } from './protocol.js';

declare global { interface Window { repoChap: CompanionBridge } }
const bridge = window.repoChap;
const element = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] => {
  const result = document.createElement(tag); result.textContent = text; result.className = className; return result;
};
let state: CompanionState | null = null;
let busy = false, workflowKey = '', resultKey = '', guidanceId = '';
let dismissedGuidanceId = '';
let activeGuidance: Guidance | null = null;
const labels: Record<string, string> = {
  'facts.lifecycle': 'PR status', 'facts.draft': 'Draft PR', 'facts.evidenceComplete': 'Complete evidence', 'facts.young': 'New PR',
  'facts.headDebouncing': 'Recent commits', 'facts.conflict': 'Merge conflict', 'facts.unaddressedReview': 'Review to address',
  'facts.externalReviewPending': 'Reviewer working', 'memory.classificationCurrent': 'Classification current',
  'memory.reviewCurrent': 'Review current', 'memory.packetCurrent': 'Handoff current', 'memory.repairSuppressed': 'Repair paused',
};
function conditionText(condition: Condition): string {
  if ('field' in condition) {
    const name = labels[condition.field] ?? condition.field;
    if (typeof condition.value === 'boolean') return `${name}${(condition.op === 'eq') === condition.value ? '' : ' is false'}`;
    return `${name} ${condition.op === 'eq' ? 'is' : 'is not'} ${condition.value}`;
  }
  if ('not' in condition) return `Not (${conditionText(condition.not)})`;
  return ('all' in condition ? condition.all : condition.any).map(item => 'field' in item ? conditionText(item) : `(${conditionText(item)})`).join('all' in condition ? ' and ' : ' or ');
}
const actionLabels: Record<string, string> = {
  'control.close': 'Finish', 'control.wait_signal': 'Wait for a change', 'control.wait_refresh': 'Refresh evidence',
  'control.wait_debounce': 'Wait for commits to settle', 'control.wait_reviewer': 'Wait for reviewer',
  'agent.resolve_conflict': 'Resolve conflict', 'agent.address_review': 'Address review', 'agent.classify': 'Classify PR', 'agent.review': 'Review PR',
  'checks.validate_candidate': 'Test candidate', 'github.push_candidate': 'Push tested commit', 'github.resolve_eligible_threads': 'Resolve addressed threads',
  'github.publish_review': 'Publish review', 'github.set_labels': 'Set labels', 'human.publish_packet': 'Hand off to a person',
};
function detailList(entries: [string, string][]): HTMLElement {
  const list = node('dl');
  for (const [label, value] of entries) list.append(node('dt', label), node('dd', value));
  return list;
}
async function perform(operation: () => Promise<CompanionResponse | null>): Promise<void> {
  if (busy) return;
  busy = true; element('error').hidden = true; renderControls();
  try {
    const response = await operation();
    if (response?.ok) render(response.state);
    else if (response) { element('error').textContent = response.error; element('error').hidden = false; }
  } catch (error) { element('error').textContent = error instanceof Error ? error.message : 'The desktop operation failed.'; element('error').hidden = false; }
  finally { busy = false; renderControls(); }
}
function command(command: CompanionCommand): void { void perform(() => bridge.command(command)); }
element('open-repository').onclick = () => { void perform(() => bridge.chooseRepository()); };
element<HTMLSelectElement>('workflow-select').onchange = event => command({ kind: 'select', workflowPath: (event.target as HTMLSelectElement).value });
element('overview-tab').onclick = () => command({ kind: 'show', view: 'overview' });
element('simulation-tab').onclick = () => command({ kind: 'show', view: 'simulation' });
element('tests-mode').onclick = () => command({ kind: 'show', mode: 'tests' });
element('pr-mode').onclick = () => command({ kind: 'show', mode: 'pr' });
element('choose-input').onclick = () => { void perform(() => bridge.chooseInput(state!.mode)); };
element('choose-packets').onclick = () => { void perform(() => bridge.choosePackets()); };
element('simulate').onclick = () => command({ kind: 'simulate' });
function dismissGuidance(): void {
  dismissedGuidanceId = activeGuidance?.id ?? '';
  clearGuidance();
  void bridge.command({ kind: 'clear' }).then(response => { if (response.ok) render(response.state); }).catch(() => {});
}
element('dismiss-guidance').onclick = dismissGuidance;
document.addEventListener('keydown', event => { if (event.key === 'Escape' && activeGuidance) dismissGuidance(); });

function renderControls(): void {
  for (const id of ['open-repository', 'workflow-select', 'overview-tab', 'simulation-tab', 'tests-mode', 'pr-mode', 'choose-input', 'choose-packets']) element<HTMLButtonElement>(id).disabled = busy;
  element<HTMLButtonElement>('simulate').disabled = busy || !state?.workflow || !state.input?.fixture || !!state.input.error || !!state.packetsError;
}
function render(next: CompanionState): void {
  if (state && next.revision < state.revision) return;
  const navigated = state?.view !== next.view || state?.workflowPath !== next.workflowPath || state?.repositoryRoot !== next.repositoryRoot;
  state = next;
  element('welcome').hidden = !!state.repositoryRoot;
  element('empty').hidden = !state.repositoryRoot || !!state.workflowPath;
  element('workspace').hidden = !state.workflowPath;
  element('repository-name').textContent = state.repositoryRoot?.split('/').at(-1) ?? '';
  element('repository-name').title = state.repositoryRoot ?? '';
  element('workflow-title').textContent = state.workflow?.id ?? state.workflowPath?.split('/').at(-1) ?? '';
  element('workflow-path').textContent = state.workflowPath ?? '';
  const picker = element<HTMLSelectElement>('workflow-select');
  const options = JSON.stringify(state.workflows);
  if (picker.dataset.options !== options) {
    picker.replaceChildren(...state.workflows.map(entry => { const option = node('option', `${entry.id ?? 'Workflow'} · ${entry.path}`); option.value = entry.path; return option; }));
    picker.dataset.options = options;
  }
  picker.value = state.workflowPath ?? '';
  for (const view of ['overview', 'simulation'] as const) {
    element(view).hidden = state.view !== view;
    if (state.view === view) element(`${view}-tab`).setAttribute('aria-current', 'page');
    else element(`${view}-tab`).removeAttribute('aria-current');
  }
  element('validation-status').textContent = state.diagnostics.length ? 'Needs a fix' : 'Workflow valid';
  element('validation-status').className = `secondary ${state.diagnostics.length ? 'danger' : 'success'}`;
  element('discovery-warning').textContent = state.discoveryWarning ?? ''; element('discovery-warning').hidden = !state.discoveryWarning;
  const diagnostics = element('diagnostics'); diagnostics.hidden = !state.diagnostics.length;
  const list = node('ul');
  for (const item of state.diagnostics) list.append(node('li', `${item.path}: ${item.message}`));
  diagnostics.replaceChildren(node('p', 'Your agent can fix these files. The view will refresh when they are saved.', 'danger'), list);
  element('workflow-content').hidden = !state.workflow;
  element('recent-changes').hidden = !state.changedPaths.length;
  element('recent-changes').textContent = `Updated ${state.changedPaths.join(', ')}`;
  const key = JSON.stringify([state.workflowPath, state.workflow, state.files]);
  if (key !== workflowKey) { workflowKey = key; renderWorkflow(); }
  renderSimulation(); renderControls();
  if (navigated) window.scrollTo({ top: 0, behavior: 'instant' });
  renderGuidance(state.guidance);
}
function renderWorkflow(): void {
  const workflow = state?.workflow;
  if (!workflow) return;
  const opened = new Set([...element('actions').querySelectorAll<HTMLDetailsElement>('details[open]')].map(item => item.dataset.target));
  element('rules').replaceChildren(...workflow.rules.map(rule => {
    const item = node('li'); item.dataset.target = `rule:${rule.id}`;
    const title = node('div', '', 'rule-title'); title.append(node('strong', rule.id), node('span', `→ ${rule.action}`, 'rule-destination'));
    item.append(title, node('p', conditionText(rule.when), 'rule-condition')); return item;
  }));
  element('otherwise').textContent = `Otherwise → ${workflow.otherwise}`;
  element('actions').replaceChildren(...Object.entries(workflow.actions).map(([id, action]) => {
    const detail = node('details'); detail.dataset.target = `action:${id}`; detail.open = opened.has(detail.dataset.target);
    const summary = node('summary', id); summary.append(node('span', actionLabels[action.uses] ?? action.uses, 'secondary'));
    const content = node('div', '', 'action-details');
    const entries: [string, string][] = [['On success', action.onSuccess], ['On failure', action.onFailure]];
    if (action.prompt) entries.push(['Prompt', action.prompt]);
    if (action.contextFiles?.length) entries.push(['Context', action.contextFiles.join(', ')]);
    if (action.capabilities.length) entries.push(['Permissions', action.capabilities.join(', ')]);
    content.append(detailList(entries)); detail.append(summary, content); return detail;
  }));
  element('settings').replaceChildren(detailList([
    ['New PR delay', `${workflow.settings.newPrDelaySeconds}s`], ['Commit debounce', `${workflow.settings.headDebounceSeconds}s`],
    ['Reviewer recheck', `${workflow.settings.reviewWaitSeconds}s`], ['Reviewer deadline', `${workflow.settings.reviewDeadlineSeconds}s`],
    ['Attempts per head', String(workflow.limits.maxAttemptsPerHead)], ['Repairs per lifecycle', String(workflow.limits.maxRepairsPerLifecycle)],
    ['Agent actions per wake', String(workflow.limits.maxAgentActionsPerWake)], ['Attempt deadline', `${workflow.limits.maxAttemptSeconds}s`],
    ['Daily cost units', String(workflow.limits.maxDailyCostUnits)], ['Merge', 'A person merges'],
  ]));
  element('files').replaceChildren(...state!.files.map(file => node('li', file.path, 'path')));
}
function traceItem(trace: ConditionTrace): HTMLElement {
  const item = node('li', `${trace.value}: ${trace.reason}`);
  if (trace.children) { const list = node('ul'); list.append(...trace.children.map(traceItem)); item.append(list); }
  return item;
}
function renderSimulation(): void {
  if (!state) return;
  const input = state.input;
  element('tests-mode').setAttribute('aria-pressed', String(state.mode === 'tests'));
  element('pr-mode').setAttribute('aria-pressed', String(state.mode === 'pr'));
  element('choose-input').textContent = state.mode === 'tests' ? 'Choose fixture' : 'Choose capture';
  element('input-summary').textContent = input?.capture ? `${input.capture.repository} #${input.capture.pr} · ${input.capture.title}` : input?.path.split('/').at(-1) ?? (state.mode === 'tests' ? 'Choose a test fixture to try this workflow.' : 'Choose a PR capture made by your agent.');
  element('input-note').textContent = state.mode === 'tests' ? 'Saved facts, stubbed action results, and a fixed clock.' : input?.capture
    ? `Captured ${input.fixture!.now} · ${input.capture.status} evidence · Head ${input.capture.headSha?.slice(0, 12) ?? 'unknown'}. Current GitHub state has not been checked.${input.capture.packageDigest !== state.packageDigest ? ' This capture was made with an earlier workflow.' : ''}`
    : 'Your agent can capture a PR with repo-chap inspect. Replaying a capture makes no live requests.';
  element('input-error').textContent = input?.error ?? state.packetsError ?? ''; element('input-error').hidden = !input?.error && !state.packetsError;
  element('input-details').hidden = !input;
  element('input-json').textContent = input?.fixture ? JSON.stringify(input.fixture, null, 2) : '';
  element('packets-summary').textContent = state.packetsPath ?? '';
  const key = JSON.stringify([state.workflowPath, state.mode, state.simulation, state.simulationCurrent]);
  if (key === resultKey) return;
  resultKey = key;
  const area = element('result'), simulation = state.simulation;
  area.hidden = !simulation; area.replaceChildren();
  if (!simulation) return;
  const result = simulation.result;
  if (!state.simulationCurrent) area.append(node('p', 'Files changed. Simulate again to test the current workflow and input.', 'notice'));
  const title = simulation.comparison ? `Test ${simulation.comparison.passed ? 'passed' : 'failed'}` : `Simulation ${result.status.replaceAll('_', ' ')}`;
  area.append(node('h2', state.simulationCurrent ? title : `Previous ${title.toLowerCase()}`), node('p', result.reason));
  if (result.nextWakeAt) area.append(node('p', `Next wake ${result.nextWakeAt}`, 'secondary'));
  if (simulation.comparison) {
    const table = node('table'); table.setAttribute('aria-label', 'Expected and actual outcomes');
    const header = node('thead'), row = node('tr');
    for (const title of ['Check', 'Expected', 'Actual', 'Result']) row.append(node('th', title));
    header.append(row); table.append(header);
    const body = node('tbody');
    for (const check of simulation.comparison.checks) {
      const row = node('tr'); row.append(node('td', check.field), node('td', JSON.stringify(check.expected)), node('td', JSON.stringify(check.actual)), node('td', check.passed ? 'Pass' : 'Fail', check.passed ? 'success' : 'danger')); body.append(row);
    }
    table.append(body); area.append(table);
  }
  area.append(node('h3', 'What would happen'));
  const trace = node('ol', '', 'trace');
  for (const decision of result.decisions) {
    const item = node('li', `${decision.ruleId ?? 'Otherwise'} → ${decision.actionId}`);
    const detail = node('details'); detail.append(node('summary', 'Why this rule'));
    const rules = node('ul');
    for (const rule of decision.rules) {
      const reason = node('li', `${rule.id}${rule.selected ? ' · selected' : ''}`), conditions = node('ul'); conditions.append(traceItem(rule.condition)); reason.append(conditions); rules.append(reason);
    }
    detail.append(rules); item.append(detail); trace.append(item);
  }
  area.append(trace);
  if (result.actions.length) {
    const actions = node('ul', '', 'effects');
    for (const action of result.actions) actions.append(node('li', `${action.actionId} · ${action.status}. ${action.reason}`));
    area.append(actions);
  }
  if (result.proposedEffects.length) {
    area.append(node('h3', 'Proposed effects'));
    const effects = node('ul', '', 'effects');
    for (const effect of result.proposedEffects) effects.append(node('li', `${actionLabels[effect.uses] ?? effect.uses}${effect.outcome ? ` · ${effect.outcome}` : ''}. ${effect.reason}`));
    area.append(effects);
  }
  if (simulation.previewError) area.append(node('p', `Slack preview: ${simulation.previewError}`, 'notice'));
  for (const handoff of simulation.handoffs) {
    area.append(node('h3', 'Slack preview'), node('p', handoff.preview.route.explanation), node('pre', handoff.preview.message.text));
  }
  const record = node('details'); record.append(node('summary', 'Simulation record'), node('pre', JSON.stringify(simulation, null, 2))); area.append(record);
}

function targetElement(target: string): HTMLElement | undefined { return [...document.querySelectorAll<HTMLElement>('[data-target]')].find(item => item.dataset.target === target); }
function guidanceAnchor(target: HTMLElement): HTMLElement {
  return target instanceof HTMLDetailsElement ? target.querySelector('summary')! : target.offsetHeight > innerHeight * .6 ? target.querySelector<HTMLElement>('h1,h2,h3') ?? target : target;
}
function clearGuidance(): void {
  document.querySelectorAll('.agent-target').forEach(item => item.classList.remove('agent-target'));
  element('guidance').hidden = true; document.getElementById('guidance-arrow')!.setAttribute('hidden', ''); activeGuidance = null;
}
function renderGuidance(guidance: Guidance | null): void {
  const fresh = guidance?.id !== guidanceId;
  clearGuidance();
  if (!guidance || guidance.expiresAt <= Date.now() || guidance.id === dismissedGuidanceId) { guidanceId = ''; return; }
  const target = targetElement(guidance.target);
  if (!target) return;
  activeGuidance = guidance; guidanceId = guidance.id;
  if (target instanceof HTMLDetailsElement) target.open = true;
  for (let parent = target.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
  target.classList.add('agent-target');
  if (fresh) {
    const anchor = guidanceAnchor(target); anchor.tabIndex = -1;
    anchor.scrollIntoView({ block: 'center', behavior: 'instant' }); anchor.focus({ preventScroll: true });
  }
  if (guidance.text) { element('guidance-text').textContent = guidance.text; element('guidance').hidden = false; }
  positionGuidance();
}
function positionGuidance(): void {
  if (!activeGuidance) return;
  const target = targetElement(activeGuidance.target);
  if (!target) { clearGuidance(); return; }
  const rect = guidanceAnchor(target).getBoundingClientRect(), bubble = element('guidance');
  if (!activeGuidance.text) return;
  const left = Math.max(16, Math.min(innerWidth - bubble.offsetWidth - 16, rect.left));
  const below = rect.bottom + bubble.offsetHeight + 55 < innerHeight;
  const top = Math.max(16, Math.min(innerHeight - bubble.offsetHeight - 16, below ? rect.bottom + 44 : rect.top - bubble.offsetHeight - 44));
  bubble.style.left = `${left}px`; bubble.style.top = `${top}px`;
  const arrow = document.getElementById('guidance-arrow')!;
  if (activeGuidance.style === 'arrow') {
    arrow.removeAttribute('hidden');
    const x = Math.max(24, Math.min(innerWidth - 24, rect.left + Math.min(rect.width / 2, 100)));
    document.getElementById('arrow-line')!.setAttribute('d', `M ${left + Math.min(bubble.offsetWidth / 2, 100)} ${below ? top : top + bubble.offsetHeight} L ${x} ${below ? rect.bottom + 10 : rect.top - 10}`);
  }
}
window.addEventListener('resize', positionGuidance); window.addEventListener('scroll', positionGuidance, true);
setInterval(() => { if (activeGuidance && activeGuidance.expiresAt <= Date.now()) clearGuidance(); }, 250);
bridge.onChange(render);
void bridge.current().then(render).catch(error => { element('error').textContent = String(error); element('error').hidden = false; });
