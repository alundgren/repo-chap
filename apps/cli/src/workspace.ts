import { readCapture } from '@repo-chap/github';
import type { WorkflowPackage } from '@repo-chap/workflow';
import type { ProviderProfile } from '@repo-chap/providers';
import { createRepairJob, readExecutionPolicy, runRepair } from '@repo-chap/execution';

export async function workspaceCommand(pkg: WorkflowPackage, profile: ProviderProfile, options: {
  capture: string; sourceRepository: string; directory: string; policy: string; action: string; json: boolean;
}): Promise<void> {
  const inspection = await readCapture(options.capture, pkg), policy = await readExecutionPolicy(options.policy);
  const job = createRepairJob(pkg, inspection, profile, policy, options.action);
  const controller = new AbortController(), cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const { result, reference } = await runRepair(job, { sourceRepository: options.sourceRepository, artifactDirectory: options.directory, profile, signal: controller.signal });
    if (options.json) process.stdout.write(`${JSON.stringify({ ...result, resultReference: reference }, null, 2)}\n`);
    else process.stdout.write([`Workspace repair ${result.status}`, `Attempt ${result.attemptId}`, `Head ${result.headSha}`, `Base ${result.baseSha}`,
      ...(result.candidate ? [`Candidate ${result.candidate.sha}`, `Required checks ${result.requiredChecksPassed ? 'passed' : 'not passed'}`] : []),
      ...result.checks.map(check => `${check.id}: ${check.status}. ${check.diagnostic}`),
      ...(result.payload?.threads ?? []).map(thread => `Thread ${thread.threadId}: ${thread.disposition}. ${thread.response}`),
      result.diagnostic, `Result ${reference.id}`, `Private artifacts ${options.directory}`, 'This candidate remains local. Humans merge.'].join('\n') + '\n');
    if (result.status !== 'candidate' && result.status !== 'no_change') process.exitCode = result.status === 'cancelled' ? 130 : 6;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
