# Real PRs in the companion

The agent uses `repo-chap inspect` to capture real PR evidence outside Git, then
`repo-chap desktop simulate --capture <inspection-directory>` to show and replay
it. The app distinguishes captured real PRs from fictional test fixtures and
identifies the observed head, capture time, and evidence coverage.

A capture is a saved observation. It can test an edited workflow without fetching
GitHub again, but does not establish the current remote head. Run `inspect` again
for new evidence. The app verifies capture files and leaves missing action
results visible rather than presenting them as successful analysis.

Live provider analysis, disposable workspace repair, and remote apply run through
the CLI. See [the desktop guide](desktop.md), [local analysis](codex-analysis.md),
and [workspace repair](workspace-repair.md). The former desktop provider/trial
controls have been removed; private historical trial files remain on disk.
