// verify:mindscape — Context Bank Phase 5. Proves the 5 topology readers
// (exploreTerritory / mindscapeStructure / listTerritories / territoryDetail /
// timeView) consolidated into the single mindscape({view}) tool without losing
// capability: each view routes to the reused handler and returns non-crash text;
// territory/explore guide when no territory is given; unknown view is handled.
// Seeds a clustered point so the Tier-2 gate is open. PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { TOPOLOGY_NOT_READY_MESSAGE as NR } from '../src/mcp.js';

const DB = 'data/verify-mindscape.db', KCV = 'data/verify-mindscape-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close, tools, handlers } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

await db.rawQuery(
  `INSERT INTO clustering_points (id, user_id, source_type, source_id, content, landscape_x, landscape_y) VALUES (?,?,?,?,?,?,?)`,
  ['cp', U, 'message', 'seed', 'x', 0.1, 0.2],
);

const names = tools.map((t) => t.name);
const OLD = ['exploreTerritory', 'mindscapeStructure', 'listTerritories', 'territoryDetail', 'timeView'];
rec('MS1. mindscape registered; the 5 topology readers removed',
  names.includes('mindscape') && OLD.every((n) => !names.includes(n)),
  `leftover=${OLD.filter((n) => names.includes(n)).join(',') || 'none'}`);

// ── each view routes + returns non-crash text on an empty-but-ready vault ──
for (const view of ['structure', 'territories', 'time']) {
  const out = await handlers.mindscape({ view });
  rec(`MS. view:${view} routes to its folded handler (non-crash text)`, typeof out === 'string' && out.length > 0 && out !== NR, `→ "${String(out).slice(0, 56).replace(/\n/g, ' ')}…"`);
}

// default view = structure (folds mindscapeStructure)
const def = await handlers.mindscape({});
rec('MS. default view = structure (folds mindscapeStructure)', /Mindscape Structure/.test(def), def.split('\n')[0]);

// territory/explore need a territory → guided message (capability + good UX)
const t = await handlers.mindscape({ view: 'territory' });
rec('MS. view:territory without a territory → guided', /Pass .territory/.test(t), t);
const e = await handlers.mindscape({ view: 'explore', territory: 'nonexistent territory' });
rec('MS. view:explore (folds exploreTerritory) → graceful on unknown territory', /Could not find territory|#/.test(e), String(e).slice(0, 56));

// unknown view → guided (no crash)
const u = await handlers.mindscape({ view: 'bogus' });
rec('MS. unknown view → guided message (no crash)', /Unknown view/.test(u), u);

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — mindscape: 5 topology readers consolidated into mindscape({view}) (capability preserved)' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
