# Workflow files and testing

Workflow JSON uses `schemaVersion: 1`, an `id`, a version, settings, execution
limits, requested capabilities, labels, an ordered rules array, an `otherwise`
action, and named actions. Use `repo-chap schema workflow` for exact fields and
limits. Every rule names a unique ID, a condition, and an existing action.
The first true rule wins. Missing evidence is unknown rather than false.

Conditions use `{ "field": "facts.draft", "op": "eq", "value": true }`,
or recursive `all`, `any`, and `not`. Facts include lifecycle, draft,
evidenceComplete, young, headDebouncing, conflict, unaddressedReview, and
externalReviewPending, ciFailed, and ciPending. Memory includes classificationCurrent, reviewCurrent,
packetCurrent, and repairSuppressed. The schema names other available fields.

Each action has `uses`, `execution`, `capabilities`, `onSuccess`, and `onFailure`.
Continuations name another action or `$observe`, `$wait`, `$closed`, `$blocked`.
Keep every execution cycle bounded. Shared validation checks reachability,
capabilities, result dependencies, references, and execution cycles.

| Task | Built-in action | Execution | Capabilities |
| --- | --- | --- | --- |
| Finish or wait | `control.close`, `control.wait_signal`, `control.wait_refresh`, `control.wait_debounce`, `control.wait_reviewer` | `code` | none |
| Classify or review | `agent.classify`, `agent.review` | `agent` | `workspace.read` |
| Repair | `agent.resolve_conflict`, `agent.address_review`, `agent.fix_ci` | `agent` | `workspace.read`, `workspace.write` |
| Test candidate | `checks.validate_candidate` | `code` | `checks.run` |
| Push tested candidate | `github.push_candidate` | `code` | `pr.push` |
| Resolve addressed threads | `github.resolve_eligible_threads` | `code` | `review.resolve` |
| Publish analysis | `github.publish_review`, `github.set_labels` | `code` | `review.publish` or `labels.set` respectively |
| Human handoff | `human.publish_packet` | `code` | `notify.send` |

Agent actions also need a Markdown `prompt`, an `outputSchema` reference, and
optional `contextFiles`. References resolve relative to the workflow JSON and
must stay inside its repository, including through symlinks. Existing review.md
files can be referenced. Obtain the canonical result definitions with
`repo-chap schema results` and save them as a repository file when needed.
Reference definitions such as `results.schema.json#/$defs/review`,
`#/$defs/classification`, or `#/$defs/candidate`. The configured output contract
must also satisfy the built-in result contract. Humans merge.

Keep practical limits for attempts per head, repairs per lifecycle, agent actions
per wake, attempt duration, and daily cost. Bot commits do not reset budgets.
Daemon activation reads committed workflow files from its configured branch;
editing a file or opening Electron does not activate it.

## Fixtures

Use `repo-chap schema fixture` for the contract. A fixture contains `schemaVersion`,
a fixed UTC `now`, and one or more observations. Each observation contains
`facts` and can pin head/base commits and an evidence digest. Optional `control`
supplies memory and counters. `results` supplies ordered stubs by action ID.
For agent results, each successful stub's payload must satisfy its output schema.

[The closed-PR fixture](../assets/closed.json) tests the starter. A meaningful
test supplies `expected.status`, ordered `expected.selectedRuleIds`, and
`expected.proposedEffects`. Test the requested change and a relevant failure or
waiting case. Inspect actual results, not only a pass label. `needs_result` and
`needs_observation` identify missing inputs and cannot count as a passing test.
Replay never starts providers or performs the proposed effects.

For a Slack preview, supply complete decision packets with CLI `--packet` or
desktop `--packets`. The head and outcome must match the proposed handoff.
Missing packet context is a visible preview error, not evidence of delivery.

## CI detection and repair

Use `facts.ciPending == true` to wait with `control.wait_signal`, then
`facts.ciFailed == true` to select `agent.fix_ci`. Place these after lifecycle,
evidence, debounce, suppression and conflict handling. Include CI failure in
your repair-suppression rule. The first matching rule wins.

CI repair requires a confirmed failed check on the captured head and
`ciPending == false`. It uses the canonical candidate result and the same
repair limits, required local checks and conditional push as other repairs.
Continue through `checks.validate_candidate` and `github.push_candidate`, then
observe GitHub again. Passing local checks does not establish remote CI success.

Both CI facts are unknown when checks are missing, collection is incomplete,
or the observed revision changes. Unrecognized check states remain unknown.
A pending check is not a failure. Completed unsuccessful checks, including
cancelled and timed-out checks, count as failed; neutral and skipped checks
count as successful. These facts cover all observed checks, not branch
protection requirements. Missing facts in older fixtures remain unknown and
cannot establish merge readiness. Add explicit CI facts to fixtures that test
successful handoffs.

Providers receive check results and links, without remote failure logs. Repair
from local evidence; return blocked for missing evidence, infrastructure or
credential problems. Never weaken checks merely to produce a passing result.
