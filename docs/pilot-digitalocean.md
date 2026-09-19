# Disposable DigitalOcean pilot

This opt-in pilot creates one Ubuntu VM, one Project, a firewall with no inbound
rules, four unique ownership tags, one Tailscale device, and one repository
Actions runner. The operator runs the commands on a Mac or Linux tailnet client.
There is no public service endpoint and no scheduled reaper.

A Droplet keeps billing when powered off. Deleting a Project does **not** delete
its resources. A successful `up` deliberately leaves the VM running. Use
`cleanup`, then `verify-clean`, before considering the pilot finished. This
implementation creates no volumes, snapshots, reserved IPs or backups. Do not
add them manually to a pilot; unexpected project/tag inventory prevents a clean
result and requires console inspection.

## Prepare the operator machine

Install Vite+, Terraform **1.14.7**, GitHub CLI, the Tailscale CLI and `tar`.
Connect the machine to the intended tailnet. Run `gh auth login` with admin
access to one dedicated **private**, trusted test repository. Its workflows must
use only this pilot's unique runner label. Do not run arbitrary pull-request
code or fork workflows on this host. A runner job can compromise the host and
its provider/configuration credentials, even though the runner and daemon use
different accounts.

Use an active DigitalOcean account with permission to read/create/delete
Droplets, Projects, firewalls and tags. Set `DIGITALOCEAN_TOKEN` in the operator's
process environment using your secret manager. The provider reads it from the
environment; it is never a Terraform input. Keep the same account for the run.

Create a Tailscale OAuth client with only `auth_keys` and `devices:core`, limited
to `tag:repo-chap-pilot`. Set `TAILSCALE_CLIENT_ID` and
`TAILSCALE_CLIENT_SECRET` in the operator environment. The local process requests
an access token and mints a preapproved, one-use, ephemeral auth key with a
10-minute expiry. The VM receives only that auth key, never the OAuth secret.
The temporary auth key may remain in cloud-init and protected local Terraform
state/backups until cleanup. Its single use and short lifetime limit exposure;
do not publish those files even after expiry.

A minimal fictional tailnet policy for a pilot-only tailnet is:

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

Merge this deliberately into an existing policy. Remove broader grants that
would otherwise permit unwanted access. `pilot-diagnostic` has sudo for install
and recovery and authenticates through Tailscale SSH, with no public SSH key or
password. An agent can use this identity only when the operator permits it to
execute these local commands. Granting that permission gives the agent the same
VM administration access as the operator.

Build the selected Repo Chap checkout with `vp install --frozen-lockfile` and
`vp run build`. The pilot transfers that CLI bundle, identifies it by SHA-256,
and invokes `deploy/install.sh` with the existing private systemd unit. It
installs Node 24.21.0 using Vite+ 0.3.0, Codex CLI 0.154.0, Tailscale 1.94.2,
and Actions runner 2.337.0. The runner archive has a pinned SHA-256 check. Ubuntu
security packages are installed through apt. Installed application versions and
the CLI digest are recorded in the manifest. Review these pins before a new
pilot; runner automatic updates remain enabled to satisfy GitHub's update policy.

Create a dedicated provider login directory, separate from your normal
`CODEX_HOME`. Authenticate that dedicated profile before provisioning. Only its
`auth.json` is transferred. No normal operator cache is selected implicitly.
Prepare a flat mode-0700 configuration directory containing mode-0600
`installation.json`, provider profiles, the GitHub App PEM key, any apply
policies, and optional Slack token file. All file references in installation.json
must refer to supplied files directly under `/etc/repo-chap/` on the VM. See
[daemon configuration](daemon-operations.md#install-and-check-the-account).
The service sets `CODEX_HOME=/var/lib/repo-chap-home/pilot-codex`.

```sh
vp run pilot prepare --root /absolute/private/repo-chap-pilot
# Edit the generated operator.json. It contains fictional values and paths.
vp run pilot prepare --root /absolute/private/repo-chap-pilot
# Copy the printed run ID into the following commands.
vp run pilot up --root /absolute/private/repo-chap-pilot --run RUN_ID --dry-run
vp run pilot up --root /absolute/private/repo-chap-pilot --run RUN_ID
```

The first prepare validates CLIs and account access and writes a redacted
template. The second validates the chosen repository and private files, then
creates a random run ID with creation/expiry metadata. Everything private stays
in that external operator directory, which also contains an ignore-all
`.gitignore`. Symlinks, Git directories and public file modes are rejected.
The dry run prints intended resources, versions and local paths without contacting
APIs, reading credentials, running Terraform or creating resources.

## Operate and finish

```sh
vp run pilot status --root /absolute/private/repo-chap-pilot --run RUN_ID
vp run pilot ssh --root /absolute/private/repo-chap-pilot --run RUN_ID
vp run pilot diagnose --root /absolute/private/repo-chap-pilot --run RUN_ID
vp run pilot cleanup --root /absolute/private/repo-chap-pilot --run RUN_ID
vp run pilot verify-clean --root /absolute/private/repo-chap-pilot --run RUN_ID
vp run pilot reap --root /absolute/private/repo-chap-pilot --older-than 24h
vp run pilot reap --root /absolute/private/repo-chap-pilot --older-than 24h --confirm
```

`ssh` and `diagnose` verify the selected device's run name, tag and recorded ID
before connecting to its tailnet DNS name. They never create or destroy
infrastructure. Diagnostics store bounded service state, owner/mode checks, disk
usage and recent journal timestamps, priorities and unit names. Journal message
bodies are omitted because they can contain arbitrary repository text and
credentials. Command errors never print raw child/API output. Diagnose does not
copy configuration or authentication contents.

Commands exit 0 on success and 64 for invalid command syntax. `status` and
`verify-clean` return 1 until all resources and registrations are absent;
a healthy running pilot therefore returns 1. Setup failure returns 1 even when
automatic cleanup succeeds. Cleanup returns 1 when verification remains
unresolved or inaccessible. Each category reports `absent`, `unresolved`,
`inaccessible`, or `unknown`, with identifiers and console links. GitHub CLI
failures are `unknown` because its exit code does not distinguish authorization
from transport failures.

Ordinary setup failure or Ctrl-C defaults to cleanup once infrastructure may
exist. To deliberately retain the VM for diagnosis, pass `--retain-on-failure`
**before** provisioning. Retention always prints ongoing billing and the exact
cleanup command. Repeating `up` for that run resumes installation on its existing
VM and reconciles runner identity before registering. An interrupted apply with
incomplete Droplet, Project, firewall or tag inventory must be cleaned before
preparing a new run. Do not rerun
Terraform apply manually when state is missing or corrupt.

Cleanup captures diagnostics and attempts service shutdown while tailnet access
still exists, then removes the runner and Tailscale registration with deadlines.
The final stage attempts Terraform destroy and independent DigitalOcean deletion
using complete ownership markers. Missing/corrupt Terraform state does not stop
the API deletion path. Unreachable VMs and registration failures do not stop
infrastructure deletion. SIGINT during cleanup leaves the bounded cleanup running;
SIGKILL or power loss cannot be trapped, so rerun cleanup when the operator
machine returns. Each API/command has a deadline; inventory has a page limit.

`reap` previews locally recorded runs older than the requested age. Confirmation
calls the same cleanup for each run and refuses incomplete ownership markers.
It does not discover runs whose entire operator directory was lost, and makes no
guarantee while the operator machine is offline. Preserve the private directory
until independent verification is complete. If it is lost, inspect DigitalOcean
Projects and tags starting `rcp-`, GitHub runner settings and Tailscale machines
in the consoles. Never delete merely by a familiar-looking tag prefix.

| State or failure | Recovery |
| --- | --- |
| `prepared` | Review dry run, then `up` |
| `retained` | Diagnose, repeat `up`, or run `cleanup` immediately |
| `running` | Finish both jobs, then `cleanup` |
| `cleanup-pending` | Restore account access and repeat `cleanup`; infrastructure is not recreated |
| `clean` | Run read-only `verify-clean` and preserve its result privately |
| Corrupt manifest | Restore `manifest.backup.json` after checking its run ID and account |
| Stale `.pilot.lock` | Verify its PID has exited before deleting the external lock file |
| Failed tailnet enrollment | Use the DigitalOcean recovery console to inspect cloud-init/tailscaled; otherwise clean the run |
| Lost provider login | Use console/tailnet shell, then `sudo -u repo-chap env HOME=/var/lib/repo-chap-home CODEX_HOME=/var/lib/repo-chap-home/pilot-codex /usr/local/bin/codex login --device-auth` |
| Unknown extra resources | Inspect the linked console; remove only resources with proven pilot ownership, then verify again |

The cloud firewall permits outbound TCP 80/443 for apt/downloads/APIs and DERP,
TCP/UDP 53 for DNS, UDP 123 for time and UDP 3478 for STUN. It has no inbound
rules. Tailscale can use relays; public TCP 22 stays closed. DigitalOcean recovery
console access is the fallback when the tailnet cannot enroll. Do not enable
public SSH as a shortcut.

To revoke access, remove the operator's tailnet grant/SSH rule or disable
Tailscale SSH through a permitted session with `sudo tailscale set --ssh=false`.
Revoke the OAuth client and any unused keys in Tailscale administration. Revoke
the dedicated Codex login, rotate the App key and optional Slack token if exposed,
and revoke the DigitalOcean/GitHub operator tokens when no longer needed. These
actions do not stop billing; still run cleanup or use the DigitalOcean console.

For the complete operator scenario, fictional PR generator and no-credentials
rehearsal, use the [guided pilot](pilot-guide.md).

## Two-job pilot fixture

The live integration command provisions through the same host installer, checks
that the installed runner service is active on the recorded VM, dispatches two
GitHub Actions workflow runs, and verifies native GitHub job records. It requires
two distinct heads, the expected failure then success, and the same recorded
runner ID/name and unique label on both jobs. It cleans up after success or
failure by default. This command creates paid resources and dispatches jobs only
when passed `--confirm`.

In the dedicated private test repository, copy
`deploy/pilot/trusted-workflow.yml` to `.github/workflows/pilot.yml` on the default
branch. Create two branches that also contain that workflow. On `pilot-failing`,
put `exit 1` in `pilot-check.sh`. On `pilot-repaired`, repair that script so it
exits 0. Both branches must remain unchanged during the fixture. The persistent
runner has only the unique pilot label, with no one-job ephemeral flag.

```sh
vp run test:pilot:integration --root /absolute/private/repo-chap-pilot \
  --run RUN_ID --workflow pilot.yml \
  --failing-ref pilot-failing --repaired-ref pilot-repaired
# After reviewing the printed target, append --confirm to run it.
```

`integration.json` records commit, workflow run, job and runner IDs and both
observed conclusions outside Git. A dispatch intent is durable before sending
it. If the response is lost, a retained resume finds the matching correlation
instead of dispatching a duplicate. Pass `--retain-on-failure` with `--confirm`
only when retaining the VM for diagnosis is intended, then repeat the same
command to resume. Ctrl-C between the jobs defaults to cleanup. A changed
reference or ambiguous dispatch stops the fixture. A completed fixture's
`verify-clean` must report all categories absent.

The automated command/API tests cover this integration controller, wrong-runner
rejection, interrupted observation between jobs and lost dispatch responses.
Those tests use fake APIs; they do not prove that a live account or runner works.
Use the opt-in command above for actual installation and two-job evidence, and
retain its external checkpoint. No live cloud run is part of the default test
suite.

Before finishing, check all of the following:

- `verify-clean` reports DigitalOcean `absent`, after checking run name/tag and
  Project inventory independently of Terraform state.
- The DigitalOcean console has no pilot Droplet, firewall, Project or tags, and
  no unexpected volumes, snapshots, reserved IPs or backups.
- GitHub reports the recorded runner absent and Tailscale reports the device absent.
- Any unresolved result has been retried or investigated in its linked console.
- Private evidence/state remains outside Git; expire or remove credential copies
  and Terraform state only after the checks above.

Provider contracts: [DigitalOcean firewall](https://docs.digitalocean.com/reference/terraform/reference/resources/firewall/),
[Tailscale OAuth](https://tailscale.com/docs/features/oauth-clients),
[Tailscale firewall ports](https://tailscale.com/docs/reference/faq/firewall-ports),
and [GitHub repository runners](https://docs.github.com/en/rest/actions/self-hosted-runners).
