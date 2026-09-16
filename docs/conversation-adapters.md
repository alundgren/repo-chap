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

## Tested protocols

Codex uses `codex-cli 0.154.0` app-server over stdio. Startup probes its command
help and bundled model catalog, initializes experimental API support, checks
local account state without requesting a token refresh, and reads effective
configuration before starting a thread. Each turn selects the requested model
and effort. A changed model in the thread response stops the turn before sending
the question. Dynamic tools use the version's function registration and
`item/tool/call` request/result protocol. Completed threads resume by ID.
The pinned `default_mode_request_user_input` capability enables questions during
ordinary conversation; without it this CLI rejects the question tool internally.

The host disables shell, browser, image, application, plugin, hook, skill search,
memory, delegation and other unrelated execution tools. It disables each
configured MCP server before creating the conversation thread, including names
containing dots. An unreadable transport configuration fails visibly before the
question is sent. Native Codex login remains
in its normal provider directory. No credentials are copied into the workflow.

Claude uses `2.1.236 (Claude Code)` with bidirectional `stream-json`, partial
messages, explicit session IDs and `--resume`. The host supplies a short system
prompt, empty setting sources, disabled hooks and automatic memory, disabled
slash commands and browser integration, and an explicit built-in tool list
containing only `AskUserQuestion`. Its strict MCP configuration points to the
application's temporary loopback HTTP server. Each server has an unpredictable
per-turn bearer token and closes when the turn ends.

Claude safe mode disables even an explicitly supplied MCP configuration in this
version, so the conversational invocation uses the individual controls above.
It does not use bare mode, which excludes the supported OAuth/keychain login.
The initialization response identifies missing authentication before the host
sends the question. Model availability remains a provider result; the host does
not select a replacement model.

Both versions are intentionally pinned. An untested CLI version fails visibly
before a model call. Updating a pin requires actual installed-CLI protocol checks
in addition to fake executable tests.

## Tools and input

`ConversationTool` has a name, description, JSON input schema and host callback.
The callback receives arguments, a call ID and an abort signal. Its result is
bounded text plus an optional error flag. The host decides which operations are
available and validates operation arguments against the document/test contract.
Registering a tool does not grant access to a filesystem, daemon or external
service. Ordinary authoring conversation registers no mutation, test-run, live
trial, publication or activation operation.

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

## Verification limits

Fake executable tests exercise host behavior without credentials or model calls.
Separate local protocol checks have run both installed CLIs against isolated
loopback model services and the actual application adapters. These checks prove
tool registration, request/result transport, streaming and local session behavior.
The provider messages and usage figures in those checks are fictional. They do
not establish model quality, real account entitlement, a real charge or native
macOS operation. Those checks belong to the personal pilot.

Protocol references are the [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server),
the [Claude programmatic guide](https://code.claude.com/docs/en/headless), and
the [Claude MCP guide](https://code.claude.com/docs/en/mcp). The pinned installed
binaries and local protocol receipts determine the behavior supported here.
