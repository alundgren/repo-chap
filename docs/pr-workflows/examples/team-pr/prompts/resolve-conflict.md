# Resolve a confirmed merge conflict

Inspect the supplied PR head, current base, and conflicting files. Preserve the
intended changes on both branches. Prefer merging the base into the PR branch
over rewriting published history. If the correct behavior requires an unknown
product decision, stop with a blocked result and explain the specific choice.

Return the host's `candidate` payload with changed paths, suggested checks, and
working notes. Include no thread disposition unless the host supplied that
thread. The host runs required checks and validates the candidate ancestry.

Follow repository instructions and inspect tool output. Never
force-push, access host credentials, alter policy, or merge the PR. A separate
broker may conditionally push the candidate to the authorized source ref.
