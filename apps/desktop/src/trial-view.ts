import type { DocumentSnapshot, EditorResult } from './protocol.js';
import type { TrialBridge, TrialProfile, TrialRecord, TrialResult, TrialSelection, TrialSnapshot } from './trial-protocol.js';

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] => { const value = document.createElement(tag); value.textContent = text; value.className = className; return value; };
export function trialView(bridge: TrialBridge, perform: (operation: () => Promise<EditorResult>) => Promise<boolean>, getDocument: () => DocumentSnapshot | null): {
  render(document: DocumentSnapshot, locked: boolean, pendingInput: boolean): void;
  running(): boolean;
} {
  let current: TrialSnapshot | null = null, documentId = '', profilesKey = '', resultKey = '', proposalKey = '';
  let locked = false, busy = false, pending = false, sourceRepository = '', selectedId = '', localChanged = false;
  const repository = element<HTMLInputElement>('trial-repository'), pr = element<HTMLInputElement>('trial-pr'), profile = element<HTMLSelectElement>('trial-profile');
  const error = (text = ''): void => { element('trial-error').textContent = text; element('trial-error').hidden = !text; };
  const selection = (): TrialSelection => ({ repository: repository.value.trim(), pr: Number(pr.value), profile: profile.value, sourceRepository });
  const profileDigest = (): string => profile.selectedOptions[0]?.dataset.digest ?? '';
  function accept(snapshot: TrialSnapshot | null): void {
    if (snapshot && (snapshot.documentSessionId !== getDocument()?.sessionId || current && snapshot.revision < current.revision)) return;
    current = snapshot;
    if (!snapshot?.proposal) proposalKey = '';
    if (snapshot?.proposal && JSON.stringify(snapshot.proposal) !== proposalKey) {
      proposalKey = JSON.stringify(snapshot.proposal);
      const proposal = snapshot.proposal;
      repository.value = proposal.selection.repository; pr.value = String(proposal.selection.pr); profile.value = proposal.selection.profile; sourceRepository = proposal.selection.sourceRepository;
      localChanged = false;
    }
    renderState();
  }
  function updateProfiles(profiles: TrialProfile[]): void {
    const key = JSON.stringify(profiles);
    if (key !== profilesKey) {
      const previous = profile.value, previousDigest = profileDigest();
      profile.replaceChildren(node('option', 'Choose a provider profile')); profile.options[0]!.value = '';
      for (const item of profiles) { const option = node('option', `${item.name} · ${item.provider === 'codex' ? 'Codex' : 'Claude'} · ${item.model}${item.effort ? ` · ${item.effort}` : ''}`); option.value = item.name; option.dataset.digest = item.digest; profile.append(option); }
      profile.value = profiles.some(item => item.name === previous) ? previous : ''; profilesKey = key;
      if (previousDigest && previousDigest !== profileDigest()) { localChanged = true; error('Provider settings changed. Review the displayed provider and model, then press Start again.'); }
    }
  }
  function receive(result: TrialResult): boolean {
    updateProfiles(result.profiles);
    accept(result.trial); if (result.error) error(result.error);
    return !result.error && !result.cancelled;
  }
  async function action(operation: () => Promise<TrialResult>): Promise<void> {
    if (busy) return;
    busy = true; error(); renderState();
    try { receive(await operation()); } catch { error('The trial operation could not finish. Your drafts have been kept.'); }
    finally { busy = false; renderState(); }
  }
  function changed(): void {
    localChanged = true; renderState();
    if (current) void bridge.invalidate(current.documentSessionId).then(receive).catch(() => error('The trial could not confirm cancellation. Use Cancel trial.'));
  }
  repository.oninput = changed; pr.oninput = changed; profile.onchange = changed;
  element('trial-load-profiles').onclick = () => { void action(() => bridge.loadProfiles()); };
  element('trial-source').onclick = () => { if (getDocument()) void action(async () => { const result = await bridge.chooseSource(getDocument()!.sessionId); if (result.sourceRepository) { sourceRepository = result.sourceRepository; localChanged = true; } return result; }); };
  for (const kind of ['prepare', 'start'] as const) element(`trial-${kind}`).onclick = () => {
    if (locked || busy) return;
    void (async () => {
      error();
      await perform(async () => {
        const document = getDocument()!, chosen = selection();
        const result = await bridge[kind]({ sessionId: document.sessionId, revision: document.revision }, chosen, profileDigest());
        if (receive(result) && kind === 'start') { selectedId = result.trial?.activeId ?? ''; localChanged = false; resultKey = ''; renderState(); }
        return result;
      });
    })().catch(() => error('The current input could not be captured. Correct it before starting a trial.'));
  };
  element('trial-cancel').onclick = () => { if (current?.activeId || current?.refreshingId) { const { documentSessionId } = current; const id = current.activeId ?? current.refreshingId!; void bridge.cancel(documentSessionId, id).then(receive).catch(() => error('Cancellation could not be confirmed. Try Cancel trial again.')); } };
  element<HTMLSelectElement>('trial-history').onchange = event => { selectedId = (event.target as HTMLSelectElement).value; resultKey = ''; renderState(); };
  element('trial-refresh').onclick = () => { if (current && selectedId) void action(() => bridge.refresh(current!.documentSessionId, selectedId)); };
  element('trial-export').onclick = () => { if (current && selectedId) void action(async () => { const result = await bridge.exportFixture(current!.documentSessionId, selectedId) as TrialResult & { exportedDirectory?: string }; if (result.exportedDirectory) { element('trial-exported').textContent = `Offline fixture and provenance saved in ${result.exportedDirectory}`; element('trial-exported').hidden = false; } return result; }); };
  bridge.onChange(accept);
  bridge.onProfilesChange(profiles => { updateProfiles(profiles); renderState(); });

  function resultContent(record: TrialRecord): HTMLElement[] {
    const currentInputs = current?.currentIds.includes(record.id) && !localChanged && !pending && JSON.stringify(selection()) === JSON.stringify(record.selection);
    const status = node('p', record.status === 'running' ? record.diagnostic : `${record.status === 'completed' ? 'Analysis completed' : `Trial ${record.status}`} · ${record.analysis?.decision.replaceAll('_', ' ') ?? 'No complete analysis'}`, 'trial-outcome');
    const freshness = node('p', currentInputs ? 'Matches the selected draft and evidence at the last GitHub check.' : 'Stale or unverified for the current selection. Start again to analyze the current inputs.', currentInputs ? 'success' : 'notice');
    const diagnostic = node('p', record.diagnostic);
    const identity = node('dl', '', 'trial-provenance');
    for (const [label, value] of [
      ['Target', `${record.selection.repository} #${record.selection.pr}`], ['Provider', `${record.provider.provider} · ${record.provider.name} · ${record.provider.model}${record.provider.effort ? ` · ${record.provider.effort}` : ''}`],
      ['Tested document', `Revision ${record.document.revision} · ${record.document.sessionId}`], ['Tested package', record.packageDigest], ['Tested head', record.inspection?.headSha ?? 'Unavailable'], ['Target base', record.inspection?.baseSha ?? 'Unavailable'], ['Comparison base', record.analysis?.comparisonBaseSha ?? 'Unavailable'],
      ['GitHub check', record.remote.checkedAt ? `${record.remote.status} at ${record.remote.checkedAt}. Later remote changes are unknown until Refresh evidence.` : 'Not verified after analysis.'],
      ['Last observed head', record.remote.headSha ?? record.inspection?.headSha ?? 'Unavailable'], ['Private record', record.recordPath],
    ]) { identity.append(node('dt', label), node('dd', value)); }
    const findings = node('div', '', 'trial-findings');
    for (const [id, result] of Object.entries(record.analysis?.results ?? {})) {
      findings.append(node('h3', `${id} · ${result.outcome}`));
      const payload = result.payload as { summary?: string; findings?: { id: string; title: string; reason: string; severity: string; evidence: { path: string; side: string; startLine: number; endLine: number; explanation: string }[] }[]; labels?: { name: string; reason: string }[] } | undefined;
      if (payload?.summary) findings.append(node('p', payload.summary));
      if (payload?.labels) { const list = node('ul'); for (const item of payload.labels) list.append(node('li', `${item.name}: ${item.reason}`)); findings.append(list); }
      if (payload?.findings) { if (!payload.findings.length) findings.append(node('p', 'No findings recorded.')); else { const list = node('ul'); for (const item of payload.findings) { const finding = node('li', `${item.severity} · ${item.title}: ${item.reason}`); const citations = node('ul'); for (const cited of item.evidence) citations.append(node('li', `${cited.path} · ${cited.side} lines ${cited.startLine}-${cited.endLine}: ${cited.explanation}`)); finding.append(citations); list.append(finding); } findings.append(list); } }
      findings.append(node('p', result.diagnostic, 'secondary'));
      for (const attempt of result.attempts) findings.append(node('p', `Actual tokens: ${attempt.usage.actual ? `${attempt.usage.actual.inputTokens} input, ${attempt.usage.actual.outputTokens} output` : 'not reported'}. Estimated tokens: ${attempt.usage.estimated.inputTokens} input, ${attempt.usage.estimated.outputTokens} output.${attempt.usage.estimated.costUsd !== undefined ? ` Estimated cost: $${attempt.usage.estimated.costUsd}.` : ''}`, 'secondary'));
    }
    const missing = node('div');
    if (record.analysis?.missingEvidence.length || record.inspection?.status !== 'complete') {
      missing.append(node('h3', 'Missing evidence'));
      const list = node('ul'); for (const item of record.analysis?.missingEvidence ?? []) list.append(node('li', item));
      if (record.inspection?.status !== 'complete') list.append(node('li', 'GitHub collection is partial or unavailable. Empty collections do not establish absence.'));
      missing.append(list);
    }
    const details = node('details'); details.append(node('summary', 'Complete retained analysis and provenance'), node('pre', JSON.stringify(record, null, 2)));
    return [status, freshness, diagnostic, missing, findings, identity, details];
  }
  function renderState(): void {
    const document = getDocument(); if (!document) return;
    const active = current?.records.find(item => item.id === (current?.activeId ?? current?.refreshingId));
    element('trial-controls').hidden = !active;
    element('trial-progress').textContent = current?.refreshing ? 'Refreshing GitHub evidence. No provider call runs.' : active ? `${active.phase} · ${active.diagnostic}` : '';
    element<HTMLButtonElement>('trial-cancel').disabled = !active;
    element('trial-current-draft').textContent = `Current unsaved draft · revision ${document.revision} · ${document.packageDigest ?? 'Fix validation errors before Start'}`;
    element('trial-source-path').textContent = sourceRepository;
    element('trial-proposal').hidden = !current?.proposal;
    element('trial-proposal').textContent = current?.proposal ? `Prepared by ${current.proposal.preparedBy}, document revision ${current.proposal.document.revision}. Prepared only. No live call is authorized until Start.` : '';
    const disabled = locked || busy || !!current?.activeId || !!current?.refreshing;
    for (const id of ['trial-load-profiles', 'trial-source', 'trial-prepare']) element<HTMLButtonElement>(id).disabled = disabled;
    element<HTMLButtonElement>('trial-start').disabled = disabled || !profile.value || !repository.value.trim() || !pr.value || !!document.diagnostics.length || !!document.readOnlyReason;
    repository.disabled = locked || busy; pr.disabled = locked || busy; profile.disabled = locked || busy;
    const history = element<HTMLSelectElement>('trial-history');
    const records = current?.records ?? [];
    if (!records.some(record => record.id === selectedId)) selectedId = records[0]?.id ?? '';
    const historyKey = JSON.stringify(records.map(record => [record.id, record.status]));
    if (history.dataset.key !== historyKey) {
      history.replaceChildren(...records.map(record => { const option = node('option', `${record.selection.repository} #${record.selection.pr} · ${record.provider.provider} · ${record.status} · ${record.startedAt}`); option.value = record.id; return option; })); history.dataset.key = historyKey;
    }
    history.value = selectedId;
    const record = records.find(item => item.id === selectedId);
    element('trial-results').hidden = !record;
    element('trial-empty').hidden = !!record;
    element<HTMLButtonElement>('trial-refresh').disabled = disabled || !record?.inspection;
    element<HTMLButtonElement>('trial-export').disabled = disabled || !record?.capture || record.status === 'running';
    const key = JSON.stringify([record, current?.currentIds, localChanged, pending, selection()]);
    if (record && key !== resultKey) { element('trial-result').replaceChildren(...resultContent(record)); resultKey = key; }
  }
  return {
    render(document, nextLocked, pendingInput) {
      locked = nextLocked;
      if (pendingInput && !pending && current?.activeId) void bridge.invalidate(document.sessionId).then(receive).catch(() => error('Use Cancel trial to stop the active provider.'));
      pending = pendingInput;
      if (document.sessionId !== documentId) {
        documentId = document.sessionId; current = null; proposalKey = ''; resultKey = ''; selectedId = ''; sourceRepository = document.repositoryRoot; localChanged = false;
        repository.value = ''; pr.value = ''; profile.value = ''; error(); element('trial-exported').hidden = true;
        void bridge.current().then(receive).catch(() => error('Private trial history could not be loaded. Check application data permissions.'));
      }
      renderState();
    },
    running: () => !!current?.activeId || !!current?.refreshing,
  };
}
