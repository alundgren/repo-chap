import assert from 'node:assert/strict';
import type { Inspection } from '@repo-chap/github';
import type { AnalysisJob, AnalysisResult } from '@repo-chap/runtime';

export function remote(inspection: Inspection, count = 1) {
  const calls: string[] = [];
  let draft = false, closed = false, unavailable = false, reviewer = false, incomplete = false;
  const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)), operation = /query\s+(\w+)/.exec(request.query)?.[1] ?? '';
    calls.push(operation); assert.ok(request.query.startsWith('query '));
    if (unavailable) return Response.json({ data: { repository: null } });
    if (incomplete && operation === 'Inspectreviews') return Response.json({ data: null, errors: [{ message: 'Fictional incomplete review collection.' }] });
    const pr = inspection.evidence.pullRequest!, repo = inspection.evidence.repository!;
    let data: unknown;
    if (operation === 'PollPullRequests') data = { repository: { id: repo.id, nameWithOwner: repo.name, isPrivate: true, pullRequests: page(closed ? [] : Array.from({ length: count }, (_, index) => ({ number: 42 + index }))) } };
    else if (operation === 'InspectMetadata') data = { repository: { id: repo.id, nameWithOwner: repo.name, isPrivate: true, pullRequest: {
      id: `PR_${request.variables.number}`, number: request.variables.number, url: pr.url.replace(/\d+$/, String(request.variables.number)), title: pr.title, body: pr.body, author: { login: pr.author }, state: closed ? 'CLOSED' : 'OPEN', isDraft: draft,
      headRefOid: pr.headSha, baseRefOid: pr.baseSha, headRefName: pr.headRef, baseRefName: pr.baseRef, headRepository: { id: repo.id, nameWithOwner: repo.name },
      createdAt: pr.createdAt, updatedAt: pr.updatedAt, mergeable: pr.mergeability.toUpperCase(), reviewDecision: null,
    } } };
    else if (operation === 'PushTarget') data = { repository: { id: repo.id, nameWithOwner: repo.name, defaultBranchRef: { name: 'main' }, pullRequest: {
      id: pr.id, number: pr.number, state: closed ? 'CLOSED' : 'OPEN', isDraft: draft, headRefOid: pr.headSha, baseRefOid: pr.baseSha,
      headRefName: pr.headRef, baseRefName: pr.baseRef, headRepository: pr.headRepository && { id: pr.headRepository.id, nameWithOwner: pr.headRepository.name },
    } } };
    else if (operation === 'InspectreviewThreads') data = { repository: { pullRequest: { reviewThreads: page(inspection.evidence.threads.items.map(thread => ({ id: thread.id, isResolved: thread.resolved, isOutdated: thread.outdated, path: thread.path, line: thread.line }))) } } };
    else if (operation === 'InspectThreadComments') data = { node: { comments: page(inspection.evidence.threads.items.find(thread => thread.id === request.variables.id)!.comments.items.map(comment => ({ id: comment.id, author: { login: comment.author }, body: comment.body, createdAt: comment.createdAt, commit: comment.headSha && { oid: comment.headSha } }))) } };
    else if (operation === 'ThreadTarget') {
      const thread = inspection.evidence.threads.items.find(value => value.id === request.variables.id);
      data = { node: thread ? { id: thread.id, isResolved: thread.resolved, isOutdated: thread.outdated, path: thread.path, line: thread.line, viewerCanResolve: true,
        pullRequest: { id: pr.id, number: pr.number, state: closed ? 'CLOSED' : 'OPEN', isDraft: draft, headRefOid: pr.headSha, baseRefOid: pr.baseSha, headRefName: pr.headRef,
          repository: { id: repo.id, nameWithOwner: repo.name }, headRepository: pr.headRepository && { id: pr.headRepository.id } },
        comments: { ...page(thread.comments.items.map(comment => ({ id: comment.id, author: comment.author && { login: comment.author }, body: comment.body,
          createdAt: comment.createdAt, commit: comment.headSha && { oid: comment.headSha } }))), totalCount: thread.comments.items.length },
      } : null };
    }
    else if (operation === 'InspectChecks') data = { repository: { object: { statusCheckRollup: { contexts: page(inspection.evidence.checks.items.map(check => check.kind === 'CheckRun' ? { __typename: check.kind, id: check.id, name: check.name, status: check.status, conclusion: check.conclusion, detailsUrl: check.url } : { __typename: check.kind, id: check.id, context: check.name, state: check.status, targetUrl: check.url })) } } } };
    else if (operation === 'Inspectreactions') data = { repository: { pullRequest: { reactions: page(reviewer ? [{ id: 'EYES_fictional', user: { login: 'willow-bot' }, content: 'EYES', createdAt: '2026-09-16T12:00:00Z' }] : []) } } };
    else if (operation.startsWith('Inspect')) data = { repository: { pullRequest: { [operation.slice(7)]: page([]) } } };
    else throw new Error('Unexpected query');
    return Response.json({ data });
  };
  return { calls, fetch, pullRequests: (value: number) => { count = value; }, draft: (value: boolean) => { draft = value; }, close: () => { closed = true; }, access: (value: boolean) => { unavailable = !value; }, reviewer: (value = true) => { reviewer = value; }, incomplete: () => { incomplete = true; } };
}
export function completed(job: AnalysisJob): AnalysisResult {
  const payload = job.actionId === 'classify' ? { schemaVersion: 1, headSha: job.headSha, labels: [], uncertain: false } :
    { schemaVersion: 1, headSha: job.headSha, baseSha: job.baseSha, summary: 'Fictional pinned review.', verdict: 'acceptable', coverage: 'complete', missingEvidence: [], findings: [] };
  return { schemaVersion: 1, job, provider: { schemaVersion: 1, provider: 'codex', providerVersion: 'fixture', profile: 'pilot', providerDigest: null, inputDigest: job.evidenceKey,
    outcome: 'completed', diagnostic: 'Validated fixture analysis.', payload, attempts: [] } };
}
