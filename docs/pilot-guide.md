# Disposable environment test

The live test has three commands: create one private environment, test it, then
delete it. A failed test leaves the
environment running for diagnosis. A powered-off Droplet still bills.

Use a dedicated private repository. Preparation may update its pilot workflow,
but the commands never merge pull requests. Keep credentials, Terraform state,
provider login data, raw repository evidence, and logs in the private operator
directory outside Git.

## Repository fixtures

`vp run pilot test` reads the repository from `operator.json`. It preserves other
default-branch files, installs the trusted workflow at
`.github/workflows/pilot.yml`, and creates or resets two stable branches:

- `pilot-failing` contains `pilot-check.sh` that exits 1.
- `pilot-repaired` contains a different commit where `pilot-check.sh` exits 0.

Both branches contain the workflow and must remain unchanged during a test. The
workflow accepts the environment's unique runner label and has one job named
`check`. The suite refuses changed heads, multiple matching dispatches, another
runner, or an unexpected conclusion.

Test records completed repository setup with the environment and reuses it on a
rerun, so saved test evidence keeps the same fixture commits. Use a new
environment to recreate changed or missing fixture branches. GitHub requires a
`workflow_dispatch` workflow on the default branch, so setup may add one commit
there when the checked-in workflow differs.

Prepare a repository-scoped GitHub App, a dedicated Codex login, and the private
daemon files described in [disposable host setup](pilot-digitalocean.md). The
runner smoke test does not need Slack. Also prepare the
[workflow acceptance cases](pilot-workflow-cases.md) for real review, repair,
conflict resolution and delivery to a dedicated Slack channel.

## 1. Create

The setup wizard checks local tools and creates a dedicated SSH keypair in the
private operator directory if needed. It shows the public-key path and waits
for you to register it with DigitalOcean. It then writes `operator.json` outside
Git, saves `REPO_CHAP_PILOT_ROOT` in the ignored repository `.env`, and creates
the environment:

```sh
deploy/pilot/setup.sh
```

The wizard keeps cloud and tailnet credentials only in its process. It cannot
export them back to your shell. Before later test, status, SSH, delete, or
verification commands, load `DIGITALOCEAN_TOKEN`, `TAILSCALE_CLIENT_ID`, and
`TAILSCALE_CLIENT_SECRET` again from your secret manager. Do not save them in
the repository or operator directory.

The underlying command is also available directly:

```sh
printf '%s\n' 'REPO_CHAP_PILOT_ROOT=/absolute/private/repo-chap-pilot' >> .env
vp run pilot create
```

Vite+ loads the ignored `.env` file for later pilot commands. An explicit
`--root` still overrides `REPO_CHAP_PILOT_ROOT`.

If `operator.json` does not exist, create writes a template and stops. Complete
the template, then run the same command again. A failed environment can be
resumed with `create --environment ENVIRONMENT_ID`.

Create provisions one Ubuntu host, a deny-inbound firewall, a Project, ownership
tags, one Tailscale device, and one
repository runner. It transfers the private daemon configuration and dedicated
Codex authentication, installs the pinned tools, runs account diagnostics, and
starts Repo Chap. If creation fails after cloud resources may exist, it retains
the environment for SSH diagnosis and prints the explicit delete command.
Billing continues until deletion succeeds. Successful deletion and cleanup
verification print `done`. Create prints its current phase, then
`done - id: ENVIRONMENT_ID`.

## 2. Test

Create prints the environment ID and saves it in the private operator directory
as the current environment. Later commands use that ID unless you supply an
explicit `--environment`.

Run the environment tests:

```sh
vp run pilot test
```

Test prepares and records the repository fixtures, checks daemon health,
dispatches the failing and repaired heads in order, then runs the configured
workflow acceptance cases. It stops at the first unexpected result and prints
one line per completed
scenario in the form `scenario: pass` or `scenario: fail`. The two jobs
must use distinct commits and the environment's recorded runner ID, name, and
unique label. Dispatch intent and results are stored in private `test.json`.
A lost dispatch response is reconciled by correlation before any retry.

Success and failure both leave the environment running. On failure, follow
[SSH diagnosis](pilot-ssh-debugging.md), fix the cause with explicit operator
approval, and rerun the same test command. Billing continues throughout.

See [workflow acceptance cases](pilot-workflow-cases.md) for the two PR fixtures,
private case configuration, Slack setup and expected evidence included in the
same test command.

## 3. Delete

Delete the environment:

```sh
vp run pilot delete
vp run pilot verify-clean --environment ENVIRONMENT_ID
```

Delete shows the selected environment ID and its age, then asks for `y` or
`yes`. Any other answer cancels deletion. Successful deletion clears the saved
current environment. A non-interactive delete must include `--environment ID`.

Delete stops services, removes the runner and Tailscale registration, runs
Terraform destroy, and falls back to independently identified DigitalOcean API
deletion when Terraform state is missing. Ownership collisions and unexpected
tagged resources stop destructive work. Repeat delete and `verify-clean` until
DigitalOcean, GitHub, and Tailscale all report `absent`.

`pilot reap --older-than 24h` lists recorded abandoned environments and asks for
confirmation before deleting them. Check every selected environment ID before
answering yes.
