#!/usr/bin/env node
import { startDaemon } from './index.js';

const [directory, config, extra] = process.argv.slice(2);
if (!directory || !config || extra) {
  process.stderr.write('Usage: repo-chap-daemon <private-state-directory> <private-installation.json>\n'); process.exitCode = 64;
} else {
  try {
    const daemon = await startDaemon(directory, config);
    process.stdout.write('Repo Chap daemon started in analysis mode.\n');
    const stop = () => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); void daemon.stop().catch(() => { process.exitCode = 7; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch { process.stderr.write('Cannot start the daemon. Check the private state directory and installation settings.\n'); process.exitCode = 7; }
}
