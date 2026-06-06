// scripts/demo-claims.mjs — Tier-3 end-to-end demo of the Persona-Claims pipe
// against a REAL local model. Seeds a fresh, throwaway-keyed vault with a coherent
// "person" across several days, then runs the actual router → discoverWindow →
// store chain and prints the discovered claims + their snapshots.
//
// NOT a verify gate — a hands-on Tier-3 check that the prompts produce good
// claims with a live Ollama model (per docs/PERSONA-CLAIMS-HANDOFF-2026-06-06.md).
//
//   USER_MASTER/SYSTEM_KEY are generated here (throwaway vault, protects nothing
//   real). Requires `ollama serve` + a pulled model. Run: node scripts/demo-claims.mjs
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createInferenceRouter } from '../src/inference/router.js';
import { resolveInferenceConfig } from '../src/inference/resolve.js';
import { createValidator } from '../src/claims/validator.js';
import { runDiscovery } from '../pipeline/discover-claims.mjs';
import { previousCompleteWindow } from '../src/claims/windows.js';
import { toConfidence } from '../src/claims/confidence.js';
import { createEmbedClient } from '../src/embed/client.js';

const DB = 'data/claims-demo.db', KCV = 'data/claims-demo-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';

// A coherent person, expressed over the last ~10 days so day/week/month windows
// all carry evidence: outdoor-social values, a hard food-allergy boundary, a
// hands-on learning preference, a long-commute aversion.
const NOW = Date.now();
const dayWin = previousCompleteWindow(NOW, 'day');     // yesterday
const weekWin = previousCompleteWindow(NOW, 'week');   // last complete week
const at = (winStart, hoursIn) => new Date(Date.parse(winStart) + hoursIn * 3600 * 1000).toISOString();

const SEED = [
  // yesterday (day cadence)
  [at(dayWin.windowStart, 9),  'Went on a long trail hike with friends this morning — felt completely recharged afterward.'],
  [at(dayWin.windowStart, 13), 'Grabbed lunch out and double-checked everything for peanuts; my allergy means I always have to ask.'],
  [at(dayWin.windowStart, 18), 'Skipped a loud indoor house party tonight to go for an evening bike ride instead. Much happier outside.'],
  [at(dayWin.windowStart, 20), 'Signed up for a hands-on woodworking workshop — I learn so much better by doing than by sitting in a lecture.'],
  // last complete week
  [at(weekWin.windowStart, 10), 'Cycled along the coast for two hours. Endurance cycling is honestly my main form of exercise now.'],
  [at(weekWin.windowStart, 30), 'Turned down a webinar in favor of a live Q&A workshop — I want to actually talk to people and try things.'],
  [at(weekWin.windowStart, 55), 'Had to send back a dish at dinner when I found out it had peanut oil. Restaurants make me nervous.'],
  [at(weekWin.windowStart, 80), 'A one-hour car commute left me drained and irritable. I really want to avoid long commutes going forward.'],
  [at(weekWin.windowStart, 100), 'Spent Saturday volunteering outdoors at a community garden with friends. Being outside with people is my happy place.'],
];

for (let i = 0; i < SEED.length; i++) {
  await db.rawQuery(
    `INSERT INTO messages (id, user_id, role, content, created_at) VALUES (?,?,?,?,?)`,
    [`seed-${i}`, U, 'user', SEED[i][1], SEED[i][0]]);
}
console.log(`Seeded ${SEED.length} messages for ${U}.`);
console.log(`Windows → day ${dayWin.windowStart.slice(0,10)}..${dayWin.windowEnd.slice(0,10)} · week ${weekWin.windowStart.slice(0,10)}..${weekWin.windowEnd.slice(0,10)}\n`);

// Build the REAL router (local Ollama via the §4g local-first path). sensitive:true
// inside discovery/validator keeps every call on-box.
const router = createInferenceRouter(await resolveInferenceConfig(db, U));
const { validate } = createValidator({ infer: router.infer });

// Semantic claim-matching via the embed service (:8091) if it's up — this is
// what merges paraphrased day/week claims into one row. Falls back to lexical.
const embedClient = createEmbedClient();
let embed;
try { await embedClient.health(); embed = (texts) => embedClient.embedBatch(texts, 'query'); console.log('Embed service up → semantic claim-matching ON.\n'); }
catch { console.log('Embed service down → lexical claim-matching (fallback).\n'); }

console.log('Running discovery (day + week) against the live model…\n');
const summary = await runDiscovery({
  db, userId: U, infer: router.infer, validate, embed,
  cadences: ['day', 'week'], log: (m) => console.log('  ' + m),
});
console.log('\nSummary:', JSON.stringify(summary));

const claims = await db.claims.listActive(U, { limit: 50 });
console.log(`\n=== ${claims.length} CLAIMS DISCOVERED ===\n`);
for (const c of claims) {
  const conf = c.confidenceLogodds == null ? '?' : toConfidence(c.confidenceLogodds).toFixed(2);
  const series = await db.claims.readSeries(U, c.id, 'day');
  const weekSeries = await db.claims.readSeries(U, c.id, 'week');
  const windows = [...series, ...weekSeries].map((s) => `${s.granularity}:${s.deltaKind}`).join(', ');
  console.log(`• [${c.claimType}] ${c.content}`);
  console.log(`    confidence ${conf} · support ${c.support?.messages?.length ?? 0} msg · windows: ${windows}\n`);
}

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
console.log('(throwaway vault cleaned up)');
