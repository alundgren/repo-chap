import { join } from 'node:path';
import { platform, release } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { PilotError } from './io.mjs';
import { writePrivate } from './store.mjs';
import { generateFixtures } from './fixtures.mjs';
import { versions } from './remote.mjs';

export const scenarios = [
  ['read-access', 'Confirm public/private CLI reads and repository-scoped GitHub App daemon access.'],
  ['codex', 'Confirm real Codex headless execution, configured model/effort, structured results, timeout/cancel, and a fresh bounded retry after a lost session.'],
  ['review', 'Observe ordinary review, labels and a clear configured human handoff. Do not merge.'],
  ['conflict', 'Observe conflict repair: required checks, conditional push of the tested commit, and fresh head observation.'],
  ['review-response', 'Observe actionable review-response repair and resolution of only eligible threads after a checked conditional push.'],
  ['ci-recovery', 'Observe a failed job with no review threads, local reproduction, bounded repair, and a passing new head on the same unique runner ID.'],
  ['ci-wait', 'Verify running, pending, mixed, stale, unknown and incomplete CI observations do not launch repair.'],
  ['ci-handoff', 'Verify remote-log-only, infrastructure, access, credential and rerun-only failures hand off to a person.'],
  ['changed-head', 'Move the head during a candidate check; verify stale conditional push refusal and fresh observation.'],
  ['budgets', 'Exhaust run/repair budgets; verify bot commits and restart do not reset them.'],
  ['configuration', 'Restart during waiting work; activate invalid configuration, verify last-valid recovery, rollback hold, and backup restore.'],
  ['uncertain-outcomes', 'Simulate a lost GitHub/Slack response using offline fixtures; verify reconciliation without duplicate repair or notification.'],
  ['slack', 'If configured, verify channel and author-DM routing, missing mappings, delivery failure and clear human handoff. Otherwise record not-configured.'],
  ['revocation', 'Revoke the dedicated Codex authentication, verify bounded authentication failure and handoff. Do this last.'],
];
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
export const pilotCommand = (pilot, run, action) => `vp run pilot ${action} --root ${quote(pilot.store.root)} --run ${run.id}`;

export async function terminalAnswer(message, signal) {
  if (!process.stdin.isTTY) throw new PilotError('Guided run needs an interactive terminal. Use --dry-run for its preview.');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await terminal.question(`${message}\n> `, { signal })).trim(); }
  finally { terminal.close(); }
}

export async function guideStatus(pilot, run) {
  const result = await pilot.verify(run);
  const billing = result.digitalocean.state === 'absent' ? 'absent' :
    result.digitalocean.ids.some(id => id.startsWith('droplet:')) ? 'exists' : 'unknown';
  pilot.output(`Run ${run.id}; host ${run.stage}; guide ${run.guide?.current ?? 'not-started'}; billable resource ${billing}.`);
  pilot.output(`Next: ${pilotCommand(pilot, run, run.stage === 'clean' ? 'verify-clean' : ['cleaning', 'cleanup-pending'].includes(run.stage) ? 'cleanup' : 'run')}`);
  if (run.retained) pilot.warn(run);
  return result;
}

export function guidePreview(pilot, run) {
  pilot.output(`Run ${run.id}; host ${run.stage}; guide ${run.guide?.current ?? 'not-started'}. Billing is not checked in preview.`);
  pilot.output(`Target repository: ${run.repository}. One disposable VM and persistent runner ${run.name}.`);
  pilot.output(`Private directory: ${pilot.store.directory(run.id)}. Pinned prerequisites: ${JSON.stringify(versions)}.`);
  pilot.output('Stages: prerequisites, offline CLI/companion comparison, infrastructure approval/up and private transfer, fixture generation/setup, live observations, evidence, cleanup, verify-clean.');
  pilot.output('No resources or GitHub states are changed by this preview. Run interactively without --dry-run; approve the displayed run ID before provisioning. Every fixture mutation has its own preview and confirmation. Never merge.');
  pilot.output(`Next: ${pilotCommand(pilot, run, 'run')}`);
}

// Only fixed outcome codes enter the summary; repository text and command output stay out.
export async function saveEvidence(pilot, run) {
  const guide = run.guide;
  const versionText = value => typeof value === 'string' && /^[a-zA-Z0-9.+_-]{1,80}$/.test(value) ? value : 'unrecorded';
  const installed = Object.fromEntries(Object.entries(run.versions ?? {}).filter(([key]) => ['node', 'vitePlus', 'tailscale', 'codex', 'runner', 'terraform', 'digitalocean', 'repoChapRelease'].includes(key)).map(([key, value]) => [key, versionText(value)]));
  const outcomes = Object.fromEntries(scenarios.map(([id]) => [id, ['pass', 'fail', 'not-configured'].includes(guide.outcomes[id]) ? guide.outcomes[id] : 'not-tested']));
  const verification = Object.fromEntries(['digitalocean', 'github', 'tailscale'].map(key => [key,
    ['absent', 'unresolved', 'inaccessible', 'unknown'].includes(run.verification?.[key]?.state) ? run.verification[key].state : 'unknown']));
  const evidence = { version: 1, runId: run.id, mode: guide.mode, operatorOS: `${platform()} ${release()}`, hostOS: 'Ubuntu 24.04', installed,
    outcomes, remainingFailures: Object.keys(outcomes).filter(key => !['pass', 'not-configured'].includes(outcomes[key])),
    fixtureCleanup: guide.fixtureCleanup === 'confirmed' ? 'operator-confirmed' : 'pending',
    current: guide.current, failedAt: guide.failedAt ?? null, verification };
  await writePrivate(join(pilot.store.directory(run.id), 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
}

export async function runGuide(pilot, run, { answer = terminalAnswer, retainOnFailure = false, mode = 'live' } = {}) {
  run.guide ??= { version: 1, mode, completed: [], outcomes: {}, current: 'prerequisites' };
  const guide = run.guide;
  if (guide.version !== 1 || guide.mode !== mode || !Array.isArray(guide.completed) || !guide.outcomes) throw new PilotError('Invalid guide checkpoint; inspect the private manifest before continuing.');
  let successful = false;
  let cleanupOK = false;
  const save = () => pilot.store.save(run);
  const ask = async (message, expected) => {
    pilot.signal?.throwIfAborted();
    if (await answer(message, pilot.signal) !== expected) throw new PilotError('Checkpoint not confirmed; guided run stopped.');
    pilot.signal?.throwIfAborted();
  };
  const step = async (id, work) => {
    if (guide.completed.includes(id)) return;
    guide.current = id;
    await save();
    await guideStatus(pilot, run);
    await work();
    guide.completed.push(id);
    await save();
  };
  try {
    run.retained = false;
    await save();
    if (['clean', 'cleaning', 'cleanup-pending'].includes(run.stage)) {
      guide.current = 'cleanup';
      successful = guide.completed.includes('fixture-cleanup');
    } else {
      await step('prerequisites', async () => {
        pilot.output('Read docs/pilot-guide.md. Use a dedicated trusted private repository, scoped App, dedicated CODEX_HOME, private configuration, and approved DigitalOcean/Tailscale accounts. No Claude account is required.');
        await ask('After completing the prerequisite checklist, type ready. Otherwise type stop.', 'ready');
      });
      await step('offline', async () => {
        await ask('Compare the same JSON/Markdown workflow and fictional inputs through CLI replay and the Electron companion. Match package/input digests and outcomes. Type matched only after the comparison passes.', 'matched');
      });
      await step('host', async () => {
        guidePreview(pilot, run);
        await ask(`Provision/resume ${run.id} in ${run.region}, ${run.size}, with paid resources, private configuration transfer and runner ${run.name}? Type approve ${run.id}.`, `approve ${run.id}`);
        if (!await pilot.up(run, { retainOnFailure })) throw new PilotError('Host setup failed.');
      });
      await step('fixtures', async () => {
        const directory = await generateFixtures(pilot.store, run);
        pilot.output(`Generated fictional inputs and preview/confirmation commands in ${directory}. Follow fixture-plan.md in the dedicated test repository. Each remote mutation requires approval; never merge.`);
        await ask(`After creating the run-specific PR states in ${run.repository}, type fixtures-ready.`, 'fixtures-ready');
      });
      await step('observations', async () => {
        for (const [id, description] of scenarios) {
          if (guide.outcomes[id] === 'pass' || id === 'slack' && guide.outcomes[id] === 'not-configured') continue;
          guide.current = id;
          await save();
          await guideStatus(pilot, run);
          pilot.signal?.throwIfAborted();
          const outcome = await answer(`${description}\nUse docs/pilot-guide.md for the procedure. Type pass or fail${id === 'slack' ? ', or not-configured' : ''}.`, pilot.signal);
          pilot.signal?.throwIfAborted();
          if (!['pass', 'fail', ...(id === 'slack' ? ['not-configured'] : [])].includes(outcome)) throw new PilotError('No valid scenario outcome supplied.');
          guide.outcomes[id] = outcome;
          await save();
          await saveEvidence(pilot, run);
          if (outcome === 'fail') throw new PilotError('Scenario failed.');
        }
      });
      await step('fixture-cleanup', async () => {
        await ask('Follow fixtures/fixture-plan.md to close the run PRs, cancel/wait for jobs, delete only the run branches and label, and verify absence. Type fixtures-clean after verification.', 'fixtures-clean');
        guide.fixtureCleanup = 'confirmed';
      });
      successful = true;
    }
  } catch {
    guide.failedAt = guide.current;
    pilot.output(`Run ${run.id}: checkpoint ${guide.current} failed or interrupted. No raw failure output is captured.`);
    pilot.output(`With operator permission, tailnet diagnostics: ${pilotCommand(pilot, run, 'status')}; ${pilotCommand(pilot, run, 'ssh')}; ${pilotCommand(pilot, run, 'diagnose')}. If tailnet access fails, use the DigitalOcean console. Do not broaden grants or rotate credentials without approval.`);
  } finally {
    // Evidence/checkpoint errors must never bypass infrastructure cleanup.
    if (!successful && retainOnFailure && !['clean', 'cleaning', 'cleanup-pending'].includes(run.stage)) {
      run.retained = true;
      try { await save(); } finally { pilot.warn(run); }
    } else {
      pilot.signal = undefined;
      guide.current = 'cleanup';
      try { cleanupOK = await pilot.cleanup(run); }
      catch { pilot.output(`Cleanup failed. Retry ${pilotCommand(pilot, run, 'cleanup')}`); }
      try {
        run.verification = await pilot.verify(run);
        cleanupOK = pilot.report(run, run.verification) && cleanupOK;
      } catch { cleanupOK = false; }
      guide.current = cleanupOK ? successful ? 'finished' : 'clean-with-incomplete-scenarios' : 'cleanup-pending';
    }
    await save();
    await saveEvidence(pilot, run);
    pilot.output(`Evidence: ${join(pilot.store.directory(run.id), 'evidence.json')}. Fixture PR/branch cleanup: follow fixtures/fixture-plan.md; infrastructure cleanup does not remove test-repository content.`);
    await guideStatus(pilot, run);
  }
  return successful && cleanupOK;
}
