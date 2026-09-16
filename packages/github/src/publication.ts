export interface PublicationTarget {
  repository: string; repositoryId: string; pullRequestId: string; number: number;
  headSha: string; baseSha: string;
}
export interface PublishedAnalysis {
  coverage: 'complete' | 'partial'; verdict: 'acceptable' | 'concerns' | 'blocking' | 'inconclusive';
  missingEvidence: string[];
}
export interface ReviewPublication {
  schemaVersion: 1; kind: 'review.publish'; target: PublicationTarget; marker: string;
  body: string; analysis: PublishedAnalysis;
}
export interface LabelPublication {
  schemaVersion: 1; kind: 'labels.set'; target: PublicationTarget; marker: string; labels: string[];
}
export type Publication = ReviewPublication | LabelPublication;
export interface RemotePublicationTarget extends PublicationTarget { lifecycle: 'open' | 'closed'; draft: boolean }
export interface PublishedReview { id: string; url: string; headSha: string; body: string; state: string }
export interface PublicationRemote {
  target(target: PublicationTarget): Promise<RemotePublicationTarget>;
  reviews(target: PublicationTarget): Promise<PublishedReview[]>;
  labels(target: PublicationTarget): Promise<string[]>;
  publishReview(publication: ReviewPublication): Promise<PublishedReview>;
  addLabels(target: PublicationTarget, labels: string[]): Promise<string[]>;
}
export interface PublicationReceipt {
  schemaVersion: 1; kind: Publication['kind']; marker: string;
  outcome: 'confirmed' | 'rejected' | 'unknown'; freshness: 'current' | 'stale' | 'unverified';
  reason: string; expectedHeadSha: string; observedHeadSha: string | null;
  expectedBaseSha: string; observedBaseSha: string | null; reobserve: boolean;
  remote: { id: string; url: string } | null; analysis?: PublishedAnalysis;
  labels?: { requested: string[]; observed: string[]; preserved: string[] };
}
export class PublicationRemoteError extends Error {
  constructor(readonly outcome: 'rejected' | 'unknown', message: string) { super(message); }
}
export interface PublicationDispatch {
  phase: 'planned' | 'unknown';
  authorize(capability: Publication['kind']): Promise<boolean>;
  /** Persist sending and check current effect ownership before allowing a write. */
  beforeSend(): Promise<boolean>;
}
function isCurrent(expected: PublicationTarget, observed: RemotePublicationTarget): boolean {
  return expected.repositoryId === observed.repositoryId && expected.pullRequestId === observed.pullRequestId &&
    expected.repository.toLowerCase() === observed.repository.toLowerCase() && expected.number === observed.number &&
    expected.headSha === observed.headSha && expected.baseSha === observed.baseSha && observed.lifecycle === 'open' && !observed.draft;
}
function receipt(publication: Publication, outcome: PublicationReceipt['outcome'], reason: string,
  observed: RemotePublicationTarget | null, remote: PublishedReview | null = null, labels?: string[]): PublicationReceipt {
  const freshness = observed ? isCurrent(publication.target, observed) ? 'current' : 'stale' : 'unverified';
  return { schemaVersion: 1, kind: publication.kind, marker: publication.marker, outcome, freshness, reason,
    expectedHeadSha: publication.target.headSha, observedHeadSha: observed?.headSha ?? null,
    expectedBaseSha: publication.target.baseSha, observedBaseSha: observed?.baseSha ?? null,
    reobserve: freshness !== 'current', remote: remote ? { id: remote.id, url: remote.url } : null,
    ...(publication.kind === 'review.publish' ? { analysis: publication.analysis } : {
      labels: { requested: publication.labels, observed: labels ?? [], preserved: (labels ?? []).filter(name => !publication.labels.includes(name)) },
    }),
  };
}
async function readAfter(publication: Publication, remote: PublicationRemote): Promise<RemotePublicationTarget | null> {
  try { return await remote.target(publication.target); } catch { return null; }
}
function matchesReview(review: PublishedReview, publication: ReviewPublication): boolean {
  return review.headSha === publication.target.headSha && review.body === publication.body && review.state === 'COMMENTED';
}

export async function publishReview(publication: ReviewPublication, remote: PublicationRemote, dispatch: PublicationDispatch): Promise<PublicationReceipt> {
  let observed: RemotePublicationTarget;
  try {
    observed = await remote.target(publication.target);
    const marked = (await remote.reviews(publication.target)).filter(review => review.body.includes(publication.marker));
    if (marked.length) {
      const match = marked.find(review => matchesReview(review, publication));
      if (!match || marked.some(review => !matchesReview(review, publication)))
        return receipt(publication, 'unknown', 'A publication marker exists with different review content. Inspect the remote reviews before any retry.', observed);
      return receipt(publication, 'confirmed', 'Found the previously published review. No second review was submitted.', await readAfter(publication, remote), match);
    }
  } catch {
    return receipt(publication, dispatch.phase === 'unknown' ? 'unknown' : 'rejected', 'Cannot finish review reconciliation. Refresh GitHub evidence before publication.', null);
  }
  if (dispatch.phase === 'unknown') return receipt(publication, 'unknown', 'The prior review request has an uncertain result and no matching marked review is visible. It will not be sent again.', observed);
  if (!isCurrent(publication.target, observed)) return receipt(publication, 'rejected', 'The PR changed before review publication. Reobserve and analyze the current revision.', observed);
  // Listing reviews can take several requests. Check the PR again next to the write.
  const latest = await readAfter(publication, remote);
  if (!latest || !isCurrent(publication.target, latest)) return receipt(publication, 'rejected', 'Current PR identity could not be confirmed before review publication.', latest);
  observed = latest;
  if (!await dispatch.authorize(publication.kind)) return receipt(publication, 'rejected', 'Apply policy does not authorize review.publish. The validated review remains local.', observed);
  if (!await dispatch.beforeSend()) return receipt(publication, 'rejected', 'Publication ownership changed before the review request.', observed);
  let published: PublishedReview;
  try {
    published = await remote.publishReview(publication);
    if (!matchesReview(published, publication)) throw new PublicationRemoteError('unknown', 'GitHub returned a review that does not match the submitted content.');
  } catch (error) {
    return receipt(publication, error instanceof PublicationRemoteError ? error.outcome : 'unknown',
      error instanceof PublicationRemoteError ? error.message : 'The review request has an uncertain result. Reconcile its marker before any retry.', await readAfter(publication, remote));
  }
  return receipt(publication, 'confirmed', 'Published a comment review attached to the reviewed commit. Human merge is still required.', await readAfter(publication, remote), published);
}

export async function setClassificationLabels(publication: LabelPublication, remote: PublicationRemote, dispatch: PublicationDispatch): Promise<PublicationReceipt> {
  let observed: RemotePublicationTarget, labels: string[];
  try { observed = await remote.target(publication.target); labels = await remote.labels(publication.target); }
  catch { return receipt(publication, dispatch.phase === 'unknown' ? 'unknown' : 'rejected', 'Cannot finish label reconciliation. Refresh GitHub evidence before publication.', null); }
  if (publication.labels.every(name => labels.includes(name))) return receipt(publication, 'confirmed', publication.labels.length
    ? 'All requested labels are already present. This receipt does not attribute existing labels to Repo Chap.'
    : 'The classification contains no labels. Existing labels were preserved.', await readAfter(publication, remote), null, labels);
  if (dispatch.phase === 'unknown') return receipt(publication, 'unknown', 'Some requested labels are absent after an uncertain request. It will not be sent again.', observed, null, labels);
  if (!isCurrent(publication.target, observed)) return receipt(publication, 'rejected', 'The PR changed before label publication. Reobserve and classify the current revision.', observed, null, labels);
  const latest = await readAfter(publication, remote);
  if (!latest || !isCurrent(publication.target, latest)) return receipt(publication, 'rejected', 'Current PR identity could not be confirmed before label publication.', latest, null, labels);
  observed = latest;
  if (!await dispatch.authorize(publication.kind)) return receipt(publication, 'rejected', 'Apply policy does not authorize labels.set. The validated classification remains local.', observed, null, labels);
  if (!await dispatch.beforeSend()) return receipt(publication, 'rejected', 'Publication ownership changed before the label request.', observed, null, labels);
  try {
    labels = await remote.addLabels(publication.target, publication.labels);
    if (!publication.labels.every(name => labels.includes(name))) throw new PublicationRemoteError('unknown', 'GitHub did not confirm every requested label. Reconcile before any retry.');
  } catch (error) {
    return receipt(publication, error instanceof PublicationRemoteError ? error.outcome : 'unknown',
      error instanceof PublicationRemoteError ? error.message : 'The label request has an uncertain result. Reconcile the requested labels before any retry.', await readAfter(publication, remote), null, labels);
  }
  return receipt(publication, 'confirmed', 'Added the configured classification labels and preserved existing labels.', await readAfter(publication, remote), null, labels);
}
