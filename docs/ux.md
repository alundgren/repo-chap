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
