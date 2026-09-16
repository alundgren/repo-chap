# Repo Chap: repository care, starting with pull requests

Repo Chap helps trusted teams keep their repositories in working order.
Its first release handles PR review, routine repairs, and clear handoffs to
people. It runs on the team's own machines and supports public and private
GitHub repositories.

The implementation has three applications:

- A macOS and Linux CLI for validation, offline replay, live local trials,
  and daemon operations.
- A macOS and Linux Electron app for editing workflow files and simulating
  their behavior locally. It does not connect to the daemon in v1.
- A daemon on a private Linux VM. It polls GitHub, schedules bounded work,
  persists progress, and sends Slack messages through outbound connections.

The applications share workflow loading, validation, evaluation, and simulation
code. They do not depend on another product, a hosted runner, a public endpoint,
or a browser service. Run the CLI on the VM, locally or through SSH, to control its local socket.

## First release

An engineer configures a repository and its workflow location. The daemon reads
current PR facts, waits for configured delays or external reviews, classifies
and reviews changes, repairs conflicts or actionable review findings, runs
required checks, and conditionally pushes the tested commit. A person merges.

Codex CLI and Claude Code are selectable agent providers. Local trials use the
developer's supported provider login and gh login or a PAT for GitHub. The
daemon uses a GitHub App installation and operator-configured provider access.

Slack is the first real messaging integration. A request explains the decision
needed, the PR and current commit, useful findings, attempted repairs, and test
evidence. Messages use formatted blocks and readable text, with links to GitHub.
Workflow JSON can map GitHub logins to Slack member IDs and route messages to
named channel IDs or the author's DM. Delivery failures and missing mappings
remain visible through the CLI. The complete decision record remains local.

Slack messages do not perform approvals or merges in v1. An offline simulation
shows the proposed route and message without contacting Slack or running models.

## Files belong with the repository

Workflow JSON and its Markdown prompts may live in the managed repository.
An action may reference an existing review.md by relative path within that
repository. The daemon watches a configured branch, normally the default branch,
and automatically activates valid changes.

Activation resolves the JSON and every referenced Markdown file from one commit
into an immutable package. Missing files, invalid references, incompatible
schemas, and unbounded execution cycles reject the new version. The last valid
version continues to work. If there has never been a valid version, that
repository stays visibly blocked while other repositories continue.

Running jobs keep their pinned package. The CLI can pause work, select an older
valid version, or migrate waiting jobs at a recorded checkpoint. An explicit
rollback holds that version until the operator resumes automatic activation,
so polling does not immediately undo the rollback.

The people and repositories are trusted. A configuration PR may be inspected
with its own proposed instructions during a local trial. The runtime must still
pin those files before starting so an edit cannot change an executing job.

Runtime state, notes, generated results, logs, and the database stay outside the
managed checkout. Recording a result never creates a commit. Bot-authored
commits receive normal observation, but they do not reset repair or cost limits.
The daemon recognizes its own confirmed effects, suppresses unchanged concerns,
and stops repeated repairs that make no progress.

## Local authoring

The engineer opens a repository, edits its JSON and referenced Markdown, checks
validation errors, and simulates a PR using fictional or locally captured facts.
The editor explains which rule matched, what the action would do, and what a
Slack recipient would receive. Saving changes preserves the file format used
by the CLI and daemon. Unsaved work, external file edits, and invalid JSON need
clear recovery paths. Unknown formats open without destructive rewriting.

Live reads, model calls, local repairs, and remote apply are separate CLI modes.
An offline replay requires neither network access nor credentials. A workspace
trial may edit and test a disposable checkout while retaining the proposed
patch locally. An explicitly configured apply policy authorizes repeated
autonomous effects within its bounds, with human merge retained.

## Reliability for trusted teams

The daemon stores runs, attempts, timers, budgets, and effect receipts in SQLite
on a local persistent volume. A restart resumes waiting work and reconciles
uncertain remote writes. A changed PR head rejects stale work. A failed Slack
send does not repeat the code repair that produced the message.

Per-attempt deadlines, process cleanup, per-run repair limits, repository budgets,
and installation ceilings are execution controls. They remain in force across
new commits and workflow versions. Workflow mistakes must not stop the whole
daemon or create an unlimited notification loop.

## Later repository work

Daily architecture checks, stale-documentation fixes, small janitorial PRs, and
performance regression runs belong to later refinement. V1 does not implement
those workflows or a general plugin system.

Persist repository and run identity separately from PR-specific observations.
Keep PR collection and actions in explicit modules. This lets a later daily
repository job reuse execution, budgets, results, and notifications without
inventing a PR number. It does not require a second trigger type in v1.

## Evidence of completion

A personal pilot must show an ordinary review and a PR with a conflict or an
actionable review progressing to a useful Slack handoff. The pushed commit
matches the tested commit. A person performs the final merge. Restart, stale
head, invalid configuration, repeated bot activity, and uncertain Slack delivery
must produce bounded and explainable outcomes. The same workflow can be edited
and simulated locally in Electron on macOS and Linux.

A work deployment follows the personal trial, using that environment's GitHub
App installation, Slack app, provider access, repositories, and private VM.

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
