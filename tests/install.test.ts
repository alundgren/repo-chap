import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const installer = resolve('install.sh');

async function executable(path: string, contents: string) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

for (const platform of ['Linux', 'Darwin']) {
test(`user installer installs and upgrades on ${platform}`, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'repo-chap-user-install-'));
  const home = join(temporary, 'home');
  const source = join(temporary, 'source');
  const prefix = join(temporary, "prefix with 'quotes' and $literal");
  const shell = platform === 'Darwin' ? '/bin/zsh' : '/bin/bash';
  const startup = platform === 'Darwin' ? '.zshrc' : '.bashrc';
  const fakeBin = join(temporary, 'bin');
  try {
    await mkdir(fakeBin);
    await mkdir(source);
    await mkdir(home);
    await writeFile(join(home, startup), '# Existing configuration\n');
    await executable(join(fakeBin, 'uname'), `#!/bin/sh\nif [ "$1" = -s ]; then echo ${platform}; else echo arm64; fi\n`);
    await writeFile(join(source, 'package.json'), '{}\n');
    await writeFile(join(source, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    await executable(join(fakeBin, 'vp'), `#!/bin/sh
mkdir -p "$HOME"
printf '%s\\n' "$*" >> "$HOME/vp-arguments"
case "$1" in
  install|run|pm|dlx|exec) ;;
  *) exit 91 ;;
esac
if [ "$1" = dlx ]; then
  mkdir -p "$HOME/.agents/skills/repo-chap-workflows"
  printf '%s\\n' '# Repo Chap workflows' > "$HOME/.agents/skills/repo-chap-workflows/SKILL.md"
fi
destination=
output=
bin_directory=
platform=linux
architecture=x64
while [ "$#" -gt 0 ]; do
  case "$1" in
    --pack-destination) destination=$2; shift 2 ;;
    --out) output=$2; shift 2 ;;
    --platform) platform=$2; shift 2 ;;
    --arch) architecture=$2; shift 2 ;;
    --global-bin-dir) bin_directory=$2; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$destination" ]; then mkdir -p "$destination"; : > "$destination/repo-chap-0.1.0.tgz"; fi
if [ -n "$output" ]; then
  app="$output/Repo Chap-$platform-$architecture"
  if [ "$platform" = darwin ]; then app="$app/Repo Chap.app/Contents/MacOS"; fi
  mkdir -p "$app"
  printf '#!/bin/sh\\n' > "$app/repo-chap-desktop"
  chmod 0755 "$app/repo-chap-desktop"
fi
if [ -n "$bin_directory" ]; then
  mkdir -p "$bin_directory"
  printf '#!/bin/sh\\n' > "$bin_directory/repo-chap"
  chmod 0755 "$bin_directory/repo-chap"
fi
`);
    for (const command of ['node', 'npm', 'npx', 'corepack', 'pnpm']) {
      await executable(join(fakeBin, command), '#!/bin/sh\nexit 92\n');
    }

    const result = spawnSync('/bin/bash', [installer, '--source', source, '--prefix', prefix], {
      encoding: 'utf8',
      env: { HOME: home, SHELL: shell, PATH: `${fakeBin}:/usr/bin:/bin`, REPO_CHAP_INSTALL_SKILL: 'yes' },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Repo Chap is installed/);
    assert.equal((await lstat(join(prefix, 'bin/repo-chap'))).mode & 0o111, 0o111);
    assert.equal((await lstat(join(prefix, 'bin/repo-chap-desktop'))).mode & 0o111, 0o111);
    assert.match(await readFile(join(home, '.agents/skills/repo-chap-workflows/SKILL.md'), 'utf8'), /Repo Chap/);
    assert.match(await readFile(join(home, 'vp-arguments'), 'utf8'), /dlx skills add .*repo-chap-workflows --global/);

    const configuration = await readFile(join(home, startup), 'utf8');
    assert.match(configuration, /^# Existing configuration/);
    const lookup = spawnSync('/bin/bash', ['-c', '. "$1"; command -v repo-chap; command -v repo-chap-desktop; repo-chap-desktop', 'bash', join(home, startup)], {
      encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' },
    });
    assert.equal(lookup.status, 0, lookup.stderr);
    assert.equal(lookup.stdout, `${prefix}/bin/repo-chap\n${prefix}/bin/repo-chap-desktop\n`);
    if (platform === 'Darwin') {
      assert.equal((await lstat(join(home, 'Applications/Repo Chap.app/Contents/MacOS/repo-chap-desktop'))).mode & 0o111, 0o111);
    } else {
      assert.match(await readFile(join(home, '.profile'), 'utf8'), /export PATH=/);
    }
    const desktopExecutable = platform === 'Darwin'
      ? join(home, 'Applications/Repo Chap.app/Contents/MacOS/repo-chap-desktop')
      : join(prefix, 'share/repo-chap/desktop/repo-chap-desktop');
    await executable(desktopExecutable, `#!/bin/sh
if [ "\${ELECTRON_RUN_AS_NODE+x}" = x ]; then exit 93; fi
printf '%s\\n' "$@"
exit 17
`);
    const launchArgs = ['--repo-root', source, '--workflow', join(source, 'workflow with spaces.json')];
    const launch = spawnSync(join(prefix, 'bin/repo-chap-desktop'), launchArgs, {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1' },
    });
    assert.equal(launch.status, 17, launch.stderr);
    assert.equal(launch.stdout, launchArgs.join('\n') + '\n');
    // Upgrades replace the previous executable symlink with the launcher.
    await rm(join(prefix, 'bin/repo-chap-desktop'));
    await symlink(desktopExecutable, join(prefix, 'bin/repo-chap-desktop'));
    await writeFile(join(home, '.agents/skills/repo-chap-workflows/SKILL.md'), 'outdated\n');
    const upgrade = spawnSync('/bin/bash', [installer, '--source', source, '--prefix', prefix], {
      encoding: 'utf8',
      env: { HOME: home, SHELL: shell, PATH: `${fakeBin}:/usr/bin:/bin`, REPO_CHAP_INSTALL_SKILL: 'yes' },
    });
    assert.equal(upgrade.status, 0, upgrade.stderr || upgrade.stdout);
    assert.match(upgrade.stdout, /installed and up to date/);
    assert.equal((await lstat(join(prefix, 'bin/repo-chap-desktop'))).isSymbolicLink(), false);
    const upgradedLaunch = spawnSync(join(prefix, 'bin/repo-chap-desktop'), launchArgs, {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1' },
    });
    assert.equal(upgradedLaunch.status, 0, upgradedLaunch.stderr);
    assert.equal(await readFile(join(home, startup), 'utf8'), configuration);
    assert.match(await readFile(join(home, '.agents/skills/repo-chap-workflows/SKILL.md'), 'utf8'), /Repo Chap/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

}

test('user installer rejects an unsafe ref before changing files', () => {
  const result = spawnSync('/bin/bash', [installer, '--ref', '../main'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plain Git branch or tag/);
});
