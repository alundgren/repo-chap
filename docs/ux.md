# UX notes for Repo Chap

The offline investigation presentation explains PR automation and includes an
editor concept. The Electron app now opens and edits local workflow source and
referenced files. Its current task is source authoring on macOS/Linux laptops.

The presentation uses warm paper, IBM Plex Sans for reading, and IBM Plex Mono
for source and identifiers. Font assets and their licence are local. Body text
is 16px, supporting text 13.5px, and headings scale with viewport size. Regular
and semibold are the only reading weights.

| Existing presentation role | Value |
| --- | --- |
| Background | #F2EADE |
| Surface | #EADFCD |
| Raised selection | #E0D2BD |
| Text | #604939 |
| Accent | #784F26 |
| Links and focus | #3D5D71 |

Components are slide navigation, reading view, action inspector, JSON editor,
staged-change status, scenario controls, decision trace, reset, and export.
The narrow layout places the inspector below the process. Architecture drawings
scroll within their region. This is intentional so diagram labels stay readable.
Semantic tokens in presentation.template.html bind the current roles.

The presentation browser check verifies navigation, editing, invalid input,
reset, export, offline operation, and laptop/narrow layouts. Generated evidence
stays outside Git.

## Desktop source editor

The desktop uses the presentation's warm-paper roles and locally bundled IBM
Plex Sans and Mono, with 16px reading and source text, 13.5px supporting text,
17px section labels and a 28px to 36px workflow title. Regular and semibold are
the only weights. Fields use #F9F6F0, borders #C1AF9A, successful validation
#3D6034 and destructive actions #8F3A2D. Keyboard focus uses the link color.

The app header opens a repository or workflow. A file list names the workflow
and every explicit reference, including output contracts; workflow-relative paths distinguish
files with the same basename. The source pane edits the selected file. Switching
files retains drafts. A single Save all action validates and writes the captured
drafts together. Validation errors name the affected file and JSON path, with
keyboard-accessible links back to the source. Validation uses the shared runtime
package, so the desktop does not maintain its own acceptance rules.

The source editor keeps the approved presentation's toolbar, light source field,
status placement, spacing and typography. It adds a file list because real
authoring includes Markdown and output contracts. The source text is 16px rather
than the presentation's 13.5px because it is the primary working content.

The file list scrolls within its own region and keeps the workflow first. At
widths below 600px it moves above the source. Paths wrap, controls wrap, and only source lines scroll
horizontally. The page does not require horizontal scrolling. A skip link and
visible focus support keyboard use; Tab leaves the source field normally.

Unsaved counts, per-file draft markers, external-change notices and read-only
unsupported-format notices stay visible. Reload replaces the selected buffer
with disk text after confirmation. Discard restores its last loaded or saved
text. Close and open protection offers save, discard and cancel, with Cancel
focused initially. Escape cancels confirmations and returns focus to the prior
control. A cancelled file picker keeps existing drafts. Save failures retain
drafts and report partial saves when necessary. No force-overwrite control is
provided; an external edit must be explicitly reloaded before saving.
Source input is temporarily read-only while reload, discard, open or close is
pending. Reload and discard show progress until the replacement finishes, then
editing resumes. Schema errors select their referenced source file, including
references with JSON Pointer fragments.

The app displays plain source for JSON and Markdown. It does not render Markdown
HTML or follow links. Discuss adds a provider conversation; explicit live analysis has its own Live trial view.

## Desktop process editing and simulation

Process, Source and Simulate are separate task views over the same captured
document. Source remains the initial view when opening a file. Process uses an
ordered list with keyboard-accessible up/down controls because array priority
determines execution. The presentation's action inspector sits beside it on a
laptop and below it on narrow windows. This replaces the concept's action grid
with actual rules and their conditions. A bounded list keeps the inspector in
reach, and reorder restores focus to the moved rule's control.

The inspector edits success/failure continuations, existing prompt references,
context paths and the timing settings used by reviewer/debounce waits. Native
select controls keep long action IDs usable with the keyboard without a custom
combobox. Visual edits preserve IDs and unknown values while formatting workflow
JSON with two spaces. Shared validation reports invalid references and action
paths. Source remains available to repair them; Reset workflow restores every
source draft to its last loaded or saved text after confirmation.

Typed inspector values become visible unsaved settings immediately. They stay
editable while incomplete. Apply settings captures them into workflow source;
Discard settings abandons only unapplied values. Save all, export, simulation,
and changing views or inspected actions capture accepted values first. An empty
numeric field stays visible with an error until corrected or discarded. Save
preserves field focus and the text selection so typing can continue after the
keyboard shortcut. Open, close and reset confirmations include unapplied
settings; Cancel retains them.

Changes against saved source compare execution fields, ordered rule IDs and
referenced text. Layout and JSON formatting are excluded. Export JSON explicitly
writes a workflow-only copy and names that referenced files were not copied.
It cannot overwrite an open source file. Save all remains the way to update
source files. Invalid source disables both simulation and export.

Simulate loads an explicitly chosen local fixture and optional complete decision
packet JSON. Fake time can change temporarily and Reset fixture restores the
loaded input. The input JSON, including ordered action stubs, is inspectable.
These inputs are not saved by Save all and are not added to the repository.
The separate Test fixtures controls now create and open repository fixture documents for source editing and explicit saving. Temporary captured inputs keep their existing behavior.

The result leads with its stop reason and wake time, then shows selected and
rejected earlier rules, unknown conditions, proposed effects and consumed fixture
counters. A tested document revision and package digest identify the result.
Changed execution content or fixture/packet bytes mark it stale. Saving or
formatting the same execution content leaves it current; layout does not affect
execution. A stale result stays visible beside its warning for comparison.

Slack content follows the shared renderer's resolved route and bounded sections.
The current captured workflow supplies Slack configuration; an explicit packet
supplies author, findings and repository context. Missing or ambiguous packet
context shows an error beside the trace. Missing member mappings show the shared
default-channel fallback. Long content keeps omission notices and an expandable
complete packet. Evidence URLs display as selectable text because the offline
window does not navigate to remote sites. Preview wording states that nothing
was sent. Warm-paper roles and local Plex fonts match the source editor.

## Desktop workflow conversation

Discuss is a fourth task view beside Process, Source and Simulate. It contains
provider setup, context choices, attributed conversation history and a question
field. Provider settings come from an explicitly chosen private JSON file.
The person selects a named profile whose provider, model and optional effort
remain visible. Loading settings or choosing a profile makes no model call.
Codex rejects ambient global AGENTS and configured base instructions before
dispatch and explains recovery
through a separate instruction-free provider home with native login. The app
does not alter global files or copy credentials. A native operation or failed
transcript verification keeps useful answer text, displays the failure and
requires Fresh session; a displayed provider ID alone never grants reuse.
Send starts the selected CLI; no substitute model or implicit test runs.

Cancel turn, Fresh session and provider input stay above the task views. They
remain keyboard-accessible when an unfinished inspector field prevents changing
views or a file operation is pending. They do not flush or discard document
input. Send uses the editor's normal pending-input capture and queue. Rejected
raw fields stay visible, accepted fields enter the draft, and a blocked capture
keeps the question. Ctrl/Cmd+Enter sends; plain Enter inserts a new line.

Context choices expose the selected rule, loaded Markdown references and latest
completed simulation. The current document revision and the simulation's tested
revision are separate. Current/stale labels describe execution identity; sending
a question does not rerun the test. Invalid source can be discussed for repair.
Oversized context produces a visible correction before provider dispatch and
keeps the question. Workflow and test evidence are never silently shortened.

Answers render as plain text with provider/model attribution and expandable
context/session details. The history has its own scroll region and follows new
text only when the person is already near its end. Coalesced updates retain
input focus and expanded details. Visible answer/history limits name shortened
or omitted text. Provider questions use native radio buttons, checkboxes and
text fields, with an explicit Send reply action and inline errors.

Cancellation and failures retain partial answers and expose fresh-session
recovery. Fresh session leaves earlier messages visible but excludes them from
future provider context. Provider changes start a separate native session and
show which earlier turns were attached or omitted as a conversational excerpt.
Source and actual test evidence determine facts; the excerpt is earlier dialogue.
Visible history lasts only while this workflow stays open. It is not restored
after close or restart, even if the provider retains its own private transcript.

Leaving a workspace first protects source drafts, then asks to stop an active
turn. Cancel retains both drafts and the running conversation. An accepted
transition waits for owned process cleanup before replacing the document.
These controls keep the existing warm-paper palette and local Plex fonts.
Discussion is at most 1000px wide; profile controls and the composer stack on
narrow windows, paths and answers wrap, and the page needs no horizontal scroll.

## Desktop authoring operations

Discuss now permits typed source, Markdown and fixture edits and actual offline
fixture tests. Save all remains explicit. A compact status above the task views
names files changed by authoring operations, including after cancellation or
provider failure. It separately reports current unsaved drafts and whether Undo
is available. The expandable Authoring operations list retains host receipts
and distinguishes unconfirmed display from a rejected or applied mutation.
Assistant prose remains plain text and cannot run an operation.

Undo draft operation sits beside Save all and restores one accepted operation,
including multi-file changes. The receipt disclosure explains its session limits
and reset on Save, Reload, Discard or Reset. Broken JSON stays in Source with
shared diagnostics and a working Undo action. Source file buttons distinguish
Test fixture from Referenced file while keeping the same unsaved markers.

Simulate keeps temporary captured inputs and adds a separate Test fixtures task.
Create opens the new unsaved JSON in Source. Open test fixture chooses an explicit
repository file. Run offline test shows actual pass/fail before the existing
rule trace, followed by a four-column expected/actual table. On narrow windows
its cells wrap so none of the compared values is hidden. The existing local
palette, type, keyboard focus and source editing controls apply unchanged.

Each tool operation captures ongoing human input. An incomplete inspector field
stays focused and visible if capture rejects; accepted earlier fields are kept.
The conversation controls remain reachable while capture is blocked. A test or
edit completion never changes the task view or steals the person's selection.

## Desktop live trials

Live trial is a separate task view beside Process, Source, Simulate and Discuss.
The form shows the current unsaved draft revision, repository/PR, named provider
and model, local Git source, and required live calls before Start. Prepare proposal
shows an unstarted proposal without contacting GitHub or a provider. Only Start
begins classification and review. The call summary says that the selected provider
may charge usage. Source saving and daemon activation are separate operations.
Both assistants can populate an unstarted proposal after capturing pending human
input. The form labels it as prepared only and shows the chosen profile, source
and draft revision. Preparation failures preserve input and explain the rejection;
the assistant cannot press Start. Profiles loaded in Discuss are available when
the prepared proposal appears in Live trial.
Reloading settings in either view updates both selectors. A same-named provider,
model or effort change is visible before another Start. Changed or removed
settings clear the prepared proposal; an outdated Start rejects before calls and
asks the person to review the refreshed selection. Retained findings keep their
original provider identity.

If Codex's native settings include unsupported ambient instructions, the retained
blocked result explains the instruction-free `CODEX_HOME` and normal login needed
before another run. It says that analysis inputs were not sent. The draft and
selection stay available; fixing the local setup requires another explicit Start.

The result leads with completion status and the analysis decision. Actual findings
and missing evidence precede detailed identities. Tested head, target base and
comparison base have separate labels. Actual token counts and estimates have
separate wording. A result matches remote evidence only at its visible last-check
time. Refresh reads GitHub again without calling a model, marks changed evidence
stale, and marks an unavailable check unknown. There is no background refresh.
This keeps remote activity explicit while preserving useful retained findings.

Cancel trial stays above task views and works while document input or a picker is
pending. Editing selected inputs or pending source/inspector text stops active
work. A rejected inspector field stays visible. Opening or closing first protects
source drafts, then offers to stop active trial work. Private records survive that
transition, conversation cleanup and restart. Unfinished records never resume
implicitly. History names each retained trial and keeps at most ten across
workspaces.

Save as offline fixture requires an explicit private directory outside Git and
writes a separate provenance file. Discuss can include the latest finished trial
with its actual analysis and tested/last-checked identity. Oversized conversation
context rejects before dispatch; it does not silently shorten trial findings.

The view reuses the approved presentation's warm-paper roles, local Plex fonts,
form controls and focus treatment. Repository and PR fields share a row on a
laptop and stack on narrow windows. Findings wrap, identifiers wrap, and retained
JSON scrolls inside a bounded disclosure. Native selects preserve keyboard
operation for long profile and history labels.

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

## Desktop provider setup

Discuss starts with a provider and model picker and a Save and use action.
Codex choices come from its installed local catalog; Claude offers CLI model
aliases. Loading choices makes no model request. A missing CLI explains the
terminal installation/login step and offers Retry loading models.

Saving writes private application settings outside Git and immediately selects
the profile for discussion. Settings return after restart. Existing profiles
remain selectable, and Import settings file supports advanced configuration.
A failed save preserves the prior settings and conversation. No workflow source
or credentials are written by provider setup.
