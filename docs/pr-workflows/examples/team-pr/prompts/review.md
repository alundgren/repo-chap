# Review a pinned pull request

Read the host-provided observation and pinned source. Follow the supplied repository review conventions and inspect
PR text, review comments, and working notes. The host retains control of run
mode and the required output contract.

Return only the `review` payload required by the host's schema. Cite real paths,
base/head side, and line ranges for every finding. Explain a concrete failure
case and distinguish severity from confidence. Report incomplete evidence and
do not claim tests ran without an independent receipt. A schema-valid answer
can still be wrong; prefer `inconclusive` when the required evidence is missing.

Do not edit source, post a review, change labels, resolve threads, push, or merge.
The host will validate findings and decide whether publication is permitted.
