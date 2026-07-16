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
// the PURE scan and exists for exactly one caller: the Generate preflight.
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
 */
export function createReadiness({ db, userId, embedderHealth, labelerHealth, enricherHealth, transcriberHealth } = {}) {
  if (!db) throw new TypeError('createReadiness: db required');
  if (!userId) throw new TypeError('createReadiness: userId required');

  // ⚠️ `evidence` is deliberately NOT in ALL — it is OPT-IN ONLY (`slices:['evidence']`).
  // Every other slice is a cached count or an in-memory health read; evidence is three
  // UNINDEXED aggregates over `messages` (the design's own map: "NOT pollable — pure scan
  // + 3 unindexed aggregates"). `get()` with no slices is documented as "the portal's ONE
  // call", and increment G's header popover is going to POLL something — if evidence rode
  // ALL, that poll would quietly full-scan a 76k-row table every tick. Opt-in keeps the
  // expensive slice impossible to buy by accident: a caller has to name it.
  const ALL = ['data', 'tags', 'embedder', 'models', 'ai', 'channel', 'mindscape', 'onboarding'];

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
  // 2026-07-16). NB the pause is shared: pauseEnrichCategorize() stops the L1 AND L2 loops
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
    } catch { return { connected: false, activeProvider: null }; }
  }

  // ── channel ────────────────────────────────────────────────────────────────
  // Mirrors the EXISTING server-side predicate (src/channels/supervisor.js shouldRun):
  // enabled && (telegram || discord). `connected` = configured (gates the rail);
  // `working` would need live daemon health — C surfaces that.
  async function channel() {
    try {
      const enabled = (await db.secrets.get(userId, 'CHANNEL_ENABLED')) === '1';
      if (!enabled) return { connected: false, kinds: [] };
      const kinds = [];
      if (await db.secrets.has(userId, 'TELEGRAM_BOT_TOKEN')) kinds.push('telegram');
      if (await db.secrets.has(userId, 'DISCORD_BOT_TOKEN')) kinds.push('discord');
      return { connected: kinds.length > 0, kinds };
    } catch { return { connected: false, kinds: [] }; }
  }

  // ── mindscape ──────────────────────────────────────────────────────────────
  // THE single definition of "generated" — the fact that ends QA item 5. A cheap COUNT.
  // It is kept cheap FOR the MCP topology gate, which has not migrated yet (see the header):
  // the slicing exists so that when it does, a tool probe never drags in the SQLCipher scan.
  async function mindscape() {
    try {
      const s = await db.mindscape?.getNoiseStats?.(userId);
      const pointCount = Number(s?.total || 0);
      return { generated: pointCount > 0, pointCount };
    } catch { return { generated: false, pointCount: 0 }; }
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
    if (want.has('evidence'))  jobs.push(evidence().then((v) => { out.evidence = v; }));
    if (want.has('ai'))        jobs.push(ai().then((v) => { out.ai = v; }));
    if (want.has('channel'))   jobs.push(channel().then((v) => { out.channel = v; }));
    if (want.has('mindscape')) jobs.push(mindscape().then((v) => { out.mindscape = v; }));
    if (want.has('onboarding'))jobs.push(onboarding().then((v) => { out.onboarding = v; }));
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
   */
  function warm() {
    try { get({ slices: ['data', 'tags'] }).catch(() => {}); } catch { /* never throw at boot */ }
  }

  return { get, getFresh, warm, MIN_EMBEDDED };
}
