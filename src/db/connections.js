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
import { canonicalize } from '../federation/sign.js';

// Recursive key tripwire (CLAUDE.md §7): never let an embedding/vector field
// leave the box, even via a future regression that adds one to the profile.
function hasVectorKey(o) {
  return o && typeof o === 'object'
    && Object.keys(o).some((k) => /centroid|embedding|vector/i.test(k) || hasVectorKey(o[k]));
}

const HANDLE_LOCAL_PART_RE = /^([a-z0-9][a-z0-9_]{2,29})@(.+)$/i;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

const PENDING_LIMIT = 20;
const WEBFINGER_TIMEOUT_MS = 5000;
const FEDERATION_POST_TIMEOUT_MS = 10000;
const RESOLVE_HANDLE_TIMEOUT_MS = 5000;
const OVERLAP_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

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
  } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createConnectionsNamespace: d1Query required');

  function canonical(a, b) {
    return a < b ? { user_a: a, user_b: b } : { user_a: b, user_b: a };
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
    const wfRes = await fetchImpl(webfingerUrl, { signal: AbortSignal.timeout(WEBFINGER_TIMEOUT_MS), redirect: 'manual' });
    if (!wfRes.ok) throw new Error(`WebFinger failed: ${wfRes.status}`);
    const wf = await wfRes.json();
    const fedLink = wf.links?.find((l) => l.rel?.includes('federation'));
    if (!fedLink?.href) throw new Error('No federation endpoint');
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
    await fetchImpl(url, { method: 'POST', headers, body: bodyStr, signal: AbortSignal.timeout(FEDERATION_POST_TIMEOUT_MS) });
  }

  async function requestRemote(fromUserId, remoteHandle, remoteDomain) {
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

    if (await pendingCount(fromUserId) >= PENDING_LIMIT) {
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
      from_handle: fp.handle || fromUserId,
      from_instance: selfHost,
      from_did: did ? did() : null,
      to_handle: remoteHandle,
      nonce: randomUUID(),
      ts: Date.now(),
      profile,
    };

    // Store outbound connection locally first so reconciliation has something to retry against.
    const id = randomUUID();
    await d1Query(
      `INSERT INTO connections (id, user_a, user_b, initiated_by, status, remote_instance, remote_user_handle, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, datetime('now'))`,
      [id, fromUserId, `${remoteHandle}@${remoteDomain}`, fromUserId, remoteDomain, remoteHandle],
    );

    // Fire-and-forget signed federation POST; failures are handled by reconciliation.
    try {
      await signedFederationPost(federationEndpoint, 'connect', requestBody);
    } catch (e) {
      console.warn(`[federation] Remote connect POST failed (will retry): ${e.message}`);
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
     * @param {{fromHandle:string, fromInstance:string, fromDid?:string, profile?:object, toUserId:string}} p
     * @returns {Promise<string>} the connection id
     */
    async receiveRemote({ fromHandle, fromInstance, fromDid, profile = {}, toUserId }) {
      if (!fromHandle || !fromInstance || !toUserId) {
        throw new Error('receiveRemote: fromHandle, fromInstance, toUserId required');
      }
      const remoteId = fromDid || `${fromHandle}@${fromInstance}`;
      if (remoteId === toUserId) throw new Error('cannot connect to yourself');
      // Cache the peer's public profile. handle stays NULL (only the local user
      // owns the UNIQUE handle); display_name carries "handle@instance".
      await d1Query(
        `INSERT INTO user_profiles (user_id, display_name, signature, did, member_since)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           display_name = excluded.display_name,
           signature    = excluded.signature,
           did          = excluded.did`,
        [remoteId, `${fromHandle}@${fromInstance}`, profile.signature ?? null, fromDid ?? null],
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
        [id, user_a, user_b, remoteId, fromInstance, fromHandle, fromDid ?? null],
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
          await signedFederationPost(endpoint, 'connect-response', {
            $type: 'social.mycelium.connect-response.v1',
            from_handle: me.handle || userId,
            from_instance: (selfInstance && selfInstance()) || '',
            from_did: did(),
            to_handle: row.remote_user_handle,
            action: 'accept',
            nonce: randomUUID(),
            ts: Date.now(),
            profile: { signature: me.signature ?? null },
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
     * @param {{fromHandle:string, fromInstance:string, fromDid?:string, profile?:object, action:string, toUserId:string}} p
     */
    async receiveResponse({ fromHandle, fromInstance, fromDid, profile = {}, action, toUserId }) {
      if (!fromHandle || !fromInstance || !toUserId) throw new Error('receiveResponse: fromHandle, fromInstance, toUserId required');
      if (action !== 'accept') return null; // only accept advances state in Tier-0b
      const found = await d1Query(
        `SELECT id, user_a, user_b FROM connections
         WHERE initiated_by = ? AND remote_instance = ? AND remote_user_handle = ? AND status = 'pending'
         LIMIT 1`,
        [toUserId, fromInstance, fromHandle],
      );
      const row = found.results?.[0];
      if (!row) return null; // unknown/duplicate → ignore
      const peerId = row.user_a === toUserId ? row.user_b : row.user_a;
      // cache the peer's bio so list() renders them (keyed by the synthetic peer id)
      await d1Query(
        `INSERT INTO user_profiles (user_id, display_name, signature, did, member_since)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, signature = excluded.signature, did = excluded.did`,
        [peerId, `${fromHandle}@${fromInstance}`, profile.signature ?? null, fromDid ?? null],
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
  };
}
