---
name: repo-chap-workflows
description: Create, change, explain, and test Repo Chap PR workflows in the current repository, using the desktop app as a visual companion. Use for Repo Chap workflow JSON, prompts, fixtures, simulations, and captured PRs, not generic GitHub Actions workflows.
---

# Repo Chap workflows

Work in the repository the user wants to configure. Use your normal file tools,
repository instructions, and agent session. Electron displays those files and
simulation results. It has no chat or editing session to initialize.

On the first invocation in a conversation, ask: "Would you like me to open the
Repo Chap desktop companion so you can follow the workflow visually?" Honor
an answer or launch request already given in the conversation instead of asking
again. Continue independent authoring work while awaiting the answer. If the
user declines, use CLI validation and replay without repeating the offer.
If they accept, follow [the companion launch instructions](references/companion.md#launching-the-app).

Find existing workflow JSON and its referenced Markdown before creating files.
Use `.repo-chap/workflow.json` for a first workflow unless the repository has
another convention. Keep unrelated edits. For a new workflow, start from
[the starter](assets/workflow.json) and adapt it to the requested behavior.
The starter only waits or finishes; it does not perform reviews or repairs.
Read [the workflow guide](references/workflows.md) when adding rules, actions,
prompts, or test fixtures. `repo-chap schema workflow`, `schema fixture`, and
`schema results` print the installed version's complete contracts.

Edit JSON, Markdown, and fictional test fixtures directly on disk. Validate
with `repo-chap validate <workflow> --repo-root <root> --json`. Replay relevant
fixtures with `repo-chap replay <workflow> --fixture <fixture> --json`. Check
the returned comparison and actual trace; a command exit of zero does not mean
expectations passed. Diagnose unexpected behavior before changing expectations.
The CLI works when the desktop is closed.

When the desktop is running, open the intended repository and workflow:

```sh
repo-chap desktop open --repo-root . --workflow .repo-chap/workflow.json --json
repo-chap desktop status --json
```

The app reloads saved files automatically. Keep it on the workflow you are
discussing. Use `desktop show --view overview` or `--view simulation` to navigate.
Read `targets` from status before pointing at a rule or action. For example:

```sh
repo-chap desktop simulate --fixture .repo-chap/tests/closed.json --json
repo-chap desktop highlight --target rule:closed --style arrow --text 'Closed PRs finish here before any agent action runs.' --seconds 20
```

Use a short highlight to explain a specific recent change or result. One
annotation is visible at a time. It expires automatically; `desktop clear`
removes it immediately. The user can dismiss it. Do not repeat a dismissed
annotation unless it helps answer a new request. More commands and recovery
details are in [the companion guide](references/companion.md).

For real PR evidence, use the existing `repo-chap inspect` command and a private
capture directory outside Git. Show the resulting inspection directory with
`desktop simulate --capture <inspection-directory>`. Real PRs are captured
snapshots, not current GitHub status. Captures can be replayed against a changed
workflow, and the app identifies when the capture used an earlier version.
Do not copy private evidence into repository test fixtures. Use fictional
repositories, people, and Slack IDs in committed examples.

Workflow editing and offline replay do not authorize pushes, publication,
Slack delivery, daemon activation, or merges. Preserve the user's existing
authorization for live actions and use the relevant CLI mode when requested.
Keep credentials and runtime state outside the managed repository. No special
Codex home, provider profile, model, or MCP setup is needed for authoring.
