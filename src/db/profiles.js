/**
 * Profiles namespace — user-facing handle + public fingerprint
 * (depth/breadth/coherence/exploration scores, public realm names).
 *
 * HANDLE SETTING lived here (setHandle + a local format pre-check + a reserved
 * list) as a multi-tenant Worker artifact. It had ZERO callers in V1 and its
 * validation rule diverged from the DNS-safe one (it permitted underscores that
 * can never be a hostname). It has been removed — the ONE handle writer is
 * src/identity/handle-service.js (QA6 handle unification).
 *
 * `computeFingerprint` derives the public profile from territory +
 * realm counts, message count, chronicle fraction (coherence), and
 * realm-entropy (exploration). Result is stored via `this.upsert` so
 * callers can read it from the profile row.
 *
 * @typedef {object} ProfilesNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(sql: string, params: any[]) => Promise<any>} d1QueryAdmin — for handle lookups by handle (no user_id filter)
 */

export function createProfilesNamespace(deps) {
  if (!deps) throw new TypeError('createProfilesNamespace: deps required');
  const { d1Query, d1QueryAdmin } = deps;
  if (typeof d1Query !== 'function')      throw new TypeError('createProfilesNamespace: d1Query required');
  if (typeof d1QueryAdmin !== 'function') throw new TypeError('createProfilesNamespace: d1QueryAdmin required');

  // NOTE (QA6 handle unification): the handle SETTER + its reserved list + its
  // validation rule used to live here (setHandle, a second RESERVED set, and an
  // underscore-permitting HANDLE_RE that could never be a hostname). All of that
  // moved to the ONE writer, src/identity/handle-service.js, which validates via
  // the shared DNS-safe isValidHandle and carries the ONE reserved list. This
  // namespace's setHandle had ZERO callers (grep-proven) — it was a multi-tenant
  // Worker artifact (d1QueryAdmin / handle-client) never wired into V1's db
  // assembly — so it was removed rather than left as a divergent second rule.
  // The `handles` (cross-tenant handle-client) dep went with it: setHandle was its
  // only consumer, so requiring it here was a constructor gate on a capability
  // nothing used. createProfilesNamespace itself has zero callers in src/, tests/
  // and scripts/ today — it is kept only for the V2 multi-tenant port.
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

    // setHandle() removed — see the note above. The ONE writer is
    // src/identity/handle-service.js (claim against the control plane +
    // publicHost authority + derived user_profiles mirror).

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
