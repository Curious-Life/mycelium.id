/**
 * Connections namespace — the social graph. Each row in `connections`
 * is a canonical pair (user_a < user_b) with a status lifecycle:
 *
 *   pending → accepted     (normal flow)
 *   pending → rejected     (permits re-request later)
 *   pending → blocked      (silent — future requests look like "user not found")
 *   accepted → (deleted)   (via disconnect)
 *
 * `_canonical(a, b)` enforces the (user_a < user_b) invariant so
 * the uniqueness check on `(user_a, user_b)` works regardless of
 * who initiated.
 *
 * ─── Federation & SSRF surface ─────────────────────────────────────
 *
 * `request(fromUserId, 'alice@example.com')` federates: the handle
 * is parsed against `^([a-z0-9][a-z0-9_]{2,29})@(.+)$`, WebFinger is
 * queried at `https://<domain>/.well-known/webfinger?resource=acct:...`,
 * and we POST the connect-request payload to the `federation` link.
 *
 * SSRF defenses:
 *   1. Domain must match `^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`
 *      — no scheme, no port, no IP literals, no underscores.
 *   2. WebFinger URL is HTTPS-only and built by string concat, not
 *      arbitrary user input.
 *   3. `redirect: 'manual'` on the WebFinger fetch — we refuse to
 *      follow 3xx (an attacker who controls a domain couldn't bounce
 *      us to an internal address).
 *   4. 5-second abort timeout on WebFinger, 10-second on the POST.
 *
 * Silent-block semantics: when status is 'blocked', `request` throws
 * "User not found" (the same error as a truly missing user) so the
 * blocker is indistinguishable from a non-existent handle.
 *
 * Pending-requests cap: a user can have at most 20 outbound pending
 * connection requests at any time (prevents handle-enumeration
 * spam).
 *
 * ─── Authorization ──────────────────────────────────────────────────
 *
 * accept/reject/block/disconnect all re-load the row and require
 * that the caller is user_a or user_b. `accept` additionally refuses
 * when the initiator is the caller (can't accept your own request).
 *
 * @typedef {object} ConnectionsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {() => string} workerUrl — current MYA_WORKER_URL
 * @property {() => string} workerAuth — bearer token for handle-resolve calls
 * @property {() => string} [randomUUID] — test seam; defaults to node:crypto.randomUUID
 * @property {(url: string, init?: any) => Promise<any>} [fetch] — test seam; defaults to globalThis.fetch
 */

import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { canonicalize, verifyDetached } from '../federation/sign.js';
import { resolveDidKey } from '../federation/did.js';
import { safeFetch } from '../federation/ssrf.js';

const SHARED_CONTENT_MAX_BYTES = 1024 * 1024; // cap an inbound shared-content response (DoS)

// Recursive key tripwire (CLAUDE.md §7): never let an embedding/vector field
// leave the box, even via a future regression that adds one to the profile.
function hasVectorKey(o) {
  return o && typeof o === 'object'
    && Object.keys(o).some((k) => /centroid|embedding|vector/i.test(k) || hasVectorKey(o[k]));
}

// Federated handle = <local>@<domain>. The local part must accept every handle
// the managed control plane can ISSUE (2–32 chars, lowercase alnum + hyphen,
// e.g. "hi", "lo", "my-handle"). The old `[a-z0-9][a-z0-9_]{2,29}` required ≥3
// chars and no hyphen, so a 2-char handle fell through to the local lookup and
// surfaced as "User not found" — neither box could federate to the other. The
// domain side + WebFinger + did:web verification are the real gates, so this
// stays deliberately permissive (2–64 chars, alnum + hyphen/underscore).
const HANDLE_LOCAL_PART_RE = /^([a-z0-9][a-z0-9_-]{1,62})@(.+)$/i;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

const PENDING_LIMIT = 20;
const MAX_MESSAGE_CHARS = 4000; // peer-message body cap (well under the 8KB canonical envelope cap)
const WEBFINGER_TIMEOUT_MS = 5000;
const FEDERATION_POST_TIMEOUT_MS = 10000;
const RESOLVE_HANDLE_TIMEOUT_MS = 5000;
const OVERLAP_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const PRESENCE_QUERY_TIMEOUT_MS = 3000;          // short per-peer timeout: a slow peer just shows last-known/offline
const PRESENCE_RESULT_TTL_MS = 45 * 1000;        // memoize the whole presence map (UI polls ~30s)
const PRESENCE_ENDPOINT_TTL_MS = 60 * 60 * 1000; // cache the resolved federation endpoint (skip WebFinger every poll)
const PRESENCE_CONCURRENCY = 6;                  // cap concurrent outbound presence queries

export function createConnectionsNamespace(deps) {
  if (!deps) throw new TypeError('createConnectionsNamespace: deps required');
  const {
    d1Query,
    // Multi-tenant Worker deps — OPTIONAL in single-user V1. When absent, the
    // cross-tenant local-handle resolve is skipped (only the @handle@domain
    // federation path is live), and from_instance falls back to selfInstance().
    workerUrl, workerAuth,
    // Federation (Tier-0) deps — OPTIONAL. When sign+did are present the outbound
    // connect-request is signed (X-Myc-Did/X-Myc-Sig over the canonical body);
    // selfInstance() is our own public host for the request's from_instance.
    sign, did, selfInstance,
    randomUUID = nodeRandomUUID,
    fetch: fetchImpl = globalThis.fetch,
    lookup, // injectable DNS resolver — threaded into safeFetch (tests inject a stub)
  } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createConnectionsNamespace: d1Query required');

  // Presence caches (per-process, transient — no presence state at rest, by design).
  // _presenceResult: the last computed { map, at } so the UI's ~30s poll reuses it.
  // _presenceEndpoint: connId -> { endpoint, at } so we don't WebFinger every poll.
  // _presenceLastShared: connId -> bool, last-known "this peer shares with me" — lets
  //   an unreachable-but-known-shared peer render grey instead of vanishing.
  let _presenceResult = { map: {}, at: 0 };
  const _presenceEndpoint = new Map();
  const _presenceLastShared = new Map();

  function canonical(a, b) {
    return a < b ? { user_a: a, user_b: b } : { user_a: b, user_b: a };
  }

  // Our FEDERATION handle = the first label of our public host (what WebFinger +
  // did:web publish, e.g. "hi" for hi.mycelium.id). This is the handle a peer
  // MUST use to resolve us back (acct:<handle>@<host>) — NOT user_profiles.handle,
  // which is a human label that can differ ("martin") and 404s WebFinger. Outbound
  // from_handle uses this so the reverse handshake (connect-response) can find us.
  function selfHandle() {
    const h = selfInstance && selfInstance();
    return h ? String(h).split('.')[0] : null;
  }

  async function loadConnection(connectionId, { requireStatus } = {}) {
    let sql = `SELECT * FROM connections WHERE id = ?`;
    const params = [connectionId];
    if (requireStatus) {
      sql += ` AND status = ?`;
      params.push(requireStatus);
    }
    const result = await d1Query(sql, params);
    return result.results?.[0] || null;
  }

  function assertMember(row, userId) {
    if (row.user_a !== userId && row.user_b !== userId) throw new Error('Not authorized');
  }

  async function pendingCount(fromUserId) {
    const result = await d1Query(
      `SELECT COUNT(*) as c FROM connections WHERE initiated_by = ? AND status = 'pending'`,
      [fromUserId],
    );
    return result.results?.[0]?.c || 0;
  }

  // Resolve a remote instance's federation endpoint via WebFinger (SSRF-guarded:
  // HTTPS-only, no redirect, abort timeout). Shared by request + response.
  async function resolveFederationEndpoint(remoteDomain, remoteHandle) {
    if (!DOMAIN_RE.test(remoteDomain)) throw new Error('Invalid domain');
    const webfingerUrl = `https://${remoteDomain}/.well-known/webfinger?resource=acct:${remoteHandle}@${remoteDomain}`;
    // safeFetch resolves once, validates every address (fail-closed), and pins the
    // connection — no DNS-rebinding the WebFinger host to a private IP.
    const wfRes = await safeFetch(webfingerUrl, { lookup, fetch: fetchImpl, signal: AbortSignal.timeout(WEBFINGER_TIMEOUT_MS), redirect: 'manual' });
    if (!wfRes.ok) throw new Error(`WebFinger failed: ${wfRes.status}`);
    const wf = await wfRes.json();
    const fedLink = wf.links?.find((l) => l.rel?.includes('federation'));
    if (!fedLink?.href) throw new Error('No federation endpoint');
    // Bind the endpoint to the WebFinger domain: a peer must not be able to point
    // our SIGNED POST at an unrelated host (confused-deputy SSRF). https-only,
    // host must equal the domain or be a subdomain of it.
    let u;
    try { u = new URL(fedLink.href); } catch { throw new Error('Invalid federation endpoint'); }
    if (u.protocol !== 'https:') throw new Error('federation endpoint must be https');
    if (u.hostname !== remoteDomain && !u.hostname.endsWith(`.${remoteDomain}`)) {
      throw new Error('federation endpoint host does not match the instance domain');
    }
    return fedLink.href;
  }

  // Sign (when sign+did are wired) and POST a federation envelope to
  // <endpoint>/<subpath>. Signs EXACTLY the canonical bytes it sends.
  async function signedFederationPost(endpoint, subpath, body) {
    const url = `${endpoint.replace(/\/$/, '')}/${subpath}`;
    const headers = { 'Content-Type': 'application/json' };
    let bodyStr;
    if (sign && did) {
      bodyStr = canonicalize(body);
      headers['X-Myc-Did'] = did();
      headers['X-Myc-Sig'] = sign(bodyStr);
    } else {
      bodyStr = JSON.stringify(body);
    }
    // safeFetch re-resolves + validates + pins the endpoint host: the subdomain
    // bind above stops a confused-deputy host swap, this stops rebinding that host
    // to a private IP (the SIGNED POST must never reach an internal target).
    await safeFetch(url, { lookup, fetch: fetchImpl, method: 'POST', headers, body: bodyStr, redirect: 'manual', signal: AbortSignal.timeout(FEDERATION_POST_TIMEOUT_MS) });
  }

  async function requestRemote(fromUserId, remoteHandle, remoteDomain) {
    // Existing-connection handling (mirrors the local request() path) — without
    // this a re-request hits the UNIQUE(user_a,user_b) constraint and surfaces a
    // raw SQL error. Resolve BEFORE any network work.
    const remoteId = `${remoteHandle}@${remoteDomain}`;
    const existing = await d1Query(
      `SELECT id, status FROM connections WHERE user_a = ? AND user_b = ?`,
      [fromUserId, remoteId],
    );
    const ex = existing.results?.[0];
    // A pre-existing pending row means a prior request whose delivery may have
    // failed (the POST is fire-and-forget and there is no background retry). So
    // a re-request RE-DELIVERS rather than no-op'ing: we keep the row and re-POST
    // below with a fresh nonce/ts. receiveRemote on the peer is idempotent, so a
    // re-delivery to a peer that already has the request is harmless.
    let redeliverId = null;
    if (ex) {
      if (ex.status === 'accepted') throw new Error('Already connected to this handle');
      if (ex.status === 'blocked') throw new Error('This peer is blocked');
      if (ex.status === 'pending') redeliverId = ex.id;
      if (ex.status === 'rejected') await d1Query(`DELETE FROM connections WHERE id = ?`, [ex.id]); // allow re-request
    }

    let federationEndpoint;
    try {
      federationEndpoint = await resolveFederationEndpoint(remoteDomain, remoteHandle);
    } catch (e) {
      throw new Error(`Instance not reachable: ${e.message}`);
    }

    // Assemble the request payload from the local profile.
    const fromProfile = await d1Query(
      `SELECT handle, signature, depth_score, breadth_score, public_realms_json FROM user_profiles WHERE user_id = ?`,
      [fromUserId],
    );
    const fp = fromProfile.results?.[0] || {};

    // Only a genuinely NEW request counts against the cap; a re-delivery reuses
    // the existing pending row.
    if (!redeliverId && await pendingCount(fromUserId) >= PENDING_LIMIT) {
      throw new Error(`Too many pending requests (max ${PENDING_LIMIT})`);
    }

    const selfHost = (selfInstance && selfInstance()) || (workerUrl ? new URL(workerUrl()).hostname : '');
    const profile = {
      signature: fp.signature ?? null,
      stats: { depth_score: fp.depth_score, breadth_score: fp.breadth_score },
      realms: fp.public_realms_json ? JSON.parse(fp.public_realms_json) : [],
    };
    if (hasVectorKey(profile)) throw new Error('refusing to federate a vector/embedding field (CLAUDE.md §7)');
    const requestBody = {
      $type: 'social.mycelium.connect-request.v1',
      from_handle: selfHandle() || fp.handle || fromUserId,
      from_instance: selfHost,
      from_did: did ? did() : null,
      to_handle: remoteHandle,
      nonce: randomUUID(),
      ts: Date.now(),
      profile,
    };

    // Store the outbound connection locally first (new request only) so a failed
    // delivery leaves a pending row the user can re-deliver by requesting again,
    // or clear via withdraw().
    const id = redeliverId || randomUUID();
    if (!redeliverId) {
      await d1Query(
        `INSERT INTO connections (id, user_a, user_b, initiated_by, status, remote_instance, remote_user_handle, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, datetime('now'))`,
        [id, fromUserId, remoteId, fromUserId, remoteDomain, remoteHandle],
      );
    }

    // Signed federation POST. Failure is non-fatal: the pending row persists and
    // re-requesting (or a future reconcile sweep) re-delivers. We surface the
    // failure to the caller's logs but keep the row so the request isn't lost.
    try {
      await signedFederationPost(federationEndpoint, 'connect', requestBody);
    } catch (e) {
      console.warn(`[federation] Remote connect POST failed (re-request to retry): ${e.message}`);
    }

    return id;
  }

  return {
    // Exported for tests; also used internally for canonical (user_a, user_b).
    _canonical: canonical,

    async request(fromUserId, toHandle) {
      // Federated handle (@handle@domain) routes through WebFinger.
      const remoteMatch = toHandle.match(HANDLE_LOCAL_PART_RE);
      if (remoteMatch) {
        return requestRemote(fromUserId, remoteMatch[1].toLowerCase(), remoteMatch[2]);
      }

      // Local handle: tenant DB first, fall back to owner registry for cross-tenant.
      const target = await d1Query(
        `SELECT user_id FROM user_profiles WHERE handle = ?`,
        [toHandle],
      );
      let toUserId = target.results?.[0]?.user_id;
      if (!toUserId && typeof workerUrl === 'function' && typeof workerAuth === 'function') {
        try {
          const res = await fetchImpl(
            `${workerUrl()}/api/resolve-handle?handle=${encodeURIComponent(toHandle)}`,
            {
              headers: { 'Authorization': `Bearer ${workerAuth()}` },
              signal: AbortSignal.timeout(RESOLVE_HANDLE_TIMEOUT_MS),
            },
          );
          if (res.ok) {
            const data = await res.json();
            toUserId = data.user_id;
          }
        } catch {
          // Registry unreachable — fall through to "not found".
        }
      }
      if (!toUserId) throw new Error('User not found');
      if (toUserId === fromUserId) throw new Error('Cannot connect to yourself');

      const { user_a, user_b } = canonical(fromUserId, toUserId);

      const existing = await d1Query(
        `SELECT id, status FROM connections WHERE user_a = ? AND user_b = ?`,
        [user_a, user_b],
      );
      const row = existing.results?.[0];
      if (row) {
        if (row.status === 'accepted') throw new Error('Already connected');
        if (row.status === 'blocked')  throw new Error('User not found'); // silent block
        if (row.status === 'pending')  throw new Error('Request already pending');
        // Rejected → allow re-request, updating initiator + reset timestamp.
        await d1Query(
          `UPDATE connections SET status = 'pending', initiated_by = ?, created_at = datetime('now') WHERE id = ?`,
          [fromUserId, row.id],
        );
        return row.id;
      }

      if (await pendingCount(fromUserId) >= PENDING_LIMIT) {
        throw new Error(`Too many pending requests (max ${PENDING_LIMIT})`);
      }

      const id = randomUUID();
      await d1Query(
        `INSERT INTO connections (id, user_a, user_b, initiated_by, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', datetime('now'))`,
        [id, user_a, user_b, fromUserId],
      );
      return id;
    },

    /**
     * Inbound federation: a remote instance asked to connect (verified upstream
     * by the federation router against the sender's did:web key). Caches the
     * peer's public profile (keyed by their did so it never collides with the
     * local handle's UNIQUE constraint) and writes a PENDING connection that
     * surfaces via pending(). Idempotent per (peer, local user).
     * SECURITY: `verifiedHost` is the host of the cryptographically verified
     * signer did:web (the federation handler derives it). The displayed instance
     * (remote_instance / "handle@instance") is bound to it — NOT the payload's
     * claimed from_instance — so a signed peer can't make their request appear
     * to come from an instance they don't control (impersonation in the UI).
     * @param {{fromHandle:string, verifiedHost:string, fromDid?:string, profile?:object, toUserId:string}} p
     * @returns {Promise<string>} the connection id
     */
    async receiveRemote({ fromHandle, verifiedHost, fromDid, profile = {}, toUserId }) {
      if (!fromHandle || !verifiedHost || !toUserId) {
        throw new Error('receiveRemote: fromHandle, verifiedHost, toUserId required');
      }
      const remoteId = fromDid || `${fromHandle}@${verifiedHost}`;
      if (remoteId === toUserId) throw new Error('cannot connect to yourself');
      // Cache the peer's public profile. handle stays NULL (only the local user
      // owns the UNIQUE handle); display_name carries "handle@<verified host>".
      await d1Query(
        `INSERT INTO user_profiles (user_id, display_name, signature, did, member_since)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           display_name = excluded.display_name,
           signature    = excluded.signature,
           did          = excluded.did`,
        [remoteId, `${fromHandle}@${verifiedHost}`, profile.signature ?? null, fromDid ?? null],
      );
      const { user_a, user_b } = canonical(toUserId, remoteId);
      const existing = await d1Query(
        `SELECT id, status FROM connections WHERE user_a = ? AND user_b = ?`,
        [user_a, user_b],
      );
      const row = existing.results?.[0];
      if (row) return row.id; // idempotent (incl. silently-blocked peers)
      const id = randomUUID();
      await d1Query(
        `INSERT INTO connections (id, user_a, user_b, initiated_by, status, remote_instance, remote_user_handle, remote_did, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, datetime('now'))`,
        [id, user_a, user_b, remoteId, verifiedHost, fromHandle, fromDid ?? null],
      );
      return id;
    },

    /**
     * Tier-0b OUTBOUND: respond to a pending inbound request and, when it came
     * from a remote instance, send the peer a SIGNED connect-response so their
     * side completes the handshake (their "Sent" → "Connected"). Does the local
     * status flip first (auth-checked), then best-effort fires the callback.
     * @param {string} userId @param {string} connectionId @param {'accept'|'reject'} action
     */
    async respondRemote(userId, connectionId, action) {
      const row = await loadConnection(connectionId, { requireStatus: 'pending' });
      if (!row) throw new Error('Connection not found');
      assertMember(row, userId);
      if (action === 'accept' && row.initiated_by === userId) throw new Error('Cannot accept your own request');

      const status = action === 'accept' ? 'accepted' : 'rejected';
      await d1Query(
        `UPDATE connections SET status = ?, accepted_at = ${action === 'accept' ? "datetime('now')" : 'accepted_at'} WHERE id = ?`,
        [status, connectionId],
      );

      // Only accept is propagated to the peer in Tier-0b (reject stays local-silent,
      // matching the re-request-permitted semantics). Local-only rows have no remote.
      if (action === 'accept' && row.remote_instance && row.remote_user_handle && sign && did) {
        try {
          const endpoint = await resolveFederationEndpoint(row.remote_instance, row.remote_user_handle);
          // include our own public bio so the peer can render us in their list
          const me = (await d1Query(`SELECT handle, signature FROM user_profiles WHERE user_id = ?`, [userId])).results?.[0] || {};
          const respProfile = { signature: me.signature ?? null };
          // §7 tripwire on THIS outbound path too (parity with requestRemote) —
          // never federate a vector/embedding field, even via a future regression.
          if (hasVectorKey(respProfile)) throw new Error('refusing to federate a vector/embedding field (CLAUDE.md §7)');
          await signedFederationPost(endpoint, 'connect-response', {
            $type: 'social.mycelium.connect-response.v1',
            from_handle: selfHandle() || me.handle || userId,
            from_instance: (selfInstance && selfInstance()) || '',
            from_did: did(),
            to_handle: row.remote_user_handle,
            action: 'accept',
            nonce: randomUUID(),
            ts: Date.now(),
            profile: respProfile,
          });
        } catch (e) {
          console.warn(`[federation] connect-response POST failed: ${e.message}`);
        }
      }
      return connectionId;
    },

    /**
     * Tier-0b INBOUND: the peer we requested has accepted (verified upstream by
     * the federation router against their did:web key). Flip our matching "sent"
     * row to accepted and cache their bio. Idempotent; ignores unknown refs.
     *
     * SECURITY: the row is matched on `verifiedHost` — the host of the
     * cryptographically VERIFIED signer did:web (passed by the federation
     * handler) — NOT the payload's claimed from_instance. Otherwise any peer
     * with a valid signature could accept on another instance's behalf, forging
     * a connection the real peer never agreed to.
     * @param {{fromHandle:string, verifiedHost:string, fromDid?:string, profile?:object, action:string, toUserId:string}} p
     */
    async receiveResponse({ fromHandle, verifiedHost, fromDid, profile = {}, action, toUserId }) {
      if (!fromHandle || !verifiedHost || !toUserId) throw new Error('receiveResponse: fromHandle, verifiedHost, toUserId required');
      if (action !== 'accept') return null; // only accept advances state in Tier-0b
      // remote_instance must equal the verified signer's host: a connect-response
      // is only honored from the very instance the request was sent to.
      // Match on the VERIFIED host (the real identity) + initiated_by, NOT the
      // handle: from_handle is a label that can legitimately differ from the one
      // we stored (federation handle vs profile handle, or an older peer build),
      // and requiring it to match silently dropped valid accepts → "accepted on
      // their side, still pending on ours". One handle per host in V1, so host +
      // initiated_by uniquely identifies the pending row.
      const found = await d1Query(
        `SELECT id, user_a, user_b FROM connections
         WHERE initiated_by = ? AND remote_instance = ? AND status = 'pending'
         ORDER BY created_at DESC
         LIMIT 1`,
        [toUserId, verifiedHost],
      );
      const row = found.results?.[0];
      if (!row) return null; // no pending row from this verified peer → ignore
      const peerId = row.user_a === toUserId ? row.user_b : row.user_a;
      // cache the peer's bio so list() renders them (keyed by the synthetic peer id)
      await d1Query(
        `INSERT INTO user_profiles (user_id, display_name, signature, did, member_since)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, signature = excluded.signature, did = excluded.did`,
        [peerId, `${fromHandle}@${verifiedHost}`, profile.signature ?? null, fromDid ?? null],
      );
      await d1Query(
        `UPDATE connections SET status = 'accepted', accepted_at = datetime('now'), remote_did = COALESCE(remote_did, ?) WHERE id = ?`,
        [fromDid ?? null, row.id],
      );
      return row.id;
    },

    async pending(userId) {
      const result = await d1Query(
        `SELECT c.*, up.handle, up.display_name, up.signature, up.avatar_url,
                up.depth_score, up.breadth_score, up.coherence_score, up.exploration_score,
                up.territory_count, up.realm_count, up.public_realms_json
         FROM connections c
         JOIN user_profiles up ON up.user_id = c.initiated_by
         WHERE (c.user_a = ? OR c.user_b = ?) AND c.status = 'pending' AND c.initiated_by != ?`,
        [userId, userId, userId],
      );
      return result.results || [];
    },

    async sent(userId) {
      const result = await d1Query(
        `SELECT c.id, c.status, c.created_at, c.remote_user_handle, c.remote_instance,
                CASE WHEN c.user_a = ? THEN ub.handle ELSE ua.handle END as to_handle,
                CASE WHEN c.user_a = ? THEN ub.display_name ELSE ua.display_name END as to_display_name,
                CASE WHEN c.user_a = ? THEN ub.avatar_url ELSE ua.avatar_url END as to_avatar_url
         FROM connections c
         LEFT JOIN user_profiles ua ON ua.user_id = c.user_a
         LEFT JOIN user_profiles ub ON ub.user_id = c.user_b
         WHERE c.initiated_by = ? AND c.status = 'pending'
         ORDER BY c.created_at DESC`,
        [userId, userId, userId, userId],
      );
      return result.results || [];
    },

    async accept(userId, connectionId) {
      const row = await loadConnection(connectionId, { requireStatus: 'pending' });
      if (!row) throw new Error('Connection not found');
      assertMember(row, userId);
      if (row.initiated_by === userId) throw new Error('Cannot accept your own request');

      await d1Query(
        `UPDATE connections SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?`,
        [connectionId],
      );
    },

    async reject(userId, connectionId) {
      const row = await loadConnection(connectionId, { requireStatus: 'pending' });
      if (!row) throw new Error('Connection not found');
      assertMember(row, userId);
      await d1Query(`UPDATE connections SET status = 'rejected' WHERE id = ?`, [connectionId]);
    },

    async block(userId, connectionId) {
      // Block permitted regardless of current status.
      const row = await loadConnection(connectionId);
      if (!row) throw new Error('Connection not found');
      assertMember(row, userId);
      await d1Query(`UPDATE connections SET status = 'blocked' WHERE id = ?`, [connectionId]);
    },

    async disconnect(userId, connectionId) {
      const row = await loadConnection(connectionId, { requireStatus: 'accepted' });
      if (!row) throw new Error('Connection not found');
      assertMember(row, userId);
      await d1Query(`DELETE FROM connections WHERE id = ?`, [connectionId]);
    },

    // Withdraw a sent-but-not-yet-accepted request. Clears a stranded pending
    // outbound row (e.g. delivery failed, or the user changed their mind) so it
    // can be re-sent. Local-only in Tier-0b: the peer's inbound pending row, if
    // any, is left for them to ignore. Only the initiator may withdraw.
    async withdraw(userId, connectionId) {
      const row = await loadConnection(connectionId, { requireStatus: 'pending' });
      if (!row) throw new Error('Connection not found');
      assertMember(row, userId);
      if (row.initiated_by !== userId) throw new Error('Can only withdraw your own sent request');
      await d1Query(`DELETE FROM connections WHERE id = ?`, [connectionId]);
    },

    async list(userId) {
      const result = await d1Query(
        `SELECT c.*,
          CASE WHEN c.user_a = ? THEN ub.handle ELSE ua.handle END as other_handle,
          CASE WHEN c.user_a = ? THEN ub.display_name ELSE ua.display_name END as other_display_name,
          CASE WHEN c.user_a = ? THEN ub.signature ELSE ua.signature END as other_signature,
          CASE WHEN c.user_a = ? THEN ub.user_id ELSE ua.user_id END as other_user_id,
          CASE WHEN c.user_a = ? THEN ub.depth_score ELSE ua.depth_score END as other_depth,
          CASE WHEN c.user_a = ? THEN ub.breadth_score ELSE ua.breadth_score END as other_breadth,
          CASE WHEN c.user_a = ? THEN ub.territory_count ELSE ua.territory_count END as other_territory_count,
          CASE WHEN c.user_a = ? THEN ub.public_realms_json ELSE ua.public_realms_json END as other_realms_json,
          CASE WHEN c.user_a = ? THEN ub.avatar_url ELSE ua.avatar_url END as other_avatar_url
         FROM connections c
         LEFT JOIN user_profiles ua ON ua.user_id = c.user_a
         LEFT JOIN user_profiles ub ON ub.user_id = c.user_b
         WHERE (c.user_a = ? OR c.user_b = ?) AND c.status = 'accepted'
         ORDER BY c.accepted_at DESC`,
        [userId, userId, userId, userId, userId, userId, userId, userId, userId, userId, userId],
      );
      return result.results || [];
    },

    /**
     * Compute mindscape overlap between two connected users.
     * Compares their publicly-visible territory sets by lowercased
     * name (exact label match — no embedding-based similarity yet),
     * then classifies the overlap shape.
     *
     * Cached on the connection row for 1 hour to avoid recomputing
     * under load.
     */
    async computeOverlap(userId, connectionId) {
      const row = await loadConnection(connectionId, { requireStatus: 'accepted' });
      if (!row) throw new Error('Connection not found');
      assertMember(row, userId);

      const otherUserId = row.user_a === userId ? row.user_b : row.user_a;

      if (row.overlap_json && row.overlap_computed_at) {
        const age = Date.now() - new Date(row.overlap_computed_at).getTime();
        if (age < OVERLAP_CACHE_TTL_MS) return JSON.parse(row.overlap_json);
      }

      const myTerr = await d1Query(
        `SELECT territory_id, name, essence, realm_id, message_count, visibility
         FROM territory_profiles WHERE user_id = ? AND visibility IN ('public', 'friends') AND name IS NOT NULL`,
        [userId],
      );
      const theirTerr = await d1Query(
        `SELECT territory_id, name, essence, realm_id, message_count, visibility
         FROM territory_profiles WHERE user_id = ? AND visibility IN ('public', 'friends') AND name IS NOT NULL`,
        [otherUserId],
      );

      const myList = myTerr.results || [];
      const theirList = theirTerr.results || [];

      // Exact case-insensitive name match.
      const myNames    = new Map(myList.map(t => [t.name.toLowerCase(), t]));
      const theirNames = new Map(theirList.map(t => [t.name.toLowerCase(), t]));

      const shared = [];
      const myOnly = [];
      const theirOnly = [];

      for (const [name, t] of myNames) {
        if (theirNames.has(name)) {
          const other = theirNames.get(name);
          shared.push({
            name: t.name,
            my_depth:    t.message_count || 0,
            their_depth: other.message_count || 0,
            my_essence:  t.essence,
            their_essence: other.essence,
          });
        } else {
          myOnly.push({ name: t.name, essence: t.essence, message_count: t.message_count || 0 });
        }
      }
      for (const [name, t] of theirNames) {
        if (!myNames.has(name)) {
          theirOnly.push({ name: t.name, essence: t.essence, message_count: t.message_count || 0 });
        }
      }

      // Match score: only compute once we have 3+ shared names.
      // Weighted by territory size so deep shared territories dominate.
      const union = shared.length + myOnly.length + theirOnly.length;
      let matchScore = null;
      if (shared.length >= 3 && union > 0) {
        const sharedWeight = shared.reduce((s, t) => s + t.my_depth + t.their_depth, 0);
        const totalWeight = sharedWeight
          + myOnly.reduce((s, t) => s + t.message_count, 0)
          + theirOnly.reduce((s, t) => s + t.message_count, 0);
        matchScore = totalWeight > 0 ? Math.round(sharedWeight / totalWeight * 100) : 0;
      }

      // Shape classification — thresholds are empirically chosen.
      let shape = 'early';
      if (shared.length >= 3) {
        const overlapRatio = shared.length / union;
        const depthBalance = shared.reduce((s, t) => {
          const max = Math.max(t.my_depth, t.their_depth, 1);
          return s + Math.min(t.my_depth, t.their_depth) / max;
        }, 0) / shared.length;

        if (overlapRatio > 0.6 && depthBalance > 0.5)       shape = 'twin';
        else if (overlapRatio > 0.4 && depthBalance > 0.4)  shape = 'deep-collaborators';
        else if (overlapRatio > 0.3)                         shape = 'broad-kindred';
        else if (myOnly.length > shared.length * 2
              || theirOnly.length > shared.length * 2)       shape = 'complementary';
        else                                                 shape = 'asymmetric';
      }

      const shapeLabels = {
        'twin':               'Twin Minds',
        'deep-collaborators': 'Deep Collaborators',
        'broad-kindred':      'Broad Kindred Spirits',
        'complementary':      'Complementary Thinkers',
        'asymmetric':         'Asymmetric',
        'early':              'Early Connection',
      };

      const overlap = {
        shared,
        myOnly:          myOnly.slice(0, 10),
        theirOnly:       theirOnly.slice(0, 10),
        matchScore,
        shape,
        shapeLabel:      shapeLabels[shape] || shape,
        sharedCount:     shared.length,
        myTotalVisible:  myList.length,
        theirTotalVisible: theirList.length,
        computedAt:      new Date().toISOString(),
      };

      await d1Query(
        `UPDATE connections SET overlap_json = ?, overlap_computed_at = datetime('now') WHERE id = ?`,
        [JSON.stringify(overlap), connectionId],
      );

      return overlap;
    },

    // ─── Direct messaging (federation Tier-0c) ─────────────────────────────
    // Two connected instances exchange text. Outbound signs + POSTs a
    // social.mycelium.message.v1 envelope to the peer's /federation/message;
    // inbound is accepted ONLY from a verified, ACCEPTED connection (the
    // federation handler runs the same did:web verify gate as /connect).

    /**
     * Send a text message to a connected peer's instance. Persists the outbound
     * row first (so a failed delivery is visible + retryable), then signs+POSTs.
     * @returns {{id:string, status:string, created_at:string}}
     */
    async sendMessage(userId, connectionId, text) {
      const content = typeof text === 'string' ? text.trim() : '';
      if (!content) throw new Error('Message is empty');
      if (content.length > MAX_MESSAGE_CHARS) throw new Error(`Message too long (max ${MAX_MESSAGE_CHARS} chars)`);
      const row = await loadConnection(connectionId, { requireStatus: 'accepted' });
      if (!row) throw new Error('Connection not found');
      assertMember(row, userId);

      const id = randomUUID();
      await d1Query(
        `INSERT INTO peer_messages (id, user_id, connection_id, direction, content, status)
         VALUES (?, ?, ?, 'out', ?, 'sending')`,
        [id, userId, connectionId, content],
      );

      // Local-only peer (no remote instance) → nothing to deliver over the wire;
      // leave it 'sent' (a same-box connection, mostly a test fixture).
      if (!row.remote_instance || !row.remote_user_handle || !sign || !did) {
        await d1Query(`UPDATE peer_messages SET status = 'sent' WHERE id = ?`, [id]);
        return { id, status: 'sent', created_at: new Date().toISOString() };
      }

      let status = 'failed';
      try {
        const endpoint = await resolveFederationEndpoint(row.remote_instance, row.remote_user_handle);
        const me = (await d1Query(`SELECT handle FROM user_profiles WHERE user_id = ?`, [userId])).results?.[0] || {};
        await signedFederationPost(endpoint, 'message', {
          $type: 'social.mycelium.message.v1',
          from_handle: selfHandle() || me.handle || userId,
          from_instance: (selfInstance && selfInstance()) || '',
          from_did: did(),
          to_handle: row.remote_user_handle,
          content,
          nonce: randomUUID(),
          ts: Date.now(),
        });
        status = 'delivered';
      } catch (e) {
        console.warn(`[federation] message POST failed (will show as failed): ${e.message}`);
      }
      await d1Query(`UPDATE peer_messages SET status = ? WHERE id = ?`, [status, id]);
      return { id, status, created_at: new Date().toISOString() };
    },

    /**
     * Inbound message from a VERIFIED peer (the federation handler already ran the
     * did:web signature/nonce/timestamp gate). We additionally require an ACCEPTED
     * connection from this peer — a valid signature alone is NOT authorization to
     * message a vault. Dedup is the UNIQUE(connection_id, remote_nonce) index.
     * @param {{fromDid?:string, verifiedHost:string, content:string, nonce:string, toUserId:string}} p
     * @returns {Promise<string|null>} the message id, or null if dropped
     */
    async receiveMessage({ fromDid, verifiedHost, content, nonce, toUserId }) {
      const body = typeof content === 'string' ? content.trim() : '';
      if (!body) throw new Error('empty message');
      if (body.length > MAX_MESSAGE_CHARS) throw new Error('message too long');
      // Find the ACCEPTED connection for this verified peer. Prefer the did
      // binding; fall back to the verified host (one handle per host in V1).
      const found = await d1Query(
        `SELECT id FROM connections
         WHERE (user_a = ? OR user_b = ?) AND status = 'accepted'
           AND (remote_did = ? OR remote_instance = ?)
         ORDER BY accepted_at DESC LIMIT 1`,
        [toUserId, toUserId, fromDid ?? ' ', verifiedHost ?? ' '],
      );
      const conn = found.results?.[0];
      if (!conn) throw new Error('no accepted connection from this peer');
      const id = randomUUID();
      // INSERT OR IGNORE: the partial-unique nonce index drops a re-delivery.
      await d1Query(
        `INSERT OR IGNORE INTO peer_messages (id, user_id, connection_id, direction, content, remote_nonce, status, read)
         VALUES (?, ?, ?, 'in', ?, ?, 'received', 0)`,
        [id, toUserId, conn.id, body, nonce ?? null],
      );
      return id;
    },

    /** Thread for a connection (oldest→newest). content auto-decrypts on read. */
    async listMessages(userId, connectionId, { limit = 200 } = {}) {
      const row = await loadConnection(connectionId);
      if (!row) throw new Error('Connection not found');
      assertMember(row, userId);
      const r = await d1Query(
        `SELECT id, direction, content, status, read, created_at
         FROM peer_messages WHERE connection_id = ? AND user_id = ?
         ORDER BY created_at ASC LIMIT ?`,
        [connectionId, userId, Number(limit) || 200],
      );
      return r.results || [];
    },

    /** Mark all inbound messages on a connection as read. */
    async markMessagesRead(userId, connectionId) {
      await d1Query(
        `UPDATE peer_messages SET read = 1 WHERE connection_id = ? AND user_id = ? AND direction = 'in' AND read = 0`,
        [connectionId, userId],
      );
    },

    /** Unread inbound counts: { total, byConnection: { [connId]: n } }. Feeds badges. */
    async unreadMessages(userId) {
      const r = await d1Query(
        `SELECT connection_id, COUNT(*) AS n FROM peer_messages
         WHERE user_id = ? AND direction = 'in' AND read = 0 GROUP BY connection_id`,
        [userId],
      );
      const byConnection = {};
      let total = 0;
      for (const row of (r.results || [])) { byConnection[row.connection_id] = row.n; total += row.n; }
      return { total, byConnection };
    },

    /**
     * Resolve a cryptographically VERIFIED peer (their did + did:web host) to one
     * of MY accepted connections. Prefer the did binding; fall back to the verified
     * host (one handle per host in V1). Returns the connection id, or null.
     * Shared by inbound message/share/content handlers — the single authorization
     * anchor (a valid signature is not access; an accepted connection is).
     */
    async findAcceptedByPeer({ fromDid, verifiedHost, toUserId }) {
      const r = await d1Query(
        `SELECT id FROM connections
         WHERE (user_a = ? OR user_b = ?) AND status = 'accepted'
           AND (remote_did = ? OR remote_instance = ?)
         ORDER BY accepted_at DESC LIMIT 1`,
        [toUserId, toUserId, fromDid ?? ' ', verifiedHost ?? ' '],
      );
      return r.results?.[0]?.id || null;
    },

    // ─── Presence (online/offline dot) ─────────────────────────────────────────

    /**
     * Resolve a VERIFIED peer to my accepted connection AND whether I currently
     * share my online status with them. The single authorization+consent anchor for
     * the presence responder. Returns { connId, share:boolean } or null (not an
     * accepted connection → caller answers `hidden`, no oracle).
     */
    async presenceShareForPeer({ fromDid, verifiedHost, toUserId }) {
      const r = await d1Query(
        `SELECT id, presence_share FROM connections
         WHERE (user_a = ? OR user_b = ?) AND status = 'accepted'
           AND (remote_did = ? OR remote_instance = ?)
         ORDER BY accepted_at DESC LIMIT 1`,
        [toUserId, toUserId, fromDid ?? ' ', verifiedHost ?? ' '],
      );
      const row = r.results?.[0];
      if (!row) return null;
      // DEFAULT 1: a NULL (shouldn't happen post-migration) is treated as shared.
      return { connId: row.id, share: row.presence_share !== 0 };
    },

    /**
     * Toggle whether I expose my online status to a connection (per-connection
     * revoke / re-grant). Auth-checked (must be a member); takes effect on the peer's
     * NEXT query (live-checked at serve time, like share revocation).
     */
    async setPresenceShare(userId, connectionId, share) {
      const row = await loadConnection(connectionId);
      if (!row) throw new Error('Connection not found');
      assertMember(row, userId);
      await d1Query(`UPDATE connections SET presence_share = ? WHERE id = ?`, [share ? 1 : 0, connectionId]);
      return connectionId;
    },

    /**
     * Query the online status of every accepted REMOTE connection (pull-on-demand).
     * Signs a presence-query to each peer's /federation/presence and verifies the
     * signed reply (signer-did match + echoed-nonce + freshness). Returns a render
     * map { [connectionId]: 'online' | 'offline' | 'none' }:
     *   online  → peer shares + active        (green dot)
     *   offline → peer shares + idle, OR unreachable-but-last-known-shared (grey dot)
     *   none    → not shared / revoked / never reached            (no dot)
     * Memoized ~45s; endpoint-cached; concurrency-capped; ~3s per-peer timeout.
     * Best-effort: a peer error never throws — it degrades to last-known/none.
     */
    async queryPresence(userId) {
      const nowMs = Date.now();
      if (nowMs - _presenceResult.at < PRESENCE_RESULT_TTL_MS) return _presenceResult.map;
      if (!sign || !did) { _presenceResult = { map: {}, at: nowMs }; return {}; } // remote off → no presence

      const conns = (await this.list(userId)).filter((c) => c.remote_instance && c.remote_user_handle);

      const queryOne = async (c) => {
        try {
          // Resolve (and cache) the peer's federation endpoint — skip WebFinger on
          // steady-state polls.
          let ep = _presenceEndpoint.get(c.id);
          if (!ep || nowMs - ep.at > PRESENCE_ENDPOINT_TTL_MS) {
            ep = { endpoint: await resolveFederationEndpoint(c.remote_instance, c.remote_user_handle), at: nowMs };
            _presenceEndpoint.set(c.id, ep);
          }
          const url = `${ep.endpoint.replace(/\/$/, '')}/presence`;
          const nonce = randomUUID();
          const body = { $type: 'social.mycelium.presence-query.v1', from_did: did(), nonce, ts: Date.now() };
          const bodyStr = canonicalize(body);
          const res = await safeFetch(url, {
            lookup, fetch: fetchImpl, method: 'POST', redirect: 'manual',
            headers: { 'Content-Type': 'application/json', 'X-Myc-Did': did(), 'X-Myc-Sig': sign(bodyStr) },
            body: bodyStr, signal: AbortSignal.timeout(PRESENCE_QUERY_TIMEOUT_MS),
          });
          if (!res.ok) throw new Error(`presence ${res.status}`);
          const raw = await res.text();
          if (raw.length > 4096) throw new Error('presence reply too large');
          const respDid = res.headers.get('x-myc-did');
          const respSig = res.headers.get('x-myc-sig');
          if (!respDid || !respSig) throw new Error('unsigned presence');
          if (c.remote_did && respDid !== c.remote_did) throw new Error('presence signed by wrong peer');
          const pub = await resolveDidKey(respDid, { fetch: fetchImpl, lookup });
          if (!verifyDetached(pub, raw, respSig)) throw new Error('presence signature invalid');
          const reply = JSON.parse(raw);
          if (reply.nonce !== nonce) throw new Error('presence nonce mismatch'); // anti-replay
          if (!Number.isFinite(Number(reply.ts)) || Math.abs(Date.now() - Number(reply.ts)) > 5 * 60 * 1000) throw new Error('stale presence');
          const state = reply.state;
          if (state === 'online') { _presenceLastShared.set(c.id, true); return 'online'; }
          if (state === 'offline') { _presenceLastShared.set(c.id, true); return 'offline'; }
          _presenceLastShared.set(c.id, false); // 'hidden' → they don't share with me
          return 'none';
        } catch {
          // Unreachable/invalid: known-shared peer is just offline (grey); else no dot.
          return _presenceLastShared.get(c.id) ? 'offline' : 'none';
        }
      };

      // Concurrency-capped fan-out.
      const map = {};
      for (let i = 0; i < conns.length; i += PRESENCE_CONCURRENCY) {
        const batch = conns.slice(i, i + PRESENCE_CONCURRENCY);
        const states = await Promise.all(batch.map(queryOne));
        batch.forEach((c, j) => { map[c.id] = states[j]; });
      }
      _presenceResult = { map, at: nowMs };
      return map;
    },

    // ─── Federation sharing (Tier-0d) — announce a grant/revoke to the peer ────
    /**
     * Tell a connected peer's instance that I granted (or revoked) them access to
     * one of my spaces/contexts, via a signed social.mycelium.share.v1 to their
     * /federation/share. Fire-and-forget: my LOCAL grant is the source of truth;
     * a failed announce just means the peer doesn't see it yet (re-grant re-syncs).
     * @param {string} userId @param {string} connectionId
     * @param {{kind:'space'|'context', ref:string, name?:string, role?:string, action:'grant'|'revoke'}} share
     */
    async announceShare(userId, connectionId, { kind, ref, name = null, role = null, action = 'grant' }) {
      const row = await loadConnection(connectionId, { requireStatus: 'accepted' });
      if (!row) return;
      assertMember(row, userId);
      if (!row.remote_instance || !row.remote_user_handle || !sign || !did) return; // local/unsigned
      try {
        const endpoint = await resolveFederationEndpoint(row.remote_instance, row.remote_user_handle);
        await signedFederationPost(endpoint, 'share', {
          $type: 'social.mycelium.share.v1',
          from_did: did(),
          from_handle: selfHandle() || userId,
          kind, ref, name, role, action,
          nonce: randomUUID(),
          ts: Date.now(),
        });
      } catch (e) {
        console.warn(`[federation] share announce failed (peer re-syncs on re-grant): ${e.message}`);
      }
    },

    /**
     * AUTHORIZATION ANCHOR for serving shared content to a verified peer. Given the
     * peer's verified did/host, resolve their connection, then check that a LIVE
     * grant exists for the requested space/context. Fail-closed: returns
     * { granted:false } for an unknown peer, a missing grant, a revoked grant, or a
     * PRIVATE context (private contexts are never exposed). Uses only d1Query so the
     * single source of truth lives here. Returns { granted, connId, peerId }.
     */
    async resolveSharedGrant({ fromDid, verifiedHost, toUserId, kind, ref }) {
      const c = await d1Query(
        `SELECT id, user_a, user_b FROM connections
         WHERE (user_a = ? OR user_b = ?) AND status = 'accepted'
           AND (remote_did = ? OR remote_instance = ?)
         ORDER BY accepted_at DESC LIMIT 1`,
        [toUserId, toUserId, fromDid ?? ' ', verifiedHost ?? ' '],
      );
      const row = c.results?.[0];
      if (!row) return { granted: false };
      const connId = row.id;
      const peerId = row.user_a === toUserId ? row.user_b : row.user_a;
      let granted = false;
      if (kind === 'space') {
        const g = await d1Query(
          `SELECT 1 FROM space_access WHERE space_id = ? AND user_id = ? AND revoked_at IS NULL LIMIT 1`,
          [ref, peerId],
        );
        granted = (g.results?.length || 0) > 0;
      } else if (kind === 'context') {
        // Only NON-private contexts ever serve (mirrors canSeeTerritory).
        const g = await d1Query(
          `SELECT 1 FROM context_grants cg JOIN sharing_contexts sc ON sc.id = cg.context_id
           WHERE cg.context_id = ? AND cg.connection_id = ? AND sc.user_id = ? AND sc.is_private = 0 LIMIT 1`,
          [ref, connId, toUserId],
        );
        granted = (g.results?.length || 0) > 0;
      }
      return { granted, connId, peerId };
    },

    /**
     * OUTBOUND (grantee side): fetch the contents of a share a peer granted me. Signs
     * a social.mycelium.shared-content.v1 request to the peer's /federation/shared-
     * content, and VERIFIES the peer's SIGNATURE on the response body (X-Myc-Did /
     * X-Myc-Sig) against their did:web key — so MITM'd/forged content is rejected.
     * SSRF-guarded (safeFetch) + size-capped. Returns the parsed, verified payload.
     * @param {string} userId @param {string} connectionId
     * @param {{kind:'space'|'context', ref:string}} q
     */
    async fetchSharedContent(userId, connectionId, { kind, ref }) {
      const row = await loadConnection(connectionId, { requireStatus: 'accepted' });
      if (!row) throw new Error('Connection not found');
      assertMember(row, userId);
      if (!row.remote_instance || !row.remote_user_handle || !sign || !did) throw new Error('peer is not reachable');
      const endpoint = await resolveFederationEndpoint(row.remote_instance, row.remote_user_handle);
      const url = `${endpoint.replace(/\/$/, '')}/shared-content`;
      const body = { $type: 'social.mycelium.shared-content.v1', from_did: did(), kind, ref, nonce: randomUUID(), ts: Date.now() };
      const bodyStr = canonicalize(body);
      const res = await safeFetch(url, {
        lookup, fetch: fetchImpl, method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/json', 'X-Myc-Did': did(), 'X-Myc-Sig': sign(bodyStr) },
        body: bodyStr, signal: AbortSignal.timeout(FEDERATION_POST_TIMEOUT_MS),
      });
      if (!res.ok) {
        if (res.status === 403) throw new Error('access to this share was revoked');
        throw new Error(`shared-content fetch failed (${res.status})`);
      }
      const raw = await res.text();
      if (raw.length > SHARED_CONTENT_MAX_BYTES) throw new Error('shared content too large');
      // Verify the peer SIGNED the response (no MITM/forgery). The signer DID must
      // match the connection's recorded peer did, and the key must resolve.
      const respDid = res.headers.get('x-myc-did');
      const respSig = res.headers.get('x-myc-sig');
      if (!respDid || !respSig) throw new Error('unsigned shared content');
      if (row.remote_did && respDid !== row.remote_did) throw new Error('shared content signed by the wrong peer');
      let pub;
      try { pub = await resolveDidKey(respDid, { fetch: fetchImpl, lookup }); } catch { throw new Error('could not resolve peer key'); }
      if (!verifyDetached(pub, raw, respSig)) throw new Error('shared content signature invalid');
      try { return JSON.parse(raw); } catch { throw new Error('malformed shared content'); }
    },
  };
}
