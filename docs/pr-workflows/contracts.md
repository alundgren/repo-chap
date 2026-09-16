# Proposed file and action contracts

These contracts make the proposal concrete enough to discuss and validate. The
repository does not yet implement their evaluator, action registry, or CLI.
Schema version 1 here is an exploratory version and carries no deployed
compatibility promise.

## Process package

[workflow.json](examples/team-pr/workflow.json) uses the
[process schema](schemas/workflow.schema.json). Rules are evaluated in array
order, first match wins. `otherwise` is explicit. Rule IDs and action IDs are
stable names; labels and graph positions do not determine identity.

The trusted built-in action registry defines each `uses` name, required inputs,
result type, maximum permissions, cancellation behavior, retry category, and
whether completion yields or returns to observation. A process file cannot
register executable code or load arbitrary remote packages. `execution` is
checked against the registry, so relabeling an agent as code changes no rights.

`onSuccess` and `onFailure` name another action or a reserved continuation:

| Continuation | Meaning |
| --- | --- |
| `$observe` | Refresh affected facts, invalidate stale derived results, then run the ordered rules. |
| `$wait` | Persist the wait or human request with its wake reason and release the PR lease. |
| `$closed` | Stop work for this lifecycle generation after observation confirmed closure. |
| `$blocked` | Persist a visible operational block. Do not recursively notify when notification itself failed. |

An action chain receives the original pinned observation plus immutable result
references from completed predecessors in that attempt chain. The registry
names which references each action requires. `validate_candidate` requires a
candidate result from `resolve_conflict` or `address`; it produces independent
test receipts. `push_candidate` requires that candidate and current successful
required checks. `resolve_threads` requires a confirmed push receipt and the
candidate's requested thread dispositions. It is a no-op when no threads are
eligible. The engine never passes arbitrary previous output as trusted input.

Repair payloads have three alternatives. `outcome: candidate` includes a commit
and continues through validation. `blocked` and `no_change` include a reason
without a candidate SHA. The host maps those to a blocked handoff, records the
concern/evidence suppression key, and never follows the success edge to push.
See [blocked-repair.json](examples/results/blocked-repair.json). A declined-only
review response uses the same route. `memory.repairSuppressed` is computed by
the host from current evidence and that record; it is not agent-writable.

The control actions have defined scheduling behavior. `wait_refresh` uses
bounded read backoff, `wait_debounce` schedules the later of the age/debounce
deadlines, and `wait_reviewer` schedules the earlier of the next poll and reviewer
deadline. An earlier external signal wakes any of them. A deadline expiry
clears the hint; it does not indefinitely restart the same wait. `park` keeps
periodic reconciliation eligible even without a webhook. `handoff` derives a
packet outcome from the selected rule, current artifacts, and operational
failure. A failed prerequisite makes `blocked_execution`, never ready.

The sample conditions cover equality, inequality, `all`, `any`, and `not` over
an allow-list of typed fields. A future evaluator must use three-valued logic:
`not unknown` is unknown, and only a true condition matches. The collector
projects missing required observations as `evidenceComplete: false` so the
refresh rule runs before repair. Types cannot coerce strings into booleans.
Cap expression depth, total nodes, and string sizes. Do not evaluate JavaScript,
shell expressions, Markdown, or JSONPath filters supplied by the package.

The example's `maxDailyCostUnits` is an abstract local budget unit, not a price
quote. The installation config maps known provider usage to units and reserves
a conservative maximum. Unknown provider usage must still consume attempt and
runtime ceilings. No schema field can raise the installation maximum.

## Payloads and engine-owned metadata

[results.schema.json](schemas/results.schema.json) defines these payloads:

| Definition | Fictional example | Checks beyond JSON Schema |
| --- | --- | --- |
| `review` | [review.json](examples/results/review.json) | Head/base match, finding locations exist in pinned source, missing coverage is honest, required checks are independent evidence. |
| `classification` | [classification.json](examples/results/classification.json) | Labels are in this process's allowed set; at most one entry per label name; referenced evidence exists. |
| `candidate` | [candidate.json](examples/results/candidate.json) | Candidate belongs to this attempt; valid Git object and permitted paths; expected parent and base; no Git hooks or unintended generated files; thread IDs belong to this PR. |
| `decisionPacket` | [decision-packet.json](examples/results/decision-packet.json) | Host-produced current outcome; test and push receipts really exist; route comes from operator config; links and content are safely rendered. |
| `controlState` | [state.json](examples/results/state.json) | Host-produced revision matches committed DB state; no agent writes; digests resolve to pinned immutable bytes. |

The packet schema accepts a display repository name; authorization must use
stable scoped repository IDs from the host envelope. All examples are fictional.
Artifact references in these files are illustrative identifiers,
not resolvable records. The review/classification examples describe an initial
head; the packet and state describe a later repaired head whose independent
review is referenced by the packet. They are separate checkpoints, not one
simultaneous observation.

Each action result is wrapped by the host with `attemptId`, `actionId`, PR IDs,
workflow/prompt/schema digests, observation digest, head/base, policy and notes
revisions, timestamps, terminal status, provider version, usage, and evidence
references. The agent must not invent authoritative values for these fields.
Budget reservations and actual usage are separate host records.

An external-effect request adds a stable semantic effect key, expected remote
revision, capability, validated payload digest, and fencing token. Its receipt
records remote object/ref identity and `confirmed`, `rejected`, or `unknown`.
Those envelopes are described here rather than pretending the sample payload
schemas define the entire future database or provider API.

The action prompt files and explicit contextFiles are pinned package inputs.
Repository instructions and PR content are trusted. Notes remain advisory
working context, while the host owns control state and authoritative receipts.
The adapter must validate the selected CLI's supported schema subset and may
compile a provider-specific equivalent. It must never silently drop constraints.
The host always validates against the canonical schema afterward.

## Semantic validation before activation

A production validator must reject missing action references, invalid prompt
paths, duplicate IDs, unsupported registry entries, capability mismatches,
malformed types, unreachable actions, and unbounded cycles. It must prove that
every path either waits, closes, blocks, or consumes a finite attempt/step
budget. It must compare `requestedCapabilities` against the operator's maximum.
The first release rejects any reachable `pr.merge` capability.

An effect-replay acceptance case should activate a prompt-only v2 while the PR
head, packet decision, evidence, and destination remain unchanged. V2 records
new execution provenance but finds the existing logical notification receipt,
so it sends no second message. A new head supersedes the old request and must
produce fresh evidence before another ready-for-merge packet.

The validator in this documentation packet is deliberately narrower. It checks
JSON Schema, local paths, references, example invariants, permission subsets,
human-merge policy, and self-contained artifact markers. It does not implement
the daemon, prove every future registry contract, or validate actual Git data.
The editor mockup validates only its illustrated subset and says so in the UI.

## Validation

The document checker uses Python 3 and `jsonschema` 4.19.2. An isolated install
keeps the application dependency lockfile unchanged:

```sh
python3 -m venv /tmp/repo-chap-docs-check
/tmp/repo-chap-docs-check/bin/pip install 'jsonschema==4.19.2'
python3 docs/pr-workflows/build_presentation.py
/tmp/repo-chap-docs-check/bin/python docs/pr-workflows/validate.py
corepack pnpm exec node docs/pr-workflows/check-presentation.mjs
```

The browser check tests visible navigation, rule/action selection, setting
changes, invalid-source recovery, simulation, JSON export, and responsive
layout in an offline iframe with no network access.
It checks Chromium and WebKit when their repository-pinned browsers are
installed. No screenshots or browser reports are committed.

## Repository context and Slack routing

Each agent action may list `contextFiles`, explicit relative Markdown paths
resolved with its prompt from the same repository commit. The sample includes
review.md as a repository convention. Markdown hyperlinks are text; the loader
does not recursively include linked files. The implementation validator must
check existence, repository containment, size limits, and snapshot consistency.

The sample `slack` object configures one workspace, stable member mappings,
named channels, a default destination, and routes by packet outcome. Tokens
belong to local installation settings. The production validator must check
normalized-login duplicates, channel references, outcome coverage, and readable
fallback behavior. Block Kit rendering is code owned, based on decisionPacket;
workflow JSON controls routes rather than arbitrary executable templates.
