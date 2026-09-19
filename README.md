# Repo Chap

Repo Chap looks after trusted teams' repositories. The first release keeps
GitHub pull requests moving through review, bounded repairs, and readable Slack
handoffs. People merge.

Use your normal agent to edit workflows in the repository you want to configure.
The Electron app is a visual companion for the current workflow, switching
workflows, and replaying test fixtures or captured real PRs. It refreshes saved
files automatically. Your agent can navigate the app and point out changes with
temporary highlights and annotated arrows.

## Install the workflow skill

Build with Node 24 and the pinned pnpm:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
mkdir -p /tmp/repo-chap-cli
corepack pnpm --filter repo-chap pack --pack-destination /tmp/repo-chap-cli
npm install --global /tmp/repo-chap-cli/repo-chap-0.1.0.tgz
repo-chap skill install
```

The CLI includes `repo-chap-workflows` and installs it into
`~/.agents/skills/repo-chap-workflows`, Codex's
[user skill directory](https://developers.openai.com/codex/skills/).
Use `--replace` to update an existing copy. The installer leaves other skills
and agent configuration alone.

Start your normal Codex agent in the repository you want to configure and ask
it to use `$repo-chap-workflows`. Start the desktop app from this checkout with:

```sh
corepack pnpm desktop
```

The agent can open the relevant workflow and explain it in the app:

```sh
repo-chap desktop open --repo-root . --workflow .repo-chap/workflow.json
repo-chap desktop status --json
repo-chap desktop simulate --fixture .repo-chap/tests/closed.json
repo-chap desktop highlight --target result --style arrow --text 'Closed PRs finish here.'
```

See [the desktop guide](docs/desktop.md) for app packaging, captured PRs, and
local control commands. Validation and replay also work without Electron.

- [Workflow commands and shared contracts](docs/workflow-api.md)
- [Local workspace repair and recovery](docs/workspace-repair.md)
- [Private analysis daemon and recovery](docs/daemon-analysis.md)
- [Linux service installation, diagnostics and backup](docs/daemon-operations.md)
- [Product brief](docs/product-brief.md)
- [Architecture](docs/pr-workflows/architecture.md)
- [Specification](docs/pr-workflows/specification.md)
- [Decisions](docs/pr-workflows/decisions.md)

The CLI and Electron app target macOS and Linux. The daemon runs on a private
Linux VM with outbound GitHub, model-provider, and Slack connections. Workflow
JSON and referenced Markdown live in each managed repository. The daemon uses
a GitHub App; local trials use gh authentication or a PAT. Electron has no daemon
connection. Multiple workflows can be viewed locally; the daemon registers one
active PR workflow per repository.

## Checks

```sh
corepack pnpm check
REPO_CHAP_DESKTOP_PROOF=/tmp/repo-chap-proof xvfb-run -a corepack pnpm test:desktop
```

Desktop checks exercise actual Electron windows and the same CLI commands used
by an external agent. Generated screenshots and diagnostics stay outside Git.
macOS execution remains a human pilot check.

## Check the investigation

The [original offline presentation](docs/pr-workflows/README.md) retains its
editor concept as historical design material. The current desktop follows the
agent workflow described above.

```sh
corepack pnpm browser:install
corepack pnpm docs:validate
corepack pnpm docs:browser
```

To rebuild that presentation, run `corepack pnpm docs:build`. The generator
requires Python 3. Application and document checks use Node 24 and Corepack.
