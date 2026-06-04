// Connector adapter registry.
//
// An adapter is a plain object describing how to sync one external source:
//   {
//     id: 'gmail',                  // stable id (used in routes + secret keys)
//     label: 'Gmail',
//     provider: 'google',
//     oauth: { ... } | null,        // null = non-OAuth (e.g. the mock/test adapter)
//     async pull(ctx, { cursor }) -> { items, nextCursor },  // items = captureMessage args
//     resolveOAuthConfig?(ctx) -> { authUrl, tokenUrl, clientId, clientSecret?, scopes, redirectUri, usePKCE },
//     ensureFreshToken?(tokens, ctx) -> tokens,   // refresh near-expiry tokens
//     revoke?(tokens) -> void,                     // best-effort on disconnect
//   }
//
// ctx passed to pull/ensureFreshToken: { db, userId, tokens, store }.

const adapters = new Map();

export function registerAdapter(adapter) {
  if (!adapter || typeof adapter.id !== 'string' || !adapter.id) {
    throw new TypeError('registerAdapter: adapter.id required');
  }
  if (typeof adapter.pull !== 'function') {
    throw new TypeError(`registerAdapter(${adapter.id}): pull() required`);
  }
  adapters.set(adapter.id, adapter);
  return adapter;
}

export function getAdapter(id) {
  return adapters.get(id) || null;
}

export function listAdapters() {
  return [...adapters.values()];
}

/** Test-only: clear the registry between verify runs. */
export function _resetRegistry() {
  adapters.clear();
}
