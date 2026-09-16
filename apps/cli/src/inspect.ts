import { GitHubReader, inspectPullRequest, localCredentials, prepareCaptureDirectory, saveCapture, type Coverage } from '@repo-chap/github';
import type { WorkflowPackage } from '@repo-chap/workflow';

export async function inspectCommand(pkg: WorkflowPackage, options: { repository: string; pr: number; directory: string; reviewers: string[]; json: boolean }): Promise<void> {
  const directory = await prepareCaptureDirectory(options.directory);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const credentials = await localCredentials();
    const inspection = await inspectPullRequest(new GitHubReader(credentials, { signal: controller.signal }), pkg,
      { repository: options.repository, pr: options.pr, reviewers: options.reviewers });
    const capture = await saveCapture(directory, inspection);
    const evidence = inspection.evidence;
    const coverage: Record<string, Coverage> = { metadata: evidence.metadata, labels: evidence.labels.coverage, checks: evidence.checks.coverage,
      reviews: evidence.reviews.coverage, threads: evidence.threads.coverage, reviewerActivity: evidence.reviewerActivity.coverage };
    const result = { schemaVersion: 1, status: inspection.status, repository: options.repository, pr: options.pr,
      packageDigest: pkg.digest, evidenceDigest: inspection.evidenceDigest, headSha: evidence.pullRequest?.headSha ?? null, baseSha: evidence.pullRequest?.baseSha ?? null,
      mergeability: evidence.pullRequest?.mergeability ?? 'unknown', revision: evidence.revision, coverage, capture };
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      const lines = [`Inspect ${inspection.status}: ${options.repository}#${options.pr}`, `Package ${pkg.digest}`,
        `Head ${result.headSha ?? 'unknown'}`, `Base ${result.baseSha ?? 'unknown'}`, `Revision ${evidence.revision.status}; mergeability ${result.mergeability}`];
      for (const [name, value] of Object.entries(coverage)) lines.push(`${name}: ${value.status}${value.failure ? `. ${value.failure.message}${value.failure.retryAt ? ` Retry at ${value.failure.retryAt}.` : ''}` : ''}`);
      if (evidence.revision.failure) lines.push(evidence.revision.failure.message);
      lines.push(`Fixture ${capture.fixture}`, `Evidence ${capture.evidence}`, 'Inspection collects evidence only. It does not establish readiness to merge.');
      process.stdout.write(`${lines.join('\n')}\n`);
    }
    if (inspection.status !== 'complete') process.exitCode = controller.signal.aborted ? 130 : 4;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
