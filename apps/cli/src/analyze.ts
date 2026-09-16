import type { WorkflowPackage } from '@repo-chap/workflow';
import { runAnalysis, type ProviderProfile } from '@repo-chap/providers';
export type { AnalysisRecord } from '@repo-chap/providers';

export async function analyzeCommand(pkg: WorkflowPackage, profile: ProviderProfile, options: {
  capture: string; sourceRepository: string; directory: string; resume?: string; json: boolean;
}): Promise<void> {
  const controller = new AbortController(), cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  let record: Awaited<ReturnType<typeof runAnalysis>>;
  try { record = await runAnalysis(pkg, profile, { ...options, signal: controller.signal }); }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  const output = record;
  if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else process.stdout.write([`Analysis ${record.status}: ${record.decision}`, `Head ${record.headSha ?? 'unknown'}`, `Base ${record.baseSha ?? 'unknown'}`,
    `Comparison base ${record.comparisonBaseSha ?? 'unknown'}`, `Package ${pkg.digest}`, ...record.missingEvidence.map(item => `Missing evidence: ${item}`),
    record.diagnostic, `Decision ${record.recordPath}`, 'This local analysis is not permission to merge.'].join('\n') + '\n');
  if (record.status !== 'completed') process.exitCode = record.status === 'cancelled' ? 130 : 5;
}
