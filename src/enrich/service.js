// D7 enrichment service — the embed-on-write half.
//
// Consumes the work queue the ingestion choke-point fills: every captured
// message lands with nlp_processed = 0. This service drains that backlog,
// computes the Nomic v1.5 768-d embedding for each message's plaintext, wraps
// it as a per-scope wrapped-DEK envelope (encryptVector), and writes it to
// embedding_768 — the column the mind-search ANN read path consumes.
//
// State machine: 0 pending → 2 embedded, or -1 on a per-row failure. A poison
// row is isolated (error recorded in nlp_error, drain continues) so one bad
// message never stalls the queue.
//
// Pure + injectable: deps are { messages, embed, getMasterKey }. No HTTP, no
// transport — the /enrich-all listener (the enqueue nudge target) is a thin
// Tier-2 wrapper over drainOnce. Tier-1 verifies drainOnce directly with a
// deterministic stub embedder, no embed-service required.
//
// Crypto note: encryptVector is called WITHOUT a userId. encrypt() derives a
// per-user key when given userId, but the canonical mind-search read path
// (decryptVector) passes no userId and decrypts master-key-direct — so writing
// with a userId would produce envelopes that never decrypt back. The no-userId
// path keeps write and read on the same key derivation.
//
// NLP entity/tag extraction (the other half of D7) is NOT here yet — this
// skeleton ships embed-on-write only; nlp_processed = 2 means "embedded". The
// tag/entity pass will advance its own marker when built.

import { encodeVectorRaw } from '../search/ann/decode.js';
import { EMBED_DIM } from '../embed/client.js';
import { TAXONOMY_VERSION } from './categories-prompt.js';
import { getMindSearch } from '../search/registry.js';
import { extract } from './extract.js';
import { embedTextOf } from './derived-text.js';

// ── Bounded, outage-safe retry for stuck rows (2026-07-18) ─────────────────────
// A transient embed failure (null vector) used to leave a row pending with NO
// attempt accounting, so a row that never embeds was re-selected every 15s cycle
// FOREVER — and the activity labels ("Embedding messages") are backlog-count
// projections, so ONE such row kept them lit indefinitely (operator live-test,
// 76k-message vault). The counter must survive restarts and be visible to the
// backlog SQL, so it is PERSISTED in nlp_error (plaintext-queryable by design —
// crypto-local ENCRYPTED_FIELDS.messages is []; never contains content):
//   'embed-retry:N'  — row still PENDING (nlp_processed 0), N counted attempts
//   'embed-capped:N' — row TERMINAL (nlp_processed -1) after N counted attempts
// An attempt is counted ONLY when the failure is attributable to the ROW, not the
// service: (a) the same drainOnce pass successfully embedded at least one OTHER
// row (the service is provably up), or (b) the row was the SOLE embed candidate
// this pass — a lone repeat-failer, with nothing else that could have proven the
// service down. If OTHER candidates were present and NONE embedded, that is an
// outage signature and NO counter advances — not even for rows already carrying a
// marker. A total outage (including a degrade-then-die, where much of the backlog
// already sits at 'embed-retry:N') therefore burns ZERO attempts on any pass with
// more than one candidate — the whole backlog survives to retry.
// One attempt per drainer CYCLE at most (`attemptedThisCycle`), so the drainer's
// 200-pass loop can never burn the budget in seconds.
// Before an attempt is counted the row gets a LAST-CHANCE rescue: a per-row
// embed with a much longer timeout (EMBED_RESCUE_TIMEOUT_MS), so a valid-but-slow
// row lands instead of being retired. Terminal marks are RARE and RECOVERABLE:
// the drainer reclaims 'embed-capped' rows once per boot, and
// POST /portal/enrichment/retry-failed resets them on demand.
export const EMBED_MAX_ATTEMPTS = 5;
export const EMBED_RETRY_MARK = 'embed-retry';
export const EMBED_CAPPED_MARK = 'embed-capped';
export const EMBED_RESCUE_TIMEOUT_MS = 120_000;

/**
 * Parse the counted-attempt number out of an nlp_error marker. Content-free and
 * total: any non-marker string (a real error message, junk, null) reads as 0
 * attempts — unrelated errors must never be mistaken for attempt state.
 * @param {string|null|undefined} nlpError
 * @returns {number}
 */
export function embedAttemptsOf(nlpError) {
  const m = /^embed-(?:retry|capped):(\d+)$/.exec(String(nlpError ?? ''));
  return m ? Number(m[1]) : 0;
}

// L1 label cap — the same progress-aware principle for the categorize path. A
// persistently-erroring classify on one row used to retry the same head-of-queue
// row every cycle forever (`catch { failed++; break; }` with no accounting).
// categories_processed = -1 is the terminal LABEL-GAVE-UP marker (the pending
// predicate selects only 0/NULL, so a -1 row leaves the backlog and the labels
// clear). Attempts are in-memory per service instance (there is no label-error
// column; a restart grants a fresh budget — bounded per boot, and consistent
// with the embed path's boot reclaim of capped rows).
export const LABEL_MAX_ATTEMPTS = 5;

export function createEnrichmentService(deps) {
  if (!deps) throw new TypeError('createEnrichmentService: deps required');
  const { messages, embed, getMasterKey, classify } = deps;
  if (!messages
      || typeof messages.selectPendingEnrichment !== 'function'
      || typeof messages.updateEnrichment !== 'function'
      || typeof messages.selectPendingNlp !== 'function'
      || typeof messages.updateNlp !== 'function') {
    throw new TypeError(
      'createEnrichmentService: messages namespace with selectPendingEnrichment + updateEnrichment + selectPendingNlp + updateNlp required',
    );
  }
  if (!embed || typeof embed.embed !== 'function') {
    throw new TypeError('createEnrichmentService: embed client with .embed() required');
  }
  if (typeof getMasterKey !== 'function') {
    throw new TypeError('createEnrichmentService: getMasterKey() required');
  }

  // In-memory L1 label-attempt counters (rowId → counted attempts). Cleared on a
  // successful label, on terminal (-1), and by resetLabelAttempts() (the
  // retry-failed route). See LABEL_MAX_ATTEMPTS above for the design.
  const _labelAttempts = new Map();

  /**
   * Drain one batch of pending messages for a user. Fail-closed on the vault:
   * if the master key is unavailable (locked / no tmpfs) it refuses the whole
   * batch rather than mark rows processed with no embedding. Per-row failures
   * are isolated and never abort the batch.
   *
   * `attemptedThisCycle` (optional Set<rowId>) is the drainer's per-CYCLE attempt
   * budget: the drainer creates ONE Set per cycle and passes it to every pass, so
   * a row's retry counter can rise at most once per cycle however many of the
   * ≤200 passes re-select it. Absent ⇒ this call is its own cycle.
   *
   * @param {{userId: string, batchSize?: number, attemptedThisCycle?: Set<string>}} opts
   * @returns {Promise<{scanned: number, embedded: number, failed: number, skipped: number, capped: number}>}
   */
  async function drainOnce({ userId, batchSize = 50, attemptedThisCycle } = {}) {
    if (!userId) throw new TypeError('drainOnce: userId required');

    // Fail closed (CLAUDE.md §3): missing key → refuse to write. Resolve once
    // per batch, not per row.
    const masterKey = await getMasterKey();
    if (!masterKey) {
      throw new Error('enrichment: master key unavailable — vault locked, refusing to write');
    }

    const rows = await messages.selectPendingEnrichment(userId, { limit: batchSize });
    let embedded = 0;
    let failed = 0;
    let skipped = 0;
    let capped = 0;
    const cycleSet = attemptedThisCycle instanceof Set ? attemptedThisCycle : new Set();
    // Rows whose vector came back null this pass — judged AFTER the pass, when we
    // know whether anything else embedded (the progress-aware attempt rule above).
    const transientRows = [];

    // Embed in SIZE-BUDGETED CHUNKS (D-131 root cause, QA hard evidence
    // 2026-08-05 on the 67k vault). The old fixed 12-row slice was sized for
    // chat messages; 12 large imported .md docs (avg 8k chars, head 21k–77k)
    // take >120s in ONE /batch call against the 30s default client timeout —
    // the client aborts, the per-row fallback then times out too because the
    // single-threaded service is still grinding the ABORTED batch, 0 rows
    // embed, and the outage guard (below) freezes the attempt counters: the
    // same 12 rows re-select forever at 99% CPU. The service itself is fine —
    // it windows long text internally (embed-service.py _embed_locked, ≤512-
    // token windows, weighted mean-pool, per-text cost capped at MAX_CHARS
    // 40k) — the defect was purely this caller's batch economics. Two rules:
    //   • pack by CHAR BUDGET (≈ one max-size doc worth of service windows per
    //     call) as well as row count — short chats still pack 12, one large
    //     doc rides alone;
    //   • give every call a SIZE-SCALED timeout (floor 30s, ~1.5ms/char +
    //     headroom, ceiling EMBED_RESCUE_TIMEOUT_MS) so a legitimate
    //     15s-per-doc compute is never aborted mid-flight.
    // Each chunk still falls back to per-row embed() (same scaled budget) so
    // one poison row — or a stub embedder without embedBatch — can't sink the
    // rest.
    const EMBED_CHUNK = 12;                  // max rows per call (short-message packing)
    const EMBED_SERVICE_MAX_CHARS = 40_000;  // mirror of embed-service.py MAX_CHARS — per-text cost cap
    const EMBED_CHUNK_CHAR_BUDGET = 20_000;  // ~2 large docs per call — sized so the worst
                                             // chunk (20k ≈ 2×16s measured compute) sits at
                                             // ~50% of its budget, not ~100% (round-2 review:
                                             // 40k of dense docs at QA's own 12–16s/8k band
                                             // could exceed the old 75s budget)
    const embedCallBudgetMs = (chars) => Math.min(EMBED_RESCUE_TIMEOUT_MS, Math.max(30_000, 15_000 + Math.ceil(chars * 2.5)));
    const effChars = (t) => Math.min(String(t || '').length, EMBED_SERVICE_MAX_CHARS);
    // Greedy packer: close a chunk at EMBED_CHUNK rows OR when the next row
    // would blow the char budget (a single over-budget row rides alone).
    const chunks = [];
    {
      let cur = [], curChars = 0;
      for (const row of rows) {
        const c = effChars(embedTextOf(row));
        if (cur.length > 0 && (cur.length >= EMBED_CHUNK || curChars + c > EMBED_CHUNK_CHAR_BUDGET)) {
          chunks.push(cur); cur = []; curChars = 0;
        }
        cur.push(row); curChars += c;
      }
      if (cur.length) chunks.push(cur);
    }
    for (const chunk of chunks) {
      // ⚠️ EMBED THE MESSAGE *PLUS* ITS ATTACHMENT'S DERIVED TEXT, never `row.content`
      // alone (2026-07-26). On the import path a voice note's content is "File: memo.ogg"
      // and the spoken words live on `attachments.transcript`, which selectPendingEnrichment
      // now LEFT JOINs in — so embedding content alone vectorised the FILENAME. ONE
      // composition (enrich/derived-text.js) feeds every embed call below, including the
      // per-row fallback and the rescue retry: a second copy of this rule is how the rescue
      // silently re-embeds a different string from the batch it is rescuing.
      const texts = chunk.map((r) => embedTextOf(r));
      const chunkChars = texts.reduce((a, t) => a + effChars(t), 0);
      const chunkBudget = { timeoutMs: embedCallBudgetMs(chunkChars) };
      let vectors;
      try {
        vectors = typeof embed.embedBatch === 'function'
          ? await embed.embedBatch(texts, 'document', chunkBudget)
          : await Promise.all(texts.map((t) => embed.embed(t, 'document', { timeoutMs: embedCallBudgetMs(effChars(t)) })));
      } catch {
        // Whole-chunk embed failed — retry per row so one bad/slow row can't sink
        // the others; a row that still fails gets a null vector → handled by the
        // bounded attempt accounting below (pending, counted only against a
        // provably-up service — never blind-poisoned).
        vectors = [];
        for (const t of texts) {
          try { vectors.push(await embed.embed(t, 'document', { timeoutMs: embedCallBudgetMs(effChars(t)) })); }
          catch { vectors.push(null); }
        }
      }

      for (let i = 0; i < chunk.length; i++) {
        const row = chunk[i];
        const text = texts[i];
        const vec = vectors[i];
        // Empty/blank content can't embed — TERMINAL SKIP (nlp_processed=1) so it
        // leaves the backlog for good. Was: stuck at nlp_processed=0 forever,
        // keeping enrichmentPending > 0 and starving the "settled → generate" gate.
        // ⚠️ THE TEST IS THE COMPOSED TEXT, NOT `row.content`: a message whose body is
        // whitespace but whose attachment carries a transcript has something real to
        // embed, and terminal-skipping it would strand the transcript permanently
        // (nlp_processed = 1 is never re-selected). A row with neither still skips.
        if (!text || !text.trim()) {
          await messages.updateEnrichment(row.id, userId, { nlpProcessed: 1 });
          skipped++;
          continue;
        }
        // TRANSIENT embed failure: vec is null/undefined (a service timeout/outage
        // during this chunk, not a model error). Leave the row PENDING (no write yet)
        // and remember it — the post-pass attempt accounting below decides whether
        // this failure counts against the row (only when the service is provably up)
        // and gives it a longer-timeout rescue first. NEVER permanent-poison it here —
        // the old code threw "embed returned object dims, expected 768" (typeof null
        // === 'object'), which the drainer's self-heal skipped forever, stranding
        // valid msgs.
        if (vec == null) {
          // Carry the COMPOSED text, not row.content — the rescue below must re-embed
          // exactly what this pass tried to embed.
          transientRows.push({ id: row.id, text, prior: embedAttemptsOf(row.nlp_error) });
          continue;
        }
        try {
          // GENUINE dimension mismatch (a real wrong-size array) → permanent poison.
          if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
            throw new Error(`embed returned ${vec.length} dims, expected ${EMBED_DIM}`);
          }
          // Stage A: store the 768-d vector as RAW LE-f32 BLOB bytes (no per-field
          // envelope; at-rest secrecy is whole-file SQLCipher). embedding_768 is
          // NEVER_AUTO_DECRYPT, so the adapter binds this Buffer as a BLOB verbatim;
          // the reader (d1-loader decodeStoredVector / pipeline decode_stored_vector)
          // dual-reads raw + any legacy envelope.
          const raw = encodeVectorRaw(Float32Array.from(vec));
          await messages.updateEnrichment(row.id, userId, { embedding768: raw, nlpProcessed: 2 });
          // Incremental search maintenance (§8): hand the just-computed vector to
          // the on-disk index (NO-OP for the in-RAM backend; never decrypts again;
          // best-effort, never blocks enrichment). @see src/search/index.js noteVector.
          try { getMindSearch()?.noteVector?.(row.id, vec); } catch { /* best-effort */ }
          embedded++;
        } catch (err) {
          // Isolate the poison row. Never log row.content (CLAUDE.md §1 — zero
          // plaintext leakage); the message text alone is sensitive.
          await messages.updateEnrichment(row.id, userId, {
            nlpProcessed: -1,
            nlpError: String(err?.message || err).slice(0, 500),
          });
          failed++;
        }
      }
    }

    // ── Post-pass attempt accounting for transient (null-vector) rows ─────────
    // Judged only now, with the whole pass known. A row's failure is COUNTED iff
    // the service is provably up (this pass embedded another row) OR the row was
    // the SOLE embed candidate this pass (a lone repeat-failer) — AND the row
    // hasn't been counted this cycle. A pass with OTHER candidates and ZERO embeds
    // is an outage signature: leave every row untouched (pending, no counter
    // movement) — even prior-marked ones — so an outage can NEVER march the
    // backlog to terminal.
    // COST BOUND: each judged row can cost one EMBED_RESCUE_TIMEOUT_MS call, so a
    // pass judges at most MAX_JUDGED_PER_PASS of them (worst case ~4 min extra per
    // pass, not ~100 min for a 50-row failing batch). Deferred rows are simply not
    // counted this pass — they stay pending with their counters untouched and are
    // judged on a later cycle, oldest first. Deferral is the SAFE direction: it can
    // only slow a cap down, never mark a row without its rescue.
    const MAX_JUDGED_PER_PASS = 2;
    // "Provably up" this pass = we actually embedded a row. When NOTHING embedded,
    // a prior-marked row is still a candidate for counting ONLY if it was the SOLE
    // embed candidate this pass — a lone repeat-failer with nothing else that could
    // have proven the service down. If OTHER candidates were present and none
    // embedded, that is an outage signature and NO counter may advance — not even
    // for rows that already carry a marker (the mass-loss guard: a degrade-then-die
    // must never march a marked backlog to terminal). `skipped` are empty-content
    // rows, which never exercise the embed service, so they are not candidates.
    const soleCandidate = (rows.length - skipped) <= 1;
    // D-131 root cause, the FREEZE half (QA hard evidence 2026-08-05): when a
    // whole pass nulls with other candidates present, the outage signature
    // deliberately counts nothing — but with the counter frozen (observed: 4 of
    // 5 forever), a head of genuinely-unembeddable rows re-selects every cycle
    // for the life of the vault and the backlog can never finish. The narrow,
    // guard-preserving unfreeze: when the service answers a POST-PASS health
    // probe as loaded-and-ok, this was NOT an outage — judge exactly ONE row
    // (rescue-first, so a valid-but-slow row lands via the 120s budget instead
    // of burning an attempt). A wedged/loading/erroring/unreachable service
    // fails the probe → nothing counted → the mass-loss guard holds untouched.
    // ⚠️ ONCE PER CYCLE, NOT PER PASS (round-2 review BLOCKER, reproduced): the
    // drainer runs up to 200 passes per cycle sharing ONE attemptedThisCycle
    // Set, and a cap keeps `moved > 0` so the loop does NOT break — a per-pass
    // bound judged a FRESH row every pass and marched 200 rows to terminal in
    // ONE cycle against a health-ok-but-overloaded service (fast-503 shedding
    // with /health deliberately lock-free is embed-service.py's DOCUMENTED
    // overload posture). The sentinel in the shared Set bounds the unfreeze to
    // ONE row per cycle — pass 2 then moves nothing, the no-progress break
    // fires, and the D-131(b) stall backoff engages exactly as designed. Worst
    // case is now 1 counted attempt + 1 health probe + 1 rescue per 15s cycle.
    const IDLE_JUDGE_SENTINEL = '__idle-judged-this-cycle__';
    let idleHealthOk = false;
    let idleJudged = false;
    if (embedded === 0 && !soleCandidate && transientRows.length > 0 && !cycleSet.has(IDLE_JUDGE_SENTINEL)) {
      try {
        const h = await embed.health();
        // STRICT, fail-closed (round-2 review #3): this predicate retires rows,
        // so only an explicit ok-and-loaded counts — an empty 200 (port
        // squatter), an unknown status, or a missing `loaded` field must all
        // read NOT-provably-up. (The drainer's own embedHealth() gate is the
        // read-side sibling; keep both strict.)
        idleHealthOk = Boolean(h) && h.status === 'ok' && h.loaded === true;
      } catch { idleHealthOk = false; }
      if (idleHealthOk) { cycleSet.add(IDLE_JUDGE_SENTINEL); idleJudged = true; }
    }
    const judgeCap = (embedded > 0 || soleCandidate) ? MAX_JUDGED_PER_PASS : (idleHealthOk ? 1 : 0);
    let judged = 0;
    for (const t of transientRows) {
      const suspect = embedded > 0 || (t.prior > 0 && soleCandidate) || idleHealthOk;
      if (!suspect || cycleSet.has(t.id)) continue;
      if (judged >= judgeCap) break;
      judged++;
      cycleSet.add(t.id);
      // LAST-CHANCE RESCUE before the attempt is counted: one per-row embed with a
      // much longer budget, so a valid-but-slow message (the documented 30s-timeout
      // failure) lands instead of burning an attempt. Only reached for rows failing
      // against a provably-up service, once per cycle — never during an outage.
      let rescued = null;
      try { rescued = await embed.embed(t.text, 'document', { timeoutMs: EMBED_RESCUE_TIMEOUT_MS }); }
      catch { rescued = null; }
      if (Array.isArray(rescued) && rescued.length === EMBED_DIM) {
        try {
          const raw = encodeVectorRaw(Float32Array.from(rescued));
          // nlpError defaults to null in updateEnrichment → the retry counter clears.
          await messages.updateEnrichment(t.id, userId, { embedding768: raw, nlpProcessed: 2 });
          try { getMindSearch()?.noteVector?.(t.id, rescued); } catch { /* best-effort */ }
          embedded++;
          continue;
        } catch { /* fall through to the counted attempt below */ }
      }
      const n = t.prior + 1;
      try {
        if (n >= EMBED_MAX_ATTEMPTS) {
          // TERMINAL: the row leaves the backlog (pending predicate is 0/NULL) so the
          // activity labels can clear. Marker only — never content (CLAUDE.md §1).
          await messages.updateEnrichment(t.id, userId, {
            nlpProcessed: -1,
            nlpError: `${EMBED_CAPPED_MARK}:${n}`,
          });
          capped++;
          failed++;
        } else {
          // Still pending — persist the counted attempt in the marker.
          await messages.updateEnrichment(t.id, userId, {
            nlpProcessed: 0,
            nlpError: `${EMBED_RETRY_MARK}:${n}`,
          });
        }
      } catch { /* counter write failed — row simply stays pending; never fatal */ }
    }

    return { scanned: rows.length, embedded, failed, skipped, capped, idleJudged };
  }

  /**
   * Stage 2: the deterministic NLP rules pass. Drains embedded-but-not-enriched
   * rows (nlp_processed=2), extracts entities/tags/summary from plaintext, and
   * advances them to enriched (1). No master key needed here — the db adapter
   * already holds the unlock()-derived key and encrypts the written fields. A
   * poison row is isolated (→ -1 + nlp_error) and never stalls the batch.
   *
   * @param {{userId: string, batchSize?: number}} opts
   * @returns {Promise<{scanned: number, enriched: number, failed: number}>}
   */
  // Stage 3 (Context Engine L1): per-message domain + register labels via the injected
  // classifier. Independent of the nlp_processed machine (its own categories_processed flag).
  // Fail-soft: a transient classify failure (model down) leaves the row pending (0) and stops
  // the batch — never poisons a row, never logs content (§1). A model that replies with
  // garbage yields null labels (still marked attempted, not retried forever).
  //
  // BOUNDED RETRY (2026-07-18, same progress-aware principle as the embed path): a
  // row-specific persistent classify error used to retry the same head-of-queue row every
  // cycle forever. A failure is COUNTED against the row only when the classifier is provably
  // up — this pass labeled another row, or the row is already suspect (a prior counted
  // attempt). At LABEL_MAX_ATTEMPTS the row is terminally skipped for labeling
  // (categories_processed = -1: the pending predicate selects only 0/NULL, so it leaves the
  // backlog and the "Categorizing messages" label can clear) and the pass CONTINUES with the
  // next row — a gave-up row never wedges the batch. A model-down outage (no progress, no
  // suspects) counts nothing and stops the batch exactly as before.
  //
  // KNOWN GAP (2026-07-18, deferred): the `prior counted attempt` clause has the same
  // shape the embed path's mass-loss fix removed — during a TOTAL outage a row already
  // carrying an in-memory attempt still advances toward terminal. Lower impact than the
  // embed path (the counter is in-memory and a restart clears it; capped labels are
  // reclaimed on boot + by retry-failed), and it cannot be closed by a one-line sole-
  // candidate clause the way the embed path was: this loop BREAKS on the first failure,
  // so a persistently-bad HEAD row fails with `enriched === 0` before any sibling can
  // prove the model up, and a naive guard would WEDGE the batch on it (regresses the
  // "gave-up row never wedges" property). A correct fix needs the loop restructured to
  // post-pass judgment like drainOnce. Tracked for a follow-up; not done here to keep
  // this change scoped to the embed-path MEDIUM finding. Terminal rows are
  // recoverable: the drainer reclaims them once per boot, and POST
  // /portal/enrichment/retry-failed resets them on demand.
  async function enrichCategoriesOnce({ userId, batchSize = 25, classify: classifyOverride } = {}) {
    if (!userId) throw new TypeError('enrichCategoriesOnce: userId required');
    // Per-cycle override lets the drainer pick the labeling model from settings each
    // cycle (so a Settings change takes effect without a restart); falls back to the
    // classifier bound at construction (tests inject one there).
    const fn = typeof classifyOverride === 'function' ? classifyOverride : classify;
    if (typeof fn !== 'function') return { scanned: 0, enriched: 0, failed: 0, skipped: 'no-classifier' };
    const rows = await messages.selectPendingCategories(userId, { limit: batchSize });
    let enriched = 0;
    let failed = 0;
    let gaveUp = 0;

    // ── D-132 (U-C): BATCH-FIRST. One model call labels up to K substantive rows
    // (K = MYCELIUM_L1_BATCH, default 8; 1 disables — the revert lever). The
    // fixed prompt prefix (~1.7k chars) is paid once instead of K times.
    // SEMANTICS ARE STRICTLY ADDITIVE, never replacing the per-row contract:
    //   • a failed/unparseable BATCH call burns ZERO attempts (the embed rule:
    //     "a pass with zero progress burns zero attempts") — rows simply fall
    //     through to the unchanged per-row loop below, whose outage/attempt
    //     logic is untouched;
    //   • only rows the STRICT id-keyed parser matched are written from the
    //     batch; every other row takes the single path this same pass.
    const batchK = Math.max(1, Number(process.env.MYCELIUM_L1_BATCH ?? 8) || 1);
    /** @type {Map<string, any>|null} row.id → labels resolved by the batch call */
    let batchLabels = null;
    if (typeof fn?.batch === 'function' && batchK > 1) {
      const cand = rows
        .map((r) => ({ id: r.id, content: (r.content || '').trim() }))
        .filter((r) => r.content)
        .slice(0, batchK);
      if (cand.length >= 2) {
        try {
          const res = await fn.batch(cand.map((c) => c.content));
          batchLabels = new Map();
          cand.forEach((c, idx) => { if (res?.[idx]) batchLabels.set(c.id, res[idx]); });
        } catch { batchLabels = null; /* outage/failure → zero burn; per-row path decides */ }
      }
    }

    for (const row of rows) {
      const content = (row.content || '').trim();
      if (!content) { // nothing to classify — mark attempted so it isn't re-selected
        await messages.updateCategories(row.id, userId, { categoriesProcessed: 1, taxonomyVersion: TAXONOMY_VERSION });
        _labelAttempts.delete(row.id);
        continue;
      }
      // Batch-resolved → write without a second model call (provenance unchanged:
      // fn.model produced these labels too).
      const fromBatch = batchLabels?.get(row.id);
      if (fromBatch) {
        await messages.updateCategories(row.id, userId, {
          domain: fromBatch.domain,
          register: fromBatch.register,
          subregister: fromBatch.subregister,
          taxonomyVersion: TAXONOMY_VERSION,
          model: fn.model,
          categoriesProcessed: 1,
        });
        _labelAttempts.delete(row.id);
        enriched++;
        continue;
      }
      let labels;
      try { labels = await fn(content); }
      catch {
        failed++;
        const prior = _labelAttempts.get(row.id) ?? 0;
        if (enriched === 0 && prior === 0) break; // indistinguishable from model-down → leave pending, stop the batch
        const n = prior + 1;
        if (n >= LABEL_MAX_ATTEMPTS) {
          // Terminal label-gave-up: content-free marker state only, labels untouched.
          try { await messages.updateCategories(row.id, userId, { categoriesProcessed: -1 }); } catch { /* stays pending */ }
          _labelAttempts.delete(row.id);
          gaveUp++;
          continue;            // a gave-up row must not wedge the batch
        }
        _labelAttempts.set(row.id, n);
        break;                 // counted, but still protective: stop hammering a struggling model this pass
      }
      await messages.updateCategories(row.id, userId, {
        domain: labels.domain,
        register: labels.register,
        subregister: labels.subregister,
        taxonomyVersion: TAXONOMY_VERSION,
        model: fn.model,   // provenance (0041): which model produced these labels
        categoriesProcessed: 1,
      });
      _labelAttempts.delete(row.id);
      enriched++;
    }
    return { scanned: rows.length, enriched, failed, gaveUp };
  }

  async function enrichNlpOnce({ userId, batchSize = 50, enrich: enrichOverride } = {}) {
    if (!userId) throw new TypeError('enrichNlpOnce: userId required');
    // Hybrid L2 enrichment when an enricher is injected (regex structured + on-box-model semantic);
    // else the deterministic regex extract(). Both return { entities, tags, entitySummary }, and the
    // enricher degrades to regex internally on a model outage, so this control flow is unchanged.
    const enrichFn = typeof enrichOverride === 'function' ? enrichOverride : extract;
    const rows = await messages.selectPendingNlp(userId, { limit: batchSize });
    let enriched = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const { entities, tags, entitySummary } = await enrichFn(row.content);
        await messages.updateNlp(row.id, userId, {
          entities: JSON.stringify(entities),
          tags: JSON.stringify(tags),
          entitySummary,
          nlpProcessed: 1,
        });
        enriched++;
      } catch (err) {
        // Never log row.content (CLAUDE.md §1 — zero plaintext leakage).
        await messages.updateNlp(row.id, userId, {
          nlpProcessed: -1,
          nlpError: String(err?.message || err).slice(0, 500),
        });
        failed++;
      }
    }

    return { scanned: rows.length, enriched, failed };
  }

  /**
   * Clear the in-memory L1 label-attempt counters. Called by the retry-failed
   * surface after it resets terminal rows to pending, so a freshly-reset row gets
   * a full budget instead of terminal-marking again on its first failure.
   */
  function resetLabelAttempts() { _labelAttempts.clear(); }

  return { drainOnce, enrichNlpOnce, enrichCategoriesOnce, resetLabelAttempts };
}

export default createEnrichmentService;
