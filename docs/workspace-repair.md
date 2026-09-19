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
remote. `--action` identifies an `agent.address_review`,
`agent.resolve_conflict`, or `agent.fix_ci` action. Repair requires complete
capture evidence and an open non-draft PR. The action also needs unresolved
review threads, a confirmed conflict, or failed CI with no pending or unknown
checks, respectively.
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
      "executable": "vp",
      "args": ["run", "test"],
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
the captured target base second. A reproduced conflict may retain the PR tree
with an empty changed-path list; it still needs the new two-parent commit to
record the conflict resolution. An empty content diff alone does not make that
commit unnecessary. Review repairs still require a content change. The host replaces the proposal SHA with this
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

## Inspect a retained candidate

Save the workspace command's `--json` output to a private file. From a built
Repo Chap source checkout with dependencies installed, this example reads the
verified result, prints its patch and required-check logs, and restores the
candidate to an empty private directory. All paths below are local examples.

```sh
vp node --input-type=module - \
  /private/trials/repairs /private/trials/repair-result.json \
  /private/trials/restored-candidate <<'JS'
import { readFile } from 'node:fs/promises';
import { readArtifact, readRepairResult, restoreCandidate } from '@repo-chap/execution';
const [store, outputFile, destination] = process.argv.slice(2);
const output = JSON.parse(await readFile(outputFile, 'utf8'));
const result = await readRepairResult(store, output.resultReference);
console.log(result.status, result.diagnostic);
if (result.candidate) {
  process.stdout.write(await readArtifact(store, result.candidate.patch));
  for (const check of result.checks) {
    console.log(`${check.id}: ${check.status}`);
    if (check.log) process.stdout.write(await readArtifact(store, check.log));
  }
  await restoreCandidate(store, output.resultReference, destination);
  console.log(`Restored ${result.candidate.sha} to ${destination}`);
}
JS
```

If the JSON command output was lost, use `readRepairAttempt(store, attemptId)`
with the printed attempt ID. A completed receipt returns the same result and
reference. A `running` receipt is unfinished and must be reconciled before a new
attempt. Restoring a failed-check candidate is useful for inspection; restoration
never authorizes publication. A conflict candidate can have an empty patch, so
also inspect its recorded parents and required-check receipts.

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

## CI repair

The example workflow selects `fix_ci` for failed GitHub checks after waiting
for running checks. This action can repair a PR with no review threads. It
receives captured check names, results and URLs and the pinned repository;
it does not fetch remote failure logs. The provider must diagnose the cause
locally or return a blocked result explaining what is missing. Do not disable
checks to hide failures. Infrastructure or access problems need a human handoff.

Configure required local checks that reproduce the repository's CI where
possible. The host runs those commands on the finalized candidate. After a
conditional push, a fresh GitHub observation must confirm CI results before a
merge recommendation. The normal lifecycle repair limits survive that push.

Replay `fixtures/replay/ci-repair.json` with the team-pr example to see a repair,
validation, push and fresh observation waiting for CI. The separate
`fixtures/replay/ci-pending.json` example waits without starting a provider.
Both fixtures include expected outcomes for the companion's simulation view.
