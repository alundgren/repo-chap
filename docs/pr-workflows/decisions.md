# Decisions

## Accepted product constraints

- Product name: Repo Chap. Repository and CLI name: `repo-chap`.
- Independent private repository and product. No integration with another app.
- macOS/Linux CLI and Electron application. Electron supports local file editing,
  simulation, both-provider authoring chat and explicitly started live read-only
  trials. Daemon operations use the CLI on the VM, including through SSH.
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
