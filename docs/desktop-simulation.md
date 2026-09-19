# Workflow simulation

The desktop's Simulate view runs the same replay and expectation comparison as
`repo-chap replay`. Choose Test fixtures for saved fictional observations and
stubbed results. Choose Real PRs for an inspection directory containing paired
`evidence.json` and `fixture.json` files. The agent edits fixtures directly.

Results show the chosen rule path, rejected earlier rules, action outcomes,
proposed effects, and any expectation comparison. Input details exposes the
fixed clock and optional Slack packet input. Simulation starts no provider,
makes no network request, and sends no effects.

A result retains its tested package and input digests. File changes or read
failures mark it stale. Test fixtures and real PR captures retain independent
selections and results. Captures show their observed head, time, and collection
status, and never imply current GitHub state. See [the companion guide](desktop.md)
for CLI commands and [the shared contracts](workflow-api.md) for expectations.
