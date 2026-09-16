# Repo Chap v1 specification

## Outcome

Keep trusted teams' GitHub PRs moving through explicit rules, bounded agent work,
and useful Slack handoffs. Review, classify, repair conflicts, address actionable
reviews, test, and push automatically within configured policy. People merge.
The CLI and local Electron editor run on macOS/Linux; the daemon runs on a private
Linux VM. There are no public callbacks or hosted-runner dependencies.

## Files and activation

Each registered repository names one workflow JSON path and a source branch.
The source branch defaults to the default branch. Poll its commit and read the
JSON, prompt files, output contracts, and explicit `contextFiles` from that same
commit. Relative paths resolve against the workflow file's directory within the
repository. A context file may be an existing review.md outside that directory.
Markdown links are not recursively executed or fetched. No implicit includes.

Compile the complete package into immutable bytes and a digest, including
referenced Markdown and contracts. Layout-only editor metadata is separate.
Validate schemas, unique IDs, action references, typed conditions, action
contracts, required error routes, permission ceilings, and finite progress.
Every execution path must wait, finish, block, or consume a finite step budget.
Missing files, oversized inputs, incompatible versions, and invalid paths reject
activation with file-specific diagnostics. Preserve the last valid package.
Without one, the repository is visibly blocked while other repositories run.

Activate valid source changes automatically for new runs. An active PR run pins
its package until closure or explicit checkpoint migration. Migration cancels
incompatible active work, invalidates stale derived results, and keeps effect
receipts, concern suppression, and lifetime budgets. Rollback selects a retained
package and holds automatic activation until explicitly resumed. Pause stops
new dispatch; in-flight remote effects still need reconciliation.

A local trial may load the PR's proposed JSON and Markdown, including instructions
for reviewing that configuration change. Pin all bytes before execution. Trust
is not the reason for version pinning; reproducible work and recovery are.

## Observation and deterministic decisions

Collect stable repository and PR IDs, lifecycle, draft state, head/base SHA,
mergeability, checks, review decisions, threads, labels, and configured reviewer
activity. Paginate each domain. Failed or partial collection is unknown, not an
empty collection. Bind every derived result to all its relevant input revisions.

The pure evaluator receives observations, package, control state, and an explicit
clock. It selects the first true rule and records why earlier rules did not
match. Conditions use typed comparisons plus bounded all/any/not. Unknown stays
unknown under negation and cannot authorize a write or a ready handoff.

The example's ordered decisions are closed, draft, incomplete evidence, debounce,
unchanged-concern suppression, conflict repair, review repair, bounded external
review wait, missing classification, missing review, and human handoff.
Overlapping PR facts remain independent. A reaction is a wait hint with expiry,
not proof that another reviewer will eventually finish. Timers survive restart.

## Execution and control state

Store repositories, runs, observations, attempts, timers, budgets, notes revisions,
artifacts, effect requests, and receipts in SQLite on a persistent local volume.
A run has its own ID and a repository ID. PR identity is a subject reference,
not the primary key of every general execution record. V1 only runs PR subjects.

One active owner advances a PR run using a lease and increasing fencing token.
Commit an attempt and budget reservation together. A worker gets a pinned
checkout, provider profile, package digest, relevant evidence, deadline, and
bounded output contract. Validate provider results and source citations before
recording completion. The daemon records tool versions, usage when available,
tests it actually ran, and all authoritative attempt metadata.

Use disposable worktrees and child processes with deadlines and cleanup of the
whole child process group. Trusted repository instructions and ordinary build
commands may run. Do not require hostile-code isolation or a container runtime.
Keep the daemon's state, credentials, notes, and generated artifacts outside the
managed working tree. The executor does not receive responsibility for remote
writes. The daemon performs and records them through named operations.

Long waits release workers. Reclaim expired leases after restart, invalidate
late worker output, schedule due timers, and reconcile in-flight effects. A
failed repository configuration or provider request must not stop unrelated
repositories. Provide CLI status, inspect, pause/resume, cancel, bounded retry,
configuration rollback, and checkpoint migration through a local control socket.
The operator can run that CLI over SSH. No remote HTTP control API in v1.

## Provider and local modes

Codex CLI and Claude Code are adapters behind the same action result contract.
Probe installed capabilities, reject unsupported required features, use explicit
recorded session IDs, and start fresh when bound inputs change. Persist terminal
status and distinguish timeout, cancellation, malformed output, provider failure,
blocked work, and superseded input. One bounded output-correction attempt is
permitted within the same budgets. Record estimated and actual usage separately.

Proposed commands, not implemented yet:

```sh
repo-chap validate ./team-pr/workflow.json
repo-chap replay ./team-pr/workflow.json --fixture ./fixtures/pr.json
repo-chap inspect ./team-pr/workflow.json --repo example-org/sample-app --pr 42
repo-chap run ./team-pr/workflow.json --repo example-org/sample-app --pr 42 --provider codex --mode workspace
repo-chap run ./team-pr/workflow.json --repo example-org/sample-app --pr 42 --provider claude --mode apply --policy ./local-policy.json
repo-chap daemon status
```

Replay uses fixtures, fake time, and stubbed results with no network or model.
Inspect performs live GitHub reads and may run configured analysis. Workspace
mode edits and tests locally without publishing, sending, pushing, or resolving.
Apply displays planned effects and uses explicit local policy for repeated
bounded autonomous work. No mode offers merge. Local GitHub auth uses gh or a
PAT; the daemon uses a GitHub App installation. Credentials stay outside JSON.

## Repair, tests, and remote effects

Repair returns a candidate, blocked, or no-change result. Blocked/no-change work
records a concern suppression key and waits for relevant changed evidence or an
explicit bounded retry. A prompt edit alone does not clear that suppression.
Finalize a candidate commit before required checks and push that identical
object. A conflict merge preserves the relevant PR and base parents. A failed
check blocks push and reports the actual failure. Suggested tests cannot replace
the repository's configured required tests.

Persist external requests before dispatch. Logical identity includes repository,
run generation, effect kind, semantic payload/evidence, and destination; exclude
attempt timestamps and package provenance. A prompt-only update requesting an
identical message must reuse its receipt. Record planned/sending/confirmed/
rejected/unknown and the remote reference or message identity.

Before a push, re-read target repository/ref, lifecycle, draft state, head, current
policy, and required evidence. Require the expected old head to be an ancestor
of the candidate. An explicit expected-old Git lease provides the atomic ref
comparison; the independent ancestry check forbids rewriting published history.
No pushes to default/base branches, deletions, or autonomous fork repairs in v1.
An ambiguous response requires remote-ref inspection, never a newly made commit.

After confirmed push, refresh evidence before resolving specifically addressed
threads. Re-read thread identity/content and current head; changed or uncertain
concerns stay open. Review publication binds the commit, and label changes use
configured labels. A newer head invalidates readiness and pending stale effects.
An effect retry reuses its validated result when inputs remain current; it does
not rerun a repair merely because notification failed.

## Bounded automation

Enforce per-attempt runtime, per-head attempts, total repairs per PR lifecycle,
per-repository and daily installation budgets, output-size limits, and worker
concurrency. Reserve before starting. Unknown monetary usage still consumes
attempt and runtime budgets. Respect rate limits with bounded backoff.

Bot commits are observed normally but never reset lifecycle budgets. Match own
effect receipts rather than ignoring all bots. Unchanged concerns, declined
repairs, and no-change results remain parked. Repeated bot-to-bot edits eventually
hit the run budget and produce a human handoff. Workflow changes do not create
unlimited retries. State exports and Markdown notes never become Git commits.

## Slack

Workflow JSON defines a Slack workspace ID, GitHub-login to Slack-member-ID map,
named channel destinations, a default channel, and routes for needs_author,
needs_team, ready_for_human_merge, and blocked_execution. Resolve GitHub logins
case-insensitively; reject conflicting normalized entries. Resolve a DM through
an explicit mapped member ID. Do not infer identities from display names.

Render validated decision data into Block Kit sections with mrkdwn, a readable
text fallback, PR links, current head, required action, findings, test summary,
and uncertainty. Escape interpolated source text and only expand configured
mentions. Support public/private channels the bot can access and one-to-one DMs.
Tokens remain in installation settings. Preview shows the resolved destination,
formatted content, missing mappings, and truncation before any send.

Use the configured default channel when an author mapping is absent, explicitly
recording the fallback. If that destination is absent or delivery fails, keep
the request visible in the CLI inbox. Store Slack channel and timestamp receipts.
Update the existing open message when the request changes; mark stale requests
superseded. Bound retries and honor Retry-After. An uncertain send remains unknown
until lookup or explicit operator reconciliation establishes its outcome; do not
promise exactly-once delivery. The operator can mark it delivered with a receipt
or authorize a resend while retaining the prior attempt record.

V1 has no Slack approval buttons, slash commands, reply interpretation, or public
decision page. GitHub links and the local CLI supply the detailed evidence.

## Electron

The local app opens a repository, reads/writes workflow JSON and Markdown,
validates with shared code, and preserves unsupported files without rewriting.
Offer source editing and an ordered rule/action view. Reordering a rule changes
priority, not its ID. Show unsaved state and semantic changes. Detect external
file edits before overwrite, and support save, discard, reload, and cancel.

Offline simulation loads fictional or privately captured fixtures and stubbed
agent outputs, advances fake time, and shows the chosen path, rejected earlier
rules, proposed effects, and Slack preview. It never executes code or calls a
provider. Editing a graph position does not change execution digests. Keep the
workflow and trace readable on a laptop, with accessible keyboard controls and
no page-level horizontal scroll. Live read-only trials can be explicitly started in the editor. Local repair/apply trials and daemon operations use the CLI. The editor supports the authoring assistant described below.

## Completion and later work

Verify restart during waits, duplicate observations, lost lease, changed head,
partial reads, invalid provider output, budget exhaustion, invalid configuration,
config changes during an attempt, ambiguous pushes, thread changes, missing Slack
mapping, and uncertain notification delivery through public interfaces.

The personal pilot demonstrates review, tested repair, conditional push, and
channel/DM handoffs with human merge on a private VM. Validate both desktop OS
families and both provider adapters. Work rollout follows the personal evidence.
Daily maintenance, cron schedules, janitorial PRs, performance suites, plugins,
automatic merge, Windows, and remote Electron controls await later refinement.

## Future resilience

A single VM remains an accepted v1 failure point and performance limit. Keep
scheduling, worker execution, and storage separate, with serializable jobs,
logical artifact references, durable claims and effect reconciliation. Shared
data services and coordinated workers/schedulers are later work. See the
architecture document for the concrete requirements and platform limits.

## Local authoring assistant in v1

The Electron editor includes a conversation with an agent running through a
supported local CLI. It can answer questions about the workflow, help create it,
and make visible edits to JSON, referenced Markdown, and local test fixtures.
It can run offline workflow tests and discuss actual results with the person.
The existing PR-review chat feature in another Electron application is technical
prior art for process ownership and interaction, not a product dependency.

Agent edits use the same versioned document model as manual edits. They appear
immediately as staged changes, with changed files, validation errors and undo.
Saving remains an explicit editor operation. Concurrent human edits must not be
overwritten by a response based on an older document revision.

Chat uses the selected provider and may contact that provider through the local
CLI. Simulation itself remains offline, with fixtures, stubbed results and fake
time. The assistant can prepare expected outcomes, run the shared simulation,
and explain pass/fail evidence tied to the tested document and fixture revisions.
Changing a test expectation is a visible edit, not proof that the workflow works.

Keep streaming, cancellation, bounded conversation context, actionable process
errors, and a fresh-session recovery path. The desktop never connects to the
daemon or activates a remote workflow. Normal authoring tools do not push code,
send Slack messages, or perform live PR repairs. Electron also supports explicitly started live read-only trials using real
repository evidence and local CLI providers. Local repair/apply trials remain
CLI operations. Both Codex and Claude provider choices should support this local
collaboration through the same document/test operations.

A live trial requires an explicit start in the UI showing repository/PR,
provider, current workflow revision and the live-read mode. An agent request
can prepare that proposal but cannot silently start a model trial. Results
record the tested head, package/fixture revision, provider and missing evidence.
Changing the draft or PR head marks the old result stale. Cancellation stops
work and preserves already visible edits. Offline simulation stays available
without provider access.
