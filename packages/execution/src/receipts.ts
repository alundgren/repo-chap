import { canonicalJson, digest } from '@repo-chap/workflow';
import { ExecutionError, validatePolicy } from './policy.js';
import type { ExecutionPolicy, RepairResult } from './types.js';

/** Required commands are operator inputs. A provider suggestion is never a receipt. */
export function validateTestedCandidate(result: RepairResult, policy: ExecutionPolicy): void {
  validatePolicy(policy);
  const candidate = result.candidate, payload = result.payload;
  if (result.status !== 'candidate' || !result.requiredChecksPassed || !candidate || payload?.outcome !== 'candidate' ||
    payload.candidateSha !== candidate.sha || payload.expectedHeadSha !== result.headSha || payload.baseSha !== result.baseSha ||
    ![candidate.sha, candidate.tree, result.headSha, result.baseSha, ...candidate.parents].every(sha => /^[a-f0-9]{40}$/.test(sha)) ||
    candidate.sha === result.headSha || candidate.parents[0] !== result.headSha ||
    candidate.parents.length !== 1 && !(candidate.parents.length === 2 && candidate.parents[1] === result.baseSha) ||
    result.policyDigest !== digest(canonicalJson(policy)) || result.checks.length !== policy.requiredChecks.length)
    throw new ExecutionError('A push requires the finalized candidate and its exact execution policy and required-check receipts.');
  for (const [index, command] of policy.requiredChecks.entries()) {
    const receipt = result.checks[index]!;
    if (receipt.id !== command.id || receipt.commandDigest !== digest(canonicalJson(command)) || receipt.candidateSha !== candidate.sha ||
      receipt.status !== 'passed' || receipt.exitCode !== 0 || !receipt.log || !Number.isFinite(Date.parse(receipt.startedAt)) ||
      !Number.isFinite(Date.parse(receipt.finishedAt)) || Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt))
      throw new ExecutionError('Required checks did not pass on this exact candidate with the configured commands.');
  }
}
