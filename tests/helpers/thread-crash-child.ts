import { readFile, writeFile } from 'node:fs/promises';
import { RuntimeStore } from '@repo-chap/runtime';
import { DaemonService } from '@repo-chap/daemon';
import { localPullRequestWriteCredentials, tokenCredentials } from '@repo-chap/github';
import { remote } from './daemon-remote.ts';
const path = process.argv[2]!, fixture = JSON.parse(await readFile(path, 'utf8')), store = await RuntimeStore.open(fixture.directory), fake = remote(fixture.inspection);
const service = new DaemonService(store, { directory: fixture.directory, credentials: tokenCredentials('fictional-read'), profile: async () => fixture.profile, applyPolicy: async () => fixture.policy,
  threadCredentials: repository => localPullRequestWriteCredentials(repository, { env: { GH_TOKEN: 'fictional-write' } }),
  readOptions: { fetch: async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (!body.query.startsWith('mutation ')) return fake.fetch(url, init);
    fixture.inspection.evidence.threads.items.find((thread: any) => thread.id === body.variables.id).resolved = true;
    await writeFile(path, JSON.stringify(fixture), { mode: 0o600 }); process.kill(process.pid, 'SIGKILL');
    throw new Error('The killed daemon cannot persist a receipt.');
  } },
});
for (let step = 0; step < 3; step++) { await service.tick(); await service.idle(); }
await service.stop(); store.close();
throw new Error('Expected the resolution request to terminate this fixture process.');
