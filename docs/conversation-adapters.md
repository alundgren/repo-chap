# Local conversation adapters

`@repo-chap/providers` exports `runConversationTurn`. The desktop host supplies an
immutable context string, a question, a private working directory, a configured
provider profile, registered local tools and an input callback. The renderer
does not own provider processes or receive provider protocol messages.

Conversation sessions are separate from analysis sessions. A successful turn
returns its provider, CLI version, settings binding, provider session ID and turn
count. The next turn can resume only that same provider, profile, directory and
tool registration. It sends a new context snapshot so previous document text
does not become the current draft. Failure and interruption return no resumable
identity. The host must offer a fresh session and retain the visible transcript
and unsaved documents.

## Protocol compatibility

Codex uses app-server over stdio. Startup probes its command
help and bundled model catalog, initializes experimental API support, checks
local account state without requesting a token refresh, and reads effective
configuration before starting a thread. Each turn selects the requested model
and effort. A changed model in the thread response stops the turn before sending
the question. Dynamic tools use function registration and
`item/tool/call` request/result protocol. Completed threads resume by ID.
The `default_mode_request_user_input` capability enables questions during
ordinary conversation; without it Codex rejects the question tool internally.

The host disables shell, browser, image, application, plugin, hook, skill search,
memory and delegation features. It lists available skills and disables their
paths for the thread, then disables each configured MCP server, including names
containing dots. Unreadable skill or transport configuration fails visibly before
the question is sent. Project AGENTS loading has a zero-byte limit, and the conversation runs in a
private directory outside the managed repository. Inherited global instructions
and custom base instructions are permitted. Instruction-source metadata is not
required. Repo Chap supplies its task instructions for each thread and retains
its explicit skill, MCP and tool controls.

The real selected model can still advertise native `apply_patch`; the adapter does not rely on an exclusion control for it. Read-only sandbox permissions and
`approvalPolicy: never` deny native writes. A denied patch is absent from normal
app-server events, so after clean exit the adapter audits the CLI's private
JSONL transcript before granting success or resume. The audit binds session,
working directory and current turn start/context/completion. Native
tool calls produce an unsupported-operation error, retaining any answer text.
Missing, truncated, incompatible or ambiguous evidence also requires a fresh
session. The audit checks transcript content, without comparing CLI versions.
Authoring uses registered application operations.

Claude uses bidirectional `stream-json`, partial
messages, explicit session IDs and `--resume`. The host supplies a short system
prompt, empty setting sources, disabled hooks and automatic memory, disabled
slash commands and browser integration, and an explicit built-in tool list
containing only `AskUserQuestion`. Its strict MCP configuration points to the
application's temporary loopback HTTP server. Each server has an unpredictable
per-turn bearer token and closes when the turn ends.

Claude safe mode disables even an explicitly supplied MCP configuration in tested releases, so the conversational invocation uses the individual controls above.
It does not use bare mode, which excludes the supported OAuth/keychain login.
The initialization response identifies missing authentication before the host
sends the question. Model availability remains a provider result; the host does
not select a replacement model.

Neither adapter requires a particular CLI version. Startup checks the required
command flags and protocol behavior. Version strings are retained for diagnostics;
a CLI update alone does not block a new turn or session resume. Missing required
capabilities or incompatible responses still produce an actionable error.

## Tools and input

`ConversationTool` has a name, description, JSON input schema and host callback.
The callback receives arguments, a call ID and an abort signal. Its result is
bounded text plus an optional error flag. The host decides which operations are
available and validates operation arguments against the document/test contract.
Registering a tool does not grant access to a filesystem, daemon or external
service. The desktop registers its typed author operation for draft edits and offline
tests. It registers no live trial, publication, save or activation operation.

Codex's user-input requests and Claude's `AskUserQuestion` requests become the
same typed questions. Claude approvals are supported only for tools already
registered by the host. Unsupported approvals, secret input and other protocol
requests stop the conversation with a visible error. Input waits share the turn
deadline and abort signal, so closing a workspace cannot leave an orphan prompt.

Tool callbacks must observe cancellation and check their captured document
revision before applying a later operation. A provider's prose or tool status is
not a document save or test receipt. Document mutation and renderer acknowledgment
remain separate host responsibilities.

## Bounds and cleanup

The host accepts questions up to 16 KiB and context snapshots up to 256 KiB.
A turn permits 32 tool calls, 32 KiB of arguments per call and 64 KiB of result
text. It accepts at most 20,000 protocol events, with a 512 KiB per-message limit,
and at most 1 MiB of answer text. The profile's combined stdout/stderr limit
applies with an 8 MiB conversation ceiling. Process parsing yields after every
64 messages. A session ends after 20 completed turns and needs a fresh start.

The profile deadline applies with a ten-minute ceiling. Cancellation sends the
provider's interruption request and terminates the complete local process group.
Tool and input waits receive an abort signal. Native session files and working
directories stay outside Git. The provider package does not persist desktop
conversation text or write managed repository files.

A successful provider answer closes stdin and allows up to two seconds for a
clean process exit before the host reports a reusable session. Claude can emit
its result before flushing the native transcript. If the process does not finish
cleanly, the answer remains visible and the host reports that a fresh session is
required. Cancellation and timeouts still terminate the owned process group.
The Codex transcript audit has a two-second deadline, a 32 MiB read ceiling,
100,000 records and the same 512 KiB per-record bound. It rejects changing files,
symlinks and non-regular files. Those audit limits do not configure native
transcript retention; exceeding them makes this session non-reusable.

## Desktop session ownership

`ConversationController` owns one document session's chat history and at most one
active turn and input request. Its caller supplies captured text, a
`DocumentToken`, and a provenance summary. The caller validates the current
document and test revisions before capture. The controller checks document
session identity, copies the supplied values, records a SHA-256 digest of the
captured text, and never reads files or invents test results. The caller supplies optional tools through a callback receiving the captured
document token. This controller has no document mutation authority.

Renderer snapshots contain the chosen provider, profile and model, attributed
turns, context revisions, tool activity, pending input and recovery state.
Provider bindings, executable paths, process directories and raw protocol
messages stay in the main process. A turn may display its native session ID
while streaming, but only the adapter's settled successful result grants resume.
Cancellation and failure keep partial text and require a fresh session.

Fresh starts retain visible history and exclude it from future provider context.
Changing provider or settings cancels the current turn, removes the old native
identity and prepares a separate session with a bounded dialogue excerpt. The
visible handoff record reports included and omitted turns and any truncation.
It distinguishes a pending excerpt, one attached to a submitted question, and
one cleared by a later fresh start or close. Attachment does not claim provider
delivery. Excerpts retain provider attribution and interrupted-turn status.
They are conversation context, not evidence of saves, tests or remote effects.
The newly captured workflow and actual test provenance remain authoritative.

Visible history is in memory, bounded to 40 entries and 256 KiB of serialized
records. Each displayed answer keeps at most 64 KiB with an explicit truncation
flag. Handoffs fit within 32 KiB and count omitted turns. The combined current
context and handoff must still fit the provider's 256 KiB context limit; a failed
size check starts no provider. Stream updates are coalesced at 50 ms. Input and
terminal state changes publish immediately. Each turn permits 16 input requests;
one pending request fits within 256 KiB, and responses fit within 64 KiB.
Answered input summaries are bounded and mark omitted text.

Closing cancels the turn and clears pending input and native resume identity.
The host can retain the closed controller's bounded transcript while showing the
transition, then discard it when leaving the workspace. Visible history does
not survive workspace disposal or app restart. Native CLI transcript files can
remain in each provider's private home; the desktop does not rediscover or
automatically resume them after restart. Neither form of history enters managed
repository files.

## Verification limits

Fake executable tests exercise host behavior without credentials or model calls.
Separate local protocol checks have run both installed CLIs against isolated
loopback model services and the actual application adapters. These checks prove
tool registration, request/result transport, streaming and local session behavior.
The provider messages and usage figures in those checks are fictional. They do
not establish model quality, real account entitlement, a real charge or native
macOS operation. Those checks belong to the personal pilot.

Protocol references are the [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server),
the [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
the [Claude programmatic guide](https://code.claude.com/docs/en/headless), and
the [Claude MCP guide](https://code.claude.com/docs/en/mcp). The pinned installed
binaries and local protocol receipts determine the behavior supported here.
