import { createHash } from 'node:crypto';
import { assertSafeColumns, clampLimit } from './column-guard.js';
import { buildAgentIdFilter, resolveAgentIds } from '../agent-id-aliases.js';
import { bustMindscapePoints } from '../mindscape-cache.js';

/**
 * The statement `markForReembed` runs. EXPORTED so `verify:reembed-derived-text` can EXPLAIN
 * QUERY PLAN the SQL THAT SHIPS rather than a hand-copied lookalike — a gate that plans against
 * its own copy stays green through any future edit to the real WHERE, including one that drops
 * `user_id` and full-scans (this repo's rule: "the gate exercises the statement that ships, not
 * a copy", enrich/drainer.js).
 *
 * ⛔ THE CATEGORIZE STAGE IS RESET WITH THE EMBED STAGE, AND IT IS NOT COSMETIC (D-047 ↻1).
 * `selectPendingCategories` enforces "embed before categorize" only for rows that are still
 * UNTAGGED — an already-tagged row (`categories_processed = 1`) is never re-selected, so nulling
 * its vector alone mints a row counted as `tagged` and NOT counted as `embedded`:
 * `tagged > embedded` produced directly by the DAL, with no scheduler involved. That is exactly
 * what `updateContent` was fixed to stop doing (gate verify:compute-lanes C17b) and what
 * `restoreTable` was fixed to stop doing (C17c). This writer is the fourth path into that state
 * and must not reopen it. Adversarial review, 2026-07-27, reproduced as `tagged=2 embedded=1`.
 *
 * ⚠️ BUT THE LABEL VALUES ARE KEPT, DELIBERATELY DIVERGING FROM `updateContent`. There, the
 * message CONTENT changed, so the labels were "stale by definition". Here the body is untouched —
 * only the attachment's derived text arrived — and `selectPendingCategories` projects `content`
 * alone, so re-running L1 recomputes the SAME domain/register from the SAME input. Nulling them
 * would blank a still-correct answer and leave the note unlabelled in the UI until L1 came back
 * around. So: the FLAG is reset (the invariant is structural and must hold), the VALUES ride
 * until the re-run overwrites them, and `categorized_at` is cleared because the old timestamp
 * would no longer describe the current attempt.
 *
 * ⚠️ `content != ''` MIRRORS THE DRAIN PREDICATE. `selectPendingEnrichment` requires non-empty
 * content, so re-queueing a content-empty row would strand it: nulled, never re-selected, and
 * invisible to all three backlog counters (which carry the same clause) — the
 * verify:enrich-backlog-parity bug class. Such rows exist: full-export-import's vector pass can
 * land a vector on one, and local-files-import writes `content: ''` for media files.
 */
export const MARK_FOR_REEMBED_SQL =
  `UPDATE messages
      SET embedding_768 = NULL, nlp_processed = 0, nlp_error = NULL,
          nlp_processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          categories_processed = 0, categorized_at = NULL
    WHERE user_id = ?
      AND attachment_id = ?
      AND forgotten_at IS NULL
      AND embedding_768 IS NOT NULL
      AND content IS NOT NULL AND content != ''
  RETURNING id`;
import { purgeDerived } from '../core/delete-cascade.js';
import { unlinkBlobIfUnreferenced } from '../ingest/blob-store.js';

/**
 * Backfill sentinel for categorized_at (0041 provenance). Stamped by restampLegacyCategories
 * onto LEGACY/external-backfill rows that were tagged (categories_processed = 1) before
 * provenance tracking existed. The Unix epoch is an honest "tagged in the past, true time
 * unknown" marker — never a real categorization time — so the UI can tell a genuine recent
 * stamp apart from a backfilled one. Distinct from strftime('now'): stamping now() on a row
 * tagged long ago would lie about when the categorization actually happened.
 */
export const CATEGORIES_BACKFILL_SENTINEL = '1970-01-01T00:00:00.000Z';

/**
 * Read AGENT_SCOPES env at call time. Returns null in admin mode
 * (unset / unparseable) so backfill scripts that import this namespace
 * with no AGENT_SCOPES still see every scope. Returns an array of
 * scope strings otherwise — used as the default SQL-level filter in
 * selectRecent / selectTimeline so an agent never even fetches rows
 * outside its bound scopes (defense in depth above crypto-local's
 * decrypt-time scope guardian, which leaves ciphertext on deny and
 * showed up as encrypted strings in the portal after the moms-scope
 * isolation fix on 2026-05-28).
 */
function _envAllowedScopes() {
  const raw = process.env.AGENT_SCOPES;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Messages namespace — the hottest write path in the system.
 *
 * Every agent inbound / outbound, every Discord / Telegram / WhatsApp
 * message, every portal chat — they all land here. The namespace
 * handles insertion (single + batched with D1 param-limit splitting),
 * pagination, agent+scope filtering, timeline reads, and hybrid
 * (FTS5 + vector) search.
 *
 * `selectByAgent` and `listAgentIds` read process.env.MYA_USER_ID as
 * the tenant id. That coupling to env is preserved from the
 * pre-extraction code — tenant resolution happens at the caller.
 *
 * Wave 4b (2026-05-04): vectorQuery + hybridSearch deps removed.
 * matchMessages uses mind-search; matchDocuments uses scan-matchers.
 * Legacy Vectorize + Worker hybrid path retired with the BGE shutdown.
 *
 * @typedef {object} MessagesNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(statements: Array<{sql: string, params: any[]}>) => Promise<any[]>} d1Batch
 * @property {(result: any) => any} firstRow
 */

export function createMessagesNamespace(deps) {
  if (!deps) throw new TypeError('createMessagesNamespace: deps required');
  const { d1Query, d1Batch, firstRow } = deps;
  // `now` injectable for the backlog-cache gates; the default reads the GLOBAL
  // Date.now at call time (not a captured reference) so clock-mocking gates
  // (verify-enrich-backlog-parity) keep working.
  const now = deps.now || (() => Date.now());
  if (typeof d1Query !== 'function')      throw new TypeError('createMessagesNamespace: d1Query required');
  if (typeof d1Batch !== 'function')      throw new TypeError('createMessagesNamespace: d1Batch required');
  if (typeof firstRow !== 'function')     throw new TypeError('createMessagesNamespace: firstRow required');

  // Minimal db facade for the shared delete cascade (src/core/delete-cascade.js):
  // purgeDerived only ever touches db.rawQuery, and this namespace is constructed
  // before the assembled `db` object exists.
  const cascadeDb = { rawQuery: (sql, params = []) => d1Query(sql, params) };

  // SWR cache for embedBacklog (see the method below). The count is a full-table
  // scan over the large, at-rest-encrypted messages table (multiple seconds on a
  // big vault — SQLCipher page-decrypt), and it is polled HARD: the activity feed
  // every 2.5s, plus processing-status and the compat shim. Recomputing per call
  // made a multi-second query arrive faster than it finishes → the single Node
  // thread's microtask/macrotask queue grew without bound → the app hung at boot
  // (observed: identical queries climbing 4.6s→43s as the backlog of requests grew).
  // Cache the last result + revalidate in the background under a single-flight latch
  // so at most ONE scan runs per window and no caller ever queues behind another.
  // Per-process (one server-rest owns the pollers); keyed by userId defensively.
  let _backlog = null;          // { userId, value:{embedded,total,pending,unprocessable}, at:ms, gen }
  let _backlogInFlight = null;  // Promise while a recompute runs (single-flight)
  // D-132 fast-half — the WRITE-GENERATION gate over all three polled backlog caches.
  // The SWR caches above bound the scan rate, but a TTL alone still RE-RUNS the
  // multi-second SQLCipher full-table decrypt on every expiry even when NOTHING has
  // written — the operator's idle 67k-message vault burned a core in bursts forever,
  // just from the activity feed polling @2.5s. The backlog numbers are pure functions
  // of the messages table, so a poll on a write-quiescent vault can serve the last
  // scan's value indefinitely: every write path bumps `_backlogGen` (every mutating
  // method in this namespace, uniformly — plus the out-of-namespace raw writers:
  // drainer reclaim/self-heal and full-export-import's vector pass / restore, via
  // noteBacklogWrite()). A poll only rescans when the generation moved (TTL pacing
  // unchanged) or when the RECONCILE FLOOR expires — drift insurance for a writer
  // this net misses (e.g. a future dynamic-SQL restore path): a missed bump can make
  // the numbers at most 15 min stale, never forever-wrong (the QA P1-C staleness
  // class). The scan stores the generation captured at its START, so a write racing
  // a scan invalidates the result conservatively.
  let _backlogGen = 0;
  const bumpBacklogGen = () => { _backlogGen += 1; };
  const BACKLOG_RECONCILE_FLOOR_MS = 15 * 60 * 1000;
  // `pending` is COUNTED, never projected. It mirrors selectPendingEnrichment's
  // predicate EXACTLY (nlp_processed 0/NULL + content-bearing) so it counts the work
  // the drainer will actually pick up — and therefore REACHES 0.
  //
  // It used to be `total - embedded`, an arithmetic projection, which could never
  // reach 0 while any row was content-bearing but permanently un-embeddable: a
  // blank-content skip (whitespace-only content passes `content != ''` but service.js
  // trims it and marks nlp_processed = 1) and a row embedded-but-awaiting-L2
  // (nlp_processed = 2) are never re-selected, so the projection pinned
  // "Embedding N of M" forever — indistinguishable from a healthy vault still
  // working. @see the data-readiness design §3.3.
  //
  // (An earlier draft of this comment also listed "a genuine poison row (nlp_processed
  // = -1 kept by the self-heal's 'expected 768' exclusion)". That exclusion is GONE —
  // the drainer now re-queues every -1 row with no dim-mismatch carve-out. A -1 row is
  // therefore transient, not a permanent resident of the gap. Corrected 2026-07-15.)
  //
  // The residue (total - embedded - pending) is `unprocessable`: content-bearing rows
  // that are neither done nor queued. SURFACED as a count, never hidden — and a COUNT
  // ONLY, because a per-message failure reason is not something a progress indicator
  // should carry.
  //   ⚠️ An earlier draft justified count-only with "nlp_error is in ENCRYPTED_FIELDS
  //   because it can reveal failure patterns" — quoting crypto-local.js prose that sat
  //   directly above `messages: []`. It is NOT encrypted; nothing in `messages` is,
  //   post-collapse. That prose described the PRE-collapse design and has since been
  //   deleted as stale. The design is unchanged (a count is still the right surface);
  //   only the reason was wrong. Do not re-derive a guarantee from that sentence.
  //
  // LOAD-BEARING INVARIANT: a row can never be counted in BOTH `embedded` and `pending`,
  // because embedding_768 and nlp_processed are always written TOGETHER. updateEnrichment
  // ENFORCES it (`nlpProcessed` is required — it throws otherwise); full-export-import's
  // vector pass calls this one table with flipNlp=true (vector + nlp_processed=1 in a single
  // UPDATE); and `markForReembed` below — the third and newest writer (2026-07-26, late
  // transcripts) — sets `embedding_768 = NULL` and `nlp_processed = 0` in the SAME statement
  // for exactly this reason. That row then counts as `pending` and NOT as `embedded`, which
  // is the honest reading: its old vector described the filename, not the speech. If that
  // invariant is ever broken, such a row would inflate both counts and `unprocessable`
  // would clamp at 0 (hence the Math.max) — the drainer would then re-embed it and heal
  // the state on its next cycle. Tests must set both columns; a raw UPDATE that sets only
  // embedding_768 fabricates a state the codebase makes impossible.
  async function _computeEmbedBacklog(userId) {
    // `gaveUp` counts the attempt-capped rows (enrich/service.js EMBED_CAPPED_MARK:
    // nlp_processed = -1 + nlp_error 'embed-capped:N'). A subset of `unprocessable`,
    // surfaced separately so the status route can offer a content-free retry
    // (POST /portal/enrichment/retry-failed). Same single scan — no extra cost on
    // this polled, SWR-cached query. A count ONLY, never a reason (§1).
    const r = await d1Query(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN embedding_768 IS NOT NULL THEN 1 ELSE 0 END), 0) AS embedded,
         COALESCE(SUM(CASE WHEN (nlp_processed = 0 OR nlp_processed IS NULL) THEN 1 ELSE 0 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN nlp_processed = -1 AND nlp_error LIKE 'embed-capped:%' THEN 1 ELSE 0 END), 0) AS gave_up
       FROM messages
       WHERE user_id = ?
         AND forgotten_at IS NULL
         AND content IS NOT NULL AND content != ''`,
      [userId],
    );
    const row = (r.results || [])[0] || {};
    const total = Number(row.total || 0);
    const embedded = Number(row.embedded || 0);
    const pending = Number(row.pending || 0);
    const gaveUp = Number(row.gave_up || 0);
    return { embedded, total, pending, unprocessable: Math.max(0, total - embedded - pending), gaveUp };
  }

  // SWR cache for the Context Engine L1 categorization backlog — same shape and same
  // hazard as the embed backlog above (a full-table scan, polled @2.5s by the activity
  // feed). Categorization runs CONTINUOUSLY on a timer (drainer), not as a discrete
  // background_jobs row, so the activity feed projects it at read-time from this count
  // (mirrors embedProjection). Separate latch so the two scans never block each other.
  //
  // `pending` here is COUNTED with selectPendingCategories' exact predicate
  // (categories_processed 0/NULL), NOT projected as `total - tagged`. The projection was
  // correct only while the column was strictly binary (0/NULL pending, 1 attempted —
  // migration 0038), and the previous version of this comment carried the trap warning
  // verbatim: "Adding a failure state (say -1) WITHOUT switching to a counted predicate
  // would reintroduce the stuck-forever bug here, identically." The label-gave-up terminal
  // state (categories_processed = -1, enrich/service.js LABEL_MAX_ATTEMPTS) is exactly that
  // -1 — so this switched to the counted predicate the warning demanded, in the same change.
  // A -1 row is neither tagged nor pending; it is surfaced as `gaveUp` (a count only) so the
  // categorize status route can offer the retry surface instead of silently omitting it.
  //
  // ⚠️ AND `pending` NOW CARRIES THE STAGE-ORDERING CLAUSE TOO (D-047 ↻1). selectPendingCategories
  // gained `AND embedding_768 IS NOT NULL` — the structural "embed before categorize" invariant
  // (read its header for why). This count MUST carry the same clause or it re-creates the exact
  // stuck-forever bug the paragraph above warns about, in the same file, one release later: a
  // `pending` that counts rows the drain will never select can never reach 0.
  //
  // The rows that clause holds back are NOT silently dropped — they split into two honest,
  // separately-reported buckets, because they mean different things and only one of them clears
  // on its own:
  //   • blockedOnEmbed — untagged, no vector, and STILL IN THE EMBED QUEUE (nlp_processed 0/NULL).
  //     Transient. It is what makes the categorize stage render "waiting for embedding" instead of
  //     a silent `done` while thousands of rows wait — the dormancy class this file exists to
  //     prevent. Without it, `pending: 0` during a large import would read as "caught up".
  //   • unembeddable — untagged, no vector, and the embed stage ATTEMPT-CAPPED them (-1). They will
  //     never become categorizable on their own, so counting them in blockedOnEmbed would peg
  //     "waiting for embedding" above zero forever. Recoverable exactly like their embed-side
  //     selves, and ONLY because they are the -1 class: reclaimGaveUpRows once per boot, and
  //     POST /portal/enrichment/retry-failed — both of which key on -1.
  // tagged + pending + blockedOnEmbed + unembeddable + gaveUp = total, by construction.
  //
  // ⚠️ THE BLANK-SKIP POPULATION IS EXCLUDED FROM `total` BY THE EMBED STAGE'S OWN VERDICT
  // (`nlp_processed = 1 AND embedding_768 IS NULL`), NOT BY RE-TESTING THE TEXT. A whitespace-only
  // row passes `content != ''` and the embed stage terminally skips it to 1 with no vector, so
  // under the new drain predicate it can never be selected again — and it used to be counted as
  // `tagged`, so leaving it in `total` gives a progress bar that can never reach its own total.
  //   An earlier draft excluded it with `TRIM(content, ' \t\n\r') != ''`, copying
  //   _computeNlpBacklog. A review proved that mismatched: SQL TRIM's charset is FOUR characters
  //   while the blank test upstream is JS `.trim()` (enrich/service.js), which also strips \v \f
  //   NBSP BOM and every Unicode space. A single-NBSP body — routine in scraped/exported corpora —
  //   is JS-blank (skipped to 1, no vector) but SQL-TRIM-NONEMPTY, so it stayed in `total` forever:
  //   the exact never-filling bar the clause was added to prevent, for a class of whitespace nobody
  //   would think to test.
  // Keying on the STATE instead of re-deriving blankness is both correct for every charset AND
  // keeps this counter's population identical to _computeEmbedBacklog's (which has no TRIM), so the
  // embed stage's `total` and the categorize stage's `total` still describe the same vault.
  // (_computeNlpBacklog's TRIM has the same latent mismatch — pre-existing, recorded, not touched
  // here: its `pending` keys on `nlp_processed = 2` so a blank can never distort it.)
  let _catBacklog = null;          // { userId, value:{tagged,total,pending,gaveUp,blockedOnEmbed,unembeddable}, at:ms }
  let _catBacklogInFlight = null;  // Promise while a recompute runs (single-flight)
  async function _computeCategoriesBacklog(userId) {
    // `tagged` mirrors updateCategories' "attempted" value exactly (categories_processed = 1);
    // `pending` mirrors selectPendingCategories exactly, so it counts work the drainer will
    // actually pick up — and therefore REACHES 0 even with gave-up rows present.
    const r = await d1Query(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN categories_processed = 1 THEN 1 ELSE 0 END), 0) AS tagged,
         COALESCE(SUM(CASE WHEN (categories_processed = 0 OR categories_processed IS NULL)
                               AND embedding_768 IS NOT NULL THEN 1 ELSE 0 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN (categories_processed = 0 OR categories_processed IS NULL)
                               AND embedding_768 IS NULL
                               AND (nlp_processed = 0 OR nlp_processed IS NULL) THEN 1 ELSE 0 END), 0) AS blocked_on_embed,
         COALESCE(SUM(CASE WHEN (categories_processed = 0 OR categories_processed IS NULL)
                               AND embedding_768 IS NULL
                               AND nlp_processed = -1 THEN 1 ELSE 0 END), 0) AS unembeddable,
         COALESCE(SUM(CASE WHEN categories_processed = -1 THEN 1 ELSE 0 END), 0) AS gave_up
       FROM messages
       WHERE user_id = ?
         AND forgotten_at IS NULL
         AND content IS NOT NULL AND content != ''
         AND NOT (nlp_processed = 1 AND embedding_768 IS NULL)`,
      [userId],
    );
    const row = (r.results || [])[0] || {};
    const total = Number(row.total || 0);
    const tagged = Number(row.tagged || 0);
    const pending = Number(row.pending || 0);
    const gaveUp = Number(row.gave_up || 0);
    const blockedOnEmbed = Number(row.blocked_on_embed || 0);
    const unembeddable = Number(row.unembeddable || 0);
    return { tagged, total, pending, gaveUp, blockedOnEmbed, unembeddable };
  }

  // SWR cache for the Context Engine L2 (semantic NLP enrichment) backlog — the THIRD polled
  // full-table scan (@2.5s by the activity feed), so it gets its own latch, identical contract
  // to the embed + categories caches above. L2 runs continuously on the enrich drainer's timer
  // (drainer.js), not as a background_jobs row, so the feed projects it at read-time from this
  // count (mirrors categorizeProjection). Until this, L2 had NO backlog counter and NO feed row
  // at all — the ~153h stage (8/min for 76k on floor hardware) was invisible.
  //
  // `pending` mirrors selectPendingNlp's predicate EXACTLY (nlp_processed = 2 + content-bearing),
  // so it counts exactly the rows the drainer will pick up and REACHES 0 when caught up. It is
  // NOT a projection off `total` (the embed-backlog lesson: a SUCCESS predicate over a 4-state
  // column — 0 unprocessed → 2 embedded → 1 enriched, −1 poison — strands the −1/0 rows in
  // `pending` forever); it is COUNTED with the exact drain predicate.
  //
  // ⚠️ `done` (nlp_processed = 1) has TWO WRITERS, not one (#210 review, LOW — an earlier draft
  // of this comment claimed "the two are DISJOINT states", which is false for blanks):
  //   • L2 success — service.js's enrichNlpOnce marks an enriched row 1;
  //   • the EMBED stage's blank-skip — service.js's drainOnce sends a whitespace-only row
  //     0 → 1 DIRECTLY (terminal; it never embeds, never reaches 2, and L2 never touches it).
  // A blank row passes `content != ''` (empty-string only), so without the TRIM clause below it
  // landed in `total` AND `done` — a bar overfilled with rows L2 never owned. The TRIM excludes
  // the blank population from total/done/(vacuously) pending CONSISTENTLY, so the bar counts
  // what L2 actually processes. `pending` was already exact either way: a blank can never sit
  // at nlp_processed = 2. (SQL TRIM's char set is the practical whitespace population; the
  // blank-skip itself uses JS .trim() — any exotic-unicode-blank row would count in total+done
  // and, being terminal at 1, never distort `pending` or the ETA.)
  let _nlpBacklog = null;          // { userId, value:{done,total,pending}, at:ms }
  let _nlpBacklogInFlight = null;  // Promise while a recompute runs (single-flight)
  async function _computeNlpBacklog(userId) {
    const r = await d1Query(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN nlp_processed = 1 THEN 1 ELSE 0 END), 0) AS done,
         COALESCE(SUM(CASE WHEN nlp_processed = 2 THEN 1 ELSE 0 END), 0) AS pending
       FROM messages
       WHERE user_id = ?
         AND forgotten_at IS NULL
         AND content IS NOT NULL AND content != ''
         AND TRIM(content, ' \t\n\r') != ''`,
      [userId],
    );
    const row = (r.results || [])[0] || {};
    const total = Number(row.total || 0);
    const done = Number(row.done || 0);
    const pending = Number(row.pending || 0);
    return { done, total, pending };
  }

  // D-132 — the write methods that invalidate the backlog caches. The bump
  // happens AFTER the write completes (finally-wrapped at the API boundary
  // below), never before it: a bump-before lets a scan that starts inside the
  // write's await window capture the NEW generation while reading PRE-write
  // data, and the caches then quiesce on stale numbers for up to the reconcile
  // floor (round-1 review, MED). Bump-after's only cost is a possible extra
  // rescan when a scan races a commit — conservative in the safe direction.
  // finally = bumps even on a failed write (also conservative). The list is
  // pinned by verify:backlog-quiescence Q7.
  const BACKLOG_WRITE_METHODS = ['insert', 'updateMetadata', 'updateEnrichment', 'markForReembed',
    'resetEnrichmentGiveUps', 'updateNlp', 'updateCategories', 'restampLegacyCategories',
    'redact', 'deleteIds', 'setSalience', 'insertIgnore', 'updateContent',
    'backfillContentHash', 'adoptOrphanChatHistory'];
  const withBacklogBump = (fn) => async function bumped(...a) {
    try { return await fn.apply(this, a); } finally { bumpBacklogGen(); }
  };
  const wrapBacklogWriters = (api) => {
    for (const m of BACKLOG_WRITE_METHODS) {
      if (typeof api[m] !== 'function') throw new TypeError(`backlog-bump wiring: messages.${m} missing`);
      api[m] = withBacklogBump(api[m]);
    }
    return api;
  };

  return wrapBacklogWriters({
    /**
     * D-132 — out-of-namespace raw writers to `messages` (drainer reclaim /
     * self-heal, full-export-import's vector pass + restore) MUST call this
     * after their write so the polled backlog caches revalidate. In-namespace
     * methods bump automatically.
     */
    noteBacklogWrite() { bumpBacklogGen(); },

    async insert(rows) {
      const arr = Array.isArray(rows) ? rows : [rows];
      assertSafeColumns(Object.keys(arr[0] || {}), 'messages');
      const placeholders = arr.map(() =>
        `(${Object.keys(arr[0]).map(() => '?').join(', ')})`,
      ).join(', ');
      const cols = Object.keys(arr[0]).join(', ');
      const params = arr.flatMap((r) => Object.values(r));

      const result = await d1Query(
        `INSERT INTO messages (${cols}) VALUES ${placeholders} RETURNING id`,
        params,
      );
      return result.results || [];
    },

    /**
     * Update only the metadata column on an existing row. Used by
     * /chat/triage to persist the inbound row at the start of triage,
     * then UPDATE it once the REPLY/NO_REPLY decision is made — keeps
     * the row durable even if Claude crashes mid-flight.
     *
     * userId is REQUIRED in the WHERE clause: the Worker safety guard
     * rejects unfiltered UPDATEs on user-data tables (the same guard
     * that catches accidental cross-tenant writes). The id alone is
     * unique by random hex, but the contract still requires user_id
     * so the same query works on every tenant DB.
     *
     * The metadata param goes through the auto-encryption layer like
     * any other write to ENCRYPTED_FIELDS.messages.
     *
     * @param {string} id
     * @param {string} userId
     * @param {object|null} metadata
     */
    async updateMetadata(id, userId, metadata) {
      const json = metadata == null
        ? null
        : (typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
      await d1Query(
        `UPDATE messages SET metadata = ? WHERE id = ? AND user_id = ?`,
        [json, id, userId],
      );
    },

    /**
     * Mark a message enriched: write its embedding envelope + advance the
     * nlp_processed state machine. The D7 enrichment service is the only
     * caller. States: 0 pending → 2 embedded, or -1 on a per-row failure
     * (nlp_error records why). nlp_processed_at stamps the transition.
     *
     * embedding_768 is deliberately NOT in ENCRYPTED_FIELDS — the caller
     * passes a ready wrapped-DEK vector envelope (encryptVector), so it
     * stores raw, exactly the value the mind-search ANN read path expects.
     * userId is REQUIRED in the WHERE clause (same unfiltered-UPDATE guard
     * as updateMetadata).
     *
     * @param {string} id
     * @param {string} userId
     * @param {{embedding768?: string, nlpProcessed: number, nlpError?: string|null}} fields
     */
    async updateEnrichment(id, userId, { embedding768, nlpProcessed, nlpError = null } = {}) {
      if (typeof nlpProcessed !== 'number') {
        throw new TypeError('updateEnrichment: nlpProcessed (number) required');
      }
      const sets = [];
      const params = [];
      if (embedding768 !== undefined) {
        sets.push('embedding_768 = ?');
        params.push(embedding768);
      }
      sets.push('nlp_processed = ?');
      params.push(nlpProcessed);
      sets.push('nlp_error = ?');
      params.push(nlpError);
      sets.push("nlp_processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
      params.push(id, userId);
      await d1Query(
        `UPDATE messages SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
        params,
      );
    },

    /**
     * Drain query for the enrichment service: messages awaiting embedding.
     * nlp_processed = 0 (or NULL legacy) AND non-empty content. content
     * auto-decrypts to plaintext on read, so the worker embeds plaintext.
     * Oldest-first so a backlog drains in arrival order. The state predicate
     * runs on the (unencrypted) nlp_processed column at SQL level.
     *
     * ⚠️ THE JOIN IS PART OF WHAT GETS EMBEDDED (2026-07-26). A message that owns an
     * attachment carries its DERIVED TEXT — the voice transcript, the image caption,
     * the extracted document text — on the ATTACHMENT row, not in `content`. On the
     * import path `content` is literally "File: memo.ogg", so embedding content alone
     * produced a vector describing the FILENAME while the spoken words sat one join
     * away. The composition itself lives in ONE place (enrich/derived-text.js
     * `embedTextOf`) so the drain, the rescue retry and any future reader cannot
     * disagree about what a message's embeddable text is.
     *
     * ⛔ SELECT THE ENCRYPTED COLUMNS SEPARATELY — NEVER CONCATENATE THEM IN SQL.
     * `attachments.transcript` and `.description` are in ENCRYPTED_FIELDS, and the
     * adapter's autoDecryptResults decrypts envelope-shaped VALUES per column. A SQL
     * `content || transcript` joins two base64 envelopes into a string that is no
     * longer an envelope, so it silently decrypts to nothing and the derived text is
     * dropped. That exact bug shipped twice on the search loader (d1-loader.js: the
     * documents source, then territory/realm/theme). Aliases are safe — the decrypt
     * keys on value SHAPE, not on column name — and neither alias may ever be added
     * to NEVER_AUTO_DECRYPT_COLUMNS.
     *
     * The join is bounded by the batch (≤ `limit` rows) and hits attachments by
     * PRIMARY KEY, so it costs one indexed lookup per row.
     *
     * @param {string} userId
     * @param {{limit?: number}} opts
     */
    async selectPendingEnrichment(userId, { limit = 50 } = {}) {
      // nlp_error rides along for the attempt-cap accounting (enrich/service.js
      // embedAttemptsOf): a pending row can carry an 'embed-retry:N' marker — the
      // count of failures already attributed to it against a provably-up service.
      // Plaintext marker state, never content (ENCRYPTED_FIELDS.messages is []).
      const result = await d1Query(
        `SELECT m.id AS id, m.content AS content, m.scope AS scope, m.nlp_error AS nlp_error,
                a.transcript AS attachment_transcript, a.description AS attachment_description
           FROM messages m
           LEFT JOIN attachments a ON a.id = m.attachment_id AND a.user_id = m.user_id
           WHERE m.user_id = ?
             AND m.forgotten_at IS NULL
             AND (m.nlp_processed = 0 OR m.nlp_processed IS NULL)
             AND m.content IS NOT NULL AND m.content != ''
           ORDER BY m.created_at ASC
           LIMIT ?`,
        [userId, limit],
      );
      return result.results || [];
    },

    /**
     * A derived-text write landed on `attachmentId` — RE-QUEUE every already-embedded
     * message that owns it, so the drain recomputes `embedding_768` over content + the
     * new transcript/description. Returns how many rows were re-queued.
     *
     * ⚠️ `embedding_768 IS NOT NULL` IS THE WHOLE GUARD, and it is doing three jobs:
     *   • a still-PENDING row needs nothing — the drain has not reached it yet and will
     *     pick the derived text up on its own via the join above. Re-queueing it would
     *     clear its `embed-retry:N` marker and hand a repeat-failer a fresh budget
     *     every time a progressive transcript save fired.
     *   • an attempt-CAPPED row (-1, no vector) stays capped: its recovery contract is
     *     the boot reclaim + POST /portal/enrichment/retry-failed, not this path.
     *   • in the overwhelmingly common case (transcription finished before the drain
     *     got there) this UPDATE matches ZERO rows and costs one indexed probe.
     *
     * ⚠️ THE VECTOR IS NULLED, NOT LEFT STALE. Keeping the old vector while flipping
     * `nlp_processed` back to 0 would look cheaper (search keeps a vector meanwhile),
     * and it is the trap: a re-embed that then FAILS lands at nlp_processed = -1 WITH a
     * vector, and every recovery path in the codebase keys on `-1 AND embedding_768 IS
     * NULL` (selfHealStrandedEmbeds, reclaimGaveUpRows, resetEnrichmentGiveUps). Such a
     * row would be stranded forever while still COUNTING as `embedded`. Nulling puts the
     * row back into a state the pipeline already understands end to end.
     *
     * ⚠️ AND IT KEEPS D-047 (↻1) TRUE BY CONSTRUCTION. `selectPendingCategories`
     * requires `embedding_768 IS NOT NULL`, so a row awaiting re-embed is automatically
     * held back from the categorize stage and rendered as `blockedOnEmbed`, never as a
     * silent `done`. Flipping only `nlp_processed` would leave the row categorisable
     * while un-embedded — reopening the "tagged > embedded" symptom from a new door.
     *
     * `nlp_error` is cleared with the state: this is NEW work (new text), not a retry of
     * the old failure, so it gets a full attempt budget. Marker state only, never
     * content. userId REQUIRED in the WHERE (unfiltered-UPDATE guard); forgotten rows
     * are excluded so a re-embed can never resurrect one into the index.
     *
     * ⚠️ ACCEPTED COST, STATED SO IT IS NOT REDISCOVERED AS A BUG: `nlp_processed = 0` is
     * the ONLY state selectPendingEnrichment selects, so a row that had already reached
     * L2 (nlp_processed = 1) walks the machine again — 0 → 2 → 1 — and re-runs
     * `enrichNlpOnce` over UNCHANGED text (selectPendingNlp still projects `content`
     * alone; L2's input is deliberately not widened here). For the rows this touches
     * that pass is cheap — their body is a ~10-token "File: memo.ogg" — and it is
     * bounded: one re-run per attachment whose derived text lands, in the background
     * BULK-governed lane. Widening L2 to see the derived text would make the re-run
     * VALUABLE rather than merely cheap; it is a separate change with its own prompt
     * and numCtx questions, not a line to slip in here.
     *
     * @param {string} userId
     * @param {string} attachmentId
     * @returns {Promise<number>}
     */
    async markForReembed(userId, attachmentId) {
      if (!userId || !attachmentId) return 0;
      const r = await d1Query(MARK_FOR_REEMBED_SQL, [userId, attachmentId]);
      const ids = (r?.results || []).map((row) => row.id).filter(Boolean);
      if (!ids.length) return 0;
      // ── THE STALE MINDSCAPE POINT MUST GO WITH THE STALE VECTOR ────────────────────────────
      // Same second half `updateContent` already has, and for the same reason. A message's 256D
      // clustering point (`clustering_points.nomic_embedding`) is a PROJECTION of the vector we
      // just deleted — on the import path, of the filename. `sync-clustering-points.js` only
      // INSERTS where no point exists, so without this delete the note keeps sitting in the
      // territory/realm/theme its filename put it in, forever, while search quietly gets it
      // right. Fisher/novelty/frequency read that same stale point. Deleting it is safe by the
      // argument `updateContent` relies on: cluster.py's `has_reembed_backlog()` defers the
      // liveness prune while any `embedding_768 IS NULL` row exists, so the point is re-added
      // from the NEW vector rather than treated as a dead node.
      const placeholders = ids.map(() => '?').join(', ');
      await d1Query(
        `DELETE FROM clustering_points WHERE user_id = ? AND source_type = 'message' AND source_id IN (${placeholders})`,
        [userId, ...ids],
      );
      bustMindscapePoints(userId); // clustering_points changed → drop BOTH points + full caches
      return ids.length;
    },

    /**
     * Reset every attempt-capped / label-gave-up row back to pending — the
     * user-facing recovery surface (POST /portal/enrichment/retry-failed). Three
     * bounded, marker-scoped UPDATEs:
     *   1. 'embed-capped:N' terminal rows  → nlp_processed 0, marker cleared
     *   2. 'embed-retry:N' pending markers → cleared (a full fresh budget)
     *   3. categories_processed = -1 rows  → 0 (labeling re-queued)
     * Marker-scoped by design: a genuine poison row (-1 with a real error string)
     * is NOT touched — the drainer's self-heal owns those. userId REQUIRED in
     * every WHERE (unfiltered-UPDATE guard). Returns counts only, never content.
     * @param {{stage?: 'embed'|'categorize'}} [opts] — scope the reset to ONE stage (QA R2's
     *   per-stage Restart). Omitted ⇒ BOTH (the global /retry-failed contract, unchanged).
     *   'embed' resets the embed-capped/retry markers only; 'categorize' the label gave-ups only.
     * @returns {Promise<{embedReset:number, labelReset:number}>}
     */
    async resetEnrichmentGiveUps(userId, { stage } = {}) {
      let embedReset = 0;
      let labelReset = 0;
      if (stage !== 'categorize') {
        const capped = await d1Query(
          `UPDATE messages SET nlp_processed = 0, nlp_error = NULL
             WHERE user_id = ? AND nlp_processed = -1 AND embedding_768 IS NULL
               AND nlp_error LIKE 'embed-capped:%'`,
          [userId],
        );
        await d1Query(
          `UPDATE messages SET nlp_error = NULL
             WHERE user_id = ? AND (nlp_processed = 0 OR nlp_processed IS NULL)
               AND nlp_error LIKE 'embed-retry:%'`,
          [userId],
        );
        embedReset = Number(capped?.meta?.changes ?? 0);
      }
      if (stage !== 'embed') {
        const labels = await d1Query(
          `UPDATE messages SET categories_processed = 0
             WHERE user_id = ? AND categories_processed = -1`,
          [userId],
        );
        labelReset = Number(labels?.meta?.changes ?? 0);
      }
      return { embedReset, labelReset };
    },

    /**
     * Embedding backlog snapshot for the activity/status surfaces. The single
     * source of truth for "embedded vs total vs pending vs unprocessable".
     *
     * `total` counts only EMBEDDABLE messages (content-bearing). `pending` is
     * COUNTED with selectPendingEnrichment's exact predicate (nlp_processed 0/NULL),
     * so it reflects work the drainer will actually pick up and REACHES 0.
     * `unprocessable` = total − embedded − pending: content-bearing rows that are
     * neither done nor queued (poison / blank-skip / awaiting-L2). A count only —
     * never the reason (nlp_error is encrypted).
     *
     * HISTORY — this doc comment used to claim the old `total − embedded` projection
     * "reflects work the drainer can actually do and reaches 0". That was FALSE: the
     * "19 remaining" fix it cites only excluded content-NULL rows from `total`, and
     * three other classes (nlp_processed = -1 / 1 / 2) stayed in the projection
     * forever. Corrected 2026-07-15 with the counted predicate above.
     * PIPELINE-INTEGRITY design §P1.2; the data-readiness design §3.3.
     * @returns {Promise<{ embedded:number, total:number, pending:number, unprocessable:number }>}
     */
    async embedBacklog(userId) {
      // PURE + always-fresh. Correctness-critical callers (the Generate preflight)
      // and read-after-write tests depend on this reflecting the DB exactly. The
      // POLLED progress surfaces use embedBacklogCached() below instead.
      return _computeEmbedBacklog(userId);
    },

    /**
     * Cached embedding-backlog snapshot for the POLLED progress surfaces (activity
     * feed @2.5s, processing-status, compat). Serve-stale-while-revalidate under a
     * single-flight latch: returns the last value instantly and kicks at most ONE
     * background recompute per window — SHORT while a backlog drains (live progress),
     * LONG once pending hits 0 (stable). The underlying scan is a multi-second
     * SQLCipher full-table decrypt on a large at-rest vault; polling it per-call
     * arrives faster than it completes → unbounded event-loop queue → boot hang.
     * This makes a hammered query ≤1 scan/window with no caller queueing behind
     * another. Few-seconds staleness is immaterial for a "N of M ready" indicator.
     * Use embedBacklog() (pure) where freshness matters. Per-process, userId-keyed.
     * @returns {Promise<{ embedded:number, total:number, pending:number, unprocessable:number }>}
     */
    async embedBacklogCached(userId) {
      const cached = _backlog && _backlog.userId === userId ? _backlog : null;
      // SHORT TTL while a backlog drains (pending > 0) — live progress. ⚠️ ALSO short when
      // total === 0: that is the TRANSIENT pre-import / not-yet-populated state, NOT a settled
      // backlog. A boot-warm() (readiness.warm → completeBoot) primes {total:0,pending:0} for the
      // fresh vault, and nothing busts _backlog on import; with the old 60s TTL that stale 0 was
      // served for up to a minute, so a user who imports within that window kept reading total:0 —
      // and generate.ts's empty-vault clock (EMPTY_CONFIRM_MS 12s) then fired the false "Import some
      // conversations first" AFTER the import had populated the vault (QA P1-C, the SWR half). A
      // total:0 snapshot is cheap to re-probe (an empty/near-empty table scan — the multi-second
      // decrypt cost only exists once total > 0), so the short TTL revalidates well within the
      // client's 12s window without any cost regression. A SETTLED backlog (pending 0, total > 0)
      // keeps the LONG 60s TTL. [[onboarding-status-emptiness-not-count]] — adjust the snapshot's
      // freshness, never bust the cache.
      const ttlMs = cached && cached.value.pending > 0 ? 8000
        : cached && cached.value.total === 0 ? 8000
          : 60000;
      const t = now();
      if (cached && (t - cached.at) < ttlMs) return cached.value;
      // D-132: write-quiescent → the numbers cannot have moved; serve without
      // rescanning (up to the reconcile floor — see _backlogGen above).
      // ⚠️ NEVER for a total:0 snapshot: that is the TRANSIENT pre-import state
      // (QA P1-C), and import writers can be dynamic-SQL the generation net does
      // not see — while an empty-table scan is cheap (the multi-second decrypt
      // cost only exists once total > 0). Quiescence is a big-vault optimization;
      // total:0 keeps the short-TTL revalidation unconditionally.
      if (cached && cached.value.total > 0 && cached.gen === _backlogGen && (t - cached.at) < BACKLOG_RECONCILE_FLOOR_MS) return cached.value;
      if (!_backlogInFlight) {
        const genAtStart = _backlogGen;
        _backlogInFlight = _computeEmbedBacklog(userId)
          .then((v) => { _backlog = { userId, value: v, at: now(), gen: genAtStart }; return v; })
          .finally(() => { _backlogInFlight = null; });
      }
      if (cached) return cached.value;   // serve stale instantly — never block a poll
      return _backlogInFlight;           // cold start only: await the first scan once
    },

    /**
     * Cached categorization-backlog snapshot for the activity feed's L1 projection
     * (same serve-stale-while-revalidate + single-flight contract as embedBacklogCached,
     * with an independent latch). Surfaces the "Sorting your messages · N of M" indicator
     * so the continuous on-box categorization is never invisible churn (the live-vault
     * dormancy bug: 69k messages tagged by an out-of-app script with no UI signal).
     * `pending` is the DRAIN predicate (untagged AND embedded); `blockedOnEmbed` / `unembeddable`
     * carry the untagged rows selectPendingCategories holds back (D-047 ↻1 — see
     * _computeCategoriesBacklog). A consumer asking "how much labeling is LEFT" must add
     * `pending + blockedOnEmbed`; one asking "how much can run right now" must not.
     * @returns {Promise<{ tagged:number, total:number, pending:number, gaveUp:number, blockedOnEmbed:number, unembeddable:number }>}
     */
    async categoriesBacklogCached(userId) {
      const cached = _catBacklog && _catBacklog.userId === userId ? _catBacklog : null;
      const ttlMs = cached && cached.value.pending > 0 ? 8000 : 60000;
      const t = now();
      if (cached && (t - cached.at) < ttlMs) return cached.value;
      if (cached && cached.value.total > 0 && cached.gen === _backlogGen && (t - cached.at) < BACKLOG_RECONCILE_FLOOR_MS) return cached.value; // D-132: write-quiescent (never for transient total:0 — P1-C)
      if (!_catBacklogInFlight) {
        const genAtStart = _backlogGen;
        _catBacklogInFlight = _computeCategoriesBacklog(userId)
          .then((v) => { _catBacklog = { userId, value: v, at: now(), gen: genAtStart }; return v; })
          .finally(() => { _catBacklogInFlight = null; });
      }
      if (cached) return cached.value;
      return _catBacklogInFlight;
    },

    /**
     * Cached L2 (semantic NLP enrichment) backlog snapshot for the activity feed's enrich
     * projection — same serve-stale-while-revalidate + single-flight contract as
     * embedBacklogCached / categoriesBacklogCached, with its own independent latch (the three
     * scans must never block each other). Polled @2.5s; the underlying query is a full-table
     * COUNT that must NOT run per-call. `pending` reaches 0 (counts nlp_processed = 2 exactly,
     * selectPendingNlp's predicate); `done` = nlp_processed = 1.
     * @returns {Promise<{ done:number, total:number, pending:number }>}
     */
    async nlpBacklogCached(userId) {
      const cached = _nlpBacklog && _nlpBacklog.userId === userId ? _nlpBacklog : null;
      const ttlMs = cached && cached.value.pending > 0 ? 8000 : 60000;
      const t = now();
      if (cached && (t - cached.at) < ttlMs) return cached.value;
      if (cached && cached.value.total > 0 && cached.gen === _backlogGen && (t - cached.at) < BACKLOG_RECONCILE_FLOOR_MS) return cached.value; // D-132: write-quiescent (never for transient total:0 — P1-C)
      if (!_nlpBacklogInFlight) {
        const genAtStart = _backlogGen;
        _nlpBacklogInFlight = _computeNlpBacklog(userId)
          .then((v) => { _nlpBacklog = { userId, value: v, at: now(), gen: genAtStart }; return v; })
          .finally(() => { _nlpBacklogInFlight = null; });
      }
      if (cached) return cached.value;
      return _nlpBacklogInFlight;
    },

    /**
     * Drain query for the NLP rules pass (enrichment stage 2). Selects rows
     * that are embedded but not yet enriched — nlp_processed = 2 — per the
     * canonical state machine (0 unprocessed → 2 embedded → 1 enriched).
     * content auto-decrypts on read so the extractor sees plaintext.
     *
     * @param {string} userId
     * @param {{limit?: number}} opts
     */
    async selectPendingNlp(userId, { limit = 50 } = {}) {
      const result = await d1Query(
        `SELECT id, content, scope FROM messages
           WHERE user_id = ?
             AND forgotten_at IS NULL
             AND nlp_processed = 2
             AND content IS NOT NULL AND content != ''
           ORDER BY created_at ASC
           LIMIT ?`,
        [userId, limit],
      );
      return result.results || [];
    },

    /**
     * Write NLP extraction results + advance the state machine to enriched (1).
     * entities/tags/entity_summary are ENCRYPTED_FIELDS — the caller passes
     * plaintext (JSON strings for entities/tags, a line for entity_summary) and
     * the adapter encrypts on write. userId REQUIRED in WHERE (unfiltered-UPDATE
     * guard). On failure the caller passes nlpProcessed=-1 + nlpError.
     *
     * @param {string} id
     * @param {string} userId
     * @param {{entities?: string, tags?: string, entitySummary?: string, nlpProcessed: number, nlpError?: string|null}} fields
     */
    async updateNlp(id, userId, { entities, tags, entitySummary, nlpProcessed, nlpError = null } = {}) {
      if (typeof nlpProcessed !== 'number') {
        throw new TypeError('updateNlp: nlpProcessed (number) required');
      }
      const sets = [];
      const params = [];
      if (entities !== undefined) { sets.push('entities = ?'); params.push(entities); }
      if (tags !== undefined) { sets.push('tags = ?'); params.push(tags); }
      if (entitySummary !== undefined) { sets.push('entity_summary = ?'); params.push(entitySummary); }
      sets.push('nlp_processed = ?');
      params.push(nlpProcessed);
      sets.push('nlp_error = ?');
      params.push(nlpError);
      sets.push("nlp_processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
      params.push(id, userId);
      await d1Query(
        `UPDATE messages SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
        params,
      );
    },

    /**
     * Drain query for the category-tagging pass (Context Engine L1, Phase 1b). Selects rows
     * not yet attempted (categories_processed 0/NULL) with non-empty content THAT ARE ALREADY
     * EMBEDDED. content auto-decrypts on read so the classifier sees plaintext.
     *
     * ⚠️ `ORDER BY created_at DESC` USED TO MEAN "fresh messages get labelled before the historical
     * backfill". THAT CLAIM IS NO LONGER TRUE DURING AN IMPORT, and it is recorded rather than
     * quietly retained: this drain now sees only EMBEDDED rows, and `selectPendingEnrichment`
     * embeds `created_at ASC` — oldest first. So while a large backfill is embedding, the newest
     * messages are the LAST to become labelable, whatever this ORDER BY says. It still holds on a
     * caught-up vault (a new message embeds within a cycle, then sorts first). The ordering is not
     * changed here: flipping either stage's traversal is a throughput/UX decision of its own, and
     * neither ordering affects the invariant below. Stated so the next reader does not trust a
     * property the predicate above took away.
     *
     * ════════════════════════════════════════════════════════════════════════════════════════
     *  ⛔ `embedding_768 IS NOT NULL` IS THE STAGE-ORDERING INVARIANT (D-047 ↻1, D-001 family)
     * ════════════════════════════════════════════════════════════════════════════════════════
     * This clause is the ONLY structural thing that makes "embed before categorize" true. Do not
     * remove it to "unblock labeling" — read this first.
     *
     * The doc comment here used to say the drain was "INDEPENDENT of the nlp_processed state
     * machine", and it was: any row could be labeled at any time, in any order, by any caller.
     * Ordering was enforced ONE layer up, by a per-CYCLE scheduling heuristic in the drainer
     * (`deferCategorizeForEmbed`, shipped as #329 for D-047). That heuristic has THREE deliberate
     * release valves — the embed service is unhealthy, the drain THREW, or the drain broke on
     * no-progress (`embedStalledOut`) — because a categorize stage deadlocked behind an embed
     * stage that can never finish is worse than the disorder. Every one of those valves releases
     * categorize for the WHOLE CORPUS.
     *
     * On the operator's shipped-v0.1.13 5.5K import that is exactly what fired. `drainOnce`
     * returns `{scanned:50, embedded:0, failed:0, skipped:0}` on its OUTAGE SIGNATURE (enrich/
     * service.js: a pass with other candidates and zero embeds must not advance any attempt
     * counter — it writes nothing at all). The drainer reads `moved === 0`, sets
     * `embedStalledOut`, and the heuristic hands the box to categorize. Qwen then labeled 772
     * rows past a stalled embed count of 445 — `tagged > embedded`, the reported symptom.
     *
     * The compute governor could never have caught it: the embed drain takes a BULK ticket and
     * categorize takes a RESIDENT ticket, which are ORTHOGONAL gates. The governor prevents the
     * two stages using memory simultaneously; it says nothing about their ORDER.
     *
     * So the ordering moves here, where it is a SET-INCLUSION FACT rather than a schedule: the
     * tagged set (categories_processed = 1) can only ever be a subset of the embedded set
     * (embedding_768 IS NOT NULL), because a row must pass through this predicate to be tagged.
     * `tagged > embedded` is therefore UNREACHABLE — by every entry point, retry, resume, second
     * import, QUEUE-lane interleave and ticket-timing accident, not just by the one the drainer
     * happens to schedule. (Gate: verify:compute-lanes C16/C17, mutation-proved — removing this
     * one clause reproduces the operator's report as `embedded=10 tagged=40`.)
     *
     * ⚠️ AND IT IS NOT A DEADLOCK — that is why it can be structural where the schedule could not.
     * The heuristic had to release the WHOLE STAGE because it only knew about stages. This knows
     * about ROWS: when embed stalls on an un-embeddable head of queue, categorize still drains
     * every row that DID embed, and simply finds nothing after that. Un-embeddable rows are not
     * labeled — deliberately, and recoverably: they are reclaimed once per boot
     * (reclaimGaveUpRows) and by POST /portal/enrichment/retry-failed, the same recovery contract
     * the embed stage already has. It is also FASTER than the old rule in the common case, which
     * deferred all labeling while embed merely progressed.
     *
     * ⚠️ THE COUNT MUST MIRROR THIS PREDICATE. `_computeCategoriesBacklog` counts `pending` with
     * this exact clause (that file's own warning: a drain predicate and a pending count that
     * disagree is the stuck-forever bug), and counts the rows this clause holds back separately
     * as `blockedOnEmbed`, so a vault waiting on embedding renders "waiting for embedding" and
     * never a silent `done`.
     *
     * ⚠️ BLANK ROWS NEED NO CLAUSE HERE — `embedding_768 IS NOT NULL` already excludes them, because
     * the EMBED stage blank-skips a whitespace-only body to `nlp_processed = 1` with NO vector. The
     * matching exclusion on the COUNT side keys on that same STATE rather than re-testing the text
     * (see _computeCategoriesBacklog: SQL `TRIM`'s 4-char charset is not JS `.trim()`, and an
     * NBSP-only body would slip through a text test forever). Sending whitespace to the on-box model
     * was never useful work anyway.
     */
    async selectPendingCategories(userId, { limit = 25 } = {}) {
      const result = await d1Query(
        `SELECT id, content, scope FROM messages
           WHERE user_id = ?
             AND forgotten_at IS NULL
             AND (categories_processed = 0 OR categories_processed IS NULL)
             AND content IS NOT NULL AND content != ''
             AND embedding_768 IS NOT NULL
           ORDER BY created_at DESC
           LIMIT ?`,
        [userId, limit],
      );
      return result.results || [];
    },

    /**
     * Write domain/register labels + mark attempted (categories_processed = 1). domain,
     * register, subregister, taxonomy_version are PLAINTEXT label enums (NOT in
     * ENCRYPTED_FIELDS — like source/nlp_processed) so they're SQL-queryable for the
     * measurement/retrieval surface. NULL labels are valid (the model couldn't classify).
     * userId REQUIRED in WHERE (unfiltered-UPDATE guard).
     */
    async updateCategories(id, userId, { domain, register, subregister, taxonomyVersion, model, categoriesProcessed = 1 } = {}) {
      const sets = [];
      const params = [];
      if (domain !== undefined) { sets.push('domain = ?'); params.push(domain ?? null); }
      if (register !== undefined) { sets.push('register = ?'); params.push(register ?? null); }
      if (subregister !== undefined) { sets.push('subregister = ?'); params.push(subregister ?? null); }
      if (taxonomyVersion !== undefined) { sets.push('taxonomy_version = ?'); params.push(taxonomyVersion ?? null); }
      if (model !== undefined) { sets.push('categories_model = ?'); params.push(model ?? null); }
      sets.push('categories_processed = ?');
      params.push(categoriesProcessed);
      // Provenance: stamp WHEN the attempt landed (0041). Only on a real attempt (=1) so a
      // future reset to 0 doesn't carry a stale timestamp. Plaintext scalar, never content.
      if (categoriesProcessed === 1) sets.push("categorized_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
      params.push(id, userId);
      await d1Query(
        `UPDATE messages SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
        params,
      );
    },

    /**
     * One-shot, idempotent provenance backfill for LEGACY/external-backfill rows (0041). The
     * forward path (updateCategories) stamps categorized_at when a row flips to processed=1, but
     * only the on-box drainer calls it — and the drainer's drain query (selectPendingCategories)
     * re-selects ONLY categories_processed 0/NULL. So a row an OUT-OF-APP backfill tagged
     * (categories_processed = 1) before provenance existed is invisible to the drainer forever and
     * stays with categorized_at NULL, which breaks the UI provenance ("tagged by X · 2h ago",
     * 0041 header) and a future model re-cut that targets rows by categorized_at.
     *
     * This re-stamps provenance ONLY onto those legacy rows, identified by the predicate
     *   categories_processed = 1 AND categorized_at IS NULL AND forgotten_at IS NULL.
     * It does NOT widen the drain (that would re-run the on-box model on already-tagged rows —
     * exactly the churn categories_processed exists to prevent), never invokes the classifier, and
     * never touches the domain/register/subregister labels.
     *
     * HONEST PROVENANCE: categorized_at is set to a fixed BACKFILL SENTINEL (the Unix epoch), NOT
     * strftime('now') — these rows were tagged in the PAST, at an unknown time; stamping now()
     * would lie about when the categorization happened. The UI can detect the sentinel and render
     * "tagged · time unknown". categories_model stays NULL for true-legacy rows (model unknown);
     * the operator may pass an explicit `model` only for a KNOWN external tagger.
     *
     * Both columns are PLAINTEXT provenance scalars (NOT in crypto-local ENCRYPTED_FIELDS; 0041
     * header) so this is a plain SQL UPDATE — no master key needed. userId is REQUIRED in the
     * WHERE (unfiltered-UPDATE guard) so a backfill can never cross the tenant boundary.
     *
     * Idempotent: a row whose categorized_at is already set fails the predicate, so a SECOND run
     * re-stamps 0. Returns { restamped } — the affected-rows count (meta.changes, the shape every
     * write helper in this file returns).
     */
    async restampLegacyCategories(userId, { model } = {}) {
      // Unix epoch = "tagged in the past, true time unknown" — an unmistakable sentinel (no real
      // categorization happened in 1970), distinct from a genuine recent strftime('now') stamp.
      // Treat model:null the same as no model (no false "external tagger" attribution).
      const wantModel = model !== undefined && model !== null;
      if (wantModel) {
        // Model-attribution pass. Anchored on `categories_model IS NULL` (NOT `categorized_at IS
        // NULL`), so attributing a known external tagger AFTER a prior default time-only pass can
        // never silently no-op — the old trap, where the default pass filled categorized_at and the
        // later model pass then matched zero rows. COALESCE fills the time sentinel only if still
        // null; the `(categorized_at IS NULL OR = sentinel)` guard means it only ever touches legacy
        // rows and never a forward-path row (those carry a real strftime timestamp). Idempotent: a
        // second model pass matches nothing because categories_model is now set.
        const res = await d1Query(
          `UPDATE messages
              SET categorized_at = COALESCE(categorized_at, ?),
                  categories_model = ?
            WHERE user_id = ?
              AND categories_processed = 1
              AND categories_model IS NULL
              AND forgotten_at IS NULL
              AND (categorized_at IS NULL OR categorized_at = ?)`,
          [CATEGORIES_BACKFILL_SENTINEL, model, userId, CATEGORIES_BACKFILL_SENTINEL],
        );
        return { restamped: res?.meta?.changes ?? 0 };
      }
      // Default time-only pass: stamp the sentinel onto true-legacy rows that were never stamped.
      // Idempotent on `categorized_at IS NULL` — a second run matches nothing.
      const res = await d1Query(
        `UPDATE messages SET categorized_at = ?
           WHERE user_id = ?
             AND categories_processed = 1
             AND categorized_at IS NULL
             AND forgotten_at IS NULL`,
        [CATEGORIES_BACKFILL_SENTINEL, userId],
      );
      return { restamped: res?.meta?.changes ?? 0 };
    },

    /**
     * Today's (or any window's) domain/register MIX — the life-balance read for getContext
     * (Context Engine L1c). Plaintext label columns → a plain SQL GROUP BY (mirrors
     * listDataSources). NULL labels surface as '(unclassified)'. Returns
     * [{domain, register, count}] desc.
     */
    async domainMix(userId, { sinceIso } = {}) {
      const since = sinceIso || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const result = await d1Query(
        `SELECT COALESCE(domain, '(unclassified)')   AS domain,
                COALESCE(register, '(unclassified)') AS register,
                COUNT(*)                              AS count
           FROM messages
           WHERE user_id = ? AND forgotten_at IS NULL AND created_at >= ?
           GROUP BY domain, register
           ORDER BY count DESC`,
        [userId, since],
      );
      return result.results || [];
    },

    /**
     * Soft-redact (forget): destroy a message's sensitive payload but keep an
     * empty tombstone row (id + timestamps) for audit + anti-resurrection. Nulls
     * every ENCRYPTED_FIELDS column + the embedding (both fingerprints), deletes
     * the derived clustering_points row, and stamps forgotten_at. Returns the
     * pre-redaction content hash + length for the audit ledger — NEVER the
     * plaintext. Local SQLite; literal NULLs so the encrypt layer is a no-op.
     *
     * @param {string} id
     * @param {string} userId
     * @returns {Promise<{found:boolean, alreadyForgotten?:boolean, contentHash:string|null, length:number}>}
     */
    async redact(id, userId, opts = {}) {
      const cur = await d1Query(
        `SELECT content, forgotten_at, attachment_id FROM messages WHERE id = ? AND user_id = ?`,
        [id, userId],
      );
      const row = firstRow(cur);
      if (!row) return { found: false, contentHash: null, length: 0 };
      if (row.forgotten_at) return { found: true, alreadyForgotten: true, contentHash: null, length: 0 };
      const content = row.content ?? '';
      const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
      // Snapshot the attachment (transcript/description/blob) BEFORE the cascade so
      // its storage key survives the row delete for the reference-counted unlink.
      // attachments.transcript is the VERBATIM voice-note transcription (still listed
      // by portal-attachments.js) and the blob is the raw file bytes — forget()
      // promises "content destroyed, cannot be undone" (src/tools/curate.js), so both
      // must go, exactly as bulk delete already does (src/core/bulk-delete.js).
      let attLocalPath = null;
      const attId = row.attachment_id || null;
      if (attId) {
        const attCur = await d1Query(
          `SELECT local_path FROM attachments WHERE id = ? AND user_id = ?`,
          [attId, userId],
        );
        attLocalPath = firstRow(attCur)?.local_path ?? null;
      }
      // FULL cascade FIRST (fail-closed): purges every derived row AND evicts the
      // search sidecar. Before this, redact() nulled the row + dropped the point but
      // left fts_docs / vec_docs_768 / vec_docs_256 / doc_meta intact — forgotten
      // content stayed full-text AND vector searchable, which defeats the entire
      // forget contract. If the cascade throws, the row is NOT tombstoned and the
      // caller reports failure rather than a false "forgotten".
      await purgeDerived(cascadeDb, userId, { messageIds: [id] }, { searchHelpers: opts.searchHelpers });
      await d1Query(
        `UPDATE messages SET
           content = NULL, content_hash = NULL, thinking = NULL, tags = NULL, entities = NULL,
           entity_summary = NULL, relations = NULL, metadata = NULL,
           suggested_new_tag = NULL, nlp_error = NULL, embedding_768 = NULL,
           forgotten_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND user_id = ?`,
        [id, userId],
      );
      // Purge the attachment row (transcript + description live in it) AFTER the
      // message tombstone, then reference-counted blob unlink (a byte-identical blob
      // still referenced by another attachment row is KEPT). Same order + helper as
      // bulk-delete: rows gone → refcount is accurate. Never throws.
      if (attId) {
        await d1Query(`DELETE FROM attachments WHERE id = ? AND user_id = ?`, [attId, userId]);
        if (attLocalPath) { try { await unlinkBlobIfUnreferenced(cascadeDb, attLocalPath); } catch { /* orphan ciphertext is safe */ } }
      }
      bustMindscapePoints(userId); // clustering_points row deleted → drop BOTH points + full caches
      return { found: true, contentHash, length: content.length };
    },

    /**
     * HARD-delete a batch of messages by id (user-scoped) + the FULL derived
     * cascade (src/core/delete-cascade.js — clustering_points, note_links,
     * entity_links, seen-points, conversation_summaries, content-quoting theme_cards
     * / person_claims, the liveness prune of dead territories/themes/realms, and
     * search-sidecar eviction). Unlike redact() (which leaves an immutable
     * tombstone), this fully removes the rows — the primitive behind bulk
     * delete-by-source / by-type and V2 right-to-erasure. Callers chunk the id list
     * (≤500) and MUST have resolved ids from a user_id+source/type SELECT so the
     * scope predicate can never widen. Blob unlink stays the CALLER's job (only the
     * caller knows the attachment refcount — see src/core/bulk-delete.js).
     *
     * NOT atomic — and never was: the adapter's d1Batch is a sequential await loop,
     * not a transaction (src/adapter/d1.js:107). What holds instead is crash-ORDER
     * safety: derived rows die BEFORE the source row, so a crash mid-cascade leaves
     * a live message with a partly-purged derived graph (re-running the same delete
     * completes it), never an orphaned derived graph pointing at nothing.
     *
     * @param {string[]} ids
     * @param {string} userId
     * @param {{searchHelpers?:object}} [opts]
     * @returns {Promise<{deleted:number, cascade:object}>}
     */
    async deleteIds(ids, userId, opts = {}) {
      const list = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : [];
      if (!userId) throw new Error('messages.deleteIds: userId required (fail-closed, never table-wide)');
      if (!list.length) return { deleted: 0 };
      const ph = list.map(() => '?').join(',');
      // Derived graph FIRST (clustering_points → note/entity links → seen-points →
      // summaries → quoting rows → liveness prune → search eviction), THEN the rows.
      // Fail-closed: a throw here leaves the messages in place, so the caller can
      // never report a completed delete over a half-purged derived graph.
      const cascade = await purgeDerived(cascadeDb, userId, { messageIds: list }, { searchHelpers: opts.searchHelpers });
      await d1Query(`DELETE FROM messages WHERE user_id = ? AND id IN (${ph})`, [userId, ...list]);
      bustMindscapePoints(userId);
      return { deleted: list.length, cascade };
    },

    /**
     * Set user-asserted salience flags on a message. Forgotten rows are
     * immutable (excluded by the WHERE). RETURNING detects a live match.
     *
     * @param {string} id
     * @param {string} userId
     * @param {{pinned?:boolean, sensitive?:boolean}} flags
     */
    async setSalience(id, userId, { pinned, sensitive } = {}) {
      const sets = [];
      const params = [];
      if (pinned !== undefined) { sets.push('pinned = ?'); params.push(pinned ? 1 : 0); }
      if (sensitive !== undefined) { sets.push('sensitive = ?'); params.push(sensitive ? 1 : 0); }
      if (!sets.length) return { found: true, changed: false };
      params.push(id, userId);
      const res = await d1Query(
        `UPDATE messages SET ${sets.join(', ')} WHERE id = ? AND user_id = ? AND forgotten_at IS NULL RETURNING id`,
        params,
      );
      const hit = firstRow(res);
      return { found: !!hit, changed: !!hit };
    },

    /** INSERT OR IGNORE — skips duplicate IDs. Splits into D1's ~100 param limit. */
    async insertIgnore(rows) {
      const arr = Array.isArray(rows) ? rows : [rows];
      if (arr.length === 0) return [];
      const cols = assertSafeColumns(Object.keys(arr[0]), 'messages');
      const colNames = cols.join(', ');
      const allInserted = [];
      // ROWS_PER_STMT keeps each statement under D1's ~100-param ceiling.
      const ROWS_PER_STMT = Math.max(1, Math.floor(95 / cols.length));
      const statements = [];
      for (let i = 0; i < arr.length; i += ROWS_PER_STMT) {
        const batch = arr.slice(i, i + ROWS_PER_STMT);
        const placeholders = batch.map(() =>
          `(${cols.map(() => '?').join(', ')})`,
        ).join(', ');
        const params = batch.flatMap((r) => cols.map((c) => r[c]));
        statements.push({
          sql: `INSERT OR IGNORE INTO messages (${colNames}) VALUES ${placeholders}`,
          params,
        });
      }
      // d1Batch sends multiple statements in one HTTP round-trip.
      const BATCH_SIZE = 50;
      for (let i = 0; i < statements.length; i += BATCH_SIZE) {
        const stmtBatch = statements.slice(i, i + BATCH_SIZE);
        try {
          const results = await d1Batch(stmtBatch);
          for (const r of results) {
            allInserted.push(...(r.results || []));
          }
        } catch {
          // Fallback: execute one-by-one if the batch request itself fails.
          for (const stmt of stmtBatch) {
            try {
              const r = await d1Query(stmt.sql, stmt.params);
              allInserted.push(...(r.results || []));
            } catch { /* skip duplicates */ }
          }
        }
      }
      return allInserted;
    },

    async getExistingIds(userId, ids) {
      const existing = new Set();
      // D1 param cap: 1 for userId + up to 90 IDs per batch.
      for (let i = 0; i < ids.length; i += 90) {
        const batch = ids.slice(i, i + 90);
        const placeholders = batch.map(() => '?').join(', ');
        const result = await d1Query(
          `SELECT id FROM messages WHERE user_id = ? AND id IN (${placeholders})`,
          [userId, ...batch],
        );
        for (const row of result.results || []) existing.add(row.id);
      }
      return existing;
    },

    /**
     * Change-detection metadata for one message id — drives captureMessage's
     * insert / no-op / update branch. content_hash is PLAINTEXT (0007) so it
     * compares without decrypting; content is decrypted by the adapter on read
     * so a legacy NULL hash can still be derived. `forgotten` is surfaced so the
     * caller never resurrects a redacted message.
     */
    async getContentMeta(userId, id) {
      const res = await d1Query(
        `SELECT content_hash, content, forgotten_at FROM messages WHERE id = ? AND user_id = ?`,
        [id, userId],
      );
      const row = firstRow(res);
      if (!row) return { exists: false, contentHash: null, content: null, forgotten: false };
      return {
        exists: true,
        contentHash: row.content_hash ?? null,
        content: row.content ?? null,
        forgotten: Boolean(row.forgotten_at),
      };
    },

    /**
     * Content changed upstream — overwrite body + hash and RE-ENRICH: reset
     * nlp_processed=0 (the drainer re-embeds), null the embedding + every
     * AI-derived column, and drop the stale mindscape point so the cluster sync
     * re-adds it with the new embedding. Mirrors redact()'s reset minus the
     * tombstone, and is gated `forgotten_at IS NULL` so a redacted message is
     * never resurrected. content + metadata auto-encrypt on write; content_hash
     * stays plaintext (crypto-local.js parseWriteSQL UPDATE branch). Returns
     * { changed } — false if no live row matched (forgotten / missing).
     */
    async updateContent(userId, id, { content, contentHash, metadata }) {
      // metadata is written ONLY when the caller provides it (mirrors
      // document-store): an update that omits metadata must not wipe the prior
      // value. content + (optional) metadata auto-encrypt; content_hash stays
      // plaintext. parseWriteSQL maps the encrypted params by SET position, so
      // a dynamic SET clause stays correct.
      const sets = ['content = ?', 'content_hash = ?'];
      const params = [content, contentHash];
      if (metadata !== undefined) { sets.push('metadata = ?'); params.push(metadata); }
      // Re-enrich: clear AI-derived columns so the drainer re-embeds + re-clusters.
      // ⛔ THE CATEGORIZE STAGE IS RESET HERE TOO, AND IT IS NOT COSMETIC (D-047 ↻1). This reset
      // listed itself as clearing "every AI-derived column" and then left the L1 label stage
      // alone: it nulled `embedding_768` and reset `nlp_processed` to 0 while `categories_processed`
      // stayed at 1. Every content re-sync therefore MANUFACTURED a row that is counted as tagged
      // and NOT counted as embedded — `tagged > embedded` produced directly by the DAL, with no
      // scheduler involved. That is a second, independent source of the reported skew, and the
      // drain-query ordering invariant (selectPendingCategories) cannot see it: the row is already
      // tagged, so it is never re-selected. Gate: verify:compute-lanes C17b.
      // The labels are AI output derived from content that just CHANGED, so they are stale by
      // definition — nulling them is completing this reset's own stated intent, not widening it.
      sets.push(
        'nlp_processed = 0', 'nlp_processed_at = NULL', 'nlp_error = NULL',
        'thinking = NULL', 'tags = NULL', 'entities = NULL', 'entity_summary = NULL',
        'relations = NULL', 'suggested_new_tag = NULL', 'embedding_768 = NULL',
        'categories_processed = 0', 'categorized_at = NULL', 'categories_model = NULL',
        'domain = NULL', 'register = NULL', 'subregister = NULL',
      );
      params.push(id, userId);
      const res = await d1Query(
        `UPDATE messages SET ${sets.join(', ')} WHERE id = ? AND user_id = ? AND forgotten_at IS NULL RETURNING id`,
        params,
      );
      const changed = Boolean(firstRow(res));
      if (changed) {
        await d1Query(
          `DELETE FROM clustering_points WHERE user_id = ? AND source_type = 'message' AND source_id = ?`,
          [userId, id],
        );
        bustMindscapePoints(userId); // clustering_points changed → drop BOTH points + full caches
      }
      return { changed };
    },

    /** Backfill content_hash on a legacy (pre-0007) row whose content is unchanged — no re-enrich. */
    async backfillContentHash(userId, id, contentHash) {
      await d1Query(
        `UPDATE messages SET content_hash = ? WHERE id = ? AND user_id = ? AND content_hash IS NULL`,
        [contentHash, id, userId],
      );
    },

    async getExistingConversationIds(userId, source) {
      const result = await d1Query(
        `SELECT DISTINCT conversation_id FROM messages WHERE user_id = ? AND source = ? AND conversation_id IS NOT NULL`,
        [userId, source],
      );
      return new Set((result.results || []).map((r) => r.conversation_id));
    },

    /**
     * List conversations (one row per conversation_id+source) with last activity + count,
     * newest-first. Optionally filtered to `sources` (e.g. the channel sources, to surface
     * Telegram/Discord threads in the portal inbox). SELECTs only PLAINTEXT provenance
     * columns (no content) → a plain grouped scan, no per-row decrypt. User-scoped.
     * @param {string} userId
     * @param {{ sources?: string[], limit?: number }} [opts]
     * @returns {Promise<Array<{conversation_id, source, last_at, n}>>}
     */
    async listConversations(userId, { sources, limit = 50 } = {}) {
      const srcs = Array.isArray(sources) && sources.length ? sources.slice(0, 20) : null;
      let sql = `SELECT conversation_id, source, MAX(created_at) AS last_at, COUNT(*) AS n
                 FROM messages
                 WHERE user_id = ? AND conversation_id IS NOT NULL AND forgotten_at IS NULL`;
      const params = [userId];
      if (srcs) { sql += ` AND source IN (${srcs.map(() => '?').join(', ')})`; params.push(...srcs); }
      sql += ` GROUP BY conversation_id, source ORDER BY last_at DESC LIMIT ?`;
      params.push(clampLimit(limit, 50, 200));
      const result = await d1Query(sql, params);
      return result.results || [];
    },

    /**
     * Cursor-paginated forward iteration for mind-search rehydrate.
     *
     * Returns one batch at a time, ordered by id ASC so a stable cursor
     * is just `lastId > ?`. Caller drives the loop. Always pulls
     * embedding_768 — this method exists specifically for rehydrate.
     *
     * Differs from selectRecent in two ways: (1) ASC order with a
     * cursor instead of a fixed-size most-recent slice, (2) no
     * agentId filter — rehydrate populates everything the agent's
     * scope can see.
     *
     * @param {string} userId  tenant id
     * @param {{ batchSize?: number, cursor?: string, scope?: string }} opts
     * @returns {Promise<Array<{ id, content, scope, created_at, embedding_768 }>>}
     */
    async streamForRehydrate(userId, { batchSize = 200, cursor = '', scope } = {}) {
      let sql = `SELECT id, content, scope, created_at, embedding_768
                 FROM messages
                 WHERE user_id = ? AND id > ? AND embedding_768 IS NOT NULL AND forgotten_at IS NULL`;
      const params = [userId, cursor];
      if (scope) {
        // Same scope-fan rule as selectRecent: 'personal' sees personal+org,
        // 'wealth' sees wealth+org, 'all' sees everything.
        if (scope === 'personal') {
          sql += ` AND scope IN ('personal', 'org')`;
        } else if (scope === 'wealth') {
          sql += ` AND scope IN ('wealth', 'org')`;
        } else if (scope !== 'all') {
          sql += ` AND scope = ?`;
          params.push(scope);
        }
      }
      sql += ` ORDER BY id ASC LIMIT ?`;
      params.push(batchSize);
      const result = await d1Query(sql, params);
      return result.results || [];
    },

    /**
     * @param {object} [o]
     * @param {string[]} [o.sources] restrict to these `source` tags IN SQL.
     *   Without it, "the newest N rows" means the newest N rows of EVERYTHING — so a caller
     *   that only cares about one surface silently gets an empty answer on a busy vault once
     *   N unrelated rows (a channel burst, an import) land on top. That fail-OPEN is a real
     *   defect for any caller whose decision depends on completeness (agent/turn-taking.js's
     *   floor read — independent review, 2026-07-26). Filtering in SQL makes the window exact
     *   and stays on the (user_id, created_at) index (migrations/0026).
     */
    async selectRecent(userId, { limit = 10, agentId, since, scope, sources, includeEmbedding768 = false } = {}) {
      limit = clampLimit(limit, 10);
      const cols = `id, content, role, source, agent_id, attachment_id, tags, entities, scope, created_at, pinned${
        includeEmbedding768 ? ', embedding_768' : ''
      }`;
      let sql = `SELECT ${cols} FROM messages WHERE user_id = ? AND forgotten_at IS NULL`;
      const params = [userId];
      if (Array.isArray(sources) && sources.length) {
        sql += ` AND source IN (${sources.map(() => '?').join(', ')})`;
        params.push(...sources.map((s) => String(s)));
      }
      // Alias-aware filter: personal-agent expands to (personal-agent, mya-personal).
      // Single source of truth in @mycelium/core/agent-id-aliases.js.
      const agentFilter = buildAgentIdFilter(agentId);
      if (agentFilter.sql) {
        sql += ` AND ${agentFilter.sql}`;
        params.push(...agentFilter.params);
      }
      if (scope) {
        // Scope filtering: 'personal' sees personal+org, 'wealth' sees
        // wealth+org, 'all' sees everything, else specific scope only.
        if (scope === 'personal') {
          sql += ` AND scope IN ('personal', 'org')`;
        } else if (scope === 'wealth') {
          sql += ` AND scope IN ('wealth', 'org')`;
        } else if (scope !== 'all') {
          sql += ` AND scope = ?`;
          params.push(scope);
        }
      } else {
        // No explicit scope — default to this agent's AGENT_SCOPES so we
        // never fetch a row the scope-guardian will then deny. Without
        // this the row arrives as ciphertext and reaches the portal.
        const allowed = _envAllowedScopes();
        if (allowed) {
          const placeholders = allowed.map(() => '?').join(', ');
          sql += ` AND scope IN (${placeholders})`;
          params.push(...allowed);
        }
      }
      if (since) {
        sql += ` AND created_at >= ?`;
        params.push(since);
      }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit);
      const result = await d1Query(sql, params);
      return result.results || [];
    },

    async selectPaginated(userId, { since, until, offset = 0, limit = 30, channel, agentId, excludeAgentId } = {}) {
      limit = clampLimit(limit, 30);
      let where = `WHERE user_id = ? AND forgotten_at IS NULL`;
      const params = [userId];
      if (since)   { where += ` AND created_at >= ?`; params.push(since); }
      if (until)   { where += ` AND created_at < ?`;  params.push(until); }
      if (channel) { where += ` AND source LIKE ?`;   params.push(`${channel}%`); }
      // Alias-aware include filter (personal-agent → both canonical + mya-personal).
      const agentFilter = buildAgentIdFilter(agentId);
      if (agentFilter.sql) {
        where += ` AND ${agentFilter.sql}`;
        params.push(...agentFilter.params);
      }
      if (excludeAgentId) {
        // Each entry in excludeAgentId expands through aliases too — excluding
        // 'personal-agent' must also exclude 'mya-personal' or company-scope
        // recall would leak personal data.
        const requested = Array.isArray(excludeAgentId) ? excludeAgentId : [excludeAgentId];
        const expanded = requested.flatMap((id) => resolveAgentIds(id) || []);
        if (expanded.length) {
          const placeholders = expanded.map(() => '?').join(', ');
          where += ` AND (agent_id NOT IN (${placeholders}) OR agent_id IS NULL)`;
          params.push(...expanded);
        }
      }

      const countResult = await d1Query(`SELECT COUNT(*) as count FROM messages ${where}`, params);
      const total = countResult.results?.[0]?.count || 0;

      const dataResult = await d1Query(
        // attachment_id rides the projection so the agent-facing reader can join
        // the attachment's derived text (transcript/caption) — src/agent/attachment-context.js.
        // Still vector-free (no embedding_768) and metadata-free.
        `SELECT id, content, role, source, agent_id, attachment_id, created_at FROM messages ${where} ORDER BY created_at ASC LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      );

      return {
        messages: dataResult.results || [],
        total, offset, limit,
        hasMore: offset + limit < total,
      };
    },

    async selectTimeline(userId, { limit = 50, before, since, afterId, scope } = {}) {
      // metadata is encrypted at rest and is NEVER projected to the UI — both
      // consumers (GET /messages and db.streams.feed) run rows through
      // assembleTimelineMessages, which strips it. So we don't SELECT it at all:
      // that avoids a per-row decrypt of an encrypted column on every timeline /
      // river open (a hot path), AND keeps triage decisions / dedupe nonces /
      // delivery state strictly behind the read path (assemble still destructures
      // `metadata` out defensively in case a future projection re-adds it).
      let sql = `SELECT id, role, content, source, agent_id, created_at, message_type, attachment_id, model FROM messages WHERE user_id = ? AND forgotten_at IS NULL`;
      const params = [userId];
      if (before) { sql += ` AND created_at < ?`; params.push(before); }
      // `since` is the unified-river time-scope floor (Today/7d/All) — pushed into
      // SQL so cursor pagination stays correct across the cross-table merge.
      if (since) { sql += ` AND created_at >= ?`; params.push(since); }
      if (afterId) {
        sql += ` AND rowid < (SELECT rowid FROM messages WHERE id = ?)`;
        params.push(afterId);
      }
      if (scope && scope !== 'all') {
        const list = Array.isArray(scope) ? scope : [scope];
        const placeholders = list.map(() => '?').join(', ');
        sql += ` AND scope IN (${placeholders})`;
        params.push(...list);
      } else if (!scope) {
        const allowed = _envAllowedScopes();
        if (allowed) {
          const placeholders = allowed.map(() => '?').join(', ');
          sql += ` AND scope IN (${placeholders})`;
          params.push(...allowed);
        }
      }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit);
      const result = await d1Query(sql, params);
      return result.results || [];
    },

    // Conversation-scoped history (Phase 5, Step 6) — the rows for ONE conversation,
    // for a channel/scheduled turn's history hydration. Modeled on selectTimeline but
    // filtered by conversation_id (which selectTimeline ignores). user_id + conversation_id
    // together scope it: a channel turn can only ever see ITS conversation, never the
    // owner's chat or another channel. content auto-decrypts via the d1Query wrapper.
    // Newest-first (like selectTimeline); the caller reverses for chronological order.
    async selectByConversation(userId, conversationId, { limit = 30, before } = {}) {
      if (!conversationId) return [];
      let sql = `SELECT id, role, content, source, agent_id, created_at, message_type, attachment_id FROM messages WHERE user_id = ? AND conversation_id = ? AND forgotten_at IS NULL`;
      const params = [userId, conversationId];
      if (before) { sql += ` AND created_at < ?`; params.push(before); }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(Number(limit) || 30);
      const result = await d1Query(sql, params);
      return result.results || [];
    },

    async countByUser(userId) {
      const result = await d1Query(`SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND forgotten_at IS NULL`, [userId]);
      return firstRow(result)?.count || 0;
    },

    // Count messages in a [since, until) window, optionally excluding sources — the
    // quiet-day gate uses this to decide, in code, whether a check-in cycle has enough
    // REAL activity to be worth composing (excluding the agent's own 'scheduler' output
    // so past check-ins don't inflate the next day's count). created_at is plaintext →
    // a cheap index scan; no content touched.
    async countInRange(userId, { since, until, excludeSources = [] } = {}) {
      let where = `WHERE user_id = ? AND forgotten_at IS NULL`;
      const params = [userId];
      if (since) { where += ` AND created_at >= ?`; params.push(since); }
      if (until) { where += ` AND created_at < ?`; params.push(until); }
      for (const s of excludeSources) { where += ` AND (source IS NULL OR source <> ?)`; params.push(s); }
      const result = await d1Query(`SELECT COUNT(*) AS count FROM messages ${where}`, params);
      return firstRow(result)?.count || 0;
    },

    // Coverage of recallable memory — total + the time span — for the getContext
    // AWARENESS line, so the agent is grounded in HOW MUCH it actually holds (and
    // doesn't over-claim coverage). created_at is plaintext, so MIN/MAX is a cheap
    // index scan; no content is touched.
    async coverage(userId) {
      const result = await d1Query(
        `SELECT COUNT(*) AS total, MIN(created_at) AS earliest, MAX(created_at) AS latest FROM messages WHERE user_id = ? AND forgotten_at IS NULL`,
        [userId],
      );
      const r = firstRow(result) || {};
      return { total: r.total || 0, earliest: r.earliest || null, latest: r.latest || null };
    },

    // ── Orphaned chat-history recovery (the conversationId send-path bug) ────────
    // Turns saved before the encrypted-WS send path carried conversationId landed
    // with conversation_id = NULL, so threaded history never finds them. These two
    // back the EXPLICIT, user-triggered "recover previous chats" action (NOT an
    // automatic read-time fallback — that would bleed unrelated NULL rows into a
    // threaded query and break conversation isolation). conversation_id is a
    // plaintext filter column, so adopt is a direct UPDATE; no content is touched.
    async countOrphanChatHistory(userId, { source = 'portal-chat' } = {}) {
      const result = await d1Query(
        `SELECT COUNT(*) AS count FROM messages WHERE user_id = ? AND conversation_id IS NULL AND source = ? AND forgotten_at IS NULL`,
        [userId, source],
      );
      return firstRow(result)?.count || 0;
    },
    async adoptOrphanChatHistory(userId, conversationId, { source = 'portal-chat' } = {}) {
      if (!conversationId) return 0;
      const result = await d1Query(
        `UPDATE messages SET conversation_id = ? WHERE user_id = ? AND conversation_id IS NULL AND source = ? AND forgotten_at IS NULL`,
        [conversationId, userId, source],
      );
      return result?.meta?.changes ?? 0;
    },

    async selectAll(userId, { limit = 500, offset = 0 } = {}) {
      limit = clampLimit(limit, 500, 5000);
      const result = await d1Query(
        `SELECT id, role, content, source, agent_id, created_at, message_type, attachment_id FROM messages WHERE user_id = ? AND forgotten_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [userId, limit, offset],
      );
      return result.results || [];
    },

    async listAgentIds() {
      const userId = process.env.MYA_USER_ID;
      const result = await d1Query(
        `SELECT DISTINCT agent_id FROM messages WHERE agent_id IS NOT NULL AND user_id = ?`,
        [userId],
      );
      return (result.results || []).map((r) => r.agent_id);
    },

    async matchMessages(embedding, userId, count = 5) {
      // Mind-search is the only path. Vectorize fallback removed
      // (Wave 4b 2026-05-04) — that path was 1024D-vs-768D broken
      // since the BGE shutdown and we don't keep deprecated paths
      // alive as silent fallbacks. If mind-search is unregistered
      // or fails, return empty and let the caller surface the
      // condition (the /internal/v1/search/mindscape endpoint
      // already returns 503 + Retry-After when subsystems aren't
      // ready, so the user-visible signal is preserved).
      // NOTE (found while wiring the delete cascade): this used to import
      // '../mind-search/registry.js' — a path that DOES NOT EXIST (the module is
      // src/search/registry.js). The dynamic import rejected, so matchMessages threw
      // instead of degrading to []. It also called mindSearch.query(), which the
      // helpers object does not expose (it has backend.query / search / bulkSearch).
      // Both fixed here; behaviour on a missing subsystem is still an empty result.
      let mindSearch = null;
      try {
        const { getMindSearch } = await import('../search/registry.js');
        mindSearch = getMindSearch();
      } catch { return []; }
      if (!mindSearch?.backend?.query) return [];

      let matches = [];
      try {
        const result = await mindSearch.backend.query({
          embedding,
          topK: count,
          recency: 'mixed',
        });
        matches = (result.hits || []).map((h) => ({ id: h.id, score: h.score }));
      } catch {
        return [];
      }
      if (!matches.length) return [];

      const ids = matches.map((m) => m.id);
      const placeholders = ids.map(() => '?').join(', ');
      const result = await d1Query(
        `SELECT id, content, role, source, agent_id, created_at, entity_summary FROM messages WHERE user_id = ? AND id IN (${placeholders}) AND forgotten_at IS NULL`,
        [userId, ...ids],
      );
      const scoreMap = new Map(matches.map((m) => [m.id, m.score]));
      return (result.results || [])
        .map((row) => ({ ...row, similarity: scoreMap.get(row.id) || 0 }))
        .sort((a, b) => b.similarity - a.similarity);
    },

    async matchDocuments(embedding, userId, count = 5, includeInternal = false) {
      // Scan-matcher only. Vectorize fallback removed (Wave 4b).
      const { getScanMatcher } = await import('../mind-search/scan-matcher-registry.js');
      const sm = getScanMatcher('documents');
      if (!sm) return [];

      let matches = [];
      try { matches = await sm.search(embedding, count); }
      catch { return []; }
      if (!matches.length) return [];

      const ids = matches.map((m) => m.id);
      const placeholders = ids.map(() => '?').join(', ');
      let sql = `SELECT id, path, title, summary, content FROM documents WHERE user_id = ? AND id IN (${placeholders}) AND forgotten_at IS NULL`;
      if (!includeInternal) sql += ` AND is_internal = 0`;
      const result = await d1Query(sql, [userId, ...ids]);

      const scoreMap = new Map(matches.map((m) => [m.id, m.score]));
      return (result.results || [])
        .map((row) => ({ ...row, similarity: scoreMap.get(row.id) || 0 }))
        .sort((a, b) => b.similarity - a.similarity);
    },
  });
}
