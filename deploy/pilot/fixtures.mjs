import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { privateDirectory, writePrivate, validateRun } from './store.mjs';

const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
export async function generateFixtures(store, run) {
  validateRun(run);
  const directory = join(store.directory(run.id), 'fixtures');
  await privateDirectory(directory, true);
  await generateOfflineFixtures(directory);
  const workflow = `name: Pilot check\non:\n  push:\n    branches: ['${run.name}/**']\npermissions:\n  contents: read\njobs:\n  check:\n    runs-on: ['${run.name}']\n    timeout-minutes: 5\n    steps:\n      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n      - run: bash pilot-check.sh\n`;
  await writePrivate(join(directory, 'pilot.yml'), workflow);
  await writePrivate(join(directory, 'pilot-check.sh'), '#!/bin/sh\nset -eu\ntest "$(cat greeting.txt)" = "Hello, woodland"\n');
  await writePrivate(join(directory, 'greeting.txt'), 'Hello, woodland\n');
  // Each operation is deliberately shown before confirmation. No whole-script approval.
  const guard = `repo=${quote(run.repository)}
run=${quote(run.id)}
prefix=${quote(run.name)}
files=${quote(directory)}
checkout=${quote(join(store.directory(run.id), 'test-repository'))}
mutate() {
  printf 'Target %s, run %s. Proposed command: ' "$repo" "$run"
  printf '%q ' "$@"
  printf '\\nType approve %s to execute this one mutation: ' "$run"
  IFS= read -r reply
  test "$reply" = "approve $run" || return 1
  test "$(gh api "repos/$repo" --jq '.id')" = ${quote(String(run.repositoryId))} || return 1
  test "$(gh api "repos/$repo" --jq '.private')" = true || return 1
  test "$(git remote get-url origin)" = "https://github.com/$repo.git" || return 1
  "$@"
}
`;
  const plan = `# Private fixture plan

Run ${run.id}. Repository ${run.repository}. Runner label ${run.name}.
Generated files contain fictional content. Keep this directory outside Git.
Execute the following blocks in a dedicated Bash terminal. Stop on any error.
Every remote mutation prints a preview and requires the exact run confirmation.
Do not run the whole plan as an unattended script. Never merge a PR.
Do not broaden the configured repository or use untrusted code on this runner.

## Set up the local copy

\`\`\`bash
set -eu
${guard}
test ! -e "$checkout"
git clone "https://github.com/$repo.git" "$checkout"
cd "$checkout"
git switch -c "$prefix/base"
mkdir -p .github/workflows
cp "$files/pilot.yml" .github/workflows/pilot.yml
cp "$files/pilot-check.sh" "$files/greeting.txt" .
git add .github/workflows/pilot.yml pilot-check.sh greeting.txt
git commit -m 'Add fictional pilot check'
mutate git push --force-with-lease="refs/heads/$prefix/base:" origin "HEAD:refs/heads/$prefix/base"
\`\`\`

The repository must have an initial commit. The base is a unique test branch;
this plan never writes the default branch. Configure the daemon workflow source
and apply policy for these selected PRs. Require \`bash pilot-check.sh\` locally.
Pause daemon effects until the initial failing job has been recorded.

## Ordinary review and CI failure with no review threads

\`\`\`bash
git switch -c "$prefix/ci" "$prefix/base"
printf 'Hello, broken\\n' > greeting.txt
git add greeting.txt
git commit -m 'Introduce a reproducible fictional failure'
mutate git push --force-with-lease="refs/heads/$prefix/ci:" origin "HEAD:refs/heads/$prefix/ci"
mutate gh label create "$prefix" --repo "$repo" --description 'Disposable pilot run' --color 70866B
mutate gh pr create --repo "$repo" --base "$prefix/base" --head "$prefix/ci" --title 'Fictional CI repair' --body 'Restore the expected greeting; do not merge.' --label "$prefix"
\`\`\`

Record the PR number, observed SHA and initial failed job/runner IDs privately.
Confirm no review threads exist. Enable the configured bounded daemon apply
policy only after previewing its repository, checks and budgets. Observe Codex
repair, checked conditional push, and a new passing job with the SAME runner ID.
Do not substitute a locally passing command for native GitHub job evidence.
If testing a manual repaired-head control instead, preview and confirm:

\`\`\`bash
git switch "$prefix/ci"
observed=$(git ls-remote origin "refs/heads/$prefix/ci" | cut -f1)
test "$observed" = "$(git rev-parse HEAD)"
printf 'Hello, woodland\\n' > greeting.txt
git add greeting.txt
git commit -m 'Repair fictional greeting'
mutate git push --force-with-lease="refs/heads/$prefix/ci:$observed" origin "HEAD:refs/heads/$prefix/ci"
\`\`\`

Record manual control separately. It does not prove Codex repair.

## Conflict and review-response PRs

Create both conflict branches from the same run base, with conflicting edits.
The conflict target is a separate branch so CI recovery remains unchanged.

\`\`\`bash
git switch -c "$prefix/conflict" "$prefix/base"
printf 'Hello, river\\n' > greeting.txt
git add greeting.txt
git commit -m 'Change greeting on conflict head'
mutate git push --force-with-lease="refs/heads/$prefix/conflict:" origin "HEAD:refs/heads/$prefix/conflict"
git switch -c "$prefix/conflict-base" "$prefix/base"
printf 'Hello, mountain\\n' > greeting.txt
git add greeting.txt
git commit -m 'Change greeting on conflict base'
mutate git push --force-with-lease="refs/heads/$prefix/conflict-base:" origin "HEAD:refs/heads/$prefix/conflict-base"
mutate gh pr create --repo "$repo" --base "$prefix/conflict-base" --head "$prefix/conflict" --title 'Fictional conflict repair' --body 'Resolve greeting conflict, satisfy the local check, and request human handoff. Do not merge.' --label "$prefix"
git switch -c "$prefix/review" "$prefix/base"
printf 'Fictional review-response exercise.\\n' > review-note.md
git add review-note.md
git commit -m 'Add fictional review note'
mutate git push --force-with-lease="refs/heads/$prefix/review:" origin "HEAD:refs/heads/$prefix/review"
mutate gh pr create --repo "$repo" --base "$prefix/base" --head "$prefix/review" --title 'Fictional review response' --body 'Review the note and hand off to a person. Do not merge.' --label "$prefix"
\`\`\`

After previewing the exact PR and line in GitHub, explicitly approve posting an
inline review asking to clarify the note. Use a separate trusted reviewer
identity. Record the thread ID privately. Check that only that eligible thread
is resolved after the repaired tested head is pushed. Resolved, outdated and
unrelated threads must remain unchanged. A person performs any merge.

## Resume without duplicating remote writes

Keep the local clone and record each successful command privately. Resume at the
first uncompleted command. If a push/create response is lost, inspect the exact
branch or PR before proceeding. Use \`gh pr list --repo "$repo" --state all\`
and \`git ls-remote origin "refs/heads/$prefix/*"\`. Do not blindly repeat creates
or replace the clone. Empty-ref leases refuse overwriting an existing branch.

## Clean test-repository content

Run infrastructure cleanup immediately even if these steps fail. Infrastructure
cleanup removes the runner and VM, not PRs, branches or the run label.
In a fresh terminal restore the variables and function from the first block,
then \`cd "$checkout"\`. Preview the selected PRs and explicitly approve each
close in the GitHub UI, checking repository, run label and head branch. Close
only the three run PRs, never merge them. Wait for or cancel their Actions jobs.
Then execute each deletion through its confirmation wrapper:

\`\`\`bash
for branch in ci conflict review conflict-base base; do
  ref="refs/heads/$prefix/$branch"
  observed=$(git ls-remote origin "$ref" | cut -f1)
  if test -n "$observed"; then
    mutate git push --force-with-lease="$ref:$observed" origin ":$ref"
  fi
done
mutate gh label delete "$prefix" --repo "$repo" --yes
\`\`\`

Verify the branches are absent with \`git ls-remote\`, the run PRs are closed,
and the exact run label is absent. If a response is unknown, inspect before
retrying. Preserve redacted evidence externally; do not delete this run directory
until DigitalOcean, GitHub runner and Tailscale verification are all absent.
`;
  await writePrivate(join(directory, 'fixture-plan.md'), plan);
  return directory;
}

export const ciCases = {
  running: { ciFailed: false, ciPending: true },
  pending: { ciFailed: false, ciPending: true },
  mixed: { ciFailed: true, ciPending: true },
  stale: { ciFailed: null, ciPending: null, headDebouncing: true },
  unknown: { ciFailed: null, ciPending: null },
  incomplete: { ciFailed: null, ciPending: null, evidenceComplete: false },
};
export async function generateOfflineFixtures(directory) {
  const source = JSON.parse(await readFile(new URL('../../fixtures/replay/ci-repair.json', import.meta.url), 'utf8'));
  const fixtures = { 'ci-recovery': source };
  for (const [name, facts] of Object.entries(ciCases)) {
    const input = structuredClone(source);
    input.observations = [input.observations[0]];
    Object.assign(input.observations[0].facts, facts);
    delete input.expected;
    fixtures[`ci-${name}`] = input;
  }
  for (const reason of ['remote-log-only', 'infrastructure', 'access', 'credential', 'rerun-only']) {
    const input = structuredClone(source);
    input.observations = [input.observations[0]];
    input.results.fix_ci = [{ status: 'failure', reason: `Fictional ${reason} failure requires an operator handoff.` }];
    delete input.expected;
    fixtures[`ci-${reason}`] = input;
  }
  for (const name of ['changed-head', 'budget', 'unknown-github', 'unknown-slack']) {
    const input = structuredClone(source);
    input.observations = [input.observations[0]];
    delete input.expected;
    if (name === 'changed-head') input.results.fix_ci[0].payload.expectedHeadSha = 'd'.repeat(40);
    if (name === 'budget') input.control.repairsThisLifecycle = 100;
    if (name === 'unknown-github') input.results.push_candidate = [{ status: 'unknown' }];
    if (name === 'unknown-slack') {
      input.results.fix_ci = [{ status: 'failure', reason: 'Fictional operator handoff.' }];
      input.results.handoff = [{ status: 'unknown' }];
    }
    fixtures[`ci-${name}`] = input;
  }
  for (const [name, input] of Object.entries(fixtures)) await writePrivate(join(directory, `${name}.json`), JSON.stringify(input, null, 2) + '\n');
}
