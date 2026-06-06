#!/usr/bin/env node
/**
 * Persona-Claims discovery worker (PersonaTree lifecycle). For each cadence
 * (day / week / month / quarter — or a single one via --cadence), gathers the
 * decrypted messages in the last complete window and runs the claim lifecycle
 * (src/claims/discovery.js): propose → identity-match → validate → log-odds
 * update → snapshot. Clones describe-chronicles.js (vault open + router build +
 * egress audit). FAIL-SOFT / Tier-3: with no local model reachable, infer()
 * throws and discoverWindow returns a no-op — no claims, exit 0.
 *
 * PRIVACY: every model call is sensitive:true (router hard-blocks US-cloud
 * egress → on-box local). Never logs message content.
 *
 * Usage (heartbeat-spawned child, or a Generate stage):
 *   USER_MASTER=<hex> SYSTEM_KEY=<hex> MYCELIUM_DB=./data/vault.db \
 *     node pipeline/discover-claims.mjs [--cadence=day|week|month|quarter] [--dry-run]
 */
import { getDb } from '../src/db/index.js';
import { loadKey } from '../src/crypto/keys.js';
import { createInferenceRouter } from '../src/inference/router.js';
import { resolveInferenceConfig } from '../src/inference/resolve.js';
import { createEgressAuditSink } from '../src/inference/egress.js';
import { createValidator } from '../src/claims/validator.js';
import { discoverWindow } from '../src/claims/discovery.js';
import { CADENCES, previousCompleteWindow } from '../src/claims/windows.js';
import { createEmbedClient } from '../src/embed/client.js';

const EVIDENCE_CAP = Number(process.env.MYCELIUM_CLAIMS_EVIDENCE_CAP || 120);

/** Decrypted messages in [windowStart, windowEnd). content auto-decrypts. */
async function gatherEvidence(db, userId, windowStart, windowEnd, cap = EVIDENCE_CAP) {
  const r = await db.rawQuery(
    `SELECT id, content, created_at FROM messages
      WHERE user_id = ? AND created_at >= ? AND created_at < ? AND forgotten_at IS NULL
      ORDER BY created_at ASC LIMIT ?`,
    [userId, windowStart, windowEnd, cap],
  ).catch(() => ({ results: [] }));
  return (r.results || r || [])
    .filter((m) => m.content)
    .map((m) => ({ id: m.id, content: m.content, ts: m.created_at }));
}

/**
 * Run discovery across cadences. Injectable (db, infer, validate, now) so it is
 * unit/smoke-testable without a live model.
 * @returns {Promise<Record<string, {created:number, updated:number, skipped:number}>>}
 */
export async function runDiscovery({ db, userId, infer, validate, embed, now = () => Date.now(), cadences = CADENCES, log = () => {} }) {
  const summary = {};
  for (const cadence of cadences) {
    const w = previousCompleteWindow(now(), cadence);
    const evidence = await gatherEvidence(db, userId, w.windowStart, w.windowEnd);
    const res = await discoverWindow({ db, userId, infer, validate, embed, evidence, ...w, granularity: cadence });
    summary[cadence] = { created: res.created, updated: res.updated, skipped: res.skipped };
    log(`[claims] ${cadence} ${w.windowStart.slice(0, 10)}..${w.windowEnd.slice(0, 10)}: ${evidence.length} evidence → +${res.created} ~${res.updated} -${res.skipped}`);
  }
  return summary;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const arg = process.argv.find((a) => a.startsWith('--cadence='));
  const cadence = arg ? arg.split('=')[1] : null;
  const cadences = cadence ? [cadence] : CADENCES;
  const DRY_RUN = process.argv.includes('--dry-run');
  const USER_ID = process.env.MYCELIUM_USER_ID || 'local-user';
  const DB_PATH = process.env.MYCELIUM_DB || './data/vault.db';
  const USER_MASTER = process.env.USER_MASTER;
  const SYSTEM_KEY = process.env.SYSTEM_KEY;
  if (!USER_MASTER || !SYSTEM_KEY) { console.error('[claims] Missing USER_MASTER and SYSTEM_KEY'); process.exit(1); }

  const [userKey, systemKey] = await Promise.all([loadKey(USER_MASTER), loadKey(SYSTEM_KEY)]);
  const { db, close } = getDb({ dbPath: DB_PATH, userKey, systemKey, scope: 'personal' });
  const router = createInferenceRouter({
    ...(await resolveInferenceConfig(db, USER_ID)),
    onEgress: createEgressAuditSink(db, USER_ID),
  });
  // sensitive:true is enforced inside discovery/validator — claims never egress.
  const infer = router.infer;
  const { validate } = createValidator({ infer });
  // Semantic claim-matching embedder (:8091). Same task ('query') both sides;
  // if the service is down, discoverWindow falls back to lexical matching.
  const embedClient = createEmbedClient();
  const embed = (texts) => embedClient.embedBatch(texts, 'query');

  try {
    if (DRY_RUN) {
      for (const c of cadences) {
        const w = previousCompleteWindow(Date.now(), c);
        const ev = await gatherEvidence(db, USER_ID, w.windowStart, w.windowEnd);
        console.log(`[claims] (dry) ${c}: ${ev.length} evidence in ${w.windowStart.slice(0, 10)}..${w.windowEnd.slice(0, 10)}`);
      }
    } else {
      const summary = await runDiscovery({ db, userId: USER_ID, infer, validate, embed, cadences, log: console.error });
      const totals = Object.values(summary).reduce((a, s) => ({ created: a.created + s.created, updated: a.updated + s.updated }), { created: 0, updated: 0 });
      console.log(`[claims] done: +${totals.created} new, ~${totals.updated} updated across ${cadences.join('/')}`);
    }
  } catch (e) {
    console.error('[claims] non-fatal:', e.message); // never block the pipeline
  } finally {
    close();
  }
}
