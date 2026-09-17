# Local Codex analysis

`analyze` explicitly starts Codex to classify and review an inspection capture.
Plain `inspect` remains model-free. Neither command publishes a review, changes
labels, pushes, sends a message, or merges. Analysis uses the captured revisions;
it does not assert that GitHub still has the same head when the command finishes.
Inspect again to assess a newer head.

```sh
repo-chap analyze ./team-pr/workflow.json \
  --capture /private/repo-chap/captures/inspection-example \
  --source-repo /path/to/local/repository \
  --output-dir /private/repo-chap/analysis \
  --provider-config /private/repo-chap/providers.json --profile review --json
```

The local repository must already contain the captured head and target-base
commits and their common history. Fetch those refs with your normal Git tools
before analysis. Repo Chap reads Git objects, never the working tree, and does
not fetch or check out branches. Uncommitted edits cannot change its evidence.
The workflow must have exactly one `agent.classify` and one `agent.review` action.
This direct trial runs those actions explicitly; it does not execute the workflow's
repair, notification, or publication actions. The decision also records the next
rule selected by the shared evaluator.

## Operator profiles and capability checks

Store the following JSON outside Git in a file owned by you with mode 0600.
Replace `model-from-installed-catalog` with a model available to your account and
listed by `codex debug models --bundled`. Profile names belong to Repo Chap.
They are separate from Codex's own `--profile` configuration mechanism.

```json
{
  "schemaVersion": 1,
  "profiles": {
    "review": {
      "provider": "codex",
      "executable": "codex",
      "model": "model-from-installed-catalog",
      "timeoutMs": 120000,
      "maxOutputBytes": 1048576,
      "maxAttempts": 1,
      "maximumCapabilities": ["workspace.read", "workspace.write", "checks.run", "pr.push", "review.resolve", "notify.send"]
    }
  }
}
```

Optional `effort` must be supported for that model in the installed catalog.
Otherwise Repo Chap pins the catalog's default effort. `maximumCapabilities` is
the operator's workflow-validation ceiling. The example permits the declarations
in the supplied team-pr workflow; a review-only workflow can use only
`workspace.read`. This does not authorize `analyze` to execute other actions. Its action
execution policy always permits only `workspace.read`.

The adapter probes the executable version, `exec --help`, top-level help, and the
bundled model catalog. It checks resume help only when an otherwise compatible
session is supplied. These probes make no model request. Missing structured
output, headless execution, explicit settings, sandbox, or local model-catalog
capabilities block the run with a corrective diagnostic. The implementation was
checked against local Codex CLI 0.154.0 help and bundled catalog. Earlier binaries
without these capabilities fail explicitly. A listed model is not proof of
account entitlement or service availability.

Repo Chap sets the model, effort, approval policy `never`, and the read-only or
workspace-write sandbox explicitly. It uses `--ignore-user-config` to keep
unrelated user configuration out of the job. Operator credentials remain in the
supported Codex login store or invocation environment. Repo Chap does not copy,
print, or store credentials in workflow files. Native Codex profiles, custom
provider endpoints from user config, and arbitrary config overrides are not
accepted by this first adapter. Use a separate Repo Chap profile when changing
the provider account. The local catalog cannot prove that credentials are valid.
See the official [Codex automation and authentication guide](https://learn.chatgpt.com/docs/non-interactive-mode).

## Pinned source evidence

`readCapture(directory, package)` verifies the metadata, fixture, and workflow
package binding. `collectSources(repository, headSha, baseSha, signal)` then
returns a version-1 `SourceBundle`. Its SHA-256 digest covers every returned byte
and omission. It includes the complete bounded text trees on both sides of the
PR change, a diff, and per-file paths, Git blob IDs, SHA-256 digests, revisions,
line counts, and exact UTF-8 text.

Three revision fields have different meanings:

| Field | Meaning |
| --- | --- |
| `headSha` | PR head from the inspection |
| `baseSha` | Target branch commit from the inspection, also required in a review result |
| `comparisonBaseSha` | Common ancestor of those commits, used for the diff and source citations on the `base` side |

For example, if the target branch added `target-only.js` after the PR branched,
that file does not appear as a deletion in the PR diff. A `base` citation resolves
against `comparisonBaseSha`, even though the review's `baseSha` identifies the
newer target commit. The source bundle records both. A `head` citation resolves
against `headSha`. Citations must name a supplied file and an existing inclusive
1-based line range. A valid path with a line past EOF is invalid output.

Source collection has a 30-second deadline, 256 files per revision, 256 KiB per
file, 4 MiB of source text, and a 1 MiB diff limit. Binary files, invalid UTF-8,
symlinks, submodules, over-limit files, unreadable objects, and unfinished reads
are explicit `missingEvidence`. An unavailable common ancestor or full diff
blocks model execution. A usable partial bundle can be analyzed, but
classification must be uncertain and review must be partial and inconclusive.
The review must retain each host-recorded omission. Metadata coverage alone
never establishes code coverage. The host also rejects an acceptable verdict
with findings or partial coverage.

## Results and process ownership

`@repo-chap/providers` exports `runCodex(ProviderRequest)`, provider-neutral request,
result, attempt, session, and usage types, source collection, and profile loading.
The request supplies the pinned package/action, source bundle, evidence and
fixture digests, missing evidence, private artifact directory, working directory,
run mode, optional `AbortSignal`, and optional `isCurrent` callback. Inputs are
copied before asynchronous work. Source/evidence contents must match their
digests. Workspace callers own their disposable checkout, candidate checks,
run budgets, and all remote effects. This adapter does not implement repair.

`actionContracts(package, actionId)` in `@repo-chap/workflow` returns the canonical
and configured schema documents with their selected fragments. The adapter puts
both complete documents into the pinned prompt. Codex's generation schema is a
small transport object, `{ "resultJson": "...JSON text..." }`. This avoids claiming
that Codex's generation service accepts every draft 2020-12 keyword or same-file
reference supported by workflow schemas. After decoding, the host always calls
`validateActionPayload`, which enforces both unchanged contracts, then checks
revisions and citations. A schema cannot weaken canonical required fields, and
a stricter configured schema can reject a result even when the transport object
is valid. The wrapper never serves as evidence that domain validation passed.

Outcomes are `completed`, `provider_error`, `invalid_output`, `blocked`, `timeout`,
`cancelled`, and `superseded`. Only completed or domain-blocked results retain a
validated payload. Invalid, failed, or superseded output is never accepted.
The process group includes tools started by Codex. Cancellation and deadlines
send SIGTERM, followed by SIGKILL after at most 200 milliseconds. A normally
exited parent also has its remaining descendants terminated. Stdout and stderr
share one byte limit. Raw streams are discarded; bounded fixed diagnostics,
exit status, retained byte count, and attempt timing remain in the record.

JSONL token counts are recorded as `usage.actual`, or null when absent. Byte-based
estimates stay in `usage.estimated` with their method. These are not price quotes.
The adapter does not invent monetary usage. Runtime callers still own durable
cost reservations and limits across jobs and restarts.

The deadline includes capability probes and all attempts for one action. Profiles
allow at most two attempts, further restricted by workflow attempt/action limits.
There is at most one fresh correction attempt after invalid output, or one fresh
attempt after a resumed provider fails. The CLI shares its workflow attempt
allowance across classification and review. Retrying a CLI command is a new
explicit local trial; durable daemon budgets are separate future work.

Session reuse requires identical provider/profile/version settings, working
directory, action, package, schema, source, evidence, fixture, and missing-evidence
inputs. `--resume /private/prior/decision.json` supplies recorded IDs; there is no
implicit most-recent-session selection. Incompatible inputs start fresh. A lost
session can start fresh within the same remaining deadline and attempt allowance.
`isCurrent` rejects late output; an AbortSignal with reason `superseded` also stops
an active process group. Source changes should abort in-flight callers promptly.

Every CLI trial first writes a new decision with current-analysis flags cleared.
It retains private immutable input files and atomically replaces that trial's
decision record as actions finish. It never imports a previous decision's ready
state when resuming. A catchable interruption records cancellation; a hard crash
can leave `running`, which must not be treated as completion. `analysis_acceptable`
means both analyses were complete and acceptable for captured inputs, not merge
permission. Exit 0 means validated reports were recorded and can still carry
`decision: incomplete`. Exit 5 means analysis could not complete; Ctrl-C exits 130.

## Opt-in provider smoke check for the human pilot

Automated tests use fake executables and fictional Git repositories. They require
no provider credentials or paid calls. Real account access, model quality, and
macOS behavior remain human pilot checks.

To opt in, first log into Codex using its supported login flow, select an installed
model and effort in a private profile, and inspect a personal test PR. Prepare
the corresponding local Git objects. Then run the `analyze` command above against
that private capture. It contacts the selected provider and may consume paid
usage. Check that both result outcomes are `completed`, citations match the pinned
files, missing evidence stays visible, and `usage.actual` is present or explicitly
null. Cancel a second trial and verify a terminal cancellation record. Retain this
evidence privately for the pilot; do not commit captures or account details.
