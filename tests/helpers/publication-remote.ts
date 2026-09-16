import assert from 'node:assert/strict';
import type { Inspection } from '@repo-chap/github';
import { remote } from './daemon-remote.ts';

export interface PublicationState {
  reviews: { id: number; html_url: string; commit_id: string; body: string; state: string }[];
  labels: string[]; writes: number; loseResponse: boolean; accept: boolean; failAfterWrite: boolean;
}
export const publicationState = (): PublicationState => ({ reviews: [], labels: ['human-choice', 'auth'], writes: 0, loseResponse: false, accept: true, failAfterWrite: false });
export function publicationRemote(inspection: Inspection, state = publicationState(), onWrite?: () => void) {
  const graph = remote(inspection), calls: { method: string; path: string }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? 'GET'; calls.push({ method, path });
    if (path === '/graphql') return graph.fetch(url, init);
    const pr = inspection.evidence.pullRequest!, repository = inspection.evidence.repository!;
    if (method === 'GET') {
      if (state.failAfterWrite && state.writes) throw new Error('Fictional unavailable follow-up read.');
      if (path.endsWith(`/pulls/${pr.number}`)) return Response.json({ node_id: pr.id, number: pr.number, state: pr.lifecycle, draft: pr.draft,
        head: { sha: pr.headSha }, base: { sha: pr.baseSha, repo: { node_id: repository.id, full_name: repository.name } } });
      if (path.endsWith('/reviews')) return Response.json(state.reviews);
      if (path.endsWith('/labels')) return Response.json(state.labels.map(name => ({ name })));
    }
    assert.equal(method, 'POST'); state.writes++;
    const body = JSON.parse(String(init?.body)); let result: unknown;
    if (path.endsWith('/reviews')) {
      assert.equal(body.event, 'COMMENT'); assert.equal(body.commit_id, pr.headSha);
      result = { id: state.writes, html_url: `${pr.url}#pullrequestreview-${state.writes}`, commit_id: body.commit_id, body: body.body, state: 'COMMENTED' };
      if (state.accept) state.reviews.push(result as PublicationState['reviews'][number]);
    } else {
      assert.ok(path.endsWith('/labels'));
      if (state.accept) state.labels = [...new Set([...state.labels, ...body.labels])];
      result = state.labels.map(name => ({ name }));
    }
    onWrite?.();
    if (state.loseResponse) throw new Error('Fictional lost response.');
    return Response.json(result);
  };
  return { fetch, calls, state, graph };
}
