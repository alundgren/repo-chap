import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

const [root, executable] = process.argv.slice(2);
await mkdir(root, { recursive: true, mode: 0o700 });
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
await writeFile(join(root, 'app.pem'), key, { mode: 0o600 });
await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('codex-cli 0.154.0');
else if (args.includes('--help')) console.log('--json --output-schema --model --config --sandbox --ignore-user-config --skip-git-repo-check --strict-config --ask-for-approval');
else if (args.includes('--bundled')) console.log(JSON.stringify({models:[{slug:'fictional-model',default_reasoning_level:'medium',supported_reasoning_levels:[{effort:'medium'}]}]}));
else if (args.join(' ') === 'login status') console.log('Fictional account is signed in.');
else { console.error('No model calls are supported by the operations fixture.'); process.exitCode=99; }
`, { mode: 0o700 });
await writeFile(join(root, 'providers.json'), JSON.stringify({ schemaVersion: 1, profiles: { pilot: { provider: 'codex', executable, model: 'fictional-model', maximumCapabilities: ['workspace.read'] } } }), { mode: 0o600 });
await writeFile(join(root, 'installation.json'), JSON.stringify({ schemaVersion: 1, app: { appId: '456', installationId: 123, privateKeyFile: join(root, 'app.pem') }, providerConfig: join(root, 'providers.json'), limits: { repositoryCostUnits: 5 } }), { mode: 0o600 });
await writeFile(join(root, 'workflow.json'), JSON.stringify({ schemaVersion: 1, id: 'operations-fixture', version: '0.1.0', requestedCapabilities: [], labels: [], settings: { newPrDelaySeconds: 0, headDebounceSeconds: 0, reviewWaitSeconds: 30, reviewDeadlineSeconds: 60, mergeMode: 'human' }, limits: { maxAgentActionsPerWake: 1, maxAttemptsPerHead: 1, maxRepairsPerLifecycle: 1, maxAttemptSeconds: 60, maxDailyCostUnits: 5 }, actions: { wait: { uses: 'control.wait_signal', execution: 'code', capabilities: [], onSuccess: '$wait', onFailure: '$blocked' } }, rules: [{ id: 'draft', when: { field: 'facts.draft', op: 'eq', value: true }, action: 'wait' }], otherwise: 'wait' }), { mode: 0o600 });
