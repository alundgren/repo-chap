import { join } from 'node:path';
import { PilotError } from './io.mjs';
import { privateRead, writePrivate } from './store.mjs';

export async function findDispatch(pilot, run, workflow, job) {
  const matches = [];
  for (let page = 1; page <= 100; page++) {
    const data = await pilot.accounts.gh(`repos/${run.repository}/actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=${encodeURIComponent(job.ref)}&per_page=100&page=${page}`);
    if (!Array.isArray(data.workflow_runs)) throw new PilotError('Invalid workflow run inventory');
    matches.push(...data.workflow_runs.filter(r => r.display_title === job.correlation));
    if (data.workflow_runs.length < 100) break;
    if (page === 100) throw new PilotError('Workflow inventory exceeded page limit');
  }
  if (matches.length > 1) throw new PilotError('Multiple matching workflow dispatches; inspect GitHub before retrying');
  return matches[0];
}

export const suite = { workflow: 'pilot.yml', failingRef: 'pilot-failing', repairedRef: 'pilot-repaired' };

// This path uses the installed host, runner, and GitHub job records. It never
// provisions or deletes the selected environment.
export async function runTestSuite(pilot, run, selection = suite) {
  if (run.stage !== 'running') throw new PilotError('The environment must be running before tests start');
  const path = join(pilot.store.directory(run.id), 'test.json');
  let evidence;
  try { evidence = JSON.parse(await privateRead(path)); }
  catch (error) { if (error.code !== 'ENOENT') throw new PilotError('Cannot read test checkpoint'); }
  const selected = { workflow: selection.workflow, failingRef: selection.failingRef, repairedRef: selection.repairedRef };
  if (evidence && JSON.stringify(evidence.selection) !== JSON.stringify(selected)) throw new PilotError('Test selection changed; use the recorded references or prepare a new environment');
  evidence ??= { version: 1, runId: run.id, selection: selected, attempt: 1, history: [], jobs: [] };
  if (evidence.runId !== run.id || !Array.isArray(evidence.jobs)) throw new PilotError('Test checkpoint belongs to another environment');
  evidence.history ??= [];
  evidence.attempt ??= 1;
  const save = () => writePrivate(path, JSON.stringify(evidence, null, 2) + '\n');
  let successful = false;
  let scenario = 'environment health';
  try {
    if (!run.runnerId || !run.deviceId) throw new PilotError('Installed runner and device identities are required');
    run.test = { status: 'running', startedAt: new Date().toISOString() };
    await pilot.store.save(run);
    await pilot.ssh(run, 'sudo -u repo-chap -H env CODEX_HOME=/var/lib/repo-chap-home/pilot-codex /opt/repo-chap/current/repo-chap daemon diagnose --state-dir /var/lib/repo-chap --config /etc/repo-chap/installation.json --json >/dev/null && sudo systemctl is-active --quiet repo-chap.service repo-chap-runner.service');
    pilot.output(`${scenario}: pass`);
    for (const [index, ref, expected] of [[0, selected.failingRef, 'failure'], [1, selected.repairedRef, 'success']]) {
      scenario = `${ref} returns ${expected}`;
      pilot.signal?.throwIfAborted();
      const runners = await pilot.runners(run);
      if (runners.length !== 1 || runners[0].id !== run.runnerId) throw new PilotError('Installed runner identity changed');
      await pilot.ssh(run, `test "$(cat /etc/repo-chap-pilot-run)" = '${run.id}' && sudo systemctl is-active --quiet repo-chap-runner.service`);
      const commit = await pilot.accounts.gh(`repos/${run.repository}/commits/${encodeURIComponent(ref)}`);
      if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new PilotError('Cannot resolve test head');
      let job = evidence.jobs[index];
      if (!job) {
        job = { ref, head: commit.sha, expected, correlation: `${run.name}-${evidence.attempt}-${index === 0 ? 'failing' : 'repaired'}` };
        evidence.jobs.push(job);
      }
      if (job.head !== commit.sha || job.expected !== expected || job.ref !== ref) throw new PilotError('Test reference moved; restore it or prepare a new environment');
      if (index === 1 && job.head === evidence.jobs[0].head) throw new PilotError('The repaired job must use a different commit');
      if (!job.attempted) {
        job.attempted = true;
        await save();
        // A lost response is reconciled by correlation on resume, never blindly dispatched twice.
        await pilot.accounts.gh(`repos/${run.repository}/actions/workflows/${selected.workflow}/dispatches`, 'POST', {
          ref, inputs: { pilot_label: run.name, correlation: job.correlation },
        });
      }
      let complete = false;
      for (let poll = 0; poll < 60; poll++) {
        pilot.signal?.throwIfAborted();
        const workflowRun = await findDispatch(pilot, run, selected.workflow, job);
        if (workflowRun) {
          if (workflowRun.head_sha !== job.head || workflowRun.run_attempt !== 1) throw new PilotError('Workflow head or attempt differs from the selected dispatch');
          job.workflowRunId = workflowRun.id;
          await save();
          if (workflowRun.status === 'completed') {
            const result = await pilot.accounts.gh(`repos/${run.repository}/actions/runs/${workflowRun.id}/jobs?filter=latest&per_page=100`);
            pilot.signal?.throwIfAborted();
            if (result.total_count !== 1 || result.jobs?.length !== 1) throw new PilotError('Fixture workflow must have exactly one check job');
            const actual = result.jobs[0];
            if (actual.name !== 'check' || actual.status !== 'completed') throw new PilotError('Fixture workflow must have one completed check job');
            job.terminalObserved = true;
            await save();
            if (actual.conclusion !== expected ||
                actual.runner_id !== run.runnerId || actual.runner_name !== run.name || !actual.labels?.includes(run.name))
              throw new PilotError('Job outcome or runner identity does not match the installed pilot');
            Object.assign(job, { jobId: actual.id, runnerId: actual.runner_id, conclusion: actual.conclusion });
            await save();
            complete = true;
            break;
          }
        }
        await pilot.pause(10000);
      }
      if (!complete) throw new PilotError('Workflow outcome unknown after deadline; inspect the recorded correlation before retrying');
      pilot.output(`${scenario}: pass`);
    }
    evidence.complete = true;
    await save();
    run.test = { ...run.test, status: 'passed', completedAt: new Date().toISOString() };
    await pilot.store.save(run);
    successful = true;
  } catch {
    // A dispatch is not safe to replace until its one job has a confirmed
    // terminal result. Resume queued, interrupted, and temporarily unreadable
    // runs by their saved correlation instead of dispatching another job.
    const uncertain = evidence.jobs.some(job => job.attempted && !job.terminalObserved);
    if (!uncertain) evidence.failed = true;
    await save();
    run.test = { ...run.test, status: uncertain ? 'interrupted' : 'failed', completedAt: new Date().toISOString() };
    await pilot.store.save(run);
    pilot.output(`${scenario}: fail`);
  }
  return successful;
}
