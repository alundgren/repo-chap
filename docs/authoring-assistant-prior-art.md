# Local authoring assistant prior art

The removed Codex Scope PR-review conversation is available at historical commit
`98f83752fc52395101d7bd9c26252ca5658f1a4d`, before removal commit
`fd6895c83d1b2818a3cf664863b357c390f04f9f`. It is a reference implementation,
not a dependency or a feature to restore. Repository-history research and targeted
source verification were performed on 2026-09-16.

## Verified mechanisms

- [review-session.ts](https://github.com/alundgren/codex-scope/blob/98f83752fc52395101d7bd9c26252ca5658f1a4d/electron/src/review-session.ts#L200)
  owns bounded newline-delimited requests. Its startup at lines 412–459 initializes
  Codex app-server and registers dynamic tools on an ephemeral thread. These are
  Codex protocol details, not a provider-neutral conversation API.
- [main.ts](https://github.com/alundgren/codex-scope/blob/98f83752fc52395101d7bd9c26252ca5658f1a4d/electron/src/main.ts#L277)
  validates IPC senders and owns one pending renderer action, its timeout,
  cancellation and acknowledgment. This pattern makes visible actions inspectable.
- [review-guidance.ts](https://github.com/alundgren/codex-scope/blob/98f83752fc52395101d7bd9c26252ca5658f1a4d/electron/src/review-guidance.ts#L188)
  validates typed source references and revisions before acting. Its actions
  change a view or annotate evidence, not repository files.
- [review-conversation.ts](https://github.com/alundgren/codex-scope/blob/98f83752fc52395101d7bd9c26252ca5658f1a4d/electron/src/ui/review-conversation.ts#L9)
  provides streamed state, bounded pages, follow/latest behavior, send/stop, and
  transcript retention after failure.
- [review-feedback.ts](https://github.com/alundgren/codex-scope/blob/98f83752fc52395101d7bd9c26252ca5658f1a4d/electron/src/ui/review-feedback.ts#L80)
  preserves edited text after failed generation and asks before replacing it.
- [review-session.test.ts](https://github.com/alundgren/codex-scope/blob/98f83752fc52395101d7bd9c26252ca5658f1a4d/electron/test/review-session.test.ts#L22)
  uses a fake CLI to exercise turn reuse, stale events, tools, interruption,
  malformed output, process exit and retained transcript capacity.

The [historical product contract](https://github.com/alundgren/codex-scope/blob/98f83752fc52395101d7bd9c26252ca5658f1a4d/docs/pr-review.md#L31)
explicitly excludes running reviewed code. It has no Claude integration, workflow
simulation or checked-out-file editing. Repo Chap must implement those behaviors
rather than claim the old chat already provides them. Its restrictive repository
trust/auth-copying setup is not Repo Chap's accepted trusted-team model.

## Repo Chap implementation direction

Own a revisioned document store in the Electron host and use it for manual UI
edits, agent edits and test snapshots. Both provider bridges call the same typed
operations. Raw provider requests stay outside the renderer. Source views,
visual rules, referenced Markdown and fixture buffers observe that store.

Separate document mutation from renderer presentation acknowledgment. Record an
operation ID and resulting revision when the host applies an edit. A lost UI
acknowledgment reports display as unconfirmed; retrying that operation returns
the prior result instead of applying it again. A stale base revision rejects the
mutation and returns current context. Changes remain staged with undo until save.

For Codex conversation, use local app-server stdio with a pinned/probed protocol
and a provider-specific tool bridge. Current [official app-server documentation](https://learn.chatgpt.com/docs/app-server)
describes bidirectional requests, turns, interruptions and streamed events.
Dynamic tool registration is experimental; compatibility acceptance requires a
real tool-call/result round trip with the installed CLI, not schema generation
alone. Do not import its wire types into the shared document operations.

For Claude conversation, use its supported local programmatic CLI, streamed
output and explicit session resume, with app-owned local MCP authoring tools.
The [headless documentation](https://code.claude.com/docs/en/headless) and
[local MCP documentation](https://code.claude.com/docs/en/mcp) describe those
mechanisms. Start/cancel/tool/result/error mapping is Claude-specific. Keep
supported local CLI authentication; do not silently require API-key-only access
when the configured local CLI login is supported. Probe the actual version and
verify tools for this adapter independently of Codex.

The conversational adapters and background workflow action adapters may share
process utilities, profile resolution and error types. They need not force the
same wire protocol or long-lived session model on both use cases.

## Authoring and testing behavior

Both providers can answer questions, visibly edit JSON/Markdown, prepare fixture
expectations, run deterministic offline tests and discuss actual results. Tests
pin draft and fixture revisions. Changed expectations stay visible as edits.
Agent prose is never a test receipt. Keep text and tool output bounded.

The person can explicitly start a live read-only trial on real PR evidence with
either provider. An agent can prepare that proposal but cannot start it silently.
No trial pushes, publishes a review, sends Slack, repairs repository code or
activates the daemon. Draft/head changes mark prior trial results stale.

Cancellation stops pending operations and subprocess work while keeping already
applied edits visible. Missing tools, authentication, unsupported versions and
process exit offer a fresh-session path without discarding the workflow draft.
The personal pilot must exercise the full authoring/test cycle with both providers
on the supported desktop platforms.
