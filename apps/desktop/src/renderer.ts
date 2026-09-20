import { actionRegistry, factTypes, memoryFields } from '@repo-chap/workflow/catalogue';
import type { Action, Condition, ConditionTrace, Workflow } from '@repo-chap/workflow';
import type { CompanionCommand, CompanionResponse, CompanionState } from '@repo-chap/companion';
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
let activeGuidance: CompanionState['guidance'] = null;
const graphObservers = new Set<ResizeObserver>();

const fieldLabels: Record<string, { yes: string; no: string; name: string; explanation: string }> = {
  'facts.lifecycle': { yes: 'PR status matches', no: 'PR status does not match', name: 'PR status', explanation: 'Whether the pull request is open, closed, or merged.' },
  'facts.draft': { yes: 'Draft PR', no: 'Ready for review', name: 'Draft status', explanation: 'Whether GitHub marks the pull request as a draft.' },
  'facts.evidenceComplete': { yes: 'All GitHub details available', no: 'Missing GitHub details', name: 'GitHub details', explanation: 'GitHub returned the PR, but one or more details such as checks or review comments could not be read.' },
  'facts.young': { yes: 'PR just opened', no: 'PR is past its opening delay', name: 'New PR', explanation: 'Whether the pull request is still inside the configured opening delay.' },
  'facts.headDebouncing': { yes: 'Recent commits still settling', no: 'Recent commits have settled', name: 'Recent commits', explanation: 'Whether the latest commit is still inside the configured settling time.' },
  'facts.conflict': { yes: 'Merge conflict', no: 'No merge conflict', name: 'Merge conflict', explanation: 'Whether GitHub reports that the pull request cannot merge cleanly.' },
  'facts.unaddressedReview': { yes: 'Review comments to address', no: 'No review comments to address', name: 'Review comments', explanation: 'Whether current review feedback still needs a code change.' },
  'facts.ciFailed': { yes: 'Checks failed', no: 'Checks have not failed', name: 'Failed checks', explanation: 'Whether a required check has failed on the current commit.' },
  'facts.ciPending': { yes: 'Checks still running', no: 'Checks are not running', name: 'Running checks', explanation: 'Whether a required check is still in progress.' },
  'facts.externalReviewPending': { yes: 'Reviewer still working', no: 'Reviewer is not working', name: 'Reviewer activity', explanation: 'Whether a configured reviewer recently signalled that they are looking at the pull request.' },
  'memory.classificationCurrent': { yes: 'Current PR version classified', no: 'Current PR version needs classification', name: 'Classification', explanation: 'Whether Repo Chap has categorized the current PR version using the GitHub details it read.' },
  'memory.reviewCurrent': { yes: 'Current PR version reviewed', no: 'Current PR version needs review', name: 'Review', explanation: 'Whether the agent reviewed the current PR version using the latest GitHub details.' },
  'memory.packetCurrent': { yes: 'Current Slack request prepared', no: 'Current Slack request still needed', name: 'Slack request', explanation: 'Whether Repo Chap has prepared the Slack request for the current PR version.' },
  'memory.repairSuppressed': { yes: 'Repair paused for a person', no: 'Automatic repair allowed', name: 'Repair pause', explanation: 'Whether the repair limit or another retained decision has paused automatic repair.' },
};
const actionLabels: Record<string, string> = {
  'control.close': 'Finish', 'control.wait_signal': 'Wait for an update', 'control.wait_refresh': 'Wait before trying GitHub again',
  'control.wait_debounce': 'Wait for commits to settle', 'control.wait_reviewer': 'Wait for the reviewer',
  'agent.fix_ci': 'Fix failing checks', 'agent.resolve_conflict': 'Repair the merge conflict', 'agent.address_review': 'Address review comments',
  'agent.classify': 'Classify the pull request', 'agent.review': 'Review the pull request',
  'checks.validate_candidate': 'Run required checks', 'github.push_candidate': 'Push the checked commit',
  'github.resolve_eligible_threads': 'Resolve addressed review threads', 'github.publish_review': 'Publish the review on GitHub',
  'github.set_labels': 'Update GitHub labels', 'human.publish_packet': 'Ask a person in Slack',
};
const actionDescriptions: Record<string, string> = {
  'control.close': 'Stop after the pull request has finished.',
  'control.wait_signal': 'Pause until the pull request changes.',
  'control.wait_refresh': 'Pause before reading missing GitHub details again.',
  'control.wait_debounce': 'Give a new pull request or commit time to settle.',
  'control.wait_reviewer': 'Give a human reviewer time to finish.',
  'agent.fix_ci': 'Let an agent repair failures in the repository checkout.',
  'agent.resolve_conflict': 'Let an agent repair a merge conflict in the repository checkout.',
  'agent.address_review': 'Let an agent change code in response to review comments.',
  'agent.classify': 'Let an agent choose the configured categories for the pull request.',
  'agent.review': 'Let an agent review the current pull request and report findings.',
  'checks.validate_candidate': 'Run the configured local checks against a repaired commit.',
  'github.push_candidate': 'Push a commit only after its required checks pass.',
  'github.resolve_eligible_threads': 'Resolve only review threads confirmed as addressed by the pushed commit.',
  'github.publish_review': 'Publish a validated agent review as a GitHub pull request review.',
  'github.set_labels': 'Add or remove the configured classification labels without replacing unrelated labels.',
  'human.publish_packet': 'Prepare and send the configured decision request to a person in Slack.',
};
const actionExamples: Record<string, string> = {
  'control.wait_refresh': 'PR #42 was read, but GitHub did not return its review comments. Try reading GitHub again after the configured delay.',
  'agent.resolve_conflict': 'PR #42 conflicts with main. Repair the local copy before running its required checks.',
  'agent.address_review': 'A reviewer asked PR #42 to handle an empty response. Make that change in the local copy.',
  'agent.fix_ci': 'The test job for PR #42 failed after a renamed field was missed. Repair it in the local copy.',
  'checks.validate_candidate': 'Run the repository checks against the exact repair commit before it can be pushed.',
  'github.push_candidate': 'Push the checked repair only if PR #42 still has the commit that was inspected.',
  'github.resolve_eligible_threads': 'After the repair is pushed, resolve the review thread whose requested change is now present.',
  'github.publish_review': 'Post the validated findings on PR #42 after confirming its commit has not changed.',
  'github.set_labels': 'Add the configured security label to PR #42 without removing the team’s existing labels.',
  'human.publish_packet': 'Send the PR link, failed check, and attempted repair to the configured Slack channel.',
};
const conditionExamples: Record<string, string> = {
  'facts.evidenceComplete': 'GitHub returned PR #42, but its review comments could not be read.',
  'facts.conflict': 'PR #42 and main changed the same lines, so GitHub cannot merge them cleanly.',
  'facts.unaddressedReview': 'A reviewer asked PR #42 to handle an empty response, and that change is not present yet.',
  'facts.ciFailed': 'A required test job failed on the current commit in PR #42.',
  'memory.packetCurrent': 'A Slack request has already been prepared for the current version of PR #42.',
};
const continuationLabels: Record<string, string> = {
  '$observe': 'Reinspect PR', '$wait': 'Reinspect PR', '$closed': 'Finished', '$blocked': 'Stop with a problem',
};
const flowContinuationLabels: Record<string, string> = { ...continuationLabels, '$wait': 'Wait for an update' };
const humanize = (value: string): string => value.split('.').at(-1)!.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
const actionLabel = (uses: string): string => actionLabels[uses] ?? humanize(uses);
function configuredActionLabel(id: string, workflow: Workflow): string {
  const action = workflow.actions[id]!;
  const repeated = Object.values(workflow.actions).filter(candidate => candidate.uses === action.uses).length > 1;
  return actionLabel(action.uses) + (repeated ? ' · ' + id : '');
}
function configuredActionName(id: string, workflow: Workflow, className = ''): HTMLElement {
  const action = workflow.actions[id]!, result = node('span', '', className);
  result.append(node('span', actionLabel(action.uses)));
  return result;
}

function leafConditionText(condition: Extract<Condition, { field: string }>): string {
  const definition = fieldLabels[condition.field];
  if (condition.field === 'facts.lifecycle') return 'PR is ' + (condition.op === 'eq' ? '' : 'not ') + condition.value + '?';
  if (typeof condition.value === 'boolean') {
    const expectsTrue = (condition.op === 'eq') === condition.value;
    return (definition?.[expectsTrue ? 'yes' : 'no'] ?? condition.field + ' is ' + (expectsTrue ? 'true' : 'false')) + '?';
  }
  return (definition?.name ?? condition.field) + (condition.op === 'eq' ? ' is ' : ' is not ') + condition.value + '?';
}
function conditionText(condition: Condition, nested = false): string {
  if ('field' in condition) return leafConditionText(condition);
  if ('not' in condition) return 'Not ' + conditionText(condition.not, true);
  const children = ('all' in condition ? condition.all : condition.any).map(item => conditionText(item, true));
  const text = children.join('all' in condition ? ' and ' : ' or ');
  return nested ? '(' + text + ')' : text;
}
function conditionTree(condition: Condition): HTMLElement {
  if ('field' in condition) {
    const item = node('div', '', 'condition-leaf');
    item.append(node('span', leafConditionText(condition)), node('code', condition.field + ' ' + condition.op + ' ' + JSON.stringify(condition.value)));
    return item;
  }
  const group = node('div', '', 'condition-group');
  if ('not' in condition) {
    group.append(node('strong', 'Not'), conditionTree(condition.not));
  } else {
    group.append(node('strong', 'all' in condition ? 'All of' : 'Any of'));
    const list = node('ul');
    for (const child of 'all' in condition ? condition.all : condition.any) {
      const item = node('li'); item.append(conditionTree(child)); list.append(item);
    }
    group.append(list);
  }
  return group;
}
function conditionHelp(condition: Condition): HTMLElement {
  const detail = node('details', '', 'condition-help'), summary = node('summary', '?');
  summary.setAttribute('aria-label', 'Explain this decision');
  const explanation = node('div', '', 'condition-explanation'), fields = new Set<string>();
  const collect = (item: Condition): void => {
    if ('field' in item) fields.add(item.field);
    else if ('not' in item) collect(item.not);
    else ('all' in item ? item.all : item.any).forEach(collect);
  };
  collect(condition);
  for (const field of fields) explanation.append(node('p', fieldLabels[field]?.explanation ?? 'This workflow reads ' + field + '.'));
  explanation.append(conditionTree(condition));
  detail.append(summary, explanation);
  return detail;
}
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
function command(commandValue: CompanionCommand): void { void perform(() => bridge.command(commandValue)); }
const chooseRepository = (): void => { void perform(() => bridge.chooseRepository()); };
element('open-repository').onclick = chooseRepository;
element('welcome-open').onclick = chooseRepository;
element<HTMLSelectElement>('workflow-select').onchange = event => command({ kind: 'select', workflowPath: (event.target as HTMLSelectElement).value });
element('overview-tab').onclick = () => command({ kind: 'show', view: 'overview' });
element('available-tab').onclick = () => command({ kind: 'show', view: 'available' });
element('simulation-tab').onclick = () => command({ kind: 'show', view: 'simulation' });
element('tests-mode').onclick = () => command({ kind: 'show', mode: 'tests' });
element('pr-mode').onclick = () => command({ kind: 'show', mode: 'pr' });
element('choose-input').onclick = () => { void perform(() => bridge.chooseInput(state!.mode)); };
element('choose-packets').onclick = () => { void perform(() => bridge.choosePackets()); };
element('simulate').onclick = () => command({ kind: 'simulate' });

function agentRequest(): string {
  const repository = state?.repositoryRoot ?? 'this repository';
  return 'Use $repo-chap-workflows to add a Repo Chap workflow for ' + repository + '. Ask me about the behavior I want, create the workflow as repository JSON and Markdown, validate it, and keep its examples fictional. The Repo Chap desktop is open and will refresh when you save the files.';
}
function showAddWorkflow(): void {
  element('agent-request').textContent = agentRequest();
  element('copy-status').textContent = '';
  element<HTMLDialogElement>('add-workflow-dialog').showModal();
}
element('add-workflow').onclick = showAddWorkflow;
element('empty-add').onclick = showAddWorkflow;
element('copy-agent-request').onclick = () => {
  void bridge.copyText(agentRequest()).then(() => { element('copy-status').textContent = 'Request copied.'; })
    .catch(error => { element('copy-status').textContent = error instanceof Error ? error.message : 'Could not copy the request.'; });
};
function dismissGuidance(): void {
  dismissedGuidanceId = activeGuidance?.id ?? '';
  clearGuidance();
  void bridge.command({ kind: 'clear' }).then(response => { if (response.ok) render(response.state); }).catch(() => {});
}
element('dismiss-guidance').onclick = dismissGuidance;
document.addEventListener('keydown', event => { if (event.key === 'Escape' && activeGuidance) dismissGuidance(); });

function renderControls(): void {
  for (const id of ['open-repository', 'welcome-open', 'workflow-select', 'add-workflow', 'overview-tab', 'available-tab', 'simulation-tab', 'tests-mode', 'pr-mode', 'choose-input', 'choose-packets']) {
    element<HTMLButtonElement | HTMLSelectElement>(id).disabled = busy;
  }
  element<HTMLButtonElement>('simulate').disabled = busy || !state?.workflow || !state.input?.fixture || !!state.input.error || !!state.packetsError;
}
function render(next: CompanionState): void {
  if (state && next.revision < state.revision) return;
  const navigated = state?.view !== next.view || state?.workflowPath !== next.workflowPath || state?.repositoryRoot !== next.repositoryRoot;
  state = next;
  element('welcome').hidden = !!state.repositoryRoot;
  element('empty').hidden = !state.repositoryRoot || !!state.workflowPath;
  element('workspace').hidden = !state.workflowPath;
  element('header-workflow').hidden = !state.repositoryRoot;
  element('view-navigation').hidden = !state.workflowPath;
  element('repository-name').textContent = state.repositoryName ?? (state.repositoryRoot ? state.repositoryRoot.split('/').at(-1)! : 'Open repository');
  element('worktree-name').textContent = state.worktreeName ? 'Worktree: ' + state.worktreeName : '';
  element('worktree-name').hidden = !state.worktreeName;
  element('open-repository').setAttribute('aria-label', state.repositoryRoot ? 'Change repository' : 'Open repository');
  element('open-repository').title = state.repositoryRoot ?? 'Open repository';
  const picker = element<HTMLSelectElement>('workflow-select'), options = JSON.stringify(state.workflows);
  if (picker.dataset.options !== options) {
    picker.replaceChildren(...state.workflows.map(entry => { const option = node('option', (entry.id ?? 'Workflow') + ' · ' + entry.path); option.value = entry.path; return option; }));
    picker.dataset.options = options;
  }
  picker.value = state.workflowPath ?? '';
  picker.hidden = !state.workflows.length;
  for (const [view, tab] of [['overview', 'overview-tab'], ['available', 'available-tab'], ['simulation', 'simulation-tab']] as const) {
    element(view).hidden = state.view !== view;
    if (state.view === view) element(tab).setAttribute('aria-current', 'page'); else element(tab).removeAttribute('aria-current');
  }
  element('discovery-warning').textContent = state.discoveryWarning ?? ''; element('discovery-warning').hidden = !state.discoveryWarning;
  const diagnostics = element('diagnostics'); diagnostics.hidden = !state.diagnostics.length;
  const list = node('ul');
  for (const item of state.diagnostics) list.append(node('li', item.path + ': ' + item.message));
  diagnostics.replaceChildren(node('h2', 'This workflow needs a fix'), node('p', 'Your agent can fix the source file. The map will return when the saved workflow is valid.'), list);
  element('workflow-content').hidden = !state.workflow || !!state.diagnostics.length;
  element('recent-changes').hidden = !state.changedPaths.length;
  element('recent-changes').textContent = 'Updated ' + state.changedPaths.join(', ');
  const key = JSON.stringify([state.workflowPath, state.workflow, state.files]);
  if (key !== workflowKey) { workflowKey = key; renderWorkflow(); }
  renderSimulation(); renderControls();
  if (navigated) window.scrollTo({ top: 0, behavior: 'instant' });
  renderGuidance(state.guidance);
}

function reachableActions(start: string, workflow: Workflow, expanded: Set<string>): string[] {
  const found: string[] = [], seen = new Set<string>(), pending = [start];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id) || !workflow.actions[id]) continue;
    seen.add(id); found.push(id);
    const action = workflow.actions[id]!;
    for (const target of [action.onFailure, action.onSuccess]) {
      if (workflow.actions[target] && !expanded.has(target) && !seen.has(target)) pending.push(target);
    }
  }
  return found;
}
function assignActionTarget(item: HTMLElement | SVGElement, id: string, claimed: Set<string>): void {
  if (!claimed.has(id)) { item.dataset.target = 'action:' + id; claimed.add(id); }
}
const svgNamespace = 'http://www.w3.org/2000/svg';
function svgNode<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const result = document.createElementNS(svgNamespace, tag);
  for (const [name, value] of Object.entries(attributes)) result.setAttribute(name, value);
  return result;
}
function pathHelp(ids: string[], workflow: Workflow): HTMLElement {
  const detail = node('details', '', 'action-help path-help'), summary = node('summary', '?');
  summary.setAttribute('aria-label', 'Explain this action path');
  const content = node('div', '', 'path-help-content');
  for (const id of ids) {
    const action = workflow.actions[id]!, section = node('section');
    section.append(node('strong', actionLabel(action.uses)));
    const continuation = (target: string): string => (workflow.actions[target] ? actionLabel(workflow.actions[target]!.uses) : continuationLabels[target] ?? target) + ' · ' + target;
    const entries: [string, string][] = [['Action', id], ['Contract', action.uses], ['Completed', continuation(action.onSuccess)], ['Failed', continuation(action.onFailure)]];
    if (action.prompt) entries.push(['Instructions', action.prompt]);
    if (action.contextFiles?.length) entries.push(['Context', action.contextFiles.join(', ')]);
    if (action.capabilities.length) entries.push(['Access', action.capabilities.join(', ')]);
    section.append(detailList(entries)); content.append(section);
  }
  detail.append(summary, content);
  return detail;
}
function successLabel(action: Action): string {
  if (action.uses === 'agent.resolve_conflict') return 'Resolved';
  if (action.uses === 'checks.validate_candidate') return 'Passed';
  if (action.uses === 'github.push_candidate') return 'Pushed';
  return 'Completed';
}
function wrappedSvgText(text: string, x: number, y: number, className: string, maxCharacters: number): SVGTextElement {
  const result = svgNode('text', { x: String(x), y: String(y), class: className, 'text-anchor': 'middle' });
  const words = text.split(' '), lines: string[] = [];
  for (const word of words) {
    const last = lines.at(-1);
    if (!last || last.length + word.length + 1 > maxCharacters) lines.push(word); else lines[lines.length - 1] = last + ' ' + word;
  }
  lines.forEach((line, index) => {
    const part = svgNode('tspan', { x: String(x), dy: index ? '18' : String(-(lines.length - 1) * 9) }); part.textContent = line; result.append(part);
  });
  return result;
}
function actionFlowchart(ids: string[], workflow: Workflow, claimed: Set<string>, start: string): SVGSVGElement {
  const chart = svgNode('svg', { class: 'flowchart', role: 'img', 'aria-label': 'Configured continuation flow from ' + configuredActionLabel(start, workflow) });
  const claimable = new Set(ids.filter(id => !claimed.has(id))); claimable.forEach(id => claimed.add(id));
  const markerId = 'flow-arrow-' + start.replace(/[^a-zA-Z0-9_-]/g, '-');
  const draw = (layoutWidth: number): void => {
    const highlightedTarget = chart.querySelector<SVGElement>('.agent-target')?.dataset.target;
    const width = Math.max(300, Math.round(layoutWidth)), narrow = width < 560;
    const centerX = narrow ? width * .34 : width * .35, rightX = narrow ? width * .75 : width * .76;
    const actionGap = narrow ? 100 : 88, firstY = 38;
    const primary: string[] = [], primarySet = new Set<string>();
    let current: string | undefined = start;
    while (current && ids.includes(current) && !primarySet.has(current)) {
      primary.push(current); primarySet.add(current);
      const next: string = workflow.actions[current]!.onSuccess;
      current = ids.includes(next) ? next : undefined;
    }
    const side = ids.filter(id => !primarySet.has(id)), positions = new Map<string, { x: number; y: number }>();
    primary.forEach((id, index) => positions.set(id, { x: centerX, y: firstY + index * actionGap }));
    side.forEach((id, index) => positions.set(id, { x: rightX, y: firstY + (primary.length + index) * actionGap }));
    const external = new Map<string, { x: number; y: number; label: string }>();
    const terminalTargets: string[] = [];
    for (const id of ids) {
      const action = workflow.actions[id]!;
      for (const target of [action.onSuccess, action.onFailure]) {
        if (positions.has(target) || external.has(target)) continue;
        terminalTargets.push(target);
        external.set(target, { x: 0, y: 0, label: workflow.actions[target] ? actionLabel(workflow.actions[target]!.uses) + ' · shown above' : flowContinuationLabels[target] ?? target });
      }
    }
    const terminalY = firstY + Math.max(1, ids.length) * actionGap + 12, terminalGap = narrow ? 68 : 60;
    terminalTargets.forEach((target, index) => {
      const column = target === '$blocked' || workflow.actions[target] ? rightX : centerX;
      const columnIndex = terminalTargets.slice(0, index).filter(previous => Boolean(previous === '$blocked' || workflow.actions[previous]) === Boolean(target === '$blocked' || workflow.actions[target])).length;
      Object.assign(external.get(target)!, { x: column, y: terminalY + columnIndex * terminalGap });
    });
    const height = Math.max(150, Math.max(terminalY, ...[...external.values()].map(item => item.y)) + 48);
    chart.replaceChildren(); chart.setAttribute('viewBox', `0 0 ${width} ${height}`); chart.style.height = height + 'px';
    const defs = svgNode('defs'), marker = svgNode('marker', { id: markerId, class: 'flow-marker', markerWidth: '7', markerHeight: '7', refX: '6', refY: '3', orient: 'auto' });
    marker.append(svgNode('path', { d: 'M0 0 L6 3 L0 6' })); defs.append(marker); chart.append(defs);
    const edges = svgNode('g', { class: 'flow-edges' });
    ids.forEach((id, index) => {
      const action = workflow.actions[id]!, source = positions.get(id)!;
      for (const [target, failed] of [[action.onSuccess, false], [action.onFailure, true]] as const) {
        const destination = positions.get(target) ?? external.get(target)!;
        const adjacentSuccess = !failed && primarySet.has(id) && primarySet.has(target) && destination.y === source.y + actionGap;
        const laneX = failed ? width * (.61 + (index % 3) * .025) : width * (.16 - (index % 3) * .018);
        const path = adjacentSuccess
          ? `M ${source.x} ${source.y + 14} V ${destination.y - 24}`
          : `M ${source.x} ${source.y + 14} V ${source.y + 35} H ${laneX} V ${destination.y - 30} H ${destination.x} V ${destination.y - 20}`;
        const loops = !!positions.get(target) && destination.y <= source.y;
        const edge = svgNode('path', { d: path, class: failed ? 'failure-edge' : 'success-edge', 'marker-end': `url(#${markerId})`, 'data-edge-target': target, 'data-edge-loop': String(loops) });
        const edgeTitle = svgNode('title'); edgeTitle.textContent = (failed ? 'Failed' : successLabel(action)) + (loops ? ' loops' : '') + ' to ' + (workflow.actions[target] ? actionLabel(workflow.actions[target]!.uses) : continuationLabels[target] ?? target);
        edge.append(edgeTitle); edges.append(edge);
        const label = svgNode('text', { x: String(adjacentSuccess ? source.x - 12 : (failed ? source.x + width * .07 : source.x - width * .07)), y: String(source.y + 31), class: failed ? 'failure-label' : 'success-label', 'text-anchor': failed ? 'start' : 'end' });
        label.textContent = failed ? 'Failed' : successLabel(action); edges.append(label);
      }
    });
    chart.append(edges);
    for (const id of ids) {
      const position = positions.get(id)!, group = svgNode('g', { class: 'flow-step', tabindex: '-1' });
      group.setAttribute('transform', `translate(0 ${position.y})`); if (claimable.has(id)) group.dataset.target = 'action:' + id;
      const action = workflow.actions[id]!;
      const destination = (target: string): string => (workflow.actions[target] ? actionLabel(workflow.actions[target]!.uses) : continuationLabels[target] ?? target) + ' (' + target + ')';
      const title = svgNode('title'); title.textContent = 'Configured action ' + id + '. Completed to ' + destination(action.onSuccess) + '. Failed to ' + destination(action.onFailure) + '.';
      group.append(title, wrappedSvgText(actionLabel(workflow.actions[id]!.uses), position.x, 0, '', narrow ? 23 : 36)); chart.append(group);
    }
    for (const [target, { x, y, label }] of external) {
      const group = svgNode('g', { class: 'flow-end', 'data-flow-terminal': target }); group.append(wrappedSvgText(label, x, y, '', narrow ? 16 : 27)); chart.append(group);
    }
    if (highlightedTarget) chart.querySelector<SVGElement>(`[data-target="${CSS.escape(highlightedTarget)}"]`)?.classList.add('agent-target');
  };
  draw(900);
  let renderedWidth = 900;
  const observer = new ResizeObserver(entries => {
    const nextWidth = Math.round(entries[0]!.contentRect.width);
    if (chart.isConnected && nextWidth > 0 && nextWidth !== renderedWidth) { renderedWidth = nextWidth; draw(nextWidth); }
  });
  observer.observe(chart); graphObservers.add(observer);
  return chart;
}
function actionPresentation(start: string, workflow: Workflow, expanded: Set<string>, claimed: Set<string>): HTMLElement {
  const startAction = workflow.actions[start]!;
  if (expanded.has(start)) {
    const reference = node('div', '', 'simple-action action-reference');
    reference.append(configuredActionName(start, workflow, 'simple-action-name'), node('small', 'Shown above', 'flow-reference'));
    return reference;
  }
  const ids = reachableActions(start, workflow, expanded);
  const complex = ids.some(id => {
    const action = workflow.actions[id]!;
    return !!workflow.actions[action.onSuccess] || !!workflow.actions[action.onFailure];
  });
  if (!complex && startAction.uses.startsWith('control.')) {
    const line = node('div', '', 'simple-action');
    assignActionTarget(line, start, claimed);
    const simpleDestination = (target: string): string => (workflow.actions[target] ? actionLabel(workflow.actions[target]!.uses) : continuationLabels[target] ?? target) + ' (' + target + ')';
    line.title = 'Action ' + start + '; contract ' + startAction.uses + '; completed to ' + simpleDestination(startAction.onSuccess) + '; failed to ' + simpleDestination(startAction.onFailure) + '.';
    line.append(configuredActionName(start, workflow, 'simple-action-name'));
    if (startAction.onSuccess !== '$closed') line.append(node('span', '→', 'simple-arrow'), node('span', continuationLabels[startAction.onSuccess] ?? startAction.onSuccess));
    if (startAction.onFailure !== '$blocked' && startAction.onFailure !== startAction.onSuccess) line.append(node('small', 'Failed → ' + (continuationLabels[startAction.onFailure] ?? startAction.onFailure), 'simple-failure'));
    expanded.add(start);
    return line;
  }
  const box = node('div', '', 'flow-box');
  const heading = node('div', '', 'flow-title'), title = node('h2');
  title.append(configuredActionName(start, workflow)); heading.append(title, pathHelp(ids, workflow)); box.append(heading);
  const chart = actionFlowchart(ids, workflow, claimed, start);
  for (const id of ids) expanded.add(id);
  box.append(chart);
  return box;
}
function renderWorkflow(): void {
  const workflow = state?.workflow;
  if (!workflow) return;
  graphObservers.forEach(observer => observer.disconnect()); graphObservers.clear();
  const expanded = new Set<string>(), claimed = new Set<string>();
  const decisions = workflow.rules.map((rule, index) => {
    const item = node('li', '', 'decision-row'); item.dataset.target = 'rule:' + rule.id;
    const question = node('div', '', 'decision-question');
    question.append(node('span', String(index + 1), 'decision-order'), node('span', conditionText(rule.when), 'decision-text'), conditionHelp(rule.when));
    item.append(question, node('div', 'Yes →', 'decision-arrow'), actionPresentation(rule.action, workflow, expanded, claimed));
    return item;
  });
  const fallback = node('li', '', 'decision-row fallback-row');
  fallback.append(node('div', 'No earlier decision matched', 'decision-question'), node('div', 'Then →', 'decision-arrow'), actionPresentation(workflow.otherwise, workflow, expanded, claimed));
  decisions.push(fallback);
  const map = element('decision-map'); map.replaceChildren(...decisions);
  const unreferenced = Object.keys(workflow.actions).filter(id => !expanded.has(id));
  if (unreferenced.length) {
    const area = node('li', '', 'unreferenced-actions');
    area.append(node('h2', 'Other configured actions'), node('p', 'No decision currently leads to these actions.', 'secondary'));
    for (const id of unreferenced) area.append(actionPresentation(id, workflow, expanded, claimed));
    map.append(area);
  }
  element('settings').replaceChildren(detailList([
    ['New PR delay', workflow.settings.newPrDelaySeconds + 's'], ['Commit settling time', workflow.settings.headDebounceSeconds + 's'],
    ['Reviewer recheck', workflow.settings.reviewWaitSeconds + 's'], ['Reviewer deadline', workflow.settings.reviewDeadlineSeconds + 's'],
    ['Attempts per commit', String(workflow.limits.maxAttemptsPerHead)], ['Repairs per PR', String(workflow.limits.maxRepairsPerLifecycle)],
    ['Agent actions per run', String(workflow.limits.maxAgentActionsPerWake)], ['Attempt deadline', workflow.limits.maxAttemptSeconds + 's'],
    ['Daily cost units', String(workflow.limits.maxDailyCostUnits)], ['Merge', 'A person merges'],
  ]));
  element('files').replaceChildren(...state!.files.map(file => node('li', file.path, 'path')));
}

function actionGroup(uses: string): string {
  if (uses.startsWith('agent.resolve') || uses.startsWith('agent.address') || uses.startsWith('agent.fix')) return 'Change code';
  if (uses.startsWith('agent.') || uses.startsWith('checks.')) return 'Inspect and decide';
  if (uses.startsWith('github.')) return 'Update GitHub';
  return 'Pause and coordinate';
}
function renderCatalogues(): void {
  const groups = ['Change code', 'Inspect and decide', 'Update GitHub', 'Pause and coordinate'], actionArea = element('action-catalogue');
  actionArea.replaceChildren();
  for (const groupName of groups) {
    const group = node('section', '', 'catalogue-group'); group.append(node('h2', groupName));
    for (const [uses, definition] of Object.entries(actionRegistry).filter(([name]) => actionGroup(name) === groupName)) {
      const detail = node('details', '', 'catalogue-item'), summary = node('summary');
      summary.append(node('span', actionLabel(uses), 'catalogue-name'), node('span', actionDescriptions[uses] ?? 'Run ' + actionLabel(uses).toLowerCase() + '.', 'secondary'));
      const entries: [string, string][] = [['Contract', uses], ['Runs as', definition.execution === 'agent' ? 'Agent task' : 'Repo Chap']];
      if (actionExamples[uses]) entries.push(['Example', actionExamples[uses]!]);
      if (definition.capabilities.length) entries.push(['Needs', definition.capabilities.join(', ')]);
      if (definition.requires) entries.push(['Starts with', definition.requires]);
      if (definition.produces) entries.push(['Produces', definition.produces]);
      if (definition.result) entries.push(['Reports', definition.result]);
      if (definition.invalidates?.length) entries.push(['Replaces saved', definition.invalidates.join(', ')]);
      if (definition.consumesAgentBudget) entries.push(['Limit', 'Counts as an agent action']);
      if (definition.continuation) entries.push(['Continues', continuationLabels[definition.continuation] ?? definition.continuation]);
      detail.append(summary, detailList(entries)); group.append(detail);
    }
    actionArea.append(group);
  }
  const conditionArea = element('condition-catalogue'); conditionArea.replaceChildren();
  for (const [heading, fields] of [['Pull request and GitHub', Object.keys(factTypes).map(field => 'facts.' + field)], ['Saved progress', memoryFields.map(field => 'memory.' + field)]] as [string, string[]][]) {
    const group = node('section', '', 'catalogue-group'); group.append(node('h2', heading));
    for (const field of fields) {
      const definition = fieldLabels[field]!, detail = node('details', '', 'catalogue-item'), summary = node('summary');
      summary.append(node('span', definition.name, 'catalogue-name'), node('span', definition.explanation, 'secondary'));
      const entries: [string, string][] = [['Contract', field], ['Can ask', definition.yes + '; ' + definition.no]];
      if (conditionExamples[field]) entries.push(['Example', conditionExamples[field]!]);
      detail.append(summary, detailList(entries)); group.append(detail);
    }
    if (heading === 'Pull request and GitHub') {
      const detail = node('details', '', 'catalogue-item'), summary = node('summary');
      summary.append(node('span', 'Combine conditions', 'catalogue-name'), node('span', 'Require every condition, accept any condition, or reverse one condition.', 'secondary'));
      detail.append(summary, detailList([['Groups', 'all, any, not'], ['Comparisons', 'eq, ne']])); group.append(detail);
    }
    conditionArea.append(group);
  }
}
renderCatalogues();

function traceItem(trace: ConditionTrace): HTMLElement {
  const item = node('li', trace.value + ': ' + trace.reason);
  if (trace.children) { const list = node('ul'); list.append(...trace.children.map(traceItem)); item.append(list); }
  return item;
}
function renderSimulation(): void {
  if (!state) return;
  const input = state.input;
  element('tests-mode').setAttribute('aria-pressed', String(state.mode === 'tests'));
  element('pr-mode').setAttribute('aria-pressed', String(state.mode === 'pr'));
  element('choose-input').textContent = state.mode === 'tests' ? 'Choose fixture' : 'Choose capture';
  element('input-summary').textContent = input?.capture ? input.capture.repository + ' #' + input.capture.pr + ' · ' + input.capture.title : input?.path.split('/').at(-1) ?? (state.mode === 'tests' ? 'Choose a test fixture to try this workflow.' : 'Choose a PR capture made by your agent.');
  element('input-note').textContent = state.mode === 'tests' ? 'Saved facts, stubbed action results, and a fixed clock.' : input?.capture
    ? 'Captured ' + input.fixture!.now + ' · ' + input.capture.status + ' evidence · Head ' + (input.capture.headSha?.slice(0, 12) ?? 'unknown') + '. Current GitHub state has not been checked.' + (input.capture.packageDigest !== state.packageDigest ? ' This capture was made with an earlier workflow.' : '')
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
  if (!state.simulationCurrent) area.append(node('p', 'Files changed. Run the test again with the current workflow and input.', 'notice'));
  const title = simulation.comparison ? 'Test ' + (simulation.comparison.passed ? 'passed' : 'failed') : 'Test ' + result.status.replaceAll('_', ' ');
  area.append(node('h2', state.simulationCurrent ? title : 'Previous ' + title.toLowerCase()), node('p', result.reason));
  if (result.nextWakeAt) area.append(node('p', 'Next wake ' + result.nextWakeAt, 'secondary'));
  if (simulation.comparison) {
    const table = node('table'); table.setAttribute('aria-label', 'Expected and actual outcomes');
    const header = node('thead'), row = node('tr');
    for (const heading of ['Check', 'Expected', 'Actual', 'Result']) row.append(node('th', heading));
    header.append(row); table.append(header);
    const body = node('tbody');
    for (const check of simulation.comparison.checks) {
      const resultCell = node('td', check.passed ? 'Pass' : 'Fail', check.passed ? 'success' : 'danger'), bodyRow = node('tr');
      bodyRow.append(node('td', check.field), node('td', JSON.stringify(check.expected)), node('td', JSON.stringify(check.actual)), resultCell); body.append(bodyRow);
    }
    table.append(body); area.append(table);
  }
  area.append(node('h3', 'What would happen'));
  const trace = node('ol', '', 'trace');
  for (const decision of result.decisions) {
    const item = node('li', (decision.ruleId ?? 'Otherwise') + ' → ' + decision.actionId), detail = node('details');
    detail.append(node('summary', 'Why this rule'));
    const rules = node('ul');
    for (const rule of decision.rules) {
      const reason = node('li', rule.id + (rule.selected ? ' · selected' : '')), conditions = node('ul');
      conditions.append(traceItem(rule.condition)); reason.append(conditions); rules.append(reason);
    }
    detail.append(rules); item.append(detail); trace.append(item);
  }
  area.append(trace);
  if (result.actions.length) {
    const actions = node('ul', '', 'effects');
    for (const action of result.actions) actions.append(node('li', action.actionId + ' · ' + action.status + '. ' + action.reason));
    area.append(actions);
  }
  if (result.proposedEffects.length) {
    area.append(node('h3', 'Proposed effects'));
    const effects = node('ul', '', 'effects');
    for (const effect of result.proposedEffects) effects.append(node('li', actionLabel(effect.uses) + (effect.outcome ? ' · ' + effect.outcome : '') + '. ' + effect.reason));
    area.append(effects);
  }
  if (simulation.previewError) area.append(node('p', 'Slack preview: ' + simulation.previewError, 'notice'));
  for (const handoff of simulation.handoffs) area.append(node('h3', 'Slack preview'), node('p', handoff.preview.route.explanation), node('pre', handoff.preview.message.text));
  const record = node('details'); record.append(node('summary', 'Test record'), node('pre', JSON.stringify(simulation, null, 2))); area.append(record);
}

function targetElement(target: string): Element | undefined { return [...document.querySelectorAll<HTMLElement | SVGElement>('[data-target]')].find(item => item.dataset.target === target); }
function guidanceAnchor(target: Element): Element {
  return target instanceof HTMLDetailsElement ? target.querySelector('summary')! : target instanceof HTMLElement && target.offsetHeight > innerHeight * .6 ? target.querySelector<HTMLElement>('h1,h2,h3') ?? target : target;
}
function clearGuidance(): void {
  document.querySelectorAll('.agent-target').forEach(item => item.classList.remove('agent-target'));
  element('guidance').hidden = true; document.getElementById('guidance-arrow')!.setAttribute('hidden', ''); activeGuidance = null;
}
function renderGuidance(guidance: CompanionState['guidance']): void {
  const fresh = guidance?.id !== guidanceId;
  clearGuidance();
  if (!guidance || guidance.expiresAt <= Date.now() || guidance.id === dismissedGuidanceId) { guidanceId = ''; return; }
  const target = targetElement(guidance.target);
  if (!target) return;
  activeGuidance = guidance; guidanceId = guidance.id;
  if (target instanceof HTMLDetailsElement) target.open = true;
  else {
    const actionDetail = target.querySelector<HTMLDetailsElement>('.action-help') ?? target.closest('.flow-box')?.querySelector<HTMLDetailsElement>('.action-help');
    if (actionDetail) actionDetail.open = true;
  }
  for (let parent = target.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
  target.classList.add('agent-target');
  if (fresh) {
    const anchor = guidanceAnchor(target); anchor.setAttribute('tabindex', '-1');
    anchor.scrollIntoView({ block: 'center', behavior: 'instant' }); (anchor as HTMLElement | SVGElement).focus({ preventScroll: true });
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
  bubble.style.left = left + 'px'; bubble.style.top = top + 'px';
  const arrow = document.getElementById('guidance-arrow')!;
  if (activeGuidance.style === 'arrow') {
    arrow.removeAttribute('hidden');
    const x = Math.max(24, Math.min(innerWidth - 24, rect.left + Math.min(rect.width / 2, 100)));
    document.getElementById('arrow-line')!.setAttribute('d', 'M ' + (left + Math.min(bubble.offsetWidth / 2, 100)) + ' ' + (below ? top : top + bubble.offsetHeight) + ' L ' + x + ' ' + (below ? rect.bottom + 10 : rect.top - 10));
  }
}
window.addEventListener('resize', positionGuidance); window.addEventListener('scroll', positionGuidance, true);
setInterval(() => { if (activeGuidance && activeGuidance.expiresAt <= Date.now()) clearGuidance(); }, 250);
void bridge.current().then(render).catch(error => { element('error').textContent = error instanceof Error ? error.message : 'The desktop could not start.'; element('error').hidden = false; });
bridge.onChange(render);
