// verify:describe-coverage — the NEW describe-clusters behaviors (narration overhaul),
// proven with REAL child runs of pipeline/describe-clusters.js against a stub model:
//   C1 territory coverage written: explored_count + explored_percent after a run
//   C2 PROGRESSIVE: a >20-point territory re-narrates on the next run and coverage
//      strictly GROWS (seen-points accumulate); a fully-covered territory then skips
//   C3 realm explored_percent ROLLS UP from child territories (CASCADE)
//   C4 ALL-SOURCE: a document-only territory gets a real name (sampler reached it)
//   C5 territory_seen_points populated (the coverage ledger)
// PASS/FAIL ledger; VERDICT GO/NO-GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-describe-coverage.db', KCV = 'data/verify-describe-coverage-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const U = 'local-user';

// Stub model: native /api/chat, returns valid describe JSON (count irrelevant here).
const stub = createServer((req, res) => {
  req.on('data', () => {}); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: { content: '{"name":"Named Area","essence":"a stub essence"}' } }));
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const PORT = stub.address().port;

{ const d0 = new Database(DB); applyMigrations(d0); d0.close(); }
let { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const q = (sql, p = []) => db.rawQuery(sql, p).then((r) => r.results || r || []);

// Territory 1 (realm 0): 50 messages spread across years → needs multiple passes to cover.
for (let i = 0; i < 50; i++) {
  const ts = `20${18 + (i % 8)}-0${1 + (i % 9)}-10T10:00:00Z`;
  await q(`INSERT INTO messages (id, user_id, content, created_at) VALUES (?,?,?,?)`,
    [`m${i}`, U, `reflection number ${i} about the shape of the work`, ts]);
  await q(`INSERT INTO clustering_points (id, user_id, source_type, source_id, realm_id, territory_id, created_at) VALUES (?,?,?,?,?,?,?)`,
    [`cp-m${i}`, U, 'message', `m${i}`, 0, 1, ts]);
}
// Territory 2 (realm 0): DOCUMENT-only (no messages) → proves all-source sampling.
await q(`INSERT INTO documents (id, user_id, path, title, content, published, public_visit_count, created_at) VALUES (?,?,?,?,?,?,?,?)`,
  ['doc1', U, 'notes/doc1.md', 'Doc', 'a document-only territory about systems and forests', 0, 0, '2022-02-02T10:00:00Z']);
await q(`INSERT INTO clustering_points (id, user_id, source_type, source_id, realm_id, territory_id, created_at) VALUES (?,?,?,?,?,?,?)`,
  ['cp-doc1', U, 'document', 'doc1', 0, 2, '2022-02-02T10:00:00Z']);

const provId = await db.providers.create(U, { provider: 'custom', label: 'stub', authType: 'api_key', baseUrl: `http://127.0.0.1:${PORT}/v1` });
await db.providers.setActive(provId, U);
close();

const env = { ...process.env, USER_MASTER: userHex, SYSTEM_KEY: systemHex, MYCELIUM_DB: DB, MYCELIUM_USER_ID: U };
const runDescribe = () => new Promise((resolve) => {
  const child = spawn('node', ['pipeline/describe-clusters.js'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (d) => { stderr += d; });
  const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 120_000);
  child.on('close', (status) => { clearTimeout(t); resolve({ status, stderr }); });
  child.on('error', () => { clearTimeout(t); resolve({ status: -1, stderr }); });
});
const reopen = async () => { const b = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null }); db = b.db; close = b.close; };
const row = async (sql, p) => ((await db.rawQuery(sql, p)).results || [])[0];

// ── Run 1 ──
const r1 = await runDescribe();
await reopen();
const t1a = await row(`SELECT name, explored_count, explored_percent FROM territory_profiles WHERE user_id=? AND territory_id=1`, [U]);
const t2 = await row(`SELECT name FROM territory_profiles WHERE user_id=? AND territory_id=2`, [U]);
const seen1 = await row(`SELECT COUNT(*) c FROM territory_seen_points WHERE user_id=? AND territory_id=1`, [U]);
rec('C1. run1: territory coverage written (explored_count + explored_percent > 0)',
  r1.status === 0 && Number(t1a?.explored_count) > 0 && Number(t1a?.explored_percent) > 0,
  `exit=${r1.status} count=${t1a?.explored_count} pct=${t1a?.explored_percent}%`);
rec('C4. document-only territory got a real name (all-source sampling reached the model)',
  t2?.name === 'Named Area', `name=${t2?.name}`);
rec('C5. territory_seen_points populated (the coverage ledger)',
  Number(seen1?.c) > 0, `seen=${seen1?.c}`);
close();

// ── Run 2: coverage must GROW (more of the 50 points folded in) ──
const r2 = await runDescribe();
await reopen();
const t1b = await row(`SELECT explored_count, explored_percent FROM territory_profiles WHERE user_id=? AND territory_id=1`, [U]);
rec('C2. progressive: run2 re-narrates the under-covered territory; coverage strictly grows',
  r2.status === 0 && Number(t1b?.explored_count) > Number(t1a?.explored_count) && Number(t1b?.explored_percent) > Number(t1a?.explored_percent),
  `run1=${t1a?.explored_count}(${t1a?.explored_percent}%) → run2=${t1b?.explored_count}(${t1b?.explored_percent}%)`);
const realm0 = await row(`SELECT explored_percent FROM realms WHERE user_id=? AND realm_id=0`, [U]);
rec('C3. realm explored_percent rolls up from child territories (CASCADE)',
  Number(realm0?.explored_percent) > 0, `realm0 explored=${realm0?.explored_percent}%`);
close();

stub.close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — describe coverage: %-described written, progressive growth, all-source, realm roll-up' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
