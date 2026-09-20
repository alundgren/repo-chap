# Disposable DigitalOcean environment

The environment contains one Ubuntu 24.04 Droplet, one Project, a firewall with
no inbound rules, four ownership tags, one ephemeral Tailscale device, and one
repository Actions runner. It has no public service endpoint or public SSH.

A powered-off Droplet still bills. Creating an environment never schedules its
deletion. Finish with `pilot delete` and `pilot verify-clean`.

## Operator machine

Install Git, GitHub CLI, OpenSSH, tar, Terraform 1.x, a connected Tailscale
client, and the repository-pinned Vite+ tools. The macOS App Store Tailscale
variant is supported because the pilot uses the regular `ssh` client after it
verifies the destination through the Tailscale API. Build the selected revision:

```sh
vp install --frozen-lockfile
vp run build
```

Authenticate `gh` with admin access to one dedicated private test repository.
Use only trusted repository code. The persistent runner can read the daemon's
local credentials if a workflow deliberately attacks the host.

Set these secrets in the process running create or use
`deploy/pilot/setup.sh`, which reads them without saving them:

- `DIGITALOCEAN_TOKEN` for an active account that may manage Droplets,
  Projects, firewalls, and tags.
- `TAILSCALE_CLIENT_ID` and `TAILSCALE_CLIENT_SECRET` for an OAuth client limited
  to `auth_keys` and `devices:core` for `tag:repo-chap-pilot`.

The wizard cannot export credentials to its parent shell. Load all three again
from your secret manager before test, status, SSH, delete, or `verify-clean`.
The test also uses the existing GitHub CLI login; no GitHub token is copied to
the environment.

The process mints a preapproved, one-use, ephemeral Tailscale auth key with a
ten-minute expiry. The VM receives that key, never the OAuth secret.

Use a narrow tailnet policy. This fictional example permits one operator to
reach only the pilot tag and to connect as `pilot-diagnostic`:

```json
{
  "tagOwners": { "tag:repo-chap-pilot": ["alex@example.com"] },
  "grants": [
    { "src": ["alex@example.com"], "dst": ["tag:repo-chap-pilot"], "ip": ["tcp:22"] }
  ],
  "ssh": [
    {
      "action": "accept",
      "src": ["alex@example.com"],
      "dst": ["tag:repo-chap-pilot"],
      "users": ["pilot-diagnostic"]
    }
  ]
}
```

Merge this into the actual policy deliberately. Existing broader grants still
apply. The diagnostic account has sudo, so access is equivalent to VM
administration.

## Private daemon inputs

Create these outside every Git checkout:

- A dedicated mode-0700 `CODEX_HOME` containing its own mode-0600 `auth.json`.
- A flat mode-0700 configuration directory with mode-0600 files.
- `installation.json`, provider profiles, the repository-scoped GitHub App PEM,
  and any apply policy needed by the fixed test.

All paths inside `installation.json` must name files directly under
`/etc/repo-chap/`, because create copies the flat directory there. Slack is not
needed. See [daemon configuration](daemon-operations.md#install-and-check-the-account)
and [conditional push](conditional-push.md) for the file contracts.

`operator.json` contains only non-secret selections:

```json
{
  "repository": "example-team/pilot-test",
  "region": "ams3",
  "size": "s-2vcpu-4gb",
  "digitalOceanSshKeyFingerprint": "00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff",
  "configDirectory": "/absolute/private/pilot-config",
  "codexHome": "/absolute/private/pilot-codex"
}
```

The setup wizard creates a dedicated Ed25519 keypair in the private operator
directory if it does not already exist. It prints the `.pub` path and waits for
the operator to register that public key with DigitalOcean. Only the public
fingerprint is stored in `operator.json`; no machine-specific path or key enters
the repository. Attaching the registered key prevents DigitalOcean from
emailing a temporary root password. The firewall still denies public inbound
traffic, cloud-init disables the normal SSH server, and operator access
continues through Tailscale SSH.

The operator directory and generated files use modes 0700 and 0600. Symlinks,
Git directories, public modes, nested configuration, and the normal operator
Codex cache are rejected.

## Lifecycle

Follow [the three-phase guide](pilot-guide.md):

```sh
vp run pilot create --root /absolute/private/repo-chap-pilot
vp run pilot test --root /absolute/private/repo-chap-pilot \
  --environment ENVIRONMENT_ID
vp run pilot delete --root /absolute/private/repo-chap-pilot \
  --environment ENVIRONMENT_ID
vp run pilot verify-clean --root /absolute/private/repo-chap-pilot \
  --environment ENVIRONMENT_ID
```

Create installs the repository's Node and Vite+ versions, the current Tailscale
and Codex releases available from their normal package sources, and Actions
runner 2.337.0 with its checked digest. It records the Repo Chap CLI digest and
observed tool versions in the private environment manifest.

Test failure never deletes the host. Use the environment ID and the approved
tailnet route described in [SSH diagnosis](pilot-ssh-debugging.md). The test can
be rerun after a correction.

Delete first attempts bounded service shutdown, runner removal, and Tailscale
removal. It then runs Terraform destroy and independently inventories owned
DigitalOcean resources. If Terraform state is missing or corrupt, deletion uses
the API ownership markers. Unexpected project resources or ambiguous ownership
stop deletion rather than selecting by a familiar name alone.

`verify-clean` is read-only. It reports each category as `absent`, `unresolved`,
`inaccessible`, or `unknown`. Only three `absent` results mean the environment
is gone. Preserve the private operator directory until then.

## Recovery

| Saved stage | Next action |
| --- | --- |
| `prepared` | Preview and confirm create. |
| `retained` | Diagnose over approved Tailscale SSH, resume create, or delete. |
| `running` | Run or rerun test, inspect through approved SSH, or delete. |
| `cleaning` or `cleanup-pending` | Restore account access and repeat delete. |
| `clean` | Run `verify-clean` and retain its result privately. |
| Missing or corrupt Terraform state | Run delete; the verified API fallback handles recorded ownership. |
| Corrupt manifest | Restore `manifest.backup.json` after checking its environment ID. |
| Stale `.pilot.lock` | Confirm its recorded process has exited before removing it. |

If the tailnet cannot enroll, use the DigitalOcean recovery console. Public
port 22 remains closed. Losing the entire operator directory requires manual
inspection of DigitalOcean Projects and tags beginning `rcp-`, repository
runner settings, and Tailscale machines. Never delete by prefix alone.
