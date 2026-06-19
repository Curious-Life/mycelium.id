/**
 * People namespace — user's contact graph.
 *
 * DEDUP BY NAME (not SQL ON CONFLICT): contact names are encrypted with
 * a per-envelope random IV, so identical plaintext names produce
 * different ciphertexts every time. SQL ON CONFLICT can't see through
 * that. Instead the caller loads a decrypted name→id index first with
 * `loadNameIndex`, then the `upsert` method checks plaintext matches.
 *
 * Reads use d1QueryAdmin so auto-decrypt can see every row across
 * tenants (rows are already scoped by user_id).
 *
 * @typedef {object} PeopleNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(sql: string, params: any[]) => Promise<any>} d1QueryAdmin
 */

export function createPeopleNamespace(deps) {
  if (!deps) throw new TypeError('createPeopleNamespace: deps required');
  const { d1Query, d1QueryAdmin } = deps;
  if (typeof d1Query !== 'function')      throw new TypeError('createPeopleNamespace: d1Query required');
  if (typeof d1QueryAdmin !== 'function') throw new TypeError('createPeopleNamespace: d1QueryAdmin required');

  return {
    /** Decrypted name → id map. Call once before bulk upserts. */
    async loadNameIndex(userId) {
      const result = await d1QueryAdmin(
        `SELECT id, name FROM people WHERE user_id = ?`,
        [userId],
      );
      const map = new Map();
      for (const r of result.results || []) {
        if (r.name) map.set(r.name, r.id);
      }
      return map;
    },

    /**
     * Upsert a contact. Uses a pre-loaded name index for dedup because
     * encryption produces different ciphertext per row.
     */
    async upsert(record, nameIndex) {
      const {
        user_id, name, source, linkedin_url, email, phone, company, position,
        connected_at, last_interaction_at, interaction_count, status,
      } = record;

      const existingId = nameIndex?.get(name);

      if (existingId) {
        await d1Query(
          `UPDATE people SET
             linkedin_url = COALESCE(NULLIF(?, ''), linkedin_url),
             email = COALESCE(NULLIF(?, ''), email),
             phone = COALESCE(NULLIF(?, ''), phone),
             company = COALESCE(NULLIF(?, ''), company),
             position = COALESCE(NULLIF(?, ''), position),
             connected_at = COALESCE(?, connected_at),
             last_interaction_at = CASE WHEN ? > COALESCE(last_interaction_at, '') THEN ? ELSE last_interaction_at END,
             interaction_count = MAX(COALESCE(?, 0), COALESCE(interaction_count, 0)),
             source = CASE WHEN source = 'manual' THEN ? ELSE source END
           WHERE id = ?`,
          [
            linkedin_url || null, email || null, phone || null, company || null,
            position || null, connected_at || null,
            last_interaction_at || null, last_interaction_at || null,
            interaction_count || 0, source || 'manual', existingId,
          ],
        );
      } else {
        await d1Query(
          `INSERT INTO people (id, user_id, name, source, linkedin_url, email, phone, company, position, connected_at, last_interaction_at, interaction_count, status)
           VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            user_id, name, source || 'manual', linkedin_url || null, email || null, phone || null,
            company || null, position || null, connected_at || null,
            last_interaction_at || null, interaction_count || 0, status || 'connected',
          ],
        );
        // Mark pending so subsequent upserts in the same batch don't re-insert.
        if (nameIndex) nameIndex.set(name, 'pending');
      }
    },

    async getBySource(userId, source) {
      const result = await d1QueryAdmin(
        `SELECT id, name, linkedin_url, email, status FROM people WHERE user_id = ? AND source = ?`,
        [userId, source],
      );
      return result.results || [];
    },

    async updateDescription(contactId, userId, descriptionJson) {
      await d1Query(
        `UPDATE people SET description = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
        [descriptionJson, contactId, userId],
      );
    },
  };
}
