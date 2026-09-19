# Repo Chap architecture

The CLI, Electron companion, and private daemon share workflow validation and
execution contracts. Repository files remain the authoring format.

## Applications and external systems

```mermaid
flowchart LR
  Engineer[Engineer] --> CLI[repo-chap CLI: macOS and Linux]
  Engineer --> Agent[Normal agent with workflow skill]
  Engineer --> Desktop[Electron: workflow overview and simulation]
  Agent -->|edit| Files
  Agent -->|desktop commands| CLI
  CLI -->|private local socket| Desktop
  CLI --> Core[Shared workflow loading, validation, evaluator and replay]
  Desktop --> Core
  CLI --> Files[Repository JSON and Markdown]
  Desktop -->|read and refresh| Files
  Operator[Operator through SSH] --> Control[repo-chap CLI on the VM]
  Control -->|local socket| Daemon[Linux daemon]
  Daemon --> Core
  Daemon --> DB[(SQLite: runs, timers, budgets, receipts)]
  Daemon --> Artifacts[Private packages, notes and artifacts]
  Daemon -->|outbound reads and effects| GitHub[GitHub public and private repositories]
  Daemon --> Worker[Bounded CLI workers and disposable checkouts]
  Worker --> Provider[Codex or Claude provider]
  Daemon -->|outbound Web API| Slack[Slack channels and DMs]
  Slack --> Team[PR authors and reviewers]
  Team -->|human merge| GitHub
```

The daemon requires outbound connectivity and has no public listener. Its CLI
control socket is local to the VM. The Electron application does not connect
to the daemon. Slack has no interactive callback in v1.

## Code organization

| Directory | Responsibility |
| --- | --- |
| apps/cli | Local commands, inspection, replay, apply, and daemon controls |
| apps/desktop | File refresh, workflow overview, simulation, Slack preview and guidance |
| packages/companion | Desktop control protocol and private local socket |
| skills/repo-chap-workflows | Globally installable agent authoring instructions and starter |
| apps/daemon | Linux entry point, polling, durable scheduling and local controls |
| packages/workflow | File loading, schemas, immutable packages, evaluator, replay |
| packages/github | Authentication, paginated observations and named GitHub effects |
| packages/providers | Codex and Claude subprocess adapters and validated results |
| packages/execution | Local checkout lifecycle, candidate preparation and checks |
| packages/runtime | SQLite runs, timers, leases, budgets and effect receipts |
| packages/slack | Identity mapping, rendering, delivery and message receipts |

CLI and desktop use the shared evaluator. The companion package defines local
commands and their transport; it does not depend on Electron or provider adapters.

## Persisted data

```mermaid
erDiagram
  REPOSITORY ||--o{ WORKFLOW_PACKAGE : owns
  REPOSITORY ||--o{ RUN : owns
  WORKFLOW_PACKAGE ||--o{ RUN : pins
  RUN ||--o{ OBSERVATION : records
  RUN ||--o{ ATTEMPT : schedules
  RUN ||--o{ TIMER : waits
  ATTEMPT ||--o{ ARTIFACT : produces
  RUN ||--o{ EFFECT : requests
  EFFECT ||--o{ RECEIPT : reconciles
```

Runs have independent IDs. A run records a subject kind and subject ID; only
pull requests are executable subjects in v1. Keep PR facts outside general
attempt and effect identity. Later repository jobs can reuse those records.
Store immutable large files outside SQLite and commit references after bytes
exist. state.json is a revisioned export, never a second writable control store.

## An attempt

```mermaid
sequenceDiagram
  participant D as Daemon
  participant G as GitHub
  participant S as SQLite
  participant W as Worker
  D->>G: Poll current PR and source configuration
  D->>S: Claim run and reserve bounded attempt
  D->>W: Pin package, head, base and evidence
  W-->>D: Candidate, blocked or no-change result
  D->>D: Finalize candidate and run required checks
  D->>S: Persist validated effect before dispatch
  D->>G: Recheck ref and conditionally push tested commit
  alt Response is uncertain
    D->>G: Read remote ref before another write
  end
  D->>S: Record receipt, preserve run budgets
  D->>G: Refresh evidence and eligible review threads
```

A process owns remote effects so failed delivery never forces a new repair.
The worker and tests are trusted processes with bounded lifetimes; v1 does not
require containers, microVMs, or hostile-code isolation.

## Configuration recovery

```mermaid
stateDiagram-v2
  [*] --> Watching
  Watching --> Validating: configured branch changes
  Validating --> Watching: invalid, keep last valid package
  Validating --> Watching: valid, activate for new runs
  Watching --> Held: operator rolls back
  Held --> Watching: operator resumes automatic activation
```

Each running PR keeps its pinned package. Explicit migration happens at a
checkpoint and preserves receipts, suppression, and budgets. Markdown references
resolve from the same commit as JSON. Runtime writes stay outside the repository,
so a result export cannot create a new commit and trigger another review.

## Resilience and scaling after v1

The one VM is an accepted v1 failure point and throughput limit. Restart recovery
and backups do not make it highly available. Keep the following requirements in
v1 so later distribution does not require changing workflow definitions:

- Keep evaluation independent of SQLite, filesystem paths, process launching,
  and a long-lived server. Supply observations, configuration, and time as data.
- Dispatch versioned, serializable job inputs and results. Include run/attempt
  identity, pinned input digests, deadline, and ownership token. Local processes
  implement the only transport in v1; do not add a queue service yet.
- Reference artifacts by logical ID and digest. A storage module resolves those
  references to private local files today, with object storage possible later.
  A saved worker directory or conversation is a cache, never required for recovery.
- Keep atomic claim, budget reservation, completion, and outbox operations in the
  runtime storage module. Do not expose SQLite connections to the evaluator or
  provider adapters. A future shared database must preserve those transactions.
- Make ownership and effect reconciliation explicit. Lost ownership rejects late
  results. Duplicate jobs cannot reset budgets or duplicate logical effects.
  A future remote worker must not perform a write merely because it once had a
  lease. Remote preconditions and durable receipt reconciliation remain required.

The first scaling change can move workers to additional VMs or Kubernetes while
retaining one scheduler. Removing scheduler failover risk also requires a shared
transactional store, shared artifact access, coordinated claims, and tested
recovery. A network filesystem containing SQLite is not that design.

Cloudflare Workers or AWS/Azure functions are possible future orchestration
hosts, subject to provider/runtime and credential testing. They are not promised
as interchangeable hosts for native Git and CLI subprocesses. Cloudflare's
[Node compatibility documentation](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
currently lists child_process as a non-functional stub. AWS recommends committing
permanent state to durable services rather than relying on invocation-local state
in [Lambda application design](https://docs.aws.amazon.com/lambda/latest/dg/concepts-application-design.html).
These sources were checked on 2026-09-16. Repo Chap's future deployment would
choose compatible execution workers and storage, rather than moving the current
single-process daemon unchanged.

Later refinement must select recovery-time/data-loss objectives, throughput,
platform, shared storage, credential delivery, and rolling-upgrade behavior before
promising high availability. V1 implements none of those cloud adapters or a
multi-host scheduler.

## Desktop agent collaboration

The agent owns its editing session in the managed repository. The workflow skill
ships with the CLI and installs into the user's global skills directory. It
uses ordinary files, shared validation/replay, and `repo-chap desktop` commands.

Electron's main process owns a read-only repository session. A serialized queue
handles commands and file refresh, and shared loading pins consistent JSON and
references. The renderer receives typed snapshots and renders plain text.
It has no filesystem access, provider process, or editing operation.

The companion socket lives in a user-owned mode-0700 directory outside Git.
It accepts versioned commands with repository and optional workflow checks.
Targets identify visible sections, rules, and actions. Annotation text is inert,
expires automatically, and can be dismissed. No public listener is introduced.

Simulation retains the tested package and input digests. Refresh marks prior
results stale when files change or become unreadable. Test and captured-PR inputs
remain separate. Captures validate their paired evidence and fixture digests,
while existing analysis callers still require the original workflow digest.
Replaying new workflow logic against an older observation makes no live request.

The last repository/workflow selection is saved in private app data. Restart
reloads files from disk, not an unsaved editor buffer. The app neither activates
daemon workflows nor changes remote permissions or run budgets.
