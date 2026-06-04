// Linear connector adapter. OAuth (confidential, no PKCE) + incremental issue
// pull via GraphQL. normalize() is pure (CI-tested with fixtures); pull()'s HTTP
// is host-verified against the live Linear API. ctx.fetchImpl overrides fetch.

import { PROVIDERS, resolveProviderConfig } from '../providers.js';

const GQL = 'https://api.linear.app/graphql';

const ISSUES_QUERY =
  'query($since:DateTimeOrDuration){issues(first:50,filter:{updatedAt:{gt:$since}},orderBy:updatedAt){nodes{id identifier title description updatedAt url state{name}}}}';

/** Linear issue node → captureMessage args. Pure. */
export function normalize(issue) {
  const title = issue.title || '(untitled issue)';
  const desc = issue.description || '';
  return {
    content: `# ${title}\n\n${desc}`.trim(),
    source: 'linear',
    // Stable id (issue id only) so an edited issue re-syncs as an UPDATE in place
    // via content_hash change-detection (captureMessage), matching Gmail. updatedAt
    // drives the incremental cursor, NOT the id. content is title+description —
    // stable for unchanged issues (no volatile fields) so there is no re-enrich churn.
    id: `linear:${issue.id}`,
    messageType: 'issue',
    createdAt: issue.updatedAt,
    metadata: { connector: 'linear', identifier: issue.identifier, url: issue.url, state: issue.state?.name || null, title },
  };
}

export const linearAdapter = {
  id: 'linear',
  label: 'Linear',
  provider: 'linear',
  oauth: PROVIDERS.linear,
  resolveOAuthConfig: (ctx) => resolveProviderConfig('linear', ctx),
  // Linear OAuth access tokens are long-lived; no refresh flow in V1.

  async pull(ctx, { cursor } = {}) {
    const fetchImpl = ctx.fetchImpl || fetch;
    const access = ctx.tokens?.access_token;
    if (!access) throw new Error('linear: no access token');
    const since = cursor || '1970-01-01T00:00:00.000Z';

    const res = await fetchImpl(GQL, {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: ISSUES_QUERY, variables: { since } }),
    });
    if (!res.ok) throw new Error(`linear query failed (${res.status})`);
    const j = await res.json();
    if (j.errors?.length) throw new Error(`linear graphql error: ${j.errors[0]?.message || 'unknown'}`);

    const nodes = j.data?.issues?.nodes || [];
    const items = nodes.map(normalize);
    let maxUpdated = since;
    for (const n of nodes) if (n.updatedAt > maxUpdated) maxUpdated = n.updatedAt;
    return { items, nextCursor: maxUpdated };
  },
};
