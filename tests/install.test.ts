import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const installer = resolve('install.sh');

async function executable(path: string, contents: string) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

test('user installer installs and upgrades the CLI, desktop launcher, and workflow skill', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'repo-chap-user-install-'));
  const home = join(temporary, 'home');
  const source = join(temporary, 'source');
  const prefix = join(temporary, 'prefix');
  const fakeBin = join(temporary, 'bin');
  try {
    await mkdir(fakeBin);
    await mkdir(source);
    await writeFile(join(source, 'package.json'), '{}\n');
    await writeFile(join(source, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    await executable(join(fakeBin, 'node'), `#!/bin/sh
if [ "$1" = "-p" ]; then printf '24\\n'; else printf 'v24.0.0\\n'; fi
`);
    await executable(join(fakeBin, 'corepack'), `#!/bin/sh
destination=
output=
platform=linux
architecture=x64
while [ "$#" -gt 0 ]; do
  case "$1" in
    --pack-destination) destination=$2; shift 2 ;;
    --out) output=$2; shift 2 ;;
    --platform) platform=$2; shift 2 ;;
    --arch) architecture=$2; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$destination" ]; then mkdir -p "$destination"; : > "$destination/repo-chap-0.1.0.tgz"; fi
if [ -n "$output" ]; then
  app="$output/Repo Chap-$platform-$architecture"
  mkdir -p "$app"
  printf '#!/bin/sh\\n' > "$app/repo-chap-desktop"
  chmod 0755 "$app/repo-chap-desktop"
fi
`);
    await executable(join(fakeBin, 'npm'), `#!/bin/sh
prefix=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then prefix=$2; shift 2; else shift; fi
done
mkdir -p "$prefix/bin"
cat > "$prefix/bin/repo-chap" <<'SCRIPT'
#!/bin/sh
SCRIPT
chmod 0755 "$prefix/bin/repo-chap"
`);
    await executable(join(fakeBin, 'npx'), `#!/bin/sh
mkdir -p "$HOME"
printf '%s\\n' "$*" > "$HOME/npx-arguments"
mkdir -p "$HOME/.agents/skills/repo-chap-workflows"
printf '%s\\n' '# Repo Chap workflows' > "$HOME/.agents/skills/repo-chap-workflows/SKILL.md"
`);

    const result = spawnSync('/bin/bash', [installer, '--source', source, '--prefix', prefix], {
      encoding: 'utf8',
      env: { HOME: home, PATH: `${fakeBin}:/usr/bin:/bin`, REPO_CHAP_INSTALL_SKILL: 'yes' },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Repo Chap is installed/);
    assert.equal((await lstat(join(prefix, 'bin/repo-chap'))).mode & 0o111, 0o111);
    assert.equal((await lstat(join(prefix, 'bin/repo-chap-desktop'))).isSymbolicLink(), true);
    assert.match(await readFile(join(home, '.agents/skills/repo-chap-workflows/SKILL.md'), 'utf8'), /Repo Chap/);
    assert.match(await readFile(join(home, 'npx-arguments'), 'utf8'), /skills add .*repo-chap-workflows --global/);

    await writeFile(join(home, '.agents/skills/repo-chap-workflows/SKILL.md'), 'outdated\n');
    const upgrade = spawnSync('/bin/bash', [installer, '--source', source, '--prefix', prefix], {
      encoding: 'utf8',
      env: { HOME: home, PATH: `${fakeBin}:/usr/bin:/bin`, REPO_CHAP_INSTALL_SKILL: 'yes' },
    });
    assert.equal(upgrade.status, 0, upgrade.stderr || upgrade.stdout);
    assert.match(upgrade.stdout, /installed and up to date/);
    assert.match(await readFile(join(home, '.agents/skills/repo-chap-workflows/SKILL.md'), 'utf8'), /Repo Chap/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('user installer rejects an unsafe ref before changing files', () => {
  const result = spawnSync('/bin/bash', [installer, '--ref', '../main'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plain Git branch or tag/);
});
