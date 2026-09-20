# Pilot journey audit

The merged command simplification still required the operator to construct
workflows and fixtures, discover daemon identities, assemble a case file and
record human evidence after the command reported completion. Tests supplied
those prerequisites themselves. This audit separates account decisions from
program work before implementing the coordinator.

| Action from an empty private operator directory | Owner |
| --- | --- |
| Install local tools and authenticate GitHub, cloud, tailnet and provider accounts | Human |
| Install GitHub and Slack apps, grant repository/channel access, supply their credentials | Human |
| Choose the private repository, region, size, provider profile, Slack workspace/channel and credential paths | Human |
| Generate and protect the operator directory, SSH keypair and configuration template | Program |
| Register the public SSH key with the cloud account and authorize the tailnet policy | Human |
| Validate selections and credentials, generate bounded repair permissions and check policy | Program |
| Provision, install and record the daemon, runner, cloud and tailnet identities | Program, through create |
| Approve named live repository mutations, paid provider calls and Slack delivery | Human, inside test |
| Build runner smoke workflow and environment-specific branches | Program |
| Install pilot review workflow, prompts, schemas, source and protected regression tests | Program |
| Register the workflow source with the daemon | Program |
| Construct review defect, conflicting base and conflicting PR branch | Program |
| Create both draft PRs with recorded ownership | Program |
| Wait for workflow activation and daemon discovery | Program |
| Pause, discover runs, capture original commits and save generated cases | Program |
| Mark PRs ready and resume the repository | Program |
| Dispatch and verify runner smoke checks, observe tested daemon repairs and exact pushes | Program |
| Verify current, distinct Slack deliveries | Program |
| Confirm Slack client rendering | Human, prompted and recorded inside test |
| Retain checkpoints and reconcile interrupted operations before another write | Program |
| Approve deletion of the named environment | Human, inside delete |
| Stop services, close matching owned PRs and conditionally remove or restore recorded refs | Program |
| Remove infrastructure and verify repository/cloud/runner/tailnet cleanup | Program, through delete |

Live failure, restart, stale-head and unknown-delivery injection are excluded
from successful pilot completion. They remain automated simulated regression
coverage. The normal journey has no required manual fault exercise or fourth
command. Unknown remote writes remain unresolved rather than authorizing a
blind retry. A changed or unobserved repair head is retained during cleanup.

The production dispatcher accepts transport and prompt substitutes for tests,
but cannot replace its coordinator with the runner-only observer. The journey
test starts without PRs, daemon runs or computed fixture commits. Generated
workflow validation separately checks that fake daemon responses do not hide
invalid workflow files.
