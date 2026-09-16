# Author workflows and offline tests

Discuss can stage workflow JSON, loaded Markdown and fixture edits through either
configured provider. Changes appear immediately in Source and Process, with the
usual unsaved-file markers. Save all writes them explicitly. Assistant text is
plain text and never dispatches an action.

Simulate has a Test fixtures section. Create a repository fixture or open an
existing one, edit its JSON in Source, and choose Run offline test. A new fixture
contains visible starter expectations that the person or assistant must adapt.
These fixture documents are separate from the earlier temporary Load fixture
input. Save all includes authored fixtures; it never rewrites a privately captured
temporary input. Fixture paths are repository-relative JSON paths with an existing
parent directory. Creation refuses an existing path. Opening a saved test fixture
again is explicit; opening a workflow does not scan the repository for tests.

The result shows the tested document token, package and exact fixture digests,
selected rules, proposed effects, and an expected/actual table. Changed execution
content or fixture bytes make the retained result stale. Changed expectations
are ordinary visible source edits and also make the old result stale. Save or
equivalent workflow formatting does not change execution identity. Missing
expectations reject a test; a missing stub or observation cannot pass it.

## Host operation contract

`AuthoringOperation` in `apps/desktop/src/authoring-protocol.ts` contains an
`operationId`, an `expected` DocumentToken and one typed action. A token is the
document session ID plus its revision. Source paths and existing rule/action IDs
identify targets. There is no positional text patch or command interpreter.

| Action | Result |
| --- | --- |
| `read`, with selected `paths` | Exact loaded document text. An empty list returns the current file inventory and token. |
| `edit`, with `changes: [{path, text}]` | One atomic in-memory edit and one undo group, including invalid intermediate JSON. |
| `visual`, with the existing VisualEdit contract | A stable-ID rule/action/timing edit through the same operation used by the inspector. |
| `createFixture`, with `path` and `text` | An unsaved new fixture with explicit expectations. |
| `validate` | Actual shared diagnostics for the captured source and authored fixtures. |
| `test`, with `fixturePath` | Actual shared replay and comparison, retained by the document session. |

`DocumentSession.author` validates the operation and owns its receipt.
`AuthoringResponse` returns the receipt, current context and any read/validation/test
data. Receipts record status, before/after tokens, changed paths and display
confirmation. A duplicate operation ID returns its existing receipt and current
context, even after Undo, cancellation or provider failure. It does not apply
again. A stale request rejects without overwriting and returns current file
digests and the current token.

Both provider adapters receive the app-owned `author` tool. Main binds its
callback to the current DocumentSession. Before each operation, AuthoringTools
requests renderer capture. Renderer uses its normal inspector flush and source
queue, then main rechecks both captured and requested revisions. This includes
text typed after Send. A rejected partial inspector value remains visible;
accepted earlier fields retain their new comparison baselines. The response
reports pending field values separately from authoritative document content.
Cancel, Fresh session and provider replies bypass the document queue.

Mutation and display acknowledgment are separate. The host records an applied
edit before returning its snapshot to the renderer. An absent acknowledgment
after 1.5 seconds leaves display unconfirmed. It never rolls back or retries the
mutation. Capture expires after five seconds without applying the request.
Cancellation stops requests still waiting for capture. An edit already applied
remains visible and undoable, including when Codex later rejects a native tool
attempt or cannot verify its transcript. Authoring operations lists those host
receipts independently of conversational success.

The controller accepts `tools?: (document: DocumentToken) => readonly
ConversationTool[]`; its caller supplies authority. The controller still owns
no document or live-trial operations. Context capture adds loaded file IDs and
recent host receipts beside current source and actual retained simulation data.
A future proposal tool must remain separate from authoring and cannot infer a
human Start from Send or another tool call.

## Bounds and recovery

Operations fit within 32 KiB and use at most 16 read/edit targets. Tool responses
fit within 64 KiB. Read text above 40 KiB rejects; oversized detailed test output
stays in the editor and the tool receives an explicit omission notice with its
tested identity, actual status and comparison outcome. Context inventories fit
within 24 KiB and report omitted file counts. The provider's existing 32-call
turn limit still applies.

The document session retains 128 operation receipts without evicting IDs. At that
limit it rejects new authoring operations with Save and reopen recovery. Existing
IDs still return their receipts, and manual source editing and saving remain
available. Save does not remove receipt IDs. Closing the workflow ends this
in-memory receipt history.

Undo keeps up to 32 recent draft groups within 8 MiB, removing the oldest groups
when necessary. A single group above that bound rejects before editing. Save,
reload, discard and reset clear undo history so undo cannot recreate an obsolete
disk baseline or silently remove a saved fixture. They preserve operation
receipts. This is session recovery, not crash recovery or a filesystem transaction.
Save still reports partial disk writes and preserves remaining drafts.

Offline validation and replay import only shared workflow and pure Slack preview
code. They dispatch no model, network or effect adapter. An active conversation
may contact its provider, but that transport is separate from test execution.
There is no authoring operation for saving, shell execution, PR push, Slack send,
daemon activation, local apply or live trials.

Actual Electron tests exercise both adapters with fictional provider executables,
not real model accounts. Development and packaged Linux tests use Xvfb with
Playwright launch flags and supplied picker responses. Native macOS, normal
host-sandbox launch, real account entitlement and model quality remain pilot
checks.
