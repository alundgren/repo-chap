# Slack handoffs

`@repo-chap/slack` renders a code-owned decision packet and resolves its route
without network access or credentials. Its root export has no Node runtime
imports. Electron can use `previewPacket`, `previewRoute` and `previewHtml` for
local simulation. The separate `@repo-chap/slack/web-api` export belongs to the
daemon. A preview is not evidence that Slack accepted or displayed a message.

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
profile must permit `notify.send`. The daemon verifies the token's workspace
before sending. Public and private channels require the appropriate bot access;
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
existing effect outbox. Request identity includes the run, evidence, destination
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
a repair.

```sh
repo-chap daemon inbox --state-dir /private/repo-chap/state
repo-chap daemon inbox <run-id> --state-dir /private/repo-chap/state --json
repo-chap daemon slack-reconcile <delivery-id> --state-dir /private/repo-chap/state \
  --delivered --workspace TFOREST --channel CPAPERBOAT --timestamp 123456.000001
repo-chap daemon slack-reconcile <delivery-id> --state-dir /private/repo-chap/state --resend
```

Use an actual Slack receipt to confirm an unknown send. `--resend` explicitly
accepts the risk that the earlier message exists. It retains the prior attempt
and creates a separately authorized operation. Each request permits at most three
explicit resends. An obsolete unknown request can be reconciled, but its old
decision is never sent again. A delivered obsolete request is marked superseded.

The runtime does not promise exactly-once delivery. A hard stop after acceptance
and before receipt persistence produces an unknown delivery requiring this
operator decision. Slack account delivery and real client rendering remain
human pilot checks. Automated adapter tests use fictional responses only.

The implementation follows Slack's [message API](https://docs.slack.dev/reference/methods/chat.postMessage/),
[conversation API](https://docs.slack.dev/reference/methods/conversations.open/) and
[message update API](https://docs.slack.dev/reference/methods/chat.update/).
