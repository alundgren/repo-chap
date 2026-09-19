import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProfiles } from '@repo-chap/providers';
import { desktopProfile, saveDesktopProfiles } from '../apps/desktop/src/provider-settings.ts';

test('desktop provider choices persist privately, replace atomically, and retain the last valid file after a rejected save', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repo-chap-provider-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const codex = desktopProfile({ provider: 'codex', model: 'fictional-codex' });
  const claude = desktopProfile({ provider: 'claude', model: 'fictional-claude' });
  await saveDesktopProfiles(directory, [codex]);
  await saveDesktopProfiles(directory, [codex, claude]);
  assert.deepEqual(await readProfiles(join(directory, 'providers.json')), [codex, claude]);
  assert.equal((await stat(join(directory, 'providers.json'))).mode & 0o777, 0o600);
  const previous = await readFile(join(directory, 'providers.json'), 'utf8');
  await assert.rejects(saveDesktopProfiles(directory, [{ ...codex, model: '' }]));
  assert.equal(await readFile(join(directory, 'providers.json'), 'utf8'), previous);
  await mkdir(join(directory, '.git'));
  await assert.rejects(saveDesktopProfiles(directory, [codex]), /outside Git/);
  assert.equal(await readFile(join(directory, 'providers.json'), 'utf8'), previous);
});

test('desktop provider choices reject malformed input', () => {
  for (const choice of [null, { provider: 'other', model: 'fictional' }, { provider: 'codex', model: '' }, { provider: 'claude', model: 'bad\nmodel' }]) {
    assert.throws(() => desktopProfile(choice as any));
  }
});
