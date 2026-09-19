# Conditional repair and push

Local CLI apply and daemon apply share durable repair, check and push handlers.
The optional [thread-resolution action](thread-resolution.md) continues from
the confirmed push and reports each addressed or remaining concern separately.
The daemon starts in analysis mode unless its private installation config lists
apply policy files. Each policy names one repository and the capabilities the
operator permits there. Repository workflow edits cannot grant this permission.
Every mode leaves merge to a person.

Add the policy path to the existing installation config:

```json
{
  "applyPolicies": ["/private/repo-chap/paperboat-apply.json"]
}
```

This is an additional field, not a complete installation file. Keep the existing
App, provider and limits settings. Policies have the same private-file rules as
installation settings. A policy can authorize repeated bounded work without
individual tool prompts:

```json
{
  "schemaVersion": 1,
  "repository": "reef-labs/paperboat",
  "capabilities": ["workspace.write", "checks.run", "pr.push"],
  "maxRepairsPerLifecycle": 3,
  "maxPushAttempts": 2,
  "execution": {
    "schemaVersion": 1,
    "allowedPaths": ["src", "tests"],
    "excludedPaths": ["src/generated"],
    "requiredChecks": [{
      "id": "tests",
      "executable": "vp",
      "args": ["run", "test"],
      "timeoutMs": 120000,
      "maxOutputBytes": 1048576
    }]
  }
}
```

The daemon reloads the selected file before work and immediately before a push.
Removing a capability prevents later dispatch. Removing or invalidating the file
blocks its repository's apply work. Add or remove policy paths in installation
config and restart to change the repository list. Workflow and current provider
permissions also apply. A changed policy or profile invalidates the old candidate's
apply prerequisites; it does not discard its saved artifacts or charges.

The App must have Contents write permission for push. Inspection still requests
its original read-only token. `installationPushCredentials` requests a separate
token with Contents write, pull-request read and the named repository. It checks
the returned Contents permission. `localPushCredentials` is the explicit local
credential entry point used by CLI apply. Neither credential
factory supplies policy approval.

## Local CLI apply

Local apply uses `GH_TOKEN`, `GITHUB_TOKEN`, or the current `gh` login. The account
must be able to read the repository and push its PR branch. It does not require
GitHub App installation settings. Keep policy and provider files private with
mode 0600 outside Git, and use a separate persistent state directory from the
daemon. The same policy contract above applies.

Prepare the repair and checks, then inspect its planned push without a remote write:

```sh
repo-chap apply ./team-pr/workflow.json --repo reef-labs/paperboat --pr 42 \
  --provider-config /private/repo-chap/providers.json --profile pilot \
  --policy /private/repo-chap/paperboat-apply.json \
  --state-dir /private/repo-chap/local-state --plan
```

The command prints the retained run ID, exact candidate and planned effect.
Only the selected repository and PR can dispatch, even when other eligible PRs
exist. `--plan` performs live GitHub reads, provider repair and local required
checks, but makes no remote writes. It is different from offline `apply inspect`.
Run the same command without `--plan` to continue from that saved candidate.
Planned effects print before dispatch. There is no per-tool prompt within the
private policy's bounds.

The command executes immediately due work until it waits, blocks or reaches its
step limit, then exits. Rerun after its displayed next wake time. Every invocation
must reuse the same state directory to preserve lifetime limits across bot heads.
Changing the workflow files does not silently replace a retained run's pinned
package; the immutable registration rejects that change. Keep the original
workflow files when resuming that local registration. Rerunning apply never
implies permission to migrate an existing run.

```sh
repo-chap apply inspect <run-id> --state-dir /private/repo-chap/local-state
repo-chap apply reconcile <run-id> --state-dir /private/repo-chap/local-state --json
```

`inspect` works offline without credentials, a provider or a running daemon.
`reconcile` uses local read credentials to inspect unknown pushes. It cannot
start a repair or send a push. It recovers dead send ownership and confirms an
already accepted candidate, including a process killed after Git accepted the
commit. Unknown reads retain their bounded retry time. An unexpected or missing
remote head stays unknown for inspection.

After a temporary failure before sending, rerun the full apply command with
`--retry` to request a bounded retry of the saved action. A resumed push reloads
policy and fresh PR evidence and reuses the exact validated candidate, without
another model repair. Unknown effects cannot resend until reconciliation finds
the expected old head. Limits, reservations and individual send attempts survive
every restart. Ctrl-C stops active work; humans still merge.

## What the operator sees

`daemon status` identifies analysis or apply mode. `daemon inspect <run-id>`
shows the candidate, required-check state, planned or completed effects, target
ref and expected old commit. JSON includes the full results and send-attempt
receipts. A planned record is not evidence that Git accepted a write.

`daemon retry <run-id>` retains every limit and charge. For a rejected push it
returns to that push action and uses the saved tested commit. It does not start
another repair. Uncertain results require remote-ref reconciliation before any
retry. A run at its repair or send-attempt limit remains blocked and reports
that a person must decide what to do next.

A temporary inspection failure pauses dispatch while retaining the candidate.
When identical complete evidence returns, the daemon resumes its saved check or
push action. A changed head, base or other captured evidence invalidates those
prerequisites.

A failed credential lookup or unavailable final PR read before sending records
a retryable rejection. The daemon schedules the next attempt after its poll delay;
an explicit bounded retry can run sooner. Invalid candidates and stale target
validation remain rejected. Temporary service failure does not require another
repair, and every later send still repeats current authorization.

Pause stops new dispatch and prevents an in-flight push from passing its final
authorization check. A push already sent can still have an unknown outcome.
Cancellation and workflow migration fence active work. Reconciliation performs
reads even when the run is cancelled or the repository is paused.

## Candidates and checks

Durable repair jobs pin the run's workflow package, inspection, provider profile,
execution policy, ownership, deadline and an immutable Git source bundle. The
bundle contains both captured histories, so losing a source cache does not lose
the job's inputs. Execution uses the same host-owned commit creation and checks
as [workspace repair](workspace-repair.md).

Each reserved repair permits one provider invocation, including invalid-output
cases. It consumes the existing attempt and cost reservations. Failed checks,
no-change results, blocked intent and worker failures retain their results and
follow the configured failure continuation. A new provider attempt requires
another bounded reservation.

`checks.validate_candidate` validates the receipts already produced by the host
on that final commit. It does not rerun commands against a different checkout.
Receipt validation compares every configured command's digest, identity, exit
code and candidate SHA. Failed, skipped, missing or mismatched receipts prevent
push. Starting another repair invalidates candidate, check and push readiness.
An empty patch on a valid conflict merge remains eligible because its new commit
preserves both captured parents.

Before sending, the daemon verifies current complete PR evidence, stable repository
and PR IDs, the exact branch/head/base, open non-draft state, same-repository head,
private policy, provider permissions, ownership and retained limits. Default and
base refs, deletion requests and forks are rejected. It restores the digest-checked
candidate bundle and verifies the actual tree and parents. Git independently checks
that the expected old commit is an ancestor of the candidate.

Credential retrieval finishes before the final PR read and authorization check.
The Git transport invokes its `beforeSend` callback after retrieving credentials
and immediately before starting the Git push. A delayed token refresh cannot
bypass an expired effect lease or a revoked private policy.

The write sends one explicit `candidateSha:targetRef` with
`--force-with-lease=targetRef:expectedHeadSha`. The lease checks the exact old
remote value; the independent ancestry check disallows history rewrites.
See [Git's push documentation](https://git-scm.com/docs/git-push). Git compares
the ref atomically. GitHub lifecycle and draft metadata remain observations;
Git cannot lock those fields against a change after the final read.

## Durable effects and recovery

The outbox saves the request before dispatch. Push payloads include repository/PR
identity, target ref, expected old SHA, candidate SHA, tree and parents. Existing
semantic IDs exclude workflow provenance and ownership. Each send attempt has
its own increasing token, bounded lease, process owner and retained receipt.
Releasing or expiring a provider claim does not abandon a separate effect worker.

The shared runtime exposes `beginEffect`, `effectCurrent`, `finishEffect`,
`reconcileEffect` and `effectAttempts`. `beginEffect` requires a current run claim
and a planned request, or a known rejection whose receipt explicitly permits
retry. It checks the attempt limit before moving the record to sending. It
cannot send an unknown effect. The effect lease remains valid after the caller
releases the run claim. New PR evidence, cancellation and migration explicitly
fence sending effects to unknown. Expired leases and dead owning processes do
the same. Handlers must still verify their own policy and target before I/O.

An ambiguous push or an interrupted sending attempt reads the remote branch:

| Observed ref | Recorded outcome |
| --- | --- |
| Exact candidate SHA | Confirmed, with no new write |
| Expected old SHA | Rejected, eligible for a bounded retry of the same candidate |
| Another SHA or missing branch | Unknown, with the observed value for inspection |
| Read failure | Unknown, with a persisted delay before another read |

Retries preserve the semantic effect ID and all earlier send-attempt receipts.
At most the lower of policy `maxPushAttempts` and installation `maxRetries + 1`
attempts can begin. A dispatch attempt includes validation that may stop before
Git writes. Send retries do not consume another provider reservation. Unknown
pushes block another repair for that run; unrelated analysis can still retain
new evidence. Other effect handlers own their own reconciliation rules.

Confirmed commits enter ordinary polling. The run ID, per-head history,
lifecycle repair count, total provider attempts, repository budget and UTC-day
charges survive every bot head, workflow activation and restart. The lower
workflow and private-policy repair totals both apply.

Runtime schema 3 upgrades schemas 1 and 2. It preserves registrations, pinned
jobs, notes, attempts, reservations and effect receipts. Older sending records
become unknown because they lack a durable effect lease. Older daemon binaries
cannot open schema 3. Preserve a consistent SQLite backup before upgrading.

Linux automated checks use fake providers and local bare Git repositories. They
exercise a real SIGKILL after remote acceptance, candidate restoration, concurrent
ref changes, failed checks, policy revocation, retained limits and database
upgrades. Real App access, provider quality, native macOS and human pilot operation
remain separate checks.
