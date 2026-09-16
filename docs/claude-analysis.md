# Local Claude Code analysis

`repo-chap analyze` selects Claude Code when its named private profile contains
`"provider": "claude"`. It uses the same capture, pinned Git source, result
validation, attempt limits, and decision record as [Codex analysis](codex-analysis.md).
Plain `inspect` remains model-free. Analysis never executes workflow repair or
remote publication actions.

Store this version-1 settings file outside Git, owned by you with mode 0600.
Choose a model available through your supported Claude Code account. Profile
names belong to Repo Chap, not Claude Code.

```json
{
  "schemaVersion": 1,
  "profiles": {
    "claude-review": {
      "provider": "claude",
      "model": "sonnet",
      "effort": "medium",
      "timeoutMs": 120000,
      "maxOutputBytes": 1048576,
      "maxAttempts": 1,
      "maximumCapabilities": ["workspace.read", "workspace.write", "checks.run", "pr.push", "review.resolve", "notify.send"]
    }
  }
}
```

`executable` defaults to `claude`; an explicit executable path is supported.
The capability list above permits validation of the supplied team-pr workflow.
Read analysis still runs only its classification and review actions. A workflow
that declares only read actions can use a `workspace.read` ceiling.

## Installation and authentication

Repo Chap probes `--version` and `--help` without a provider request. It requires
headless JSON/schema output, explicit model/effort/settings, tool and permission
controls, safe mode, MCP configuration, and explicit resume. Missing capabilities
produce an update or profile correction diagnostic. The adapter was checked
against installed Claude Code 2.1.236 help. It checks the effort choices advertised
by that executable and defaults to `medium` when the profile omits effort.
Claude exposes no supported local model catalog in that version. A passed probe
does not verify model availability, model-specific effort behavior, credentials,
or account entitlement. Provider failures remain visible instead of selecting a
replacement model.

Use Claude Code's [supported authentication](https://code.claude.com/docs/en/authentication)
under the account that runs Repo Chap. The adapter retains the CLI's developer
login and environment-based operator authentication. It neither reads nor copies
credentials. Use a different named Repo Chap profile when changing accounts.
Credential values and account details never belong in workflow JSON.

The launch uses `--safe-mode`, empty `--setting-sources`, explicit settings that
disable hooks, empty strict MCP configuration, and `dontAsk` permissions. This
keeps unrelated user/project instructions and tools out of pinned analysis while
retaining normal authentication. It does not use `--bare`, which excludes OAuth
and keychain authentication. Managed operator policies still apply. Native
settings files, arbitrary overrides, plugins, and MCP tools are not profile
options. See the official [CLI reference](https://code.claude.com/docs/en/cli-reference).

Read mode disables built-in tools; the complete bounded evidence arrives on
stdin. Workspace mode exposes Read, Glob and Grep, adds Edit and Write only with
`workspace.write`, and adds Bash only with `checks.run`. Those tools are explicitly
allowed without interactive prompts. The caller must supply a disposable
workspace and enforce candidate, check, budget and effect rules. These permission
settings are not an isolation boundary for hostile code. The adapter itself does
not perform repair, push, review publication, label writes, messaging, or merge.

## Native output and shared validation

Claude receives a direct canonical result schema through `--json-schema` and
returns the action payload in `structured_output` of its JSON result. Its schema
validator uses draft-07, so Repo Chap selects the known canonical definition and
renames its internal definition references for that generation format. It does
not translate arbitrary workflow schemas. Both original schema documents remain
in the pinned prompt, and the host validates the returned payload against the
unchanged canonical and configured draft-2020-12 contracts. A relaxed configured
schema cannot remove canonical requirements; a tighter one can reject Claude's
otherwise valid native output. This follows the documented [structured-output
format](https://code.claude.com/docs/en/agent-sdk/structured-outputs).

The shared runner then validates head/base revisions, source paths and inclusive
line ranges, allowed classification labels, unique finding IDs, and coverage.
A missing binary file or unavailable metadata must remain explicit. Classification
becomes uncertain, and review becomes partial and inconclusive. A valid native
JSON response alone never establishes a clear review.

Claude stdin is capped at 10 MiB. Probes and all attempts share one deadline;
stdout and stderr share the configured byte limit. The shared process owner
terminates descendants on timeout, cancellation, supersession, and normal parent
exit. Records retain fixed corrective diagnostics, status, timing and bounded
byte counts, not raw streams that might contain account information.

`usage.actual.inputTokens` includes Claude's reported uncached input, cache reads,
and cache creation. `cachedInputTokens` is the cache-read subset;
`cacheCreationInputTokens` records cache creation separately. Missing or malformed
counters leave actual usage null. Byte estimates remain in `usage.estimated`.
Claude's `total_cost_usd`, when present, is retained only as
`usage.estimated.costUsd` with `costMethod: provider_reported_estimate`, because
Claude documents it as an estimate rather than a billed amount. No absent cost
is replaced with zero. See [programmatic usage](https://code.claude.com/docs/en/headless).

`runProvider(request)` dispatches either supported provider; `runClaude(request)`
and `runCodex(request)` remain available. Callers use the shared request/result
contracts and do not need to decode either provider's transport. Session reuse
requires an explicit recorded UUID and matching provider settings, CLI version,
working directory and every pinned input revision. Changed inputs start fresh.
A lost compatible session may receive one fresh attempt within the same deadline
and remaining allowance. There is no implicit latest-session selection. A new
CLI decision always clears earlier readiness before replacing analysis.

## Opt-in smoke check for the human pilot

Automated tests use fake executables and fictional local repositories. They need
no credentials or paid provider calls. Native macOS execution, real authentication,
requested model/effort behavior and review quality remain human pilot checks.

After configuring a supported login and private profile, capture a personal test
PR and fetch its head/base history into your local repository. Then explicitly run:

```sh
repo-chap analyze ./team-pr/workflow.json \
  --capture /private/repo-chap/captures/inspection-example \
  --source-repo /path/to/local/repository \
  --output-dir /private/repo-chap/analysis \
  --provider-config /private/repo-chap/providers.json \
  --profile claude-review --json
```

This command contacts the provider and may consume paid usage. Verify completed
classification and review, pinned citations, visible missing evidence, and separate
actual/estimated usage. Repeat with `--resume /private/prior/decision.json`, then
cancel a trial and confirm a terminal cancellation record and stopped processes.
Keep the evidence outside Git for the personal pilot.
