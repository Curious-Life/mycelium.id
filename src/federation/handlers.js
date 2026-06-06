// src/federation/handlers.js — framework-agnostic Tier-0 federation handlers.
//
// Pure logic (no express): each handler returns { status, body }. The thin
// express wrapper (router.js) and the verify gate both call these, so the
// protocol is unit-tested independently of the web framework.
//
// Signature model: the sender signs canonicalize(requestBody) and sends those
// exact bytes. By the time express.json() has parsed the POST the raw bytes are
// gone — so we verify over canonicalize(parsedPayload), which deterministically
// reproduces the signed bytes (canonicalize sorts keys recursively). Key
// reordering in transit still verifies (same logical message); any value change
// breaks the signature. Fail closed throughout.

import { buildDidDocument, buildWebfinger, resolveDidKey, didWebHost } from './did.js';
import { canonicalize, verifyDetached } from './sign.js';

const MAX_CANONICAL_BYTES = 8 * 1024;     // body cap (DoS)
const TS_WINDOW_MS = 5 * 60 * 1000;       // ±5 min freshness window
const RATE_MAX = 30;                       // inbound connects per IP per window
const RATE_WINDOW_MS = 60 * 1000;

/**
 * @param {object} deps
 * @param {object} deps.db                 the live db (uses db.connections.receiveRemote)
 * @param {string} deps.userId             the local vault user (connection recipient)
 * @param {object} deps.identity           the box identity (publicKeyB64)
 * @param {()=>string} deps.getHost        current public host ("" when unset → fail closed)
 * @param {()=>(string|null)} deps.getHandle current handle (null when unset)
 * @param {Function} [deps.fetch]          injected for did resolution / tests
 * @param {()=>number} [deps.now]          injectable clock for tests
 */
export function createFederationHandlers({ db, userId = 'local-user', identity, getHost, getHandle, fetch = globalThis.fetch, now = () => Date.now() }) {
  const seenNonces = new Map(); // nonce -> expiry ms
  const rate = new Map();       // ip -> { n, resetAt }

  function rateLimited(ip) {
    const key = ip || '?';
    const rec = rate.get(key);
    if (!rec || now() > rec.resetAt) { rate.set(key, { n: 1, resetAt: now() + RATE_WINDOW_MS }); return false; }
    rec.n += 1;
    return rec.n > RATE_MAX;
  }
  function noncePrune() {
    const t = now();
    for (const [k, exp] of seenNonces) if (exp < t) seenNonces.delete(k);
  }

  // Verify a signed inbound federation envelope. Returns { ok:true, did } when
  // valid, or { ok:false, status, body }. Marks the nonce on success. Shared by
  // /connect and /connect-response (identical trust model).
  async function verify({ payload, headers = {}, ip }) {
    if (!getHost() || !identity?.publicKeyB64) return { ok: false, status: 503, body: { error: 'federation not configured' } };
    if (rateLimited(ip)) return { ok: false, status: 429, body: { error: 'rate limited' } };
    if (!payload || typeof payload !== 'object') return { ok: false, status: 400, body: { error: 'invalid body' } };

    const did = headers['x-myc-did'];
    const sig = headers['x-myc-sig'];
    if (!did || !sig) return { ok: false, status: 401, body: { error: 'unsigned request' } };

    const canonical = canonicalize(payload);
    if (canonical.length > MAX_CANONICAL_BYTES) return { ok: false, status: 400, body: { error: 'body too large' } };

    const ts = Number(payload.ts);
    if (!Number.isFinite(ts) || Math.abs(now() - ts) > TS_WINDOW_MS) return { ok: false, status: 401, body: { error: 'stale or missing timestamp' } };
    noncePrune();
    if (!payload.nonce || seenNonces.has(payload.nonce)) return { ok: false, status: 401, body: { error: 'replay or missing nonce' } };
    if (payload.from_did && payload.from_did !== did) return { ok: false, status: 401, body: { error: 'did mismatch' } };

    let pub;
    try { pub = await resolveDidKey(did, { fetch }); } catch { return { ok: false, status: 401, body: { error: 'unresolvable did' } }; }
    if (!verifyDetached(pub, canonical, sig)) return { ok: false, status: 401, body: { error: 'signature verification failed' } };

    seenNonces.set(payload.nonce, now() + TS_WINDOW_MS);
    return { ok: true, did };
  }

  return {
    didJson() {
      const doc = buildDidDocument(getHost(), identity?.publicKeyB64);
      return doc ? { status: 200, body: doc } : { status: 404, body: { error: 'no public identity' } };
    },

    webfinger(resource) {
      const wf = buildWebfinger(getHost(), getHandle(), resource);
      return wf ? { status: 200, body: wf } : { status: 404, body: { error: 'not found' } };
    },

    /** Inbound connect request. @param {{payload:object, headers:object, ip?:string}} */
    async connect({ payload, headers = {}, ip } = {}) {
      const v = await verify({ payload, headers, ip });
      if (!v.ok) return { status: v.status, body: v.body };
      if (payload.$type !== 'social.mycelium.connect-request.v1') return { status: 400, body: { error: 'unexpected $type' } };
      try {
        await db.connections.receiveRemote({
          fromHandle: payload.from_handle,
          // displayed instance bound to the verified signer host, not the claim
          verifiedHost: didWebHost(v.did),
          fromDid: v.did,
          profile: payload.profile || {},
          toUserId: userId,
        });
      } catch (e) {
        return { status: 400, body: { error: e.message } };
      }
      return { status: 202, body: { accepted: true, verified: true } };
    },

    /** Inbound connect RESPONSE (the peer accepted our request). Same trust model. */
    async connectResponse({ payload, headers = {}, ip } = {}) {
      const v = await verify({ payload, headers, ip });
      if (!v.ok) return { status: v.status, body: v.body };
      if (payload.$type !== 'social.mycelium.connect-response.v1') return { status: 400, body: { error: 'unexpected $type' } };
      try {
        await db.connections.receiveResponse({
          fromHandle: payload.from_handle,
          // The acceptance is bound to the VERIFIED signer's did:web host — not
          // the payload's claimed from_instance — so a signed-but-unrelated peer
          // can't flip another instance's pending row to accepted.
          verifiedHost: didWebHost(v.did),
          fromDid: v.did,
          profile: payload.profile || {},
          action: payload.action,
          toUserId: userId,
        });
      } catch (e) {
        return { status: 400, body: { error: e.message } };
      }
      return { status: 202, body: { accepted: true, verified: true } };
    },
  };
}
