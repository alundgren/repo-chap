# Guided personal pilot

Use this guide with `vp run pilot run` to exercise Repo Chap on the disposable
DigitalOcean host. The command guides an operator; it does not infer success
from a prompt response or run arbitrary agent commands. A `pass` is the
operator's attestation after inspecting the stated evidence. Real-account
verification belongs to issue #19. The offline rehearsal only proves the guide
and fake-service lifecycle.

A powered-off Droplet still bills. `run` invokes the existing `cleanup` and
independent verification after success, a failed checkpoint, or Ctrl-C. Keep
the terminal running through bounded cleanup. SIGKILL, power loss and an offline
Mac cannot be handled automatically. Resume cleanup as soon as the Mac returns.

## Prepare privately

Use a Mac or Linux operator machine. Follow the exact installation, account,
OAuth, tailnet policy and file-mode checklist in
[disposable host setup](pilot-digitalocean.md#prepare-the-operator-machine).
Install Git, GitHub CLI, tar, Terraform 1.14.7, and a connected Tailscale client.
Use `vp install --frozen-lockfile` and `vp run build` in this checkout. The
installer pins and verifies Node 24.21.0, Vite+ 0.3.0, Tailscale 1.94.2,
Codex 0.154.0 and runner 2.337.0 on Ubuntu 24.04. It transfers the built Repo Chap
release and records its digest. The Codex pin matches the current adapter's
capability baseline; account entitlement must still be tested live.

Keep concrete values in a mode-0700 operator directory outside every Git
checkout. Generated files are mode 0600. These names are fictional placeholders:

| Selection | What to configure privately |
| --- | --- |
| `example-team/pilot-test` | Dedicated trusted **private** repository with an initial commit; operator admin access; no untrusted fork code |
| Public-read control | A separate approved public repository and existing PR; read-only inspection only |
| GitHub App | Installation restricted to the private test repository, private PEM file, and the permissions in the daemon guide |
| Slack, optional | Test channel `C012EXAMPLE`, test member `U012EXAMPLE`, bot token, membership and explicit author mapping; never use a production destination |
| Codex | Dedicated instruction-free `CODEX_HOME`, authenticated separately, plus a supported model and effort in the private provider profile |
| DigitalOcean | Active account, scoped operator token, selected region and size |
| Tailscale | Narrow OAuth client, one-use bootstrap key, VM tag and explicit operator-to-tag SSH grant from the host guide |
| Daemon | Flat private config directory with installation JSON, provider profile, App key and explicit apply policy; optional Slack file |

Do not implicitly copy the normal operator Codex cache. Use the daemon's
`CODEX_HOME=/var/lib/repo-chap-home/pilot-codex`. The host guide documents device
login if transfer is unavailable. No Claude subscription or real Claude-account
validation is required. Claude remains covered by implementation tests.

```sh
vp run pilot prepare --root /absolute/private/repo-chap-pilot
# Edit the fictional operator.json template outside Git, then repeat:
vp run pilot prepare --root /absolute/private/repo-chap-pilot
vp run pilot run --root /absolute/private/repo-chap-pilot --run RUN_ID --dry-run
vp run pilot run --root /absolute/private/repo-chap-pilot --run RUN_ID
```

Copy the actual run ID from `prepare`. Preview lists the repository, host size,
versions, private paths and stages without reading credentials or contacting
services. The interactive run shows live billing inventory and asks for
`approve RUN_ID` before `up` provisions or resumes anything. `up` owns private
configuration transfer over the verified tailnet destination and installation.
It does not use public SSH. The selected run holds the existing operator lock.

## Compare offline evaluation first

Author workflow JSON and Markdown with your normal external agent. Electron is
the local companion and simulator, with no embedded chat, daemon connection or
provider execution. JSON/Markdown authoring and replay work without Electron.

Before approving infrastructure, start the companion with `vp run desktop` in a
second terminal. In the source checkout run:

```sh
vp node apps/cli/dist/cli.js replay docs/pr-workflows/examples/team-pr/workflow.json --fixture fixtures/replay/ci-repair.json --json
vp node apps/cli/dist/cli.js desktop open --repo-root /absolute/path/to/repo-chap --workflow docs/pr-workflows/examples/team-pr/workflow.json
vp node apps/cli/dist/cli.js desktop simulate --fixture /absolute/path/to/repo-chap/fixtures/replay/ci-repair.json --json
```

Repeat with `ci-pending.json`, `conflict.json`, `review-wait.json`,
`incomplete-evidence.json`, `suppressed-repair.json` and `handoff.json`.
Compare package digest, selected rules, effects, outcome, input selection and
expectation comparison. Exit 0 alone is not a passed expectation. Edit the
fixture and verify the companion marks the previous result stale. Record both
operator OS and companion version in private notes. Enter `matched` only after
this comparison succeeds. See [simulation](desktop-simulation.md).

## Create controlled PR states

After provisioning, `run` generates `fixtures/fixture-plan.md`, a runner-targeted
workflow, a reproducible greeting check and CI replay JSON under the external
run directory. Read the generated plan before acting. It gives exact Bash
commands, fixed repository and run values, unique branches and label, a preview
and typed confirmation **for each remote mutation**, and cleanup commands.
The wrapper rechecks repository ID, privacy, clone remote and every resolved
push URL before executing.
Never remove these checks or approve unseen commands. A shell session stopped
mid-plan resumes at the first uncompleted command after read-only inspection.
Unknown push/PR-create responses require reconciliation before retrying.

The plan creates a unique base branch, a failing CI PR with no review threads,
a conflicting head/base pair, and a review-response PR. It never changes the
default branch or merges. The workflow runs only on this run's branches and
exact runner label. It has a five-minute job deadline. Pause daemon effects
until you have recorded the first failed CI job and runner ID. Configure the
workflow source and required local check `bash pilot-check.sh`; otherwise the
failure cannot be reproduced and the pilot must not claim repair success.

Workflow configuration still needs your repository-owned JSON/Markdown and
private profile/apply policy. Use the team-pr example and
[conditional push configuration](conditional-push.md). Preview the repository,
allowed effects, required checks, repair limits and Slack destinations before
activating the policy. Register only the selected private repository through
[daemon registration](daemon-analysis.md) or
[branch source registration](workflow-activation.md). For watched workflow
recovery use `register-source --branch rcp-RUN_ID/base`. Copy its JSON and
referenced Markdown to that branch with a separately previewed and approved
push. Do not register the public-read control for mutations.

## Observe and record

At each checkpoint the command displays run ID, host state, guide checkpoint,
whether a billable Droplet exists, and the next command. An unknown inventory is
never reported as absent. Type `pass` only after completing the corresponding
procedure below. `fail`, an invalid response, EOF or Ctrl-C stops the scenario
and leads to cleanup. Only Slack accepts `not-configured`.

Keep raw captures, logs and decision records private. The generated
`evidence.json` contains only fixed scenario outcomes, installed versions, OS,
remaining failures, fixture-cleanup status and independent cleanup categories.
It omits repository names, network addresses, logs, tokens and free-form error
text. Add redacted job IDs, SHAs and human notes in a separate private file.
Review any evidence before sharing it. Never commit generated workflows,
private content, screenshots, recordings or logs to Repo Chap.

| Checkpoint | Procedure and evidence required for pass |
| --- | --- |
| `read-access` | Use `repo-chap inspect WORKFLOW --repo OWNER/REPO --pr NUMBER --capture-dir PRIVATE_PATH --json` on approved public and private PRs. Verify captured SHA and coverage. Inspect daemon status to prove App installation reads the private repository. CLI gh access does not prove App access. |
| `codex` | Follow [Codex analysis](codex-analysis.md): run `analyze` on the capture with private profile and local Git history. Check completed classification/review, pinned citations, explicit model/effort and validated structured result. Test a short profile deadline and Ctrl-C separately; terminal decisions must be `timeout`/`cancelled` and child processes gone. Lose a session and use a fresh bounded attempt; inspect attempts/cost counters instead of silently resuming incompatible state. Never print auth contents. |
| `review` | On the review PR, observe classification, published review/labels allowed by policy, and a handoff naming the PR/head, findings, checks and decision needed. No automatic merge. |
| `conflict` | Use the generated conflicting PR. Check candidate SHA, required local checks, expected-head conditional push receipt, and fresh GitHub head observation. Confirm pushed SHA equals tested SHA. |
| `review-response` | Preview and approve one inline review on the generated review PR with a second trusted reviewer. Observe repair of that request and resolution of only eligible threads at the new tested head. Check unrelated, outdated and already resolved threads are unchanged. |
| `ci-recovery` | Record native GitHub initial failing job, no review threads, locally reproduced failure, bounded Codex candidate and conditional push. Wait for the new head's passing job and confirm both jobs used the recorded runner ID/name/unique label. A manual control repair is not Codex evidence. |
| `ci-wait` | Replay generated `ci-running`, `ci-pending`, `ci-mixed`, `ci-stale`, `ci-unknown` and `ci-incomplete` JSON through CLI and companion. None may propose `agent.fix_ci`. In the live run, watch the queued/running job without repair. A changed-head capture must not authorize an old-head action. |
| `ci-handoff` | Replay generated `ci-remote-log-only`, `ci-infrastructure`, `ci-access`, `ci-credential`, `ci-rerun-only`. Confirm handoff and no push. These stubs demonstrate expected routing, not live provider diagnosis. In the private test policy temporarily select a check that cannot reproduce the remote failure, preview/approve activation, and verify a blocked live repair with an explanation. Restore the original policy after inspection. |
| `changed-head` | Replay `ci-changed-head.json`. Live: while a candidate check is paused at an operator-controlled delay, preview/approve a second benign commit on that PR branch. Release the check. The stale candidate must not push; inspect expected/actual heads and next observation. |
| `budgets` | Replay `ci-budget.json`. Live: choose small explicit limits before activation, make repeated failing candidates within this run, then verify exhaustion prevents further repair across bot commits and restart. Never raise limits merely to finish the pilot. |
| `configuration` | Follow the recovery sequence below. Check waiting run, version IDs, last-valid digest, rollback hold, restored pause and preserved charges. |
| `uncertain-outcomes` | Replay generated `ci-unknown-github.json` and `ci-unknown-slack.json`; each blocks for reconciliation. Inspect existing effect-receipt and restore behavior in [conditional push](conditional-push.md) and [daemon operations](daemon-operations.md). Do not simulate ambiguity by blindly repeating live writes or disconnecting broad account access. Record offline coverage separately from any live unknown outcome. |
| `slack` | In an explicitly approved test channel and author DM, inspect route and packet preview, then authorized delivery. Verify missing mapping and delivery failure remain visible in inbox without repeating repair. Record `not-configured` if no Slack evidence is wanted. |
| `revocation` | Last, explicitly approve revoking only the dedicated pilot Codex authentication through the account's supported controls. Verify a subsequent bounded analysis fails authentication and hands off. Record the result without credentials. Revocation does not delete cloud resources. |

The generated replay cases use fictional stubs. Their outcomes must be compared
with the real runtime receipts where the table calls for live behavior. Do not
label a rehearsal, simulated timeout or stubbed repair as real-account evidence.

## Restart, last-valid recovery and restore

Use the verified tailnet diagnostic account only with operator permission.
In a permitted shell, run service operations as `repo-chap` using
`/opt/repo-chap/current/repo-chap`; state is `/var/lib/repo-chap`.

The following commands run inside the permitted VM shell. Define this helper
so each daemon command uses the service account and explicit state directory:

```sh
chap() {
  sudo -u repo-chap -H /opt/repo-chap/current/repo-chap daemon "$@" --state-dir /var/lib/repo-chap
}
chap status
chap inspect RUN --json
sudo systemctl restart repo-chap.service
chap status
chap inspect RUN --json
```

Replace `RUN` with the daemon run ID, which differs from the infrastructure run
ID. Verify the waiting run resumes with its previous attempts, reservations,
repair budget and next wake. Record versions before previewing and approving
an invalid JSON push to the watched run branch:

```sh
chap versions --repo OWNER/REPO
```

Verify rejection diagnostics and continued use of the last valid digest.
Restore valid JSON through another confirmed push. Replace `VERSION` with a
recorded valid version, then test rollback and a subsequent poll:

```sh
chap rollback VERSION --repo OWNER/REPO
chap versions --repo OWNER/REPO
# After confirming the rollback hold, explicitly release it:
chap resume-auto --repo OWNER/REPO
```

Running jobs keep their pinned package. For backup, create a private parent
and stop the service first:

```sh
sudo install -d -m 0700 -o repo-chap -g repo-chap /var/lib/repo-chap-home/backups
sudo systemctl stop repo-chap.service
chap backup /var/lib/repo-chap-home/backups/pilot --config /etc/repo-chap/installation.json
sudo -u repo-chap -H /opt/repo-chap/current/repo-chap daemon restore /var/lib/repo-chap-home/backups/pilot --state-dir /var/lib/repo-chap-home/restored
```

Both destination directories must be new. Follow the ownership, preserved
original state and directory replacement steps in
[backup/restore](daemon-operations.md#coherent-backup) while the service is stopped.
After placing the restored state at `/var/lib/repo-chap`, start and verify the
restored pause and preserved charges:

```sh
sudo systemctl start repo-chap.service
chap reconcile
chap status
chap inbox
# Only after inspecting and resolving unknown effects, explicitly approve:
chap resume-restored
```

Do not resend an unknown Slack delivery just to make the guide pass.

## Failure, diagnostic permission and cleanup

Every failed checkpoint offers the same diagnostic options:

```sh
vp run pilot status --root /absolute/private/repo-chap-pilot --run RUN_ID
vp run pilot ssh --root /absolute/private/repo-chap-pilot --run RUN_ID
vp run pilot diagnose --root /absolute/private/repo-chap-pilot --run RUN_ID
```

The operator may explicitly permit a local agent to use those commands for
this run with the Mac's tailnet identity. That grants VM administration through
the dedicated diagnostic account, not permission to broaden tailnet grants,
rotate credentials, mutate another repository or bypass confirmations. There
is no public SSH. Revoke the grant or disable Tailscale SSH as documented in the
host guide. Failed enrollment/access uses the DigitalOcean console; do not open
port 22 as a workaround. Diagnostics capture only bounded redacted output.

For diagnosis that requires the VM to survive a failure, select retention
**before** running:

```sh
vp run pilot run --root /absolute/private/repo-chap-pilot --run RUN_ID --retain-on-failure
```

Retention is recorded, and every status/resume message repeats the billing
warning and exact immediate cleanup command. A resumed run clears retention
and retries the failed checkpoint, skipping completed ones. Reapply the flag
only if another failure should retain the host. Fixture commands are manual:
inspect prior successful mutations before resuming them. An incomplete apply
may require cleanup and a new run; the lifecycle will refuse unsafe reapply.

| Saved state | Next safe action |
| --- | --- |
| `prepared` or failed before host approval | `run` to repeat the current checkpoint and approve the displayed plan |
| Retained, host still present | Explicitly permit diagnostics, then repeat `run` or run `cleanup` immediately |
| `cleanup-pending` | Restore required account access and repeat `cleanup`; `run` also retries cleanup without reprovisioning |
| `clean`, some scenarios not tested | Preserve failed evidence. Prepare a new run for remaining live tests; do not recreate the old run |
| Lost terminal/process | Run `status`, inspect the saved checkpoint; run `cleanup` first if resource state is uncertain |
| Manifest or lock problem | Follow host guide recovery. Confirm the lock owner exited before removing a stale lock |

On success the guide asks you to close the run PRs, cancel/wait for their jobs,
and delete only the generated branches/label with the fixture plan's previews
and confirmations. On failure, infrastructure cleanup proceeds immediately;
fixture cleanup remains `pending` in evidence for manual completion. Closing a
PR is not merging it. No step merges; only a person may perform a merge.

```sh
vp run pilot cleanup --root /absolute/private/repo-chap-pilot --run RUN_ID
vp run pilot verify-clean --root /absolute/private/repo-chap-pilot --run RUN_ID
```

Cleanup is immediate reap for the selected run. It clears retention and attempts
infrastructure destruction even when diagnostics or runner/Tailscale removal
fails. `verify-clean` is read-only. Check DigitalOcean **absent** separately from
GitHub runner and Tailscale **absent**. Unknown/inaccessible is not clean.
If only a registration remains, the report says billing resources are gone but
still returns nonzero. Repeat cleanup and verification until resolved. Check
fixture PRs/branches/label independently. Preserve external evidence and state
until all categories are verified. `pilot reap --older-than 24h` is an explicit,
on-demand abandoned-run recovery command, never a scheduled guarantee.

## Rehearse without credentials

```sh
vp run pilot:rehearse --root /absolute/private/new-pilot-rehearsal
vp run test:pilot
vp run check
```

Use a new external directory. Rehearsal constructs only fake services and fake
checkpoint answers, runs the entire guide, provisions/cleans fictional
resources, and leaves a redacted `evidence.json` marked `rehearsal` outside Git.
It does not call a real account, model, Slack, Terraform or Tailscale process.
It is not a substitute for the live procedures above. Tests inject failures at
every guide checkpoint, refuse approvals, cancel runs, retain/resume, retry
cleanup and evaluate generated CI fixtures through the shared evaluator.
