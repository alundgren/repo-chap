globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('/app/installations/123/access_tokens')) return Response.json({ token: 'fictional-installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
  const body = JSON.parse(String(init?.body));
  if (String(url) === 'https://api.github.com/graphql' && body.query?.startsWith('query PollPullRequests')) return Response.json({ data: { repository: {
    id: 'R_paperboat', nameWithOwner: 'reef-labs/paperboat', isPrivate: true, pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  } } });
  throw new Error('The isolated operations fixture rejected an unexpected network request.');
};
