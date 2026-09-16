# Local workspace repair

`repo-chap workspace` prepares a local repair from one captured PR revision.
It creates a disposable checkout, runs the selected provider, creates the final
commit, and runs required checks on that commit. It retains a private result,
patch and Git bundle, then removes the checkout. The source repository's refs
and working files remain unchanged.

```sh
repo-chap workspace path/to/workflow.json \
  --capture /private/trials/inspection-example \
  --source-repo /local/repositories/paperboat \
  --output-dir /private/trials/repairs \
  --provider-config /private/providers.json --profile pilot \
  --execution-policy /private/execution.json --action address --json
```

Use the same pinned workflow as the capture. The source repository must already
contain the captured head and base commits. The command never fetches from a
remote. `--action` identifies an `agent.address_review` or
`agent.resolve_conflict` action. Repair requires complete capture evidence, an
open non-draft PR, and either unresolved review threads or a confirmed conflict.
A conflict must reproduce locally before starting the provider.

Select Codex or Claude through the existing named
[provider profiles](claude-analysis.md). Real model calls remain explicit local
trials. Automated tests use fake executables and fictional Git repositories.

## Required checks and permitted changes

The execution caller supplies a version-1 policy separately from workflow JSON.
This keeps command execution under the caller's control and pins it into the
job's policy digest. A policy needs at least one required command.

```json
{
  "schemaVersion": 1,
  "allowedPaths": ["src", "tests", "package.json"],
  "excludedPaths": ["src/generated"],
  "requiredChecks": [
    {
      "id": "tests",
      "executable": "corepack",
      "args": ["pnpm", "test"],
      "timeoutMs": 120000,
      "maxOutputBytes": 1048576
    }
  ]
}
```

Paths are exact files or directory prefixes. `src` includes `src/value.ts` and
excludes `src-extra/value.ts`. Excluded prefixes take precedence. Git metadata,
`node_modules` and `.repo-chap` paths are never candidates. Changed entries must
be regular files or deletions; new symlinks and submodules are rejected. Include
any intended merged-base paths in the policy for conflict repair. The host
compares the staged path list with the provider's declared changes before
creating a commit. It rejects unresolved conflict markers.

Commands use an executable and argument array, without an implicit shell. They
run sequentially in the finalized checkout. A failure skips later commands.
`REPO_CHAP_CANDIDATE_SHA` supplies the exact finalized commit. Receipts contain
that SHA, command digest, exit code, timestamps, status and a bounded private log
reference. A command that changes tracked files, HEAD, the index, or creates
unignored files fails validation. Ignored build outputs may remain in the
disposable checkout until cleanup. Provider `suggestedChecks` remain advisory;
they are never executed or accepted as replacements for required commands.

The workflow and operator profile must permit `checks.run`. That permission
belongs to the host check runner. The supplied repair actions still omit it, so
Claude receives Read/Glob/Grep/Edit/Write and does not receive Bash.

The application creates no remote refs, messages, reviews, thread changes or
labels. Disposable checkouts have no configured remote. Providers and configured
commands are trusted programs instructed to perform local work; this is not a
hostile-code or network-isolation system.

## Provider proposals and host results

The host tells the provider to edit permitted files without committing or
changing HEAD. For a candidate proposal, the provider sets `candidateSha` to the
pinned head and lists paths changed relative to that head. This field identifies
the proposal's starting commit. It is not a tested candidate receipt.

Both providers first pass the unchanged canonical and configured payload
validators. The host then validates paths and thread decisions, stages the
proposed files and creates a commit itself. Review repairs have the captured PR
head as their sole parent. Conflict repairs have the captured PR head first and
the captured target base second. The host replaces the proposal SHA with this
new commit and runs both payload validators again before running checks.
Consumers must use `RepairResult.payload` and `RepairResult.candidate`, not the
proposal retained in `RepairResult.provider.payload`.

Every captured unresolved thread needs exactly one addressed, declined or
blocked decision with an explanation. Resolved or foreign thread IDs, duplicate
IDs and omitted decisions are rejected. The host supplies evidence references
`thread:<id>`, `evidence:<digest>` and `source:<digest>`; other references are
rejected. An addressed decision requires at least one reference. Any blocked
thread, or a declined-only review response, prevents finalization. The host
converts proposed addressed decisions to blocked when another decision stops
the entire candidate. Unknown product intent belongs in a blocked reason.
Blocked and no-change outputs cannot claim addressed threads.

## Jobs, results and recovery

`@repo-chap/execution` exports `createRepairJob`, `runRepair`,
`readRepairAttempt`, `readRepairResult`, `readArtifact`, and `restoreCandidate`.
The version-1 `RepairJob` is JSON data containing run/attempt/ownership IDs, an
absolute deadline, stable repository/PR IDs, head/base, action, the pinned
workflow and capture, profile identity/digest, and execution policy/digest.
Local source and storage directories, the resolved profile, cancellation and
current-ownership callbacks are execution options. They are absent from job
and result recovery identities.

The version-1 `RepairResult` repeats these identities and input digests. It
contains the provider record, the final canonical payload when available,
required check receipts, and candidate tree/parents plus bundle and patch
references. `status: candidate` and `requiredChecksPassed: true` together mean
all configured checks passed on that candidate. A failed candidate remains
available for inspection with `status: checks_failed`. Blocked, no-change,
invalid-output, provider-error, cancellation, timeout and superseded outcomes
never claim successful checks. No result authorizes a remote effect.

Artifacts use `{id, digest, bytes, kind}`. `id` is the SHA-256 hexadecimal digest
without its `sha256:` prefix. The storage directory resolves it to immutable
private bytes. The reader checks size, ownership, permissions and digest.
Each artifact is limited to 128 MiB. The complete Git bundle contains candidate
history and does not depend on a worker directory or the original repository.
Large histories that cannot fit the limit produce a blocked result.
`restoreCandidate` requires an empty private directory and verifies the restored
commit's tree and parent IDs. Failed-check candidates may also be restored for
inspection; that does not make them eligible to push.

An `attempt-<id>.json` receipt records the pinned job and completed result
reference. `readRepairAttempt` recovers that result after checkout removal or
process restart. Duplicate attempt IDs do not rerun a provider. An interrupted
process can leave a `running` receipt; this is unfinished work, not successful
completion. A future scheduler must reconcile ownership and reserve a new
attempt rather than resetting the old attempt or its budget. Worker directories
left by a hard process kill can be removed after ownership is resolved.

`runRepair` clones its input and checks package, capture, policy and profile
identities. `isCurrent` rejects lost ownership or replaced inputs before and
after provider and check work. The caller must still verify ownership and
current remote revisions when accepting a result for any later effect. The
worker does not manage daemon leases or lifetime budgets.

The job deadline and workflow attempt ceiling bound the whole operation.
Provider profile limits remain in force. Git commands have a 30-second ceiling,
ordinary Git output a 2 MiB ceiling, and bundle/patch output the artifact ceiling.
Checks each have their own timeout/output bound inside the job deadline.
Cancellation, timeout and process exit terminate the process group, including
remaining descendants. Notes and diagnostics stay in private artifacts outside
the checkout. Candidate commits contain repository edits only.

## CLI outcomes and human verification

Text output leads with the outcome, pinned revisions and candidate SHA, then
shows required checks and thread decisions. JSON includes the complete result
and `resultReference`. Exit 0 means a tested local candidate or an explicit
no-change result; inspect `status` to distinguish them. Exit 6 means a blocked or
failed repair, and 130 means cancellation. Existing workflow, provider-settings
and usage errors retain their existing exit codes.

The personal pilot must verify real Codex/Claude repair quality, supported
provider authentication and native macOS behavior. It must inspect the retained
patch, required-check output and unknown-intent handoff. Automated Linux tests
prove the execution and recovery contracts without paid calls or remote writes.
