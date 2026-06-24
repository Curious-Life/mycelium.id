// src/publish/links.js — signed capability links for "unlisted" published docs.
//
// Visibility model (per-doc, owner's choice):
//   public   → anyone can read at /p/<slug>            (published flag)
//   unlisted → only someone holding a SIGNED link can read at /s/<slug>?t=<token>
//   private  → nobody but the owner (never served publicly)
//
// An unlisted link is a capability token signed by the box identity (ed25519):
//   token = base64url(payload) "." base64url(signature-over-that)
//   payload = { slug, nonce, exp }   (exp = unix seconds, 0 = no expiry)
// Only the master-key holder can MINT one (they hold the private key); anyone
// can present it, but it cannot be forged or have its slug/nonce/exp tampered.
//
// `nonce` is the doc's CURRENT capability epoch (documents.publish_nonce). The
// public server verifies signature + expiry + slug-binding AND that the token's
// nonce still matches the doc's current nonce before serving — so revoking a
// link is just rotating/clearing the doc's nonce (unpublish / revokeShareLinks).
// Without this, a leaked link served the private doc forever. Fail-closed.
//
// NOTE: links are bound to the box IDENTITY, which is derived from the master
// key. Rotating the master key changes the identity AND invalidates every
// outstanding link (they can no longer be verified). That is intended.

export const VISIBILITY = Object.freeze(["public", "unlisted", "private"]);

export class LinkError extends Error {
  constructor(message) { super(message); this.name = "LinkError"; }
}

/** True iff `s` is the canonical base64url encoding of its own bytes (no
 * padding, no alt chars, no trailing junk). Rejecting non-canonical encodings
 * closes a token-malleability gap. */
function isCanonicalB64url(s) {
  return typeof s === "string" && s.length > 0 &&
    Buffer.from(s, "base64url").toString("base64url") === s;
}

/**
 * Mint a signed capability token for an unlisted doc.
 * @param {{sign:(s:string)=>string}} identity
 * @param {{slug:string, nonce:string, ttlSec?:number, now?:number}} opts
 *   `nonce` is the doc's current documents.publish_nonce (capability epoch) —
 *   REQUIRED, so a token can never outlive a revocation. Fail-closed.
 * @returns {string} token
 */
export function mintLink(identity, { slug, nonce, ttlSec = 0, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!identity || typeof identity.sign !== "function") throw new LinkError("mintLink: identity with sign() required");
  if (typeof slug !== "string" || slug.length === 0) throw new LinkError("mintLink: slug required");
  if (typeof nonce !== "string" || nonce.length === 0) throw new LinkError("mintLink: nonce (doc publish_nonce) required");
  const exp = ttlSec > 0 ? now + Math.floor(ttlSec) : 0;
  const payloadB64 = Buffer.from(JSON.stringify({ slug, nonce, exp }), "utf8").toString("base64url");
  const sig = identity.sign(payloadB64);
  return `${payloadB64}.${sig}`;
}

/**
 * Verify a capability token. Returns { valid, slug?, nonce?, reason? }. Never throws.
 * Pass the identity (has verify()) OR a verifier fn (data,sig)=>bool.
 * @param {{verify:(d:string,s:string)=>boolean}|((d:string,s:string)=>boolean)} verifier
 * @param {string} token
 * @param {{slug?:string, now?:number}} [opts]  if slug given, must match (binds the token to the requested doc)
 *
 * This proves the token is AUTHENTIC and UNEXPIRED and (optionally) bound to the
 * requested slug. It does NOT check the doc's current state — the caller MUST
 * additionally confirm the returned `nonce` matches the doc's current
 * publish_nonce (see public-server.js). That nonce check is what makes links
 * revocable; verifyLink alone is necessary but not sufficient to serve.
 */
export function verifyLink(verifier, token, { slug = null, now = Math.floor(Date.now() / 1000) } = {}) {
  const verify = typeof verifier === "function" ? verifier : verifier?.verify?.bind(verifier);
  if (typeof verify !== "function") return { valid: false, reason: "no verifier" };
  if (typeof token !== "string" || !token.includes(".")) return { valid: false, reason: "malformed" };

  const dot = token.indexOf(".");
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  if (!payloadB64 || !sigB64) return { valid: false, reason: "malformed" };

  // Reject non-canonical encodings before trusting the bytes (malleability).
  if (!isCanonicalB64url(payloadB64) || !isCanonicalB64url(sigB64)) {
    return { valid: false, reason: "non-canonical encoding" };
  }

  // Signature first — reject forgeries/tampering before trusting any field.
  if (!verify(payloadB64, sigB64)) return { valid: false, reason: "bad signature" };

  let payload;
  try { payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")); }
  catch { return { valid: false, reason: "bad payload" }; }
  if (!payload || typeof payload.slug !== "string") return { valid: false, reason: "bad payload" };
  if (typeof payload.nonce !== "string" || payload.nonce.length === 0) return { valid: false, reason: "bad payload" };

  if (payload.exp && now > payload.exp) return { valid: false, reason: "expired" };
  if (slug !== null && payload.slug !== slug) return { valid: false, reason: "slug mismatch" };

  return { valid: true, slug: payload.slug, nonce: payload.nonce };
}

export default { mintLink, verifyLink, VISIBILITY };
