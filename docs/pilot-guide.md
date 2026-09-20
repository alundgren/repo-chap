# Disposable pilot

The normal pilot uses exactly three commands:

```sh
vp run pilot create
vp run pilot test
vp run pilot delete
```

Select an absolute private directory outside Git with `REPO_CHAP_PILOT_ROOT`.
Keep credentials, generated configuration, checkpoints and evidence there, never
in the repository. Use a dedicated private repository with an initial commit and
no unrelated open PRs. A powered-off Droplet still bills until deletion succeeds.

## Account prerequisites

Install the local tools and supply the account inputs described in
[host setup](pilot-digitalocean.md). Authenticate GitHub, DigitalOcean, Tailscale
and a dedicated provider account. Install the repository-scoped GitHub App with
Contents write and the documented inspection permissions. Install a Slack bot
with `chat:write` and channel-read access, and invite it to the selected channel.
Choose the repository, cloud region and size, provider profile, Slack workspace
and channel. Register the generated SSH public key with DigitalOcean.

These are account credentials and stable selections. Do not construct fixture
branches, workflows, prompts, repair policies, PRs or workflow-case files.

## Create

`create` writes a private `operator.json` template if it is missing. Fill in the
account selections and paths, then repeat `create`. It generates the bounded
pilot repair policy and provider permissions for the host, provisions the private
VM and installs the daemon and runner. It saves the current environment so later
commands need no ID. Repeating create resumes that environment.

Environments created by the earlier manual-case workflow need deletion and a
new create so the host receives the generated pilot policy. Existing manually
created fixtures have no ownership record and are never adopted for cleanup.

Cloud and tailnet credentials must remain available in the invoking process.
The optional account setup helper cannot export credentials back to its parent
shell. Load them from your secret manager for each shell session.

## Test

`test` validates the selected accounts and daemon before changing fixtures. Its
approval prompt names the repository and Slack destination and authorizes fixture
writes, paid provider calls, tested pushes and handoffs for this environment.

It installs the runner workflow and pilot review workflow, prompts, source files
and regression tests. It creates environment-specific smoke branches, a review
PR and a conflicting PR, registers the workflow with the daemon, waits for
activation and draft discovery, pauses the repository, records exact original
commits and run IDs, marks the PRs ready, and resumes processing.

The suites verify a failing runner job and a passing job on different commits,
a review finding followed by a tested repair, a tested conflict resolution, and
two confirmed Slack deliveries. Before reporting success, test shows the Slack
messages and asks you to confirm that their links, commit IDs, findings, repair
summaries and check evidence are readable. That answer is saved with the receipts.
A non-interactive invocation cannot silently satisfy this human check.

All generated cases and checkpoints live under the private environment directory.
Repeat `test` after interruption. It reuses recorded PRs, runs, dispatches and
receipts; it does not request repair retries or Slack resends. An unresolved
remote outcome fails visibly and retains its intent for reconciliation.

Live delivery-failure injection, host restart, stale-head injection and unknown
Slack outcome injection are excluded from pilot completion. Automated simulated
regression tests cover these failure cases. The live pilot does not change Slack
membership or deliberately interrupt daemon effects. No manual appendix is
required to finish this pilot.

## Delete

`delete` asks you to confirm the current environment and its age. It stops the
services, removes the runner, tailnet device and cloud resources, and verifies
absence in the same invocation. It removes completed, identity-checked smoke workflow runs, closes recorded fixture PRs and removes
recorded branches only when their identities and commits still match. Confirmed
repair commits are accepted only from saved daemon evidence. It restores the
original default branch only when its current commit is exactly the installed
pilot commit, using a conditional Git push.

Changed or uncertain artifacts are retained and reported as unresolved. Cloud
cleanup still proceeds. Restore account access or inspect the recorded conflict,
then repeat delete. It clears the current environment only after successful
cleanup. Do not merge fixture PRs. No fourth command is required.

`status`, `ssh`, `verify-clean` and `reap` are recovery and diagnostic tools.
Non-interactive delete requires an explicit `--environment ID`. Tailnet diagnosis
requires the permission described in [SSH debugging](pilot-ssh-debugging.md).
