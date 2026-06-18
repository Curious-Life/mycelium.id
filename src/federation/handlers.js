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
const MAX_SHARED_CONTENT_BYTES = 1024 * 1024; // cap an OUTBOUND shared-content response

// §7 tripwire (mirror of db/connections.js): never let an embedding/vector field
// leave the box, even via a future regression on the shared-content serve path.
function hasVectorKey(o) {
  return o && typeof o === 'object'
    && Object.keys(o).some((k) => /centroid|embedding|vector/i.test(k) || hasVectorKey(o[k]));
}
const TS_WINDOW_MS = 5 * 60 * 1000;       // ±5 min freshness window
const RATE_MAX = 30;                       // inbound connects per peer per window
const RATE_MAX_GLOBAL = 120;               // backstop: total inbound connects per window (any peer)
const RATE_WINDOW_MS = 60 * 1000;

/**
 * @param {object} deps
 * @param {object} deps.db                 the live db (uses db.connections.receiveRemote)
 * @param {string} deps.userId             the local vault user (connection recipient)
 * @param {object} deps.identity           the box identity (publicKeyB64)
 * @param {()=>string} deps.getHost        current public host ("" when unset → fail closed)
 * @param {()=>(string|null)} deps.getHandle current handle (null when unset)
 * @param {()=>(string|null)} [deps.getMatrixId] current box MXID for the #matrix
 *   service in did.json (null when Matrix unconfigured → no #matrix advertised).
 *   Read per-request like getHost/getHandle so a homeserver configured after boot
 *   is picked up without a restart.
 * @param {Function} [deps.fetch]          injected for did resolution / tests
 * @param {()=>number} [deps.now]          injectable clock for tests
 */
export function createFederationHandlers({ db, userId = 'local-user', identity, getHost, getHandle, getMatrixId = () => null, getPresenceConfig = () => ({}), getLastActiveAt = async () => null, fetch = globalThis.fetch, lookup, now = () => Date.now() }) {
  const seenNonces = new Map(); // nonce -> expiry ms
  const rate = new Map();       // peer-ip -> { n, resetAt }
  let globalRate = { n: 0, resetAt: 0 }; // backstop across ALL peers (M-FED-RL)

  // `ip` is the real socket peer (router keys on req.socket.remoteAddress, NOT a
  // client-spoofable X-Forwarded-For). The global backstop catches the case where
  // the peer is a shared tunnel/proxy (all traffic collapses to one key) or where
  // an attacker could still rotate the per-key value.
  function rateLimited(ip) {
    const t = now();
    if (t > globalRate.resetAt) globalRate = { n: 1, resetAt: t + RATE_WINDOW_MS };
    else if (++globalRate.n > RATE_MAX_GLOBAL) return true;
    const key = ip || '?';
    const rec = rate.get(key);
    if (!rec || t > rec.resetAt) { rate.set(key, { n: 1, resetAt: t + RATE_WINDOW_MS }); return false; }
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
    try { pub = await resolveDidKey(did, { fetch, lookup }); } catch { return { ok: false, status: 401, body: { error: 'unresolvable did' } }; }
    if (!verifyDetached(pub, canonical, sig)) return { ok: false, status: 401, body: { error: 'signature verification failed' } };

    seenNonces.set(payload.nonce, now() + TS_WINDOW_MS);
    return { ok: true, did };
  }

  return {
    didJson() {
      const doc = buildDidDocument(getHost(), identity?.publicKeyB64, getMatrixId() || undefined);
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

    /**
     * Inbound DIRECT MESSAGE from a connected peer (federation Tier-0c). Same
     * fail-closed did:web verify gate as /connect — and receiveMessage ADDS an
     * authorization check: a valid signature is not enough, the peer must be an
     * ACCEPTED connection. Replay/dedup handled by verify()'s nonce set + the
     * UNIQUE(connection_id, remote_nonce) index. Content never logged.
     */
    async message({ payload, headers = {}, ip } = {}) {
      const v = await verify({ payload, headers, ip });
      if (!v.ok) return { status: v.status, body: v.body };
      if (payload.$type !== 'social.mycelium.message.v1') return { status: 400, body: { error: 'unexpected $type' } };
      try {
        const id = await db.connections.receiveMessage({
          fromDid: v.did,
          verifiedHost: didWebHost(v.did),
          content: payload.content,
          nonce: payload.nonce,
          toUserId: userId,
        });
        return { status: 202, body: { accepted: true, id } };
      } catch (e) {
        // Signed but not a connection → 403 (authenticated, unauthorized).
        const status = /no accepted connection/.test(e.message) ? 403 : 400;
        return { status, body: { error: e.message } };
      }
    },

    /**
     * Inbound SHARE ANNOUNCE from a connected peer (federation Tier-0d). The peer
     * is telling us they granted (or revoked) us access to one of THEIR spaces/
     * contexts. Same fail-closed verify gate; must come from an ACCEPTED connection
     * (matched on the VERIFIED did, never payload claims). We only RECORD the
     * announcement — the content is fetched on demand later (grant-gated on their
     * side). The label is the only sensitive field; it is encrypted at rest.
     */
    async share({ payload, headers = {}, ip } = {}) {
      const v = await verify({ payload, headers, ip });
      if (!v.ok) return { status: v.status, body: v.body };
      if (payload.$type !== 'social.mycelium.share.v1') return { status: 400, body: { error: 'unexpected $type' } };
      const kind = payload.kind === 'context' ? 'context' : payload.kind === 'space' ? 'space' : null;
      if (!kind || !payload.ref) return { status: 400, body: { error: 'invalid share' } };
      try {
        const connId = await db.connections.findAcceptedByPeer({ fromDid: v.did, verifiedHost: didWebHost(v.did), toUserId: userId });
        if (!connId) return { status: 403, body: { error: 'no accepted connection from this peer' } };
        const ref = String(payload.ref).slice(0, 200);
        const name = typeof payload.name === 'string' ? payload.name.slice(0, 200) : null;
        const role = ['member', 'contributor'].includes(payload.role) ? payload.role : null;
        if (payload.action === 'revoke') {
          await db.inboundShares.revoke({ connectionId: connId, kind, remoteRef: ref });
        } else {
          await db.inboundShares.upsert({ connectionId: connId, peerDid: v.did, kind, remoteRef: ref, name, role, grantedAt: new Date(Number(payload.ts) || Date.now()).toISOString() });
        }
        return { status: 202, body: { accepted: true } };
      } catch (e) {
        return { status: 400, body: { error: e.message } };
      }
    },

    /**
     * SERVE shared content to a verified peer (federation Tier-0e) — the security
     * core. Fail-closed at every step:
     *   1. verify() the requester's signature (gate).
     *   2. resolveSharedGrant: a LIVE grant must exist for this peer + ref, else 403
     *      (revocation is honored on every request; private contexts never serve).
     *   3. assemble a VECTOR-FREE payload (explicit columns; getForShare excludes
     *      embedding_768) + hasVectorKey tripwire before serialization (§7).
     *   4. size-cap + audit (counts only, never content).
     *   5. SIGN the response body so the peer can prove it came from us (no MITM).
     * Returns { status, signedBody, sig, did } — the router emits the signature
     * headers + the raw signed bytes.
     */
    async sharedContent({ payload, headers = {}, ip } = {}) {
      const v = await verify({ payload, headers, ip });
      if (!v.ok) return { status: v.status, body: v.body };
      if (payload.$type !== 'social.mycelium.shared-content.v1') return { status: 400, body: { error: 'unexpected $type' } };
      const kind = payload.kind === 'context' ? 'context' : payload.kind === 'space' ? 'space' : null;
      if (!kind || !payload.ref) return { status: 400, body: { error: 'invalid request' } };
      try {
        const grant = await db.connections.resolveSharedGrant({ fromDid: v.did, verifiedHost: didWebHost(v.did), toUserId: userId, kind, ref: payload.ref });
        if (!grant.granted) return { status: 403, body: { error: 'not shared with you' } };

        let content;
        if (kind === 'space') {
          const knowledge = (await db.spaceKnowledge.list(payload.ref).catch(() => [])).slice(0, 200)
            .map((k) => ({ content: k.content, source_type: k.source_type, created_at: k.created_at }));
          const documents = (await db.spaceRoomDocuments.listAtRoot(payload.ref, userId).catch(() => [])).slice(0, 200)
            .map((d) => ({ path: d.path, title: d.title, summary: d.summary }));
          const sp = await db.spaces.get(payload.ref).catch(() => null);
          content = { kind, name: sp?.name || sp?.display_name || null, knowledge, documents };
        } else {
          const territories = (await db.contexts.getTerritories(payload.ref).catch(() => [])).slice(0, 500)
            .map((t) => ({ territory_id: t.territory_id, name: t.name, essence: t.essence, realm_id: t.realm_id }));
          content = { kind, territories };
        }
        // §7: refuse to serve if any vector/embedding field slipped into the payload.
        if (hasVectorKey(content)) return { status: 500, body: { error: 'refusing to serve a vector field' } };

        const canon = canonicalize(content);
        if (canon.length > MAX_SHARED_CONTENT_BYTES) return { status: 413, body: { error: 'shared content too large' } };

        db.audit?.log?.({
          action: 'federation_shared_content_served', userId, ip,
          resourceType: kind, resourceId: String(payload.ref),
          details: { peer: didWebHost(v.did), docs: content.documents?.length ?? 0, knowledge: content.knowledge?.length ?? 0, territories: content.territories?.length ?? 0 },
        })?.catch?.(() => {});

        // Sign the EXACT bytes we send so the peer verifies authenticity.
        return { status: 200, signedBody: canon, sig: identity.sign(canon), did: `did:web:${getHost()}` };
      } catch (e) {
        return { status: 400, body: { error: e.message } };
      }
    },

    /**
     * Presence query from a connected peer — answers online/offline/hidden for the
     * connection online-status dot. Same fail-closed did:web verify gate. Returns
     * `hidden` IDENTICALLY for not-a-connection, a revoked share, or a global pause
     * (no oracle separating them). `online` only when the peer is an ACCEPTED
     * connection that we still share with AND a Mycelium client was active within the
     * window. The reply is SIGNED (no forged "online") and ECHOES the request nonce
     * (no stale-reply replay). Audit records host + state only — never the timestamp.
     */
    async presence({ payload, headers = {}, ip } = {}) {
      const v = await verify({ payload, headers, ip });
      if (!v.ok) return { status: v.status, body: v.body };
      if (payload.$type !== 'social.mycelium.presence-query.v1') return { status: 400, body: { error: 'unexpected $type' } };
      let state = 'hidden';
      try {
        const peer = await db.connections.presenceShareForPeer({ fromDid: v.did, verifiedHost: didWebHost(v.did), toUserId: userId });
        const cfg = getPresenceConfig() || {};
        if (peer && peer.share && !cfg.paused) {
          const last = await getLastActiveAt();
          const windowMs = (Number(cfg.activeWindowMin) > 0 ? Number(cfg.activeWindowMin) : 5) * 60 * 1000;
          // SQLite datetime('now') is UTC without a 'Z' — parse as UTC.
          const lastMs = last ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(last) ? last : last.replace(' ', 'T') + 'Z') : NaN;
          state = Number.isFinite(lastMs) && (now() - lastMs) < windowMs ? 'online' : 'offline';
        }
      } catch {
        state = 'hidden'; // fail closed — any error reveals nothing
      }
      const body = { state, nonce: payload.nonce, ts: now() };
      const canon = canonicalize(body);
      db.audit?.log?.({ action: 'presence_served', userId, ip, details: { peer: didWebHost(v.did), state } })?.catch?.(() => {});
      return { status: 200, signedBody: canon, sig: identity.sign(canon), did: `did:web:${getHost()}` };
    },
  };
}
