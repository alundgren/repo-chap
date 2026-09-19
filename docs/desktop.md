# Workflow companion

Run your normal agent in the repository you want to configure. Install the
`repo-chap-workflows` skill with `repo-chap skill install` and use it there.
The agent edits JSON, Markdown, and fictional fixtures directly. Electron reads
those files and shows the current workflow and simulation results.

## Start the app

Use Vite+ for development. It selects the pinned Node and pnpm versions:

```sh
vp install --frozen-lockfile
vp run desktop
```

Open repository discovers workflows and shows a selector with names and relative
paths. It honors Git ignores. Discovery checks up to 2000 JSON files; the CLI can
open another path explicitly. A repository without a workflow stays open and
notices when the agent creates one. Unsupported or invalid files show validation
diagnostics without rewriting them.

```sh
repo-chap desktop open --repo-root /path/to/repository --workflow .repo-chap/workflow.json
repo-chap desktop status --repo-root /path/to/repository --json
```

From the source checkout, a known repository can be opened at startup:

```sh
vp run @repo-chap/desktop#start --repo-root /path/to/repository --workflow /path/to/repository/.repo-chap/workflow.json
```

The app restores the last selected repository and workflow after restart. It
reloads files from disk and does not retain unsaved editing buffers. Existing
workflow formats, CLI validation, daemon activation, and runtime limits keep
their existing behavior. Earlier private conversation or trial files are left
in app data; the companion does not load them.

## Understand and test a workflow

Overview shows rules in priority order, followed by their actions. Expand an
action for its continuations, prompt, and permissions. Timing, limits, and file
paths remain in disclosures. The app polls files every 1.5 seconds and refreshes
before CLI commands. Invalid edits remove the current graph and show diagnostics;
fixing the files restores it. The app never writes workflow source.

Simulate has separate Test fixtures and Real PRs selections. Choose a fixture
or a captured PR directory, then Simulate. Results show the stop reason, selected
rules, rejected earlier rules, proposed effects, and expectation comparisons.
Input details contains the fixed clock, observations, and action stubs. Optional
Slack packets produce the same local preview as the CLI.

```sh
repo-chap desktop simulate --fixture .repo-chap/tests/closed.json --json
repo-chap desktop simulate --packets /private/packets.json --json
```

Results retain their tested workflow and input digests. Changed or unreadable
source, fixtures, or packets mark prior results stale. A changed test expectation
also requires a new run. A failed expectation is visible in `comparison.passed`;
a successful command only means the simulation completed.

For real PRs, the agent first captures evidence using the existing CLI:

```sh
repo-chap inspect .repo-chap/workflow.json --repo willow-labs/sample-project --pr 42 --capture-dir /private/repo-chap-captures --json
repo-chap desktop simulate --capture /private/repo-chap-captures/inspection-example --json
```

Use the inspection directory returned by `inspect`. The app verifies its paired
`evidence.json` and `fixture.json`. The display identifies the captured head,
time, and evidence coverage, and says that current GitHub state has not been
checked. Replaying against an edited workflow reuses the saved observation and
identifies its earlier workflow version. A missing model result stays visibly
`needs_result`. It is not evidence of a successful review.

All desktop simulation is offline. Live reads, provider analysis, local repair,
apply, and daemon operations run through their existing CLI commands. The user's
normal agent owns its model, login, repository instructions, and tools.

## Agent navigation and explanations

The CLI controls the running app through a Unix socket in
`~/.repo-chap/desktop/control.sock`. Its directory is user-owned, mode 0700, and
outside Git. There is no TCP listener or MCP setup. To run another instance,
set `REPO_CHAP_DESKTOP_CONTROL` to a separate private directory in both the app
and agent environment. `REPO_CHAP_DESKTOP_DATA` selects a separate Electron
profile outside Git.

```sh
repo-chap desktop select --workflow .repo-chap/other.workflow.json
repo-chap desktop show --view simulation --mode tests
repo-chap desktop show --target action:review
repo-chap desktop highlight --target rule:closed --style arrow --text 'Closed PRs stop here.' --seconds 20
repo-chap desktop clear
```

Status returns available target names. Highlighting navigates to the target,
opens its disclosure, and renders plain text beside it. A single annotation is
visible, lasts 1 to 120 seconds, and can be dismissed with Escape or its close
control. No annotation or navigation command changes source files.

Commands use the current Git root by default. `--repo-root` chooses another root,
and `--workflow` guards commands against a changed workflow selection. `open`
and `select` deliberately change the selection. Wrong-repository commands fail
before changing the view. On a timeout or disconnect, inspect status before
repeating the command. Errors use exit 8; usage errors use exit 64. See
`repo-chap desktop --help` for the full command list.

## Development packages and checks

Build an unpacked Linux application or unsigned macOS bundle outside Git:

```sh
vp run desktop:package --out /tmp/repo-chap-packages --platform linux --arch x64
vp run desktop:package --out /tmp/repo-chap-packages --platform darwin --arch arm64
```

Both platforms accept `x64` and `arm64`. The package includes Electron, fonts,
and JavaScript. Linux launches `Repo Chap-linux-x64/repo-chap-desktop`; macOS opens
`Repo Chap-darwin-arm64/Repo Chap.app`. These are development packages without
signing, notarization, or automatic updates. The CLI installs separately.

```sh
vp run check
REPO_CHAP_DESKTOP_PROOF=/tmp/repo-chap-proof vp exec xvfb-run -a vp run test:desktop
```

The tests use fictional repositories, actual main/preload/renderer code, and
external CLI commands. They cover workflow switching, external edits, invalid
source and recovery, stale results, captured PRs, arrows and expiry, keyboard
navigation, narrow layouts, and restart. Set `REPO_CHAP_DESKTOP_EXECUTABLE` to a
packaged Linux binary to run the same checks against it. Evidence stays outside
Git. macOS execution remains a human pilot check.
