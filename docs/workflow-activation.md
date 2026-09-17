# Repository-owned workflow activation

Use `register-source` to watch a workflow in its repository. The workflow path is
relative to that repository's root. Omit `--branch` to follow its current default
branch, including a later default-branch change.

```sh
repo-chap daemon register-source team-pr/workflow.json \
  --repo reef-labs/paperboat --profile pilot --reviewers willow-bot \
  --state-dir /private/repo-chap/state
repo-chap daemon versions --repo reef-labs/paperboat --state-dir /private/repo-chap/state
repo-chap daemon rollback <version-id> --repo reef-labs/paperboat --state-dir /private/repo-chap/state
repo-chap daemon resume-auto --repo reef-labs/paperboat --state-dir /private/repo-chap/state
repo-chap daemon migrate <run-id> --version <version-id> --state-dir /private/repo-chap/state
```

The original `register <local-workflow>` command still installs one immutable
package. Repeating either registration with identical settings is harmless.
Changing its mode, path, branch, provider profile, reviewer list or operator
capability ceiling through re-registration is rejected. There is no implicit
conversion of an explicitly registered package into a watched source.

The daemon resolves a branch to one full Git commit, fetches that object into
private temporary storage, and reads JSON, prompts, output contracts and explicit
context files at that commit. It never reads the managed working tree. References
may include an existing relative `review.md`; symlinks, missing files, invalid
UTF-8, oversized inputs and invalid packages are rejected. Shared `buildPackage`
validation applies schema, action, cycle and capability checks. The source cannot
raise the operator ceiling retained at registration. Current provider permissions
also apply before a newly validated candidate activates and before execution.

Versions record both a source commit and the shared package digest. The source
commit identifies where the bytes came from. The digest identifies executable
configuration and excludes layout and workflow JSON formatting. A formatting-only
commit can therefore have a new version ID and the same package digest. Source
commits are independent of the PR's head and base commits.

An invalid update records its commit and file-specific diagnostics while the last
valid package stays active. An invalid commit is retried when its source changes;
temporary access or storage failures are retried on later polls. Without any
valid version, the repository remains registered and visibly blocked. Other
repositories continue. Source reads honor the installation cooldown. The existing
polling position and PR inspection timing remain persisted.
An otherwise valid source denied by the current provider permissions is unavailable,
rather than cached as invalid source. Restoring those private permissions allows
the same commit to activate without requiring an unrelated repository change.

Rollback selects a retained valid version for new runs and holds automatic
activation. Polling still validates and retains newer source versions, but cannot
replace the held version. The hold survives restart. `resume-auto` permits the
next source poll to activate the current valid version, even when the source
commit is unchanged. An invalid source continues to retain the active package.
Dispatch pause is separate. Source watching continues while paused, and releasing
an activation hold does not resume dispatch.

## Pinned runs and migration

New PR runs pin the active version. Each existing run uses its own complete package
for later observations and jobs, even after source activation or rollback. The
stable repository/PR identity also preserves that run through closure and reopen.
An automatic activation does not change an attempt's ownership, job, reservation,
results or cancellation signal. A bot-authored source edit has the same behavior.
If migration changes a run's package while its poll is in flight,
`RuntimeStore.observe` rejects that observation with `StaleObservationError`.
The daemon discards only that PR's stale observation and refreshes it on the next
poll. Other runs retain their evidence, ownership and active attempts.

`migrate` is an explicit operator action against a retained version for the run's
repository. It accepts a waiting, ready, blocked or running open run. A cancelled
run requires a bounded retry first; a closed run cannot be migrated. The command
reads the complete target package and saved inspection, then commits a checkpoint
only if the run has not advanced in the meantime. A concurrent change rejects the
command and asks the operator to inspect and retry.

The checkpoint records old and new version IDs, time, ownership token, evidence
identity and notes revision. It is the accepted interruption point for active
analysis. The transaction increments ownership and marks a running attempt
`superseded`. The daemon then cancels that worker's signal; the provider adapter
terminates its process group. A worker that finishes before cancellation arrives
cannot commit through the old ownership token. The original pinned job and consumed
reservation remain inspectable. Automatic activation never performs this step.

Changing the package digest invalidates current classification, review and packet
readiness. Saved results remain historical evidence. A source version with the
same digest retains compatible readiness. A compatible failure continuation stays
pending. If its action was removed or changed to another action type, migration
blocks it instead of guessing a continuation. Renaming a failed action to another
action with the same built-in type does not remove evidence-bound suppression.
Migration does not reuse a provider session as evidence.

Existing wake times, refresh backoff and first-observed times remain recorded.
Debounce and reviewer deadlines already in effect retain their original deadlines
through migration and restart. New heads and new reviewer hints use the newly
pinned settings. Migration retains lifecycle attempts, historical per-head counts,
operator retries, per-wake counters, repository lifetime and UTC-day reservations.
It does not clear suppression or grant another uncharged attempt.

Effect records keep their semantic IDs, payloads and receipts. A sending effect
becomes `unknown` at the interruption checkpoint and still requires reconciliation.
Confirmed effects stay confirmed. Planning the same payload, evidence and destination
after a prompt change finds the same record. Effect handlers validate current inputs before sending a planned effect and
must reconcile an unknown outcome before another write. Conditional push uses
the independent effect leases described in [conditional repair and push](conditional-push.md).

Provider profile selection and reviewer logins remain operator-controlled inputs.
The separate repair execution policy is unchanged; source activation does not
change its digest or grant command permissions. Repair scheduling requires an explicit private apply policy. Analysis mode
continues to stop before repair.

## Local trials and storage

The local `inspect`, `analyze` and `workspace` commands still accept proposed JSON
and Markdown from a configuration PR. Their loader captures all referenced bytes
before execution and captures bind to that exact package digest. A proposed local
trial does not activate the daemon or require the source branch to be merged.
Workflow source, PR head/base and private capture revisions remain distinct.

Runtime database schema 2 introduced upgrades for schema-1 explicit registrations in one
transaction. Each receives a retained local-package version, and each existing
run receives its version ID. Existing jobs, ownership, attempts, reservations,
notes and effect receipts remain unchanged. The old schema-1 daemon cannot open
schema 2; preserve a consistent database backup before changing installed binaries.
Workflow packages and all runtime records stay outside Git. No activation,
rollback, migration or local result recording creates a repository commit.
Workflow rollback selects configuration bytes; it does not downgrade the database
or make an older daemon binary compatible with schema 2.

Linux tests use local Git repositories, fake GitHub responses and provider
executables. They cover source validation, exact commit reads, local trials,
activation during analysis, cancellation/fencing, rollback across reopen,
waiting migration, effect identity and retained budgets. Actual GitHub App access,
provider accounts and macOS local operation remain human pilot checks.

Current runtime schema 3 also retains these version and migration records. It adds
independent effect leases and send-attempt receipts. See [the upgrade behavior](conditional-push.md).
