# Verified review-thread resolution

`github.resolve_eligible_threads` continues local and daemon apply after a
confirmed repair push. Add `review.resolve` to the workflow, provider profile
and private apply policy before starting the repair. The policy must still
authorize the preceding repair, checks and push. The host performs resolution;
model execution produces decisions and local changes. This action never
publishes a review, approves or merges the PR.

The handler uses final host `RepairResult.payload.threads`, its tested candidate
and the matching confirmed push receipt. It retains these inputs before sending
the push. Normal observation can clear current repair readiness without losing
the resolution continuation. A replacement repair or incompatible workflow
migration cannot reuse that context as current authority. Older runs without
this context stop with an inspectable reason; arbitrary historical successes
do not authorize a resolution.

Each captured unresolved thread needs an addressed decision and evidence
references. Declined and blocked decisions keep the host's reason. New threads
have no addressed decision for this candidate and remain open. An outdated code
location alone does not mean a concern was addressed. The content digest covers
thread ID, path and every comment's ID, author, body, creation time and original
commit. Moving line numbers and GitHub's outdated flag do not change the digest.

Before each send, the handler reads every comment page, repository/PR/thread
identities, head and base, branch, lifecycle, draft state and `viewerCanResolve`.
The current head must be the exact confirmed candidate and the concern must
match the captured content. Missing, edited, foreign, incomplete or changed
evidence prevents a write.

## Credentials and remote guarantees

`PullRequestWriteCredentials` is an explicit repository scope with
`permission: 'pull_requests:write'`. `localPullRequestWriteCredentials` uses the
existing gh/PAT login. `installationPullRequestWriteCredentials` requests the
named repository with Contents read and Pull requests write, then verifies the
returned write permission. Inspection and push credentials remain separate.
The daemon supplies `threadCredentials`; CLI apply uses the local factory.
Final thread reads use the acquired write credential, so permission observation
refers to the account and token that will send.

Token acquisition finishes before the final remote read and ownership/private
policy check. Every attempt rechecks provider and workflow capabilities, pinned
policy/profile, effect ownership and retained limits. Revocation, cancellation,
pause and migration prevent later sends that have not passed that check.
Already sent requests can have unknown outcomes.

GitHub's [`resolveReviewThread` input](https://docs.github.com/en/graphql/reference/pulls#resolvereviewthreadinput)
has a thread ID, optional client mutation ID and optional Copilot resolution
reason. It has no expected-head or expected-content condition. GitHub cannot
atomically reject a concurrent head or comment change between the final read
and write. Post-write reads detect changes visible by then and retain a stale
concern alongside the observed resolved state. A receipt describes observed
state, not proof that Repo Chap caused it. A client mutation ID does not supply
a documented remote deduplication guarantee.

Automated tests use fictional responses and local Git. Real GitHub App/PAT
permissions, account behavior and native macOS remain human pilot checks.
Permission failures remain visible; the application does not silently request
broader credentials or repeat a mutation.

## Per-thread persistence and recovery

Each addressed thread has its own `github.resolve_eligible_threads` effect.
Its destination names repository, PR and thread. The payload binds the confirmed
push effect, tested candidate and original concern digest. The semantic ID
excludes changing observation provenance, so observing another resolved thread
cannot create a second logical request. Each send uses the shared runtime's
attempt lease, receipt and retry limit. A different thread can finish while one
thread remains unknown.

The HTTP transport sends at most one mutation per attempt. A failure before
sending can request a bounded retry of the same retained payload under the
installation retry ceiling. Changed concerns and denied permission produce
visible rejections. No effect failure starts another repair merely to recreate
the candidate.

On restart, expired or dead effect ownership becomes unknown. Daemon polling
and `repo-chap apply reconcile` perform read-only reconciliation:

| Current observation | Retained outcome |
| --- | --- |
| Same PR/thread, matching head and concern, resolved | Confirmed current resolved state, with no new mutation |
| Same PR/thread resolved, but head or concern changed | Confirmed remote state and a stale concern requiring inspection |
| Open after an uncertain send | Unknown; the request may still finish or a person may have reopened it |
| Missing, unrelated, incomplete or unreadable thread | Unknown, with a reason and persisted delay before another read |

An open thread does not prove that an uncertain request failed. It cannot
silently return to sending. Cancellation and pause still permit read-only
reconciliation. Repeated reads and workflow changes do not reset attempt or
repair limits.

## Inspection and handoff

Local and daemon inspect expose `threadResolution` with `candidateSha`,
`pushEffectId`, `pushConfirmed`, `pushReceipt`, `concerns` and
`remainingConcerns`. Each concern has `threadId`, final `disposition`,
`effectId`, `state`, `reason`, `remoteResolved` and `evidenceCurrent`.
States distinguish eligible, skipped, confirmed, rejected, unknown and stale.
A stale concern may already be resolved on GitHub and still need attention.
Later complete observations show reopened or edited concerns without changing
historical confirmed receipts.
They also refresh remote state for declined or unrelated concerns without
changing the original disposition. A later human-resolved declined thread no
longer counts as remaining work. Unavailable evidence marks current state
unknown and retains the pending resolution or failure handoff through restart.

CLI output names what was pushed and each thread's outcome. One confirmed
thread never becomes a claim that the whole review was resolved. The failure
continuation receives remaining concerns and survives observation of the
handler's own thread changes. `--plan` retains individual thread plans without
mutations. `apply inspect` remains offline; `apply reconcile` runs no providers.

The optional resolution context uses existing version-3 run data and effect
tables. No database rebuild or receipt reset is required. Historical results
and effect attempts remain inspectable after migration or later repairs.
