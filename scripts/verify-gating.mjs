// verify:gating — Context Bank Phase 4. Boots the real MCP server on a FRESH
// vault and asserts cold-start gating: every Tier-2 reader returns the uniform
// "topology not ready" message (not honest-empty), the Tier-1 surface is
// untouched, and seeding a clustered point flips readiness MID-SESSION (no
// restart) so the same tool runs its real path. PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { TIER2_TOOLS, TOPOLOGY_NOT_READY_MESSAGE } from '../src/mcp.js';

const DB = 'data/verify-gating.db', KCV = 'data/verify-gating-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close, handlers } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const NR = TOPOLOGY_NOT_READY_MESSAGE;

// ── G1: every Tier-2 tool gated on a fresh vault (uniform not-ready message) ──
const gatedNames = [...TIER2_TOOLS];
const results = {};
for (const name of gatedNames) results[name] = await handlers[name]({});
const allGated = gatedNames.every((n) => results[n] === NR);
rec(`G1. all ${gatedNames.length} Tier-2 tools return the uniform not-ready message on a fresh vault`,
  allGated, allGated ? gatedNames.join(', ') : gatedNames.filter((n) => results[n] !== NR).map((n) => `${n}→${String(results[n]).slice(0, 40)}`).join(' | '));

rec('G2. the not-ready message is actionable (mentions import + a working alternative)',
  /import/i.test(NR) && /getContext|searchMindscape/.test(NR), NR.slice(0, 80) + '…');

// ── G3: Tier-1 tools are NOT gated (work on a fresh vault) ──
const ctx = await handlers.getContext({});
rec('G3. getContext (Tier-1) is NOT gated — returns a real briefing', typeof ctx === 'string' && ctx.includes('Current time') && ctx !== NR, `len=${ctx.length}`);
const search = await handlers.searchMindscape({ query: 'anything' });
rec('G4. searchMindscape (Tier-1) is NOT gated', search !== NR && /No results|##/.test(search), String(search).slice(0, 50));
await handlers.remember({ category: 'identity', key: 'name', value: 'Test' });
const factsCtx = await handlers.getContext({ include: ['facts'] });
rec('G5. remember + facts surface (Tier-1) work pre-clustering', factsCtx.includes('identity/name'), `hasFact=${factsCtx.includes('identity/name')}`);

// ── G6: seeding a clustered point flips readiness MID-SESSION (no restart) ──
const beforeFlip = await handlers.mindscape({});
rec('G6. mindscape is gated BEFORE clustering', beforeFlip === NR, beforeFlip === NR ? 'not-ready' : String(beforeFlip).slice(0, 40));
await db.rawQuery(
  `INSERT INTO clustering_points (id, user_id, source_type, source_id, content, landscape_x, landscape_y) VALUES (?,?,?,?,?,?,?)`,
  ['cp1', U, 'message', 'seed', 'x', 0.1, 0.2],
);
const afterFlip = await handlers.mindscape({});
rec('G7. SAME tool runs its real path AFTER clustering lands (mid-session flip, no restart)', afterFlip !== NR && typeof afterFlip === 'string', `now → "${String(afterFlip).slice(0, 60).replace(/\n/g, ' ')}…"`);

// ── G8: readiness stays flipped (cache) — another Tier-2 tool now ungated too ──
const state = await handlers.cognitiveState({});
rec('G8. readiness is sticky — cognitiveState also ungated now', state !== NR, `not-ready=${state === NR}`);

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — cold-start gating: Tier-2 not-ready on fresh vault, Tier-1 untouched, mid-session flip on clustering' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
