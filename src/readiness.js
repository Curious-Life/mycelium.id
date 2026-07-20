// src/readiness.js — the ONE readiness model.
//
// Every consumer that asks a readiness-shaped question ("does the user have data?",
// "is it embedded?", "is an AI connected?", "is the mindscape generated?", "can we
// generate?") should read THIS.
//
// ⚠️ MIGRATION IS IN PROGRESS — do not read this header as a finished state.
//   migrated: /portal/readiness · /mycelium/processing-status · the /generate preflight
//             · /onboarding/status's aiModelsReady
//   NOT yet:  src/mcp.js's makeTopologyReadiness (its own getNoiseStats + a permanent
//             true-latch) · portal-compat's embedCounts() (still the PURE scan)
//             · src/tools/context.js (no readiness at all — the design's biggest win)
//             · portal-app/src/lib/generate.ts (carries its OWN `MIN_EMBEDDED = 5`)
// Until those land, this module is one MORE definition alongside the ones it exists to
// collapse. An earlier version of this header claimed "nothing computes readiness
// privately any more" — that was false when written (independent review, 2026-07-15), and
// a false claim here is exactly how the next reader concludes the job is done.
//
// WHY THIS EXISTS (the sweep that produced it — docs/DATA-READINESS-DESIGN-2026-07-15.md
// §2.8): the same facts were computed in several places, differently, and they disagreed:
//   • "empty"      — the onboarding rail used `messageCount > 0`, the mindscape view used
//                    `points.length > 0`. Both true through the whole middle of onboarding
//                    ⇒ two onboarding surfaces on screen at once (QA item 5).
//   • "generated"  — three answers: /portal/mindscape nodes, the points store, and
//                    getNoiseStats().total.
//   • the SAME count, two cache policies — /onboarding/status read the PURE scan while
//     /processing-status read the CACHED one, so the UI could read "ready" and be 409'd.
//   • `aiModelsReady` was hardcoded `true`.
// One module, one answer, many consumers.
//
// ── SLICED, deliberately (§3.2b) ─────────────────────────────────────────────
// A monolithic get() would drag the multi-second SQLCipher backlog scan into every
// caller. The MCP topology gate is a deliberately CHEAP COUNT (src/mcp.js) and must stay
// that way; getContext is the agent's latency-sensitive preamble. So callers ask for the
// slices they need:
//   get({ slices: ['mindscape'] })     → a cheap COUNT
//   get({ slices: ['data','tags'] })   → SWR-cached scans (never a fresh scan per call)
//   get()                              → everything (the portal's one call)
// Counts ride embedBacklogCached/categoriesBacklogCached by default. `fresh: true` forces
// the PURE path and exists for exactly two callers, both read-after-write correctness
// surfaces: the Generate preflight (data) and /import/preview (evidence — EC4).
//
// ⚠️ NEVER poll a fresh slice. Polling the pure scan per-call once hung the app at boot
// ("identical queries climbing 4.6s→43s" — src/db/messages.js). warm() exists so the
// first user-facing read never pays the cold-start await.
//
// FAIL-CLOSED (CLAUDE.md §3): every slice catches its own errors and degrades to the
// safe answer — unknown ⇒ not-ready, not-connected, cannot-generate. A readiness module
// that throws would take down every consumer at once.
//
// NO PLAINTEXT (CLAUDE.md §1): this returns counts, booleans, enums, timestamps and
// model NAMES. Never message content, never a failure reason, never a token.
//
// ── ONE import, and why it does not cost the header's "stay cheap" promise ────
// `isEnrichProcessingPaused` is drainer.js's MODULE-LEVEL flag read — a synchronous
// in-memory boolean, no DB, no scan, no drainer INSTANCE handle. It is the DEFAULT for
// the injectable `isProcessingPaused` dep below, exactly as getLabelerHealth /
// getEnricherHealth are drainer module-level functions passed as `labelerHealth` /
// `enricherHealth`. The default means every caller gets a truthful `paused` with ZERO
// wiring changes (§3.2's D13); the injection point exists so a gate can force the flag
// either way (paused is the ONE fact the reminder turns on — it must be falsifiable).
// No new load risk: portal-compat.js already imports this same symbol, so drainer is
// already in every readiness consumer's graph; drainer references readiness only in
// comments, so there is no cycle.
import { isEnrichProcessingPaused, getEnrichDrainerStatus } from './enrich/drainer.js';
// The points-bust chokepoint (mindscape-cache.js). The `mindscape` memo below rides the
// SAME explicit-bust discipline as getMindscapePointsCached — one notion of "the points
// changed", not a second drifting one. mindscape-cache imports nothing, so no cycle.
import { onMindscapePointsBust } from './mindscape-cache.js';
// ⚠️ The `pipeline` slice REUSES the activity feed's ETA math (embedEta/categorizeEta) rather
// than re-deriving a second per-item rate (PIPELINE-TRANSPARENCY-DESIGN §"Canonical model":
// "Counts + etaSeconds reuse the existing embedProjection/enrichProjection math — no new scans").
// These are PURE functions of the drainer's in-memory status + a remaining count; they touch no
// DB. portal-activity imports drainer/supervisor but NOT readiness, so there is no cycle.
import { embedEta, categorizeEta } from './portal-activity.js';

/** Generate needs embedded vectors; below this the pipeline dies cryptically. */
const MIN_EMBEDDED = 5;

/**
 * @param {object}   deps
 * @param {object}   deps.db
 * @param {string}   deps.userId
 * @param {() => any} [deps.embedderHealth]     getEmbedderHealth  (src/embed/supervisor.js)
 * @param {() => any} [deps.labelerHealth]      getLabelerHealth   (src/enrich/drainer.js)
 * @param {() => any} [deps.enricherHealth]     getEnricherHealth  (src/enrich/drainer.js)
 * @param {() => any} [deps.transcriberHealth]  getTranscriberHealth (src/transcribe/supervisor.js)
 * @param {() => boolean} [deps.isProcessingPaused]  isEnrichProcessingPaused (src/enrich/drainer.js) — defaults to the module import
 * @param {() => number}  [deps.now]  clock injection for the TTL memos below — exists so a
 *                                    gate can drive TTL expiry without sleeping; production
 *                                    never passes it (same pattern as isProcessingPaused)
 * @param {() => any} [deps.drainerStatus]  getEnrichDrainerStatus (src/enrich/drainer.js) — the
 *                                    in-memory throughput status the `pipeline` slice feeds to
 *                                    embedEta/categorizeEta. Injectable so a gate can drive a rate.
 */
export function createReadiness({ db, userId, embedderHealth, labelerHealth, enricherHealth, transcriberHealth, isProcessingPaused = isEnrichProcessingPaused, isEmbedPaused, isCategorizePaused, now = Date.now, drainerStatus = getEnrichDrainerStatus } = {}) {
  if (!db) throw new TypeError('createReadiness: db required');
  if (!userId) throw new TypeError('createReadiness: userId required');

  // ⚠️ `evidence` is deliberately NOT in ALL — it is OPT-IN ONLY (`slices:['evidence']`).
  // ⚠️ I WROTE "Every other slice is a cached count or an in-memory health read" HERE, and it was
  // FALSE when I wrote it: `channel` was three FULL SECRETS-TABLE DECRYPT SCANS per call (§3.2c —
  // has() is not EXISTS; findRow decrypts every row and matches in JS). That false sentence is
  // part of why E2 then put `channel` on a 4s poll believing it cheap — ~2,700 decrypt scans an
  // hour, for every onboarded user, forever. `channel` is memoized now, so the sentence is TRUE
  // again — but it was a claim about cost in a file whose gates only ever checked SHAPE, which is
  // how it went unexamined. C1 asserts the cost. (independent review HIGH-5, 2026-07-16)
  // Every other slice is a cached count, a memoized read, or an in-memory health read; evidence is three
  // UNINDEXED aggregates over `messages` (the design's own map: "NOT pollable — pure scan
  // + 3 unindexed aggregates"). `get()` with no slices is documented as "the portal's ONE
  // call", and increment G's header popover is going to POLL something — if evidence rode
  // ALL, that poll would quietly full-scan a 76k-row table every tick. Opt-in keeps the
  // expensive slice impossible to buy by accident: a caller has to name it.
  // (2026-07-18: evidence is now ALSO SWR-memoized — see evidenceCached below — but the
  // memo does not soften the opt-in: a 15s-TTL revalidate on a poll would still be a
  // full-table pass every window, bought by accident. Both guards stay.)
  // ⚠️ `processing` IS in ALL — cost derived, not assumed (C1 discipline; gate P-COST).
  // Its price on a repeat poll: `paused` is an in-memory boolean (free); `waiting` sums the
  // THREE already-existing SWR-cached counters (embed + categories + nlp), and in ALL `data`
  // already buys embed and `tags` already buys categories — so the ONLY new cached read is
  // nlp, and on a warm poll all three cost 0 scans; `pausedAt` is ONE PK read
  // (`SELECT settings FROM users WHERE id=?`), the same cost class as `onboarding`'s already-
  // allowlisted read. So processing is cheap enough for `get()` (the portal's one call) AND
  // for G's popover poll — unlike `evidence`, whose three UNINDEXED aggregates keep it opt-in.
  // ⚠️ `pipeline` IS in ALL, and it costs ZERO marginal scans there — every read it needs is
  // ALREADY bought by a sibling slice in ALL: `data` buys the embed backlog (embedBacklogCached),
  // `tags` buys the categories backlog (categoriesBacklogCached), `mindscape` buys the
  // clustering_points COUNT (getNoiseStats, memoized). pipeline re-CALLS those cheap readers, but
  // each lands on the same SWR memo (db/messages.js) / the mindscape closure memo, so a warm poll
  // pays 0 scans — the P-COST discipline, proved by verify:pipeline-status's cost gate. The rest
  // is in-memory: the health readers, the pause flag, the drainer status → embedEta. It rides the
  // portal's ONE call exactly as the design intends (no new poll) BECAUSE it is a strict subset.
  const ALL = ['data', 'tags', 'embedder', 'models', 'ai', 'channel', 'mindscape', 'onboarding', 'processing', 'pipeline'];

  // ── evidence ───────────────────────────────────────────────────────────────
  // "What you brought in", for the invite's Data step — sources, years, how many
  // conversations, how many people. NOT counts of work (that's `data`); this is the
  // proof-of-perception card.
  //
  // ⚠️ WHY ITS OWN SLICE, when §3.2's type sketch put these four fields inside `data`:
  // §3.2b — written later, and the more considered pass — locks the principle that
  // "a cheap probe must stay cheap". The `data` slice is consumed by the GENERATE
  // PREFLIGHT on every click (portal-mindscape.js:569,599) and warmed at boot; it has
  // no use for evidence. Folding four aggregates into it would tax every consumer for
  // one screen's benefit. The two sections of the design contradict each other; the
  // principle wins over the sketch.
  //
  // ⚠️ AND WHY NOT REUSE `/portal/import/preview`, which already returns exactly this
  // shape: because it computes the aggregates alongside the PURE embedBacklog() — a
  // multi-second full-table SQLCipher decrypt that already hung the app at boot once
  // (design PIVOT 2; src/db/messages.js:68-77 — "identical queries climbing 4.6s→43s").
  // The card wants the aggregates WITHOUT that scan. So the SQL moves here and the
  // route delegates (see portal-compat.js) — one implementation, not a twin.
  //
  // ZERO-PLAINTEXT (CLAUDE.md §1): every column read here — created_at, source,
  // conversation_id — is plaintext at rest (NOT in ENCRYPTED_FIELDS.messages), plus
  // COUNT(*). `content` is never touched, so nothing sensitive is decrypted. Keep it
  // that way: this shape crosses the HTTP boundary.
  async function evidence() {
    const one = (r) => (r?.results || r || [])[0] || {};
    const rows = (r) => r?.results || r || [];
    const yearOf = (ts) => { const y = String(ts || '').slice(0, 4); return /^\d{4}$/.test(y) ? Number(y) : null; };
    try {
      const range = one(await db.rawQuery(
        'SELECT MIN(created_at) AS earliest, MAX(created_at) AS latest FROM messages WHERE user_id = ?', [userId]));
      const srcRows = rows(await db.rawQuery(
        `SELECT source, COUNT(*) AS c FROM messages WHERE user_id = ? AND source IS NOT NULL
           GROUP BY source ORDER BY c DESC LIMIT 12`, [userId]));
      const convRow = one(await db.rawQuery(
        `SELECT COUNT(DISTINCT conversation_id) AS c FROM messages
           WHERE user_id = ? AND conversation_id IS NOT NULL`, [userId]));
      // ⚠️ NO inner try/catch here. The route this replaces had one ("people table
      // empty/absent → 0"), and inheriting it made `peopleCount: 0` an UNQUALIFIED CLAIM
      // on a swallowed error: `{peopleCount: 0, unknown: false}` — "you know 0 people",
      // rendered as earned fact, from a query that failed (independent review, 2026-07-16).
      // `people` is created in migrations/0001_init.sql, so the catch never fired for
      // absence — only for real errors. The old route could afford the lie because it never
      // rendered the number as proof-of-perception; the evidence card does.
      // ⇒ let it reach the outer catch, which says `unknown`. One code path, no silent zero.
      const peopleCount = Number(one(await db.rawQuery(
        'SELECT COUNT(*) AS c FROM people WHERE user_id = ?', [userId])).c ?? 0);
      return {
        sources: srcRows.map((r) => ({ source: r.source, count: Number(r.c || 0) })),
        dateRange: {
          earliest: range.earliest || null,
          latest: range.latest || null,
          yearStart: yearOf(range.earliest),
          yearEnd: yearOf(range.latest),
        },
        conversationCount: Number(convRow.c || 0),
        peopleCount,
      };
    } catch {
      // `unknown` — the same discipline as `data` (§3.2a): a query that never ran must
      // not impersonate an empty vault. The card renders nothing rather than "0 sources",
      // which would be a claim we did not earn.
      return { sources: [], dateRange: { earliest: null, latest: null, yearStart: null, yearEnd: null }, conversationCount: 0, peopleCount: 0, unknown: true };
    }
  }

  // ── evidence, cached — the SWR memo in front of the three unindexed aggregates ─
  // WHY: the header StatusPopover reads `?slices=evidence` once per OPEN (G-COST pins
  // that), and on a 76k-message vault the four scans above are the dominant cost of the
  // status panel's first paint. Opt-in (E1) kept the price out of the POLL; this memo
  // takes it off the OPEN too. Same contract as db/messages.js embedBacklogCached:
  // serve stale instantly, single-flight latch, background revalidate — a hammered
  // slice costs ≤1 aggregate pass per TTL window and no caller queues behind another.
  //
  // TTL 15s, fixed (deliberately simpler than embedBacklogCached's 8s/60s split):
  // evidence has no `pending` of its own to key an active/idle split on, and its facts
  // move only on import/forget — surfaces that are user gestures, not drains. 15s keeps
  // a mid-import popover honest within a tick or two of re-opening; idle, the slice is
  // read once per open anyway, so a longer idle TTL would buy nothing. The Embedding
  // row already lives with 8–60s staleness; this is the same accepted model.
  //
  // ⚠️ Only SUCCESSFUL snapshots land in the memo. An `unknown` (the outer catch's
  // degrade) is NEVER cached: caching it would serve a fabricated-empty card for a full
  // TTL window (§3.2a), and holding a PRIOR good snapshot through a failed revalidate
  // is exactly the "hold the last known answer" discipline G3 pins on the client.
  //
  // ⚠️ `fresh` BYPASSES the memo AND the single-flight latch (running its own scan and
  // write-through-refreshing the memo on success): the /import/preview route is a
  // read-after-import correctness surface — its card renders moments after the vault's
  // contents changed, where a stale snapshot is a lie. Bypassing the memo is not enough:
  // joining an in-flight background revalidate (evidenceInFlight) that started BEFORE the
  // import committed would hand back the same pre-import count a memo hit would. Same split
  // as data()'s embedBacklog vs embedBacklogCached — a direct scan, never a shared latch.
  const EVIDENCE_TTL_MS = 15_000;
  let evidenceMemo = null;       // { at:number, value:object } — successful snapshots only
  let evidenceInFlight = null;   // Promise while a recompute runs (single-flight)

  function evidenceRevalidate() {
    if (!evidenceInFlight) {
      evidenceInFlight = evidence()
        .then((v) => { if (!v?.unknown) evidenceMemo = { at: now(), value: v }; return v; })
        .finally(() => { evidenceInFlight = null; });
    }
    return evidenceInFlight;
  }

  async function evidenceCached(fresh) {
    if (fresh) {
      // ⚠️ Run the scan DIRECTLY — do NOT join evidenceInFlight. A background revalidate
      // (a status-popover open, boot warm()) already in flight when /import/preview fires
      // read the vault BEFORE the import committed; joining that single-flight promise would
      // hand this read-after-import caller the PRE-import count — the exact "0 sources /
      // stale count" defect the fresh split exists to prevent (portal-compat.js:1305).
      // Same shape as data(fresh)'s direct embedBacklog() call: own scan, no shared latch,
      // write-through the memo on success (an `unknown` degrade is NEVER cached — §3.2a).
      const v = await evidence();
      if (!v?.unknown) evidenceMemo = { at: now(), value: v };
      return v;
    }
    if (evidenceMemo && now() - evidenceMemo.at < EVIDENCE_TTL_MS) return evidenceMemo.value;
    const inFlight = evidenceRevalidate();
    if (evidenceMemo) return evidenceMemo.value;            // serve stale instantly — never block
    return inFlight;                                        // cold start only: await the first pass once
  }

  // ── data ───────────────────────────────────────────────────────────────────
  // total/embedded/pending/unprocessable. `pending` is COUNTED (never the old
  // `total - embedded` projection) so it reaches 0; `unprocessable` is the residue —
  // content-bearing rows neither done nor queued. A count only.
  async function data(fresh) {
    try {
      const b = fresh
        ? await db.messages.embedBacklog(userId)
        : await db.messages.embedBacklogCached(userId);
      return {
        total: Number(b?.total || 0),
        embedded: Number(b?.embedded || 0),
        pending: Number(b?.pending || 0),
        unprocessable: Number(b?.unprocessable || 0),
      };
    } catch {
      // unknown ⇒ zeros, and canGenerate reads 'unknown' (NOT 'no_messages' — §3.2a).
      return { total: 0, embedded: 0, pending: 0, unprocessable: 0, unknown: true };
    }
  }

  async function tags() {
    try {
      const c = await db.messages.categoriesBacklogCached(userId);
      return { total: Number(c?.total || 0), tagged: Number(c?.tagged || 0), pending: Number(c?.pending || 0) };
    } catch { return { total: 0, tagged: 0, pending: 0, unknown: true }; }
  }

  // ── embedder ───────────────────────────────────────────────────────────────
  // The supervisor's own health vocabulary, surfaced verbatim rather than re-invented.
  function embedder() {
    try {
      const h = embedderHealth?.();
      const status = h?.status || 'unknown';
      return { up: status === 'ok', status };
    } catch { return { up: false, status: 'unknown' }; }
  }

  // ── models ─────────────────────────────────────────────────────────────────
  // The four on-box model components, in ONE uniform shape — {status, message, detail,
  // model, progress} over a shared vocabulary (ok | no_model | downloading | loading |
  // paused | unavailable | deps_missing | down | error | unknown).
  //
  // ⚠️ `paused` was missing from THIS list while the list 4 lines below already carried it —
  // two enumerations of one vocabulary, disagreeing. labelerHealth/enricherHealth both
  // return it (drainer.js), so the omission was the doc lying about a status that ships
  // (re-review, 2026-07-16).
  //
  // The VOCABULARY is a convention that already existed (ok | loading | no_model |
  // downloading | paused | deps_missing | down | error | unknown) — getTranscriberHealth and
  // getEmbedderHealth both speak it, and the labeler was simply missing from it: its state
  // was closure-local in the drainer and never exported, which is why nothing outside could
  // tell "paused, no model approved" from "running" (§3.10b). An earlier draft invented a
  // bespoke `labeler.state` vocabulary before noticing.
  //
  // ⚠️ But the SHAPE is normalized HERE, not inherited: getEmbedderHealth returns only
  // {status, message, detail} (embed/supervisor.js) — no `model`, no `progress` — so
  // models.embedder.model/.progress are ALWAYS null, padded by safe() below. An earlier
  // version of this comment (and M's commit message) claimed all three "have returned this
  // shape for ages"; that is true of the transcriber and FALSE of the embedder. The padding
  // is deliberate — one shape for every consumer — but a `k in obj` test proves nothing
  // about it (independent review, 2026-07-16).
  //
  // ⚠️ The four are NOT symmetrical, and the UI must not pretend they are (§3.10d-c):
  //   • embedder    — BUNDLED with the app. Cannot be declined, cannot be downloaded,
  //                   ~always 'ok'. Render as "included", never as an approvable choice —
  //                   presenting a non-choice as consent is the dishonesty §3.10 exists
  //                   to remove.
  //   • labeler     — consented: 'no_model' until the owner approves one; 'paused' when the
  //                   owner stopped the churn. Both are CHOICES, not faults.
  //   • enricher    — consented via its OWN setting (`taskModels.enrich`), which is why it
  //                   needs its own health member: it can be approved, or not, independently
  //                   of the labeler, and nothing else reports on it.
  //                   ⚠️ CORRECTED 2026-07-16: this said "PUT /providers/task-models writes
  //                   exactly ONE task per call, so approving Labeling does NOT approve
  //                   Enrichment." Both halves are now FALSE — the route also accepts
  //                   `{function}` and fans out — `{function:'understanding'}` writes BOTH
  //                   (operator decision; gate M8 in verify-task-models.mjs). ⚠️ The SCREEN that will use it does not
  //                   exist yet: nothing calls `{function}` (this branch's only frontend
  //                   change is one AISettings copy string). The route is the contract, shipped
  //                   ahead of its consumer.
  //                   The SETTINGS stay independent (two keys, two health members, this
  //                   member still earns its place); it is the *approval* that is now joint.
  //                   Do not re-derive "one task per call" as a route invariant — it isn't.
  //   • transcriber — consented: 'no_model'/'unknown' until the owner picks a whisper model.
  //
  // ⚠️ WHY `enricher` IS HERE. It was the one on-box task with NO surface at all: this slice
  // carried {embedder, labeler, transcriber} and portal-activity projects only embed +
  // categorize, so a vault that approved Labeling but not Enrichment had L2 (entities + gist)
  // SILENTLY dead — the exact dormancy class §3.10 exists to end, one task over. It is not a
  // new setting; it is the missing REPORT on a setting that always existed (re-review,
  // 2026-07-16). NB the pause is shared: pauseEnrichProcessing() stops the embed drain AND the L1/L2 loops
  // (drainer.js cycle), so `paused` is truthful for both, not copied from the labeler.
  //
  // ✅ RENDERED (2026-07-16). This paragraph used to read "AND NOTHING RENDERS THIS SLICE YET…
  // do not cite this member as evidence the dormancy is visible". That was true when written;
  // it is not now. The consumer is portal-app/src/lib/components/settings/ModelHealth.svelte,
  // hosted by AISettings.svelte (Settings → Intelligence) beside each member's own picker, on
  // GET /portal/readiness?slices=models. It renders `no_model`/`paused` as CHOICES (never red),
  // `unknown` as an honest absence, and `downloading` with progress.pct — and the embedder as
  // "included", with no control at all (§3.10d-c).
  //
  // ⚠️ …but the old claim "True of all four, `labeler` included" was ITSELF inaccurate, and the
  // correction matters more than the flip: the TRANSCRIBER was always visible. AISettings'
  // Voice lane reads GET /portal/transcription/status → getTranscriberHealth() — the same
  // source models.transcriber projects. So "portal-app reads models.* nowhere" was literally
  // true and materially misleading: a sibling projection of the same supervisor was on screen
  // the whole time. The real gap was THREE members. Beware that shape of grep-proof.
  //
  // The two projections cannot DISAGREE (one source), but they are not the same thing as
  // `embedder` ↔ `models.embedder` below: those ride one response and one tick, whereas the
  // Voice lane is a second endpoint with its own poller (and its own side effect —
  // ensureTranscribeSupervisor, portal-transcription.js). That lane also owns whisper's
  // catalog + download rail, which readiness has no business carrying.
  //
  // 'no_model' is NOT an error. Declining is a supported configuration: the vault still
  // imports, embeds and generates its mindscape. It simply has no categories.
  function models() {
    const safe = (fn, absent) => {
      try {
        const h = fn?.();
        if (!h || typeof h.status !== 'string') return absent;
        return { status: h.status, message: h.message || null, detail: h.detail ?? null, model: h.model ?? null, progress: h.progress ?? null };
      } catch { return absent; }
    };
    const unknown = (message) => ({ status: 'unknown', message, detail: null, model: null, progress: null });
    return {
      embedder: safe(embedderHealth, unknown('Embedding has not started.')),
      labeler: safe(labelerHealth, unknown('Labeling has not started.')),
      enricher: safe(enricherHealth, unknown('Enrichment has not started.')),
      transcriber: safe(transcriberHealth, unknown('Transcription is not set up.')),
    };
  }

  // ── ai ─────────────────────────────────────────────────────────────────────
  // connected = an ACTIVE provider exists. NOT `providers.length > 0`: an all-inactive
  // list read as "connected" in the old onboarding code (§2.8 #6).
  async function ai() {
    try {
      const rows = (await db.providers.list(userId)) || [];
      const active = rows.find((r) => r.is_active);
      return { connected: Boolean(active), activeProvider: active ? (active.label || active.provider || null) : null };
    } catch {
      // ⚠️ `unknown`, NOT a bare `connected:false` (§3.2a family, filed by #208's reviewer). A
      // provider-list read that THREW is not the same as "no AI connected" — a blip must not
      // read as a disconnected AI and light the "connect an AI" rail over a configured vault.
      // Fail-closed on `connected` (safe), honest via `unknown` (the caller can hold the last
      // known answer instead of regressing). The `!enabled`/no-active HAPPY paths are unchanged.
      return { connected: false, activeProvider: null, unknown: true };
    }
  }

  // ⚠️ THE CHANNEL SLICE IS NOT CHEAP, AND THE DOC SAID SO. §3.2c: "db.secrets.has() is NOT an
  // EXISTS query — secrets is SYSTEM_KEY-encrypted and AES-GCM is non-deterministic, so the key
  // column can't be matched in SQL; findRow DECRYPTS EVERY SECRET into process memory and matches
  // in JS… Do not call it in a hot loop; it rides the readiness cache like everything else."
  //
  // BOTH HALVES OF THAT WERE UNTRUE. There was no channel cache — `readiness.js`'s own header
  // claims "every other slice is a cached count or an in-memory health read", which is false for
  // this one — and E2 put it in a 4s poll. Measured: THREE full secrets-table decrypt scans per
  // tick (CHANNEL_ENABLED + 2×has), i.e. ~2,700 per hour, forever, for every onboarded user, for
  // a rail that can never appear again. That is PIVOT 2's sin, third instance, committed while
  // quoting §3.2b as the justification (independent review HIGH-5, 2026-07-16 — measured, not
  // reasoned).
  //
  // ⇒ Memoize HERE, not at the caller. §3.2c's promise becomes true, and increment G's popover —
  // which §3.8 specifies as POLLING readiness — inherits the fix instead of rediscovering the bug.
  // A user's channel config changes on a deliberate click, so seconds of staleness are free; the
  // decrypt loop is not. TTL, because invalidation would need a hook into every secrets writer.
  const CHANNEL_TTL_MS = 10_000;
  let channelMemo = null;   // { at:number, value:object }

  // ── channel ────────────────────────────────────────────────────────────────
  // Mirrors the EXISTING server-side predicate (src/channels/supervisor.js shouldRun):
  // enabled && (telegram || discord). `connected` = configured (gates the rail);
  // `working` would need live daemon health — C surfaces that.
  async function channel() {
    const now = Date.now();
    if (channelMemo && now - channelMemo.at < CHANNEL_TTL_MS) return channelMemo.value;
    const value = await channelUncached();
    channelMemo = { at: now, value };
    return value;
  }

  async function channelUncached() {
    try {
      const enabled = (await db.secrets.get(userId, 'CHANNEL_ENABLED')) === '1';
      if (!enabled) return { connected: false, kinds: [] };
      const kinds = [];
      if (await db.secrets.has(userId, 'TELEGRAM_BOT_TOKEN')) kinds.push('telegram');
      if (await db.secrets.has(userId, 'DISCORD_BOT_TOKEN')) kinds.push('discord');
      return { connected: kinds.length > 0, kinds };
    } catch {
      // ⚠️ `unknown`, NOT a bare `connected:false` (§3.2a family, filed by #208's reviewer). A
      // throwing secrets read (the decrypt loop can fail — §3.2c) is not "no channel configured";
      // marking it unknown keeps a transient from reading as a disconnected messenger. The
      // `!enabled` HAPPY path above stays a bare `{connected:false}` — that is a real answer, not
      // an error. NB `channel()` memoizes whatever this returns for CHANNEL_TTL_MS, so an `unknown`
      // blip is held for up to that window then re-computed — the same staleness the `mindscape`
      // memo accepts for its own `unknown`, not a per-tick self-heal.
      return { connected: false, kinds: [], unknown: true };
    }
  }

  // ── mindscape ──────────────────────────────────────────────────────────────
  // THE single definition of "generated" — the fact that ends QA item 5. A cheap COUNT.
  // It is kept cheap FOR the MCP topology gate, which has not migrated yet (see the header):
  // the slicing exists so that when it does, a tool probe never drags in the SQLCipher scan.
  // ⚠️ MEMOIZED for the same reason `channel` is: the rail polls this every 4s for the life of
  // every session, and `getNoiseStats` FULL-SCANS clustering_points — `idx_clustering_user` is on
  // user_id alone, so `AND landscape_x IS NOT NULL` plus the noise SUM visits every row, and on a
  // single-user vault that is all of them (measured: 7ms / 76k rows — real, but 0.17% duty, which
  // is why this was MED not HIGH). It also computes a `noise` sum no caller here reads.
  // The fact changes about once in a vault's lifetime.
  // ⚠️ TTL, NOT cache-forever-once-true: `generated` LOOKS monotonic, but no reset path is proven
  // (a wipe/regenerate zeroes the points), and X2 requires the rail still learn false→true within
  // a tick or two (independent review MED-10, 2026-07-16).
  // ⚠️ TTL raised 10s→60s (2026-07-18) because the memo now ALSO rides the explicit points-bust
  // discipline (onMindscapePointsBust, registered below): every path that actually changes
  // clustering_points already calls bustMindscapePoints — jobs.js:297 (clustering re-ran),
  // db/documents.js:390,424 (document delete), db/messages.js:650,676,819 (forget/edit) — so
  // false→true after a Generate is learned on the NEXT poll tick (better than any TTL), and the
  // TTL degrades to what mindscape-cache.js calls it: "safety net only — explicit busts keep it
  // fresh". X2's requirement is now met by the bust, not the clock.
  const MINDSCAPE_TTL_MS = 60_000;
  let mindscapeMemo = null;
  let mindscapeInFlight = null;   // single-flight latch — collapses concurrent cold reads to ONE scan
  let mindscapeGen = 0;   // bumped on every bust — bars an in-flight read from writing back a pre-mutation count

  // The bust wire. userId-scoped (null/undefined = all users). Registered once per
  // readiness instance; production builds exactly ONE (server-rest.js "one instance"),
  // so the module-level listener set stays size 1. Never unsubscribed — the instance
  // lives as long as the process does.
  onMindscapePointsBust((forUser) => {
    if (forUser == null || forUser === userId) { mindscapeGen++; mindscapeMemo = null; }
  });

  async function mindscape() {
    const t = now();
    if (mindscapeMemo && t - mindscapeMemo.at < MINDSCAPE_TTL_MS) return mindscapeMemo.value;
    // ⚠️ SINGLE-FLIGHT (mirrors evidence's evidenceInFlight). The mindscape slice AND the pipeline
    // slice both call this inside ONE get(); the slice jobs run under Promise.all, so on a cold memo
    // they would race TWO getNoiseStats full-table COUNTs. The latch collapses concurrent cold reads
    // to ONE scan — this is what keeps `pipeline`'s ZERO-marginal-scan promise honest even on the
    // first get() (verify:pipeline-status PS-COST caught the double before this latch existed).
    if (mindscapeInFlight) return mindscapeInFlight;
    const genAtStart = mindscapeGen;
    mindscapeInFlight = mindscapeUncached()
      // Drop the write-back if a bust raced this read: the count may predate the mutation, and at a
      // 60s TTL caching it would hold a stale "generated" for a full minute (the guard mindscape-cache
      // keeps per cache). The VALUE is still returned — one possibly-stale answer, never a poisoned memo.
      .then((value) => { if (genAtStart === mindscapeGen) mindscapeMemo = { at: t, value }; return value; })
      .finally(() => { mindscapeInFlight = null; });
    return mindscapeInFlight;
  }

  async function mindscapeUncached() {
    try {
      const s = await db.mindscape?.getNoiseStats?.(userId);
      const pointCount = Number(s?.total || 0);
      return { generated: pointCount > 0, pointCount };
    } catch {
      // ⚠️ `unknown`, NOT `generated:false`. This slice was the ONLY one whose catch fabricated a
      // definite answer — `data`, `tags`, `evidence` and `onboarding` all carry `unknown`. The
      // route still 200s, so every consumer read a failed COUNT as "this vault has no map":
      // MindscapeView rendered "Grow your mycelium — three steps to begin" over a 76k-message
      // built vault, and the rail's poll self-gated and never recovered. That is §3.2a's rule —
      // a counting error must not impersonate an empty vault — broken in the one place the whole
      // §3.7a exclusivity claim rests on (independent review HIGH-4, 2026-07-16).
      return { generated: false, pointCount: 0, unknown: true };
    }
  }

  async function onboarding() {
    try {
      const r = await db.rawQuery('SELECT welcome_shown_at, onboarding_dismissed_at FROM users WHERE id = ?', [userId]);
      const row = (r?.results || r || [])[0] || {};
      // A MISSING row is a real answer (a fresh vault has no users row until the first
      // welcome-seen/dismiss write) — not-seen, not-dismissed. A THROW is not.
      return { welcomeSeen: Boolean(row.welcome_shown_at), dismissed: Boolean(row.onboarding_dismissed_at) };
    } catch {
      // Fail-CLOSED on the read error. `welcomeSeen:false` would re-show first-run over a
      // populated vault — the QA-item-5 class of bug — so callers get `unknown` and must
      // decide, rather than being handed a fabricated "never seen".
      return { welcomeSeen: false, dismissed: false, unknown: true };
    }
  }

  // ── processing (§3.2 D13) — the pause reminder's whole data source ──────────
  // {paused, pausedAt, waiting}. This is the slice §3.2's type declared and increment B
  // never built (recorded four times); G's §3.8 popover renders the D13 reminder
  // ("Processing paused — N messages waiting · Resume") FROM it, so it is G's precondition.
  //
  //   • paused   — the LIVE in-memory flag (isProcessingPaused → isEnrichProcessingPaused).
  //                NOT read from settings: settings.enrichProcessingPaused is the durable
  //                record the drainer restores AT BOOT, but the flag is the current truth,
  //                and the reminder must reflect the click the user JUST made — which is
  //                exactly why this is NOT memoized (a 10s-stale paused, like channel's, would
  //                lie about the one control the popover exists to operate).
  //   • pausedAt — the DURABLE record: settings.enrichProcessingPausedAt (an ISO string when
  //                paused, null when resumed — persistPause, portal-compat.js). There is
  //                deliberately NO in-memory pausedAt (drainer.js), so settings is the ONLY
  //                source. A failed OR absent read ⇒ null, NEVER a fabricated "paused since now".
  //   • waiting  — total work still queued across the THREE on-box stages, summed from the
  //                SWR-CACHED counters (never a pure scan): embed + L1 categories + L2 nlp
  //                `.pending`. Summed, not scanned. This is the "(also showing how much)" the
  //                operator's D13 asked for — the reminder cannot state a number it did not count.
  //
  // §3.2a — a COUNTING error must not impersonate an empty/zero queue. If any backlog counter
  // throws, we carry `unknown:true` and do NOT report `waiting:0` (a fabricated "nothing left"
  // would tell a paused user their vault is fully processed) — the same catch discipline as
  // `data`/`evidence`. A failed `pausedAt` read is NOT slice-unknown: it degrades to null (the
  // honest "we don't have a paused-since time"), because `paused` + `waiting` are still truthful.
  async function processing() {
    let paused = false;
    try { paused = Boolean(isProcessingPaused?.()); } catch { paused = false; }

    let pausedAt = null;
    try {
      const s = await db.users?.getSettings?.(userId);
      const v = s?.enrichProcessingPausedAt;
      pausedAt = (typeof v === 'string' && v) ? v : null;
    } catch { pausedAt = null; }   // §3.2 D13: absent/failed ⇒ null, never a fabricated time

    try {
      // ⚠️ OPTIONAL-CHAIN the calls, not just the results: a SYNC throw while building the
      // Promise.all array (a missing counter method) would orphan the sibling promises already
      // created to its left into an UNHANDLED REJECTION — a fail-closed slice that CRASHES the
      // process is the opposite of fail-closed (caught by R4). `?.()` yields undefined instead,
      // so the array always completes and any real (async) counter rejection lands in the catch.
      const [emb, cat, nlp] = await Promise.all([
        db.messages?.embedBacklogCached?.(userId),
        db.messages?.categoriesBacklogCached?.(userId),
        db.messages?.nlpBacklogCached?.(userId),
      ]);
      const waiting = Number(emb?.pending || 0) + Number(cat?.pending || 0) + Number(nlp?.pending || 0);
      return { paused, pausedAt, waiting };
    } catch {
      // A backlog scan failed ⇒ we cannot honestly total the queue. `waiting:0` here would be
      // the §3.2a lie; `unknown` lets G hold the last known count instead of showing "0 waiting".
      return { paused, pausedAt, waiting: 0, unknown: true };
    }
  }

  // ── pipeline (PIPELINE-TRANSPARENCY-DESIGN §"Canonical model") — the ordered stage machine ──
  // The ONE source of truth for "where is my data in the pipeline?", read by both the rail and the
  // generate store so they can never disagree (the two-voice overlap the design deletes). An
  // ORDERED array — import → embed → categorize → cluster → describe → measure — where each stage's
  // `state` ∈ pending | running | blocked | done (NEVER a bare boolean; §"Design principles").
  //
  // ⚠️ THE LOAD-BEARING CONSTRAINT (§Threat model / P-COST): this slice adds ZERO fresh scans. It
  // assembles ONLY from reads readiness already does cheaply — the SWR-cached embed/categories
  // backlogs, the memoized clustering_points COUNT (mindscape()), the injected in-memory health
  // readers, the pause flag, and the drainer's in-memory throughput status. It never issues a new
  // aggregate. If a stage would need an uncached scan, it uses the cached count instead (the exact
  // trap from [[gates-assert-shape-never-cost]] / [[onboarding-status-emptiness-not-count]]).
  //
  // §1 (no plaintext): counts + FIXED enum states/reasons/labels only — never message content and
  // never any string derived from vault text. Same contract as `processing`/`embedder`.
  //
  // §3.2a (fail-closed): any throw ⇒ an `idle`/`unknown` pipeline, never a fabricated `done` and
  // never a crash (a throwing slice would take down every consumer — R4's rule).
  //
  // ⚠️ BLOCK DETECTION rides the injected HEALTH READERS, not a fresh settings/model read:
  // labelerHealth().status is 'no_model' until the owner approves a labeling model (drainer.js —
  // the same vocabulary the `models` slice surfaces), so "categorize is blocked, approve a model"
  // is an in-memory read, not a DB round-trip. Every `blocked` stage ALWAYS carries a `reason`
  // (the fixed enum) AND an `action` {label,target} — a named block with no remedy is the "empty
  // rail with extra words" the design forbids.
  //
  // ⚠️ describe + measure derive their done-ness from `points > 0` — NOT a background_jobs read.
  // The design's own sweep RESOLVED that describe/measure/narrate AUTO-CHAIN inside the cluster job
  // (§"Open questions": "describe/measure/narrate DO auto-chain inside the cluster job"), so a map
  // that exists is proof they ran. Their LIVE per-step progress (the generate-job stageLabels) is
  // a UI concern for a later unit; the STAGE MACHINE only needs pending↔done, and points is free.
  async function pipeline() {
    try {
      const [emb, cat, ms] = await Promise.all([
        db.messages?.embedBacklogCached?.(userId),     // rides the SWR memo `data` also buys
        db.messages?.categoriesBacklogCached?.(userId),// rides the SWR memo `tags` also buys
        mindscape(),                                   // the memoized clustering_points COUNT
      ]);
      const total = Number(emb?.total || 0);
      const embedded = Number(emb?.embedded || 0);
      const embedPending = Number(emb?.pending || 0);
      const catTotal = Number(cat?.total || 0);
      const catTagged = Number(cat?.tagged || 0);
      const catPending = Number(cat?.pending || 0);
      const points = Number(ms?.pointCount || 0);
      // ⚠️ §3.2a — mindscape() NEVER throws; on a transient getNoiseStats failure it returns
      // {pointCount:0, unknown:true} (its own HIGH-4 catch). Reading that as points===0 would let
      // cluster fabricate `blocked needs_generate` over a FULLY-BUILT vault whose map read merely
      // hiccuped — the exact "a counting error must not impersonate an ungenerated vault" trap, and
      // the caught-up-trap that pops a spurious Generate whose action kicks a redundant re-cluster.
      // So carry the flag: when the map state is NOT KNOWN we hold cluster/describe/measure at
      // `pending` (honest "map not known"), never asserting "no map". embed/categorize stay truthful —
      // a mindscape hiccup must not blank the stages we DO know.
      const msUnknown = Boolean(ms?.unknown);
      // Per-stage pause (QA R2). Each Stop/Resume control drives its OWN stage — embed vs categorize.
      // ⚠️ FALL BACK to the global isProcessingPaused when a per-stage reader is not injected: that
      // keeps a single-flag caller (and verify-pipeline-status, which injects only isProcessingPaused)
      // driving BOTH stages, while PRODUCTION passes the real per-stage readers (server-rest.js) so
      // the two controls are genuinely independent. Each stage reads ONLY its own flag below.
      const embedPausedFn = isEmbedPaused || isProcessingPaused;
      const categorizePausedFn = isCategorizePaused || isProcessingPaused;
      let embedPaused = false; try { embedPaused = Boolean(embedPausedFn?.()); } catch { embedPaused = false; }
      let categorizePaused = false; try { categorizePaused = Boolean(categorizePausedFn?.()); } catch { categorizePaused = false; }
      const st = (() => { try { return drainerStatus?.(); } catch { return null; } })();
      const hstat = (fn) => { try { return fn?.()?.status || 'unknown'; } catch { return 'unknown'; } };
      const embStatus = hstat(embedderHealth);
      const labStatus = hstat(labelerHealth);
      const DOWN = new Set(['down', 'error', 'deps_missing', 'unavailable']);

      // Fixed action factories — labels + targets are constants, never derived from vault text (§1).
      const approveModel = { label: 'Approve a labeling model', target: 'intelligence' };
      const checkEmbedder = { label: 'Check the embedder', target: 'intelligence' };
      const checkLabeler = { label: 'Check the labeling model', target: 'intelligence' };
      const resume = { label: 'Resume', target: 'resume' };
      const generate = { label: 'Generate', target: 'generate' };

      const stages = [];

      // import — messages present ⇒ done; an empty vault has not imported yet.
      stages.push(total > 0 ? { key: 'import', state: 'done', count: { done: total } }
        : { key: 'import', state: 'pending' });

      // embed — the vectors. paused OUTRANKS a down embedder (a choice is not a fault); a running
      // embed carries the measured ETA (embedEta — the activity feed's own math, reused). Every
      // embed stage carries `paused: embedPaused` so the co-located Stop/Resume control (R2) knows
      // its two-state label without a second read.
      if (total === 0) stages.push({ key: 'embed', state: 'pending', paused: embedPaused });
      else if (embedPending <= 0) stages.push({ key: 'embed', state: 'done', count: { done: embedded, total }, paused: embedPaused });
      else if (embedPaused) stages.push({ key: 'embed', state: 'blocked', count: { done: embedded, total }, reason: 'paused', action: resume, paused: true });
      else if (DOWN.has(embStatus)) stages.push({ key: 'embed', state: 'blocked', count: { done: embedded, total }, reason: 'embedder_down', action: checkEmbedder, paused: false });
      else stages.push({ key: 'embed', state: 'running', count: { done: embedded, total }, etaSeconds: embedEta(st, embedPending, embedPaused), paused: false });

      // categorize — the on-box labels. no_model is a CHOICE, surfaced whenever data exists (the
      // biggest silent stall, §"The problem" #1); it OUTRANKS paused so the missing-consent remedy
      // is the one shown. Nothing embedded yet ⇒ nothing to categorize (pending, no nag). `paused`
      // is categorizePaused (its own control), independent of embed's.
      if (embedded === 0) stages.push({ key: 'categorize', state: 'pending', paused: categorizePaused });
      else if (labStatus === 'no_model') stages.push({ key: 'categorize', state: 'blocked', reason: 'no_model', action: approveModel, paused: categorizePaused });
      else if (categorizePaused && catPending > 0) stages.push({ key: 'categorize', state: 'blocked', count: { done: catTagged, total: catTotal }, reason: 'paused', action: resume, paused: true });
      else if (DOWN.has(labStatus)) stages.push({ key: 'categorize', state: 'blocked', reason: 'ollama_down', action: checkLabeler, paused: categorizePaused });
      else if (catPending > 0) stages.push({ key: 'categorize', state: 'running', count: { done: catTagged, total: catTotal }, etaSeconds: categorizeEta(st, catPending, categorizePaused, false), paused: false });
      else stages.push({ key: 'categorize', state: 'done', count: { done: catTagged, total: catTotal }, paused: categorizePaused });

      // cluster — the map. A map that EXISTS is done. Below the floor the user is stranded unless
      // told: blocked, too_few_embedded, with a Generate action (§"Filling the gaps" #2). Above the
      // floor with no map yet ⇒ needs_generate (the debounce made visible), never silence.
      if (points > 0) stages.push({ key: 'cluster', state: 'done', count: { done: points } });
      // The map read FAILED (not a real zero) ⇒ we do NOT know whether a map exists. Hold at pending
      // with an honest reason — NEVER `blocked needs_generate` (that would pop a spurious Generate over
      // a built vault and kick a redundant re-cluster). A pending stage carries no action, so no nag.
      else if (msUnknown) stages.push({ key: 'cluster', state: 'pending', reason: 'map_unknown' });
      else if (embedded === 0 || embedPending > 0) stages.push({ key: 'cluster', state: 'pending', reason: 'waiting_embed' });
      else if (embedded < MIN_EMBEDDED) stages.push({ key: 'cluster', state: 'blocked', reason: 'too_few_embedded', action: generate });
      else stages.push({ key: 'cluster', state: 'blocked', reason: 'needs_generate', action: generate });

      // describe + measure — auto-chained inside the cluster job; a map proves they ran. When the map
      // state is unknown we cannot claim done, and cluster is not blocked, so they stay pending (honest).
      stages.push({ key: 'describe', state: points > 0 ? 'done' : 'pending' });
      stages.push({ key: 'measure', state: points > 0 ? 'done' : 'pending' });

      // overall + blockedOn — a block anywhere dominates (the pipeline cannot advance past it);
      // else running if any stage is; else done iff EVERY stage is done; else still running
      // (pending stages remain, work is progressing). An empty vault is `idle`, not `running`.
      const firstBlocked = stages.find((s) => s.state === 'blocked');
      let overall;
      if (total === 0) overall = 'idle';
      else if (firstBlocked) overall = 'blocked';
      else if (stages.some((s) => s.state === 'running')) overall = 'running';
      else if (stages.every((s) => s.state === 'done')) overall = 'done';
      else overall = 'running';
      return { stages, overall, blockedOn: firstBlocked ? firstBlocked.reason : null };
    } catch {
      // §3.2a: a failed assembly claims NOTHING — never a fabricated all-done, never a crash.
      return { stages: [], overall: 'idle', blockedOn: null, unknown: true };
    }
  }

  // ── canGenerate — the ≥5 threshold, encoded ONCE ───────────────────────────
  // Was duplicated: the server refused below 5 while every client said `messageCount > 0`
  // (§2.8 #5), so the UI thought it was ready and the server 409'd.
  //
  // 'unknown' is NOT cosmetic. The preflight's catch left total=0 and the NEXT line
  // blocked on `total === 0` → a counting error told the user their FULL vault was empty
  // (§3.2a). Fail-closed on the GATE, honest in the MESSAGE.
  function canGenerate(d) {
    if (!d || d.unknown) return { ok: false, reason: 'unknown' };
    if (d.total === 0) return { ok: false, reason: 'no_messages' };
    if (d.embedded < MIN_EMBEDDED) return { ok: false, reason: 'not_embedded' };
    return { ok: true, reason: null };
  }

  /**
   * @param {{ slices?: string[], fresh?: boolean }} [opts]
   * @returns {Promise<object>} only the requested slices (+ canGenerate when `data` is in)
   */
  async function get({ slices, fresh = false } = {}) {
    const want = new Set(Array.isArray(slices) && slices.length ? slices : ALL);
    const out = {};
    const jobs = [];
    if (want.has('data'))      jobs.push(data(fresh).then((v) => { out.data = v; }));
    if (want.has('tags'))      jobs.push(tags().then((v) => { out.tags = v; }));
    if (want.has('evidence'))  jobs.push(evidenceCached(fresh).then((v) => { out.evidence = v; }));
    if (want.has('ai'))        jobs.push(ai().then((v) => { out.ai = v; }));
    if (want.has('channel'))   jobs.push(channel().then((v) => { out.channel = v; }));
    if (want.has('mindscape')) jobs.push(mindscape().then((v) => { out.mindscape = v; }));
    if (want.has('onboarding'))jobs.push(onboarding().then((v) => { out.onboarding = v; }));
    if (want.has('processing'))jobs.push(processing().then((v) => { out.processing = v; }));
    if (want.has('pipeline'))  jobs.push(pipeline().then((v) => { out.pipeline = v; }));
    await Promise.all(jobs);
    // Both are SYNC (they read a supervisor's in-memory health) — never a DB hit, so they
    // stay out of the awaited set. `embedder` and `models.embedder` are two projections of
    // ONE source (embedderHealth), so they cannot disagree; `embedder` is the terse
    // {up,status} the existing consumers already read.
    if (want.has('embedder')) out.embedder = embedder();
    if (want.has('models')) out.models = models();
    if (want.has('data')) {
      out.canGenerate = canGenerate(out.data);
      delete out.data.unknown;   // internal marker — never surfaced
    }
    return out;
  }

  /** The PURE scan. One caller: the Generate preflight. Never poll this. */
  const getFresh = (opts = {}) => get({ ...opts, fresh: true });

  /**
   * Fire-and-forget cache warm. embedBacklogCached AWAITS the first scan on a cold
   * process ("cold start only: await the first scan once" — db/messages.js), so without
   * this the first user-facing consumer pays multiple seconds. Called from completeBoot.
   *
   * `evidence` + `mindscape` joined (2026-07-18): the header StatusPopover buys evidence
   * once per OPEN and mindscape on its poll — both were cold-start awaits, so the status
   * panel's FIRST paint on a 76k-message vault paid four full-table aggregate scans live.
   * Warming here means the first open serves the boot snapshot instantly and the SWR/bust
   * machinery keeps it live. Naming `evidence` explicitly does not soften E1: a bare
   * get() still never buys it — warm() is one boot-time call, not a poll.
   * Fail-soft stays intact (S4): every slice catches its own errors, the whole get() is
   * .catch(()=>{})-swallowed, and nothing awaits it — boot never waits on this.
   */
  function warm() {
    try { get({ slices: ['data', 'tags', 'evidence', 'mindscape'] }).catch(() => {}); } catch { /* never throw at boot */ }
  }

  return { get, getFresh, warm, MIN_EMBEDDED };
}
