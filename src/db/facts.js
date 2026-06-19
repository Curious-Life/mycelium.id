import { createHash } from 'node:crypto';
import { clampLimit } from './column-guard.js';

// Keep-last-N bound on fact version rows per (user,category,key) — an injection loop of
// overwrites must not grow the vault without bound (red-team HIGH-1; mirrors documents).
const FACT_VERSION_KEEP = 50;

/**
 * Facts namespace — typed durable truths the agent should always know.
 *
 * A fact is (category, key) -> value, e.g. identity/name -> "Alex". Written via
 * the `remember` verb (upsert on the UNIQUE (user_id, category, key) target),
 * surfaced in getContext + searchMindscape({scope:'facts'}), curated via the
 * unified forget/mark verbs ({type:'fact', id}).
 *
 * Encryption boundary (verified src/adapter/d1.js + crypto-local.js):
 *   - `value` is in ENCRYPTED_FIELDS.facts, so the adapter auto-encrypts the
 *     bound `value` param on INSERT and auto-decrypts it on read.
 *   - The upsert MUST use `ON CONFLICT ... DO UPDATE SET value = excluded.value`
 *     (never a fresh `?`): autoEncryptParams only encrypts params in the first
 *     VALUES group and never inspects the ON CONFLICT clause — a bound `?` there
 *     would be written PLAINTEXT and would also break the param/row math.
 *   - redact() nulls `value` with a LITERAL NULL (no param) so the encrypt layer
 *     is a no-op on it (mirrors messages.redact).
 *
 * Local SQLite vault — single user. @see migrations/0005_facts.sql
 *
 * @typedef {object} FactsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 * @property {() => string} randomUUID
 */
export function createFactsNamespace(deps) {
  if (!deps) throw new TypeError('createFactsNamespace: deps required');
  const { d1Query, firstRow, randomUUID } = deps;
  if (typeof d1Query !== 'function')   throw new TypeError('createFactsNamespace: d1Query required');
  if (typeof firstRow !== 'function')  throw new TypeError('createFactsNamespace: firstRow required');
  if (typeof randomUUID !== 'function') throw new TypeError('createFactsNamespace: randomUUID required');

  const LIVE_COLS = 'id, category, key, value, pinned, sensitive, confidence, updated_at';

  return {
    /**
     * Upsert a fact on (user_id, category, key). Re-remembering an existing
     * key supersedes its value in place; re-remembering a FORGOTTEN key
     * restores it (clears forgotten_at) with the new value — a deliberate
     * re-assertion. Salience (pinned/sensitive) is NOT touched here; the
     * `remember` tool applies it via setSalience when provided, so the
     * separation "remember = value, mark = salience" holds.
     *
     * @returns {Promise<{ id: string, status: 'created'|'updated'|'restored' }>}
     */
    async upsert({ userId, category, key, value, confidence = 'stated', source = 'user', trigger, reason } = {}) {
      // Prior state (incl. a forgotten husk + the prior value) for an accurate
      // status/UX message AND overwrite recoverability.
      const prior = firstRow(await d1Query(
        `SELECT id, value, confidence, forgotten_at FROM facts WHERE user_id = ? AND category = ? AND key = ?`,
        [userId, category, key],
      ));
      // RT2-H1 overwrite recoverability (migration 0034): snapshot the PRIOR value
      // into fact_versions (encrypted) before a content-changing overwrite, so a
      // poisoned/mistaken `remember` is recoverable. A fresh fact (no prior), a
      // restore of a forgotten husk, and an identical re-assertion capture nothing.
      // Non-fatal + isolated — never deny an owner-authorized write; no plaintext logged.
      if (prior && !prior.forgotten_at && value !== undefined && value !== prior.value) {
        try {
          await d1Query(
            `INSERT INTO fact_versions (user_id, fact_id, category, key, value, confidence, trigger, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, prior.id, category, key, prior.value ?? null, prior.confidence ?? null, trigger || 'overwrite', reason ?? null],
          );
          // Bound growth (red-team HIGH-1): keep most-recent N versions per (user,category,key).
          await d1Query(
            `DELETE FROM fact_versions WHERE user_id = ? AND category = ? AND key = ? AND id NOT IN (
               SELECT id FROM fact_versions WHERE user_id = ? AND category = ? AND key = ?
               ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
            [userId, category, key, userId, category, key, FACT_VERSION_KEEP],
          );
        } catch (e) {
          console.warn(`[fact-version] prior-snapshot capture failed: ${e?.code || e?.name || 'error'}`);
        }
      }
      const id = prior?.id || randomUUID();
      const res = await d1Query(
        `INSERT INTO facts (id, user_id, category, key, value, confidence, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, category, key) DO UPDATE SET
           value = excluded.value,
           confidence = excluded.confidence,
           source = excluded.source,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           forgotten_at = NULL
         RETURNING id`,
        [id, userId, category, key, value, confidence, source],
      );
      const rowId = firstRow(res)?.id || id;
      const status = !prior ? 'created' : (prior.forgotten_at ? 'restored' : 'updated');
      return { id: rowId, status };
    },

    /**
     * Live facts for the getContext FACTS section: pinned first, then by
     * category, then most-recently-updated. Capped. value auto-decrypted.
     *
     * Excludes sensitive=1 — getContext is the always-on proactive preamble,
     * and `sensitive` means "keep out of proactive recall" (§3.6). Sensitive
     * facts remain available via the explicit searchMindscape({scope:'facts'})
     * listing (see list()).
     */
    async forContext({ userId, limit = 30 }) {
      const res = await d1Query(
        `SELECT ${LIVE_COLS} FROM facts
         WHERE user_id = ? AND forgotten_at IS NULL AND sensitive = 0
         ORDER BY pinned DESC, category ASC, updated_at DESC
         LIMIT ?`,
        [userId, limit],
      );
      return res?.results || [];
    },

    /**
     * List live facts (optionally filtered to one category) — the
     * searchMindscape({scope:'facts'}) surface. value auto-decrypted.
     */
    async list({ userId, category = null, limit = 100 }) {
      const params = [userId];
      let where = 'user_id = ? AND forgotten_at IS NULL';
      if (category) { where += ' AND category = ?'; params.push(category); }
      params.push(limit);
      const res = await d1Query(
        `SELECT ${LIVE_COLS} FROM facts WHERE ${where}
         ORDER BY pinned DESC, category ASC, key ASC LIMIT ?`,
        params,
      );
      return res?.results || [];
    },

    /**
     * Soft-redact (forget) a fact: null `value`, stamp forgotten_at, keep the
     * husk (id + category/key + timestamps) for audit + UNIQUE anti-collision.
     * Returns the pre-redaction value hash + length for the audit ledger —
     * NEVER the plaintext. Idempotent on an already-forgotten fact.
     *
     * @returns {Promise<{found:boolean, alreadyForgotten?:boolean, contentHash:string|null, length:number}>}
     */
    async redact(id, userId) {
      const row = firstRow(await d1Query(
        `SELECT value, forgotten_at FROM facts WHERE id = ? AND user_id = ?`,
        [id, userId],
      ));
      if (!row) return { found: false, contentHash: null, length: 0 };
      if (row.forgotten_at) return { found: true, alreadyForgotten: true, contentHash: null, length: 0 };
      const value = row.value ?? '';
      const contentHash = createHash('sha256').update(value, 'utf8').digest('hex');
      await d1Query(
        `UPDATE facts SET value = NULL, forgotten_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ? AND user_id = ?`,
        [id, userId],
      );
      return { found: true, contentHash, length: value.length };
    },

    /**
     * Set user-asserted salience on a fact. Forgotten husks are immutable
     * (excluded by the WHERE); RETURNING detects a live match. pinned/sensitive
     * are plaintext integers — not encrypted.
     *
     * @param {{pinned?:boolean, sensitive?:boolean}} flags
     */
    async setSalience(id, userId, { pinned, sensitive } = {}) {
      const sets = [];
      const params = [];
      if (pinned !== undefined)    { sets.push('pinned = ?');    params.push(pinned ? 1 : 0); }
      if (sensitive !== undefined) { sets.push('sensitive = ?'); params.push(sensitive ? 1 : 0); }
      if (!sets.length) return { found: true, changed: false };
      params.push(id, userId);
      const res = await d1Query(
        `UPDATE facts SET ${sets.join(', ')} WHERE id = ? AND user_id = ? AND forgotten_at IS NULL RETURNING id`,
        params,
      );
      const hit = firstRow(res);
      return { found: !!hit, changed: !!hit };
    },

    // ── RT2-H1 recovery (migration 0034) ────────────────────────────────

    /**
     * Prior values of a fact (category/key), captured before each overwrite,
     * newest first. `value` auto-decrypts. The recovery half of the owner-write
     * grant: an owner can see what a poisoned `remember` overwrote and restore it.
     */
    async listVersions({ userId, category, key, limit = 20 }) {
      const res = await d1Query(
        `SELECT id, value, confidence, trigger, reason, created_at FROM fact_versions
         WHERE user_id = ? AND category = ? AND key = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        [userId, category, key, clampLimit(limit, 20, 200)],
      );
      return res?.results || [];
    },

    /**
     * Restore a prior fact version's value. Routes through upsert() so the CURRENT
     * value is snapshotted first — reversible. Returns the restore status or null.
     */
    async restoreVersion(userId, versionId) {
      const v = firstRow(await d1Query(
        `SELECT category, key, value, confidence FROM fact_versions WHERE id = ? AND user_id = ?`,
        [versionId, userId],
      ));
      if (!v) return null;
      const { id, status } = await this.upsert({
        userId, category: v.category, key: v.key, value: v.value,
        confidence: v.confidence || 'stated', trigger: 'restore', reason: `restore ${versionId}`,
      });
      return { id, status, category: v.category, key: v.key };
    },
  };
}
