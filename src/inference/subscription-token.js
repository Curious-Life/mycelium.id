// src/inference/subscription-token.js — the ONE definition of "these credentials
// carry a Claude subscription token".
//
// Deliberately a zero-dependency leaf: both the inference resolver and the vault
// IMPORT path need this answer, and the importer must not drag the Claude CLI /
// Keychain modules (resolve.js's own imports) into the ingest path.
//
// WHY IT'S SHARED (this is a security invariant, not a tidy-up): resolve.js decides
// a row is a subscription when a token is present AND (auth_type='oauth' OR the
// vendor is anthropic/claude/claude_subscription) — auth_type is only ONE disjunct
// (resolve.js:128). So a row typed auth_type='api_key' with provider='anthropic'
// and a claudeOAuthToken in `credentials` still resolves as claude_subscription.
// An import filter that keys on auth_type ALONE is therefore bypassable. The
// durable invariant is the credential SHAPE, and both sides must read it the same
// way or the filter silently drifts away from the resolver it is protecting.

/** The token shapes resolve.js will accept, in its order. Kept identical to
 *  mapRowToConfig — `accessToken` and the nested `claudeAiOauth.accessToken` are
 *  older on-disk shapes an earlier build may have stored. */
export function subscriptionTokenFrom(creds) {
  const s = (v) => (typeof v === 'string' && v ? v : null);
  return s(creds?.claudeOAuthToken) || s(creds?.accessToken) || s(creds?.claudeAiOauth?.accessToken);
}

/**
 * Import-side check: do these `credentials` carry ANY subscription material?
 * Broader than subscriptionTokenFrom on purpose — a refreshToken mints access
 * tokens, so it is just as much a credential even though the resolver never
 * reads it directly.
 *
 * ⚠️ ACCEPTS BOTH SHAPES, AND MUST. This used to read `typeof credentials !==
 * 'string' → return false` ("nothing to carry"), which was FAIL-OPEN on the wrong
 * side: a bundle is JSON, so `credentials` arrives as an OBJECT — the natural
 * shape — sails through the check, and is then JSON-stringified into the column by
 * vault-import's normalizeValue (vault-import.js:67), landing as exactly the
 * string the resolver parses back (resolve.js:96 parseCredentials). The refusal
 * ran on the STRING projection while the OBJECT shape was what actually flowed.
 * A caller must never have to pre-serialize to be protected: normalize HERE, at
 * the one shared definition, so the check cannot be bypassed by shape.
 */
export function credentialsCarrySubscriptionMaterial(credentials) {
  if (credentials == null) return false;
  let creds = credentials;
  if (typeof creds === 'string') {
    if (creds.length === 0) return false;
    try { creds = JSON.parse(creds); } catch { return false; }
  }
  if (!creds || typeof creds !== 'object') return false;
  if (subscriptionTokenFrom(creds)) return true;
  return typeof creds.refreshToken === 'string' && creds.refreshToken.length > 0;
}
