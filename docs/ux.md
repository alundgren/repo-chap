# UX notes for Repo Chap

The current UI is an offline investigation presentation with an editor concept.
There is no production Electron UI yet. Its task is to explain PR automation
and let an engineer try a bounded edit and fictional simulation on a laptop.

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

Implementation should record its actual desktop UI choices here as components
ship. The existing browser check verifies navigation, editing, invalid input,
reset, export, offline operation, and laptop/narrow layouts. Generated browser
evidence stays outside Git.

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
