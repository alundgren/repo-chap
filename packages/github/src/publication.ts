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
export interface PublishedReview { id: string; nodeId?: string; url: string; headSha: string; body: string; state: string }
export type BeforePublicationSend = (readTarget: () => Promise<RemotePublicationTarget>) => Promise<boolean>;
export interface PublicationRemote {
  target(target: PublicationTarget): Promise<RemotePublicationTarget>;
  reviews(target: PublicationTarget): Promise<PublishedReview[]>;
  labels(target: PublicationTarget): Promise<string[]>;
  publishReview(publication: ReviewPublication, beforeSend: BeforePublicationSend): Promise<PublishedReview>;
  addLabels(target: PublicationTarget, labels: string[], beforeSend: BeforePublicationSend): Promise<string[]>;
}
export interface PublicationReceipt {
  schemaVersion: 1; kind: Publication['kind']; marker: string;
  outcome: 'confirmed' | 'rejected' | 'unknown'; freshness: 'current' | 'stale' | 'unverified';
  reason: string; expectedHeadSha: string; observedHeadSha: string | null;
  expectedBaseSha: string; observedBaseSha: string | null; reobserve: boolean;
  remote: { id: string; nodeId?: string; url: string } | null; analysis?: PublishedAnalysis;
  labels?: { requested: string[]; observed: string[]; preserved: string[] };
  retryable: boolean; reconcileAfter?: number;
}
export class PublicationRemoteError extends Error {
  constructor(readonly outcome: 'rejected' | 'unknown', message: string, readonly retryable = false) { super(message); }
}
export interface PublicationDispatch {
  phase: 'planned' | 'unknown';
  authorize(capability: Publication['kind']): Promise<boolean>;
  /** Check the already persisted effect lease after credential retrieval. */
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
    reobserve: freshness !== 'current', retryable: false, remote: remote ? { id: remote.id, ...(remote.nodeId ? { nodeId: remote.nodeId } : {}), url: remote.url } : null,
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
async function authorizeSend(publication: Publication, readTarget: () => Promise<RemotePublicationTarget>, dispatch: PublicationDispatch): Promise<boolean> {
  let observed: RemotePublicationTarget;
  try { observed = await readTarget(); }
  catch { throw new PublicationRemoteError('rejected', 'The final PR read failed before publication. Retry the retained publication after refreshing access.', true); }
  if (!isCurrent(publication.target, observed)) throw new PublicationRemoteError('rejected', 'The PR changed before publication. Reobserve and analyze the current revision.');
  try {
    if (!await dispatch.authorize(publication.kind)) throw new PublicationRemoteError('rejected', `Apply policy does not authorize ${publication.kind}. Retry the retained analysis after restoring permission.`, true);
    if (!await dispatch.beforeSend()) throw new PublicationRemoteError('rejected', 'Publication permission or ownership changed before the request.', true);
  } catch (error) {
    if (error instanceof PublicationRemoteError) throw error;
    throw new PublicationRemoteError('rejected', 'Current authorization could not be checked before publication. Retry the retained result after checking private settings.', true);
  }
  return true;
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
    return { ...receipt(publication, dispatch.phase === 'unknown' ? 'unknown' : 'rejected', 'Cannot finish review reconciliation. Refresh GitHub evidence before publication.', null), retryable: dispatch.phase === 'planned' };
  }
  if (dispatch.phase === 'unknown') return receipt(publication, 'unknown', 'The prior review request has an uncertain result and no matching marked review is visible. It will not be sent again.', observed);
  if (!isCurrent(publication.target, observed)) return receipt(publication, 'rejected', 'The PR changed before review publication. Reobserve and analyze the current revision.', observed);
  let published: PublishedReview;
  try {
    published = await remote.publishReview(publication, readTarget => authorizeSend(publication, readTarget, dispatch));
    if (!matchesReview(published, publication)) throw new PublicationRemoteError('unknown', 'GitHub returned a review that does not match the submitted content.');
  } catch (error) {
    return { ...receipt(publication, error instanceof PublicationRemoteError ? error.outcome : 'unknown',
      error instanceof PublicationRemoteError ? error.message : 'The review request has an uncertain result. Reconcile its marker before any retry.', await readAfter(publication, remote)),
      retryable: error instanceof PublicationRemoteError && error.retryable };
  }
  return receipt(publication, 'confirmed', 'Published a comment review attached to the reviewed commit. Human merge is still required.', await readAfter(publication, remote), published);
}

export async function setClassificationLabels(publication: LabelPublication, remote: PublicationRemote, dispatch: PublicationDispatch): Promise<PublicationReceipt> {
  let observed: RemotePublicationTarget, labels: string[];
  try { observed = await remote.target(publication.target); labels = await remote.labels(publication.target); }
  catch { return { ...receipt(publication, dispatch.phase === 'unknown' ? 'unknown' : 'rejected', 'Cannot finish label reconciliation. Refresh GitHub evidence before publication.', null), retryable: dispatch.phase === 'planned' }; }
  if (publication.labels.every(name => labels.includes(name))) return receipt(publication, 'confirmed', publication.labels.length
    ? 'All requested labels are already present. This receipt does not attribute existing labels to Repo Chap.'
    : 'The classification contains no labels. Existing labels were preserved.', await readAfter(publication, remote), null, labels);
  if (dispatch.phase === 'unknown') return receipt(publication, 'unknown', 'Some requested labels are absent after an uncertain request. It will not be sent again.', observed, null, labels);
  if (!isCurrent(publication.target, observed)) return receipt(publication, 'rejected', 'The PR changed before label publication. Reobserve and classify the current revision.', observed, null, labels);
  try {
    labels = await remote.addLabels(publication.target, publication.labels, readTarget => authorizeSend(publication, readTarget, dispatch));
    if (!publication.labels.every(name => labels.includes(name))) throw new PublicationRemoteError('unknown', 'GitHub did not confirm every requested label. Reconcile before any retry.');
  } catch (error) {
    return { ...receipt(publication, error instanceof PublicationRemoteError ? error.outcome : 'unknown',
      error instanceof PublicationRemoteError ? error.message : 'The label request has an uncertain result. Reconcile the requested labels before any retry.', await readAfter(publication, remote), null, labels),
      retryable: error instanceof PublicationRemoteError && error.retryable };
  }
  return receipt(publication, 'confirmed', 'Added the configured classification labels and preserved existing labels.', await readAfter(publication, remote), null, labels);
}
