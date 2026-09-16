# Review and classification publication

Analysis and publication are separate actions. `github.publish_review` consumes
a successful `agent.review` result from its action chain and requires
`review.publish`. `github.set_labels` consumes a successful `agent.classify`
result and requires `labels.set`. Workflow validation rejects a path that reaches
either publication action without its required analysis result. Offline replay
proposes the effect and uses a supplied stub without calling GitHub.

The publication builders in `@repo-chap/runtime` verify the current run, accepted
analysis, pinned package, captured observation, and source artifact. Daemon and
local apply share the same handlers and schema-3 effect leases. Each action
requires its own capability in the private apply policy, workflow, action, and
current provider profile. Publication-only policies need neither repair nor push
permission. Authorization is checked at dispatch and again after acquiring the
write credential. Inspection credentials retain their existing read-only scope.

Review writes require a repository-scoped `pull_requests:write` credential;
labels require `issues:write`. App token responses must confirm the requested
write permission. The final target read uses the acquired operation credential;
the complete evidence refresh uses the inspection credential for checks and
other collections. Both reads finish before sending, followed by another current
policy and independent lease check.

`repo-chap apply --plan` runs analysis and retains the publication request without
writing to GitHub. Normal apply prints the planned effect before dispatch.
`apply inspect` reads private state offline. `apply reconcile` can confirm unknown
effects or refresh unverified receipts through reads alone; it never invokes a
provider or sends a publication.

## Review evidence

A review is a GitHub comment review bound to the exact reviewed head commit.
Publication cannot approve or merge a PR. The body includes the verdict, coverage,
every missing-evidence item, findings, and source links. Partial results retain
their incomplete evidence; a contradictory acceptable result is rejected.

Every cited line must exist in the captured file and map to the captured diff on
the requested side. Head links use the reviewed head. Base links use
`comparisonBaseSha`, the diff's common ancestor, rather than `baseSha`, the captured
target-branch commit. Diff context lines are valid locations. A citation elsewhere
in a captured file rejects the whole publication. All local findings remain
available with the rejection reason. No finding is dropped to fit GitHub, and a
review that exceeds the publication limit remains local without truncation.

The PR identity, head, target base, lifecycle, and draft status are read before
the write and checked again after acceptance. A concurrent head change can leave
an accepted comment attached to the previous commit. Its receipt says `confirmed`
and `stale`, and requests another observation. Acceptance does not transfer
readiness to the new head. A failed post-write read produces `unverified`
freshness while preserving the remote receipt.

## Classification labels

`labels.set` means adding the validated configured category names to the PR.
It preserves every existing label, including categories from earlier analyses
and labels added by people. There is no reliable ownership attribution for
existing labels, so this operation does not remove them. An empty classification
is a confirmed no-op with the preserved labels recorded. Operators can remove
obsolete categories on GitHub.

Uncertain classifications and classifications with missing evidence stay local.
Each name must be unique and present in the pinned workflow's `labels` list.
Classification citations use the same diff validation as review findings.

GitHub does not offer a head comparison condition for adding labels. The handler
checks the PR before and after the request, preserves unrelated labels through
the additive endpoint, and records a stale result when the PR changed.

## Receipts and recovery

`PublicationReceipt` records the kind, semantic marker, expected and observed
head/base revisions, remote reference, diagnostic, and independent outcome and
freshness values. Review receipts retain coverage, verdict, and missing evidence.
Label receipts list requested, observed, and preserved names.

| Field | Values |
| --- | --- |
| `outcome` | `confirmed`, `rejected`, `unknown` |
| `freshness` | `current`, `stale`, `unverified` |
| `reobserve` | True when freshness is stale or unverified |
| `retryable` | True only for a rejected request that may be attempted within retained limits |
| `reconcileAfter` | Earliest next remote reconciliation time, when a follow-up read is due |

Inspect exposes `effects`, `effectAttempts`, and accepted analysis in `results`.
A local citation or completeness rejection creates a rejected effect with an
inspectable reason and no send attempt; the complete analysis stays in results.
Consumers must not present that rejection as a successful or clean review.
Historical effects remain after new observations and workflow migrations, so a
consumer must compare the effect's evidence key and expected revision with the
current run before treating its receipt as current evidence.

Send attempts use independent leases and survive release of provider ownership.
Only proven stale inputs invalidate analysis and request a fresh observation.
Unavailable follow-up reads preserve the confirmed receipt with unverified
freshness, then schedule read-only reconciliation. They do not rerun analysis or
resend the effect. Individual send receipts remain in `effectAttempts` when the
top-level confirmed receipt receives a later freshness update.

Review markers bind the repository and PR identity, run, revisions, pinned diff,
and validated review content. Workflow versions, prompt text, attempt numbers,
and timestamps do not create another logical publication. An identical review
after a prompt-only migration uses the same marker and body. Reconciliation
requires a marked `COMMENTED` review with the exact body and reviewed commit.
A conflicting marked review remains unknown.

Labels have a durable local marker for the requested names. Reconciliation checks
whether all requested labels are present; it does not claim who added them.
An empty set needs no remote mutation. An uncertain label request with missing
labels stays unknown, because a missing label does not prove the earlier request
was rejected.

Neither handler repeats an unknown request. It first reads complete bounded
remote evidence. A prior marked review or satisfied label set confirms the
effect. Missing or incomplete evidence retains the uncertainty. The REST client
also never automatically retries a mutation after connection loss, an unreadable
success response, or an ambiguous server error.

GitHub documents the review commit and comment event in
[creating a pull request review](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request)
and the additive label endpoint in
[adding labels to an issue](https://docs.github.com/en/rest/issues/labels#add-labels-to-an-issue).
Real GitHub App scope verification and account behavior require the human pilot.

The shared apply integration is based on reviewed issue #9. Final integration
with issue #10's shared pull request write-credential factory, completion review,
and the complete inherited test suite remain pending in this preparation branch.
