# Repo Chap: repository care, starting with pull requests

Repo Chap helps trusted teams keep their repositories in working order.
Its first release handles PR review, routine repairs, and clear handoffs to
people. It runs on the team's own machines and supports public and private
GitHub repositories.

The implementation has three applications:

- A macOS and Linux CLI for validation, offline replay, live local trials,
  and daemon operations.
- A macOS and Linux Electron visual companion for viewing workflows and
  simulating their behavior locally. It does not connect to the daemon in v1.
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

The engineer runs their usual agent in the repository to edit workflow JSON,
referenced Markdown, and fictional test fixtures. A globally installed skill
teaches the agent the file contracts and shared CLI validation and replay.
Electron shows the current workflow and simulation results, refreshes agent
edits from disk, and accepts local navigation and explanation commands.

Offline replay requires neither network access nor credentials. Real PR captures
stay private and retain their observed revision and time. Live reads, model calls,
local repairs, and remote apply use separate CLI modes. An explicitly configured
apply policy authorizes autonomous effects within its bounds; a person merges.

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
must produce bounded and explainable outcomes. The same repository files can be edited with an agent
and viewed and simulated locally in Electron on macOS and Linux.

A work deployment follows the personal trial, using that environment's GitHub
App installation, Slack app, provider access, repositories, and private VM.

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
