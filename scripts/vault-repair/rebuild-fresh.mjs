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
//
// Env knobs:
//   MYCELIUM_REBUILD_FORCE_ROBUST=<csv>  force named tables down the robust copy path,
//        even if a one-shot scan reads them clean (belt-and-suspenders — see below;
//        tables the source integrity_check flags corrupt are auto-forced already).
//   MYCELIUM_REBUILD_NO_AUTOROBUST=1     disable the integrity_check auto-derive (faster
//        boot on a huge vault when you'll name the corrupt tables explicitly instead).
//   MYCELIUM_REBUILD_SKIP=<csv>          leave named tables EMPTY (regenerable, b-tree
//        so damaged even robustCopy can't enumerate rowids).
//   MYCELIUM_REBUILD_MAX_ROWID=<n>       upper bound for the last-resort range sweep.
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { existsSync, rmSync } from 'node:fs';
import { readUserMaster, deriveDbKey } from '../../src/account/keystore.js';
import { robustScanIncomplete, parityVerdict } from './loss-guard.mjs';

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
// Per-table flag: robustCopy could NOT read the table in one clean directional pass, so an
// unread region may remain. Set by robustCopy's loss guard; consumed by the final count-parity
// gate so an unverifiable table fails the run even when a corrupt src can't be counted ('ERR').
const robustIncomplete = {};
function genericCopy(t) {
  const cols = tinfo(t.name).map(c => c.name);
  const withoutRowid = /WITHOUT\s+ROWID/i.test(t.sql);
  const collist = cols.map(c => `"${c}"`).join(', ');
  const ins = dest.prepare(`INSERT INTO "${t.name}"(${withoutRowid ? collist : `rowid, ${collist}`}) VALUES (${withoutRowid ? cols.map(c => '@' + c).join(', ') : `@__rid, ${cols.map(c => '@' + c).join(', ')}`})`);
  const rows = src.prepare(`SELECT ${withoutRowid ? '' : 'rowid AS __rid, '}${collist} FROM "${t.name}"`).iterate();
  let n = 0; dest.transaction(() => { for (const r of rows) { ins.run(r); n++; } })();
  counts[t.name] = n; return n;
}

// Robust copy for a corrupt table: forward+reverse scan-union on FRESH connections (clears
// shared-page cache transients), then gap-fill any id present in the snapshot but missing from
// the rebuild. Returns {incomplete, filled} — `incomplete` is true when neither directional
// scan reached EOF (a possible unread region), which the final parity gate treats as loss.
// Enumerate rowids for a corrupt table. `SELECT rowid ... ORDER BY rowid` walks the
// table b-tree and DIES on page-linkage damage (shared pages / bad child pointers) —
// and the covering index can't be trusted either: with a shared page an index scan
// wanders into another tree's pages and yields phantom keys (observed live: the
// autoindex reported 101,398 distinct ids for a table holding ~73k rows). So sweep
// bounded rowid RANGES: each seek touches a localized subtree, so damage stays
// contained to its chunk and everything readable is still recovered.
//
// ⚠️ CURRENTLY UNUSED (kept for reference/last-resort manual salvage). Do NOT wire this into the
// copy path or the loss guard: its index-satisfied enumeration can OVER-report phantom rowids on
// a shared-page-damaged tree, which is exactly why robustCopy uses a scan-union and the loss
// guard keys on scan-completeness instead. Feeding these rowids into a diff would false-abort a
// healthy rebuild.
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
  // Returns whether the scan reached EOF WITHOUT throwing — i.e. it walked the whole table
  // b-tree, so `seen` now holds every physically-present row. (A scan that stops on a bad page
  // returns false.) This is the trustworthy completeness signal the loss guard keys on.
  const scan = (desc) => {
    const d = keyed(SRC, true);
    let n = 0, complete = false;
    try {
      const sql = `SELECT rowid AS __rid, ${collist} FROM "${t}"${desc ? ' ORDER BY rowid DESC' : ''}`;
      for (const r of d.prepare(sql).iterate()) { if (!seen.has(r.__rid)) seen.set(r.__rid, r); n++; }
      complete = true; // reached EOF with no error → this direction read the entire table
    } catch (e) { log(`  ${t}: ${desc ? 'reverse' : 'forward'} scan stopped after ${n} rows (${e.message})`); }
    try { d.close(); } catch {}
    return complete;
  };
  const fwdComplete = scan(false), revComplete = scan(true);
  const txInsert = dest.transaction((objs) => { for (const o of objs) ins.run(o); });
  txInsert([...seen.values()]);
  const rids = [...seen.keys()].sort((a, b) => a - b);
  const have = new Set(dest.prepare(`SELECT id FROM "${t}"`).all().map(r => r.id));
  // Gap-fill from the snapshot. A table GENUINELY ABSENT from the snapshot (schema drift —
  // it simply doesn't exist there) is benign: there's nothing to recover from, so skip and
  // continue. But ANY OTHER snapshot-read failure — the snapshot's own copy of this table
  // is corrupt/unreadable, or its columns don't match — is dangerous: we cannot tell whether
  // we're silently dropping rows the snapshot could have restored. FAIL CLOSED (CLAUDE.md §3)
  // rather than quietly ship a lossy vault; the operator picks a known-good snapshot (the
  // final count-parity gate can't catch this — a corrupt src count(*) reads as 'ERR').
  let snapRows = [];
  try { snapRows = snap.prepare(`SELECT ${collist} FROM "${t}"`).all(); }
  catch (e) {
    if (/no such table/i.test(e.message)) log(`  ${t}: not present in snapshot (schema drift) — gap-fill skipped`);
    else throw new Error(`snapshot copy of "${t}" is unreadable (${e.message}) — cannot verify gap-fill; refusing to continue. Use a known-good snapshot, or MYCELIUM_REBUILD_SKIP=${t} if this table is regenerable.`);
  }
  let nextRid = dest.prepare(`SELECT COALESCE(MAX(rowid),0) x FROM "${t}"`).get().x + 1;
  const filled = [];
  for (const row of snapRows) { if (!have.has(row.id)) { ins.run({ __rid: nextRid++, ...row }); filled.push(row.id); } }
  counts[t] = dest.prepare(`SELECT count(*) c FROM "${t}"`).get().c;

  // LOSS GUARD (now live — the old `failed` array was declared but never populated, so its
  // stillMissing = failed.length − filled.length was always ≤ 0 and this warning could never
  // fire). The trustworthy signal is scan COMPLETENESS, not a re-derived rowid set: a `SELECT *`
  // pass in EITHER direction that reaches EOF without throwing hit no corrupt page, so in the
  // common damage mode `seen` holds every readable row. Only when BOTH directions stopped on
  // damage can an unread region remain — rows recovered only if the snapshot carried them. This
  // is a tripwire, not a completeness PROOF (see loss-guard.mjs's honesty caveat + residual);
  // validate.mjs is the id-level authority. It also avoids the phantom-rowid hazard that an
  // enumerate-and-diff guard would re-import.
  const incomplete = robustScanIncomplete(fwdComplete, revComplete);
  log(`${t}: scan complete fwd=${fwdComplete} rev=${revComplete}, src readable=${rids.length}, gap-filled=${filled.length}, dest=${counts[t]} (snap=${snapRows.length})`);
  if (incomplete) {
    robustIncomplete[t] = true; // seen by the final parity gate → fails the run under an 'ERR' src count
    log(`  *** WARNING: ${t} could NOT be read in one clean pass (both scans stopped on damage). Any row in the unread region absent from the snapshot is UNRECOVERABLE. Validate before swapping. ***`);
  }
  return { incomplete, filled };
}

// Tables to leave EMPTY (regenerable/non-critical) — their b-trees are so damaged
// that even robustCopy can't enumerate rowids. Comma-list via MYCELIUM_REBUILD_SKIP.
const SKIP = new Set((process.env.MYCELIUM_REBUILD_SKIP || '').split(',').map(s => s.trim()).filter(Boolean));

// Which tables MUST take the robust path, regardless of what a one-shot scan reports.
// WHY this matters (live incident 2026-07-19): `isCorrupt`'s single `SELECT *` can read
// clean on a shared-page-transient table while a SPECIFIC row still yields garbage (e.g.
// a NULL in a NOT NULL column) during the actual copy. That let `messages` (which the
// diagnostic flagged corrupt — Tree 127) take genericCopy's plain-INSERT path and abort
// with `NOT NULL constraint failed: messages.role`, instead of robustCopy's
// scan-union + INSERT OR IGNORE + gap-fill which tolerates it. So a table flagged corrupt
// by the source's OWN integrity_check is forced robust — never trusted to the clean path.
//
// The force-robust set is the union of:
//   (a) MYCELIUM_REBUILD_FORCE_ROBUST — explicit operator override (comma-list), and
//   (b) AUTO-DERIVED from the source integrity_check's corrupt-tree→object map — the same
//       computation diagnose.mjs prints (rootpage → sqlite_master object), replicated here
//       so a diagnostic-flagged table forces itself down robustCopy with no manual step.
const FORCE_ROBUST = new Set((process.env.MYCELIUM_REBUILD_FORCE_ROBUST || '').split(',').map(s => s.trim()).filter(Boolean));
function autoDeriveCorruptTables() {
  if (process.env.MYCELIUM_REBUILD_NO_AUTOROBUST) { log('auto-derive of corrupt tables DISABLED (MYCELIUM_REBUILD_NO_AUTOROBUST)'); return new Set(); }
  let text = '';
  try { text = src.prepare('PRAGMA integrity_check(200)').all().map(r => r.integrity_check).join('\n'); }
  catch (e) { log(`integrity_check on src threw (${e.code || e.message}) — auto-derive skipped (scan probe + copy-error fallback still apply)`); return new Set(); }
  if (text.trim() === 'ok') return new Set();
  // Map each corrupt "Tree N" rootpage → its base table (indexes resolve via tbl_name),
  // exactly as diagnose.mjs's "corrupt trees → objects" section does.
  const roots = [...new Set([...text.matchAll(/Tree (\d+) /g)].map((m) => Number(m[1])))];
  const names = new Set();
  for (const rp of roots) {
    for (const r of src.prepare(`SELECT name, tbl_name FROM sqlite_master WHERE rootpage=?`).all(rp)) names.add(r.tbl_name || r.name);
  }
  return names;
}
const autoRobust = autoDeriveCorruptTables();
for (const n of autoRobust) FORCE_ROBUST.add(n);
if (FORCE_ROBUST.size) log(`force-robust: ${[...FORCE_ROBUST].sort().join(', ')} (env${autoRobust.size ? ' + integrity_check auto-derive' : ''})`);

// Decide which tables need the robust path: forced (above) OR failing a quick full-scan.
function isCorrupt(t) { try { for (const _ of src.prepare(`SELECT * FROM "${t}"`).iterate()) {} return false; } catch { return true; } }
// robustCopy is rowid-centric (scan-union by rowid) and keys its dedup + snapshot gap-fill
// on an `id` column — so it CANNOT handle a WITHOUT ROWID table or one with no `id`.
// Never route such a table there: forcing one down robustCopy would `SELECT rowid`/`SELECT
// id` → throw → exit(7), REGRESSING a table genericCopy would have copied fine (e.g. a
// healthy WITHOUT ROWID table whose only damage is a flagged secondary index, which the
// auto-derive maps to its base table). Those stay on genericCopy.
function robustCapable(t) {
  if (/WITHOUT\s+ROWID/i.test(t.sql)) return false;
  return tinfo(t.name).some((c) => c.name === 'id');
}
for (const t of normalTables) {
  if (SKIP.has(t.name)) { log(`SKIP ${t.name} — left empty (regenerable; corrupt b-tree unreadable)`); continue; }
  const capable = robustCapable(t);
  if (FORCE_ROBUST.has(t.name) && !capable) log(`${t.name}: force-robust requested but robustCopy can't handle it (WITHOUT ROWID / no id column) — using genericCopy`);
  const forced = FORCE_ROBUST.has(t.name) && capable;
  try {
    if (forced || (capable && isCorrupt(t.name))) {
      if (forced) log(`${t.name}: forced down robustCopy`);
      robustCopy(t.name);
    } else {
      try { const n = genericCopy(t); if (n) log(`copied ${t.name}: ${n}`); }
      catch (e) {
        // GRACEFUL DEGRADE: a bad row surfaced only during the copy (e.g. a shared-page
        // NULL tripping a NOT NULL constraint) that the one-shot probe missed. The failed
        // genericCopy transaction rolled back (dest table left empty), so fall back to the
        // robust path — but only when robustCopy can actually handle this table (else there
        // is no robust salvage, so preserve the original hard-fail).
        if (!capable) throw e;
        log(`genericCopy ${t.name} failed (${e.message}) — degrading to robustCopy`);
        robustCopy(t.name);
      }
    }
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
  const v = parityVerdict({ s, dN, wasCopied: counts[t] !== undefined, robustIncomplete: !!robustIncomplete[t] });
  if (v.note) console.log(`  ${t}: ${v.note}`);
  if (v.mismatch) mismatches++;
}
log(`count mismatches: ${mismatches}`);
src.close(); snap.close(); dest.close();
if (!(ic.length === 1 && ic[0] === 'ok')) { console.error('FAIL: dest integrity_check not ok'); process.exit(6); }
if (mismatches > 0) { console.error('FAIL: table count mismatches / unrecoverable data loss'); process.exit(8); }
log('DONE — fresh rebuild succeeded (integrity ok, VACUUM ok, count parity). Validate, then swap.');
