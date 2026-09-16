# Slack handoffs

`@repo-chap/slack` renders a code-owned decision packet and resolves its route
without network access or credentials. Its root export has no Node runtime
imports. Electron can use `previewPacket`, `previewRoute` and `previewHtml` for
local simulation. The separate `@repo-chap/slack/web-api` export belongs to the
host application. A preview is not evidence that Slack accepted or displayed a message.

## Workflow and installation settings

The existing workflow `slack` object names one workspace, member mappings,
channels, a default channel and all four outcome routes. GitHub login matching
ignores case. Identical mappings with different case are allowed; conflicting
member IDs are rejected. `needs_author` uses `author_dm`, resolving only through
the configured stable member ID. A missing mapping visibly falls back to the
default channel. Team, merge and blocked outcomes use named channels.

Optional `slack.mentions` maps outcomes to at most ten Slack member IDs. Only
these configured IDs create mentions. Source text and model output cannot select
destinations or create mentions. Custom executable templates are unsupported.

The daemon retains packets in its local inbox even without Slack delivery enabled.
To enable delivery, private installation JSON can include:

```json
{
  "slack": {
    "enabled": true,
    "workspaceId": "TFOREST",
    "tokenFile": "/private/repo-chap/slack-token"
  }
}
```

This is a fragment of installation settings, not workflow JSON. The token file
and its parent directory follow the daemon's private-file rules. The operator
profile, pinned workflow and private per-repository apply policy must permit
`notify.send`. Analysis mode retains the local inbox without sending. The daemon verifies the token's workspace
before sending and rechecks that binding when the token changes. Each delivery uses
the same in-memory token that passed verification. Public and private channels
require the appropriate bot access;
DMs use `conversations.open` with one mapped member ID. The app needs `chat:write`
and permission to open DMs, normally `im:write`. No inbound listener, Slack
approval, slash command, message impersonation or merge operation is provided.

## Offline preview

```sh
repo-chap slack-preview ./team-pr/workflow.json --packet ./packet.json
repo-chap slack-preview ./team-pr/workflow.json --packet ./packet.json --json
repo-chap slack-preview ./team-pr/workflow.json --packet ./packet.json --html > /private/preview.html
```

`DecisionPacket` is a version-1 data contract exported by the package. It includes
repository, PR number, exact head, author, outcome, reason, requested decision,
findings, attempted changes, test evidence, uncertainty and GitHub links. The
packet has no token, provider session, local path, workflow version or attempt
timestamp. Runtime records retain execution provenance separately.

The complete packet can contain up to 1,000,000 characters. The Slack projection
uses at most twelve section blocks, each below 3,000 characters, and a readable
text fallback below 4,000 characters. It bounds each section before escaping and
explicitly identifies shortened or omitted content. The full evidence stays in
the local inbox. The fallback carries the decision, tests and uncertainty as well
as the GitHub links, because screen readers normally use Slack's top-level text.

Source angle brackets and ampersands are escaped. Source formatting characters
are displayed as literal equivalents. Automatic link/member parsing and link
previews are disabled; generated GitHub links and configured member mentions are
explicit. The HTML preview uses the same display projection and has no external
assets or scripts. It does not reproduce the Slack client's own styling.

## Receipts and recovery

Slack requests, delivery records, conversation IDs and rate deadlines share the
private runtime SQLite database. The runtime also records each operation in the
existing effect outbox. `claimForEffect` can obtain a short run claim for an
eligible retained effect even when the workflow has no due action. It shares
run ownership and installation/repository concurrency checks, then hands ownership
to `beginEffect`. `releaseEffectClaim` releases only that scheduling claim,
preserving the parked continuation and per-wake counters. It does not schedule
or reserve a provider attempt. Slack uses
`effectCurrent`, `finishEffect` and the runtime's shared lease recovery; releasing
a provider claim is not evidence that a message send was abandoned. Request identity includes the run, evidence, destination
and content. Workflow provenance and attempt time do not create another request.
Identical evidence and content therefore reuse the existing receipt after restart
or a prompt-only migration.

Changed evidence on the same head and destination updates the existing message
when its receipt is known. A new head or destination creates a new request and
marks the earlier message superseded. An unknown prior delivery blocks further
sends for that run until reconciliation. Receipts retain workspace, channel and
timestamp. DM conversation IDs are cached by workspace and member ID.

The adapter performs one bounded API call at a time and never blindly retries a
lost response. Persisted deadlines apply across requests and restarts. Calls are
spaced conservatively and honor `Retry-After`. A known rate rejection permits at
most three automatic message attempts. Missing access or destination keeps the
complete request in the inbox. No notification failure calls a provider or repeats
a repair. A configuration or permission failure before dispatch is rejected with
no message call. If receipt persistence fails after dispatch, the attempted send
remains unknown until reconciliation. Unexpected storage failures appear in daemon
status with a bounded processing delay; that delay never authorizes another send.

```sh
repo-chap daemon inbox --state-dir /private/repo-chap/state
repo-chap daemon inbox <run-id> --state-dir /private/repo-chap/state --json
repo-chap daemon slack-reconcile <delivery-id> --state-dir /private/repo-chap/state \
  --delivered --workspace TFOREST --channel CPAPERBOAT --timestamp 123456.000001
repo-chap daemon slack-reconcile <delivery-id> --state-dir /private/repo-chap/state --resend
```

Use an actual Slack receipt to confirm an unknown send. `--resend` explicitly
accepts the risk that the earlier message exists. It retains the prior attempt
and creates a separately authorized operation. The logical delivery can be
confirmed by an operator receipt while its original send attempt remains unknown:
the receipt establishes the message to use, without rewriting what the interrupted
worker knew. Slack passes `preserveUnknownAttempts` to `reconcileEffect` for these
operator decisions; existing push/thread reconciliation keeps its current behavior. Each request permits at most three
explicit resends. An obsolete unknown request can be reconciled, but its old
decision is never sent again. A delivered obsolete request is marked superseded.

The runtime does not promise exactly-once delivery. A hard stop after acceptance
and before receipt persistence produces an unknown delivery requiring this
operator decision. Slack account delivery and real client rendering remain
human pilot checks. Automated adapter tests use fictional responses only.

The implementation follows Slack's [message API](https://docs.slack.dev/reference/methods/chat.postMessage/),
[conversation API](https://docs.slack.dev/reference/methods/conversations.open/),
[workspace verification API](https://docs.slack.dev/reference/methods/auth.test/) and
[message update API](https://docs.slack.dev/reference/methods/chat.update/).

## Local apply

Local apply accepts `--slack-config /private/repo-chap/slack.json`. This private
version-1 JSON file contains `schemaVersion` and the same `slack` object shown
above. Its token stays outside workflow JSON. The selected private apply policy
must also permit `notify.send`. The shared daemon service handles the selected
repository and PR. `--plan` saves the packet and effect without contacting Slack.

`apply inbox [run-id] --state-dir <directory>` reads complete packets without a
running daemon. `apply slack-reconcile` accepts the same receipt or explicit resend
options as its daemon counterpart and does not send a message or run a provider.
Use the same private local state directory as the original apply invocation.
`apply inspect` and `apply reconcile` retain their offline/read-only distinctions.
