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
/** Live drainer liveness for the activity feed — null when no drainer is running. */
export function getEnrichDrainerStatus() { try { return _current?.status?.() ?? null; } catch { return null; } }

/**
 * Labeler health — the third member of the supervisor-health convention, alongside
 * getEmbedderHealth() (embed/supervisor.js) and getTranscriberHealth() (transcribe/
 * supervisor.js). Same shape, same vocabulary, so readiness can carry one `models` slice
 * with three uniform members instead of a bespoke per-component vocabulary (§3.10b).
 *
 * No drainer ⇒ 'unknown' (a verify script, or before boot) — never a fabricated 'ok'.
 */
export function getLabelerHealth() {
  try {
    return _current?.labelerHealth?.()
      ?? { status: 'unknown', message: 'Labeling has not started.', detail: null, model: null, progress: null };
  } catch {
    return { status: 'unknown', message: 'Labeling has not started.', detail: null, model: null, progress: null };
  }
}

/**
 * Enricher health — the FOURTH member of the supervisor-health convention (embedder, labeler,
 * enricher, transcriber). L2 semantic enrichment had no health surface at all until now, which
 * is why a vault that approved labeling but not enrich ran L2 dormant and silent (§3.10b,
 * re-review 2026-07-16).
 *
 * No drainer ⇒ 'unknown' — never a fabricated 'ok'. Same fail-closed rule as getLabelerHealth.
 */
export function getEnricherHealth() {
  try {
    return _current?.enricherHealth?.()
      ?? { status: 'unknown', message: 'Enrichment has not started.', detail: null, model: null, progress: null };
  } catch {
    return { status: 'unknown', message: 'Enrichment has not started.', detail: null, model: null, progress: null };
  }
}

export function nudgeEnrichDrainer() { try { _current?.nudge(); } catch { /* best-effort */ } return Boolean(_current); }

/** STOP the L1 categorization stage (the on-box-model churn). Embedding keeps running. */
export function pauseEnrichCategorize() { _categorizePaused = true; return true; }
/** RESUME L1 categorization and kick a cycle immediately so progress moves at once. */
export function resumeEnrichCategorize() { _categorizePaused = false; nudgeEnrichDrainer(); return true; }
/** Is the L1 categorization stage currently paused by the user? */
export function isEnrichCategorizePaused() { return _categorizePaused; }

// ── THE APPROVAL *IS* THE MODEL SETTING (design §3.10c) ──────────────────────
// There is no separate consent flag. `settings.taskModels.<task>.model` is BOTH the
// choice and the approval, exactly as whisper already works (transcribeModel unset ⇒
// 'no_model' ⇒ nothing downloads, portal-transcription.js). Unset ⇒ we resolve NOTHING,
// and the drainer never wakes Ollama and never pulls.
//
// ⚠️ THIS IS WHY THE FALLBACK IS GONE. It used to default to DEFAULT_LABEL_MODEL, and that
// single default was the whole reason a fresh vault silently downloaded 3.4GB (qwen3.5:4b)
// — plus the Ollama RUNTIME it needs (ollama-daemon.js autoInstall) — with no prompt, no
// progress, and no way to decline. Three of the four local models already required consent
// (embedding is bundled, whisper and Kokoro are click-to-download); labeling was the lone
// offender. This makes the outlier behave like the majority.
//
// DEFAULT_LABEL_MODEL survives as the RECOMMENDATION (what the Intelligence step proposes,
// via role-models.js ROLE_RECOMMENDATIONS.labeling) — never as a SILENT DEFAULT (what runs
// unasked). That distinction is the entire fix; do not "helpfully" restore the fallback.

/**
 * The APPROVED on-box labeling model for this vault, or null if the owner has not approved
 * one. Labeling is on-box by design (bulk + privacy) — this resolves a LOCAL model NAME,
 * not a cloud provider.
 *
 * FAIL-CLOSED: any read error → null (no model), never a default. A settings read that
 * fails must not be read as consent — the old fail-soft-to-default did exactly that.
 */
export async function defaultLabelModel(db, userId, fallback = null) {
  try {
    const s = await db?.users?.getSettings?.(userId);
    const m = s?.taskModels?.categorize?.model;
    if (typeof m === 'string' && m.trim()) return m.trim();
  } catch { /* fail-closed → no model */ }
  return fallback;
}

/**
 * The APPROVED on-box model for L2 message enrichment (semantic entities + gist), or null.
 * Its own SETTING (`taskModels.enrich`) — which is why it has its own health member below.
 *
 * ⚠️ THE APPROVAL HISTORY, because this line has now been wrong in BOTH directions:
 *   • It once said "approving labeling in the Intelligence step sets both" — false at the time.
 *   • It was then corrected to "NOTHING sets both: PUT writes exactly ONE task per call" —
 *     which THIS increment made false again (2026-07-16), and which had the perverse effect of
 *     denying the very design the branch implements.
 * The truth, stated once: the SETTINGS are independent (two keys, two health members), but the
 * Intelligence screen approves Understanding = {categorize, enrich} as ONE choice, and the
 * route fans out — `PUT /providers/task-models {function:'understanding', model}` writes BOTH
 * (portal-providers.js; gate M8 in verify-task-models.mjs). The per-task path still exists and still writes exactly one,
 * so a NON-screen caller can still approve them separately — which is why the enricher keeps
 * its own report rather than inheriting the labeler's.
 *
 * It is no longer STRUCTURALLY ABSENT, which was the actual defect: the dormancy had no report
 * anywhere — readiness's `models` slice carried {embedder, labeler, transcriber} and
 * portal-activity projects only embed + categorize. getEnricherHealth() (below) is now the
 * fourth member of that slice, so enrich is reported on exactly the same terms as the labeler.
 * The SETTING's independence stays (two keys); what changed is that the screen no longer makes
 * the user reason about them separately (operator decision, 2026-07-16).
 *
 * ⚠️ DO NOT read that as "the user can now SEE it". The slice is SERVED — GET /api/v1/portal/
 * readiness (server-rest.js) returns it, and `models` is in readiness.js's ALL, so a slice-less
 * call carries it — but nothing RENDERS it: `portal-app/src` has zero consumers of models.*
 * (verified 2026-07-16). Equally true of `labeler`, which M added the same way. This buys
 * PARITY — enrich is no longer the one on-box task missing from the model — not a visible
 * indicator. (Both halves matter: an earlier draft of this note over-claimed "a state you can
 * SEE", and its own correction then under-claimed "no route serves it". The route serves it;
 * the renderer is what's missing.)
 *
 * STILL OPEN (recorded, not papered over): whatever renders `models` must render four members,
 * not three; increment I's function map owes `enrich` a home — §3.11b's table lists six
 * functions and covers only three of INFERENCE_TASKS' six (harness, reflection and enrich have
 * none); and portal-activity has no enrich PROJECTION row (that needs an nlp-backlog counter —
 * verified absent: only embed + categories have one, and a third polled full-table decrypt
 * scan is a perf decision, not a comment fix).
 *
 * Fail-closed → null.
 */
export async function defaultEnrichModel(db, userId, fallback = null) {
  try {
    const s = await db?.users?.getSettings?.(userId);
    const m = s?.taskModels?.enrich?.model;
    if (typeof m === 'string' && m.trim()) return m.trim();
  } catch { /* fail-closed → no model */ }
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
  // The APPROVED on-box labeling model, when a caller wants to inject one directly (tests).
  // NULL by default — and that is the consent gate, not an oversight: unset ⇒ nothing is
  // resolved, nothing is woken, nothing is pulled (§3.10c above). It is NOT a fallback for
  // an unset setting; qwen3.5:4b is the RECOMMENDATION (role-models.js), which the
  // Intelligence step offers and the owner approves — writing it to settings.taskModels.
  labelModel = null,
  // Ollama model-management client (listInstalled + pullModel). Injectable so the gate can
  // drive the pull offline.
  ollama = createOllamaClient(),
  // Context Engine L1: per-message domain+register tagging via the on-box model (cheap,
  // private; format:'json' constrains the reply). INJECTABLE so the gate can drive it offline.
  // In production leave it null → the cycle resolves the model each tick from settings (below)
  // so a Settings → Intelligence change takes effect without a restart. A model outage leaves
  // rows pending (self-heals next cycle), never poisons a row.
  classify = null,
  // Resolve the APPROVED on-box labeling model NAME from the per-task setting (categorize is
  // on-box by design — see INFERENCE_TASKS). null ⇒ not approved ⇒ labeling pauses honestly.
  // The SAME resolved name feeds the pull below, so an owner-chosen model is what gets pulled.
  resolveLabelModel = () => defaultLabelModel(db, userId, labelModel),
  // L2 message enrichment (semantic entities + gist) model resolver — its OWN setting
  // (taskModels.enrich), same consent rule, same null-means-not-approved.
  // ⚠️ THE FALLBACK IS `null`, NOT `labelModel`. It used to be `labelModel` — i.e. the model
  // approved for LABELING was the fallback for the ENRICH setting, so a caller injecting
  // labelModel would silently make a labeling-only approval count as enrich consent, and
  // enricherHealth would report 'ok' naming it. Inert in production (server-rest passes no
  // labelModel, and nothing else injects it — audited), which is exactly why it survived: a
  // consent crossover that no test could see, so it is closed rather than commented.
  //
  // ⚠️ WHY IT IS STILL WRONG NOW THAT ONE APPROVAL CAN SET BOTH. An earlier version of this
  // line justified the fix with "the Intelligence copy says each on-box task is approved
  // SEPARATELY". That is not a rule to lean on: it is SCOPED, not universal — true of the
  // per-task screen shipping today (AISettings' two on-box selects → the per-task route, which
  // writes exactly one), and false of the function path (role-models.js: Understanding =
  // {categorize, enrich}; portal-providers.js fans out; gate M8 in verify-task-models.mjs).
  // A justification that flips with which screen is mounted is not a justification.
  // The real reason is sharper and survives both:
  // consent must be EXPLICIT. `{function:'understanding'}` approving both is the OWNER'S choice
  // and it WRITES BOTH SETTINGS — `taskModels.enrich` genuinely records it. A resolver fallback
  // invents consent nobody gave and records it in NO SETTING: `taskModels.enrich` stays unset
  // while the code behaves as though it were set (and enricherHealth then reports 'ok' naming a
  // model the owner never approved — see 8 lines up; "nowhere" would contradict that). Joint
  // approval is a decision; an implicit fallback is a lie.
  // (independent review ×3, 2026-07-16 — this site survived two sweeps that claimed to be
  // complete, in the file both of them edited.)
  resolveEnrichModel = () => defaultEnrichModel(db, userId, null),
  // db.activityFeed — a 3.4GB pull is the longest unattended thing the app does, so it
  // publishes to the ONE progress surface (`model-pull`, design §3.10e) instead of being
  // log-only. OPTIONAL: absent ⇒ no publishing, identical behaviour otherwise.
  activityFeed = db?.activityFeed || null,
} = {}) {
  const svc = createEnrichmentService({ messages: db.messages, embed, getMasterKey, classify });
  let running = false;
  let pending = false;
  let _skips = 0; // consecutive cycles skipped because the embed service looked unhealthy
  let _embedErrs = 0; // consecutive cycles whose embed block THREW (throttles the log; see the guard)
  // ms of the last cycle that RAN. ⚠️ Meaning changed 2026-07-15: it used to mean "got past
  // the health gate", because the gate returned from the whole cycle. Now the gate only
  // skips EMBEDDING, so a cycle runs (and stamps this) even with :8091 dead — it labels.
  // Liveness of the CYCLE, not evidence that embedding happened. `_skips`/`health` say that.
  let _lastCycleAt = 0;
  let _lastProgressAt = 0; // ms of the last cycle that actually embedded something
  let _noProgress = 0;     // consecutive cycles whose head-of-queue would not embed (throttles the log)
  let _health = 'unknown'; // last observed embed-service health: ok | loading | error | unreachable
  const embedBaseUrl = () => `http://127.0.0.1:${Number(process.env.MYCELIUM_EMBED_PORT) || 8091}`;
  let timer = null;
  // Cached on-box labeling classifier, rebuilt only when the resolved model changes (so a
  // Settings change swaps the model live without a restart, and we don't rebuild every cycle).
  let _labelModel = null;
  let _labelClassify = null;
  // The labeling model the last cycle RESOLVED from settings — i.e. what the owner approved.
  // ⚠️ Tri-state, and the distinction is load-bearing for getLabelerHealth():
  //   undefined = no cycle has read the setting yet (boot)  → 'unknown'
  //   null      = read, and nothing is approved             → 'no_model'
  //   string    = approved
  let _approvedModel;
  // Same tri-state, for the L2 ENRICH model (settings.taskModels.enrich). SEPARATE from
  // `_approvedModel` because the two settings are independent — a vault can approve labeling
  // and leave enrich unset. Collapsing them into one slot is precisely the bug M7b in verify-model-consent.mjs caught one
  // layer down (the shared _pulling/_faults slots made the enrich model's download read as the
  // labeler's health); the same trap applies to the approved-model slot itself.
  let _approvedEnrichModel;
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

  // Health for the DRAIN GATE: only 'ok' may drain (embedding against a loading/erroring
  // service would burn the backlog). But report WHY, so the caller can tell a model that
  // is still warming up (normal, transient — a 170MB download on first run) from an
  // outage. Conflating the two made onboarding look broken.
  async function embedHealth() {
    try {
      const h = await embed.health(); // /health → { status, loaded, dim, … }
      if (!h) return 'unreachable';
      if (h.loaded === false || h.status === 'loading') return 'loading';
      if (h.status && h.status !== 'ok') return h.status;   // 'error' | anything else
      return 'ok';
    } catch { return 'unreachable'; }
  }
  async function embedHealthy() { return (await embedHealth()) === 'ok'; }

  /**
   * Does `installed` (ollama's tag list) contain the APPROVED `model`?
   *
   * ⚠️ AN APPROVAL THAT NAMES A TAG MEANS *THAT* TAG. This used to be
   * `n === model || n.split(':')[0] === base`, i.e. a bare BASE match in both directions — so a
   * vault that approved `qwen3.5:4b` and had only `qwen3.5:70b-instruct` installed was declared
   * ready, and then reported "Labeling with qwen3.5:4b." while every classify 404'd on a model
   * that does not exist there (independent review, 2026-07-16). Two different tags of one base
   * are two different models — different weights, different size, and in the 4b-vs-70b case a
   * ~40GB difference in what the owner agreed to run on their machine.
   *
   * ⚠️ AND A TAG-LESS APPROVAL MEANS `:latest` — NOT "any tag". The first fix here kept a base
   * match for the tag-less case and commented it as "any installed tag of it satisfies it". That
   * is FALSE, and a re-review proved it against a LIVE ollama daemon rather than by reading —
   * with only `qwen3.5:4b` installed:
   *     qwen3.5              → {"error":"model 'qwen3.5' not found"}
   *     qwen3.5:latest       → {"error":"model 'qwen3.5:latest' not found"}
   *     qwen3.5:70b-instruct → {"error":"model 'qwen3.5:70b-instruct' not found"}
   *     qwen3.5:4b           → runs
   * (reproduced independently here, 2026-07-16). Ollama resolves a tag-less name to `:latest`
   * and nothing else, and localInfer sends the APPROVED NAME VERBATIM — so a tag-less approval
   * matched against `qwen3.5:4b` reported "Labeling with qwen3.5." while every classify 404'd:
   * this commit's own headline defect, re-committed by its own fix, and the gate written to
   * bless it (M9l) asserted the lie as intended behaviour. Hence one rule, no branches: the
   * name ollama will be ASKED for is the name that must be installed.
   *
   * Shared by the pull decision and the health probe ON PURPOSE — two predicates would let
   * health and the classifier disagree about the same model, which is the class M7b exists to
   * catch, one layer down. A tag-less PULL installs `<name>:latest` — VERIFIED against the live
   * daemon (`/api/copy` to a tag-less name lists back as `<name>:latest` and resolves) — so the
   * post-pull list satisfies this predicate and it settles.
   *
   * KNOWN LIMIT, on record rather than rediscovered: `includes(':')` is HOST-UNAWARE. For a
   * port-qualified registry name (`registry.local:5000/library/qwen3.5`) ollama parses the tag
   * as the colon after the LAST slash, so it resolves `:latest` while this reads the PORT colon
   * as a tag. Cosmetic — it costs one no-op re-pull attempt per boot and cannot loop, because
   * the pull's `.then()` adds to `_modelReady` unconditionally without re-consulting this. It
   * needs a hand-typed name to reach at all: the picker only offers `/api/tags` names, which
   * always carry a tag. The old base match survived this case BY ACCIDENT while lying broadly
   * (re-review, 2026-07-16). Fix by splitting on the last '/' before the ':' if a registry with
   * a port ever ships.
   */
  function isInstalled(installed, model) {
    if (!Array.isArray(installed)) return false;
    const want = String(model).includes(':') ? String(model) : `${model}:latest`;
    return installed.some((n) => n === want);
  }

  // PRODUCTION: ensure the APPROVED on-box labeling MODEL is actually installed before we
  // classify. daemon.ensureUp() only starts the Ollama SERVER — but a fresh, app-private
  // Ollama ships with NO models, so the first classify fails "model not found" and L1
  // silently never runs for that user (the model-tier sibling of the lazy-server dormancy
  // bug). We pull ONCE, in the BACKGROUND (the download is minutes — never hold the drain
  // cycle for it), and skip the tagging loop until it's ready. Result cached so we hit
  // `ollama list` at most once per model. Fail-soft: any error leaves rows pending.
  const _modelReady = new Set();   // models confirmed present (or freshly pulled) this session
  // ⚠️ KEYED BY MODEL, not module-global. ensureLabelModel() runs for BOTH the L1 label model
  // and the L2 enrich model, which can differ — so a single shared slot made the ENRICH
  // model's download or failure surface as the LABELER's health: "Downloading gemma4:12b…"
  // while labeling ran fine on qwen, or "runtime not reachable" when only the enrich pull
  // hit a disk-full (independent review, 2026-07-16).
  const _pulling = new Map();      // model → pct (0-100), byte-accurate from ollama's stream
  const _faults = new Map();       // model → last non-consent reason it can't run (Ollama down)
  const _probing = new Set();      // models with a readiness probe in flight (single-flight; see probeModelReady)
  async function ensureLabelModel(model) {
    // ⚠️ NO MODEL ⇒ NOT APPROVED ⇒ NEVER PULL, NEVER RUN (§3.10c). This return is the consent
    // gate. It used to be `if (!model || …) return TRUE` — i.e. an unapproved model reported
    // READY, which is how the classifier ran (and the pull fired) on a vault whose owner was
    // never asked. False is the honest answer: labeling is paused, and §3.5's blocked states
    // make that a legitimate steady state rather than a transient error.
    if (!model) return false;
    if (_modelReady.has(model)) return true;
    if (_pulling.has(model)) return false;               // download in flight → not ready yet
    let installed;
    try { installed = await ollama.listInstalled(); }    // ['qwen3.5:4b', 'llama3.1:latest', …]
    catch (e) {                                          // can't reach Ollama → retry next tick
      _faults.set(model, String(e?.message || e).slice(0, 120));
      return false;
    }
    _faults.delete(model);
    if (isInstalled(installed, model)) {
      _modelReady.add(model); return true;               // already have it
    }
    _pulling.set(model, 0);
    log(`[enrich] labeling model "${model}" not installed — pulling it once (a few minutes)…`);
    // A multi-GB download is the longest unattended thing the app does. It was log-only, so
    // it was invisible from every screen (§3.10e). The model NAME is publishable — it is an
    // identifier, never user content — and is what the feed's `model` column exists for.
    // UNIQUE PER ATTEMPT, AND ACROSS RESTARTS. begin() is `ON CONFLICT(id) DO UPDATE SET
    // status='running', finished_at=NULL, error=NULL`, so any id reuse REOPENS the previous
    // attempt's row and erases that failure from history — the user never learns the download
    // keeps failing.
    //
    // ⚠️ It must be a CLOCK, not a counter. A process-local counter (the first fix here) resets
    // to 0 on every app restart, so boot 2's first attempt re-minted boot 1's id and wiped its
    // error row — proven with a two-boot probe (re-review, 2026-07-16). A persistent failure
    // (disk full, no network) is exactly the case that retries across a restart, so the counter
    // failed precisely where it was needed. That review also caught the comment defending it:
    // it cited the import runner as precedent for "not a clock", but import-job.js uses
    // `import-${j.startedAt}` — a wall clock, restart-safe BECAUSE it isn't a counter. The
    // stated rationale was the inverse of its own precedent. This now genuinely matches it.
    // (No hot-path concern: a multi-GB pull happens at most once per model per process.)
    const feedId = `model-pull-${model}-${Date.now()}`;
    publishPull.begin(feedId, model);
    ollama.pullModel(model, (ev) => {
      // ollama streams { status, completed, total } per layer.
      const total = Number(ev?.total) || 0, done = Number(ev?.completed) || 0;
      if (total > 0) { _pulling.set(model, Math.max(0, Math.min(100, Math.round((done / total) * 100)))); }
      publishPull.beat(feedId, done, total, model);
    })
      .then(() => { _modelReady.add(model); publishPull.end(feedId, 'done'); log(`[enrich] labeling model "${model}" ready — L1 resumes`); })
      .catch((e) => {
        _faults.set(model, String(e?.message || e).slice(0, 120));
        // A CONSTANT to the feed: the row is content-free by contract (activity-feed.js §SECURITY).
        // An ollama error is a model name + an HTTP status today, but this is not the place to
        // bet on that staying true. The reason stays in _faults, behind the authed route.
        publishPull.end(feedId, 'error', 'download failed');
        log(`[enrich] pull "${model}" failed: ${String(e?.message || e).slice(0, 60)} — will retry`);
      })
      .finally(() => { _pulling.delete(model); });        // next 15s tick resumes categorize
    return false;
  }

  /**
   * Is the APPROVED model installed, right now? A READ-ONLY probe, and every "not" is
   * load-bearing: it never wakes the daemon, never installs the runtime, never pulls.
   *
   * WHY IT EXISTS: `_modelReady` used to be written ONLY by ensureLabelModel(), which the
   * cycle calls only when `pc.length || pn.length` — so the 'ok' branch of both healths was
   * reachable ONLY while rows were pending. Two vaults identical in settings, model and
   * runtime, differing only in boot history, disagreed:
   *   had a backlog earlier this process → 'ok'      "Enriching with qwen3.5:4b."
   *   caught up at boot (mature vault)   → 'unknown' "Checking the enrichment model…"
   * i.e. the steady state of every mature vault after a restart was 'unknown' — the healthiest
   * configuration reporting as the least known one, and saying "Checking…" while nothing was
   * checking. That is the fabricated liveness this slice exists to remove, pointed the other
   * way (independent review, 2026-07-16). Readiness is a property of the APPROVAL and the
   * MODEL'S INSTALLED-NESS, never of the backlog, so it is resolved here rather than inside the
   * pending gate.
   *
   * ⚠️ HONEST LIMIT — `_modelReady` is a process-lifetime cache and is never cleared, so 'ok'
   * strictly means "confirmed installed at least once THIS PROCESS", not "confirmed right now".
   * Two caught-up vaults whose runtime is unreachable AT THIS MOMENT can therefore still
   * disagree — one confirmed earlier and says 'ok', one never could and says 'unknown' — which
   * is the same boot-history dependence, narrowed rather than eliminated. An earlier draft of
   * this comment claimed readiness was a property of "the APPROVAL and the RUNTIME", which
   * would make that disagreement a bug; it is not what the code does (independent review,
   * 2026-07-16 — it caught the claim by re-running the fix's own premise against it). The cache
   * is deliberate: a SLEEPING daemon does not un-install a model, and re-probing a known model
   * every 15s to re-learn a fact that cannot change would spend requests to say nothing new.
   */
  async function probeModelReady(model) {
    // NOT APPROVED ⇒ NO CALL. The same consent gate as ensureLabelModel's `if (!model)`: an
    // unapproved vault must reach Ollama zero times, not "only to look" (§3.10c, gate M1).
    if (!model) return;
    if (_modelReady.has(model) || _pulling.has(model)) return;  // known, or a pull is in flight
    // SINGLE-FLIGHT PER MODEL. Un-awaiting the probe (so it cannot delay embedding) also dropped
    // it out of cycle()'s `running` guard, which had been bounding it for free: while ollama
    // hangs, `_modelReady` never fills, so every cycle fired a fresh probe and they accumulated
    // — a re-review drove 5,236 concurrent in-flight probes through the un-rate-limited
    // POST /portal/enrichment/trigger route (owner-only, so LOW, but it is a real invariant the
    // await used to hold). The 15s timer alone cannot reach it (the 5s cap settles first); the
    // nudge path can. Bound it explicitly rather than relying on a timing coincidence.
    if (_probing.has(model)) return;
    // ⚠️ THE WHOLE BODY IS INSIDE THE TRY, AND THAT IS NOT TIDINESS. This runs ABOVE the embed
    // gate, so a throw from here would land in cycle()'s outer catch and skip EVERYTHING below
    // — embedding, L1 and L2 — which is precisely the coupling the guard further down exists to
    // break. A health probe that can take down the pipeline it reports on is worse than no probe
    // at all. Not theoretical: listInstalled() is INJECTABLE and reaches the network, so it can
    // reject; isInstalled() absorbs a malformed ANSWER, but only this try absorbs a rejected CALL.
    _probing.add(model);
    try {
      // isInstalled() is the SHARED predicate (see it for why a tagged approval is exact), and
      // it is also total: a non-array answer is `false`, never a throw.
      if (isInstalled(await ollama.listInstalled(), model)) {
        // Clearing the fault only on the INSTALLED path is belt-and-braces, not a mechanism:
        // ensureLabelModel's own unconditional `_faults.delete` dominates in every reachable
        // state (a live pull-fault implies pending rows, which implies that path runs). A
        // counterfactual probe showed identical status histories with and without this
        // condition (independent review, 2026-07-16, which also refuted the 5-line rationale an
        // earlier draft gave it here). It is kept only because a probe that clears a fault it
        // cannot disprove would be wrong on its face — not because a test can tell the
        // difference. Do not cite it as load-bearing.
        _faults.delete(model);
        _modelReady.add(model);
      }
    } catch {
      // ⚠️ DELIBERATELY NOT A FAULT. listInstalled() throws when the daemon is merely ASLEEP —
      // and the daemon is lazy: on a caught-up vault nothing has woken it, because nothing
      // needs it. Recording 'unavailable' ("The local model runtime is not reachable") here
      // would trade the 'unknown' lie for a louder one: an alarm on a vault that is working
      // perfectly and would wake the daemon the moment a row arrived. We genuinely cannot see
      // whether the model is installed, so we say so by leaving the state alone → 'unknown'.
      // A fault is still recorded where it is EARNED: ensureLabelModel(), i.e. after a wake was
      // actually attempted for real pending work. Do not "simplify" this into a fault.
    } finally {
      _probing.delete(model);   // release the single-flight slot on EVERY path, including a throw
    }
  }

  // The pull's feed publishing — fire-and-forget and swallowed, exactly like the import
  // runner's: the feed is a mirror, and a broken mirror must never stop a download.
  const publishPull = {
    begin: (id, model) => { try { activityFeed?.begin({ userId, kind: 'model-pull', id, totalSteps: 0, stageLabel: 'Downloading the labeling model', model }).catch(() => {}); } catch { /* never */ } },
    beat: (id, step, totalSteps, model) => { try { activityFeed?.heartbeat(id, { step, totalSteps, stalled: false }).catch(() => {}); } catch { /* never */ } },
    end: (id, status, error = null) => { try { activityFeed?.finish(id, { status, error }).catch(() => {}); } catch { /* never */ } },
  };

  /**
   * Labeler health, in the SAME shape the two supervisors that already exist return
   * (getEmbedderHealth / getTranscriberHealth — {status, message, detail, model, progress}),
   * over the shared vocabulary. The drainer's equivalents were closure-local and never
   * exported, so nothing outside could tell "paused, no model" from "running" (§3.10b).
   *   'ok'          — an approved model is installed; L1 runs
   *   'no_model'    — no model approved yet. NOT an error: a supported configuration.
   *   'downloading' — the approved model is being pulled (progress.pct, byte-accurate)
   *   'paused'      — the owner stopped the churn. A CHOICE, not a fault.
   *   'unavailable' — Ollama unreachable (detail = why); actionable
   *   'unknown'     — no cycle has resolved the setting yet (boot)
   */
  function labelerHealth() {
    // ⚠️ EVERY branch below reports on THE LABELING MODEL specifically (`_approvedModel`).
    // The first draft read module-global pull/fault slots that ensureLabelModel also writes
    // for the L2 ENRICH model — so labeling reported "Downloading gemma4:12b…" while it was
    // happily running on qwen, and an enrich-only disk-full read as a labeling outage.
    // If you add a branch here, key it by model or it will lie the same way.
    const m = _approvedModel;
    // undefined ⇒ no cycle has resolved the setting yet (boot). NOT the same as null, which
    // is a resolved "the owner has not approved one" — conflating them would render
    // "no labeling model" for the first seconds of every boot, which is a lie.
    if (m === undefined) {
      return { status: 'unknown', message: 'Checking the labeling model…', detail: null, model: null, progress: null };
    }
    if (m === null) {
      return { status: 'no_model', message: 'No labeling model approved — messages stay uncategorized.', detail: null, model: null, progress: null };
    }
    if (_pulling.has(m)) {
      return { status: 'downloading', message: `Downloading ${m}…`, detail: null, model: m, progress: { pct: _pulling.get(m) ?? 0 } };
    }
    // The owner stopped the churn (POST /portal/enrichment/categorize/pause). A CHOICE, not
    // a fault — and it outranks 'ok' because nothing is actually labeling. It was missing
    // from the vocabulary entirely, so the one state the user explicitly picked was the one
    // this slice could not express (independent review, 2026-07-16).
    if (isEnrichCategorizePaused()) {
      return { status: 'paused', message: 'Labeling is paused — pending messages are waiting.', detail: null, model: m, progress: null };
    }
    if (_faults.has(m)) {
      return { status: 'unavailable', message: 'The local model runtime is not reachable.', detail: _faults.get(m), model: m, progress: null };
    }
    if (_modelReady.has(m)) return { status: 'ok', message: `Labeling with ${m}.`, detail: null, model: m, progress: null };
    return { status: 'unknown', message: 'Checking the labeling model…', detail: null, model: m, progress: null };
  }

  /**
   * Enricher health — L2 (semantic entities + gist), in the SAME shape and vocabulary as
   * labelerHealth() above. It is a near-mirror ON PURPOSE, but it is NOT the labeler's answer
   * copied: every branch keys on `_approvedEnrichModel` and the model-keyed _pulling/_faults/
   * _modelReady slots, so an enrich-only pull or an enrich-only fault reports HERE and nowhere
   * else. (Reading the labeler's slots instead is exactly the lie M7b in verify-model-consent.mjs was written to catch.)
   *
   * WHY IT EXISTS: `taskModels.enrich` is its own setting, and L2 ran dead with NOTHING
   * anywhere reporting it — the readiness `models` slice carried {embedder, labeler,
   * transcriber} and portal-activity projects only embed + categorize (re-review, 2026-07-16).
   * This is the missing REPORT, not a gate.
   * ⚠️ Still needed after the Intelligence screen began approving {categorize, enrich} together
   * (`{function:'understanding'}` fans out — portal-providers.js): the per-task route still
   * writes one task at a time, so enrich can still be approved, paused, pulled or broken on its
   * own. A member that inherited the labeler's answer would be the lie M7b in verify-model-consent.mjs exists to catch.
   *
   *   'ok'          — an approved model is installed; L2 runs
   *   'no_model'    — no model approved yet. NOT an error: a supported configuration.
   *   'downloading' — the approved model is being pulled (progress.pct, byte-accurate)
   *   'paused'      — the owner stopped the churn. A CHOICE, not a fault.
   *   'unavailable' — Ollama unreachable (detail = why); actionable
   *   'unknown'     — no cycle has resolved the setting yet (boot)
   */
  function enricherHealth() {
    const m = _approvedEnrichModel;
    // undefined ⇒ no cycle has resolved the setting yet (boot); null ⇒ resolved, not approved.
    if (m === undefined) {
      return { status: 'unknown', message: 'Checking the enrichment model…', detail: null, model: null, progress: null };
    }
    if (m === null) {
      return { status: 'no_model', message: 'No enrichment model approved — messages keep their entities and gist unextracted.', detail: null, model: null, progress: null };
    }
    if (_pulling.has(m)) {
      return { status: 'downloading', message: `Downloading ${m}…`, detail: null, model: m, progress: { pct: _pulling.get(m) ?? 0 } };
    }
    // ⚠️ The pause flag is SHARED, and truthfully so: pauseEnrichCategorize() skips the whole
    // `if (!isEnrichCategorizePaused())` block in cycle(), which contains the L2 loop as well
    // as L1. So a paused vault really is not enriching. The flag's NAME says categorize; its
    // SCOPE is both. Do not "fix" this by reporting 'ok' here — that would resurrect the
    // dormancy this member exists to expose.
    if (isEnrichCategorizePaused()) {
      return { status: 'paused', message: 'Enrichment is paused — pending messages are waiting.', detail: null, model: m, progress: null };
    }
    if (_faults.has(m)) {
      return { status: 'unavailable', message: 'The local model runtime is not reachable.', detail: _faults.get(m), model: m, progress: null };
    }
    if (_modelReady.has(m)) return { status: 'ok', message: `Enriching with ${m}.`, detail: null, model: m, progress: null };
    return { status: 'unknown', message: 'Checking the enrichment model…', detail: null, model: m, progress: null };
  }

  async function cycle() {
    if (running) { pending = true; return; } // single-flight; coalesce concurrent nudges
    running = true;
    try {
      // ── RESOLVE + STAMP THE APPROVED MODELS FIRST, ABOVE EVERYTHING THAT CAN THROW ──
      // These two are pure settings READS: they wake nothing, install nothing, download nothing.
      // Read the resolver bodies for that — defaultLabelModel/defaultEnrichModel call
      // db.users.getSettings and nothing else, and both are try/catch fail-closed, so neither
      // can throw and neither can resolve a model from a failed read. (An earlier draft of this
      // line cited "50 health reads drove 0 settings reads" as proof. That probe measured
      // getEnricherHealth(), which never runs these resolvers — 0 settings reads is what it
      // MEASURED, not evidence about them. True claim, wrong proof; a review caught the
      // mis-citation in the very diff whose subject is over-claimed prose.)
      // They are hoisted to the very top for one reason: THE STAMP MUST NOT BE REACHABLE-ONLY
      // THROUGH THE DRAIN PATH. They used to sit below the `if (embedOk)` block, still inside
      // this try — so any throw in the embed loop (svc.drainOnce() is unguarded) hit the outer
      // catch and skipped the stamp, leaving _approvedModel/_approvedEnrichModel `undefined`
      // and BOTH healths reporting 'unknown' / "Checking the … model…" FOREVER, since the same
      // throw repeats every cycle. That is the identical defect the note below records for the
      // pause block — the stamp was moved out of the pause and left under the throw, i.e. only
      // half-fixed (independent review, 2026-07-16; reproduced with a throwing drain path).
      // A health that says "Checking…" while the cycle crashes every 15s is the fabricated
      // liveness this whole slice exists to remove. Keep them ABOVE the embed gate.
      const labelM = await resolveLabelModel();   // resolve once — feeds the pull AND the classifier
      const enrichM = await resolveEnrichModel();  // ditto for the enrich model
      _approvedModel = labelM ?? null;             // what getLabelerHealth() reports on
      _approvedEnrichModel = enrichM ?? null;      // what getEnricherHealth() reports on

      // ── RESOLVE READINESS FROM THE APPROVAL, NOT FROM THE BACKLOG ──
      // `_modelReady` was written ONLY under `if (pc.length || pn.length)`, so a CAUGHT-UP vault
      // could never reach 'ok' and reported "Checking the … model…" forever. Read-only and
      // fail-soft: probeModelReady never wakes, installs, pulls or throws, and is a no-op on an
      // unapproved model — so an unapproved vault still touches Ollama zero times (M1), and an
      // idle one still spawns nothing (M2).
      //
      // ⚠️ NOT AWAITED, AND THAT IS THE POINT. Awaiting it here put a health question on
      // EMBEDDING'S CRITICAL PATH: listInstalled() is capped at 5s (ollama.js AbortSignal.timeout),
      // and an ollama that accepts connections but hangs — the app's own daemon during boot does
      // exactly this — made every 15s cycle spend 10s (two sequential probes) before the first
      // embed read. Measured on this diff before the fix: first drainOnce read at t+10008ms vs
      // t+4ms on main (independent review, 2026-07-16). Embedding has no stake whatsoever in the
      // model list, so it must not wait on it: a health probe that delays the pipeline it reports
      // on is the coupling this very commit removes from the embed gate, re-introduced by its own
      // fix. Fire-and-forget is safe precisely because the probe cannot throw and writes nothing
      // but two in-memory Sets/Maps; the health resolves a tick later, which is a health surface's
      // whole tolerance. DEDUPED because the two tasks usually name the SAME model — two identical
      // in-flight probes would double the cost of the thing being made free.
      for (const m of new Set([labelM, enrichM].filter(Boolean))) void probeModelReady(m);

      // NEVER skip silently. This early return sat here for a month while the embed
      // service was a single-request HTTPServer: any in-flight batch blocked /health
      // (measured: 7.8s), embedHealthy() swallowed the timeout → false → return, with
      // NO log — every 15s, forever, while the UI still rendered "Embedding messages"
      // (that label is just `pending > 0`, not liveness). A skip you can't see is a
      // failure you can't fix. Throttled so a genuinely-down service can't spam.
      _health = await embedHealth();
      const embedOk = _health === 'ok';
      if (!embedOk) {
        _skips++;
        if (_skips === 1 || _skips % 20 === 0) {
          log(`[enrich] SKIPPED embedding, cycle #${_skips}: embed service not healthy at ${embedBaseUrl()} — nothing is being embedded. `
            + `(backlog stays put; check the service is up and not saturated. Labeling still runs — it needs Ollama, not the embed service)`);
        }
      } else if (_skips) {
        log(`[enrich] embed service healthy again after ${_skips} skipped cycle(s) — resuming`);
        _skips = 0;
      }
      _lastCycleAt = Date.now();

      // ⚠️ THE EMBED HEALTH GATE SKIPS EMBEDDING — NOT THE CYCLE (design §3.6).
      // It used to `return` here, so a dead embed service ALSO silenced L1 labeling — which
      // depends on OLLAMA, not on :8091. Two independent pipelines, one gate:
      // when the embed sidecar died, categorization stopped too, for reasons that had
      // nothing to do with it. Nothing about labeling requires an embedding to exist first
      // (selectPendingCategories keys on categories_processed alone — "INDEPENDENT of the
      // nlp_processed state machine"), so there was never a real ordering dependency — only
      // this early return.
      //   NB on L2: it also moves below the gate and never calls :8091 — but unlike L1 it IS
      //   downstream of embedding (selectPendingNlp requires nlp_processed = 2, which only
      //   the embed loop sets). With the embedder dead L2 drains a pre-existing residue and
      //   then finds nothing new. Correct, but do not read this as "L2 is independent".
      //
      // ⚠️ THE GATE WAS ONLY HALF THE COUPLING — AND THIS COMMENT USED TO STOP HERE, which made
      // it read as a completed decoupling it had not finished. The early `return` was removed,
      // but svc.drainOnce() below was left UNGUARDED inside this block, so a THROW walked to
      // cycle()'s outer catch and skipped the entire L1+L2 block anyway — the exact outcome the
      // paragraph above says was fixed, by a different mechanism. It is not hypothetical:
      // service.js:69 throws BY DESIGN on a locked vault ('master key unavailable … refusing to
      // write') and service.js:72 can throw on SQLITE_BUSY. Demonstrated with pending work every
      // cycle, the model installed and Ollama up: 0 rows tagged, 0 enriched, both healths stuck
      // (independent review, 2026-07-16). Hence the try/catch: an embed failure now costs
      // EMBEDDING, and nothing else. Two independent pipelines, one gate — and now, one throw.
      if (embedOk) {
      try {

      // SELF-HEAL: retry rows that previously failed for a NON-content reason
      // (service down/slow/timeout) now that the service is healthy.
      //
      // The old `AND nlp_error NOT LIKE '%expected 768%'` clause is gone. The honest reasons
      // (an earlier version of this comment claimed nlp_error is field-encrypted — that is
      // FALSE: crypto-local.js ENCRYPTED_FIELDS.messages is `[]`; the prose above it is stale,
      // left from before the SQLCipher collapse. Don't repeat that: check the array, not the
      // comment):
      //  1. It matches NOTHING on this vault (verified: 0 rows). The `%expected 768%` rows
      //     that exist carry LEGACY encrypted envelopes written before the collapse, so the
      //     LIKE can't see them — and they are FALSE poison anyway, from the old
      //     `typeof null === 'object'` bug (a transient null read as a 3-dim vector). Letting
      //     the self-heal reclaim them is a FIX, not a regression: they are embeddable.
      //  2. It cannot fire for a GENUINE dimension mismatch either: client.js assertVector
      //     throws before service.js can ever write "expected 768", so such a row lands on
      //     the `vec == null` path and stays PENDING (0) — it never reaches -1 to be excluded.
      // So the clause quarantined nothing real. If poison-quarantine is ever needed, the hole
      // to close is service.js's `if (vec == null) continue`, not this LIKE.
      try {
        await db.rawQuery(
          "UPDATE messages SET nlp_processed = 0, nlp_error = NULL WHERE user_id = ?"
          + " AND nlp_processed = -1 AND embedding_768 IS NULL",
          [userId],
        );
      } catch { /* non-fatal */ }

      let embedded = 0;
      let stalledPasses = 0;
      for (let i = 0; i < 200; i++) {            // hard cap ≤200 batches/cycle (≤10k msgs)
        const e = await svc.drainOnce({ userId });
        embedded += e?.embedded ?? 0;
        if ((e?.scanned ?? 0) === 0) break;      // backlog drained
        // NO-PROGRESS BREAK. drainOnce leaves a transiently-failed row PENDING (by design —
        // never poison it), so a batch that embeds nothing re-selects the SAME rows next
        // pass: `scanned` stays 50 and this loop spins all 200 times, re-embedding the same
        // head of the queue and saturating the single-threaded embed service for minutes —
        // which then starves the health check and kills subsequent cycles. If a pass moved
        // nothing at all, the next pass can't either: stop and let the 15s tick retry.
        const moved = (e?.embedded ?? 0) + (e?.failed ?? 0) + (e?.skipped ?? 0);
        if (moved === 0) {
          if (++stalledPasses >= 1) {
            _noProgress++;
            if (_noProgress === 1 || _noProgress % 20 === 0) log(`[enrich] no progress on ${e?.scanned ?? 0} pending message(s) after ${stalledPasses} pass(es) `
              + `— pausing this cycle (retry in ${Math.round(intervalMs / 1000)}s). The head of the queue is not embeddable right now.`);
            break;
          }
        } else stalledPasses = 0;
      }
      if (embedded > 0) {
        _lastProgressAt = Date.now();
        // NLP enrichment (embedded → enriched) now runs in the on-box message block below, so it
        // uses the hybrid LLM enricher after the daemon is woken (was a regex pass here).
        log(`[enrich] embedded ${embedded} message(s) in-process`);
        // Embedded SOMETHING this cycle (NOT "backlog drained" — the drain signal is the
        // `scanned === 0` break above, which does not gate this hook) → let the owner decide
        // whether to kick off the topology pipeline (first-run auto-generate). The gate is
        // deliberately progress-based, not completion-based: maybeAutoGenerate reads only
        // `embedded`/`points` and never `pending`, so auto-generate fires on a vault that
        // still has work left — which is what makes it fire at all on a vault carrying
        // permanently un-embeddable rows. Decoupled: the drainer never imports jobs.js;
        // server-rest wires the gate (single-flight + topology-empty).
        try { await onSettled?.({ embedded }); } catch { /* non-fatal */ }
        }
      if (_embedErrs) { log(`[enrich] embedding recovered after ${_embedErrs} failed cycle(s)`); _embedErrs = 0; }
      } catch (err) {
        // EMBEDDING FAILED — LABELING AND ENRICHMENT ARE NOT ITS DEPENDANTS. Swallowed HERE, at
        // the narrowest scope that can contain it, rather than at cycle()'s outer catch: from
        // there the throw skipped L1 + L2 (and the ensureLabelModel calls that feed the healths),
        // silencing two pipelines that never touch :8091 for a reason that has nothing to do with
        // them. The two throws this exists for (service.js: the locked-vault refusal, and a
        // SQLITE_BUSY on the batch read) both fire BEFORE any write, so rows stay pending and the
        // next tick retries for free. (An earlier draft justified that with "drainOnce is
        // transactional per batch" — FALSE, and exactly the kind of comment this repo treats as a
        // defect: service.js has no transaction at all, it is a per-row write loop. The
        // conclusion held; the mechanism was invented. Verified by an independent review,
        // 2026-07-16.) A throw AFTER partial writes leaves those rows written and the rest
        // pending, which is still resumable — but do not read the old claim back into this.
        //
        // NEVER SILENTLY (§the skip-log rule above): a throw you can't see is the month-long
        // dormancy all over again. The first THREE are logged before throttling — a persistent
        // programming error (not just a locked vault) surfaces here too, and one line in twenty
        // buried its 16 siblings; the counter carries the persistence either way. The message is
        // an ERROR STRING, not vault content — the same one cycle()'s outer catch has always
        // logged; bounded anyway, on the principle that this is not the place to bet on an
        // upstream error staying content-free. It names the STAGE that failed, never a cause:
        // a null-row TypeError surfaces here just as a locked vault does.
        _embedErrs++;
        if (_embedErrs <= 3 || _embedErrs % 20 === 0) {
          log(`[enrich] embedding FAILED this cycle (#${_embedErrs}): ${String(err?.message || err).slice(0, 120)} `
            + '— backlog stays put; labeling + enrichment continue (they do not use the embed service)');
        }
      }
      } // ← end `if (embedOk)`. Everything BELOW runs even when the embed sidecar is down.

      // Context Engine L1: tag new + backfill messages with domain/register. Separate from
      // the embed gate so the historical backfill proceeds on cycles with no new embeds.
      // Bounded per cycle (≤8 batches = 200 msgs); stops on a model outage (failed>0), leaving
      // the rest pending for the next tick. Single-flighted by the outer `running` guard.
      //
      // USER PAUSE: the owner can stop the on-box-model churn (POST /portal/enrichment/
      // categorize/pause). Skip the wake + the tagging loop entirely while paused — rows stay
      // pending and resume exactly where they left off (resumable + idempotent). Embedding above
      // is unaffected. A restart clears the pause (safe default; see the flag's note).
      //
      // `labelM` / `enrichM` were resolved and stamped at the TOP of this try — on EVERY cycle,
      // pause or not, and above anything that can throw. Both placements are load-bearing and
      // were each a real bug: inside the pause block, a paused vault never stamped and reported
      // 'unknown' forever; below the embed gate, a throwing drain did the same. Do not move them
      // back down for tidiness.
      if (!isEnrichCategorizePaused()) {
        // WAKE THE ON-BOX MODEL FIRST. The Ollama daemon is lazy and the enrich path is the one
        // consumer that nothing else starts it for — so without this, a vault whose owner never
        // opened local chat would leave EVERY message untagged forever (the live-vault dormancy
        // bug). Wake it only when there's actual pending work, so an idle vault never spawns a
        // model. ensureUp() adopts a running daemon instantly (single-flight) and NEVER throws;
        // if it can't come up, the loop below fails-soft (rows stay pending) exactly as before.
        // ⚠️ NOT `true` (§3.10c). These used to default to ready, so an unapproved/unresolved
        // model still ran the classifier. Ready now MEANS an approved model is installed.
        let modelReady = false;
        let enrichReady = false;
        // ⚠️ THE SECOND SILENT PATH. daemon.ensureUp() auto-INSTALLS the Ollama runtime
        // (ollama-daemon.js autoInstall = true) — a download of its own, before the model
        // pull is even considered. So the consent gate must sit ABOVE the wake, not just at
        // the pull: approving labeling approves BOTH; declining fetches NEITHER.
        if (daemon && (labelM || enrichM)) {
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
    labelerHealth,        // → getLabelerHealth(), the readiness `models.labeler` slice
    enricherHealth,       // → getEnricherHealth(), the readiness `models.enricher` slice
    nudge: () => cycle(), // returns the cycle promise (callers may ignore it; the gate awaits it)
    stop: () => { if (timer) clearInterval(timer); timer = null; if (_current === handle) _current = null; },
    // LIVENESS, for the activity feed. The UI used to render "Embedding messages" purely
    // from `pending > 0` — so a drainer that had been dead for a MONTH still looked busy
    // (it skipped silently every 15s because a single-threaded embed service blocked
    // /health). A progress indicator that can't distinguish "working" from "dead" is worse
    // than none: it hides the outage it exists to reveal.
    status: () => ({
      alive: true,
      running,                         // a cycle is IN FLIGHT right now — the opposite of stalled
      lastCycleAt: _lastCycleAt,       // start of the last cycle that RAN — embedding may have been skipped (see `health`/`skips`). 0 = never
      lastProgressAt: _lastProgressAt, // last time a message was actually embedded
      skips: _skips,                   // consecutive cycles skipped: embed service unhealthy
      // consecutive cycles whose embed block THREW. DISTINCT from `skips`: a skip is the health
      // gate declining to drain (the service looks unhealthy); this is the drain itself failing
      // on a service that looked FINE — a locked vault or a SQLITE_BUSY. It is exposed for the
      // same reason `skips` is: the guard that keeps a throw from silencing L1+L2 also keeps it
      // out of every surface that isn't stderr, so a permanently-locked vault read 'ok' from the
      // healths AND clean from status() while embedding was dead — the exact shape of the
      // month-long dormancy (independent review, 2026-07-16; the review also caught the comment
      // that called this counter "its own surface" while it was a private local).
      embedErrs: _embedErrs,
      health: _health,                 // ok | loading | error | unreachable
      // A model still LOADING is not a fault — it's a download. Only a real outage is.
      // ⚠️ `stalled` keys on _skips ALONE, deliberately unchanged: it drives the activity feed's
      // "embedding" indicator, and a throwing drain is already carried by `embedErrs` above.
      // Widening it here without tracing every consumer would be the fix-by-guess this file's
      // history warns about — recorded as the next unit's work, not smuggled into this one.
      stalled: _skips > 0 && _health !== 'loading',
      starting: _health === 'loading',
    }),
  };
  _current = handle; // expose to nudgeEnrichDrainer() for the portal trigger route
  return handle;
}

export default startEnrichDrainer;
