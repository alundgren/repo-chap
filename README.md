# Repo Chap

Repo Chap looks after trusted teams' repositories. The first release keeps
GitHub pull requests moving through review, bounded repairs, and readable Slack
handoffs. People merge.

Use your normal agent to edit workflows in the repository you want to configure.
The Electron app is a visual companion for the current workflow, switching
workflows, and replaying test fixtures or captured real PRs. It refreshes saved
files automatically. Your agent can navigate the app and point out changes with
temporary highlights and annotated arrows.

## Install and run Repo Chap

Repo Chap supports macOS and Linux. Install [Vite+](https://viteplus.dev/guide/)
first, then install the CLI and desktop app:

```sh
curl -fsSL https://raw.githubusercontent.com/alundgren/repo-chap/main/install.sh | bash
```

Run the same command again to upgrade. It replaces the CLI and desktop app with
the current `main` versions.

After installing the app, the script asks whether to install the workflow skill
globally. If you agree, the standard `vp dlx skills` agent picker lets you choose
Codex, Claude Code, or another supported agent. Pick the agents where you want
`$repo-chap-workflows` available. The same prompt can update the skill when you
rerun the installer.

The installer builds a clean checkout and writes the application to
`~/.local`. It does not use `sudo`. If it reports that `~/.local/bin` is missing
from `PATH`, add it and open a new terminal. Start a new agent session after
installing or updating the skill.

From the repository containing `.repo-chap/workflow.json`, open the desktop
app with:

```sh
repo-chap-desktop --repo-root "$PWD" --workflow "$PWD/.repo-chap/workflow.json"
```

Leave the app running while the agent works. It refreshes when the agent saves
changes. The agent can select the workflow, run a simulation, and point out
results:

```sh
repo-chap desktop open --repo-root . --workflow .repo-chap/workflow.json
repo-chap desktop status --json
repo-chap desktop simulate --fixture .repo-chap/tests/closed.json
repo-chap desktop highlight --target result --style arrow --text 'Closed PRs finish here.'
```

To install a tag instead of `main`, download the installer and pass `--ref`:

```sh
curl -fsSL https://raw.githubusercontent.com/alundgren/repo-chap/main/install.sh -o /tmp/repo-chap-install.sh
bash /tmp/repo-chap-install.sh --ref v0.1.0
```

For development, clone the repository and run
`vp exec bash install.sh --source . --prefix "$HOME/.local"`.

See [the desktop guide](docs/desktop.md) for app packaging, captured PRs, and
local control commands. Validation and replay also work without Electron.

- [Workflow commands and shared contracts](docs/workflow-api.md)
- [Local workspace repair and recovery](docs/workspace-repair.md)
- [Private analysis daemon and recovery](docs/daemon-analysis.md)
- [Linux service installation, diagnostics and backup](docs/daemon-operations.md)
- [Product brief](docs/product-brief.md)
- [Architecture](docs/pr-workflows/architecture.md)
- [Specification](docs/pr-workflows/specification.md)

The CLI and Electron app target macOS and Linux. The daemon runs on a private
Linux VM with outbound GitHub, model-provider, and Slack connections. Workflow
JSON and referenced Markdown live in each managed repository. The daemon uses
a GitHub App; local trials use gh authentication or a PAT. Electron has no daemon
connection. Multiple workflows can be viewed locally; the daemon registers one
active PR workflow per repository.

## Development

Use `vp` for every project command. Vite+ selects Node from `.node-version`
and pnpm from `package.json#packageManager`, including when your shell has a
different Node version. Install the global Vite+ CLI using the
[official setup instructions](https://viteplus.dev/guide/).

```sh
vp install --frozen-lockfile
vp run build
vp run desktop
```

Run package scripts with `vp run <script>`, tools with `vp exec <tool>`, and
Node files with `vp node <file>`. Use `vp run check` and `vp run test` for this
repo's checks and Node test suite. `vp check` and `vp test` invoke Vite+'s own
lint/type checks and Vitest instead. Use `vp pm pack` to create a package archive.

## Checks

```sh
vp run check
REPO_CHAP_DESKTOP_PROOF=/tmp/repo-chap-proof vp exec xvfb-run -a vp run test:desktop
```

Desktop checks exercise actual Electron windows and the same CLI commands used
by an external agent. Generated screenshots and diagnostics stay outside Git.
macOS execution remains a human pilot check.

## Check the investigation

The [original offline presentation](docs/pr-workflows/README.md) retains its
editor concept as historical design material. The current desktop follows the
agent workflow described above.

```sh
vp run browser:install
vp run docs:validate
vp run docs:browser
```

To rebuild that presentation, run `vp run docs:build`. The generator
requires Python 3. Application and document checks use Vite+ with the pinned Node 24 runtime.
