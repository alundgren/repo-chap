# Generated pilot cases

`pilot test` owns setup and observation for both workflow cases. The operator
supplies only account credentials, a provider profile and the Slack destination,
then approves the in-command mutation prompt. There is no operator-authored
workflow-case file.

The review fixture contains `price(amount, percent)` implemented as subtraction
of a fixed amount. The generated regression test requires percentage discounts:
200 at 10 percent must become 180, 80 at 25 percent must become 60, and zero
percent must preserve the price. The daemon must find the defect, repair it,
pass the protected regression check and push that exact candidate.

The conflict fixture changes `greeting()` from `Hello` to `Hello, ${name}` while
its dedicated base changes the same line to `Welcome`. The generated prompt and
regression tests require `Welcome, ${name}`. The suite first records GitHub's
conflicting state, then requires a mergeable tested candidate incorporating the
recorded base as a parent and a confirmed conditional push.

Setup copies the team PR workflow's contracts and prompts, routes successful
review to repair and successful push to handoff, and confines repair writes to
`src`. Tests remain outside those allowed paths. Each environment has unique
branch names and ownership markers. Git commit identities, PR numbers, daemon
run IDs, original bases and heads, required checks and the Slack destination are
recorded in its private manifest before either PR becomes ready.

Both repaired PRs must have distinct, current, confirmed handoffs to the selected
workspace and channel. Unknown sends, queued messages, previews and superseded
receipts cannot pass. The command then prompts for Slack client rendering and
saves that human result. Success requires both API evidence and confirmation.

The private `workflow-test.json` retains baselines, daemon results, check and
push evidence, Slack receipts and rendering confirmation. Reruns observe those
same runs without authorizing retries or resends. A changed head or base fails.

The live pilot includes these two workflow cases and the runner smoke suite.
Failure, restart, stale-head and unknown-outcome injection are simulated regression
coverage, not additional operator completion exercises. See the
[three-command guide](pilot-guide.md) for the entire normal journey.
