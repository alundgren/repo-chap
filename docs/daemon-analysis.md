# Private analysis daemon

The Linux daemon polls registered GitHub repositories, follows the shared workflow
evaluator, and saves bounded classification and review results. It listens only
on a Unix socket in its private state directory. Use the CLI on the same machine,
including through SSH. The desktop does not connect to it.

The daemon stops visibly before a repair, check, GitHub effect or Slack action.
An ordinary team-pr workflow therefore progresses through its waits and analyses,
then reports that analysis mode stopped before `human.publish_packet`. Inspect
the saved reports locally. No result is permission to merge.

## Start and register

Use Node 24 and the pinned Corepack pnpm. After `corepack pnpm install
--frozen-lockfile` and `corepack pnpm build`, the bundled CLI can start the daemon:

```sh
node apps/cli/dist/cli.js daemon start \
  --state-dir /private/repo-chap/state \
  --config /private/repo-chap/installation.json
```

The process stays in the foreground. A service manager can also run the Linux
entry point with `node apps/daemon/dist/main.js <state-directory>
<installation.json>`. Ctrl-C or SIGTERM stops polling and active providers.
The state directory must be on local persistent storage, outside every managed
checkout, owned by the daemon account with mode 0700. SQLite on network storage
and multiple daemon hosts are unsupported. Do not copy a live database without
its WAL using ordinary file-copy tools.

Installation settings, the App key and provider profiles belong outside Git.
Their parent directories must have mode 0700 and the files mode 0600, owned by
the daemon account. Paths in installation JSON are absolute. For example:

```json
{
  "schemaVersion": 1,
  "app": {
    "appId": "fictional-app-id",
    "installationId": 42,
    "privateKeyFile": "/private/repo-chap/app.pem"
  },
  "providerConfig": "/private/repo-chap/providers.json",
  "limits": {
    "concurrency": 2,
    "repositoryConcurrency": 1,
    "maxAttemptsPerLifecycle": 20,
    "maxRetries": 3,
    "repositoryCostUnits": 1000,
    "dailyCostUnits": 100,
    "attemptCostUnits": 1,
    "maxAttemptSeconds": 300,
    "maxImmediateSteps": 32,
    "pollSeconds": 60
  }
}
```

Configure supported [Codex](codex-analysis.md) or [Claude](claude-analysis.md)
profiles and their local authentication separately. The App installation must
permit repository contents, pull requests, checks and statuses reads. Webhooks
can remain disabled. Token creation is the only credential POST. Repository
queries and authenticated Git fetches perform reads. Tokens stay in memory and
the Git child environment; they are absent from command arguments, artifacts
and diagnostics.

In another terminal, register an explicitly chosen workflow package:

```sh
repo-chap daemon register /work/paperboat/team-pr/workflow.json \
  --repo reef-labs/paperboat --profile pilot \
  --reviewers willow-bot --state-dir /private/repo-chap/state
repo-chap daemon status --state-dir /private/repo-chap/state
repo-chap daemon inspect <run-id> --state-dir /private/repo-chap/state --json
repo-chap daemon pause --repo reef-labs/paperboat --state-dir /private/repo-chap/state
repo-chap daemon resume --repo reef-labs/paperboat --state-dir /private/repo-chap/state
repo-chap daemon cancel <run-id> --state-dir /private/repo-chap/state
repo-chap daemon retry <run-id> --state-dir /private/repo-chap/state
```

Registration validates all workflow bytes against the operator profile and
verifies App access before committing the repository. Repeating the same
registration is harmless. A different package/profile/reviewer list is rejected
without replacing the saved one. To watch a repository-owned workflow instead,
use `register-source` as described in [workflow activation](workflow-activation.md).
The two registration modes remain distinct. Runs retain their complete immutable
package even when source files change.

Status lists repositories, run IDs, state, reason and next wake. Inspect returns
the current inspection, attempts, reservations, results, notes revisions and
effect receipts. Text output summarizes the work; `--json` returns version-1
data. Exit 7 means the daemon command failed. Pause stops new dispatch while
active analysis can finish. Cancel invalidates ownership and stops the provider.
Retry authorizes another bounded attempt without clearing earlier charges. It
selects the last failed analysis action when one exists; otherwise it clears
analysis readiness and asks the evaluator to select work again.
If a limit is exhausted, retry reports or retains the block.

## Limits and restart accounting

The values above are the defaults. Every limit is a positive integer. Maximums
are 32 concurrent claims, 1000 lifecycle attempts, 100 operator retries,
1,000,000 repository or daily cost units, 100,000 units reserved per attempt,
3600 attempt/poll seconds, and 256 immediate steps. The workflow's lower
per-head, per-wake, attempt-duration and repository daily-unit limits also apply.

Cost units are operator-defined conservative reservation units. They are not
money, token counts or a provider's cost estimate. Every durable attempt consumes
`attemptCostUnits` and reserves its maximum runtime before provider execution.
The default is one unit per invocation. Configure that unit ceiling to bound
the installation's work. Actual token usage and estimated usage or cost remain
separate fields in the provider result. Missing usage, provider failure, timeout,
cancel, crash and stale completion retain the full reservation.

`repositoryCostUnits` limits all reservations for a registered repository's
lifetime. `dailyCostUnits` limits the installation's reservations in the UTC day
when they start. The workflow's `maxDailyCostUnits` limits that repository's UTC
day. A job crossing midnight remains charged to its start day. Daily exhaustion
persists a wake at the next UTC midnight. Repository lifetime, lifecycle, per-head
and operator-retry exhaustion remain visibly blocked. The operator may deliberately
raise installation ceilings in the private config and restart; no command erases
charges. These UTC accounting days do not introduce scheduled daily repository jobs.

Every PR has one durable run ID scoped to its stable repository and PR IDs.
New heads, own commits, closure/reopening, worker replacement and explicit retries
retain lifecycle and repository totals. Returning to an earlier head retains that
head's prior attempt count. Configuration activation and checkpoint migration preserve
those same records. Unchanged failed analysis actions are suppressed individually until
relevant evidence changes or the operator requests an allowed retry. A failed
action still follows its configured `onFailure`, including another analysis
action, a control action, `$wait` or `$blocked`. The failed result and invalidated
readiness remain recorded. A deferred repair/publication action reached through
failure produces the same visible analysis-mode stop as one reached through
success. Prompt edits alone do not authorize retry.

A daemon attempt invokes its selected provider at most once, even if the profile
permits two adapter attempts. Invalid output is retained as a failed attempt;
correction requires another reserved attempt through bounded retry or changed
evidence. The daemon does not depend on cached provider sessions. The local
analysis and workspace commands retain their own documented adapter allowances.

## Polling and worker recovery

PR listing and every inspection collection are paginated. Tracked PRs are inspected
even when they disappear from the open list, so absence cannot be mistaken for
closure. Partial lists and collections retain unknown coverage. An unavailable
repository blocks its affected runs while other repositories continue.

The listing and each PR inspection have separate bounded readers, so earlier
PRs cannot consume later PRs' per-collection request allowance. Every attempted
PR inspection records its PR number as the repository's polling position.
The next cycle starts after that number in the sorted discovered/tracked PR list,
then wraps. That position survives restarts and lets later PRs receive evidence
after a rate limit interrupts a cycle. Repositories with the oldest due poll are
visited first. All readers obey the installation's persisted server cooldown
before every query; creating a reader cannot bypass it. Registration and polling
readers share the same runtime callbacks, including readers created before the
server returned its guidance.
If another reader extends the deadline during sleep or credential lookup, the
waiting reader checks again before sending. It either waits until the new time
or retains that retry time in a bounded collection failure.

The prior inspection is persisted and supplied on the next poll. First-observed
head time and original reviewer reaction times therefore survive restarts.
`controlDecision` in the workflow package now supplies the same debounce,
reviewer deadline, refresh backoff and closure decisions to replay and the daemon.
Polling does not restart those delays. Server cooldowns and collection retry
times survive restart and apply across repository reads for the installation.

The daemon fetches the captured head/base history into a private temporary bare
Git repository, saves the bounded source bundle, and removes that repository
before provider dispatch. Each fetch has its own directory, so concurrent PRs
cannot contend over a shared Git index or fetch receipt. A worker receives
a version-1 `AnalysisJob` containing run/attempt/ownership IDs, deadline, stable
subject IDs, head/base, package/inspection/source artifact references, profile
digest and notes revision. Jobs and results contain JSON data. Native handles,
absolute working paths, signals and ownership callbacks belong to execution
options. The worker reads its pinned sources from immutable artifacts, so loss
of the Git cache or temporary directory cannot lose a committed result.

`RuntimeStore` keeps SQLite private. Its claim, reservation, completion and outbox
methods use local transactions. Claims use increasing ownership tokens. New
evidence, cancel and expired ownership invalidate old tokens. Completion checks
the active token, evidence, notes, reserved job and deadline in the committing
transaction. Expired attempts become abandoned and can be replaced within the
remaining limits. An old worker cannot replace the new owner's result.

Results and notes revisions commit together with requested outbox entries.
Artifacts are digest-checked private files, written and synced before their
references are committed. Unreferenced artifacts left by a failed transaction
are harmless retained files; automatic retention cleanup is not implemented.
The state directory contains a SQLite database, immutable artifacts, disposable
workers and Git caches. Only the first two are durable records.

Outbox requests have stable semantic IDs containing repository/run identity,
kind, destination, evidence, expected revision and payload digest. Attempt times,
ownership tokens and workflow provenance do not create a second logical request.
States are `planned`, `sending`, `confirmed`, `rejected` and `unknown`. Lost
ownership while sending becomes unknown. Reconciliation may confirm or reject it
with a receipt; it cannot silently return to sending. These storage operations
do not authorize dispatch, and this daemon installs no external effect handlers.

A transactional process-ownership record prevents a second daemon from opening
the same control socket. After SIGKILL, startup replaces a dead process's record
and socket and recovers due work. A record pointing to a live PID is preserved.
Inspect that process before manual cleanup if the PID was reused. The local runtime does not coordinate
multiple hosts or promise exactly-once external delivery.

## Verification limits

Automated Linux tests use fictional repositories, fake GitHub responses and
fake provider executables. They exercise socket/CLI operation, real SIGKILL,
wait/attempt recovery, duplicate polls, new heads, closure, budgets, concurrency,
provider failures, late completions and deletion of worker/source caches.
They make no paid provider request and no GitHub or Slack mutation. Real App
installation access, native deployment, provider authentication and analysis
quality remain human pilot checks.
