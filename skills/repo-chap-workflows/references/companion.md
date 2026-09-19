# Desktop commands

`repo-chap desktop --help` documents the installed command version. Commands
return JSON with `--json`. A successful response includes `state`, workflow
paths, validation diagnostics, view, input, simulation freshness, and `targets`.
An unsuccessful command returns `ok: false` and a corrective error.

Run from the managed repository. The CLI discovers its Git root. For plain
directories or another working directory, supply `--repo-root <root>`.
Commands other than `open` reject a different open repository. Add
`--workflow <repository-relative-path>` to guard against a changed selection.
`select --workflow` deliberately switches workflows in the current repository.
Multiple workflows can be viewed locally; the daemon still registers one active
PR workflow per repository.

| Command | Purpose |
| --- | --- |
| `desktop open --repo-root . --workflow .repo-chap/workflow.json` | Open or switch the repository and workflow |
| `desktop status --json` | Refresh files and read the visible state and valid targets |
| `desktop select --workflow .repo-chap/other.workflow.json` | Switch workflow |
| `desktop show --view overview` | Display rules and action continuations |
| `desktop show --view simulation --mode tests` | Display test fixtures |
| `desktop show --mode pr` | Display captured real PRs |
| `desktop show --target action:review` | Navigate to an existing action and expand it |
| `desktop input --fixture .repo-chap/tests/closed.json` | Load a test without running it |
| `desktop simulate --fixture .repo-chap/tests/closed.json` | Load and replay a test |
| `desktop simulate --capture /private/inspection-directory` | Replay verified captured PR facts |
| `desktop simulate --packets /private/packets.json` | Replay the selected input with Slack packet context |
| `desktop highlight --target result --style arrow --text 'The workflow waits for review here.' --seconds 20` | Navigate and explain a result temporarily |
| `desktop clear` | Dismiss guidance |

Targets include `workflow`, `rules`, `files`, `simulation`, `inputs`, and `result`
when there is a result, plus `rule:<id>` and `action:<id>` from the workflow.
Use returned targets rather than inventing selectors. Annotations render plain
text, replace the previous annotation, and expire after 1 to 120 seconds.
They never write repository files.

Real PR input is a directory produced by:

```sh
repo-chap inspect .repo-chap/workflow.json --repo willow-labs/sample-project --pr 42 --capture-dir /private/repo-chap-captures --json
```

Use the returned inspection directory, not its parent. The capture contains a
paired `evidence.json` and `fixture.json`. Captures retain observed head/base,
collection status, and time. Replaying a capture is offline, even when it shows
real PR data. Use a new `inspect` call for current evidence. A changed workflow
can reuse the same PR observation for comparison, but model analysis commands
still require the matching pinned workflow. Missing model results are reported
as `needs_result`; do not invent them to make a real PR appear reviewed.

If the app is closed, keep editing and use CLI validation/replay. Explain that
the visual companion needs to be started when it would help the user. Installed
users open Repo Chap normally; developers run `corepack pnpm desktop` in the
Repo Chap checkout. A timeout or disconnect does not confirm whether the view
changed. Read status before repeating a command.

The app and CLI share a local Unix socket in `~/.repo-chap/desktop`, outside Git.
For a separate app instance, set `REPO_CHAP_DESKTOP_CONTROL` to the same private
directory in both processes. It must be owned by the current user, mode 0700.
No public server, provider credentials, or MCP registration is involved.
