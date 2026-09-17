# Desktop process editing and offline simulation

The Electron main process owns workflow source, temporary simulation inputs and
results in `DocumentSession`. The renderer calls the typed preload bridge. It
does not load packages, evaluate rules, invoke providers or dispatch effects.
`buildPackage`, `parseFixture`, `replay` and `previewReplayHandoffs` supply shared
validation and execution behavior.

Open a workflow, choose Process to reorder rules or inspect action settings,
then choose Simulate and load a version-1 fixture. Fixtures can be fictional or
explicit private captures from `inspect`. Their `results` arrays supply ordered
action stubs; `now` supplies fake UTC time. The desktop never calls `apply
--plan`, which performs live reads, provider repair and local checks.

Load optional decision packet JSON to preview a proposed Slack handoff. It is
one complete version-1 packet or an array, using the same input as CLI `replay
--packet`. Each proposed head/outcome needs exactly one matching packet. The
composition is `previewReplayHandoffs(result, packets, package.workflow.slack)`.
The workflow provides explicit Slack routing and member mappings. The packet
provides author, repository, findings and evidence. Missing or ambiguous context
leaves the decision trace available with a preview error; no context is invented.

The complete replay result and previews equal CLI output for the same saved
package, fixture, fake time and packet input. Stubs describe proposed behavior,
including unknown outcomes; they do not prove remote acceptance or current merge
readiness. The HTML application displays the pure renderer's sections, omissions,
route and accessible fallback while retaining the complete packet.

## Document operations for desktop consumers

Every operation takes the existing `DocumentToken`, containing sessionId and
revision. Stale tokens reject without changing newer input. Main serializes IPC
operations. The renderer temporarily disables source and visual mutation controls
while a replacement or visual operation is pending.

| Operation | Behavior |
| --- | --- |
| `visualEdit(token, edit)` | Move a rule by ID/toIndex; change action onSuccess/onFailure/prompt; change contextFiles; or change a supported timing field. Updates the same workflow source and refreshes references. |
| `reset(token)` | Restore all workflow buffers to each file's loaded/saved baseline, keeping external disk-change indicators and temporary fixture inputs. |
| `loadSimulationInput(token, kind)` | Main opens a local JSON picker for fixture or packets, then calls `setSimulationInput(token, kind, text, name)`. No captured file is rewritten. |
| `editSimulationInput(token, kind, text)` | Stage bounded temporary input with the current token. General fixture editing UI is deferred. |
| `resetSimulationInput(token, kind)` | Restore the input captured by the picker. |
| `setClock(token, now)` | Validate the fixture with the proposed UTC time, then stage its JSON with that time. |
| `simulate(token)` | Build the current captured package, parse the fixture, run pure replay and compose optional Slack previews. |
| `exportWorkflow(token)` | Validate and write an explicit workflow JSON copy through the save picker. Referenced files are not copied. Open source files must use Save all. |

`DocumentSnapshot` adds `workflow`, `semanticChanges`, `semanticError`,
`simulationInputs`, `simulation` and `simulationCurrent`. Invalid packages have
`workflow: null`; source remains available under the existing recovery rules.
Semantic changes compare against file baselines, including removed references,
and exclude layout and JSON formatting. Visual edits retain unknown JSON values
and stable IDs but format workflow JSON with two spaces. Unknown runtime fields
continue to fail shared validation and cannot be simulated or exported.

The simulation record retains the tested token, packageDigest, fixtureDigest,
packetsDigest, unchanged shared result, handoffs and previewError. All input
changes advance the document revision, including temporary clock edits. Current
result status compares execution package identity plus exact fixture and packet
bytes, rather than treating Save all or a layout edit as a new execution input.
The tested token remains visible even when later equivalent source has a newer
document revision. Invalid workflow source always makes a prior result stale.

The renderer also owns raw inspector text while a person types. An incomplete
number cannot yet be represented in authoritative workflow JSON. These values
immediately count as unsaved settings and enable Save all. `processView` exposes
`pending()`, `flush()` and `discardDrafts()` to the renderer. `flush()` sends each
accepted field through the existing token-checked `visualEdit` and retains any
rejected input. Apply settings calls it explicitly. Discard settings discards
only raw values that have not entered the document.
Each accepted field updates its control's comparison baseline immediately,
including when a later field is rejected. Later typing compares against that
accepted value, and a completed capture removes only its own draft entry.

Renderer `perform` captures pending inspector edits before export, simulation
or other workflow actions. `save` captures them before disk writes and retains
focus and selection. View/action selection captures them before replacing the
inspector. `leave` includes them in save/discard/cancel protection, and workflow
reset clears them only after confirmation and a successful document reset.
The internal capture-disabled `perform` call belongs only to `flush`, to avoid
recursion. Future context or authoring operations must use the normal capture
path and wait for the renderer queue before reading `DocumentSnapshot`; a main
process snapshot alone cannot include an unfinished human field. No assistant
operations or general patch/undo API are introduced here.

Temporary fixture and packet inputs live only in the current document session.
Save all writes workflow JSON and its referenced files. Reset workflow affects
those source buffers; Reset fixture affects the loaded fixture. Opening another
workflow or closing the application drops temporary simulation inputs and
results. They are not durable test records or an assistant undo API.

## Validation

`corepack pnpm test:desktop` exercises both source and simulation flows in actual
Electron. Use Xvfb on a headless Linux host and set `REPO_CHAP_DESKTOP_PROOF` to a
private directory outside the checkout. `REPO_CHAP_DESKTOP_EXECUTABLE` selects an
unpacked application for the same tests. Playwright launches Electron with
`--no-sandbox --inspect=0 --remote-debugging-port=0`; this checks application
behavior and isolated renderer settings, not host sandbox enforcement.

The tests cover exact built-CLI parity, rule order, context changes, revision
checks, waits/limits, invalid source/fixture recovery, reset/save/export, missing
packet context, long findings, mapping fallback, keyboard focus and laptop/narrow
layouts. Runtime guards and the bundled import graph establish that simulation
does not reach network, provider or effect adapters. Native macOS execution,
normal native picker use and real Slack rendering/delivery remain pilot checks.
