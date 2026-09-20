import { runTestSuite } from './integration.mjs';
import { runWorkflowTests } from './workflow-tests.mjs';
import { prepareTests } from './test-setup.mjs';
import { PilotError } from './io.mjs';

export async function runAllTests(pilot, run) {
  try {
    await prepareTests(pilot, run);
    pilot.output('repository setup: pass');
    const prefix = run.name;
    for (const suite of [() => runTestSuite(pilot, run, { workflow: 'pilot.yml', failingRef: `${prefix}-failing`, repairedRef: `${prefix}-repaired` }),
      () => runWorkflowTests(pilot, run)]) {
      if (!await suite()) {
        run.test = { ...run.test, status: 'failed', completedAt: new Date().toISOString() };
        await pilot.store.save(run);
        return false;
      }
    }
    run.test = { ...run.test, status: 'passed', completedAt: new Date().toISOString() };
    await pilot.store.save(run);
    return true;
  } catch (error) {
    pilot.output(`repository setup: fail${error instanceof PilotError ? ` - ${error.message}` : ''}`);
    run.test = { ...run.test, status: 'failed', completedAt: new Date().toISOString() };
    await pilot.store.save(run);
    return false;
  }
}
