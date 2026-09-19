# Repo Chap

Run the desktop app from this checkout:

```sh
corepack pnpm desktop
```

First run requires Node 24 and `corepack pnpm install --frozen-lockfile`.

Repo Chap looks after trusted teams' repositories. The first release keeps
GitHub pull requests moving through review, bounded repairs, and readable Slack
handoffs. People merge.

Status: the `repo-chap` CLI supports offline validation/replay, GitHub capture,
provider analysis, tested local workspace repair and a private Linux daemon.
The Electron app edits workflow source, runs offline simulations and discusses
captured drafts and results through a selected local Codex or Claude CLI.
See [workflow commands and shared contracts](docs/workflow-api.md) to build,
install, validate the supplied example, and replay fictional fixtures.

- [Local workspace repair and recovery](docs/workspace-repair.md)
- [Private analysis daemon and recovery](docs/daemon-analysis.md)
- [Desktop workflow editor and discussion](docs/desktop.md)
- [Linux service installation, diagnostics and backup](docs/daemon-operations.md)
- [Product brief](docs/product-brief.md)
- [Architecture](docs/pr-workflows/architecture.md)
- [Specification](docs/pr-workflows/specification.md)
- [Investigation and interactive presentation](docs/pr-workflows/README.md)
- [Decisions](docs/pr-workflows/decisions.md)

The CLI and Electron app target macOS and Linux. The daemon runs on a private
Linux VM using outbound GitHub, model-provider, and Slack connections. Workflow
JSON and referenced Markdown can live in each managed repository. The daemon
uses a GitHub App; local trials can use gh authentication or a PAT.

Daily architecture checks, documentation upkeep, janitorial PRs, and performance
regression workflows are later work. This repository is private for now.

## Check the investigation

Use Node 24 with Corepack to validate the checked-in documentation and presentation:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm browser:install
corepack pnpm docs:validate
corepack pnpm docs:browser
```

To rebuild the presentation after editing its template or inputs, run
`corepack pnpm docs:build` before validation. That generator still requires
Python 3, with no third-party Python packages. Validation itself uses TypeScript.

The document checks validate illustrative contracts and the offline presentation.
Application behavior is covered separately by `corepack pnpm check`. Browser
evidence stays in system temporary storage and is never committed.

## Local authoring assistant in v1

Discuss currently supports streamed questions, follow-ups, input replies,
cancellation and provider-specific sessions. Editing/test tools and explicitly
started live trials below remain later v1 implementation work.

The complete v1 assistant will run through a supported local CLI. It will answer
questions about the workflow, help create it,
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

## Real CLI integration check

Explicitly invoke `$real-cli-integration` to check desktop authoring with your
installed Codex or Claude CLI and a selected model. This uses real model calls
and a temporary fictional workflow. It checks draft edits, validation, session
resume, Undo and Save. The skill does not run automatically or in CI.
See [the skill](.agents/skills/real-cli-integration/SKILL.md) for the command.
