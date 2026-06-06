// scripts/claims-live-demo.mjs — stand up the REAL app against a persistent
// throwaway vault pre-seeded with claims + weekly trajectories, so the portal
// Claims view can be live-rendered. Deterministic seed (no model needed for the
// visual check). Keeps running until killed. NOT a verify gate.
import crypto from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';
import { fromConfidence } from '../src/claims/confidence.js';

const DB = 'data/claims-live.db', KCV = 'data/claims-live-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
const raw = new Database(DB); applyMigrations(raw); raw.close();

const srv = await startRestServer({
  dbPath: DB, kcvPath: KCV,
  userHex: crypto.randomBytes(32).toString('hex'),
  systemHex: crypto.randomBytes(32).toString('hex'),
  port: 8799, host: '127.0.0.1', portalMode: 'canonical',
});
const db = srv.db, U = 'local-user';

// Weekly window_ends (Mondays), oldest → newest.
const WEEKS = ['2026-05-04', '2026-05-11', '2026-05-18', '2026-05-25', '2026-06-01'].map((d) => `${d}T00:00:00Z`);
// claim → [type, content, support, [confidence per week | null], [delta per week]]
const CLAIMS = [
  ['boundary', 'The user has a severe peanut allergy and avoids it strictly.', 4,
    [0.62, 0.70, null, 0.80, 0.86], ['new', 'strengthened', null, 'strengthened', 'strengthened']],
  ['value', 'The user values spending time outdoors with friends.', 5,
    [0.55, 0.64, 0.71, 0.74, 0.80], ['new', 'strengthened', 'strengthened', 'stable', 'strengthened']],
  ['principle', 'The user prefers hands-on, in-person learning over lectures.', 2,
    [null, 0.52, 0.58, 0.61, 0.66], [null, 'new', 'strengthened', 'stable', 'strengthened']],
  ['identity', 'The user identifies as an endurance cyclist.', 3,
    [0.60, 0.63, 0.66, 0.68, 0.70], ['new', 'stable', 'stable', 'stable', 'strengthened']],
  ['personality', 'The user is an introvert who prefers solitude.', 2,
    [0.58, 0.55, 0.44, 0.34, null], ['new', 'weakened', 'weakened', 'contradicted', null]],
];

for (let i = 0; i < CLAIMS.length; i++) {
  const [type, content, support, confs, deltas] = CLAIMS[i];
  const last = [...confs].reverse().find((c) => c != null) ?? 0.5;
  const id = `live-${i}`;
  await db.claims.upsert({
    id, userId: U, claimType: type, content, confidenceLogodds: fromConfidence(last),
    decayClass: type === 'boundary' ? 'boundary' : 'fact',
    support: { messages: Array.from({ length: support }, (_, k) => `m${i}-${k}`), territories: [] },
    contentHash: `h${i}`, status: 'active', lastEvidenceAt: WEEKS[WEEKS.length - 1],
  });
  for (let w = 0; w < WEEKS.length; w++) {
    if (confs[w] == null) continue;
    await db.claims.writeSnapshot({
      userId: U, claimId: id, windowStart: WEEKS[w], windowEnd: WEEKS[w], granularity: 'week',
      confidenceLogodds: fromConfidence(confs[w]), content, evidenceCount: support, deltaKind: deltas[w],
    });
  }
}

console.log(`\n  Claims live demo at ${srv.url}  (open /claims)\n  Seeded ${CLAIMS.length} claims with weekly trajectories. Ctrl-C to stop.\n`);
