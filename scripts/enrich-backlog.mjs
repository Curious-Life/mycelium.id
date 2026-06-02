// scripts/enrich-backlog.mjs — phased enrichment drain for a bulk import.
//
// Sequences the two enrichment stages GLOBALLY (not interleaved per batch):
//   Phase 1 — embeddings: drainOnce() over the whole backlog (batched /embed)
//   Phase 2 — NLP:        enrichNlpOnce() over the whole backlog
//
// Rationale: embeddings are what mind-search + the mindscape clustering consume,
// so they must complete first; the NLP rules pass (entities/tags/summary) is
// independent and runs after. Idempotent + resumable — re-run to finish a
// partially-drained backlog (it only ever scans rows still pending each stage).
//
// Usage:  MYCELIUM_KEY_SOURCE=keychain node scripts/enrich-backlog.mjs
// Env:    MYCELIUM_USER_ID (default 'local-user'), MYCELIUM_ENRICH_BATCH (64)
import { boot } from '../src/index.js';
import { createEmbedClient } from '../src/embed/client.js';
import { getMasterKey } from '../src/crypto/crypto-local.js';
import { createEnrichmentService } from '../src/enrich/service.js';

const userId = process.env.MYCELIUM_USER_ID || 'local-user';
const BATCH = Number(process.env.MYCELIUM_ENRICH_BATCH) || 64;

const { db, close } = await boot({});
const embed = createEmbedClient({});
const svc = createEnrichmentService({ messages: db.messages, embed, getMasterKey });

// ── Phase 1: embeddings ─────────────────────────────────────────────────────
const t0 = Date.now();
let embedded = 0;
for (let round = 1; ; round++) {
  const r = await svc.drainOnce({ userId, batchSize: BATCH });
  embedded += r.embedded;
  if (round % 10 === 0 || r.scanned === 0) {
    const s = Math.max(1, Math.round((Date.now() - t0) / 1000));
    console.log(`[embed] round ${round}: +${r.embedded} (failed ${r.failed}) | total ${embedded} | ${s}s | ${(embedded / s).toFixed(1)}/s`);
  }
  if (r.scanned === 0) break;
  if (r.embedded === 0 && r.failed === r.scanned) { console.log('[embed] every row in the batch failed — aborting (is the embed service up?)'); break; }
}
console.log(`[embed] PHASE COMPLETE: ${embedded} embedded in ${Math.round((Date.now() - t0) / 1000)}s`);

// ── Phase 2: NLP rules pass ─────────────────────────────────────────────────
const t1 = Date.now();
let enriched = 0;
for (let round = 1; ; round++) {
  const r = await svc.enrichNlpOnce({ userId, batchSize: BATCH });
  enriched += r.enriched;
  if (round % 10 === 0 || r.scanned === 0) {
    console.log(`[nlp] round ${round}: +${r.enriched} (failed ${r.failed}) | total ${enriched} | ${Math.round((Date.now() - t1) / 1000)}s`);
  }
  if (r.scanned === 0) break;
}
console.log(`[nlp] PHASE COMPLETE: ${enriched} enriched in ${Math.round((Date.now() - t1) / 1000)}s`);

close();
console.log('enrich-backlog: done.');
