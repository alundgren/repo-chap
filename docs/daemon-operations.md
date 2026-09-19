# Linux service operations

The service runs as one unprivileged account on one Linux machine. It uses local
persistent SQLite and immutable artifacts outside managed repositories, with a
private Unix control socket. It opens no public listener and needs no inbound
webhook. GitHub, provider and optional Slack access are outbound connections.

## Install and check the account

Install Node 24, Git, systemd and the provider CLIs you intend to use. Build with
the pinned package manager: `vp install --frozen-lockfile`, then
`vp run build`. Copy the bundled `apps/cli/dist/cli.js` and `deploy/` to
the VM. From that copy, run as root:

```sh
bash deploy/install.sh apps/cli/dist/cli.js release-0.1 /usr/local/bin/node
```

The installer creates `repo-chap` with no login shell, validates the units and
selects the release through `/opt/repo-chap/current`. It does not start the
service. Repeating the same release and bundle is safe; different bytes require
a new release ID. The chosen Node executable must remain installed at its path.

| Path | Purpose and access |
| --- | --- |
| `/opt/repo-chap/releases/<release>` | Root-owned CLI and Node launcher |
| `/opt/repo-chap/bin` | Root-managed provider/tool launchers on service PATH |
| `/etc/repo-chap` | Account-owned 0700 directory; configuration and keys 0600 |
| `/var/lib/repo-chap-home` | Account-owned 0700 HOME; supported provider login stores |
| `/var/lib/repo-chap` | Account-owned 0700 state on local persistent storage |
| `runtime.sqlite`, `runtime.sqlite-wal`, `runtime.sqlite-shm` | Private database and active journals in state |
| `artifacts/`, `repairs/` | Private durable artifacts and repair attempt receipts in state |
| `control.sock` | Mode 0600 Unix socket in state; CLI runs as the same account |

Create `/etc/repo-chap/installation.json` using the
[installation example](daemon-analysis.md#start-and-register), with absolute
paths under `/etc/repo-chap`. Configure a [Codex](codex-analysis.md) or
[Claude](claude-analysis.md) profile, the App ID, installation ID and private key.
The App must have the documented repository read permissions. Add private
[apply policies](conditional-push.md) only for intended writes and optional
[Slack settings](slack-handoffs.md) separately. Keep local apply and daemon state
directories separate.

Install repository toolchains and dependencies needed by each policy's required
checks. Put the provider executables on the service PATH or use absolute profile
paths. Establish supported provider authentication as this account with
`sudo -u repo-chap -H`; do not copy another person's credential directory.
If a provider needs environment settings, put them in an account-readable private
environment file and configure `EnvironmentFile=` in matching service and
diagnostics unit drop-ins. Do not put credentials in arguments or repository files.

The installed units use the same account, HOME, PATH and filesystem restrictions.
The service can write its state and HOME; the rest of the filesystem is read-only,
other home directories are hidden, and temporary files are private. Run diagnostics
in that environment before starting:

```sh
sudo systemctl start repo-chap-diagnostics.service
sudo journalctl -u repo-chap-diagnostics.service -n 80 --no-pager
sudo systemctl enable --now repo-chap.service
sudo -u repo-chap -H /opt/repo-chap/current/repo-chap daemon status \
  --state-dir /var/lib/repo-chap
```

`daemon diagnose --state-dir /var/lib/repo-chap --config
/etc/repo-chap/installation.json --json` also checks its invoking account. It
reports Linux/Node/account access, private configuration, a synced storage probe,
available bytes, Git, provider capabilities and login status, App token issuance,
registered/policy repository reads and required-check executable access. It does
not open or migrate the runtime through the scheduler, make a model call, run
repository checks or send Slack messages. Provider entitlement, repository
dependency installation and Slack permissions need their own actual trials.

Executable paths such as `./scripts/check`, or commands available only through
relative PATH entries, require a candidate checkout. Diagnostics report that
tooling check as incomplete with exit 7 and name the affected check IDs. Verify
those commands in the retained candidate workspace; diagnostics do not search
for a similarly named executable elsewhere or change the execution policy.

Failure messages name the check and correction without raw provider output or
credential values. Fix private file ownership/modes, executable paths, login,
App repository selection or outbound access as indicated. At least 512 MiB free
is required by diagnostics; that is a startup check, not a capacity estimate.
Allow additional space for source history, workers and a complete backup.
Commands return exit 7 on failure; inspect JSON `ok` and the check list.

## Stop, upgrade and inspect

Use `systemctl stop repo-chap.service` before maintenance. SIGTERM stops polling
and active providers; systemd stops the process group after 45 seconds if needed.
Verify `systemctl is-active` reports inactive and the socket is gone. A killed
process can leave uncertain effects; starting again preserves their records for
reconciliation. A live recorded PID blocks a second owner, including backup.
Inspect a reused PID before any manual owner cleanup.

For an upgrade: stop, create a coherent backup below, install a distinct release
ID, run account diagnostics, start and inspect status/inbox. Schema 1, 2 and 3
upgrade to schema 4. Migration first acquires the existing process ownership
record, so a live older daemon prevents mutation. Schema 4 adds the durable
installation recovery pause; older binaries reject it rather than ignore it.
Rolling back the release symlink alone cannot downgrade a schema-4 database.
Use a compatible release, or the older release's own complete pre-upgrade backup.
[Workflow rollback](workflow-activation.md) selects a retained package and is
separate from binary/database recovery.

`journalctl -u repo-chap.service` contains operational messages. Restrict journal
access and set host journal size/age policy for the VM. Keep detailed evidence,
check logs and backups private. The daemon does not print App tokens or provider
authentication output. Artifacts can contain sensitive repository text.

## Coherent backup

Run as `repo-chap` after stopping the service and any other command using this
state. The destination must be new, outside the source, under a private writable
parent with room for the complete snapshot:

```sh
sudo -u repo-chap -H /opt/repo-chap/current/repo-chap daemon backup \
  /var/lib/repo-chap-home/backups/before-upgrade \
  --state-dir /var/lib/repo-chap --config /etc/repo-chap/installation.json
```

The command acquires the process ownership record before changing anything in
the database. SQLite's backup API captures committed WAL data into a standalone
database; ordinary copying of a live `runtime.sqlite` is insufficient. It copies
all durable artifact files and repair receipts, then checks SQLite integrity,
file sizes/digests and known references before publishing a completed directory.
All database tables survive, including versions, waits, holds, migrations,
reservations, provider/repair attempts, effect receipts and Slack requests,
deliveries, rates, DM records and resend history.

Reference checks cover the supported runtime jobs/results, workflow versions,
observations, effect payloads, Slack packets/previews and repair
source/candidate/check artifacts. Ordinary workflow JSON is not interpreted as
file references. Future database rows remain intact, but unknown future artifact
formats require a compatible release. The bound is 100,000 files, a 16 GiB
database, 32 MiB per runtime artifact, 128 MiB per execution artifact and 16 KiB per repair attempt receipt, matching the
execution receipt reader. The inventory is bounded at 32 MiB. Oversize or corrupt
state blocks backup rather than producing an incomplete success.

Worker/source caches and pending temporary files are disposable and excluded.
Installation JSON, App keys, Slack tokens and provider login stores require
separate protected recovery. Preserve the private policies/profile choices and
supported authentication needed to interpret and operate the restored state.
Store backups off the VM through the team's protected backup process; this
command does not provide encryption, remote storage or scheduled retention.

## Restore and release recovery

Restore to a new directory as the service account, with the service stopped:

```sh
sudo -u repo-chap -H /opt/repo-chap/current/repo-chap daemon restore \
  /var/lib/repo-chap-home/backups/before-upgrade \
  --state-dir /var/lib/repo-chap-home/restored
```

The command verifies the complete snapshot before publishing new state. Preserve
the old state separately, then move the restored directory to the unit's configured
state path while stopped. Restore private configuration/authentication, run
diagnostics and start. The installation starts paused, including an empty backup
or repositories registered after restore. Existing repository pauses and workflow
activation holds remain separate. Source watching and read-only effect
reconciliation can continue; provider work and remote delivery cannot dispatch.

```sh
sudo -u repo-chap -H /opt/repo-chap/current/repo-chap daemon reconcile --state-dir /var/lib/repo-chap
sudo -u repo-chap -H /opt/repo-chap/current/repo-chap daemon status --state-dir /var/lib/repo-chap
sudo -u repo-chap -H /opt/repo-chap/current/repo-chap daemon inbox --state-dir /var/lib/repo-chap
sudo -u repo-chap -H /opt/repo-chap/current/repo-chap daemon resume-restored --state-dir /var/lib/repo-chap
```

Restore fences copied process/run owners, retains every charge, abandons unfinished
provider attempts and marks interrupted sends unknown. `reconcile` reads GitHub
outcomes. Inspect affected runs; Slack unknowns need the explicit receipt or
bounded resend procedure in its guide. A confirmed logical delivery may retain
an unknown historical send attempt. Status reports those counts separately.
If unresolved effects remain, `resume-restored --keep-unknown` acknowledges them
and releases unrelated work; it neither retries unknown sends nor grants a
resend. A reconciliation pass is required first. Repository pauses and activation
holds survive release and restart.

The manifest retains the last active installation limits. With an omitted
`limits` setting, a backup with `repositoryCostUnits: 5` starts paused at 5,
releases at 5 and restarts at 5 even though the default is higher. Different
explicit settings are rejected while recovery is paused. After release an
operator may deliberately set 8 and restart; a later restart omitting the value
retains 8. Release itself never raises ceilings or clears consumed reservations.
For backups of earlier releases without saved installation limits, supply the
unchanged private service configuration to `backup`.

A backup knows only outcomes recorded at its snapshot time. Restoring an older
backup after later remote writes loses those later receipts; read-only
reconciliation cannot discover every unrecorded effect. Inspect remote history
and keep affected repositories paused until the operator has accounted for that
gap. Do not run the original and restored installations concurrently.

## Retention and limits

There is no automatic deletion of referenced artifacts or run history. Do not
delete digest files or receipts by age: old waits, pinned jobs and accepted
candidates can still need them. While stopped, disposable worker/source caches
may be removed after ownership recovery; never treat them as the durable result.
Delete complete obsolete backups under an explicit retention policy after testing
a replacement. Decommissioning requires stopping the unit and deliberately
removing the whole private state, configuration and authentication stores.

One failed VM stops scheduling, and loss of its disk loses all state since the
last separately retained backup. SQLite, local disk, account processes and
outbound rate limits bound throughput. Availability, recovery-time/data-loss
objectives and sizing remain future operational decisions. There is one active
scheduler; network-shared SQLite and multi-host PID ownership are unsupported.

Persisted jobs are serializable and name immutable artifacts by digest/size,
with separate accepted results, reservations and effect attempts. Workers can be
discarded and reconstructed from those records. Those contracts support future
worker/storage design, but local paths, SQLite transactions and process ownership
still require this single host. Shared storage, distributed ownership and multiple
active schedulers need a separate design; no cloud component is installed here.

## Isolated lifecycle check

Run `vp run test:systemd` on a Linux development machine
with Docker. It runs systemd in a disposable privileged container with networking
disabled, installs the bundle, checks account diagnostics, registers a fictional
workflow, exercises local controls, stops, backs up, restores paused, reconciles,
releases and restarts. It checks that no TCP/UDP socket listens and removes its
container/image. Logs stay in a private temporary directory or the external
`REPO_CHAP_SMOKE_LOG_DIR`. This test changes no host service.

The suite uses fictional GitHub/provider responses and makes no paid model call.
Real App access, provider entitlement, Slack permissions/rendering, private VM
deployment and native macOS remain human pilot checks.
