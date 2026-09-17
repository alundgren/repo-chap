import { RuntimeError, RuntimeStore } from '@repo-chap/runtime';
import { DaemonService } from './service.js';
import { serveControl } from './control.js';
import { loadInstallation } from './config.js';

export { DaemonService, type DaemonDependencies } from './service.js';
export { runLocalApply, inspectLocalApply, type LocalApplyOptions } from './local.js';
export { executeAnalysis, fetchSources, executeRepair, fetchRepairSources, profileDigest } from './worker.js';
export { readWorkflowCommit, fetchWorkflowCommit } from './source.js';
export { requestControl, serveControl, handleControl, type ControlRequest, type ControlResponse } from './control.js';
export async function startDaemon(directory: string, config: string): Promise<{ service: DaemonService; stop: () => Promise<void> }> {
  if (process.platform !== 'linux') throw new RuntimeError('The daemon runs on Linux. Run its CLI on the VM, including through SSH.');
  let store: RuntimeStore | undefined;
  let ownership: string | undefined;
  try {
    const installation = await loadInstallation(config, directory);
    store = await RuntimeStore.open(directory, installation.limits);
    ownership = store.claimDaemon();
    const service = new DaemonService(store, installation.dependencies), control = await serveControl(directory, service);
    const tick = () => { void service.tick().catch(() => process.stderr.write('Daemon scheduling failed. Inspect private storage and daemon status.\n')); };
    const interval = setInterval(tick, 1000); tick(); let stopped = false;
    return { service, stop: async () => { if (stopped) return; stopped = true; clearInterval(interval); await control.close(); await service.stop(); store!.releaseDaemon(ownership!); store!.close(); } };
  } catch (error) { if (ownership) store?.releaseDaemon(ownership); store?.close(); throw error; }
}
