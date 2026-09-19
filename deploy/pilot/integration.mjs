import { parseArgs } from 'node:util';
import { join, resolve, isAbsolute } from 'node:path';
import { open, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Accounts, PilotError } from './io.mjs';
import { Store, privateRead, writePrivate } from './store.mjs';
import { Pilot } from './lifecycle.mjs';

async function findDispatch(pilot, run, workflow, job) {
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

// This path uses the installed runner and GitHub job records, never local check results.
export async function runIntegration(pilot, run, selection, { retainOnFailure = false } = {}) {
  const path = join(pilot.store.directory(run.id), 'integration.json');
  let evidence;
  try { evidence = JSON.parse(await privateRead(path)); }
  catch (error) { if (error.code !== 'ENOENT') throw new PilotError('Cannot read integration checkpoint'); }
  const selected = { workflow: selection.workflow, failingRef: selection.failingRef, repairedRef: selection.repairedRef };
  if (evidence && JSON.stringify(evidence.selection) !== JSON.stringify(selected)) throw new PilotError('Integration selection changed; use the recorded references or prepare a new run');
  evidence ??= { runId: run.id, selection: selected, jobs: [] };
  if (evidence.runId !== run.id || !Array.isArray(evidence.jobs)) throw new PilotError('Integration checkpoint belongs to another run');
  const save = () => writePrivate(path, JSON.stringify(evidence, null, 2) + '\n');
  let successful = false;
  try {
    if (!await pilot.up(run, { retainOnFailure })) throw new PilotError('Pilot setup did not complete');
    if (!run.runnerId || !run.deviceId) throw new PilotError('Installed runner and device identities are required');
    for (const [index, ref, expected] of [[0, selected.failingRef, 'failure'], [1, selected.repairedRef, 'success']]) {
      pilot.signal?.throwIfAborted();
      const runners = await pilot.runners(run);
      if (runners.length !== 1 || runners[0].id !== run.runnerId) throw new PilotError('Installed runner identity changed');
      await pilot.ssh(run, `test "$(cat /etc/repo-chap-pilot-run)" = '${run.id}' && sudo systemctl is-active --quiet repo-chap-runner.service`);
      const commit = await pilot.accounts.gh(`repos/${run.repository}/commits/${encodeURIComponent(ref)}`);
      if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new PilotError('Cannot resolve integration head');
      let job = evidence.jobs[index];
      if (!job) {
        job = { ref, head: commit.sha, expected, correlation: `${run.name}-${index === 0 ? 'failing' : 'repaired'}` };
        evidence.jobs.push(job);
      }
      if (job.head !== commit.sha || job.expected !== expected || job.ref !== ref) throw new PilotError('Integration reference moved; restore it or prepare a new run');
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
            if (result.total_count !== 1 || result.jobs?.length !== 1) throw new PilotError('Fixture workflow must have exactly one check job');
            const actual = result.jobs[0];
            if (actual.name !== 'check' || actual.status !== 'completed' || actual.conclusion !== expected ||
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
      pilot.output(`Verified ${expected} job on runner ${run.runnerId}, head ${job.head}.`);
    }
    evidence.complete = true;
    await save();
    successful = true;
  } catch (error) {
    pilot.output(error instanceof PilotError ? error.message : 'Integration interrupted or failed');
    if (retainOnFailure) {
      run.retained = true;
      await pilot.checkpoint(run, 'retained');
      pilot.warn(run);
    }
  } finally {
    if (successful || !retainOnFailure) {
      pilot.signal = undefined;
      if (!await pilot.cleanup(run)) successful = false;
    }
  }
  return successful;
}

async function cli() {
  const { values } = parseArgs({ options: {
    root: { type: 'string' }, run: { type: 'string' }, workflow: { type: 'string', default: 'pilot.yml' },
    'failing-ref': { type: 'string' }, 'repaired-ref': { type: 'string' }, confirm: { type: 'boolean' },
    'retain-on-failure': { type: 'boolean' },
  } });
  if (!values.root || !isAbsolute(values.root) || !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(values.workflow) ||
      !values['failing-ref'] || !values['repaired-ref']) throw new PilotError('Use --root PATH --run ID --workflow pilot.yml --failing-ref BRANCH --repaired-ref BRANCH; add --confirm to provision and dispatch');
  const store = new Store(values.root);
  const run = await store.load(values.run);
  console.log(`Integration will provision run ${run.id}, dispatch two heads in ${run.repository}, then clean up. Billing continues until verified cleanup.`);
  if (!values.confirm) { console.log('Preview only. Add --confirm to run the live integration.'); return 0; }
  const lockPath = join(store.root, '.pilot.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new PilotError('Operator directory is locked; inspect .pilot.lock'); });
  await lock.writeFile(String(process.pid));
  const controller = new AbortController();
  const pilot = new Pilot(store, new Accounts(), { signal: controller.signal });
  const interrupt = () => { if (!pilot.cleaning) controller.abort(); else console.log('Bounded cleanup continues.'); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    return await runIntegration(pilot, run, { workflow: values.workflow, failingRef: values['failing-ref'], repairedRef: values['repaired-ref'] }, { retainOnFailure: !!values['retain-on-failure'] }) ? 0 : 1;
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    await lock.close(); await rm(lockPath, { force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try { process.exitCode = await cli(); }
  catch (error) { console.error(error instanceof PilotError ? error.message : 'Integration failed; check the private checkpoint and clean up the selected run.'); process.exitCode = 1; }
}
