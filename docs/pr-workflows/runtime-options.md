# CLI workers and daemon operation

Repo Chap v1 runs trusted repository code. Use a dedicated daemon account,
disposable checkouts, bounded child processes, and a private state directory.
Containers are an operator packaging option, not a required execution platform.
KVM, gVisor, hostile-checkout sandbox tests, and provider/tool network separation
are outside the agreed first release.

## Provider adapters

The investigation recorded Codex noninteractive execution, structured results,
event output, and explicit session resume, and equivalent Claude Code headless
capabilities. See [Codex noninteractive documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
and [Claude Code headless documentation](https://code.claude.com/docs/en/headless).
These are prior research links, not a claim that a particular installed version
supports every flag. Implementation must probe the installed binary and test
its exact behavior, including interruption and schema handling.

Local trials use supported developer authentication. A shared daemon uses
operator-configured provider access. Do not copy another person's login into
committed files or hard-code account details. Keep provider choice, model, effort,
timeout, and other supported settings in named configuration profiles. A profile
must fail visibly if the chosen CLI cannot honor required settings.

The adapter owns subprocess lifetime, bounded streams, structured final output,
usage reporting, and session identity. The caller supplies pinned inputs and
run mode. Start a new session after incompatible head, package, evidence, or
provider settings change. A timeout terminates descendants and records a
terminal result; it must not leave a background repair running.

## GitHub access

Local commands accept an existing gh login or a PAT outside repository JSON.
The daemon uses a GitHub App installation authorized for its configured public
and private repositories. Refresh installation tokens before expiry and surface
installation removal or insufficient access per repository.

The App can disable webhook delivery, as documented in
[GitHub App registration](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).
Poll with pagination and rate-aware scheduling. No public webhook URL is needed.

An exact expected-old lease can conditionally update a Git ref. Independently
reject non-fast-forward candidates because a lease alone can permit history
rewrites. See [git push](https://git-scm.com/docs/git-push). Push the same commit
that passed required checks, then reconcile an uncertain outcome by reading
the remote ref. Do not infer atomic compare-and-swap from GitHub's REST update-ref
endpoint, which does not document an expected-old parameter.

## Linux deployment

Provide a systemd service, private persistent SQLite/artifact directories,
operator-controlled environment/credential files, and a local Unix control socket.
The daemon should run without a public listener and recover after host restart.
Use the installed CLI locally or over SSH for status, pause, bounded retry,
configuration rollback, and waiting-run migration.

Document backup and restore with compatible database versions, safe upgrades,
log retention, and clean shutdown. Preserve state while replacing application
binaries. Check the actual daemon account's provider tools and repository test
commands with a diagnostics command before activating apply mode.

## Proof required before the pilot

Use local fake remotes, fake providers, and fake clocks for deterministic crash,
lease, stale-head, timeout, and budget tests. Then verify both real provider
adapters with supported credentials, the GitHub App installation, and Slack
channel/DM delivery on personal test repositories. Keep that evidence private.
