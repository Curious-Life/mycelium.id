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
import { createEnrichmentService } from './service.js';

export function startEnrichDrainer({
  db,
  userId,
  intervalMs = 15000,
  embed = createEmbedClient(),
  log = (m) => process.stderr.write(`${m}\n`),
} = {}) {
  const svc = createEnrichmentService({ messages: db.messages, embed, getMasterKey });
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

  return {
    nudge: () => { cycle(); },
    stop: () => { if (timer) clearInterval(timer); timer = null; },
  };
}

export default startEnrichDrainer;
