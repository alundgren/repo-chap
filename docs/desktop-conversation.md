# Discuss a workflow

Open a workflow and choose **Discuss**. Choose Codex or Claude Code, select a
model, and press **Save and use**. Codex models come from the installed CLI's
local catalog. Claude offers Sonnet, Opus and Haiku. If the CLI is missing,
install it and log in from your terminal, then use **Retry loading models**.
Setup makes no model request. Sending a question starts the selected CLI.

The app saves provider settings privately outside Git in its application data
directory and loads them on restart. Saved choices appear under **Saved profiles**; select one and press **Use profile**. Saving provider settings does not
save workflow drafts or credentials. CLI login stays with the provider.

**Import settings file** also accepts the version-1 format from
[Codex analysis](codex-analysis.md) or [Claude analysis](claude-analysis.md).
Imported files must be owned by you, private with mode 0600, outside Git, and
contain 1–32 named profiles. Import does not modify the original file or switch
the current conversation. **Save and use** retains loaded profiles alongside
the chosen desktop profile. Desktop-created profiles allow discussion, draft
editing and offline tests; live trials may require imported capability settings.

CLI versions are not pinned. The app checks required CLI capabilities and
protocol responses. Missing capabilities, unsupported settings or unavailable
login produce an error without choosing another provider.

Codex discussion uses your normal local login and permits inherited global
instructions, including custom base instructions. It runs in a private session
directory outside the repository and disables automatic project-document loading.
Skills and configured MCP servers remain disabled for discussion. Repo Chap
supplies the workflow context, its own task instructions and registered app tools.
Claude uses its normal supported login while excluding ambient customization
for each turn.

Expand **Context for the next question** to choose a rule and the loaded Markdown
references to send. The current workflow JSON is always included. The latest
completed simulation is included by default when available, with its tested
revision and current/stale status. A question about that result uses the retained
result. It does not run another simulation. Invalid source can be discussed,
but incomplete inspector input must be corrected or explicitly discarded before
the editor can capture it. Save all remains the only normal source-save action.

Send or Ctrl/Cmd+Enter submits one question. Follow-ups reuse a native session
only after the preceding turn completed and the CLI flushed its session state.
Codex also checks the private native transcript for the current turn. An
unsupported native operation or unverifiable transcript keeps the answer but
requires **Fresh session**. Read-only permissions deny native file edits;
native tools have no editing authority. App-owned typed tools stage visible drafts.
Each answer names its provider and model; **Context and session** shows the
captured provenance, digest and native session ID. A displayed session ID during
streaming does not yet promise that the session can resume.

**Cancel turn**, **Fresh session** and provider replies remain available in every
task view, including while a file picker or rejected inspector value blocks other
actions. A fresh session retains visible messages but excludes them from future
questions. Choosing a different profile starts a separate session with a bounded,
attributed excerpt of earlier dialogue. The handoff notice records included,
omitted or shortened turns. No provider ID moves between Codex and Claude.

Conversation text is held in bounded application memory, outside source files.
Closing or switching the workflow clears it after stopping the owned process.
The desktop does not restore conversation history after restart. Native CLI
transcripts may remain in the provider's private home; they are separate from the
visible history and are not rediscovered or resumed automatically.

## Context and IPC contract

`window.repoChapConversation` exposes `current`, `loadProfiles`, `selectProfile`,
`send`, `cancel`, `fresh`, `answer` and coalesced `onChange` snapshots. The preload
passes no filesystem handles or provider protocol messages to the renderer.
Main owns the controller, CLI processes and temporary private working directory.
Settings selection and Send share the existing document-operation queue. Cancel,
fresh and input replies bypass that queue so they remain reachable during a
pending picker. Their conversation/turn/request identities still reject stale
actions.

Send uses the normal renderer `perform` capture, including the reviewed
`processView.flush()` behavior, before main checks the current `DocumentToken`.
`captureConversationContext` then serializes an immutable version-1 record:

- Current token, valid package digest or null, read-only reason and diagnostics.
- Exact workflow file text and its dirty, external-change and read-error state.
- The chosen rule, or null for the whole workflow.
- Only selected loaded Markdown files, with their exact text and file state.
- Excluded/no simulation status, or the complete actual retained simulation with
  current/stale status, tested token, package/fixture/packet digests, shared replay
  result, local Slack previews and any preview error.

The current token and the simulation's tested token can differ while execution
content remains equivalent. Formatting/layout edits and Save all can keep a
result current; changed execution content or fixture/packet bytes make it stale.
Proposed effects and local previews do not prove remote execution or delivery.

A selected unreadable file or unavailable rule rejects the question. Unselected
Markdown, output-contract files and unrelated repository files are not added.
The serialized snapshot must fit within 256 KiB; the host never truncates workflow
or test evidence to fit. The current snapshot plus any provider-switch excerpt
must also fit that bound before dispatch. Questions fit within 16 KiB. The host
records the context token, SHA-256 digest and provenance summary with each turn.

Visible history keeps at most 40 entries and 256 KiB of serialized records, with
64 KiB per displayed answer. Omission and truncation flags are visible. Native
provider transcripts have independent retention behavior and are not governed
by those application display limits. See [adapter contracts](conversation-adapters.md)
for protocol, tool, input, session and process bounds.

This capture grants no later document mutation authority. The authoring tools
check the current document revision again, capture ongoing human input, use shared
document/test operations, and return actual receipts. See [authoring and tests](desktop-authoring.md). Assistant text and conversational excerpts
cannot establish a saved revision, passing test, live trial or daemon activation.

## Verification

The desktop Electron checks exercise both real application adapters against
fictional local executables. They cover streaming, follow-up context, provider
changes, input, errors, cancellation, event bursts, bounds, pending document
operations and draft preservation. Development and rebuilt Linux package runs
use the same tests. Native picker responses are supplied by the tests; Playwright
uses `--no-sandbox --inspect=0 --remote-debugging-port=0` under Xvfb.

Separate retained checks run the actual installed CLIs through these adapters
against isolated loopback model services, including a real CLI tool round trip
and immediate native session resume. Synthetic provider usage is not a bill.
Those checks do not establish real account entitlement, model quality, normal
host sandbox operation or native macOS behavior. These remain pilot checks.
