// src/enrich/drainer.js — in-process enrichment for the REST server.
//
// The app spawns only the REST server — no separate `:8095` enrich listener and
// no consumer for its nudge — so UI-imported messages used to sit at
// nlp_processed=0 / embedding_768=NULL forever, and Generate then had nothing to
// cluster. This drains the embed backlog IN-PROCESS against the embed service
// (`:8091`): once on boot, on a timer, and on a post-import nudge.
//
// Robustness: it HEALTH-CHECKS `:8091` before each batch. drainOnce() mass-marks
// a batch failed (-1) if the embed call throws, and failed rows are never
// re-selected — so attempting a drain while the service is down would silently
// burn the backlog. Health-gating keeps rows pending (0) for a later retry.
import { createEmbedClient } from '../embed/client.js';
import { getMasterKey } from '../crypto/crypto-local.js';
import { localInfer } from '../inference/local.js';
import { createOllamaClient } from '../hardware/ollama.js';
import { createEnrichmentService } from './service.js';
import { createCategoryClassifier, DEFAULT_LABEL_MODEL } from './categories.js';
import { createMessageEnricher } from './enricher.js';

// The live drainer for the booted vault. Set by startEnrichDrainer so a portal
// route (POST /portal/enrichment/trigger) can kick a drain WITHOUT threading the
// drainer handle through buildVaultSubApp — the drainer is created deep in
// completeBoot. Single-user / single-vault, so one module-level handle is exact.
let _current = null;

// User control for the Context Engine L1 categorization stage (the on-box-model churn the
// user sees as "my computer is working a lot"). Module-level + in-memory: single-user /
// single-vault, so one flag is exact (same rationale as `_current`). NOT persisted across a
// restart by design — a restart resumes categorizing (the safe default: never silently leave
// the vault permanently un-enriched). Embedding is unaffected; this gates only the L1 pass.
let _categorizePaused = false;

/** Kick the live enrichment drainer if one is running (no-op otherwise). */
export function nudgeEnrichDrainer() { try { _current?.nudge(); } catch { /* best-effort */ } return Boolean(_current); }

/** STOP the L1 categorization stage (the on-box-model churn). Embedding keeps running. */
export function pauseEnrichCategorize() { _categorizePaused = true; return true; }
/** RESUME L1 categorization and kick a cycle immediately so progress moves at once. */
export function resumeEnrichCategorize() { _categorizePaused = false; nudgeEnrichDrainer(); return true; }
/** Is the L1 categorization stage currently paused by the user? */
export function isEnrichCategorizePaused() { return _categorizePaused; }

/**
 * The on-box labeling model for this vault: the per-task override
 * (settings.taskModels.categorize.model) if set, else DEFAULT_LABEL_MODEL (qwen3.5:4b).
 * Labeling is on-box by design (bulk + privacy) — this resolves a LOCAL model NAME, not a
 * cloud provider. Fail-soft: any read error → the default.
 */
export async function defaultLabelModel(db, userId, fallback = DEFAULT_LABEL_MODEL) {
  try {
    const s = await db?.users?.getSettings?.(userId);
    const m = s?.taskModels?.categorize?.model;
    if (typeof m === 'string' && m.trim()) return m.trim();
  } catch { /* fail-soft → default */ }
  return fallback;
}

/**
 * The on-box model for L2 message enrichment (semantic entities + gist): the per-task override
 * (settings.taskModels.enrich.model) if set, else DEFAULT_LABEL_MODEL (qwen3.5:4b) — the same
 * small local model as labeling. Also on-box by design (per-message, bulk). Fail-soft → default.
 */
export async function defaultEnrichModel(db, userId, fallback = DEFAULT_LABEL_MODEL) {
  try {
    const s = await db?.users?.getSettings?.(userId);
    const m = s?.taskModels?.enrich?.model;
    if (typeof m === 'string' && m.trim()) return m.trim();
  } catch { /* fail-soft → default */ }
  return fallback;
}

export function startEnrichDrainer({
  db,
  userId,
  intervalMs = 15000,
  embed = createEmbedClient(),
  log = (m) => process.stderr.write(`${m}\n`),
  onSettled,
  // The on-box Ollama daemon (lazy: ensureUp() adopts-or-spawns, single-flight, never throws).
  // L1 categorization runs on this local model; the daemon is LAZY and nothing else on the
  // enrich path wakes it, so the cycle wakes it on demand (below). Null in contexts with no
  // local model (tests / model-less hosts) → L1 simply stays pending, fail-soft.
  daemon = null,
  // The on-box model L1 labels with. Default qwen3.5:4b — operator pick 2026-06-24: best
  // register-axis coverage in the model bake-off + a 4B (far lighter than llama3.1 8B on a
  // 16GB box). Auto-pulled if missing (see ensureLabelModel) so a fresh app-private Ollama —
  // which ships with NO models — doesn't dead-end every classify on "model not found". Single
  // source of truth: also feeds the default classifier below. (DEFAULT_LOCAL_MODEL stays the
  // general-inference default; only L1 labeling pins qwen3.5:4b.)
  labelModel = 'qwen3.5:4b',
  // Ollama model-management client (listInstalled + pullModel). Injectable so the gate can
  // drive the auto-pull offline.
  ollama = createOllamaClient(),
  // Context Engine L1: per-message domain+register tagging via the on-box model (cheap,
  // private; format:'json' constrains the reply). INJECTABLE so the gate can drive it offline.
  // In production leave it null → the cycle resolves the model each tick from settings (below)
  // so a Settings → Intelligence change takes effect without a restart. A model outage leaves
  // rows pending (self-heals next cycle), never poisons a row.
  classify = null,
  // Resolve the on-box labeling model NAME from the per-task setting (categorize is on-box by
  // design — see INFERENCE_TASKS), falling back to the `labelModel` param (default qwen3.5:4b).
  // The SAME resolved name feeds the auto-pull below, so a settings-overridden model gets pulled.
  resolveLabelModel = () => defaultLabelModel(db, userId, labelModel),
  // L2 message enrichment (semantic entities + gist) model resolver — settings override, else the
  // same small local model (labelModel default). Injectable for tests.
  resolveEnrichModel = () => defaultEnrichModel(db, userId, labelModel),
} = {}) {
  const svc = createEnrichmentService({ messages: db.messages, embed, getMasterKey, classify });
  let running = false;
  let pending = false;
  let timer = null;
  // Cached on-box labeling classifier, rebuilt only when the resolved model changes (so a
  // Settings change swaps the model live without a restart, and we don't rebuild every cycle).
  let _labelModel = null;
  let _labelClassify = null;
  // Return the classifier to use for L1 this cycle: an injected one (tests) wins; otherwise
  // resolve the model from settings (default qwen3.5:4b) and build/reuse a local classifier.
  async function labelClassifier(model) {
    if (typeof classify === 'function') return classify;
    if (_labelClassify && _labelModel === model) return _labelClassify;
    _labelModel = model;
    _labelClassify = createCategoryClassifier({
      model, // recorded as per-row provenance (categories_model, 0041)
      infer: (prompt) => localInfer({ prompt, model, format: 'json', maxTokens: 40, numCtx: 1024, think: false }),
    });
    return _labelClassify;
  }
  // Cached on-box message enricher (L2), rebuilt only when the resolved model changes.
  let _enrichModel = null;
  let _enrichFn = null;
  async function messageEnricher(model) {
    if (_enrichFn && _enrichModel === model) return _enrichFn;
    _enrichModel = model;
    _enrichFn = createMessageEnricher({
      model,
      // maxTokens 160: enough for {people,orgs,places,topics,gist} JSON; numCtx 1024 holds a bounded message.
      infer: (prompt) => localInfer({ prompt, model, format: 'json', maxTokens: 160, numCtx: 1024, think: false }),
    });
    return _enrichFn;
  }

  async function embedHealthy() {
    try {
      const h = await embed.health(); // /health → { status, loaded, dim, … }
      return Boolean(h) && h.loaded !== false && (h.status ? h.status === 'ok' : true);
    } catch { return false; }
  }

  // PRODUCTION: ensure the on-box labeling MODEL is actually installed before we classify.
  // daemon.ensureUp() only starts the Ollama SERVER — but a fresh, app-private Ollama ships
  // with NO models, so the first classify fails "model not found" and L1 silently never runs
  // for that user (the model-tier sibling of the lazy-server dormancy bug). We pull the model
  // ONCE, in the BACKGROUND (the download is minutes — never hold the drain cycle for it), and
  // skip the tagging loop until it's ready. Result cached so we hit `ollama list` at most once
  // per model. Fail-soft throughout: any error just leaves rows pending for the next tick.
  const _modelReady = new Set();   // models confirmed present (or freshly pulled) this session
  let _pullingModel = null;        // a model currently downloading → skip categorize meanwhile
  async function ensureLabelModel(model) {
    if (!model || _modelReady.has(model)) return true;
    if (_pullingModel === model) return false;           // download in flight → not ready yet
    let installed;
    try { installed = await ollama.listInstalled(); }    // ['qwen3.5:4b', 'llama3.1:latest', …]
    catch { return false; }                              // can't reach Ollama → retry next tick
    const base = String(model).split(':')[0];
    if (installed.some((n) => n === model || String(n).split(':')[0] === base)) {
      _modelReady.add(model); return true;               // already have it (exact or :tag match)
    }
    _pullingModel = model;
    log(`[enrich] labeling model "${model}" not installed — pulling it once (a few minutes)…`);
    ollama.pullModel(model)
      .then(() => { _modelReady.add(model); log(`[enrich] labeling model "${model}" ready — L1 resumes`); })
      .catch((e) => { log(`[enrich] pull "${model}" failed: ${String(e?.message || e).slice(0, 60)} — will retry`); })
      .finally(() => { _pullingModel = null; });          // next 15s tick resumes categorize
    return false;
  }

  async function cycle() {
    if (running) { pending = true; return; } // single-flight; coalesce concurrent nudges
    running = true;
    try {
      if (!(await embedHealthy())) return; // :8091 down → retry next tick (no failed-row churn)

      // SELF-HEAL: retry rows that previously failed for a NON-content reason
      // (service down/slow/timeout) now that the service is healthy. Genuine
      // poison rows (a dimension mismatch → "expected 768") stay failed (-1).
      try {
        await db.rawQuery(
          "UPDATE messages SET nlp_processed = 0, nlp_error = NULL WHERE user_id = ?"
          + " AND nlp_processed = -1 AND embedding_768 IS NULL"
          + " AND (nlp_error IS NULL OR nlp_error NOT LIKE '%expected 768%')",
          [userId],
        );
      } catch { /* non-fatal */ }

      let embedded = 0;
      for (let i = 0; i < 200; i++) {            // hard cap ≤200 batches/cycle (≤10k msgs)
        const e = await svc.drainOnce({ userId });
        embedded += e?.embedded ?? 0;
        if ((e?.scanned ?? 0) === 0) break;      // backlog drained
      }
      if (embedded > 0) {
        // NLP enrichment (embedded → enriched) now runs in the on-box message block below, so it
        // uses the hybrid LLM enricher after the daemon is woken (was a regex pass here).
        log(`[enrich] embedded ${embedded} message(s) in-process`);
        // Backlog drained this cycle → let the owner decide whether to kick off the
        // topology pipeline (first-run auto-generate). Decoupled: the drainer never
        // imports jobs.js; server-rest wires the gate (single-flight + topology-empty).
        try { await onSettled?.({ embedded }); } catch { /* non-fatal */ }
      }

      // Context Engine L1: tag new + backfill messages with domain/register. Separate from
      // the embed gate so the historical backfill proceeds on cycles with no new embeds.
      // Bounded per cycle (≤8 batches = 200 msgs); stops on a model outage (failed>0), leaving
      // the rest pending for the next tick. Single-flighted by the outer `running` guard.
      //
      // USER PAUSE: the owner can stop the on-box-model churn (POST /portal/enrichment/
      // categorize/pause). Skip the wake + the tagging loop entirely while paused — rows stay
      // pending and resume exactly where they left off (resumable + idempotent). Embedding above
      // is unaffected. A restart clears the pause (safe default; see the flag's note).
      if (!isEnrichCategorizePaused()) {
        // WAKE THE ON-BOX MODEL FIRST. The Ollama daemon is lazy and the enrich path is the one
        // consumer that nothing else starts it for — so without this, a vault whose owner never
        // opened local chat would leave EVERY message untagged forever (the live-vault dormancy
        // bug). Wake it only when there's actual pending work, so an idle vault never spawns a
        // model. ensureUp() adopts a running daemon instantly (single-flight) and NEVER throws;
        // if it can't come up, the loop below fails-soft (rows stay pending) exactly as before.
        const labelM = await resolveLabelModel();   // resolve once — feeds the auto-pull AND the classifier
        const enrichM = await resolveEnrichModel();  // ditto for the enrich model
        let modelReady = true;
        let enrichReady = true;
        if (daemon) {
          try {
            const [pc, pn] = await Promise.all([
              db.messages.selectPendingCategories(userId, { limit: 1 }),
              db.messages.selectPendingNlp(userId, { limit: 1 }),
            ]);
            if (pc.length || pn.length) {
              await daemon.ensureUp(); // wake the server for tagging OR enrichment work
              // ensure the MODELS are installed (pull once if missing), keyed on the RESOLVED models.
              if (pc.length) modelReady = await ensureLabelModel(labelM);
              if (pn.length) enrichReady = await ensureLabelModel(enrichM);
            }
          } catch { /* never block the cycle on the wake — the loops fail-soft if the model is down */ }
        }
        if (modelReady) {
          const cycleClassify = await labelClassifier(labelM);
          let tagged = 0;
          for (let i = 0; i < 8; i++) {
            const c = await svc.enrichCategoriesOnce({ userId, classify: cycleClassify });
            tagged += c?.enriched ?? 0;
            if ((c?.scanned ?? 0) === 0 || (c?.failed ?? 0) > 0) break;
          }
          if (tagged > 0) log(`[enrich] tagged ${tagged} message(s) via ${cycleClassify.model || 'local model'}`);
        }
        // L2: hybrid semantic enrichment (entities + gist) — gated on the enrich model being present;
        // the enricher degrades to regex if the model is down, so rows never stall.
        if (enrichReady) {
          const cycleEnrich = await messageEnricher(enrichM);
          let enrichedSem = 0;
          for (let i = 0; i < 8; i++) {
            const n = await svc.enrichNlpOnce({ userId, enrich: cycleEnrich });
            enrichedSem += n?.enriched ?? 0;
            if ((n?.scanned ?? 0) === 0 || (n?.failed ?? 0) > 0) break;
          }
          if (enrichedSem > 0) log(`[enrich] enriched ${enrichedSem} message(s) via ${cycleEnrich.model || 'local model'}`);
        }
      }
    } catch (err) {
      log(`[enrich] drain cycle error: ${String(err?.message || err)}`);
    } finally {
      running = false;
      if (pending) { pending = false; setImmediate(cycle); } // a nudge arrived mid-cycle
    }
  }

  cycle();                                       // drain any backlog on boot
  timer = setInterval(cycle, intervalMs);
  if (timer.unref) timer.unref();                // never keep the process alive for the timer

  const handle = {
    nudge: () => cycle(), // returns the cycle promise (callers may ignore it; the gate awaits it)
    stop: () => { if (timer) clearInterval(timer); timer = null; if (_current === handle) _current = null; },
  };
  _current = handle; // expose to nudgeEnrichDrainer() for the portal trigger route
  return handle;
}

export default startEnrichDrainer;
