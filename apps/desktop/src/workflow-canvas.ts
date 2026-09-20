import { layoutCanvas } from './canvas-layout.js';
import type { Workflow, Condition } from '@repo-chap/workflow';

type Labels = { action: (uses: string) => string; condition: (condition: Condition) => string; conditionTree: (condition: Condition) => HTMLElement };
type ViewNode = { id: string; title: string; subtitle: string; members: string[]; kind: string };
type Connection = { from: string; to: string; label: string; failure: boolean };
const sections: Record<string, string> = { pause: 'Pause or finish', repair: 'Repair code', publish: 'Check and push', review: 'Classify and review' };
const endings: Record<string, [string, string]> = {
  $observe: ['Reinspect PR', 'Continue with updated PR details'],
  $wait: ['Wait for an update', 'Reinspect when work resumes'],
  $closed: ['Finished', 'This workflow has ended'],
  $blocked: ['Needs attention', 'Execution cannot continue'],
};
const html = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => {
  const item = document.createElement(tag); item.textContent = text; item.className = className; return item;
};
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}) => {
  const item = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, value);
  return item;
};
function section(uses: string): string | undefined {
  if (uses.startsWith('control.')) return 'pause';
  if (['agent.resolve_conflict', 'agent.address_review', 'agent.fix_ci'].includes(uses)) return 'repair';
  if (['checks.validate_candidate', 'github.push_candidate', 'github.resolve_eligible_threads'].includes(uses)) return 'publish';
  if (['agent.classify', 'agent.review'].includes(uses)) return 'review';
  return undefined;
}

export interface WorkflowCanvas {
  dispose(): void;
  reveal(target: string): Promise<void>;
}

export function mountWorkflowCanvas(host: HTMLElement, workflow: Workflow, labels: Labels): WorkflowCanvas {
  const expanded = new Set<string>();
  const groups = new Map<string, string[]>();
  for (const [id, action] of Object.entries(workflow.actions)) {
    const key = section(action.uses);
    if (key) groups.set(key, [...groups.get(key) ?? [], id]);
  }
  let scale = 1, offsetX = 30, offsetY = 30, graphWidth = 1, graphHeight = 1;
  let selected: string | undefined;
  let generation = 0, disposed = false;
  const shell = html('div', '', 'canvas-shell');
  const toolbar = html('div', '', 'canvas-toolbar');
  const heading = html('div'); heading.append(html('strong', workflow.id), html('span', 'Configured workflow', 'secondary'));
  const controls = html('div', '', 'canvas-controls');
  const reportError = (error: unknown) => { if (!disposed) { footer.textContent = 'Map could not be laid out: ' + String(error); footer.setAttribute('role', 'alert'); } };
  const button = (label: string, fn: () => void | Promise<void>) => {
    const b = html('button', label); b.type = 'button';
    b.onclick = () => { void Promise.resolve().then(fn).catch(reportError); };
    return b;
  };
  const zoomValue = html('span', '100%', 'canvas-zoom');
  const viewport = html('div', '', 'canvas-viewport'); viewport.tabIndex = 0;
  viewport.setAttribute('aria-label', 'Workflow map. Drag or scroll to pan. Use plus and minus to zoom.');
  const world = html('div', '', 'canvas-world'); viewport.append(world);
  const inspector = html('aside', '', 'canvas-inspector'); inspector.hidden = true;
  inspector.setAttribute('aria-label', 'Selected workflow step');
  const workspace = html('div', '', 'canvas-workspace'); workspace.append(viewport, inspector);
  const footer = html('div', '', 'canvas-footer');
  footer.append(html('span', 'Drag or scroll to explore · Select a section to inspect or expand'), html('span', 'Solid: completed / entry   ·   Dashed: failed'));
  toolbar.append(heading, controls); shell.append(toolbar, workspace, footer); host.replaceChildren(shell);
  const transform = () => { world.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`; zoomValue.textContent = Math.round(scale * 100) + '%'; window.dispatchEvent(new Event('workflow-canvas-moved')); };
  const fit = () => {
    const rect = viewport.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    scale = Math.min(1, (rect.width - 64) / graphWidth, (rect.height - 64) / graphHeight);
    offsetX = (rect.width - graphWidth * scale) / 2; offsetY = (rect.height - graphHeight * scale) / 2; transform();
  };
  const zoom = (factor: number, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) => {
    const next = Math.max(.25, Math.min(1.8, scale * factor));
    offsetX = x - (x - offsetX) * next / scale; offsetY = y - (y - offsetY) * next / scale; scale = next; transform();
  };
  controls.append(button('−', () => zoom(1 / 1.2)), zoomValue, button('+', () => zoom(1.2)), button('Show whole workflow', fit), button('Collapse sections', async () => { expanded.clear(); inspector.hidden = true; selected = undefined; await render(); fit(); }));
  controls.children[0]!.setAttribute('aria-label', 'Zoom out'); controls.children[2]!.setAttribute('aria-label', 'Zoom in');
  const represent = (id: string) => {
    const group = workflow.actions[id] && section(workflow.actions[id]!.uses);
    return group && (groups.get(group)?.length ?? 0) > 1 && !expanded.has(group) ? 'group:' + group : workflow.actions[id] ? 'action:' + id : id;
  };
  const display = (id: string) => {
    const action = workflow.actions[id];
    if (!action) return endings[id]?.[0] ?? id;
    const repeated = Object.values(workflow.actions).filter(other => other.uses === action.uses).length > 1;
    return labels.action(action.uses) + (repeated ? ' · ' + id : '');
  };
  let positions = new Map<string, { x: number; y: number }>();
  const focus = (id: string) => {
    const position = positions.get(id); if (!position) return;
    scale = Math.max(scale, .95); offsetX = viewport.clientWidth * .4 - position.x * scale; offsetY = viewport.clientHeight / 2 - position.y * scale; transform();
  };
  function inspect(item: ViewNode): void {
    selected = item.id;
    world.querySelectorAll<HTMLElement>('.canvas-node').forEach(node => node.classList.toggle('selected', node.dataset.id === selected));
    world.querySelectorAll<SVGElement>('[data-from]').forEach(edge => {
      edge.classList.toggle('connected', edge.dataset.from === selected || edge.dataset.to === selected);
    });
    inspector.hidden = false;
    const close = button('×', () => { inspector.hidden = true; selected = undefined; world.querySelectorAll('.selected,.connected').forEach(node => node.classList.remove('selected', 'connected')); });
    close.className = 'canvas-inspector-close'; close.setAttribute('aria-label', 'Close step details');
    inspector.replaceChildren(close, html('h2', item.title));
    if (item.id.startsWith('group:')) {
      const group = item.id.slice(6);
      inspector.append(html('p', 'A visual grouping of the configured actions. Select an action to see its connections.', 'secondary'));
      inspector.append(button('Expand section', async () => { expanded.add(group); inspector.hidden = true; await render(); focus(represent(item.members[0]!)); }));
    }
    if (item.id === '$entry') {
      inspector.append(html('p', 'Each observation checks the conditions below in their configured order. The first match determines the work. False or unknown conditions continue to the next check.'));
      for (const [index, rule] of workflow.rules.entries()) {
        const detail = html('details'); detail.dataset.target = 'rule:' + rule.id;
        detail.append(html('summary', `${index + 1}. ${labels.condition(rule.when)}`), labels.conditionTree(rule.when), button('Follow → ' + display(rule.action), () => { const id = represent(rule.action); const target = nodes.find(node => node.id === id); if (target) { inspect(target); focus(id); } }));
        inspector.append(detail);
      }
      inspector.append(html('p', 'If none match: ' + display(workflow.otherwise)));
    }
    for (const id of item.members) {
      const action = workflow.actions[id]!;
      const part = html('section', '', 'canvas-action-detail');
      part.append(html('h3', display(id)));
      if (workflow.rules.length && workflow.rules[0]!.action !== id) part.append(html('p', 'Entry conditions apply only when no earlier condition matches.', 'secondary'));
      const rules = workflow.rules.filter(rule => rule.action === id);
      for (const rule of rules) {
        const detail = html('details'); detail.dataset.target = 'rule:' + rule.id;
        detail.append(html('summary', 'When ' + labels.condition(rule.when)), labels.conditionTree(rule.when)); part.append(detail);
      }
      if (workflow.otherwise === id) part.append(html('p', 'Also used when no condition matches.', 'secondary'));
      if (!rules.length && workflow.otherwise !== id) {
        const incoming = Object.values(workflow.actions).some(other => other.onSuccess === id || other.onFailure === id);
        part.append(html('p', incoming ? 'Reached from a previous action.' : 'No configured condition or action leads here.', 'secondary'));
      }
      for (const [label, target] of [['Completed', action.onSuccess], ['Failed', action.onFailure]]) {
        part.append(button(label + ' → ' + display(target!), () => {
          const targetId = represent(target!); const targetNode = nodes.find(candidate => candidate.id === targetId);
          if (targetNode) { inspect(targetNode); focus(targetId); }
        }));
      }
      if (item.id.startsWith('group:')) part.append(button('Show this action', async () => { expanded.add(item.id.slice(6)); await render(); const target = nodes.find(node => node.id === represent(id)); if (target) { inspect(target); focus(represent(id)); } }));
      const technical = html('details'); technical.className = 'canvas-configuration'; technical.append(html('summary', 'Instructions and configuration'));
      const dl = html('dl');
      for (const [name, value] of [['Action', id], ['Contract', action.uses], ['Prompt', action.prompt], ['Context', action.contextFiles?.join(', ')], ['Access', action.capabilities.join(', ')]]) {
        if (value) dl.append(html('dt', name), html('dd', value));
      }
      technical.append(dl); part.append(technical); inspector.append(part);
    }
    if (item.id === '$observe' || item.id === '$wait') {
      inspector.append(html('p', item.id === '$observe' ? 'Read the PR again and reconsider the configured conditions using the updated details.' : 'The workflow pauses. On its next wake, it reads the PR again before choosing further work.'));
      inspector.append(button('Return to PR conditions', () => { inspect(nodes.find(node => node.id === '$entry')!); focus('$entry'); }));
    }
    if (item.id === '$blocked') inspector.append(html('p', 'Execution stopped with a problem. This is a configured outcome, not a report of a live failure.'));
    inspector.scrollTop = 0;
    focus(item.id);
  }
  let nodes: ViewNode[] = [];
  let pendingLayout: Promise<void> = Promise.resolve();
  function render(): Promise<void> { pendingLayout = draw(); return pendingLayout; }
  async function draw(): Promise<void> {
    const version = ++generation;
    nodes = [{ id: '$entry', title: 'Inspect the pull request', subtitle: 'Conditions determine the next work', members: [], kind: 'entry' }];
    const seen = new Set<string>();
    for (const [id, action] of Object.entries(workflow.actions)) {
      const key = represent(id); if (seen.has(key)) continue; seen.add(key);
      const members = key.startsWith('group:') ? groups.get(key.slice(6))! : [id];
      const rules = workflow.rules.filter(rule => members.includes(rule.action));
      const subtitle = key.startsWith('group:') ? members.map(member => labels.action(workflow.actions[member]!.uses)).join(' · ') : rules.length === 1 ? labels.condition(rules[0]!.when) : rules.length ? rules.length + ' entry conditions' : action.uses.startsWith('human.') ? 'Request a decision from a person' : 'Continues from the previous step';
      nodes.push({ id: key, title: key.startsWith('group:') ? sections[key.slice(6)]! : display(id), subtitle, members, kind: key.startsWith('group:') ? 'group' : 'action' });
    }
    const edges: Connection[] = [], edgeKeys = new Set<string>();
    const add = (from: string, to: string, label: string, failure = false) => {
      const source = represent(from), target = represent(to);
      if (source === target && source.startsWith('group:')) return;
      const key = source + '|' + target + '|' + failure;
      if (edgeKeys.has(key)) return; edgeKeys.add(key); edges.push({ from: source, to: target, label, failure });
    };
    for (const rule of workflow.rules) add('$entry', rule.action, 'When needed');
    add('$entry', workflow.otherwise, 'Otherwise');
    for (const [id, action] of Object.entries(workflow.actions)) {
      add(id, action.onSuccess, action.uses === 'checks.validate_candidate' ? 'Passed' : 'Completed');
      add(id, action.onFailure, 'Failed', true);
    }
    for (const id of new Set(edges.map(edge => edge.to).filter(id => id.startsWith('$')))) nodes.push({ id, title: display(id), subtitle: endings[id]?.[1] ?? '', members: [], kind: 'ending' });
    const graph = await layoutCanvas(nodes.map(item => ({ id: item.id, width: 224, height: item.kind === 'ending' ? 104 : 146 })), edges);
    if (disposed || version !== generation) return;
    world.replaceChildren();
    graphWidth = graph.width; graphHeight = graph.height;
    world.style.width = graphWidth + 'px'; world.style.height = graphHeight + 'px';
    const drawing = svg('svg', { width: String(graphWidth), height: String(graphHeight), class: 'canvas-connections', 'aria-hidden': 'true' });
    const defs = svg('defs');
    for (const [name, color] of [['normal', '#66574D'], ['failed', '#8F3A2D']]) {
      const marker = svg('marker', { id: 'canvas-arrow-' + name, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' }); marker.append(svg('path', { d: 'M 0 1 L 9 5 L 0 9', fill: 'none', stroke: color! })); defs.append(marker);
    }
    drawing.append(defs);
    edges.forEach((edge, index) => {
      const geometry = graph.edges[index]!;
      const path = svg('path', { d: geometry.points.map((point: { x: number; y: number }, i: number) => `${i ? 'L' : 'M'} ${point.x} ${point.y}`).join(' '), class: edge.failure ? 'canvas-edge failed' : 'canvas-edge', 'marker-end': 'url(#canvas-arrow-' + (edge.failure ? 'failed' : 'normal') + ')', 'data-from': edge.from, 'data-to': edge.to, 'data-edge-target': edge.to.startsWith('action:') ? edge.to.slice(7) : edge.to, 'data-edge-loop': String(edge.from === edge.to) });
      const title = svg('title'); title.textContent = edge.label + ' → ' + (nodes.find(item => item.id === edge.to)?.title ?? edge.to); path.append(title); drawing.append(path);
      const text = svg('text', { x: String(geometry.labelX), y: String(geometry.labelY), class: edge.failure ? 'canvas-edge-label failed' : 'canvas-edge-label', 'text-anchor': 'middle' }); text.textContent = edge.label; drawing.append(text);
    });
    world.append(drawing); positions = new Map();
    for (const item of nodes) {
      const position = graph.nodes.get(item.id)!; positions.set(item.id, position);
      const card = button('', () => inspect(item)); card.className = 'canvas-node ' + item.kind; card.dataset.id = item.id;
      card.style.left = position.x - position.width / 2 + 'px'; card.style.top = position.y - position.height / 2 + 'px'; card.style.width = position.width + 'px'; card.style.height = position.height + 'px';
      if (item.kind === 'action') card.dataset.target = item.id;
      if (item.kind === 'entry') card.dataset.target = 'rules';
      card.append(html('strong', item.title), html('span', item.subtitle, 'canvas-node-description'));
      if (item.kind === 'group') card.append(html('span', item.members.length + ' actions · Expand ↗', 'canvas-node-count'));
      card.addEventListener('focus', () => { if (!disposed && document.activeElement === card && card.matches(':focus-visible')) focus(item.id); });
      card.ondblclick = () => { if (item.kind === 'group') { expanded.add(item.id.slice(6)); inspector.hidden = true; void render().then(() => focus(represent(item.members[0]!))).catch(reportError); } };
      world.append(card);
    }
  }
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) { const rect = viewport.getBoundingClientRect(); zoom(Math.exp(-event.deltaY * .008), event.clientX - rect.left, event.clientY - rect.top); }
    else { offsetX -= event.deltaX || (event.shiftKey ? event.deltaY : 0); offsetY -= event.shiftKey ? 0 : event.deltaY; transform(); }
  };
  viewport.addEventListener('wheel', wheel, { passive: false });
  let suppressClick = false;
  viewport.addEventListener('click', event => { if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; } }, true);
  let drag: { x: number; y: number; startX: number; startY: number; moved: boolean } | undefined;
  viewport.onpointerdown = event => {
    if (event.button !== 0) return;
    suppressClick = false;
    drag = { x: event.clientX, y: event.clientY, startX: offsetX, startY: offsetY, moved: false };
    if (!(event.target as Element).closest('button')) viewport.setPointerCapture(event.pointerId);
  };
  viewport.onpointermove = event => {
    if (!drag) return;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 5) { drag.moved = true; viewport.setPointerCapture(event.pointerId); }
    if (drag.moved) { offsetX = drag.startX + event.clientX - drag.x; offsetY = drag.startY + event.clientY - drag.y; transform(); }
  };
  viewport.onpointerup = () => { suppressClick = drag?.moved ?? false; drag = undefined; };
  viewport.onpointercancel = () => { drag = undefined; };
  viewport.onkeydown = event => {
    if ((event.target as Element).closest('button')) return;
    if (event.key === '+' || event.key === '=') zoom(1.2);
    else if (event.key === '-') zoom(1 / 1.2);
    else if (event.key === '0') fit();
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { offsetX += event.key === 'ArrowLeft' ? 70 : event.key === 'ArrowRight' ? -70 : 0; offsetY += event.key === 'ArrowUp' ? 70 : event.key === 'ArrowDown' ? -70 : 0; transform(); }
    else return;
    event.preventDefault();
  };
  let fitted = false;
  void render().then(() => {
    if (disposed) return;
    if (selected) return;
    scale = .95; offsetX = 32; offsetY = Math.max(24, (viewport.clientHeight - graphHeight * scale) / 2); transform(); fitted = viewport.clientWidth > 0;
  }).catch(reportError);
  const observer = new ResizeObserver(() => {
    if (!fitted && graphWidth > 1 && viewport.clientWidth) {
      scale = .95; offsetX = 32; offsetY = Math.max(24, (viewport.clientHeight - graphHeight * scale) / 2); transform(); fitted = true;
    }
  }); observer.observe(viewport);
  return {
    dispose() { disposed = true; generation++; observer.disconnect(); },
    async reveal(target) {
      await pendingLayout;
      if (disposed) return;
      if (target.startsWith('action:')) {
        const id = target.slice(7), action = workflow.actions[id];
        if (!action) return;
        const group = section(action.uses);
        if (group && !expanded.has(group)) { expanded.add(group); await render(); }
        if (disposed) return;
        const item = nodes.find(node => node.id === represent(id));
        if (item) {
          inspect(item);
          const detail = inspector.querySelector<HTMLDetailsElement>('.canvas-configuration');
          if (detail) detail.open = true;
        }
      } else if (target === 'rules' || target.startsWith('rule:')) {
        inspect(nodes.find(node => node.id === '$entry')!);
        if (target.startsWith('rule:')) {
          const detail = [...inspector.querySelectorAll<HTMLDetailsElement>('[data-target]')].find(item => item.dataset.target === target);
          if (detail) { detail.open = true; detail.scrollIntoView({ block: 'nearest' }); }
        }
      }
    },
  };
}
