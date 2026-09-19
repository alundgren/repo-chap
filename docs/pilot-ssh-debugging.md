# Diagnose a retained environment over Tailscale

Use this procedure when a test fails and an environment ID remains running.
The operator directory, repository evidence, addresses, and logs are private.

## Permission and identity

Obtain explicit operator permission for tailnet access to the named environment
ID before connecting. Permission for one environment does not cover another
environment, broader tailnet policy, credential changes, repository mutations,
or infrastructure changes.

Start with the read-only inventory from the operator Mac:

```sh
vp run pilot status --root /absolute/private/repo-chap-pilot \
  --environment ENVIRONMENT_ID
```

A running environment returns nonzero because resources are present. Check that
the output names the expected environment and repository. Inspect the private
test checkpoint at:

```text
/absolute/private/repo-chap-pilot/ENVIRONMENT_ID/test.json
```

Connect only through the pilot command:

```sh
vp run pilot ssh --root /absolute/private/repo-chap-pilot \
  --environment ENVIRONMENT_ID
```

The command resolves the environment manifest, then requires exactly one
Tailscale device with the recorded device ID, `rcp-ENVIRONMENT_ID` hostname,
and `tag:repo-chap-pilot`. It connects as `pilot-diagnostic`. Do not replace it
with public SSH or an unverified hostname.

## Read-only inspection

On the host, inspect state before proposing a change:

```sh
cat /etc/repo-chap-pilot-run
sudo systemctl show repo-chap.service repo-chap-runner.service \
  -p ActiveState -p SubState -p Result
sudo -u repo-chap -H /opt/repo-chap/current/repo-chap daemon status \
  --state-dir /var/lib/repo-chap
sudo journalctl -u repo-chap.service -u repo-chap-runner.service \
  --since '-30 minutes' --no-pager
df -h /var/lib/repo-chap
sudo find /etc/repo-chap /var/lib/repo-chap-home/pilot-codex \
  -maxdepth 1 -type f -printf '%u %g %m %p\n'
```

Confirm `/etc/repo-chap-pilot-run` equals the requested environment ID. Keep
journal messages and file names private because repository text and credential
paths may appear. Read file contents only when the diagnosis requires them, and
never copy secrets into chat, an issue, a commit, or a pull request.

For a bounded configuration and account check:

```sh
sudo -u repo-chap -H env \
  CODEX_HOME=/var/lib/repo-chap-home/pilot-codex \
  /opt/repo-chap/current/repo-chap daemon diagnose \
  --state-dir /var/lib/repo-chap \
  --config /etc/repo-chap/installation.json --json
```

This checks configuration, provider login, GitHub App access, storage, and
required executables. It does not make a model request, run a repository check,
send Slack, or change a pull request.

## Changes and retest

Before restarting a service, editing a file, changing credentials, modifying
tailnet policy, or mutating GitHub or DigitalOcean, show the operator the exact
command, what it changes, and the likely failure if it goes wrong. Wait for
approval of that action.

After an approved correction, leave the SSH session and rerun the fixed suite
from the Mac:

```sh
vp run pilot test --root /absolute/private/repo-chap-pilot \
  --environment ENVIRONMENT_ID --confirm
```

Finish by deleting the environment and independently verifying absence:

```sh
vp run pilot delete --root /absolute/private/repo-chap-pilot \
  --environment ENVIRONMENT_ID --confirm
vp run pilot verify-clean --root /absolute/private/repo-chap-pilot \
  --environment ENVIRONMENT_ID
```
