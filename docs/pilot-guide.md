# Disposable environment test

The live test has three commands: create one private environment, test it, then
delete it. A failed test leaves the
environment running for diagnosis. A powered-off Droplet still bills.

Use a dedicated private repository. The commands never merge or change its
default branch. Keep credentials, Terraform state, provider login data, raw
repository evidence, and logs in the private operator directory outside Git.

## One-time test repository setup

The environment tests expect `.github/workflows/pilot.yml` from
`deploy/pilot/trusted-workflow.yml` and two stable branches:

- `pilot-failing` contains `pilot-check.sh` that exits 1.
- `pilot-repaired` contains a different commit where `pilot-check.sh` exits 0.

Both branches contain the workflow and must remain unchanged during a test. The
workflow accepts the environment's unique runner label and has one job named
`check`. The suite refuses changed heads, multiple matching dispatches, another
runner, or an unexpected conclusion.

Prepare a repository-scoped GitHub App, a dedicated Codex login, and the private
daemon files described in [disposable host setup](pilot-digitalocean.md). Slack
is not part of this suite.

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

The underlying commands are also available directly:

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
tags, one Tailscale device, and one repository runner. It transfers the private
daemon configuration and dedicated Codex authentication, installs the pinned
tools, runs account diagnostics, and starts Repo Chap. If creation fails after
cloud resources may exist, it retains the environment for SSH diagnosis and
prints the explicit delete command. Billing continues until deletion succeeds.

## 2. Test

Run the environment tests using its ID:

```sh
vp run pilot test --environment ENVIRONMENT_ID
```

Test checks daemon health, then dispatches the failing and repaired heads in
order. It stops at the first unexpected result and prints one line per completed
scenario in the form `scenario: pass` or `scenario: fail`. The two jobs
must use distinct commits and the environment's recorded runner ID, name, and
unique label. Dispatch intent and results are stored in private `test.json`.
A lost dispatch response is reconciled by correlation before any retry.

Success and failure both leave the environment running. On failure, follow
[SSH diagnosis](pilot-ssh-debugging.md), fix the cause with explicit operator
approval, and rerun the same test command. Billing continues throughout.

## 3. Delete

Delete the environment:

```sh
vp run pilot delete --environment ENVIRONMENT_ID
vp run pilot verify-clean --environment ENVIRONMENT_ID
```

Delete stops services, removes the runner and Tailscale registration, runs
Terraform destroy, and falls back to independently identified DigitalOcean API
deletion when Terraform state is missing. Ownership collisions and unexpected
tagged resources stop destructive work. Repeat delete and `verify-clean` until
DigitalOcean, GitHub, and Tailscale all report `absent`.

`pilot reap --older-than 24h` previews recorded abandoned environments. Add
`--confirm` only after checking every selected environment ID.
