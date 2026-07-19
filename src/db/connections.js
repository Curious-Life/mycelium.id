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
import { verifyDetached } from '../federation/sign.js';
import { resolveDidKey, resolveRelayInbox, resolveKeyAgreementKey, didWebHost } from '../federation/did.js';
import { createDirectHttpTransport } from '../federation/transport.js';
import { planDelivery } from '../federation/transport-chooser.js';
import { sealEnvelope } from '../federation/envelope.js';
import { safeFetch } from '../federation/ssrf.js';
import { decodeSharedSpace } from '../crypto/space-reader.js';

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

const PENDING_LIMIT = 20;
const MAX_MESSAGE_CHARS = 4000; // peer-message body cap (well under the 8KB canonical envelope cap)
const OUTBOX_MAX_ATTEMPTS = 10; // stop re-attempting a failed DM after this many outbox sweeps (dead peer)
// Endpoint resolution + signed POST (WebFinger/DOMAIN_RE + federation timeouts) now live
// in the transport seam (src/federation/transport.js). PRESENCE_QUERY_TIMEOUT_MS below is
// this caller's tighter per-peer budget, passed to transport.request().
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
    // E2E shared-spaces decrypt (grantee side) — OPTIONAL. getDb is a late-bound
    // back-reference to the assembled db (db.spaceKeyManager + db.spaceCrypto), present
    // only when remote is configured. selfDid is this box's owner DID. When absent,
    // fetching a SPACE share throws cleanly (decryption unavailable) rather than leaking.
    getDb, selfDid,
    randomUUID = nodeRandomUUID,
    fetch: fetchImpl = globalThis.fetch,
    lookup, // injectable DNS resolver — threaded into safeFetch (tests inject a stub)
    now = () => Date.now(), // injectable clock for the presence caches (tests advance it)
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
  // which is a human label that can differ ("person") and 404s WebFinger. Outbound
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

  // Federation transport seam (P1 — docs/FEDERATION-TRANSPORT-REDESIGN-DESIGN-2026-07-18.md):
  // the ONE place that resolves a peer endpoint and frames/signs/POSTs an envelope. Direct
  // HTTP today; the relay store-and-forward transport (P3) slots in behind this interface.
  //   transport.resolveEndpoint(domain, handle) → federation endpoint href (WebFinger, SSRF-bound)
  //   transport.send(endpoint, subpath, body)    → fire-and-forget signed POST
  //   transport.request(url, body, { timeoutMs }) → signed POST, RETURNS the Response so the
  //                                                 caller verifies the signed reply itself.
  const transport = createDirectHttpTransport({ sign, did, lookup, fetch: fetchImpl });

  // Federation delivery ROUTER (P3b-2b): route a signaling payload to a peer via the
  // relay store-and-forward queue when the peer advertises a #relay-inbox + a seal key,
  // else the direct box→box HTTP transport. The relay path needs NO WebFinger and does
  // not require the peer's box to be reachable NOW — the sealed envelope waits in the
  // queue and the peer pulls it when next online (the 502/offline failure class). Both
  // paths are best-effort here; the caller keeps a durable pending row and re-delivers.
  const RELAY_ENQUEUE_TIMEOUT_MS = 10000;
  const PEER_KEY_TTL_MS = 24 * 60 * 60 * 1000; // re-resolve a cached peer inbox/key after a day (bounds stale-key loss)
  const _relaySeq = new Map(); // per-peer monotonic send seq (in-memory; P4 makes it durable)
  const relayResolvers = {
    resolveRelayInbox: (peerDid) => resolveRelayInbox(peerDid, { fetch: fetchImpl, lookup }),
    resolveKeyAgreement: async (peerDid) => {
      const raw = await resolveKeyAgreementKey(peerDid, { fetch: fetchImpl, lookup });
      if (!raw) return null;
      // resolveKeyAgreementKey returns the X25519 key as a base64url STRING; sealToX25519
      // wants exactly that. (Handle a Buffer too, defensively — never double-encode.)
      return typeof raw === 'string' ? raw : Buffer.from(raw).toString('base64url');
    },
  };

  // Seal `payload` to the peer and enqueue it in the peer's relay inbox (unauthenticated —
  // sealed-sender). recipient handle = the peer did's host label (their provisioned handle).
  async function enqueueSealed(inbox, peerDid, keyAgreementPubB64, payload) {
    const recipient = (didWebHost(peerDid) || '').split('.')[0];
    if (!recipient) throw new Error('relay: cannot derive recipient handle from peer did');
    const seq = (_relaySeq.get(peerDid) || 0) + 1; _relaySeq.set(peerDid, seq);
    const env = sealEnvelope(payload, {
      recipientKeyAgreementPubB64: keyAgreementPubB64, recipientDid: peerDid,
      senderDid: selfDid, sign: (b) => sign(b), nonce: randomUUID(), ts: Date.now(), senderSeq: seq,
    });
    // safeFetch re-validates + pins the inbox host (resolveRelayInbox already bound it to
    // a public host; this is the second SSRF layer at POST time). The body carries the
    // recipient handle (routing) + the SEALED-SENDER envelope (no sender_did on the wire —
    // the relay can't see who sent it). Residual: recipient-DID blinding (the relay still
    // sees the recipient handle it routes to) is deferred.
    const res = await safeFetch(`${inbox.replace(/\/$/, '')}/v1/queue/enqueue`, {
      lookup, fetch: fetchImpl, method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient, envelope: JSON.stringify(env) }),
      signal: AbortSignal.timeout(RELAY_ENQUEUE_TIMEOUT_MS),
    });
    // Fail LOUD on a relay reject (unknown recipient / quota / rate-limit) — fetch does
    // not throw on 4xx/5xx, so without this a dropped enqueue would read as 'delivered'.
    if (!res.ok) throw new Error(`relay enqueue rejected (${res.status})`);
  }

  // Deliver `payload` ($type record) to a peer. Returns 'relay' | 'direct'. Chooses the relay
  // path iff the peer advertises an inbox + seal key (capability chooser, fail-closed to
  // direct). `remoteDid` may be null → derived as did:web:<remoteDomain>. When `connId` is
  // given, the peer's inbox + seal key are CACHED on that connection row after the first
  // resolve and reused thereafter — so a send to an established peer needs NO did.json fetch
  // and works while the peer is fully OFFLINE (the relay holds the sealed envelope).
  async function federationDeliver({ remoteDomain, remoteHandle, remoteDid, connId }, subpath, payload) {
    const peerDid = remoteDid || `did:web:${remoteDomain}`;
    if (sign && selfDid) {
      // Read the cached inbox + seal key (if any) and whether it's within the TTL.
      let cachedInbox = null, cachedKey = null, fresh = false;
      if (connId) {
        const c = (await d1Query(`SELECT remote_relay_inbox, remote_key_agreement, remote_keys_cached_at FROM connections WHERE id = ?`, [connId])).results?.[0];
        if (c?.remote_relay_inbox && c?.remote_key_agreement) {
          cachedInbox = c.remote_relay_inbox; cachedKey = c.remote_key_agreement;
          const at = c.remote_keys_cached_at ? Date.parse(String(c.remote_keys_cached_at).replace(' ', 'T') + 'Z') : NaN;
          fresh = Number.isFinite(at) && (Date.now() - at < PEER_KEY_TTL_MS);
        }
      }
      let inbox = null, key = null;
      if (fresh) {
        inbox = cachedInbox; key = cachedKey; // fresh cache → no did.json fetch
      } else {
        // No cache, or stale → re-resolve (picks up a rotated key / moved relay). If the peer is
        // unreachable, fall back to the STALE cache so delivery stays offline-tolerant.
        let plan = { kind: 'direct' };
        try { plan = await planDelivery(peerDid, relayResolvers); } catch { /* peer unreachable */ }
        if (plan.kind === 'relay') {
          inbox = plan.inbox; key = plan.keyAgreementPubB64;
          if (connId) { try { await d1Query(`UPDATE connections SET remote_relay_inbox = ?, remote_key_agreement = ?, remote_keys_cached_at = datetime('now') WHERE id = ?`, [inbox, key, connId]); } catch { /* best-effort */ } }
        } else if (cachedInbox && cachedKey) {
          inbox = cachedInbox; key = cachedKey; // re-resolve failed, peer offline → use stale cache
        }
      }
      if (inbox && key) {
        try { await enqueueSealed(inbox, peerDid, key, payload); return 'relay'; }
        catch (e) {
          // A relay reject means the cached inbox is dead (moved relay / gone) — CLEAR the cache
          // so the next send re-resolves, and surface the failure (the caller keeps the row + retries).
          if (connId) { try { await d1Query(`UPDATE connections SET remote_relay_inbox = NULL, remote_key_agreement = NULL, remote_keys_cached_at = NULL WHERE id = ?`, [connId]); } catch { /* */ } }
          throw e;
        }
      }
    }
    const endpoint = await transport.resolveEndpoint(remoteDomain, remoteHandle);
    await transport.send(endpoint, subpath, payload);
    return 'direct';
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

    // Endpoint resolution is now LAZY inside federationDeliver: a relay-capable peer skips
    // WebFinger entirely (so its box being offline no longer blocks the request — the
    // sealed envelope waits in the queue), and the direct path resolves + fails
    // best-effort below, keeping the pending row for re-delivery (store-and-forward).

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
      await federationDeliver({ remoteDomain, remoteHandle, connId: id }, 'connect', requestBody);
    } catch (e) {
      console.warn(`[federation] Remote connect delivery failed (re-request to retry): ${e.message}`);
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
          // include our own public bio so the peer can render us in their list
          const me = (await d1Query(`SELECT handle, signature FROM user_profiles WHERE user_id = ?`, [userId])).results?.[0] || {};
          const respProfile = { signature: me.signature ?? null };
          // §7 tripwire on THIS outbound path too (parity with requestRemote) —
          // never federate a vector/embedding field, even via a future regression.
          if (hasVectorKey(respProfile)) throw new Error('refusing to federate a vector/embedding field (CLAUDE.md §7)');
          // Route via the chooser: relay store-and-forward when the peer advertises an inbox
          // (so the ACCEPT lands even if the requester is now offline), else direct.
          await federationDeliver({ remoteDomain: row.remote_instance, remoteHandle: row.remote_user_handle, remoteDid: row.remote_did, connId: connectionId }, 'connect-response', {
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
      // Choose the payload nonce ONCE and persist it: a later outbox retry REUSES it so the
      // receiver's remote_nonce dedup drops a re-delivery (idempotent). A fresh nonce per retry
      // would double-deliver if an earlier attempt actually landed (lost relay/POST response).
      const wireNonce = randomUUID();
      await d1Query(
        `INSERT INTO peer_messages (id, user_id, connection_id, direction, content, send_nonce, status)
         VALUES (?, ?, ?, 'out', ?, ?, 'sending')`,
        [id, userId, connectionId, content, wireNonce],
      );

      // Local-only peer (no remote instance) → nothing to deliver over the wire;
      // leave it 'sent' (a same-box connection, mostly a test fixture).
      if (!row.remote_instance || !row.remote_user_handle || !sign || !did) {
        await d1Query(`UPDATE peer_messages SET status = 'sent' WHERE id = ?`, [id]);
        return { id, status: 'sent', created_at: new Date().toISOString() };
      }

      let status = 'failed';
      try {
        const me = (await d1Query(`SELECT handle FROM user_profiles WHERE user_id = ?`, [userId])).results?.[0] || {};
        await federationDeliver({ remoteDomain: row.remote_instance, remoteHandle: row.remote_user_handle, remoteDid: row.remote_did, connId: connectionId }, 'message', {
          $type: 'social.mycelium.message.v1',
          from_handle: selfHandle() || me.handle || userId,
          from_instance: (selfInstance && selfInstance()) || '',
          from_did: did(),
          to_handle: row.remote_user_handle,
          content,
          nonce: wireNonce, // persisted above → an outbox retry reuses it (idempotent receiver dedup)
          ts: Date.now(),
        });
        status = 'delivered';
      } catch (e) {
        console.warn(`[federation] message delivery failed (will show as failed): ${e.message}`);
      }
      await d1Query(`UPDATE peer_messages SET status = ? WHERE id = ?`, [status, id]);
      return { id, status, created_at: new Date().toISOString() };
    },

    /**
     * Delivery-robustness sweep (federation transport P5): re-attempt outbound DMs whose live
     * delivery FAILED (the relay/peer was unreachable at send time, so sendMessage left them
     * 'failed'). A store-and-forward send only needs to reach the relay ONCE — the sealed
     * envelope then waits in the queue for the offline peer — so on the first successful
     * re-enqueue we flip the row to 'delivered' and it is never swept again (no relay-queue
     * bloat: success is self-terminating). Called best-effort from the pull loop on cycles when
     * the relay was just reachable. Bounded batch. A per-message failure is left 'failed' for
     * the next sweep and does NOT block the rest of the batch.
     *
     * Idempotent retry: the payload nonce is the one PERSISTED at send time (send_nonce), reused
     * here — the receiver dedups a DM on remote_nonce for both transports, so a retry whose
     * earlier attempt actually landed (lost relay/POST response after commit) is DROPPED, not
     * double-delivered. Anti-starvation + cap: ORDER BY send_attempts ASC keeps a dead peer's
     * backlog from starving a live peer's newer messages, and send_attempts >= OUTBOX_MAX_ATTEMPTS
     * drops out of the sweep so a permanently-unreachable peer is eventually left alone.
     *
     * Deferred (not here): retry of pending CONNECTS — 'pending' is ambiguous (delivery-failed
     * vs awaiting-accept), so a blind connect re-send would re-enqueue a duplicate every sweep;
     * that needs a delivery-status column to gate on. federation_seen TTL prune is also deferred
     * (it needs a co-designed ts-freshness window or it reopens replay for pruned nonces).
     */
    async federationOutbox(userId, { limit = 20 } = {}) {
      if (!sign || !did) return { retried: 0, delivered: 0 };
      const failed = (await d1Query(
        `SELECT id, connection_id, content, send_nonce FROM peer_messages
         WHERE user_id = ? AND direction = 'out' AND status = 'failed' AND send_attempts < ?
         ORDER BY send_attempts ASC, created_at ASC LIMIT ?`,
        [userId, OUTBOX_MAX_ATTEMPTS, limit],
      )).results || [];
      // The sender handle is the same for every message this sweep → resolve it once, not per row.
      const me = failed.length ? ((await d1Query(`SELECT handle FROM user_profiles WHERE user_id = ?`, [userId])).results?.[0] || {}) : {};
      let delivered = 0;
      for (const m of failed) {
        try {
          const row = await loadConnection(m.connection_id, { requireStatus: 'accepted' });
          if (!row || !row.remote_instance || !row.remote_user_handle) continue; // not deliverable (local-only / gone)
          // Count the attempt BEFORE the network call: a message that keeps throwing still
          // climbs toward the cap (and sinks in priority) instead of being retried forever.
          await d1Query(`UPDATE peer_messages SET send_attempts = send_attempts + 1 WHERE id = ?`, [m.id]);
          await federationDeliver({ remoteDomain: row.remote_instance, remoteHandle: row.remote_user_handle, remoteDid: row.remote_did, connId: m.connection_id }, 'message', {
            $type: 'social.mycelium.message.v1',
            from_handle: selfHandle() || me.handle || userId,
            from_instance: (selfInstance && selfInstance()) || '',
            from_did: did(),
            to_handle: row.remote_user_handle,
            content: m.content,
            nonce: m.send_nonce || randomUUID(), // reuse the persisted nonce (legacy rows: fresh)
            ts: Date.now(),
          });
          await d1Query(`UPDATE peer_messages SET status = 'delivered' WHERE id = ?`, [m.id]);
          delivered++;
        } catch { /* still unreachable → leave 'failed' for the next sweep; don't block the batch */ }
      }
      return { retried: failed.length, delivered };
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
        [toUserId, toUserId, fromDid ?? '\0', verifiedHost ?? '\0'],
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
      const nowMs = now();
      if (nowMs - _presenceResult.at < PRESENCE_RESULT_TTL_MS) return _presenceResult.map;
      if (!sign || !did) { _presenceResult = { map: {}, at: nowMs }; return {}; } // remote off → no presence

      const conns = (await this.list(userId)).filter((c) => c.remote_instance && c.remote_user_handle);

      const queryOne = async (c) => {
        try {
          // Resolve (and cache) the peer's federation endpoint — skip WebFinger on
          // steady-state polls.
          let ep = _presenceEndpoint.get(c.id);
          if (!ep || nowMs - ep.at > PRESENCE_ENDPOINT_TTL_MS) {
            ep = { endpoint: await transport.resolveEndpoint(c.remote_instance, c.remote_user_handle), at: nowMs };
            _presenceEndpoint.set(c.id, ep);
          }
          const url = `${ep.endpoint.replace(/\/$/, '')}/presence`;
          const nonce = randomUUID();
          const body = { $type: 'social.mycelium.presence-query.v1', from_did: did(), nonce, ts: Date.now() };
          const res = await transport.request(url, body, { timeoutMs: PRESENCE_QUERY_TIMEOUT_MS });
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
        const endpoint = await transport.resolveEndpoint(row.remote_instance, row.remote_user_handle);
        await transport.send(endpoint, 'share', {
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
      // D6 (shared-spaces redesign 2026-06-30): SPACE serves/mutations bind to the
      // peer's stable did:web identity — NEVER the mutable verifiedHost. The
      // `remote_instance` (host) fallback is migration-only and is NOT honored for
      // spaces: a host rebind / handle reissue must not silently satisfy a grant.
      // No presented did → fail closed. (Contexts keep the host fallback for now.)
      const didBound = kind === 'space';
      if (didBound && !fromDid) return { granted: false };
      const c = await d1Query(
        `SELECT id, user_a, user_b FROM connections
         WHERE (user_a = ? OR user_b = ?) AND status = 'accepted'
           AND ${didBound ? 'remote_did = ?' : '(remote_did = ? OR remote_instance = ?)'}
         ORDER BY accepted_at DESC LIMIT 1`,
        didBound ? [toUserId, toUserId, fromDid] : [toUserId, toUserId, fromDid ?? ' ', verifiedHost ?? ' '],
      );
      const row = c.results?.[0];
      if (!row) {
        // D6 / decision #6: a space grant denied ONLY because the peer's connection
        // predates did-capture (matches by host but carries no bound remote_did) must
        // be LOGGED, not silently 403'd — operators need to see these until BU6's
        // 0018 migration backfills remote_did. Still fail-closed (we do NOT grant);
        // this just makes the denial visible. An attacker with no accepted connection
        // triggers no log (the diagnostic requires a host-matched accepted row).
        if (didBound && fromDid) {
          const legacy = await d1Query(
            `SELECT 1 FROM connections
             WHERE (user_a = ? OR user_b = ?) AND status = 'accepted'
               AND remote_instance = ? AND (remote_did IS NULL OR remote_did != ?) LIMIT 1`,
            [toUserId, toUserId, verifiedHost ?? ' ', fromDid],
          );
          if (legacy.results?.length) {
            console.warn(
              `[connections] space grant DENIED for host=${verifiedHost}: connection lacks a bound remote_did ` +
              `(did-bound enforcement, decision #6). Run the 0018 remote_did backfill to restore this share.`,
            );
          }
        }
        return { granted: false };
      }
      const connId = row.id;
      const peerId = row.user_a === toUserId ? row.user_b : row.user_a;
      let granted = false;
      if (kind === 'space') {
        // D10 (the HIGH leak fix): the space must still EXIST as a LIVE space —
        // the JOIN on users.type='space' makes a soft-deleted space
        // (type='space_deleted') STOP serving to previously-granted peers. This is
        // the cryptographic floor for revocation: it holds even if a revoke
        // announce was lost. (Audit 2026-06-30: resolveSharedGrant never re-checked
        // u.type, so deleted spaces kept serving indefinitely.)
        const g = await d1Query(
          `SELECT 1 FROM space_access sa
             JOIN users u ON u.id = sa.space_id AND u.type = 'space'
           WHERE sa.space_id = ? AND sa.user_id = ? AND sa.revoked_at IS NULL LIMIT 1`,
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
      const endpoint = await transport.resolveEndpoint(row.remote_instance, row.remote_user_handle);
      const url = `${endpoint.replace(/\/$/, '')}/shared-content`;

      // Fetch one page (signed request → signature-verified response). Returns the parsed
      // body + the OWNER's resolved signing key (reused to verify each entry's authorship).
      const fetchPage = async (since) => {
        const body = { $type: 'social.mycelium.shared-content.v1', from_did: did(), kind, ref, since, nonce: randomUUID(), ts: Date.now() };
        const res = await transport.request(url, body);
        if (!res.ok) {
          if (res.status === 403) throw new Error('access to this share was revoked');
          throw new Error(`shared-content fetch failed (${res.status})`);
        }
        const raw = await res.text();
        if (raw.length > SHARED_CONTENT_MAX_BYTES) throw new Error('shared content too large');
        // The peer SIGNED the response (no MITM/forgery): signer DID must match the
        // connection's recorded peer DID, and the key must resolve.
        const respDid = res.headers.get('x-myc-did');
        const respSig = res.headers.get('x-myc-sig');
        if (!respDid || !respSig) throw new Error('unsigned shared content');
        if (row.remote_did && respDid !== row.remote_did) throw new Error('shared content signed by the wrong peer');
        let pub;
        try { pub = await resolveDidKey(respDid, { fetch: fetchImpl, lookup }); } catch { throw new Error('could not resolve peer key'); }
        if (!verifyDetached(pub, raw, respSig)) throw new Error('shared content signature invalid');
        let parsed;
        try { parsed = JSON.parse(raw); } catch { throw new Error('malformed shared content'); }
        return { parsed, ownerPub: pub };
      };

      // CONTEXT shares stay plaintext (legacy territories path) — single fetch, unchanged.
      if (kind !== 'space') return (await fetchPage(-1)).parsed;

      // SPACE shares are E2E: page through the ciphertext oplog (since → head), then
      // DECRYPT LOCALLY. The owner/relay never see plaintext; only this box, holding a
      // sealed CEK, can decode. Requires the crypto seam (remote configured).
      const db = typeof getDb === 'function' ? getDb() : null;
      if (!db?.spaceKeyManager || !db.spaceCrypto) throw new Error('space decryption unavailable (remote not configured)');
      const MAX_PAGES = 64; // backstop against an oversharing/looping peer
      let since = -1, head = -1, name = null, ownerPub = null;
      const entries = [];
      let grants = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const { parsed, ownerPub: pub } = await fetchPage(since);
        ownerPub = pub;
        if (parsed.name != null) name = parsed.name;
        if (Number.isInteger(parsed.head)) head = parsed.head;
        if (Array.isArray(parsed.grants) && parsed.grants.length) grants = parsed.grants;
        const pageEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
        entries.push(...pageEntries);
        const maxSeq = pageEntries.length ? pageEntries[pageEntries.length - 1].seq : since;
        if (pageEntries.length === 0 || maxSeq >= head) break; // caught up
        since = maxSeq;
      }
      // Local decrypt: verify authorship + shape + gen-binding, LWW by seq. Fail-closed.
      return decodeSharedSpace({ ref, name, entries, grants, ownerSigningKeyB64: ownerPub, keyManager: db.spaceKeyManager, spaceCrypto: db.spaceCrypto });
    },
  };
}
