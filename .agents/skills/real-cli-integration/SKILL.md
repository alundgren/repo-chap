---
name: real-cli-integration
description: Run an explicitly requested desktop integration check with the installed Codex or Claude CLI and real model calls.
---

# Real CLI integration

Run only when the user explicitly requests this skill or a real-CLI integration
check. Ordinary implementation, PR validation and automated tests do not invoke
it. This check uses the local provider login and consumes model usage.

Use the provider, model and executable from the user's request or the failure
being investigated. If those are unknown, ask which provider and model to test.
Resolve the executable before changing PATH for Node or pnpm, so a second CLI
installation cannot silently replace the one the user runs. Preserve the user's
normal HOME, CODEX_HOME and CLAUDE_CONFIG_DIR settings. Do not create a clean
provider home to make a failing integration pass.

From the repository root, build with Node 24 and the pinned Corepack pnpm, then
run the bundled script with explicit model-call authorization:

```sh
corepack pnpm build
corepack pnpm exec node .agents/skills/real-cli-integration/scripts/run.mjs \
  --provider codex --model MODEL --executable /absolute/path/to/codex \
  --allow-model-calls
```

Use `--provider claude` for Claude Code. The executable defaults to the provider
name on PATH when omitted. `--help` performs no model call.

The script opens actual Electron with a fictional workflow and private app data
in a temporary directory. It checks real provider startup, registered author
reads and edits, validation, a second turn in the same session, visible unsaved
changes, Undo, and explicit Save. It never opens the user's working repository
as the test document. Passing requires document state and operation receipts;
assistant prose alone is insufficient. It makes at most two turns, with a
three-minute provider deadline for each, and no automatic retries.

On failure, inspect the retained report and screenshot outside Git. Identify the
actual tool call and response when needed; separate a denied tool attempt from
an accepted app operation. Fix the demonstrated failure, then rerun only within
the user's requested test scope. Do not weaken assertions, change the selected
model or disable inherited settings to obtain a pass.

Report provider/model, executable version, passed and failed stages, and the
private report path. Distinguish this real run from fixture tests. Keep reports,
transcripts, screenshots and machine paths out of commits and PR bodies.
