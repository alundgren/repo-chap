import { parseArgs } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { fixture } from './pilot-fixture.mjs';
import { runGuide } from '../deploy/pilot/guide.mjs';
import { outsideGit } from '../deploy/pilot/store.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' } } });
if (!values.root || !isAbsolute(values.root)) throw new Error('Use --root /absolute/private/new-rehearsal-directory');
await outsideGit(values.root);
process.umask(0o077);
// This entry point only constructs fake services. It cannot select real accounts.
const f = await fixture({ after() {} }, {}, values.root);
const successful = await runGuide(f.pilot, f.run, { mode: 'rehearsal', answer: async message => {
  if (message.includes('prerequisite checklist')) return 'ready';
  if (message.includes('Type matched')) return 'matched';
  if (message.includes('Type approve')) return `approve ${f.run.id}`;
  if (message.includes('fixtures-ready')) return 'fixtures-ready';
  if (message.includes('fixtures-clean')) return 'fixtures-clean';
  return 'pass';
} });
console.log(`Rehearsal ${successful ? 'passed' : 'failed'} with fake services. No real-account evidence.\nEvidence: ${join(f.store.directory(f.run.id), 'evidence.json')}`);
process.exitCode = successful ? 0 : 1;
