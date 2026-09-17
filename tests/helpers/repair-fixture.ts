import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalJson, digest } from '@repo-chap/workflow';
import { saveCapture } from '@repo-chap/github';
import { createRepairJob, type ExecutionPolicy } from '@repo-chap/execution';
import { setup as providerFixture, git } from './provider-fixture.ts';

export async function repairFixture(provider: 'codex' | 'claude' = 'codex', mode = 'valid', conflict = false) {
  const s = await providerFixture('valid', { provider });
  await writeFile(join(s.repository, 'AGENTS.md'), 'Keep the exported value numeric. Use the supplied review intent.\n');
  git(s.repository, 'add', 'AGENTS.md'); git(s.repository, 'commit', '-qm', 'Repository instructions'); s.head = git(s.repository, 'rev-parse', 'HEAD');
  s.inspection.evidence.pullRequest!.headSha = s.head; s.inspection.evidence.revision.headSha = s.head; s.inspection.fixture.observations[0]!.headSha = s.head;
  if (conflict) {
    git(s.repository, 'checkout', '--detach', s.base);
    await writeFile(join(s.repository, 'src/value.js'), 'export const value = 4;\n');
    git(s.repository, 'commit', '-qam', 'Base advances'); s.base = git(s.repository, 'rev-parse', 'HEAD');
    git(s.repository, 'checkout', '--detach', s.head);
    s.inspection.evidence.pullRequest!.baseSha = s.base; s.inspection.evidence.pullRequest!.mergeability = 'conflicting';
    s.inspection.evidence.revision.baseSha = s.base; s.inspection.fixture.observations[0]!.baseSha = s.base;
    s.inspection.fixture.observations[0]!.facts.conflict = true;
  } else {
    s.inspection.evidence.threads.items.push({ id: 'THREAD_value', resolved: false, outdated: false, path: 'src/value.js', line: 1,
      comments: { coverage: { status: 'complete', pages: 1 }, items: [{ id: 'COMMENT_value', author: 'river', body: 'Use value three.', headSha: s.head, createdAt: '2026-01-01T00:00:00Z' }] } });
    s.inspection.fixture.observations[0]!.facts.unaddressedReview = true;
  }
  s.inspection.evidenceDigest = digest(canonicalJson(s.inspection.evidence)); s.inspection.fixture.observations[0]!.evidenceDigest = s.inspection.evidenceDigest;
  const capture = await saveCapture(join(s.temporary, 'captures'), s.inspection);
  await writeFile(s.executable, `#!${process.execPath}\nglobal.fixture=${JSON.stringify({ provider, mode, log: s.log, marker: s.marker, childPid: s.childPid })};\nrequire(${JSON.stringify(resolve('tests/helpers/fake-repair.cjs'))});\n`, { mode: 0o700 });
  const policy: ExecutionPolicy = { schemaVersion: 1, allowedPaths: ['src'], excludedPaths: ['src/generated'], requiredChecks: [{ id: 'value', executable: process.execPath,
    args: ['-e', 'const fs=require("node:fs"),cp=require("node:child_process");if(cp.execFileSync("git",["rev-parse","HEAD"]).toString().trim()!==process.env.REPO_CHAP_CANDIDATE_SHA)process.exit(8);if(fs.readFileSync("src/value.js","utf8")!=="export const value = 3;\\n")process.exit(9);'], timeoutMs: 5000, maxOutputBytes: 64 * 1024 }] };
  const policyFile = join(s.temporary, 'execution.json'); await writeFile(policyFile, JSON.stringify(policy));
  const action = conflict ? 'resolve_conflict' : 'address';
  const job = () => createRepairJob(s.pkg, s.inspection, s.profile, policy, action);
  const options = { sourceRepository: s.repository, artifactDirectory: s.output, profile: s.profile };
  const args = ['workspace', resolve('docs/pr-workflows/examples/team-pr/workflow.json'), '--capture', capture.directory, '--source-repo', s.repository, '--output-dir', s.output,
    '--provider-config', s.settings, '--profile', 'pilot', '--execution-policy', policyFile, '--action', action, '--json'];
  return { ...s, policy, policyFile, job, options, args };
}
