import { canonicalJson, currentFacts, digest, parseFixture, type Observation, type ReplayFixture, type WorkflowPackage } from '@repo-chap/workflow';
import { GitHubReader, object, type QueryResult } from './client.js';
import { GitHubReadError, readFailure, type ReadFailure } from './errors.js';

export interface Coverage { status: 'complete' | 'partial' | 'unknown'; pages: number; failure?: ReadFailure }
export interface Collection<T> { items: T[]; coverage: Coverage }
export interface RepositoryIdentity { id: string; name: string; private: boolean }
export interface PullRequestEvidence {
  id: string; number: number; url: string; title: string; body: string; author: string | null;
  lifecycle: 'open' | 'closed' | 'merged'; draft: boolean; headSha: string; baseSha: string;
  headRef: string; baseRef: string; headRepository: { id: string; name: string } | null;
  createdAt: string; updatedAt: string; mergeability: 'mergeable' | 'conflicting' | 'unknown'; reviewDecision: string | null;
}
export interface LabelEvidence { id: string; name: string }
export interface CheckEvidence { id: string; kind: 'CheckRun' | 'StatusContext'; name: string; status: string; conclusion: string | null; url: string | null }
export interface ReviewEvidence { id: string; author: string | null; state: string; body: string; headSha: string | null; submittedAt: string | null }
export interface CommentEvidence { id: string; author: string | null; body: string; createdAt: string; headSha: string | null }
export interface ThreadEvidence { id: string; resolved: boolean; outdated: boolean; path: string; line: number | null; comments: Collection<CommentEvidence> }
export interface ReactionEvidence { id: string; actor: string | null; content: string; createdAt: string }
export interface Evidence {
  schemaVersion: 1;
  requested: { repository: string; pr: number };
  repository: RepositoryIdentity | null;
  pullRequest: PullRequestEvidence | null;
  metadata: Coverage;
  labels: Collection<LabelEvidence>;
  checks: Collection<CheckEvidence>;
  reviews: Collection<ReviewEvidence>;
  threads: Collection<ThreadEvidence>;
  reviewerActivity: Collection<ReactionEvidence>;
  configuredReviewers: string[];
  revision: { status: 'stable' | 'changed' | 'unknown'; headSha?: string; baseSha?: string; failure?: ReadFailure };
}
export interface Inspection {
  schemaVersion: 1;
  status: 'complete' | 'partial' | 'unavailable';
  packageDigest: string;
  evidenceDigest: string;
  evidence: Evidence;
  fixture: ReplayFixture;
}
const pageFields = 'pageInfo { hasNextPage endCursor } nodes';
const prFields = `id number url title body author { login } state isDraft headRefOid baseRefOid headRefName baseRefName
  headRepository { id nameWithOwner } createdAt updatedAt mergeable reviewDecision`;
const metadataQuery = `query InspectMetadata($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) { id nameWithOwner isPrivate pullRequest(number:$number) { ${prFields} } }
}`;
function str(value: unknown): string { if (typeof value !== 'string') throw new GitHubReadError('invalid_response'); return value; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') throw new GitHubReadError('invalid_response'); return value; }
function nullable(value: unknown): string | null { return value === null ? null : str(value); }
function sha(value: unknown): string { const text = str(value); if (!/^[a-f0-9]{40}$/.test(text)) throw new GitHubReadError('invalid_response'); return text; }
function timestamp(value: unknown): string { const text = str(value); if (!Number.isFinite(Date.parse(text))) throw new GitHubReadError('invalid_response'); return new Date(text).toISOString(); }
function login(value: unknown): string | null { return value === null ? null : str(object(value).login); }
function commit(value: unknown): string | null { return value === null ? null : sha(object(value).oid); }
function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw new GitHubReadError('invalid_response'); return value as T;
}
const empty = <T>(): Collection<T> => ({ items: [], coverage: { status: 'unknown', pages: 0 } });
function unpackMetadata(result: QueryResult): { repository: RepositoryIdentity; pr: PullRequestEvidence } {
  const data = object(result.data);
  if (data.repository === null) throw new GitHubReadError('access');
  const repo = object(data.repository);
  if (repo.pullRequest === null) throw new GitHubReadError('access');
  const pr = object(repo.pullRequest);
  if (!Number.isSafeInteger(pr.number) || Number(pr.number) < 1) throw new GitHubReadError('invalid_response');
  return {
    repository: { id: str(repo.id), name: str(repo.nameWithOwner), private: bool(repo.isPrivate) },
    pr: {
      id: str(pr.id), number: Number(pr.number), url: str(pr.url), title: str(pr.title), body: str(pr.body), author: login(pr.author),
      lifecycle: enumValue(pr.state, ['OPEN', 'CLOSED', 'MERGED'] as const).toLowerCase() as PullRequestEvidence['lifecycle'],
      draft: bool(pr.isDraft), headSha: sha(pr.headRefOid), baseSha: sha(pr.baseRefOid), headRef: str(pr.headRefName), baseRef: str(pr.baseRefName),
      headRepository: pr.headRepository === null ? null : { id: str(object(pr.headRepository).id), name: str(object(pr.headRepository).nameWithOwner) },
      createdAt: timestamp(pr.createdAt), updatedAt: timestamp(pr.updatedAt),
      mergeability: enumValue(pr.mergeable, ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] as const).toLowerCase() as PullRequestEvidence['mergeability'],
      reviewDecision: pr.reviewDecision === null ? null : enumValue(pr.reviewDecision, ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']),
    },
  };
}
async function collect<T>(reader: GitHubReader, query: string, variables: Record<string, unknown>, select: (data: Record<string, unknown>) => unknown, map: (node: Record<string, unknown>) => T): Promise<Collection<T>> {
  const result = empty<T>(); let cursor: string | null = null;
  const cursors = new Set<string>();
  try {
    for (let page = 0; page < 100; page++) {
      const response = await reader.query(query, { ...variables, cursor });
      const connection = object(select(object(response.data)));
      if (!Array.isArray(connection.nodes)) throw new GitHubReadError('invalid_response');
      result.coverage.pages++;
      for (const node of connection.nodes) {
        try { result.items.push(map(object(node))); }
        catch (error) { result.coverage.failure = readFailure(error); }
      }
      if (response.incomplete) result.coverage.failure = new GitHubReadError('graphql').failure;
      const info = object(connection.pageInfo);
      if (!bool(info.hasNextPage)) {
        result.coverage.status = result.coverage.failure ? 'partial' : 'complete'; return result;
      }
      cursor = str(info.endCursor);
      if (!cursor || cursors.has(cursor)) throw new GitHubReadError('invalid_response');
      cursors.add(cursor);
      if (response.incomplete) break;
    }
    throw new GitHubReadError(result.coverage.failure ? 'graphql' : 'limit');
  } catch (error) {
    result.coverage = { status: result.coverage.pages ? 'partial' : 'unknown', pages: result.coverage.pages, failure: readFailure(error) };
    return result;
  }
}
const pull = (data: Record<string, unknown>) => object(object(data.repository).pullRequest);
function prConnection(name: string, selection: string, args = ''): string {
  return `query Inspect${name}($owner:String!, $name:String!, $number:Int!, $cursor:String) {
    repository(owner:$owner,name:$name) { pullRequest(number:$number) { ${name}(first:100,after:$cursor${args}) { ${pageFields} { ${selection} } } } }
  }`;
}
export function validateTarget(repository: string, pr: number): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(repository) || !Number.isSafeInteger(pr) || pr < 1 || pr > 2_147_483_647)
    throw new Error('Inspect requires --repo owner/name and a positive --pr number.');
}
export async function inspectPullRequest(reader: GitHubReader, pkg: WorkflowPackage, options: {
  repository: string; pr: number; reviewers?: string[]; previous?: Inspection;
  reviewerDeadline?: { startedAt: string; until: number };
}): Promise<Inspection> {
  validateTarget(options.repository, options.pr);
  const reviewers = [...new Set((options.reviewers ?? []).map(s => s.trim().toLowerCase()))].sort();
  if (reviewers.length > 100 || reviewers.some(s => !/^[a-z0-9][a-z0-9-]*(\[bot\])?$/.test(s))) throw new Error('Reviewer logins must be comma-separated GitHub logins.');
  const [owner, name] = options.repository.split('/');
  const variables = { owner, name, number: options.pr };
  const evidence: Evidence = {
    schemaVersion: 1, requested: { repository: options.repository, pr: options.pr }, repository: null, pullRequest: null,
    metadata: { status: 'unknown', pages: 0 }, labels: empty(), checks: empty(), reviews: empty(), threads: empty(), reviewerActivity: empty(),
    configuredReviewers: reviewers, revision: { status: 'unknown' },
  };
  let headObservedAt: string | undefined;
  try {
    const response = await reader.query(metadataQuery, variables);
    const value = unpackMetadata(response);
    if (value.pr.number !== options.pr) throw new GitHubReadError('invalid_response');
    evidence.repository = value.repository; evidence.pullRequest = value.pr;
    evidence.metadata = { status: response.incomplete ? 'partial' : 'complete', pages: 1, ...(response.incomplete ? { failure: new GitHubReadError('graphql').failure } : {}) };
    headObservedAt = new Date(reader.now()).toISOString();
  } catch (error) { evidence.metadata.failure = readFailure(error); }
  if (evidence.pullRequest) {
    evidence.labels = await collect(reader, prConnection('labels', 'id name'), variables, data => pull(data).labels,
      node => ({ id: str(node.id), name: str(node.name) }));
    evidence.checks = await collect(reader, `query InspectChecks($owner:String!, $name:String!, $oid:GitObjectID!, $cursor:String) {
      repository(owner:$owner,name:$name) { object(oid:$oid) { ... on Commit { statusCheckRollup { contexts(first:100,after:$cursor) {
        ${pageFields} { __typename ... on CheckRun { id name status conclusion detailsUrl } ... on StatusContext { id context state targetUrl } }
      } } } } }
    }`, { owner, name, oid: evidence.pullRequest.headSha }, data => {
      const rollup = object(object(data.repository).object).statusCheckRollup;
      return rollup === null ? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } : object(rollup).contexts;
    }, node => {
      const kind = enumValue(node.__typename, ['CheckRun', 'StatusContext'] as const);
      return { id: str(node.id), kind, name: str(kind === 'CheckRun' ? node.name : node.context), status: str(kind === 'CheckRun' ? node.status : node.state),
        conclusion: kind === 'CheckRun' ? nullable(node.conclusion) : null, url: nullable(kind === 'CheckRun' ? node.detailsUrl : node.targetUrl) };
    });
    evidence.reviews = await collect(reader, prConnection('reviews', 'id author { login } state body commit { oid } submittedAt'), variables, data => pull(data).reviews,
      node => ({ id: str(node.id), author: login(node.author), state: enumValue(node.state, ['PENDING', 'COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']), body: str(node.body), headSha: commit(node.commit), submittedAt: node.submittedAt === null ? null : timestamp(node.submittedAt) }));
    evidence.threads = await collect(reader, prConnection('reviewThreads', 'id isResolved isOutdated path line'), variables, data => pull(data).reviewThreads, node => {
      if (node.line !== null && !Number.isSafeInteger(node.line)) throw new GitHubReadError('invalid_response');
      return { id: str(node.id), resolved: bool(node.isResolved), outdated: bool(node.isOutdated), path: str(node.path), line: node.line as number | null, comments: empty<CommentEvidence>() };
    });
    for (const thread of evidence.threads.items) {
      thread.comments = await collect(reader, `query InspectThreadComments($id:ID!, $cursor:String) {
        node(id:$id) { ... on PullRequestReviewThread { comments(first:100,after:$cursor) { ${pageFields} { id author { login } body createdAt commit { oid } } } } }
      }`, { id: thread.id }, data => object(data.node).comments,
      node => ({ id: str(node.id), author: login(node.author), body: str(node.body), createdAt: timestamp(node.createdAt), headSha: commit(node.commit) }));
      if (thread.comments.coverage.status !== 'complete') {
        evidence.threads.coverage.status = 'partial'; evidence.threads.coverage.failure ??= thread.comments.coverage.failure;
      }
    }
    evidence.reviewerActivity = reviewers.length ? await collect(reader, prConnection('reactions', 'id user { login } content createdAt', ',content:EYES'), variables, data => pull(data).reactions,
      node => ({ id: str(node.id), actor: login(node.user), content: enumValue(node.content, ['EYES']), createdAt: timestamp(node.createdAt) })) : { items: [], coverage: { status: 'complete', pages: 0 } };
    evidence.reviewerActivity.items = evidence.reviewerActivity.items.filter(r => r.actor && reviewers.includes(r.actor.toLowerCase()));
    try {
      const response = await reader.query(metadataQuery, variables);
      const final = unpackMetadata(response);
      const initial = evidence.pullRequest;
      const stable = final.repository.id === evidence.repository!.id && final.pr.id === initial.id &&
        final.pr.headSha === initial.headSha && final.pr.baseSha === initial.baseSha && final.pr.updatedAt === initial.updatedAt &&
        final.pr.lifecycle === initial.lifecycle && final.pr.draft === initial.draft;
      evidence.revision = { status: response.incomplete ? 'unknown' : stable ? 'stable' : 'changed', headSha: final.pr.headSha, baseSha: final.pr.baseSha,
        ...(!stable || response.incomplete ? { failure: new GitHubReadError(response.incomplete ? 'graphql' : 'changed').failure } : {}) };
    } catch (error) { evidence.revision.failure = readFailure(error); }
  } else {
    for (const collection of [evidence.labels, evidence.checks, evidence.reviews, evidence.threads, evidence.reviewerActivity])
      collection.coverage.failure = evidence.metadata.failure;
    evidence.revision.failure = evidence.metadata.failure;
  }
  const safe = JSON.parse(JSON.stringify(evidence, (_key, value) => typeof value === 'string' ? reader.credentials.redact(value) : value)) as Evidence;
  const evidenceDigest = digest(canonicalJson(safe));
  const now = new Date(reader.now()).toISOString();
  const pr = safe.pullRequest;
  const complete = safe.metadata.status === 'complete' && safe.revision.status === 'stable' && pr?.mergeability !== 'unknown' &&
    [safe.labels, safe.checks, safe.reviews, safe.threads, safe.reviewerActivity].every(c => c.coverage.status === 'complete');
  const reviewKnown = safe.reviews.coverage.status === 'complete' && safe.threads.coverage.status === 'complete';
  const latest = new Map<string, ReviewEvidence>();
  for (const review of [...safe.reviews.items].sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''))) {
    if (review.author && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(review.author.toLowerCase(), review);
  }
  const pending = safe.reviewerActivity.items.filter(reaction => !safe.reviews.items.some(review => review.author?.toLowerCase() === reaction.actor?.toLowerCase() &&
    review.submittedAt && review.submittedAt >= reaction.createdAt && review.state !== 'PENDING' && review.headSha === pr?.headSha));
  const activityKnown = safe.reviewerActivity.coverage.status === 'complete' && (!reviewers.length || safe.reviews.coverage.status === 'complete');
  const previous = options.previous?.evidence.revision.status === 'stable' && options.previous.evidence.repository?.id === safe.repository?.id &&
    options.previous.evidence.pullRequest?.id === pr?.id ? options.previous.fixture.observations[0] : undefined;
  const headChangedAt = previous?.headSha === pr?.headSha && previous?.baseSha === pr?.baseSha && previous?.headChangedAt &&
    Number.isFinite(Date.parse(previous.headChangedAt)) && Date.parse(previous.headChangedAt) <= Date.parse(now) ? previous.headChangedAt : headObservedAt;
  const observation: Observation = {
    facts: { lifecycle: pr?.lifecycle ?? null, draft: pr?.draft ?? null, evidenceComplete: complete,
      young: null, headDebouncing: null, conflict: pr ? pr.mergeability === 'unknown' ? null : pr.mergeability === 'conflicting' : null,
      unaddressedReview: reviewKnown ? pr?.reviewDecision === 'CHANGES_REQUESTED' ||
        safe.reviews.items.some(r => r.author === null && r.state === 'CHANGES_REQUESTED') ||
        [...latest.values()].some(r => r.state === 'CHANGES_REQUESTED') || safe.threads.items.some(t => !t.resolved) : null,
      externalReviewPending: activityKnown ? pending.length > 0 : null },
    ...(pr ? { headSha: pr.headSha, baseSha: pr.baseSha, createdAt: pr.createdAt, headChangedAt } : {}), evidenceDigest,
    ...(activityKnown && pending.length ? { externalReviewStartedAt: pending.map(r => r.createdAt).sort()[0]! } : {}),
  };
  const retained = options.reviewerDeadline;
  const workflow = retained && retained.startedAt === observation.externalReviewStartedAt && Number.isFinite(retained.until) && retained.until >= Date.parse(retained.startedAt)
    ? { ...pkg.workflow, settings: { ...pkg.workflow.settings, reviewDeadlineSeconds: (retained.until - Date.parse(retained.startedAt)) / 1000 } } : pkg.workflow;
  observation.facts = currentFacts(workflow, observation, now);
  const fixture = parseFixture({ schemaVersion: 1, now, observations: [observation] });
  return { schemaVersion: 1, status: !pr ? 'unavailable' : complete ? 'complete' : 'partial', packageDigest: pkg.digest, evidenceDigest, evidence: safe, fixture };
}
