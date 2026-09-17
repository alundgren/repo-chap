# Local workflow editor

Repo Chap's Electron app edits a repository's workflow JSON and its explicit
prompt, output-contract and context-file references. An existing `review.md`
appears when the workflow references it. Markdown links remain text.

Use Node 24 and the pinned pnpm through Corepack:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm desktop
```

Choose **Open repository**, select the repository directory, then choose its
workflow JSON. **Open workflow** selects a JSON file directly and uses its
nearest Git repository as the root. For a plain directory, that shortcut uses
the JSON file's directory. Use Open repository when references need a wider
plain-directory root.

To launch a known local file during development:

```sh
corepack pnpm build
corepack pnpm --filter @repo-chap/desktop start --workflow /path/to/repository/workflow.json --repo-root /path/to/repository
```

The renderer has no Node or filesystem access. The main process owns the open
document session, native pickers, validation and file writes. A sandboxed preload
exposes only the editor operations. Local fonts ship with the app. Opening,
editing and saving never start providers, fetch Markdown links, or connect to
the daemon. The app blocks remote navigation and renderer network requests.

## Saving and recovery

Switching files retains each draft. Removing a reference retains its unsaved
buffer until that draft is saved or discarded. Save all, or Ctrl/Cmd+S, validates the captured
JSON and referenced draft text with `@repo-chap/workflow` before writing. The app
saves exact source text. It does not regenerate IDs, remove fields, format JSON,
or convert Markdown. Unknown data inside `layout` is valid and stays intact.
Other unknown runtime fields remain visible with validation errors. Unsupported
workflow versions and actions open read-only. Nothing is rewritten to make them
look supported.

Each document session has an opaque `sessionId` and a monotonically increasing
`revision`. Edits, reloads, discards and saves require the current token. A stale
request fails without replacing the newer draft. The snapshot contains source
text, dirty and external-change states, file-specific diagnostics, and the
execution package digest when valid. Later editor operations can use that same
token without granting access to arbitrary files.

The app checks disk bytes and resolved paths on focus, periodically while open,
and before saving. An external change blocks the save. Reload file reads the
current disk version; it asks before replacing a dirty draft. Discard changes
restores the last loaded or saved text for the selected file. It does not accept
external disk changes. Cancel leaves the draft in place. Opening another workflow
and closing the window offer save, discard and cancel. Cancelling a native file
picker retains the previous drafts even after choosing Discard and open.

Saving stages files beside their destinations, then replaces each file by rename.
The workflow JSON is written last. A save across several files is not a filesystem
transaction. If a file changes or an I/O operation fails after an earlier file
was saved, the error reports the saved count and keeps the remaining drafts dirty.
Temporary save files are cleaned up after handled failures. A process crash can
leave a temporary `.repo-chap-*.tmp` file, which is never loaded as workflow input.
Unsaved buffers live in memory; the app does not promise crash recovery for them.
Electron profile data stays in its normal user-data directory, outside the
managed repository. `REPO_CHAP_DESKTOP_DATA` can select an isolated profile.

## Development packages

Build an unpacked Linux application or unsigned macOS application bundle into a
directory outside the checkout:

```sh
corepack pnpm desktop:package --out /tmp/repo-chap-packages --platform linux --arch x64
corepack pnpm desktop:package --out /tmp/repo-chap-packages --platform darwin --arch arm64
```

Both platforms accept `x64` and `arm64`. Omitting platform and architecture uses
the build host. The output includes the Electron runtime and bundled JavaScript;
the person launching it does not need Node, pnpm or a running development server.
Launch `Repo Chap-linux-x64/repo-chap-desktop` on Linux. On macOS, open
`Repo Chap-darwin-arm64/Repo Chap.app`. These are local development packages,
without signing, notarization, installers or automatic updates.

Linux needs the desktop libraries required by Electron. CI can use an X display
provided by Xvfb. macOS execution and installation on both supported OS families
remain human pilot checks; cross-packaging a macOS bundle does not prove it runs
on macOS.

```sh
corepack pnpm typecheck
corepack pnpm test
REPO_CHAP_DESKTOP_PROOF=/tmp/repo-chap-proof xvfb-run -a corepack pnpm test:desktop
```

Set `REPO_CHAP_DESKTOP_EXECUTABLE` to a packaged Linux binary's absolute path to
run the same UI checks against that package. Playwright launches Electron with
its test sandbox flags; these checks prove editor behavior and renderer isolation,
not host sandbox enforcement. Test a normal application launch on each target OS
during the human pilot.

The Electron checks exercise actual main/preload/renderer behavior with fictional
local repositories. Native picker responses are supplied by the test while the
app's open operation still loads real files. Proof includes source editing,
validation failure, external-change recovery, close cancellation, narrow layouts,
keyboard focus, original screenshots, a short recording and a labeled comparison
with the approved presentation. All generated evidence stays outside Git.
