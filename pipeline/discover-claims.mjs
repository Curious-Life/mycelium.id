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
import { discoverWindow, parseProposals } from '../src/claims/discovery.js';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { CADENCES, previousCompleteWindow } from '../src/claims/windows.js';
import { createEmbedClient } from '../src/embed/client.js';

const EVIDENCE_CAP = Number(process.env.MYCELIUM_CLAIMS_EVIDENCE_CAP || 120);

/** The user's OWN messages in [windowStart, windowEnd). content auto-decrypts.
 *  role='user' only — person-understanding profiles the VAULT OWNER, not the
 *  assistant's replies (else we'd form claims about "Claude", and technical
 *  assistant output would swamp the user's own voice). */
async function gatherEvidence(db, userId, windowStart, windowEnd, cap = EVIDENCE_CAP) {
  const r = await db.rawQuery(
    `SELECT id, content, created_at FROM messages
      WHERE user_id = ? AND role = 'user' AND created_at >= ? AND created_at < ? AND forgotten_at IS NULL
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
    const res = await discoverWindow({ db, userId, infer, validate, embed, evidence, ...w, granularity: cadence, log });
    summary[cadence] = { created: res.created, updated: res.updated, skipped: res.skipped };
    log(`[claims] ${cadence} ${w.windowStart.slice(0, 10)}..${w.windowEnd.slice(0, 10)}: ${evidence.length} evidence → +${res.created} ~${res.updated} -${res.skipped}`);
  }
  return summary;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const arg = process.argv.find((a) => a.startsWith('--cadence='));
  const cadence = arg ? arg.split('=')[1] : null;
  // Accept a comma list (`--cadence=week,month`) so ONE child runs all due
  // cadences sequentially — avoids concurrent children contending for the single
  // local Ollama instance (which serializes requests → 60s timeouts).
  const cadences = cadence ? cadence.split(',').map((s) => s.trim()).filter(Boolean) : CADENCES;
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
    // Discovery prompts are large and run on a local model; 60s (the router
    // default) is too short and silently zeroed every run. Give it room.
    timeoutMs: Number(process.env.MYCELIUM_CLAIMS_TIMEOUT_MS || 300000),
  });
  // Run log in the data dir — observable record of each discovery run (counts
  // only, never message content). Lets the UI surface "last run" + lets us
  // diagnose an empty run (parse vs match vs write vs error). Best-effort.
  const LOG = join(process.env.MYCELIUM_DATA_DIR || DB_PATH.replace(/[^/]+$/, ''), 'claims-discovery.log');
  const flog = (m) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch { /* best-effort */ } };

  // sensitive:true is enforced inside discovery/validator — claims never egress.
  // Wrap infer to log REPLY size + parse count (counts only) so an empty run is
  // diagnosable (parsed=0 → model/parse; parsed>0 but created=0 → match/write).
  const infer = async (req) => {
    const out = await router.infer(req);
    if (req.task === 'narrate') flog(`infer reply_chars=${String(out).length} parsed=${parseProposals(out).length}`);
    if (req.task === 'narrate' && process.env.MYCELIUM_CLAIMS_DEBUG_RAW) flog(`RAWHEAD<<<${String(out).slice(0, 900)}>>>`);
    return out;
  };
  const { validate } = createValidator({ infer: router.infer });
  // Semantic claim-matching embedder (:8091). Same task ('query') both sides;
  // if the service is down, discoverWindow falls back to lexical matching.
  const embedClient = createEmbedClient();
  let embedOk = false; try { await embedClient.health(); embedOk = true; } catch { /* lexical fallback */ }
  const embed = (texts) => embedClient.embedBatch(texts, 'query');

  flog(`run start: cadences=${cadences.join('/')} embed=${embedOk ? 'on' : 'OFF(lexical)'}`);
  try {
    if (DRY_RUN) {
      for (const c of cadences) {
        const w = previousCompleteWindow(Date.now(), c);
        const ev = await gatherEvidence(db, USER_ID, w.windowStart, w.windowEnd);
        console.log(`[claims] (dry) ${c}: ${ev.length} evidence in ${w.windowStart.slice(0, 10)}..${w.windowEnd.slice(0, 10)}`);
      }
    } else {
      const summary = await runDiscovery({ db, userId: USER_ID, infer, validate, embed, cadences, log: (m) => { console.error(m); flog(m); } });
      const totals = Object.values(summary).reduce((a, s) => ({ created: a.created + s.created, updated: a.updated + s.updated }), { created: 0, updated: 0 });
      flog(`run done: ${JSON.stringify(summary)}`);
      console.log(`[claims] done: +${totals.created} new, ~${totals.updated} updated across ${cadences.join('/')}`);
    }
  } catch (e) {
    flog(`run ERROR: ${e.message} | ${String(e.stack || '').split('\n').slice(0, 3).join(' ')}`);
    console.error('[claims] non-fatal:', e.message); // never block the pipeline
  } finally {
    close();
  }
}
