import { mkdir, readFile, readdir, rm, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PilotError } from './io.mjs';
import { privateDirectory, privateRead, writePrivate } from './store.mjs';

export const versions = { node: '24.21.0', vitePlus: '0.3.0', runner: '2.337.0' };
const runnerDigest = '70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613';
export function bootstrap(run, key) {
  if (!/^tskey-auth-[a-zA-Z0-9-]+$/.test(key)) throw new PilotError('Invalid bootstrap key');
  return `#cloud-config
ssh_pwauth: false
disable_root: true
users:
  - name: pilot-diagnostic
    shell: /bin/bash
    lock_passwd: true
    sudo: ALL=(ALL) NOPASSWD:ALL
write_files:
  - path: /etc/repo-chap-pilot-run
    permissions: '0644'
    content: '${run.id}'
  - path: /run/pilot-auth
    permissions: '0600'
    content: '${key}'
runcmd:
  - [sh, -c, 'systemctl disable --now ssh.service ssh.socket || true']
  - [sh, -c, 'apt-get update && apt-get install -y curl ca-certificates sudo git tar xz-utils']
  - [sh, -c, 'curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg && curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list && apt-get update && apt-get install -y tailscale']
  - [sh, -c, 'tailscale up --auth-key=file:/run/pilot-auth --ssh --hostname=${run.name}; result=$?; rm -f /run/pilot-auth; exit $result']
`;
}

export async function validateInputs(run) {
  await privateDirectory(run.configDirectory);
  const dedicated = await privateDirectory(run.codexHome);
  const normal = process.env.CODEX_HOME ?? join(process.env.HOME, '.codex');
  if (dedicated === resolve(normal) || dedicated === resolve(process.env.HOME, '.codex')) throw new PilotError('Select a dedicated pilot CODEX_HOME, not the normal operator cache');
  await privateRead(join(run.codexHome, 'auth.json'));
  const files = await readdir(run.configDirectory);
  if (!files.length || files.length > 40 || files.some(f => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(f))) throw new PilotError('Use a flat private configuration directory with up to 40 plain filenames');
  for (const f of files) await privateRead(join(run.configDirectory, f));
  let config;
  try { config = JSON.parse(await privateRead(join(run.configDirectory, 'installation.json'))); }
  catch { throw new PilotError('Private configuration needs installation.json'); }
  const paths = [config.providerConfig, config.app?.privateKeyFile, ...(config.applyPolicies ?? []), ...(config.slack ? [config.slack.tokenFile] : [])];
  if (paths.some(p => typeof p !== 'string' || !p.startsWith('/etc/repo-chap/') || !files.includes(p.slice('/etc/repo-chap/'.length))))
    throw new PilotError('All installation file references must select supplied files directly under /etc/repo-chap');
  return files;
}

const prerequisites = `set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update >/dev/null
apt-get install -y curl ca-certificates git sudo tar xz-utils libicu74 >/dev/null
export VP_HOME=/opt/vite-plus
export PATH=/opt/vite-plus/bin:$PATH
if [ ! -x /opt/vite-plus/bin/vp ]; then
  curl -fsSL https://viteplus.dev/install.sh -o /run/install-vp.sh
  VP_VERSION=${versions.vitePlus} bash /run/install-vp.sh >/dev/null
  rm -f /run/install-vp.sh
fi
cd /opt
vp env pin ${versions.node} --target node-version >/dev/null
ln -sf "$(vp node -p process.execPath)" /usr/local/bin/node
vp exec npm install --global --prefix /opt/repo-chap-tools @openai/codex >/dev/null
ln -sf /opt/repo-chap-tools/bin/codex /usr/local/bin/codex
`;

export async function provisionHost(pilot, run) {
  const files = await validateInputs(run);
  // Enrollment can precede completion of cloud-init and network setup.
  await pilot.ssh(run, 'sudo timeout 120 cloud-init status --wait >/dev/null', undefined, 125000);
  await pilot.ssh(run, 'sudo bash -s', prerequisites, 300000);
  const directory = pilot.store.directory(run.id);
  const payload = join(directory, 'transfer');
  await rm(payload, { recursive: true, force: true });
  await mkdir(join(payload, 'config'), { recursive: true, mode: 0o700 });
  try {
    for (const file of files) await writePrivate(join(payload, 'config', file), await privateRead(join(run.configDirectory, file)));
    await writePrivate(join(payload, 'auth.json'), await privateRead(join(run.codexHome, 'auth.json')));
    const cli = await readFile(new URL('../../apps/cli/dist/cli.js', import.meta.url));
    run.release = createHash('sha256').update(cli).digest('hex');
    await writePrivate(join(payload, 'cli.js'), cli);
    for (const file of ['install.sh', 'repo-chap.service']) await copyFile(new URL(`../${file}`, import.meta.url), join(payload, file));
    await pilot.accounts.io.command('tar', ['-czf', join(directory, 'transfer.tgz'), '-C', payload, '.']);
    await pilot.ssh(run, 'sudo install -d -m 0700 /opt/repo-chap-pilot-transfer && sudo tar -xzf - -C /opt/repo-chap-pilot-transfer', await readFile(join(directory, 'transfer.tgz')), 120000);
    await pilot.ssh(run, 'sudo bash -s', `set -eu
systemctl stop repo-chap.service || true
cd /opt/repo-chap-pilot-transfer
bash install.sh cli.js ${run.release} /usr/local/bin/node >/dev/null
install -d -m 0700 -o repo-chap -g repo-chap /var/lib/repo-chap-home/pilot-codex
install -m 0600 -o repo-chap -g repo-chap auth.json /var/lib/repo-chap-home/pilot-codex/auth.json
for file in config/*; do install -m 0600 -o repo-chap -g repo-chap "$file" /etc/repo-chap/; done
for unit in repo-chap repo-chap-diagnostics; do
  install -d -m 0755 /etc/systemd/system/$unit.service.d
  printf '[Service]\\nEnvironment=CODEX_HOME=/var/lib/repo-chap-home/pilot-codex\\n' > /etc/systemd/system/$unit.service.d/pilot.conf
done
systemctl daemon-reload
systemctl start repo-chap-diagnostics.service
systemctl enable --now repo-chap.service
rm -rf /opt/repo-chap-pilot-transfer
`, 120000);
  } finally {
    await rm(payload, { recursive: true, force: true });
    await rm(join(directory, 'transfer.tgz'), { force: true });
  }
  await pilot.checkpoint(run, 'registering-runner');
  const existing = await pilot.runners(run);
  if (!existing.length) {
    const token = await pilot.accounts.gh(`repos/${run.repository}/actions/runners/registration-token`, 'POST');
    if (typeof token.token !== 'string' || !/^[a-zA-Z0-9_]+$/.test(token.token) || Date.parse(token.expires_at) <= Date.now()) throw new PilotError('Runner registration token missing or expired');
    // Identity is durable before the registration side effect; resume reconciles by name and label.
    await pilot.checkpoint(run, 'runner-token-minted');
    await pilot.ssh(run, 'sudo bash -s', `set -eu
id pilot-runner >/dev/null 2>&1 || useradd --system --user-group --home-dir /opt/repo-chap-runner --shell /bin/bash pilot-runner
install -d -m 0700 -o pilot-runner -g pilot-runner /opt/repo-chap-runner
cd /opt/repo-chap-runner
curl -fsSL https://github.com/actions/runner/releases/download/v${versions.runner}/actions-runner-linux-x64-${versions.runner}.tar.gz -o /run/runner.tgz
printf '${runnerDigest}  /run/runner.tgz\\n' | sha256sum -c - >/dev/null
tar -xzf /run/runner.tgz
rm /run/runner.tgz
chown -R pilot-runner:pilot-runner .
# A missing API registration permits replacing stale local runner credentials.
rm -f .runner .credentials .credentials_rsaparams
sudo -u pilot-runner env ACTIONS_RUNNER_INPUT_TOKEN='${token.token}' ./config.sh --unattended --url https://github.com/${run.repository} --name ${run.name} --labels ${run.name} --no-default-labels --work _work >/dev/null
`, 180000);
  }
  const runners = await pilot.runners(run);
  if (runners.length !== 1) throw new PilotError('Runner registration outcome unknown; cleanup or resume this run');
  run.runnerId = runners[0].id;
  await pilot.checkpoint(run, 'runner-registered');
  const installed = await pilot.ssh(run, 'sudo bash -s', `set -eu
cat > /etc/systemd/system/repo-chap-runner.service <<'UNIT'
[Unit]
Description=Repo Chap disposable trusted repository runner
After=network-online.target
[Service]
User=pilot-runner
Group=pilot-runner
WorkingDirectory=/opt/repo-chap-runner
ExecStart=/opt/repo-chap-runner/run.sh
Restart=on-failure
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now repo-chap-runner.service
systemctl is-active --quiet repo-chap.service repo-chap-runner.service
node --version
/opt/vite-plus/bin/vp --version | head -1
tailscale version | head -1
/opt/repo-chap-tools/bin/codex --version
/opt/repo-chap-runner/bin/Runner.Listener --version
`, 30000);
  const observed = installed.trim().split('\n');
  if (observed.length !== 5 || observed.some(value => !/^(?:v|vp v|codex-cli )?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value)) ||
      !observed[0].startsWith('v24.') || !observed[1].endsWith(versions.vitePlus) || !observed[4].endsWith(versions.runner))
    throw new PilotError('Installed tools did not report supported versions');
  run.versions = { ...versions, observed, repoChapRelease: run.release };
}

export async function diagnoseHost(pilot, run) {
  const raw = await pilot.ssh(run, 'sudo bash -s', `set -eu
printf 'services\\n'
systemctl show repo-chap.service repo-chap-runner.service -p ActiveState -p SubState -p Result
printf 'permissions\\n'
find /etc/repo-chap /var/lib/repo-chap-home/pilot-codex -maxdepth 1 -type f -printf '%u %m\\n' | head -40
printf 'disk\\n'
df -Pk /var/lib/repo-chap | tail -1 | awk '{print $2, $3, $4, $5}'
printf 'journal\\n'
journalctl -u repo-chap.service -u repo-chap-runner.service -n 50 --since '-15 minutes' -o json --no-pager | python3 -c 'import sys,json; [print(json.dumps({k:v for k,v in json.loads(l).items() if k in ("__REALTIME_TIMESTAMP","PRIORITY","_SYSTEMD_UNIT")})) for l in sys.stdin]'
`, 30000);
  // Allow-list diagnostic values. Journal message bodies can contain arbitrary private code or tokens.
  const safe = raw.split('\n').filter(line => /^(services|permissions|disk|journal)$/.test(line) || /^(ActiveState|SubState|Result)=[a-z-]+$/.test(line) || /^(repo-chap|root) [0-7]{3,4}$/.test(line) || /^[0-9 ]+\d%$/.test(line) || /^\{.*\}$/.test(line) && (() => {
    try { const value = JSON.parse(line); return Object.entries(value).every(([k,v]) => ['__REALTIME_TIMESTAMP', 'PRIORITY', '_SYSTEMD_UNIT'].includes(k) && /^(\d+|repo-chap(?:-runner)?\.service)$/.test(v)); } catch { return false; }
  })()).join('\n').slice(0, 32768);
  await writePrivate(join(pilot.store.directory(run.id), 'diagnostics.txt'), safe + '\n');
  return safe;
}
