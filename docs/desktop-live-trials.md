# Read-only live trials in Electron

Live trial runs the open workflow's classification and review against a selected
GitHub PR. It uses the exact unsaved JSON and referenced files. Source saving,
offline simulation, conversation and live analysis remain separate actions.

Choose the repository and PR, a named private provider profile, and the local
repository containing the PR head, target base and common history. The open
repository is the initial local source. Prepare missing Git objects with normal
Git tools. Repo Chap reads objects by commit; it never fetches or changes that
checkout. The app validates the draft against the selected profile's capability
ceiling. A direct trial requires exactly one classification and one review action.

The form names read-only mode and its calls before Start. Prepare proposal makes
no GitHub or model call. Start captures pending editor input through the document
queue, validates its token, and pins its files, package, profile and selection.
Changing those inputs stops active work and requires another Start. Invalid
inspector text remains visible and blocks Start. Provider settings and normal
local GitHub/provider login stay private; the app does not activate daemon
configuration.

Either assistant can call `prepare_live_trial` with a repository, PR and loaded
profile name. Source IDs refer only to the workspace or directories already
chosen with the picker. It captures pending human input through the host's
read-only author operation and consumes one of that document session's 128
receipts. Stale tokens, rejected input, cancellation and an exhausted receipt
limit reject preparation. After an assistant edit, the operation uses the latest
authoring context token. A successful result says `prepared: true, started: false`;
the person reviews the populated Live trial form and presses Start separately.
Reloading settings in either task view updates both profile lists. Prepare and
Start carry the exact displayed settings identity; an outdated request rejects
before any GitHub or provider call and requires another explicit Start. Changing
or removing a prepared profile clears that proposal. A retained result continues
to identify the settings used by its actual run.

## Retained evidence

The shared `runAnalysis` API powers the CLI and desktop analysis. It uses
`saveCapture`/`readCapture`, `collectSources` and `runProvider` in read mode. It
performs no repair, required check, GitHub mutation, Slack delivery or merge.
The evaluator's proposed next action is retained context, never a dispatched
operation. Conversation sessions are not analysis sessions.

The result keeps the tested document token, exact draft digest, semantic package
digest, provider settings identity, capture and source digests, head, target base,
comparison base, validated findings and missing evidence. Actual token counters
remain separate from estimates, including estimated monetary cost. Partial
metadata or source evidence cannot become a clear analysis result.
Exact draft currentness includes all loaded source and fixture bytes. Editing a
loaded offline fixture therefore invalidates currentness conservatively, while
the original live capture and validated provider payloads remain unchanged.

The last GitHub read runs after completed analysis. The result says when its
remote evidence was last checked. Later remote changes are unknown until the
person chooses Refresh GitHub evidence or starts another trial. Refresh performs
reads only, detects changed heads or evidence, and never reruns the model. Failed
or cancelled refresh clears current remote knowledge and retains the completed
analysis.

Trials have a ten-minute total deadline, alongside the shared collector, source
and provider limits. Cancel remains available from every task view and while a
file picker or document operation is pending. Status reads also bypass that
queue. Closing or switching stops owned trial processes before replacing the
workspace. Completed and interrupted records remain separate from temporary
conversation cleanup.

The app stores mode-0600 records in its private mode-0700 `live-trials` directory
outside Git. It retains the latest ten trial directories across workspaces.
Records have a 16 MiB limit, with captured inputs bounded by the shared package,
GitHub and provider contracts. Restart reads retained records but never resumes
unfinished work automatically. A trial interrupted before completion is marked
blocked, with its saved inputs and available analysis records retained.

Save as offline fixture is explicit. It writes `fixture.json` and a separate
`provenance.json` to a new private export directory outside Git. Successful
classification/review payloads become action stubs. Export never edits the
original capture. Editing that fixture or later expectations establishes no new
remote evidence. Either assistant can discuss a retained result through typed
context, including its tested inputs and last-check state; chat prose alone
establishes no execution.

## Verification boundaries

Automated tests use fictional repositories, GraphQL responses and provider
executables. Electron proof exercises the actual application under Linux Xvfb
with Playwright's `--no-sandbox --inspect=0 --remote-debugging-port=0` flags and
supplied picker responses. This verifies those UI flows, not normal host sandbox
launch, native picker behavior, native macOS execution, real account entitlement,
paid usage or model quality. Those checks remain in the personal pilot.
