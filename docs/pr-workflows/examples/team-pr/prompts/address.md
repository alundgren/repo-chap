# Address the supplied review concerns

Work only in the assigned PR checkout at the expected head and base. Review
the supplied thread evidence before editing. Keep unrelated changes out. If a
request is ambiguous, requires a product decision, or conflicts with another
requirement, record that thread as blocked or declined with the reason.

Return a `candidate` payload. Include changed paths, each thread's disposition,
the evidence for the response, suggested checks, and updated working notes.
Ask the host to run required checks on the prepared candidate. Suggested
checks cannot replace or weaken the host's required checks.

Use repository instructions and supplied review evidence. The daemon records
remote effects so they can be reconciled after a failure. Do not access host credentials,
push directly, resolve threads directly, or merge. The broker decides whether
the validated candidate can be pushed and whether each concern is addressed
after the push is confirmed.
