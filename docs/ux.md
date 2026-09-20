# UX notes for Repo Chap

The desktop helps someone understand and test a workflow while their normal
agent edits the repository. Map, Available, and Test are its three focused
views. Workflow editing, provider setup, and conversation happen in the user's
agent. The original presentation remains an earlier editor concept.

## Desktop companion

The corner brand uses the transparent mascot holding a repository with a Git
branch symbol, with no visible product name. Keep it in the header, with no
welcome illustration or backdrop. The standalone app icon uses the framed
version; the README uses the cutout. Teal and coral in the artwork provide
contrast against the warm-paper UI without changing the interface palette.

Use the existing warm-paper palette and bundled IBM Plex Sans and Mono. Body
text is 16px, secondary text 13.5px, section titles 22px, and the workflow title
28px to 36px. Regular and semibold are the only weights. Primary text is #604939
on #F2EADE; selected controls use #E0D2BD, fields #F9F6F0, and focus #3D5D71.

One 54px bar holds the mascot and repository context on the left, Map,
Available, and Test navigation on the right, and the workflow picker at the far
right. Repository identity remains visible at narrow widths. The native Window
menu provides macOS window management. The workflow picker shows names and
relative paths, including multiple files with the same workflow ID. A native
select is intentional for long labels and keyboard operation. New workflows
appear as the agent saves them.

The small plus beside the workflow picker opens a read-only handoff. It gives
the person a plain text request to copy into their normal repository agent.
Electron does not create or edit the workflow and does not start an agent.
The saved file appears through normal workflow discovery and refresh. The empty
repository view offers the same handoff.

Map answers how the selected configured workflow will behave. It gives ordered
decisions most of the window and states that the first matching condition runs;
a false or unknown answer continues to the next decision. Nested all, any, and
not conditions retain their grouping. Every action and its success and failure
continuations come from the loaded workflow. Shared paths and cycles appear
once with references, so a large workflow remains readable. Short wait and
finish paths stay on one row. More involved paths use one action area containing
a title and flow diagram. Diagram steps are labels, never controls. Small
explain disclosures show exact condition fields, action IDs, prompt and context
references, and required capabilities without turning the main view into a
contract browser.

Timing, limits, and files stay in disclosures at the end of Map. Recent changed
paths provide temporary refresh feedback. There is no permanent valid-file
status. Invalid files replace the map with diagnostics and recover on the next
successful read.

Available answers what conditions and tools Repo Chap supports. It starts with
tools grouped by the job they do, followed by conditions in terms familiar to
someone who uses GitHub and Slack. Disclosures show raw contract names,
requirements, and outcomes. It always reflects the shared action and condition
registries, including GitHub review publication and labels. It does not mark
which entries the selected workflow uses and does not imply that catalogue
items can be run from Electron.

Test separates Test fixtures and Real PRs. Each retains its own selected input
and latest result. The main controls choose input and run simulation. Raw fixture
JSON and optional Slack packets live in Input details. Results lead with their
stop reason or expectation comparison, followed by the chosen path and proposed
effects. Rule reasoning and the full record remain expandable.

Real PRs always identify capture time, collection status, and observed head.
They explicitly state that current GitHub state has not been checked. Editing a
workflow does not require fetching that observation again. The capture's original
workflow version stays identifiable, and changed inputs mark prior results stale.
Invalid or missing source/input disables simulation until the agent fixes it.

An agent can navigate to named sections, rules, and actions, highlight a target,
and place a short explanation with an arrow. Guidance opens relevant disclosures,
scrolls the target into view, and expires after a bounded interval. Escape or the
close control dismisses it. Text is plain text, never rendered HTML. Only one
annotation is visible at a time; it does not become a permanent panel.

At narrow widths each action flow moves below its decision. Long paths and
conditions wrap, keyboard focus stays visible, and only bounded JSON blocks
scroll. The last repository and workflow return after restart; simulations are
rerun explicitly against files on disk. Screenshots and browser evidence remain
outside Git.

## Offline CLI

The CLI supports `validate` and `replay`. Human output names the selected rule,
explains earlier rejections, lists proposed actions, and gives the stop reason
and next wake time. `--json` returns the same decisions in a versioned format.
Validation failures name the affected file or JSON path and the correction.

A replay that waits, blocks, or needs another stub still exits successfully.
The user asked to explain a workflow, so these are simulation results rather
than command failures. JSON includes an explicit status; human output starts
with that status. Missing results identify the exact fixture key to supply.
Commands print help without requiring repository access or credentials.

## GitHub inspection CLI

`inspect` requires a repository, PR, and explicit private capture directory. It
prints collection status, pinned package/head/base, missing evidence, and saved
paths. Text and JSON distinguish complete, partial, and unavailable results;
complete describes collection and never claims readiness to merge. Partial reads
still produce a replay fixture and retain their evidence. Ctrl-C cancels reads,
saves collected evidence, and returns exit 130. Authentication and file failures
name the corrective action without exposing credential or response contents.

The default command performs reads and capture only. Provider analysis requires
an explicit later command or mode. Reviewer logins are optional; their PR eyes
reactions are waiting hints with the original reaction timestamp and the workflow
expiry, never approval evidence.

## Local analysis CLI

`analyze` explicitly starts the selected named provider profile after the user
supplies a capture, local source repository, and private output directory. Text
output leads with completion status and the analysis decision, followed by pinned
revisions, missing evidence, the corrective diagnostic, and the saved record.
JSON carries the same information plus individual attempts and usage. An
acceptable analysis does not claim merge permission. A validated but incomplete
report can exit 0, so its missing evidence and `decision: incomplete` stay visible.

Ctrl-C stops subprocesses and writes a cancellation record. Passing a previous
record with `--resume` reuses only compatible sessions and clears prior readiness
before replacement work. A failed replacement never displays an older successful
review as current. See [the provider contract](codex-analysis.md) for profile setup,
failure outcomes, and the opt-in human pilot command.

Claude Code is selected through the same named profile and analysis command as
Codex. Failure diagnostics name the provider and corrective action. Both providers
use the same decision status, missing-evidence reporting, cancellation and explicit
resume behavior. Claude token counters are actual usage; its reported monetary
cost stays visibly estimated. See [Claude setup and pilot checks](claude-analysis.md).

## Local workspace repair CLI

`workspace` requires an explicit repair action and execution policy alongside
the capture, provider profile, source repository and private output directory.
Text output starts with the outcome, then names the pinned head/base, final
candidate, required-check status and thread decisions. The final line reminds
the user that the candidate remains local. JSON returns the same result with a
logical artifact reference; it contains no worker-directory recovery dependency.

No-change exits 0 with its distinct status. Blocked repair or failed checks exit
6 and retain their reasons. Ctrl-C stops child processes, removes the disposable
checkout, saves the cancellation result and exits 130. The private attempt
receipt lets the user recover a result after restart; it never silently repeats
an unfinished attempt. See [local workspace repair](workspace-repair.md).

## Daemon CLI

`daemon start` runs in the foreground with a named private state directory.
Every control command uses that directory's local socket. `status` leads with
analysis mode, then repository state and each run's reason and wake time.
`inspect` shows pinned revisions, charges and saved analysis; JSON includes the
full retained evidence. Empty status names the registration command.

Registration requires an explicit workflow, repository and provider profile.
Invalid or conflicting registration keeps existing state. Pause and resume name
a repository; cancel and retry name a run ID copied from status. Pause lets active
analysis finish. Cancel fences the active worker. Retry retains every limit and
charge. Exit 7 indicates a failed daemon command with a corrective diagnostic.
Deferred repair/publication actions are visible stops. No CLI output calls
analysis success merge permission. See [daemon operation](daemon-analysis.md).

`register-source` names a repository-relative workflow path and optional branch.
It reports a first invalid source as a registered repository with no valid workflow,
so the operator can fix and commit the files without registering again. `versions`
shows active and observed source revisions, retained version IDs, exact validation
diagnostics, and whether automatic activation is held. `inspect` names the run's
own workflow source revision, package digest and migration checkpoints.

`rollback` selects a retained version and holds automatic activation. `resume-auto`
releases that hold; a separately paused repository stays paused. Polling continues
to validate source changes during both hold and pause. `migrate` requires a run ID
and explicit retained version ID. Its output names the checkpoint and resulting
version, states that derived analysis was invalidated when needed, and confirms
that existing waits, suppression, receipts and charges remain recorded. Help warns
that migration stops active analysis. These are text controls with JSON equivalents;
there is no new visual application flow.

## Conditional push controls

Daemon status and startup name analysis or apply mode. Apply is selected through
private installation policies for named repositories. Inspect lists the tested
candidate, required-check state, and each planned, sending, confirmed, rejected
or unknown effect with its target and expected old commit. It does not present
a planned push as success. JSON retains individual send attempts and receipts.

A failed push keeps its tested candidate. Bounded retry returns to the push
action and retains charges. Unknown outcomes stay visible and require read-only
reconciliation; another or missing remote commit names the need for inspection.
Repair and send limits explicitly ask for a human decision. No mode offers merge.

### Local apply commands

Local apply names one repository and PR, uses local gh/PAT credentials and shares
the daemon's durable repair and push handlers. `--plan` performs live reads,
provider repair and local checks, then retains and prints a tested candidate
and planned push without remote writes. Repeating the command without that
flag resumes the saved work. Every planned push prints before dispatch.

`apply inspect` works offline and shows the same candidate, limits, next wake and
effect receipts as daemon inspect. `apply reconcile` performs only remote reads
for unknown outcomes and never starts a provider or sends. `--retry` requests a
bounded retry of the retained failed action; the output keeps previous charges
and send attempts visible. Local commands stop when work waits or blocks and
explain when to rerun using the same private state directory.

## Review-thread outcomes

Apply and daemon inspection name the confirmed pushed candidate and list each
thread's disposition, state and reason. Eligible plans, skipped decisions,
confirmed remote state, rejections, unknown results and stale concerns remain
distinct. The remaining-concern count does not imply every listed concern is
still open remotely; a thread resolved during a concurrent edit still needs
inspection. JSON records `remoteResolved` and `evidenceCurrent` separately.

An ambiguous send does not offer an automatic repeat just because a later read
finds the thread open. The output explains that it may have been reopened or
the first request may still finish. Read-only reconciliation can confirm a
resolved thread after a crash. A later reopened concern stays visible beside
its historical receipt. Failed resolution retains the tested repair, so another
model call is not part of recovery. See [thread resolution](thread-resolution.md).

## GitHub publication output

Comment reviews lead with the reviewed commit, evidence coverage, and verdict.
Missing evidence precedes the findings so an incomplete report cannot read as a
clean review. Every finding keeps its explanation and immutable source links.
An unmappable citation or oversized report blocks publication and keeps the
complete local report, with a reason the operator can inspect.

Classification publication preserves existing labels, including older categories
and choices made by people. An empty classification is a visible no-op. Receipts
distinguish remote acceptance from current-head status; an accepted stale review
does not imply readiness for the new commit. These are GitHub text outputs and
structured local records. There is no new desktop view or control.

Local apply authorizes the selected action: a publication-only policy can publish
validated analysis without enabling repair or push. Inspect prints each effect's
outcome and freshness together, includes review coverage and missing evidence,
and links the published review. An unverified follow-up read preserves remote
acceptance while explaining why current readiness is not confirmed. Offline
inspect and read-only reconciliation also cover publication receipts.

The displayed publication freshness uses the current observation. JSON keeps
that value separate from the historical receipt's observed freshness. Temporary
access loss clears visible readiness and retains the publication continuation;
recovery does not require another model call for unchanged inputs. A terminal
publication failure keeps its reason visible and exits local apply with failure
even when the configured next action waits.

Seeing the exact confirmed review or requested labels in a later GitHub poll
does not mark that publication stale or charge for another analysis. The actual
capture remains available, and concurrent human changes still invalidate current
analysis. Cancellation during the final permission reads prevents the write;
cancellation after a request started preserves its uncertain outcome for
read-only reconciliation.

## Slack preview and inbox

`slack-preview` shows the destination, current PR/head, requested decision,
findings, attempted changes, tests and uncertainty. Its HTML output is a standalone
local preview with the existing warm-paper palette and system fonts. It has no
external assets. A leading notice says nothing was sent and that actual Slack
rendering needs pilot verification. The layout follows the decision-packet
presentation, with one request, readable evidence and GitHub links.

The route appears before the message. Missing author mappings show the configured
default-channel fallback in both the route and message. Shortened sections carry
an explicit omission notice and point to the complete local inbox. An expandable
text fallback presents the accessible message used by Slack. The links and
disclosure work with the keyboard, and narrow layouts wrap identifiers and links.

Daemon status identifies pending, failed and unknown delivery. `daemon inbox`
retains the complete request independently of Slack access. Configuration failures
name the correction before a send, while an unknown delivery states that Slack may
have accepted it. Storage failures appear in daemon status with the next processing
retry time. Reconciliation requires
a matching receipt or an explicit resend command. Resend help explains possible
duplicates and retained history. It does not restart analysis or repair.

Local apply accepts optional private Slack settings. Its plan mode still performs
no remote writes and retains the request for inspection. `apply inbox` and
`apply slack-reconcile` use the same complete content and explicit receipt/resend
wording as daemon controls, without requiring a running daemon. JSON distinguishes
a confirmed logical delivery from its retained unknown historical send attempt.

The replay CLI optionally takes complete fictional packets through `--packet`.
It renders only proposed handoffs with matching heads and outcomes, naming a
fixture error when context is absent or ambiguous. Text labels the result as a
local preview and says simulation sent nothing. Its route/message are identical
to the standalone preview for the same packet and configuration.

A host packet labels retained repair/check revisions and each push, publication
and thread outcome. Current freshness is separate from historical acceptance.
A candidate alone does not produce “Ready for human merge.” A direct post-push
handoff refreshes the PR before displaying its current head. Reopened and stale
resolved threads remain visible as concerns needing attention. Failed or unknown
notification attempts keep the complete packet and do not repeat provider work.

A temporary GitHub evidence outage pauses new delivery while keeping the saved
request and confirmed Slack receipt. When identical evidence returns, the same
message remains available. If an earlier decision becomes current after a proven
input change, the inbox reopens that request and Slack reuses its known message.
Interrupted cleanup remains explicitly unknown until reconciled.

## Service diagnostics and restored state

CLI diagnostics name the invoking account and show each passed or failed check
with a concrete correction. JSON retains the same check list and aggregate `ok`.
The command reports capability/login checks separately from model entitlement;
raw provider authentication output is never displayed.

Backup names its completed destination and reminds the operator that private
configuration/authentication need separate recovery. Restore names the new state
directory and immediately explains the paused startup, reconciliation and release
commands. Status distinguishes the installation recovery pause from repository
pause and source activation hold, and separates unresolved logical effects from
historical unknown attempts. `--keep-unknown` explains that unrelated work may
resume without granting a resend. No desktop control is added.
