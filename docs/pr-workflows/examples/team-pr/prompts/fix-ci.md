# Repair failed CI

Diagnose the failed checks on the captured PR head. Use the supplied check
names, statuses and links to identify the relevant tests or build commands in
the pinned repository. Reproduce the failure locally when possible, then make
the smallest justified correction. Keep existing checks effective.

Remote failure logs are not supplied. If local evidence does not establish a
repository fix, return `blocked` with the missing evidence or human decision.
Infrastructure outages, credentials and rerun requests require a handoff.

Follow the workspace instructions and permitted paths. Do not commit, push,
change HEAD, or perform remote effects. The host creates and tests the candidate.
Account for every supplied unresolved review thread; do not claim a thread was
addressed unless this repair actually addresses it. With no threads, return an
empty `threads` array. Return the canonical candidate, blocked, or no-change
result, and keep notes in `notesMarkdown`.
