// scripts/vault-repair/diagnose.mjs — READ-ONLY structural diagnostic for a vault
// that opens & reads fine but fails `VACUUM` with "database disk image is malformed".
//
// Symptom class: a row/page-level "table-by-table recovery" leaves a structurally
// inconsistent vault — shared pages ("2nd reference to page N"), invalid child
// pointers ("invalid page number ..."), corrupt overflow chains, and leaked pages.
// Normal reads tolerate it (a query walks one path); VACUUM (which rewrites every
// page) does not. This script enumerates the blast radius WITHOUT modifying anything.
//
// Usage:  node scripts/vault-repair/diagnose.mjs <path-to-vault.db>
// The vault is opened keyed via the app's own key scheme (USER_MASTER from the
// macOS Keychain → deriveDbKey). Never prints key material. Run with the app QUIT
// (a concurrent writer is what caused the original corruption). Safe on a copy.
import Database from 'better-sqlite3';
import { readUserMaster, deriveDbKey } from '../../src/account/keystore.js';

const DBPATH = process.argv[2];
if (!DBPATH) { console.error('usage: diagnose.mjs <vault.db>'); process.exit(2); }
const userHex = readUserMaster();
if (!userHex) { console.error('FATAL: USER_MASTER not found in Keychain'); process.exit(2); }
const dbKey = deriveDbKey(userHex);

const db = new Database(DBPATH, { readonly: true, fileMustExist: true });
db.pragma(`cipher='sqlcipher'`);
db.pragma(`key="x'${dbKey}'"`);
db.pragma('temp_store = MEMORY');
console.log(`[diag] opened ${DBPATH} keyed (readonly); sqlite_master has ${db.prepare('SELECT count(*) c FROM sqlite_master').get().c} objects`);

// 1) Bounded structural checks (unbounded integrity_check may itself throw on a
//    badly malformed file, so we bound it).
function pragmaText(sql, label) {
  console.log(`\n=== ${label} ===`);
  try { for (const r of db.prepare(sql).all()) console.log('  ', Object.values(r)[0]); }
  catch (e) { console.log('  (threw)', e.code || e.message); }
}
pragmaText(`PRAGMA quick_check(20)`, 'PRAGMA quick_check (first 20)');
pragmaText(`PRAGMA integrity_check(40)`, 'PRAGMA integrity_check (first 40)');
console.log('\n=== PRAGMA foreign_key_check ===');
const fk = db.prepare('PRAGMA foreign_key_check').all();
console.log(`  ${fk.length} violation(s)`);

// 2) Map corrupt "Tree N" rootpages → objects (table/index name).
const checkText = (() => { try { return db.prepare('PRAGMA integrity_check(40)').all().map(r => r.integrity_check).join('\n'); } catch { return ''; } })();
const trees = [...new Set([...checkText.matchAll(/Tree (\d+) /g)].map(m => Number(m[1])))];
console.log('\n=== corrupt trees → objects ===');
for (const rp of trees) {
  const rows = db.prepare(`SELECT type, name, tbl_name FROM sqlite_master WHERE rootpage=?`).all(rp);
  if (rows.length) for (const r of rows) console.log(`  Tree ${rp} = ${r.type} "${r.name}" (tbl=${r.tbl_name})`);
  else console.log(`  Tree ${rp} = (interior/overflow page — no sqlite_master row)`);
}

// 3) Full-scan every plain table to find which DATA tables are actually corrupt
//    (virtual tables skipped — they need their module loaded; their shadow tables
//    are plain tables and are scanned here).
console.log('\n=== full-scan plain tables (find corrupt data tables) ===');
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND sql NOT LIKE '%USING%' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`).all().map(r => r.name);
const corrupt = [];
for (const t of tables) {
  let n = 0;
  try { for (const _ of db.prepare(`SELECT * FROM "${t}"`).iterate()) n++; }
  catch (e) { corrupt.push(t); console.log(`  ✗ ${t}: FAILED after ${n} rows — ${e.code || e.message}`); }
}
console.log(`  clean: ${tables.length - corrupt.length}/${tables.length}; corrupt data tables: ${corrupt.length ? corrupt.join(', ') : '(none)'}`);

// 4) For each corrupt table, enumerate the exact unreadable rowids (per-row read).
for (const t of corrupt) {
  console.log(`\n=== unreadable rowids in "${t}" ===`);
  const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map(c => `"${c.name}"`).join(', ');
  const rids = db.prepare(`SELECT rowid AS r FROM "${t}" ORDER BY rowid`).all().map(x => x.r);
  const read = db.prepare(`SELECT ${cols} FROM "${t}" WHERE rowid=?`);
  const lost = [];
  for (const r of rids) { try { read.get(r); } catch { lost.push(r); } }
  console.log(`  total ${rids.length}, unreadable ${lost.length}: ${JSON.stringify(lost)}`);
}
db.close();
console.log('\n[diag] done.');
