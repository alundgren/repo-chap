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

The desktop is a visual companion for an agent working in the managed repository.
It discovers workflow files, shows ordered rules and action continuations, and
reloads external edits. Invalid or unsupported files show shared diagnostics.
The app never writes workflow source.

Overview and Simulate are the main views. Simulation distinguishes fictional
tests from captured real PRs, displays selected and rejected rules, proposed
effects, expectation comparisons, and Slack previews. It uses pinned file and
input digests, labels stale results, and makes no model or network calls.

A local CLI API selects workflows, navigates, runs replays, and displays temporary
highlights or annotated arrows. Users can dismiss guidance. The API accepts named
targets from the current workflow, checks the intended repository, and has no
arbitrary script execution. The renderer remains sandboxed with local assets.
Keep the workflow and trace readable on laptop and narrow windows with keyboard
controls and no horizontal page scrolling.

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

## Agent authoring and desktop companion

The user runs their normal agent in the repository being configured. A globally
installed `repo-chap-workflows` skill supplies workflow contracts, validation,
replay, and desktop commands. The agent edits repository JSON, Markdown, and
fictional test fixtures with its ordinary tools and instructions.

Electron is a visual companion with Overview and Simulate views, a repository
picker, and a workflow selector. It reads files from disk and refreshes them as
the agent saves. Overview shows ordered rules, action continuations, timing,
limits, and referenced files. Invalid or unsupported files produce diagnostics
without rewriting the files or displaying an old workflow as current.

The agent steers the running app through `repo-chap desktop` over a private local
Unix socket. Commands open or select a workflow, navigate, load input, replay,
and show temporary highlights or arrows with plain text. Guidance has a bounded
lifetime and can be dismissed by the user. Repository and optional workflow
checks prevent a command from steering an unrelated open workspace.

Simulation uses shared loading, validation, replay, and Slack preview code.
Test fixtures and captured real PRs have separate selections and results. Every
result identifies the workflow and input digests it tested. Changed or unreadable
inputs make retained results stale. A capture records its observed head, time,
and evidence coverage; it never claims current GitHub state. A saved capture can
be replayed against an edited workflow without another network request.

Live GitHub reads, provider analysis, repair, apply, and daemon operations remain
CLI tasks with their existing authorization and recovery behavior. Electron
starts no provider process and has no agent chat, editing controls, or daemon
connection. Runtime state and captured evidence stay outside Git.
