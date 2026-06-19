/**
 * Persona-Claims namespace — current person-level claims (PersonaTree "Root")
 * and their per-window snapshots (the "over time" series). Leaves = `messages`.
 *
 * Encryption boundary (verified src/adapter/d1.js + crypto-local.js):
 *   - person_claims sensitive cols (claim_type, content, confidence_logodds,
 *     decay_class, support) and person_claim_snapshots sensitive cols
 *     (confidence_logodds, content, evidence_count, delta_kind) are in
 *     ENCRYPTED_FIELDS → the adapter auto-encrypts the bound params on the FIRST
 *     VALUES group and auto-decrypts on read.
 *   - UPSERTs use `ON CONFLICT ... DO UPDATE SET col = excluded.col` (never a
 *     fresh `?`): autoEncryptParams only encrypts the first VALUES group and
 *     never inspects the ON CONFLICT clause — a bound `?` there would be written
 *     PLAINTEXT (mirrors the facts/messages namespaces).
 *   - confidence_logodds / evidence_count are numerics stored as encrypted
 *     strings; callers pass a JS number and Number()-coerce on read.
 *   - embedding_768 is a vector envelope (NEVER_AUTO_DECRYPT) — caller manages it.
 *
 * Local SQLite vault — single user. @see migrations/0011_persona_claims.sql,
 * docs/PERSONA-CLAIMS-DESIGN-2026-06-06.md.
 *
 * @typedef {object} ClaimsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 * @property {() => string} randomUUID
 */
export function createClaimsNamespace(deps) {
  if (!deps) throw new TypeError('createClaimsNamespace: deps required');
  const { d1Query, firstRow, randomUUID } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createClaimsNamespace: d1Query required');
  if (typeof firstRow !== 'function') throw new TypeError('createClaimsNamespace: firstRow required');
  if (typeof randomUUID !== 'function') throw new TypeError('createClaimsNamespace: randomUUID required');

  const num = (v) => (v == null ? null : Number(v));
  const rows = (res) => (Array.isArray(res) ? res : res?.results || []);
  const CLAIM_COLS =
    'id, subject, claim_type, content, confidence_logodds, decay_class, support, content_hash, status, '
    + 'last_evidence_at, created_at, updated_at, valid_from, valid_to, superseded_by, domain, variability, context_primary';

  /** Hydrate a decrypted person_claims row to a typed object (numbers coerced). */
  function toClaim(r) {
    if (!r) return null;
    let support = null;
    try { support = r.support ? JSON.parse(r.support) : null; } catch { support = null; }
    return {
      id: r.id,
      subject: r.subject,
      claimType: r.claim_type,
      content: r.content,
      confidenceLogodds: num(r.confidence_logodds),
      decayClass: r.decay_class,
      support,
      contentHash: r.content_hash,
      status: r.status,
      lastEvidenceAt: r.last_evidence_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      // bi-temporal + distribution (Phase 2a) — valid-time, the revision chain, and the
      // Whole-Trait params. variability/context_primary are the structured "distribution, not
      // point" fields; the full conditioning distribution rides support.contexts.
      validFrom: r.valid_from,
      validTo: r.valid_to,
      supersededBy: r.superseded_by,
      domain: r.domain,
      variability: num(r.variability),
      contextPrimary: r.context_primary,
    };
  }

  return {
    /**
     * Insert a new claim or update an existing one by id. The full row is
     * supplied each call (discovery recomputes it); mutable columns are taken
     * from `excluded` so the encrypt layer covers them. embedding_768 is bound
     * as an opaque envelope (caller-encrypted) or null.
     * @returns {Promise<{ id: string }>}
     */
    async upsert(c) {
      const id = c.id || randomUUID();
      // updated_at is bound as a param (all-? VALUES group, like facts/messages):
      // the adapter's write-rewriter only handles ? placeholders in VALUES, and a
      // bare strftime() literal there parses as a syntax error.
      // valid_from is the birth-of-validity — set on INSERT, IMMUTABLE on conflict (like created_at).
      // domain/variability/context_primary are mutable (re-distilled). valid_to/superseded_by are
      // owned by retract() (the revision chain), never by upsert.
      const res = await d1Query(
        `INSERT INTO person_claims
           (id, user_id, subject, claim_type, content, confidence_logodds, decay_class,
            support, content_hash, embedding_768, status, last_evidence_at,
            valid_from, domain, variability, context_primary, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           subject = excluded.subject,
           claim_type = excluded.claim_type,
           content = excluded.content,
           confidence_logodds = excluded.confidence_logodds,
           decay_class = excluded.decay_class,
           support = excluded.support,
           content_hash = excluded.content_hash,
           embedding_768 = excluded.embedding_768,
           status = excluded.status,
           last_evidence_at = excluded.last_evidence_at,
           domain = excluded.domain,
           variability = excluded.variability,
           context_primary = excluded.context_primary,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         RETURNING id`,
        [id, c.userId, c.subject ?? 'self', c.claimType ?? null, c.content ?? null,
          c.confidenceLogodds ?? null, c.decayClass ?? null,
          c.support != null ? JSON.stringify(c.support) : null,
          c.contentHash ?? null, c.embedding768 ?? null, c.status ?? 'active',
          c.lastEvidenceAt ?? null,
          c.validFrom ?? new Date().toISOString(), c.domain ?? null,
          c.variability ?? null, c.contextPrimary ?? null, new Date().toISOString()],
      );
      return { id: firstRow(res)?.id || id };
    },

    /** Active + currently-valid claims for getContext / retrieval — highest confidence first.
     * status='active' excludes pending (CVP gate) + superseded/archived; valid_to IS NULL = now-true. */
    async listActive(userId, { limit = 20 } = {}) {
      const res = await d1Query(
        `SELECT ${CLAIM_COLS} FROM person_claims
         WHERE user_id = ? AND status = 'active' AND valid_to IS NULL
         ORDER BY last_evidence_at DESC LIMIT ?`,
        [userId, limit]);
      // confidence_logodds is encrypted (can't ORDER BY it in SQL); recency-ordered
      // here, confidence-sorting happens JS-side after decrypt where needed.
      return rows(res).map(toClaim);
    },

    /** One claim by id (decrypted). */
    async getById(userId, id) {
      return toClaim(firstRow(await d1Query(
        `SELECT ${CLAIM_COLS} FROM person_claims WHERE user_id = ? AND id = ?`, [userId, id])));
    },

    /**
     * Claims used by the discovery identity-match step: active + rejected
     * tombstones (so a rejected claim is recognised and NOT resurrected). Returns
     * the raw embedding_768 envelope too (NEVER_AUTO_DECRYPT) for cosine match.
     */
    async listForMatch(userId) {
      const res = await d1Query(
        `SELECT ${CLAIM_COLS}, embedding_768 FROM person_claims
         WHERE user_id = ? AND status IN ('active','pending','rejected')`, [userId]);
      // 'pending' included (Phase 2): a fresh corroboration must MATCH a pending claim (raise its
      // confidence toward promotion), not create a duplicate of it.
      return rows(res).map((r) => ({ ...toClaim(r), embedding768: r.embedding_768 }));
    },

    /** Fast dedup/tombstone lookup by content hash. */
    async findByHash(userId, contentHash) {
      const res = await d1Query(
        `SELECT ${CLAIM_COLS} FROM person_claims WHERE user_id = ? AND content_hash = ? LIMIT 1`,
        [userId, contentHash]);
      return toClaim(firstRow(res));
    },

    /** Set a claim's status (pending|active|archived|superseded|rejected). */
    async setStatus(userId, id, status) {
      await d1Query(
        `UPDATE person_claims SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE user_id = ? AND id = ?`, [status, userId, id]);
      return { id, status };
    },

    /**
     * AGM contraction (Phase 2a): CLOSE a claim's validity + link its successor — never overwrite,
     * never delete. valid_to marks when it ceased being true; superseded_by points at the new row.
     * The old row stays (status='superseded') as the audit trail. `boundary` claims are caller-gated
     * (the lifecycle refuses to auto-retract a safety boundary).
     */
    async retract(userId, id, { validTo = null, supersededBy = null, status = 'superseded' } = {}) {
      const vt = validTo ?? new Date().toISOString();
      await d1Query(
        `UPDATE person_claims
           SET status = ?, valid_to = ?, superseded_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE user_id = ? AND id = ?`,
        [status, vt, supersededBy, userId, id]);
      return { id, status, validTo: vt, supersededBy };
    },

    /** Promote a pending claim to active — the SPRT promotion bar cleared (§1). Idempotent: only fires
     * from 'pending'. */
    async promote(userId, id) {
      await d1Query(
        `UPDATE person_claims SET status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE user_id = ? AND id = ? AND status = 'pending'`,
        [userId, id]);
      return { id, status: 'active' };
    },

    /**
     * VALID-time AS-OF: the claims TRUE of the user at `date`. getContext uses date=now → currently-
     * true active claims (a since-superseded claim has valid_to<=now → excluded by the interval).
     * A historical date returns what was true THEN, including since-superseded claims (set
     * includeArchived to also surface low-confidence-archived ones for an audit replay). pending
     * (CVP-gated) and rejected (tombstones) are never returned. NULL valid_from = always-having-been.
     */
    async asOf(userId, date, { includeArchived = false } = {}) {
      const excluded = includeArchived ? "('pending','rejected')" : "('pending','rejected','archived')";
      const res = await d1Query(
        `SELECT ${CLAIM_COLS} FROM person_claims
         WHERE user_id = ? AND status NOT IN ${excluded}
           AND (valid_from IS NULL OR valid_from <= ?)
           AND (valid_to IS NULL OR valid_to > ?)
         ORDER BY last_evidence_at DESC`,
        [userId, date, date]);
      return rows(res).map(toClaim);
    },

    /**
     * Per-change TRANSACTION-time record (Phase 2a, the D fix): one row per assertion change so the
     * belief axis is GAPLESS (the periodic per-window snapshots left intermediate revisions invisible).
     * granularity='change', window=the change instant, delta_kind=the op (added|corroborated|weakened|
     * retracted|promoted|superseded). Same-ms collisions DO UPDATE (a non-issue in a single-user
     * nightly system).
     */
    async recordChange(s) {
      const id = s.id || randomUUID();
      const at = s.at || new Date().toISOString();
      await d1Query(
        `INSERT INTO person_claim_snapshots
           (id, user_id, claim_id, window_start, window_end, granularity,
            confidence_logodds, content, evidence_count, delta_kind)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id, claim_id, window_end, granularity) DO UPDATE SET
           confidence_logodds = excluded.confidence_logodds, content = excluded.content,
           evidence_count = excluded.evidence_count, delta_kind = excluded.delta_kind,
           computed_at = datetime('now')`,
        [id, s.userId, s.claimId, at, at, 'change',
          s.confidenceLogodds ?? null, s.content ?? null, s.evidenceCount ?? null, s.deltaKind ?? null]);
      return { id, at };
    },

    /** TRANSACTION-time AS-OF replay: what we BELIEVED about a claim at `date` (the per-change log). */
    async believedAsOf(userId, claimId, date) {
      const r = firstRow(await d1Query(
        `SELECT window_end, confidence_logodds, content, delta_kind FROM person_claim_snapshots
         WHERE user_id = ? AND claim_id = ? AND granularity = 'change' AND window_end <= ?
         ORDER BY window_end DESC LIMIT 1`,
        [userId, claimId, date]));
      if (!r) return null;
      return { at: r.window_end, confidenceLogodds: num(r.confidence_logodds), content: r.content, deltaKind: r.delta_kind };
    },

    /**
     * Upsert a per-window snapshot (clone of frequency_snapshots semantics).
     * Conflict target is the UNIQUE(user_id, claim_id, window_end, granularity).
     */
    async writeSnapshot(s) {
      const id = s.id || randomUUID();
      await d1Query(
        `INSERT INTO person_claim_snapshots
           (id, user_id, claim_id, window_start, window_end, granularity,
            confidence_logodds, content, evidence_count, delta_kind)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id, claim_id, window_end, granularity) DO UPDATE SET
           confidence_logodds = excluded.confidence_logodds,
           content = excluded.content,
           evidence_count = excluded.evidence_count,
           delta_kind = excluded.delta_kind,
           computed_at = datetime('now')`,
        [id, s.userId, s.claimId, s.windowStart, s.windowEnd, s.granularity ?? 'week',
          s.confidenceLogodds ?? null, s.content ?? null, s.evidenceCount ?? null, s.deltaKind ?? null]);
      return { id };
    },

    /**
     * Time series for one claim at a granularity, oldest→newest (clones the
     * /portal/frequency/series read). Numbers coerced; nulls preserved so the
     * UI can break the line (honest gaps).
     */
    async readSeries(userId, claimId, granularity = 'week', { limit = 180 } = {}) {
      const res = await d1Query(
        `SELECT window_start, window_end, granularity, confidence_logodds, content,
                evidence_count, delta_kind, computed_at
         FROM person_claim_snapshots
         WHERE user_id = ? AND claim_id = ? AND granularity = ?
         ORDER BY window_end ASC LIMIT ?`,
        [userId, claimId, granularity, limit]);
      return rows(res).map((r) => ({
        windowStart: r.window_start,
        windowEnd: r.window_end,
        granularity: r.granularity,
        confidence: num(r.confidence_logodds) == null ? null : 1 / (1 + Math.exp(-num(r.confidence_logodds))),
        confidenceLogodds: num(r.confidence_logodds),
        content: r.content,
        evidenceCount: num(r.evidence_count),
        deltaKind: r.delta_kind,
        computedAt: r.computed_at,
      }));
    },

    /**
     * Latest snapshot window_end for a granularity — drives the heartbeat's
     * window-roll-over check. window_end is plaintext so MAX() works in SQL.
     * @returns {Promise<string|null>}
     */
    async lastSnapshotWindow(userId, granularity) {
      const res = await d1Query(
        `SELECT MAX(window_end) AS w FROM person_claim_snapshots
         WHERE user_id = ? AND granularity = ?`, [userId, granularity]);
      return firstRow(res)?.w ?? null;
    },
  };
}

export default createClaimsNamespace;
