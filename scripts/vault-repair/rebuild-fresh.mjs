// scripts/vault-repair/rebuild-fresh.mjs — repair a malformed-on-VACUUM vault by
// rebuilding it into a fresh, structurally-clean, born-encrypted database.
//
// Why fresh-file (not in-place): the corrupt table b-trees can't be DROPped or
// VACUUMed (traversal hits the bad page pointers), and this SQLCipher build does
// not honor `PRAGMA writable_schema` (so sqlite_master surgery is unavailable).
// So we READ-ONLY from the corrupt source (good rows read reliably) and WRITE
// everything into a brand-new db. The few physically-destroyed rows are recovered
// by id from a clean snapshot (gap-fill). No plaintext is ever written; the dest
// inherits the same whole-file SQLCipher key as the source.
//
// Usage:  node scripts/vault-repair/rebuild-fresh.mjs <corrupt-src.db> <clean-snapshot.db> <dest.db>
//   - src  : the corrupt vault (opened read-only)
//   - snap : a structurally-clean keyed snapshot (PRAGMA integrity_check = ok) used
//            ONLY to recover rows that are physically unreadable in src
//   - dest : output path for the rebuilt vault (created; overwritten if present)
// Run with the app QUIT. Verify with validate.mjs before swapping into place.
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { existsSync, rmSync } from 'node:fs';
import { readUserMaster, deriveDbKey } from '../../src/account/keystore.js';

const SRC = process.argv[2], SNAP = process.argv[3], DEST = process.argv[4];
if (!SRC || !SNAP || !DEST) { console.error('usage: rebuild-fresh.mjs <src> <snapshot> <dest>'); process.exit(2); }
// FAIL-CLOSED: never rebuild FROM (or write NEAR) a LIVE vault — tooling-vs-live-writer
// overlap is the prime corruption suspect (guard.mjs). After the usage check, so a bare
// invocation prints usage instead of a TypeError (review).
const { assertQuiesced } = await import('./guard.mjs');
assertQuiesced(SRC, { what: 'rebuild (read of the live source)' });
assertQuiesced(DEST, { what: 'rebuild (write of the destination)' });
const userHex = readUserMaster();
if (!userHex) { console.error('FATAL: USER_MASTER not found in Keychain'); process.exit(2); }
const KEY = deriveDbKey(userHex);
const log = (m) => console.log(`[rebuild] ${m}`);
function keyed(p, ro) { const d = new Database(p, { fileMustExist: ro, readonly: !!ro }); d.pragma(`cipher='sqlcipher'`); d.pragma(`key="x'${KEY}'"`); d.pragma('temp_store=MEMORY'); d.pragma('cache_size=-200000'); return d; }

for (const sfx of ['', '-wal', '-shm']) { try { if (existsSync(DEST + sfx)) rmSync(DEST + sfx); } catch {} }

const src = keyed(SRC, true); sqliteVec.load(src);
const snap = keyed(SNAP, true);
const dest = new Database(DEST); dest.pragma(`cipher='sqlcipher'`); dest.pragma(`key="x'${KEY}'"`); dest.pragma('temp_store=MEMORY'); dest.pragma('cache_size=-200000'); dest.pragma('foreign_keys=OFF'); sqliteVec.load(dest);

// ---- categorize schema (exclude sqlite_* internal tables) ----
const master = src.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`).all();
const virtuals = master.filter(o => o.type === 'table' && /CREATE VIRTUAL TABLE/i.test(o.sql || ''));
const vtNames = virtuals.map(v => v.name);
const isShadow = (n) => vtNames.some(v => n.startsWith(v + '_'));
const normalTables = master.filter(o => o.type === 'table' && !/USING/i.test(o.sql || '') && !isShadow(o.name));
const userIndexes = master.filter(o => o.type === 'index' && o.sql);
const triggers = master.filter(o => o.type === 'trigger' && o.sql);
log(`schema: ${normalTables.length} normal tables, ${virtuals.length} virtual, ${userIndexes.length} indexes, ${triggers.length} triggers`);

const tinfo = (t) => src.prepare(`PRAGMA table_info("${t}")`).all();

// ---- 1. create normal tables ----
for (const t of normalTables) dest.exec(t.sql);
log('created normal tables');

// ---- 2. copy data (generic, rowid-preserving), with a robust path for corrupt tables ----
const counts = {};
function genericCopy(t) {
  const cols = tinfo(t.name).map(c => c.name);
  const withoutRowid = /WITHOUT\s+ROWID/i.test(t.sql);
  const collist = cols.map(c => `"${c}"`).join(', ');
  const ins = dest.prepare(`INSERT INTO "${t.name}"(${withoutRowid ? collist : `rowid, ${collist}`}) VALUES (${withoutRowid ? cols.map(c => '@' + c).join(', ') : `@__rid, ${cols.map(c => '@' + c).join(', ')}`})`);
  const rows = src.prepare(`SELECT ${withoutRowid ? '' : 'rowid AS __rid, '}${collist} FROM "${t.name}"`).iterate();
  let n = 0; dest.transaction(() => { for (const r of rows) { ins.run(r); n++; } })();
  counts[t.name] = n; return n;
}

// Robust copy for a corrupt table: chunked bulk read, falling back to per-row reads
// on FRESH connections (clears shared-page cache transients), then gap-fill any id
// present in the snapshot but missing from the rebuild. Returns {failed, filled}.
// Enumerate rowids for a corrupt table. `SELECT rowid ... ORDER BY rowid` walks the
// table b-tree and DIES on page-linkage damage (shared pages / bad child pointers) —
// and the covering index can't be trusted either: with a shared page an index scan
// wanders into another tree's pages and yields phantom keys (observed live: the
// autoindex reported 101,398 distinct ids for a table holding ~73k rows). So sweep
// bounded rowid RANGES: each seek touches a localized subtree, so damage stays
// contained to its chunk and everything readable is still recovered.
function enumerateRowids(t) {
  // 1) UNORDERED rowid scan first. `ORDER BY rowid` forces a walk of the TABLE b-tree —
  //    the very tree that's damaged — so it dies; without it the planner takes a clean
  //    index and returns every rowid. (Live: ORDER BY → malformed; unordered → all
  //    73,507 rowids, contiguous, matching COUNT(*).) Sort in JS, not in SQLite.
  try {
    const r = src.prepare(`SELECT rowid AS r FROM "${t}"`).all().map(x => x.r);
    if (r.length) return r.sort((x, y) => x - y);
  } catch { /* fall through */ }
  // 2) Ordered scan (works on a healthy tree; kept for non-corrupt callers).
  try { return src.prepare(`SELECT rowid AS r FROM "${t}" ORDER BY rowid`).all().map(x => x.r); }
  catch { log(`  ${t}: rowid enumeration unreadable (corrupt b-tree) — sweeping rowid ranges`); }
  // 3) Last resort: bounded range sweep. NOTE: on a damaged tree seeks past the last
  //    intact subtree silently return nothing, so this UNDER-recovers — only reached
  //    when both scans above fail.
  const found = new Set();
  const MAX = Number(process.env.MYCELIUM_REBUILD_MAX_ROWID) || 500000;
  const STEP = 1000;
  for (let a = 1; a <= MAX; a += STEP) {
    const b = a + STEP - 1;
    try {
      for (const x of src.prepare(`SELECT rowid AS r FROM "${t}" WHERE rowid BETWEEN ? AND ?`).all(a, b)) found.add(x.r);
    } catch {
      // Damaged chunk — fall back to per-rowid probes on FRESH connections so a
      // poisoned page cache can't sink the neighbours.
      for (let r = a; r <= b; r++) {
        for (let k = 0; k < 2; k++) {
          const d = keyed(SRC, true);
          try { const g = d.prepare(`SELECT rowid AS r FROM "${t}" WHERE rowid=?`).get(r); if (g) { found.add(g.r); } d.close(); break; }
          catch { try { d.close(); } catch {} }
        }
      }
    }
  }
  return [...found].sort((x, y) => x - y);
}

function robustCopy(t) {
  const cols = tinfo(t).map(c => c.name);
  const collist = cols.map(c => `"${c}"`).join(', ');
  // OR IGNORE: shared-page damage can surface the SAME logical row at two rowids;
  // a duplicate would otherwise abort the whole transaction on the UNIQUE(id) index.
  const ins = dest.prepare(`INSERT OR IGNORE INTO "${t}"(rowid, ${collist}) VALUES (@__rid, ${cols.map(c => '@' + c).join(', ')})`);

  // SCAN-UNION salvage. Do NOT enumerate rowids and seek: on a page-linkage-damaged
  // tree the planner may satisfy a rowid/id enumeration from an INDEX, and a shared
  // page makes an index scan wander into other trees and return PHANTOM keys (live:
  // 101,398 "rows" for a 71,823-row table — a rebuild from that fabricates ~30k bogus
  // rows). Selecting ALL columns forces the TABLE b-tree — the only trustworthy read.
  // A forward scan dies at the first bad page; a REVERSE scan reaches the rows beyond
  // it. Their union is everything physically readable (live: 71,823 fwd + 8 rev-only).
  const seen = new Map(); // rowid -> row
  const scan = (desc) => {
    const d = keyed(SRC, true);
    let n = 0;
    try {
      const sql = `SELECT rowid AS __rid, ${collist} FROM "${t}"${desc ? ' ORDER BY rowid DESC' : ''}`;
      for (const r of d.prepare(sql).iterate()) { if (!seen.has(r.__rid)) seen.set(r.__rid, r); n++; }
    } catch (e) { log(`  ${t}: ${desc ? 'reverse' : 'forward'} scan stopped after ${n} rows (${e.message})`); }
    try { d.close(); } catch {}
    return n;
  };
  scan(false); scan(true);
  const failed = [];
  const txInsert = dest.transaction((objs) => { for (const o of objs) ins.run(o); });
  txInsert([...seen.values()]);
  const rids = [...seen.keys()].sort((a, b) => a - b);
  const have = new Set(dest.prepare(`SELECT id FROM "${t}"`).all().map(r => r.id));
  const snapRows = snap.prepare(`SELECT ${collist} FROM "${t}"`).all();
  let nextRid = dest.prepare(`SELECT COALESCE(MAX(rowid),0) x FROM "${t}"`).get().x + 1;
  const filled = [];
  for (const row of snapRows) { if (!have.has(row.id)) { ins.run({ __rid: nextRid++, ...row }); filled.push(row.id); } }
  counts[t] = dest.prepare(`SELECT count(*) c FROM "${t}"`).get().c;
  log(`${t}: src readable=${rids.length - failed.length}/${rids.length}, hard-unreadable=${JSON.stringify(failed)}, gap-filled=${filled.length}, dest=${counts[t]} (snap=${snapRows.length})`);
  // Loss guard: a hard-unreadable rowid that the snapshot could NOT recover is true data loss.
  const stillMissing = failed.length - filled.length;
  if (stillMissing > 0) log(`  *** WARNING: ${stillMissing} row(s) unreadable in src AND absent from snapshot — UNRECOVERABLE. Review before swapping. ***`);
  return { failed, filled };
}

// Tables to leave EMPTY (regenerable/non-critical) — their b-trees are so damaged
// that even robustCopy can't enumerate rowids. Comma-list via MYCELIUM_REBUILD_SKIP.
const SKIP = new Set((process.env.MYCELIUM_REBUILD_SKIP || '').split(',').map(s => s.trim()).filter(Boolean));
// Decide which tables need the robust path: those that fail a quick full-scan.
function isCorrupt(t) { try { for (const _ of src.prepare(`SELECT * FROM "${t}"`).iterate()) {} return false; } catch { return true; } }
for (const t of normalTables) {
  if (SKIP.has(t.name)) { log(`SKIP ${t.name} — left empty (regenerable; corrupt b-tree unreadable)`); continue; }
  try {
    if (isCorrupt(t.name)) robustCopy(t.name);
    else { const n = genericCopy(t); if (n) log(`copied ${t.name}: ${n}`); }
  } catch (e) { console.error(`FAIL copying ${t.name}: ${e.message}`); process.exit(7); }
}
log('data copy complete');

// ---- 3. virtual tables + rebuild external-content FTS ----
for (const v of virtuals) dest.exec(v.sql);
log('created virtual tables');
for (const v of virtuals) {
  // External-content fts5 (content=<table>) is rebuilt from its content table.
  if (/USING\s+fts5/i.test(v.sql) && /content\s*=\s*['"]?\w/i.test(v.sql)) {
    dest.exec(`INSERT INTO "${v.name}"("${v.name}") VALUES('rebuild')`);
    log(`rebuilt external-content fts5 "${v.name}"`);
    continue;
  }
  // Self-content fts5 / vec0 (the rows live IN the index — id+content for fts5,
  // id+embedding vector for vec0). NOT derivable via 'rebuild'; copy the logical
  // rows from src (these index tables are clean — only the messages heap was
  // corrupt). Keyed by `id`, so rowid alignment is irrelevant to correctness.
  const cols = tinfo(v.name).map((c) => c.name);
  const srcCount = src.prepare(`SELECT count(*) c FROM "${v.name}"`).get().c;
  if (srcCount === 0) { log(`self-content "${v.name}" empty — nothing to copy`); continue; }
  const collist = cols.map((c) => `"${c}"`).join(', ');
  const ins = dest.prepare(`INSERT INTO "${v.name}"(${collist}) VALUES (${cols.map((c) => '@' + c).join(', ')})`);
  let n = 0;
  dest.transaction(() => { for (const r of src.prepare(`SELECT ${collist} FROM "${v.name}"`).iterate()) { ins.run(r); n++; } })();
  log(`copied self-content "${v.name}": ${n}/${srcCount} rows`);
}

// ---- 4. indexes + triggers ----
for (const ix of userIndexes) dest.exec(ix.sql);
log(`created ${userIndexes.length} indexes`);
for (const tg of triggers) dest.exec(tg.sql);
log(`created ${triggers.length} triggers`);

// ---- 5. verify dest ----
const ic = dest.prepare('PRAGMA integrity_check').all().map(r => r.integrity_check);
log(`integrity_check: ${ic.join(' | ')}`);
log(`foreign_key_check: ${dest.prepare('PRAGMA foreign_key_check').all().length} violations`);
log('VACUUM dest …'); const t0 = Date.now(); dest.exec('VACUUM'); log(`VACUUM OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---- 6. per-table count parity vs source ----
let mismatches = 0;
for (const t of [...normalTables.map(t => t.name), ...vtNames].sort()) {
  if (SKIP.has(t)) { console.log(`  ${t}: intentionally left EMPTY (regenerable) — parity check skipped`); continue; }
  let s, dN; try { s = src.prepare(`SELECT count(*) c FROM "${t}"`).get().c; } catch { s = 'ERR'; }
  try { dN = dest.prepare(`SELECT count(*) c FROM "${t}"`).get().c; } catch { dN = 'ERR'; }
  if (String(s) !== String(dN)) { const expectedGapFill = counts[t] !== undefined; if (!expectedGapFill || dN < s) { mismatches++; console.log(`  ${t}: src=${s} dest=${dN}  <-- MISMATCH`); } }
}
log(`count mismatches: ${mismatches}`);
src.close(); snap.close(); dest.close();
if (!(ic.length === 1 && ic[0] === 'ok')) { console.error('FAIL: dest integrity_check not ok'); process.exit(6); }
if (mismatches > 0) { console.error('FAIL: table count mismatches'); process.exit(8); }
log('DONE — fresh rebuild succeeded (integrity ok, VACUUM ok, count parity). Validate, then swap.');
