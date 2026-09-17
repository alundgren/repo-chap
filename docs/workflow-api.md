# Workflow validation and offline replay

`@repo-chap/workflow` owns loading, validation, package digests, rule evaluation,
and offline replay. `apps/cli` bundles it into an installable `repo-chap` command.
The editor and daemon should import this package instead of copying its rules.
The runtime schemas are `packages/workflow/src/workflow.schema.json` and
`packages/workflow/src/fixture.schema.json`. The older schemas under
`docs/pr-workflows` remain illustrative action contracts and design inputs.

## Commands

Use Node 24 and the Corepack-pinned pnpm version:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
node apps/cli/dist/cli.js validate docs/pr-workflows/examples/team-pr/workflow.json
node apps/cli/dist/cli.js replay docs/pr-workflows/examples/team-pr/workflow.json --fixture fixtures/replay/conflict.json --json
corepack pnpm --filter repo-chap pack --pack-destination /tmp/repo-chap-package
corepack pnpm add --global /tmp/repo-chap-package/repo-chap-0.1.0.tgz
repo-chap --help
```

The package contains a bundled JavaScript executable and has no installed runtime
dependencies beyond Node. pnpm's global bin directory must be on `PATH` for a
global install. A local install also exposes `node_modules/.bin/repo-chap`.

The repository root defaults to the nearest ancestor containing `.git`. Supply
`--repo-root <directory>` when validating a plain directory. Both commands accept
`--json`. JSON goes to stdout, including diagnostics; ordinary errors go to
stderr. Successful JSON responses have `schemaVersion: 1`.

| Exit | Meaning |
| --- | --- |
| 0 | Valid package or a completed simulation |
| 2 | Invalid workflow, reference, contract, or package |
| 3 | Invalid fixture or stub payload |
| 64 | Invalid command or option |
| 70 | Unexpected internal failure |

A simulated block, wait, missing result, or request for another observation is a
successful simulation. Check the JSON `status`, rather than interpreting exit 0
as permission to act. `merge` is not a command and no package may request merge.

GitHub inspection and its bound private evidence files are documented in
[the inspect contract](github-inspect.md). Inspect exports this same fixture
format; offline replay remains credential-free and accepts the fixture directly.

## Pinned packages

`loadWorkflow(path, { repositoryRoot, maximumCapabilities })` reads local UTF-8
files and rechecks them before returning. `buildPackage(workflowPath, sourceFiles,
{ maximumCapabilities })` accepts a map of repository-relative paths to text.
The daemon can supply files from one immutable Git revision; the editor can
supply a captured document revision. Those callers own revision consistency.
Neither function fetches files or follows Markdown links.

Paths in `prompt`, `outputSchema`, and `contextFiles` resolve relative to the
workflow file, including `..` paths that stay within the repository. Missing
files, out-of-root paths and symlinks, duplicate JSON properties, invalid UTF-8,
files above 1 MiB, packages above 8 MiB or 256 files, and unsupported schemas
fail with a `WorkflowError`. Its `diagnostics` contain `code`, `path`, and
`message`. Output contracts use JSON Schema draft 2020-12, optionally select a
JSON Pointer fragment, and allow only same-file schema references.

A `WorkflowPackage` is deeply frozen and serializable. It contains the parsed
workflow, exact file text and per-file digests, repository-relative workflow
path, and a package digest. Later disk edits cannot change the captured package.
Local reads detect changes during loading; a daemon must still load from one
fixed Git revision rather than treating filesystem checks as a Git snapshot.

The package digest is `sha256:` plus lowercase SHA-256 hex over canonical JSON
with `schemaVersion`, `workflowPath`, `workflow`, and `files`. Object keys sort
lexically; arrays preserve order. The workflow excludes top-level `layout` and
uses parsed JSON, so whitespace and object-key order do not affect execution.
Referenced files sort by repository-relative path and contribute their exact
UTF-8 text. The raw workflow remains in `files` for authoring, but its raw file
digest is not part of the execution digest. Changing a context file or rule
order changes the package digest. Moving a graph node or formatting JSON does
not. Execution never reads `layout`.

## Validation and action registry

`validateWorkflow(value, maximumCapabilities)` validates structure and semantics.
The optional capability ceiling defaults to the supported built-in capabilities
for offline use. A live caller must supply the operator's actual ceiling.
Rules keep their array priority. Rule IDs compare after NFKC normalization,
trimming and lowercase conversion. Action IDs follow the lowercase schema.
The validator also rejects unknown actions, missing continuations, incompatible
execution types or capabilities, unreachable actions, and paths that reach
candidate checks, push, or thread resolution without their required predecessor.
Starting a repair invalidates the previous candidate, checks, and push result.
Starting checks invalidates earlier checks and push results; starting a push
invalidates an earlier push result. Failure routes retain those invalidations.
Replay binds successful checks and push stubs to the current candidate SHA.

The exported `actionRegistry` defines these trusted names:

| Action | Execution or required result |
| --- | --- |
| `control.close` | Confirm observed closure and finish |
| `control.wait_signal` | Wait for a signal or periodic reconciliation |
| `control.wait_refresh` | Wait with bounded read backoff |
| `control.wait_debounce` | Wait for both age and head deadlines |
| `control.wait_reviewer` | Wait until next poll or the fixed reviewer deadline |
| `agent.resolve_conflict`, `agent.address_review` | Agent, produces a candidate on success |
| `agent.classify`, `agent.review` | Agent, produces analysis |
| `checks.validate_candidate` | Requires a candidate, produces checks |
| `github.push_candidate` | Requires successful checks, produces a push receipt |
| `github.resolve_eligible_threads` | Requires a confirmed push |
| `human.publish_packet` | Proposes a human handoff |

Capabilities must exactly match each built-in action's requirements and stay
within both the workflow request and caller ceiling. These definitions grant no
permission to execute during replay. There is no plugin or executable-code field.
Control failures and failed notifications must route to `$blocked`.

Cycles between named actions must contain an agent action. Each such action
consumes the finite per-wake and per-head attempt budgets before its supplied
result is accepted. Repair actions also consume the lifecycle repair count.
Replay has a separate host ceiling of 256 steps, which fixtures may only lower.
It preserves counters across observations and head changes. It does not model
provider costs, elapsed subprocess time, a database, or remote receipts; those
execution controls belong to the later live runtime.

## Evaluation and fixtures

`evaluate(workflow, observation, control, now)` is pure and returns an action ID,
a selected rule ID or null for the fallback, and condition explanations for
all rules examined through the first true rule. `evaluateCondition` implements
three-valued equality, inequality, `all`, `any`, and `not`. Missing or null facts
are unknown. Strings do not coerce into booleans. `not unknown` remains unknown.
Conditions are limited to 256 total nodes and depth 16.

`controlDecision(workflow, uses, observation, control, now)` returns a pure
wait/closure decision for control actions, or undefined for other actions.
Replay and the private daemon share it. Its next wake and optional refresh count
are data for the caller to persist; it neither owns timers nor changes inputs.

`parseFixture(value)` validates the versioned fixture contract; `replay(package,
fixture)` returns a serializable `ReplayResult`. Its inputs never launch
processes, providers, checks, GitHub requests, or notifications. See the five
fictional examples in `fixtures/replay`.

A fixture has `schemaVersion: 1`, a UTC `now` timestamp, and one or more
`observations`. Each observation has `facts` and may include head/base SHA,
`evidenceDigest`, `createdAt`, `headChangedAt`, and `externalReviewStartedAt`.
The explicit clock derives age and debounce facts when timestamps are present.
Reviewer expiry clears the active hint using its original start time. Replay
requires that time when a reviewer wait is selected, so polling cannot silently
restart the deadline.

Optional `control` provides projected memory, attempt/repair counters, read
backoff count, repair suppression, and current analysis outcomes. These are
simulation inputs, not the daemon's persisted state format. `reviewCurrent`
means a review exists for current inputs; it says nothing about acceptability.
A ready handoff additionally requires `review.coverage: complete`,
`review.verdict: acceptable`, and `classification.uncertain: false`, with known
eligible PR facts. Missing, incomplete, inconclusive, failed, or uncertain
analysis cannot produce a ready handoff. Concerns route to the team. A missing
suppression evidence digest cannot authorize another repair.

Optional `results` maps action IDs to ordered stub arrays. Each stub has
`status: success | failure | unknown`, an optional `payload`, and an optional
`reason`. Successful agent payloads must satisfy the action's pinned output
contract and the engine-owned `builtin-results.schema.json` contract for that
built-in action. Repository contracts may add constraints but cannot remove
required result fields. Selecting a JSON Pointer validates only that definition,
with its document available for internal references; unrelated root constraints
do not apply. Repair `blocked` and `no_change` payloads follow the failure route,
record suppression, and never reach a push. Unknown outcomes stop for
reconciliation. Starting a new review or classification invalidates its old
readiness projection before accepting any result, including failure or unknown
outcomes. Repair attempts invalidate both analysis projections. These
invalidations survive `$observe` until successful replacement analysis.
Head/base changes invalidate projected current analysis while
preserving budgets. A supplied payload for an older head or base blocks work.

A successful action follows `onSuccess`; a failure follows `onFailure`.
`$observe` consumes the next fixture observation and clears chain prerequisites.
Without one it returns `needs_observation`. A missing stub returns `needs_result`
with the exact fixture entry to add. `$wait`, `$closed`, and `$blocked` end the
simulation. Only the close action can confirm a closed lifecycle.

The result contains `packageDigest`, the explicit clock, decisions, actions,
proposed effects, updated control projections, `reason`, and `nextWakeAt`.
Statuses are `waiting`, `closed`, `blocked`, `needs_observation`, and
`needs_result`. Handoff effects show the outcome and configured route name.
Actual Slack member resolution, rendering, delivery, and receipts remain the
Slack module's responsibility. No simulation result is an execution receipt.
