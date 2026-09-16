# GitHub inspection and private captures

`@repo-chap/github` collects one PR through read-only GraphQL queries. The CLI,
future local trials, and daemon can share it. It does not search for PRs, run
providers, approve reviews, or change repository data.

```sh
repo-chap inspect ./team-pr/workflow.json \
  --repo reef-labs/paperboat --pr 42 \
  --capture-dir "$HOME/.local/state/repo-chap/captures" \
  --reviewers willow-bot --json
```

The workflow uses the same loader and package digest as validation and replay.
Inspection requires an explicit capture directory outside Git. New directories
have mode 0700, and existing ones must belong to the current account with no
group or other access. Each inspection creates a new child directory containing
mode-0600 `fixture.json` and `evidence.json`. Capture roots cannot be symlinks.
No command commits evidence. Inspect never starts a model, even if the workflow
contains agent actions. A future provider trial must have its own explicit start.

JSON and text output show the pinned package, head/base, mergeability, each
collection's coverage, final revision check, and capture paths. Exit 0 means
complete collection, not readiness to merge. Exit 4 means incomplete evidence,
access/authentication failure, or a capture failure. Interrupting an active read
retains collected evidence and exits 130 after saving it. Workflow and usage
failures keep exits 2 and 64. A process killed without a catchable signal cannot
save evidence still held in memory.

## Credentials

`localCredentials()` selects `GH_TOKEN`, then `GITHUB_TOKEN`, then the token from
a bounded local `gh auth token --hostname github.com` subprocess. The subprocess
output stays in memory. No command-line token option or workflow credential field
exists. CLI login failures give a fixed diagnostic without subprocess output.
The current collector targets GitHub.com; Enterprise Server hosts need a separate
explicit host contract before support can be claimed.

Daemon callers create `installationCredentials({ appId, installationId,
privateKey })` using operator settings held outside repositories. It signs an
RS256 JWT in memory and requests an installation token with contents, pull
requests, checks, and commit statuses read permissions. GitHub App webhooks can
remain disabled. This token request is the only REST POST; it creates a credential
and does not change a repository. Future repository effects need explicitly
scoped credentials with the required write permissions.

Installation tokens refresh within one minute of expiry. A 401 invalidates the
cached token and permits one refresh per query. Failed token requests have a
bounded cooldown; rate-limit guidance can extend it. Tokens, keys, JWTs, response
headers, and raw transport errors are absent from captures and CLI output. The
redactor also removes known credential values if a response body repeats them.
This is not a general scanner for unrelated secrets in PR content, so captures
remain private.

See GitHub's [installation-token guide](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
and [JWT guide](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app).
Account setup and permission checks against real installations remain pilot work.

## Reads, coverage, and timing

`inspectPullRequest(reader, package, { repository, pr, reviewers, previous })`
returns a serializable version-1 `Inspection`. `GitHubReader` accepts credentials
and optional cancellation, fetch, clock, and bounded-read settings. Access errors
belong to the requested repository and PR, so a daemon can retain that result
while continuing other repositories.

The collector keeps repository/PR node IDs separate from display names. It reads
lifecycle, draft state, head/base and branch identities, mergeability, labels,
head-commit checks and statuses, submitted/pending reviews, threads with their
comments, and configured reviewer activity. It paginates each required connection,
including each thread's comments. The final metadata read checks repository/PR
identity, head/base, lifecycle, draft state, and update timestamp against the
initial read. A mismatch is `revision.status: changed`; a failed final read is
`unknown`. Neither permits complete evidence. This is a bounded observation across
several requests, not an atomic GitHub snapshot.

Captures contain PR metadata and review bodies, not changed-file lists, diffs,
repository source files, or a checkout. `complete` certifies the requested GitHub
collections only. Later provider analysis must obtain the code inputs it needs
at the recorded head/base and bind their revisions and digests to its result.
It must not interpret this collection status as complete source-code evidence.

Every collection has `items` and `coverage` with `status`, `pages`, and an optional
fixed failure code/message and `retryAt`. `complete` certifies collection, not a
passing check or an acceptable review. `partial` retains successful pages or nodes
with missing evidence. `unknown` means no page was collected successfully. An empty
list with unknown coverage must never be interpreted as no checks, reviews, or
threads. Unknown mergeability remains unknown even when its field was read.

Reads are sequential. Defaults allow at most 200 GraphQL requests, three attempts
per query, 120 seconds per inspection, 15 seconds per request, 100 pages per
connection, 2 MiB per response, and 16 MiB of response bodies per inspection. Server `Retry-After` and primary reset times
pause subsequent requests, including after a successful response exhausts the
remaining allowance. Guidance beyond the deadline returns incomplete evidence
with the retry time. Secondary rate limits without a timestamp wait at least one
minute. Limits may be lowered or raised only up to the package's fixed ceilings.
See GitHub's [rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

The initial metadata response records when this process first observed the head.
It does not infer a push time from commit author or committer dates. A daemon must
persist and pass `previous` to keep that time across polls and restarts. Reuse
requires the same stable repository ID, PR ID, head SHA, and base SHA. A changed
identity or either revision starts a new conservative debounce interval. The
prior inspection must also have passed its final revision check. The prior
time must be valid and no later than the current capture clock. A standalone CLI
inspection therefore begins a fresh debounce interval.

Configured reviewer logins are an explicit collector option, exposed by
`--reviewers`, separate from workflow schema v1. Matching is case-insensitive.
With no configured logins, the waiting hint is false and no reaction read is
needed. The first version uses PR `EYES` reactions as hints. It retains their
original creation times rather than poll times. A submitted review by that actor
on the current head, at or after the reaction, clears the hint. Otherwise the
oldest pending reaction starts the workflow's fixed reviewer deadline. Expiry
clears the hint through shared `currentFacts`; partial reactions or reviews leave
it unknown. Other bot conventions need an explicit future contract. An unresolved
thread remains unaddressed even if GitHub marks its location outdated. Neither
reaction activity nor the `complete` status establishes review acceptability.

## Replay and later consumers

The replay schema remains unchanged. `fixture.json` contains the collected facts,
head/base, timestamps, and `observation.evidenceDigest`, and passes shared
`parseFixture`. Incomplete required reads set `evidenceComplete: false` and unknown
derived facts to null. It contains no invented classification, review verdict,
provider result, or execution receipt.

`evidence.json` has `schemaVersion: 1`, `status`, `packageDigest`, `evidenceDigest`,
`fixtureDigest`, and `evidence`. The evidence includes identities, collections,
coverage, configured reviewers, and revision verification. `evidenceDigest` is
the shared SHA-256 digest of canonical evidence JSON. Collection-clock timestamps
are in the fixture, so observing unchanged evidence again does not itself defeat
concern suppression. `fixtureDigest` covers the full canonical fixture including
its clock and timing facts. The stored package digest is the existing shared
workflow package digest.

Analysis/runtime consumers should use `readCapture(directory, pinnedPackage)`.
It checks versions, both digests, the expected package digest, the fixture's
evidence digest, and matching head/base. Mixing two capture directories or loading
a different workflow package fails explicitly. Keep this returned evidence and
its fixture together when binding provider results to inputs. Analysis cannot
fill missing GitHub evidence by guessing. Replaying an edited copy of a fixture
is allowed, but that copy no longer passes the original capture binding. To replay
the untouched capture, use the ordinary offline command:

```sh
repo-chap replay ./team-pr/workflow.json --fixture /private/capture/fixture.json
```

Transport-backed contract tests exercise public/private results, pagination,
partial and cancelled reads, rate limits, credential expiry/revocation, capture
privacy and digest mismatches. They do not prove live-account permissions or
macOS operation; those checks remain part of the pilot.
