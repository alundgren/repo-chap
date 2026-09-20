# Workflow acceptance cases

`vp run pilot test` checks the runner, code review and repair, conflict
resolution, and real Slack delivery on the existing private pilot host. One
command runs every pilot test.

The workflow cases observe two dedicated PRs as the daemon processes them. They
do not create PRs, edit workflow permissions, send extra messages, retry effects,
merge PRs, or delete the host. The daemon performs the repairs and sends under
its configured apply policy. Setup is an operator task; observation runs unattended
for up to 120 polls per scenario, ten seconds apart, and stops at the first
failure. Network calls add to that elapsed time.

## Prepare the workflow and channel

Use a dedicated private test repository and a dedicated channel such as
`repo-chap-pilot`. Install a Slack app with a bot in your workspace, give it
`chat:write`, and invite the bot to that channel. A personal Slack account alone
is not a daemon credential. Keep the token in a mode-0600 file in the private,
flat configuration directory copied to `/etc/repo-chap/` during host creation.
Configure `installation.json` as described in [Slack handoffs](slack-handoffs.md).
Existing hosts need an operator-authorized configuration update before this test.

Set the workflow's workspace ID and channel ID to your dedicated destination.
Use an empty `users` mapping and set `defaultChannel` to the dedicated channel
name. Keep `needs_author: "author_dm"`, which falls back to that default when
there is no user mapping. Route the other outcomes to the dedicated channel
name. Do not configure mentions. Keep actual workspace/channel IDs and tokens outside Git.

Start from the [team PR example](pr-workflows/examples/team-pr/workflow.json),
including its referenced prompts, context and schemas. For this pilot workflow,
set `review.onSuccess` to `address` and `push_candidate.onSuccess` to `handoff`.
This explicitly tests a local review followed by a repair, without waiting for
a human to publish an external review. Keep `resolve_conflict` followed by
`validate_candidate` and `push_candidate`. Make the review prompt check the
requirements below; the address prompt must fix the documented discount defect
and return `no_change` if it is already correct. Set `maxAttemptsPerHead` to 4
to allow classification, review and repair on one head. Keep the remaining
normal attempt and repair limits. Do not use this forced review-to-repair continuation as a general
production workflow.

Enable `workspace.write`, `checks.run`, `pr.push`, and `notify.send` in the
applicable provider/workflow/private apply permissions. The GitHub App needs
Contents write for the conditional push. Configure the execution policy with
`allowedPaths: ["src"]` and a required check named `pilot-regression` that invokes
`vp node tests/pilot-regression.mjs`. Keep tests outside allowed repair paths so
the agent cannot make its candidate pass by weakening the assertions. See
[conditional push](conditional-push.md) for the complete policy contract.

## Code review and fix

Create a draft PR with this deliberate defect in `src/price.mjs`:

```js
export const price = (amount, percent) => amount - percent;
```

The requirement is a percentage discount, so a 10 percent discount on 200 must
return 180, and a 25 percent discount on 80 must return 60. Put these assertions
in `tests/pilot-regression.mjs` on the PR branch:

```js
import assert from 'node:assert/strict';
import { price } from '../src/price.mjs';
assert.equal(price(200, 10), 180);
assert.equal(price(80, 25), 60);
assert.equal(price(200, 0), 200);
```

Keep the review PR's hosted smoke check passing so `fix_ci` does not take priority
over review. The regression check is the private repair policy's required check.
The daemon must produce a review finding on the original head, repair the code,
pass the regression check on its candidate, and confirm a push of that exact
candidate. A prewritten passing branch does not satisfy this case.

## Merge conflict and resolve

Create a separate draft PR against a dedicated base branch. Start both from:

```js
export const greeting = () => 'Hello';
```

On the PR branch, change `src/greeting.mjs` to accept a name and return
`Hello, ${name}`. On its base branch, change that same line to return `Welcome`.
The desired result is `Welcome, ${name}`. This creates a same-line conflict with
a specific resolution that preserves both changes. Include the following
`tests/pilot-regression.mjs` on this PR branch:

```js
import assert from 'node:assert/strict';
import { greeting } from '../src/greeting.mjs';
assert.equal(greeting('Mira'), 'Welcome, Mira');
assert.equal(greeting('Rowan'), 'Welcome, Rowan');
```

Use the conflict prompt to state the requirement. Do not change the base after
capturing it. The suite must first observe GitHub reporting `CONFLICTING`, then
observe the conflict action's tested candidate, a confirmed push and GitHub
reporting `MERGEABLE`. The candidate must include the captured base as a parent.
Unknown mergeability cannot pass.

## Record the cases and run

Let the daemon discover both draft PRs, then pause that repository through
`repo-chap daemon pause OWNER/REPO --state-dir /var/lib/repo-chap`. Record their
run IDs with `daemon status --json`. Use the authorized host access described in
[pilot SSH debugging](pilot-ssh-debugging.md). Mark both PRs ready while the
repository is paused. Record each original head and base commit with `gh pr view`.

Write `workflow-cases.json` with mode 0600 in the private pilot operator directory.
This fictional example shows the contract; replace its values with the selected
PRs, daemon run IDs, exact 40-character Git commit IDs and Slack destination:

```json
{
  "version": 1,
  "workspaceId": "TFOREST",
  "channelId": "CPAPERBOAT",
  "review": {
    "pr": 11,
    "runId": "run-review",
    "initialHead": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "baseSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "reviewAction": "review",
    "repairAction": "address",
    "requiredChecks": ["pilot-regression"]
  },
  "conflict": {
    "pr": 12,
    "runId": "run-conflict",
    "initialHead": "cccccccccccccccccccccccccccccccccccccccc",
    "baseSha": "dddddddddddddddddddddddddddddddddddddddd",
    "repairAction": "resolve_conflict",
    "requiredChecks": ["pilot-regression"]
  }
}
```

Run `vp run pilot test`. After `workflow prerequisites: pass`, the command
resumes the repository itself. At that point it has saved both original PR
states before the daemon can repair either. Keep the PRs open until all cases pass.
A changed base, closed PR or unrelated daemon run fails the test.

The command prints:

```text
workflow prerequisites: pass
code review and fix: pass
merge conflict and resolve: pass
Slack message sending: pass
```

Private `ENVIRONMENT_ID/workflow-test.json` retains original PR
states, daemon results, required check evidence, push receipts and Slack receipts.
Rerunning the command reads the same cases and reconciles their recorded state;
it never authorizes another repair or Slack resend. Use a new environment for a
new selection. Failure retains the environment and evidence for diagnosis.

## Slack message sending

Both repaired PRs must have a current, confirmed handoff to the selected workspace
and channel. The receipts must identify two distinct messages. A preview, queued
request, rejected send, superseded decision or unknown send cannot pass. The
suite rechecks the live PR heads before accepting delivery evidence.

Open those two messages in Slack and confirm the PR links, head commits, findings,
repair summary and test evidence are readable. Record that human observation in
the private operator directory. The automated result verifies API receipts; it
cannot prove that a Slack client displayed the blocks correctly.

For delivery failure, remove bot access to the dedicated channel before a fresh
case. Confirm the inbox retains the packet and the suite fails without authorizing
a repair retry. Restore access and follow the existing bounded delivery recovery.
For an unknown outcome, inspect Slack and use `daemon slack-reconcile` with the
actual receipt or an explicitly authorized resend. Never resend just to make the
test green. A host restart must preserve the same receipts and repair counts;
rerun the suite after an operator-authorized restart and compare the retained
attempt records. These fault exercises and client rendering remain operator
checks; the test does not interrupt the daemon or change Slack membership.
