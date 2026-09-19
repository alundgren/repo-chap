# Decisions

## Accepted product constraints

- Product name: Repo Chap. Repository and CLI name: `repo-chap`.
- Independent private repository and product. No integration with another app.
- macOS/Linux CLI and Electron application. The user authors workflows with their
  usual agent and a globally installed skill. Electron shows workflows, simulation
  and captured PR evidence, with local CLI navigation and temporary annotations. Daemon operations use the CLI on the VM, including through SSH.
- Single daemon on a Linux VM without public ingress. Poll GitHub and use
  durable timers. Slack and model requests are outbound.
- Public and private GitHub repositories, including organizations. Use a GitHub
  App for the daemon and existing gh authentication or a PAT for local trials.
- Trusted users, repositories, and PRs. Hostile-checkout isolation, microVMs,
  network allowlists, and multi-tenant execution are not v1 requirements.
- Automatic review, classification, conflict/review repair, checks, conditional
  push, and eligible thread resolution. Humans merge in v1.
- Codex CLI and Claude Code adapters. Operator-configured supported provider
  access. No hosted runner execution dependency.
- Repository-owned workflow JSON and referenced Markdown, including existing
  review.md. Automatically activate valid versions from a configured branch.
- Each running job pins a complete immutable package. Invalid updates retain
  the last valid version. CLI rollback holds until automatic activation resumes.
- Slack is the first real messaging integration. Rich blocks and text fallback,
  GitHub-login mappings to Slack member IDs, channel delivery and author DMs.
- A personal pilot precedes the work deployment.

## Implementation direction

Use TypeScript for the applications and shared workflow code, SQLite on a local
persistent volume for the daemon, and plain repository files for authoring.
The three applications share parsing, validation, evaluation, and replay.
Persist run and repository identity independently of PR-specific observations.
No general plugin framework or daily-job scheduler is needed in v1.

The daemon owns remote effects so retries can reuse results and reconcile
uncertain writes. This is a reliability decision for trusted users. Use separate
working directories and bounded child processes. Do not require containers;
operators may install the daemon in a container when their toolchains permit it.

Keep one active PR workflow per registered repository in v1. The configured
source branch defaults to its default branch. New PR runs use the active
package; existing runs keep their package until explicitly migrated at a
checkpoint. Permission revocation and installation ceilings apply immediately.
An operator rollback suspends source auto-activation until explicitly resumed.

Keep runtime notes, results, and state outside Git. Own commits do not reset
budgets. Suppress unchanged concerns and no-progress repair loops. Rejected or
missing configuration blocks only the affected repository, never the daemon.

## Later refinement

Daily repository maintenance, scheduled performance suites, janitorial PRs,
automatic merge, Slack approvals, Electron daemon controls, Windows clients,
automated fork repair, arbitrary plugins, distributed scheduling, and multi-tenant
hosting are deferred. The first maintenance workflow gets its own refinement
once the PR pilot provides operational evidence.

## Validation still to perform during implementation

- Provider capability probes for the installed CLI versions, structured output,
  interruption, usage reporting, and supported local/daemon authentication.
- Crash recovery after remote acceptance but before receipt persistence.
- Conditional Git push against an exact observed ref while independently
  rejecting any non-fast-forward candidate.
- Slack channel and DM delivery, missing identity mappings, rate limits, and
  uncertain delivery without repeated messages.
- Personal pilot with fictional/public test content before work installation.

These are implementation acceptance cases, not completed experiments.

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
