import { runTestSuite } from './integration.mjs';
import { runWorkflowTests } from './workflow-tests.mjs';
import { prepareRepository } from './repository.mjs';

const suites = [runTestSuite, runWorkflowTests];

async function prepareTests(pilot, run) {
  if (run.testSetup?.repository === run.repository) return true;
  try {
    await prepareRepository(pilot.accounts, run.repository);
    run.testSetup = { repository: run.repository, completedAt: new Date().toISOString() };
    await pilot.store.save(run);
    return true;
  } catch {
    return false;
  }
}

export async function runAllTests(pilot, run, testSuites = suites, setup = prepareTests) {
  if (!await setup(pilot, run)) {
    pilot.output('repository setup: fail');
    run.test = { ...run.test, status: 'failed', completedAt: new Date().toISOString() };
    await pilot.store.save(run);
    return false;
  }
  pilot.output('repository setup: pass');
  for (const runSuite of testSuites) {
    if (!await runSuite(pilot, run)) {
      run.test = { ...run.test, status: 'failed', completedAt: new Date().toISOString() };
      await pilot.store.save(run);
      return false;
    }
  }
  run.test = { ...run.test, status: 'passed', completedAt: new Date().toISOString() };
  await pilot.store.save(run);
  return true;
}
