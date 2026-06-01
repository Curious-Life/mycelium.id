/**
 * Profiles namespace — user-facing handle + public fingerprint
 * (depth/breadth/coherence/exploration scores, public realm names).
 *
 * Handle reservation is cross-tenant: every tenant D1 stores its own
 * `user_profiles.handle` (denormalized display cache), but the
 * authoritative uniqueness check + reservation row live on the
 * **owner** D1's `handle_reservations` table. PR 4 routes the
 * reservation through `handles.claim()` (the typed Worker endpoint
 * client) — pre-PR-4 this namespace issued raw SQL via
 * `/api/db/query`, which any tenant token could spoof; the typed
 * client derives `user_id` from the bearer-token identity server-
 * side, eliminating the cross-tenant write surface.
 *
 * SECURITY notes:
 *   - Local format pre-check before any network hop
 *     (`^[a-z0-9][a-z0-9_]{2,29}$`, 3–30 chars). PR 7 will reconcile
 *     this with the Worker's DNS-compatible regex.
 *   - Reserved handles blocked locally (defense in depth — Worker
 *     also rejects them).
 *   - `handles` dep is injectable for tests; the production wiring
 *     in db-d1.js passes the createHandleClient instance.
 *
 * `computeFingerprint` derives the public profile from territory +
 * realm counts, message count, chronicle fraction (coherence), and
 * realm-entropy (exploration). Result is stored via `this.upsert` so
 * callers can read it from the profile row.
 *
 * @typedef {object} ProfilesNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(sql: string, params: any[]) => Promise<any>} d1QueryAdmin — for handle lookups by handle (no user_id filter)
 * @property {{ claim: (h: string) => Promise<{handle: string}>, mine: () => Promise<string|null> }} handles — handle-client instance
 */

export function createProfilesNamespace(deps) {
  if (!deps) throw new TypeError('createProfilesNamespace: deps required');
  const { d1Query, d1QueryAdmin, handles } = deps;
  if (typeof d1Query !== 'function')      throw new TypeError('createProfilesNamespace: d1Query required');
  if (typeof d1QueryAdmin !== 'function') throw new TypeError('createProfilesNamespace: d1QueryAdmin required');
  if (!handles || typeof handles.claim !== 'function') {
    throw new TypeError('createProfilesNamespace: handles (handle-client) required');
  }

  // Reserved handles — superset of:
  //   1. Subdomain-conflicting names enforced by the Worker public route
  //      (publishing.ts RESERVED_HANDLES) — defense in depth before the
  //      DB-level handle_reservations sentinel rows from migration 141.
  //   2. UI-route conflicting names that would shadow portal pages.
  // Keep this list in sync with packages/worker/src/handlers/publishing.ts
  // — both lists must include any new system reservation.
  const RESERVED = new Set([
    // Subdomain-conflicting (mirror Worker)
    'www', 'cdn', 'api', 'admin', 'app', 'mycelium', 'status', 'docs',
    'share', 'mail', 'static', 'public', 'auth', 'id', 'well-known',
    // UI-route conflicting (portal would render the wrong page)
    'support', 'system', 'vault', 'login', 'signup', 'profile',
    'settings', 'help', 'about', 'discover', 'connections',
  ]);
  const HANDLE_RE = /^[a-z0-9][a-z0-9_]{2,29}$/;

  return {
    async get(userId) {
      const result = await d1Query(
        `SELECT * FROM user_profiles WHERE user_id = ?`,
        [userId],
      );
      return result.results?.[0] || null;
    },

    async getByHandle(handle) {
      // d1QueryAdmin bypasses the user_id filter so the portal's
      // public profile page can resolve a handle → profile row.
      const result = await d1QueryAdmin(
        `SELECT * FROM user_profiles WHERE handle = ?`,
        [handle],
      );
      return result.results?.[0] || null;
    },

    async upsert(userId, data) {
      const fields = [];
      const values = [];
      const updates = [];
      for (const [k, v] of Object.entries(data)) {
        if (v !== undefined) {
          fields.push(k);
          values.push(v);
          updates.push(`${k} = excluded.${k}`);
        }
      }
      fields.push('user_id');
      values.push(userId);
      updates.push("updated_at = datetime('now')");

      const placeholders = fields.map(() => '?').join(', ');
      await d1Query(
        `INSERT INTO user_profiles (${fields.join(', ')}) VALUES (${placeholders})
         ON CONFLICT (user_id) DO UPDATE SET ${updates.join(', ')}`,
        values,
      );
    },

    async setHandle(userId, handle) {
      // Local format/reserved fast-checks. The Worker enforces the
      // canonical (DNS-compatible) format too; this duplicates for
      // fast-fail without a network hop and to keep the existing
      // error messages stable for portal-profile.test.js.
      if (!handle || !HANDLE_RE.test(handle)) {
        throw new Error('Handle must be 3-30 chars, lowercase alphanumeric + underscore');
      }
      if (RESERVED.has(handle)) {
        throw new Error('This handle is reserved');
      }

      // Step 1: claim via the typed Worker endpoint. The client
      // throws HandleTakenError on 409 and HandleInvalidError on
      // 400; we translate to the portal's existing error messages
      // for callers (portal-profile route maps these via safeError).
      // Fail-closed — if the Worker is unreachable, claim() throws
      // and we never reach Step 2 (no silent local-only success).
      try {
        await handles.claim(handle);
      } catch (e) {
        if (e?.code === 'already_claimed') {
          throw new Error('This handle is already taken');
        }
        if (e?.code === 'invalid_handle') {
          // Worker rejected on canonical format. The local pre-check
          // should have caught this, but keep the message coherent.
          throw new Error('Handle must be 3-30 chars, lowercase alphanumeric + underscore');
        }
        throw e;
      }

      // Step 2: write the handle to the local tenant profile (cache).
      // This used to also be the registry-write fallback; that role
      // is gone with PR 4 — Step 1 is authoritative. The local row
      // now is purely a denormalized display cache for the profile UI.
      await d1Query(
        `INSERT INTO user_profiles (user_id, handle, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT (user_id) DO UPDATE SET handle = excluded.handle, updated_at = datetime('now')`,
        [userId, handle],
      );
    },

    async computeFingerprint(userId) {
      // Territory + realm counts.
      const countResult = await d1Query(
        `SELECT
           COUNT(DISTINCT territory_id) as territory_count,
           COUNT(DISTINCT realm_id) as realm_count
         FROM territory_profiles WHERE user_id = ?`,
        [userId],
      );
      const counts = countResult.results?.[0] || {};

      // Message count + member since.
      const msgResult = await d1Query(
        `SELECT COUNT(*) as message_count, MIN(created_at) as member_since
         FROM messages WHERE user_id = ?`,
        [userId],
      );
      const msgs = msgResult.results?.[0] || {};

      // Realm names for public profile (fallback source).
      const realmResult = await d1Query(
        `SELECT DISTINCT realm_id, name FROM territory_profiles
         WHERE user_id = ? AND realm_id IS NOT NULL AND name IS NOT NULL
         ORDER BY realm_id`,
        [userId],
      );

      // Depth: avg message_count per territory as a proxy for engagement depth.
      // Normalized against 500 (saturates at avg 500 msgs/territory).
      const depthResult = await d1Query(
        `SELECT AVG(message_count) as avg_depth, MAX(message_count) as max_depth
         FROM territory_profiles WHERE user_id = ? AND message_count > 0`,
        [userId],
      );
      const depthData = depthResult.results?.[0] || {};
      const maxPossibleDepth = 500;
      const depthScore = Math.min(1, (depthData.avg_depth || 0) / maxPossibleDepth);

      // Breadth: territory count normalized against 300.
      const breadthScore = Math.min(1, (counts.territory_count || 0) / 300);

      // Coherence: fraction of territories that have a non-trivial chronicle
      // (chronicle > 10 chars) — proxy for narrative integration.
      const coherenceResult = await d1Query(
        `SELECT COUNT(*) as with_chronicle FROM territory_profiles
         WHERE user_id = ? AND chronicle IS NOT NULL AND LENGTH(chronicle) > 10`,
        [userId],
      );
      const withChronicle = coherenceResult.results?.[0]?.with_chronicle || 0;
      const coherenceScore = counts.territory_count > 0
        ? Math.min(1, withChronicle / counts.territory_count) : 0;

      // Exploration: Shannon entropy of realm distribution, normalized
      // against log2(realm_count) so max entropy = 1.0.
      const realmDistResult = await d1Query(
        `SELECT realm_id, COUNT(*) as count FROM territory_profiles
         WHERE user_id = ? AND realm_id IS NOT NULL GROUP BY realm_id`,
        [userId],
      );
      const realmDist = realmDistResult.results || [];
      const totalInRealms = realmDist.reduce((s, r) => s + r.count, 0);
      let entropy = 0;
      if (totalInRealms > 0) {
        for (const r of realmDist) {
          const p = r.count / totalInRealms;
          if (p > 0) entropy -= p * Math.log2(p);
        }
      }
      const maxEntropy = realmDist.length > 0 ? Math.log2(realmDist.length) : 1;
      const explorationScore = maxEntropy > 0 ? Math.min(1, entropy / maxEntropy) : 0;

      // Public realm names: prefer the realms table; fall back to distinct
      // territory.realm_id → name map when the realms table is empty.
      const realmNamesResult = await d1Query(
        `SELECT DISTINCT r.realm_id, r.name FROM realms r
         WHERE r.user_id = ? AND r.name IS NOT NULL`,
        [userId],
      );
      let publicRealms = (realmNamesResult.results || []).map(r => r.name).filter(Boolean);
      if (!publicRealms.length) {
        const realmMap = new Map();
        for (const r of (realmResult.results || [])) {
          if (r.realm_id != null && r.name && !realmMap.has(r.realm_id)) {
            realmMap.set(r.realm_id, r.name);
          }
        }
        publicRealms = [...realmMap.values()];
      }

      const profile = {
        depth_score:       Math.round(depthScore * 100) / 100,
        breadth_score:     Math.round(breadthScore * 100) / 100,
        coherence_score:   Math.round(coherenceScore * 100) / 100,
        exploration_score: Math.round(explorationScore * 100) / 100,
        territory_count:   counts.territory_count || 0,
        realm_count:       counts.realm_count || 0,
        message_count:     msgs.message_count || 0,
        member_since:      msgs.member_since || null,
        public_realms_json: JSON.stringify(publicRealms),
      };

      await this.upsert(userId, profile);
      return profile;
    },

    async setTerritoryVisibility(userId, territoryId, visibility) {
      if (!['private', 'friends', 'public'].includes(visibility)) {
        throw new Error('Visibility must be private, friends, or public');
      }
      await d1Query(
        `UPDATE territory_profiles SET visibility = ? WHERE user_id = ? AND territory_id = ?`,
        [visibility, userId, territoryId],
      );
    },

    async getPublicTerritories(userId) {
      const result = await d1Query(
        `SELECT territory_id, name, essence, visibility, realm_id, message_count
         FROM territory_profiles WHERE user_id = ? AND visibility IN ('public', 'friends')
         ORDER BY message_count DESC`,
        [userId],
      );
      return result.results || [];
    },
  };
}
