# Repo Chap guidance

Repo Chap is an independent repository-care product for trusted teams. Its v1
applications are a macOS/Linux CLI named `repo-chap`, a local Electron workflow
companion and simulator, and a daemon on a private Linux VM. There is no public
server endpoint.

Read docs/product-brief.md and docs/pr-workflows/decisions.md before changing
scope. Keep JSON and Markdown authoring usable without the Electron app. Share
validation and evaluation across the CLI, companion, and daemon. Keep runtime
state outside managed repositories. Preserve run limits across bot commits.

Use fictional repositories, people, and Slack IDs in examples and tests. Keep
credentials, private repository evidence, machine details, and logs outside Git.
Never commit screenshots, recordings, browser reports, or image baselines.

Test observable behavior, including failed configuration activation, restarts,
stale heads, and unknown remote outcomes. Run all project commands through
Vite+ (`vp`). Use `vp install`,
`vp run <script>`, `vp exec <tool>`, and `vp node <file>` so Vite+ selects
the pinned Node and pnpm versions. Keep test output compact and store failure
diagnostics outside the checkout.

Implementation issues close through a PR body containing `Closes #<issue>`.
Human verification issues close after the stated evidence is recorded. Use
native sub-issues and blocking dependencies for the implementation plan.
