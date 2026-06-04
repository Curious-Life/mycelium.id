// src/gateway/static-bearer.js — the §3b opt-in static bearer (S4/S8 auth).
//
// A copy-pasteable token accepted on the Bearer-guarded :4711 surface (/mcp AND
// the /v1 gateway) IN ADDITION to the OAuth path, so a purely-local harness
// (opencode / Codex / Goose / Cline / Continue / OpenHands) or a 2.0-only client
// can connect without running the full OAuth dance.
//
// SECURITY — fail-closed by construction:
//   • OFF unless MYCELIUM_MCP_BEARER is set → the default posture is OAuth-only
//     and unchanged. The operator opts in explicitly.
//   • Length floor (MIN_BEARER_LEN): a too-short / accidental token is ignored
//     (treated as "not configured") so a weak token can't become a footgun.
//   • Constant-time comparison (timingSafeEqual) — no char-by-char timing leak.
//   • The token is NEVER logged and never appears in an error/response.
//   • This is the ONLY place the static-bearer decision lives, so the auth-bypass
//     path is auditable in one ~30-line file.
//
// Generate a token with e.g.  `openssl rand -hex 32`  (64 hex chars).

import { timingSafeEqual } from 'node:crypto';

// A configured token must be at least this long to be honored. 24 chars admits a
// 16-byte hex token (32 chars) or a 12-byte base64url token; rejects trivially
// guessable strings set by mistake.
export const MIN_BEARER_LEN = 24;

/**
 * The configured static bearer, or null when not configured / too short.
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {string|null}
 */
export function configuredStaticBearer(env = process.env) {
  const t = env?.MYCELIUM_MCP_BEARER;
  return typeof t === 'string' && t.length >= MIN_BEARER_LEN ? t : null;
}

/**
 * Does the request's Authorization header present the configured static bearer?
 * Fail-closed: false when the env var is unset/short, when there's no Bearer
 * header, or on any mismatch. Constant-time for equal-length candidates.
 * @param {string|undefined} authHeader  the raw `Authorization` header value
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {boolean}
 */
export function matchStaticBearer(authHeader, env = process.env) {
  const expected = configuredStaticBearer(env);
  if (!expected) return false;                       // not configured → fail closed
  if (typeof authHeader !== 'string') return false;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!m) return false;
  const presented = Buffer.from(m[1]);
  const want = Buffer.from(expected);
  // timingSafeEqual throws on unequal lengths; a length mismatch is an immediate
  // (and not secret-leaking) reject.
  if (presented.length !== want.length) return false;
  try { return timingSafeEqual(presented, want); } catch { return false; }
}

export default matchStaticBearer;
