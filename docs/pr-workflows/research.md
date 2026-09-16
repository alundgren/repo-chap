# Research for Repo Chap

The comparison below comes from the investigation on 2026-09-15. Product decisions
were revised on 2026-09-16 in decisions.md. No engine, provider trial, or production
experiment has been completed. Repo Chap is a standalone product for trusted
teams, with a private Linux daemon, local CLI, and local Electron editor.

Use a small deterministic interpreter and SQLite for v1. Adopt recovery patterns
from durable workflow systems without adding their service infrastructure.
Keep JSON and referenced Markdown in managed repositories, pin complete packages,
and bound every attempt. PR work is first; daily repository jobs are later.

## Six-system comparison

| System | Documented behavior | What to use or avoid |
| --- | --- | --- |
| Temporal | A workflow's append-only Event History is the durable recovery record and audit log. [Durable timers](https://docs.temporal.io/workflow-execution/timers-delays) persist while workers are unavailable and consume no worker resources while waiting. [Event History](https://docs.temporal.io/workflow-execution/event) must replay deterministically. | Use persisted timers, recorded decisions, and replay-safe code as design tests. Avoid the service cluster, worker protocol, and full replay model in v1. |
| Restate | Restate journals steps before or while they execute, uses idempotency keys to identify duplicate invocations, and fences late attempts by epoch. [Its architecture](https://docs.restate.dev/references/architecture) includes durable timers, state, and promises. [Deployments are immutable](https://docs.restate.dev/services/versioning); retries remain on the original endpoint while new requests use the latest deployment. | Use durable journals, leases with fencing tokens, and immutable definition snapshots. Restate uses the [Business Source License 1.1](https://github.com/restatedev/restate/blob/main/LICENSE), with a four-year Apache 2.0 change date per version and an additional-use grant whose terms must be checked before redistribution or offering a public service. Do not make it a default dependency without a separate license and operations decision. |
| DBOS | The [DBOS library](https://docs.dbos.dev/architecture) checkpoints workflow inputs and outputs in PostgreSQL; a workflow must be deterministic and steps are the idempotency boundary. A single application process can recover local work, while its Conductor component provides distributed recovery and management. [Application versioning](https://docs.dbos.dev/typescript/tutorials/upgrading-workflows) keeps recovery on the matching code version and recommends draining older versions. | Use explicit step boundaries, durable results, and version-pinned recovery. Its PostgreSQL requirement and distributed management service add more infrastructure than the SQLite-first target needs. The documentation describes DBOS as open source, but its precise package and hosted-service license terms were not evaluated here. |
| n8n | Workflows [import and export as JSON](https://docs.n8n.io/build/manage-workflows/export-and-import); exports may contain credential names, IDs, and imported headers. Its [workflow review](https://docs.n8n.io/build/manage-workflows/workflow-reviews) pins a saved version for review, provides a visual diff, and publishes the reviewed version after approval. That review feature is documented for Enterprise plans. | Use stable node IDs, lossless text/editor round trips, separate draft and active revisions, and a pinned visual diff. Never store credentials or runtime artifacts in exported process files. n8n's main code uses the [Sustainable Use License](https://github.com/n8n-io/n8n/blob/master/LICENSE.md), with separate enterprise terms for `.ee` code, so use the interaction ideas rather than copying implementation. |
| Mergify | Its [rules engine](https://docs.mergify.com/workflow/) evaluates current pull-request state. An action runs when its rule changes from unmatched to matched, rather than for every repeated event. | Use current-state reconciliation and transition-triggered actions. Webhooks should wake evaluation, not define truth or directly cause a repeated side effect. Do not copy a broad merge-queue product model into v1, where people merge. |
| CodeRabbit | [Automatic reviews](https://docs.coderabbit.ai/configuration/auto-review) run incrementally after pushes and focus on new commits. The documented default pauses automatic reviews after five reviewed commits on one pull request. | Re-review the exact new head and cap automatic fix/review generations. Stop when findings repeat without a tree change, then present the decision to a person. Do not infer implementation or self-hosting details from externally visible product behavior. |


## Slack and private operation

[Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/)
supports channel and direct messages, Block Kit, and text fallback. Use explicit
member IDs and [conversations.open](https://docs.slack.dev/reference/methods/conversations.open/)
for DMs. [Slack formatting](https://docs.slack.dev/messaging/formatting-message-text/)
defines mrkdwn and ID-based mentions. Route by configured GitHub-login mappings
and retain Slack message receipts. Missing mappings require a visible fallback.

[GitHub App registration](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
allows disabling webhooks. Polling plus outbound messaging satisfies the private
VM requirement. GitHub App installation permissions must cover the configured
repositories and actual operations. These references were checked on 2026-09-16.

## Design inference

Share the evaluator between CLI, desktop, and daemon. Persist repository/run
identity separately from PR facts. Add later scheduled maintenance only after
its first concrete use case is refined. The trusted-team requirement removes
hostile-code isolation from the initial implementation; deadlines, state
integrity, stale-input rejection, and remote-write recovery remain necessary.
