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
import { createEnrichmentService } from './service.js';
import { createCategoryClassifier } from './categories.js';

// The live drainer for the booted vault. Set by startEnrichDrainer so a portal
// route (POST /portal/enrichment/trigger) can kick a drain WITHOUT threading the
// drainer handle through buildVaultSubApp — the drainer is created deep in
// completeBoot. Single-user / single-vault, so one module-level handle is exact.
let _current = null;

/** Kick the live enrichment drainer if one is running (no-op otherwise). */
export function nudgeEnrichDrainer() { try { _current?.nudge(); } catch { /* best-effort */ } return Boolean(_current); }

export function startEnrichDrainer({
  db,
  userId,
  intervalMs = 15000,
  embed = createEmbedClient(),
  log = (m) => process.stderr.write(`${m}\n`),
  onSettled,
} = {}) {
  // Context Engine L1: per-message domain+register tagging via the on-box model (cheap,
  // private; format:'json' constrains the reply). The model is configurable in principle
  // (settings.models.enrichment) — a follow-on; default = local. A model outage leaves rows
  // pending (self-heals next cycle), never poisons a row.
  const classify = createCategoryClassifier({
    infer: (prompt) => localInfer({ prompt, format: 'json', maxTokens: 40, numCtx: 1024, think: false }),
  });
  const svc = createEnrichmentService({ messages: db.messages, embed, getMasterKey, classify });
  let running = false;
  let pending = false;
  let timer = null;

  async function embedHealthy() {
    try {
      const h = await embed.health(); // /health → { status, loaded, dim, … }
      return Boolean(h) && h.loaded !== false && (h.status ? h.status === 'ok' : true);
    } catch { return false; }
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
        await svc.enrichNlpOnce({ userId });     // advance embedded → enriched
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
      let tagged = 0;
      for (let i = 0; i < 8; i++) {
        const c = await svc.enrichCategoriesOnce({ userId });
        tagged += c?.enriched ?? 0;
        if ((c?.scanned ?? 0) === 0 || (c?.failed ?? 0) > 0) break;
      }
      if (tagged > 0) log(`[enrich] tagged ${tagged} message(s) with domain/register`);
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
    nudge: () => { cycle(); },
    stop: () => { if (timer) clearInterval(timer); timer = null; if (_current === handle) _current = null; },
  };
  _current = handle; // expose to nudgeEnrichDrainer() for the portal trigger route
  return handle;
}

export default startEnrichDrainer;
