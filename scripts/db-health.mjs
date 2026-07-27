#!/usr/bin/env node
// scripts/db-health.mjs — what data the vault holds, and what actually LOADS.
//
//   node scripts/db-health.mjs           gate mode: temp vault from the real migrations,
//                                        asserts the detectors have teeth (CI-safe)
//   node scripts/db-health.mjs --live    report mode: the CANONICAL vault, read-only
//
// WHY. Through the 2026-07-15 corruption day, every coarse probe lied: quick_check said
// "ok" while rows were shredded, aggregate counts said "fine" while writes failed, and
// the UI rendered empty screens with HTTP 200. The honest checks — the ones that caught
// it — were: (1) COUNT every table (a damaged b-tree throws on the table it damages),
// (2) run the SAME queries each UI surface runs, (3) table-scan-vs-planner parity on
// messages (a corrupt index INVENTS rows — observed: 101,398 "rows" of a 71,823-row
// table), (4) a created_at shape scan (shredded rows carry page fragments in plaintext
// columns). This script makes those one command.
//
// READ-ONLY by construction in --live: better-sqlite3 `readonly: true` cannot write and
// takes no writer lock; safe beside a running app. On a corrupt verdict it appends to
// the corruption ledger (a file BESIDE the vault, never inside it).

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const LIVE = process.argv.includes('--live');
const ISO_GLOB = "created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'";

// FTS/vec shadow tables — internal storage; counting them is noise, and fts shadow
// counts legitimately differ from their content table.
const SHADOW_RE = /_(data|idx|content|docsize|config|chunks|rowids|info|vector_chunks00)$/;

// The UI surfaces, expressed as the literal query shapes those surfaces run.
// A surface "loads" iff its query executes without throwing. LIMIT keeps it cheap.
const SURFACES = [
  ['history (chat timeline)', "SELECT id, role, content, created_at, conversation_id FROM messages WHERE user_id = ? AND forgotten_at IS NULL ORDER BY created_at DESC LIMIT 40"],
  ['streams · messages arm', "SELECT id, source, created_at, content FROM messages WHERE user_id = ? AND forgotten_at IS NULL ORDER BY created_at DESC LIMIT 40"],
  ['library (documents)', "SELECT path, title, summary, source_type, created_at FROM documents WHERE user_id = ? AND forgotten_at IS NULL AND is_internal = 0 ORDER BY created_at DESC LIMIT 40"],
  ['tasks', "SELECT id, created_at FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 40"],
  ['health days', "SELECT created_at FROM health_daily WHERE user_id = ? ORDER BY created_at DESC LIMIT 40"],
  ['mindscape territories', "SELECT territory_id FROM territory_profiles WHERE user_id = ? LIMIT 40"],
  ['media (attachments)', "SELECT id, created_at FROM attachments LIMIT 40"],
  ['activity feed', "SELECT id, kind, status FROM background_jobs WHERE user_id = ? ORDER BY started_at DESC LIMIT 40"],
];

function fmtN(n) { return typeof n === 'number' ? n.toLocaleString('en-US') : String(n); }

/** Run every check against an open handle. Pure over the connection — both modes share it.
 *
 * ONE READ TRANSACTION for everything (review B2): the phantom detector compares two
 * counts, and running them as separate statements beside a LIVE writer races it — a row
 * committed between the two reads reported "scan=73682 planner=73684 → corrupt index"
 * on a perfectly healthy vault, and that false verdict then polluted the corruption
 * ledger. Inside one WAL read transaction both counts see the same snapshot; the
 * reviewer measured delta=0 across three runs on a vault taking live writes.
 *
 * SEMANTICS: "loads" means the surface's query EXECUTES — a surface with 0 rows is
 * still GO (an empty vault is healthy). Row counts are printed so a human can judge
 * "loads but empty" for themselves. */
function checkVault(db, { userId }) {
  const problems = [];
  const report = { tables: [], surfaces: [], messages: {}, quickCheck: null };
  let txn = false;
  try { db.exec('BEGIN'); txn = true; } catch { /* already in a txn — proceed unsnapshot */ }
  try {
    return checkVaultInner(db, { userId }, problems, report);
  } finally {
    if (txn) { try { db.exec('COMMIT'); } catch { /* read txn — nothing to roll back */ } }
  }
}

function checkVaultInner(db, { userId }, problems, report) {

  // 1. quick_check — structural floor (NOT sufficient alone: it skips index-vs-table
  //    consistency, which is exactly what the phantom check below covers).
  try {
    const qc = db.prepare('PRAGMA quick_check').all().map((r) => r.quick_check).join(' | ');
    report.quickCheck = qc;
    if (qc !== 'ok') problems.push(`quick_check: ${qc.slice(0, 200)}`);
  } catch (e) { report.quickCheck = `THREW ${e.code || e.message}`; problems.push(`quick_check threw: ${e.code || e.message}`); }

  // 2. COUNT EVERY TABLE — a per-b-tree read probe. A count that throws marks the
  //    exact table whose tree is damaged (this is how the 07-15 write-only damage
  //    was finally localized: reads passed, the messages tree threw).
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  for (const t of tables) {
    if (SHADOW_RE.test(t.name)) continue;
    let rows = null, err = null;
    try { rows = db.prepare(`SELECT count(*) c FROM "${t.name}"`).get().c; }
    catch (e) { err = e.code || String(e.message).slice(0, 60); problems.push(`table ${t.name}: count threw ${err}`); }
    report.tables.push({ name: t.name, rows, err, virtual: /VIRTUAL/i.test(t.sql || '') });
  }

  // 3. THE SURFACES — does each screen's query run?
  for (const [name, sql] of SURFACES) {
    let ok = true, rows = 0, err = null;
    const params = (sql.match(/\?/g) || []).map(() => userId); // bind exactly as many as the query takes
    try { rows = db.prepare(sql).all(...params).length; }
    catch (e) { ok = false; err = e.code || String(e.message).slice(0, 80); problems.push(`surface "${name}": ${err}`); }
    report.surfaces.push({ name, ok, rows, err });
  }

  // 4. messages deep checks — the table that carries the vault's soul.
  try {
    const scan = db.prepare('SELECT count(*) c FROM messages NOT INDEXED').get().c;
    const planner = db.prepare('SELECT count(*) c FROM messages').get().c;
    const shredded = db.prepare(`SELECT count(*) c FROM messages NOT INDEXED WHERE NOT (${ISO_GLOB}) OR created_at IS NULL`).get().c;
    const newest = db.prepare(`SELECT max(created_at) m FROM messages WHERE ${ISO_GLOB}`).get().m;
    const oldest = db.prepare(`SELECT min(created_at) m FROM messages WHERE ${ISO_GLOB}`).get().m;
    report.messages = { scan, planner, shredded, newest, oldest };
    if (scan !== planner) problems.push(`messages PHANTOMS: table scan=${scan} but planner says ${planner} — a corrupt index is inventing rows`);
    if (shredded > 0) problems.push(`messages SHREDDED: ${shredded} row(s) carry non-timestamp bytes in created_at (page-fragment damage)`);
  } catch (e) { problems.push(`messages deep check threw: ${e.code || e.message}`); }

  return { problems, report };
}

function printReport({ problems, report }) {
  console.log(`\nquick_check: ${String(report.quickCheck).slice(0, 100)}`);
  console.log('\nDATA AVAILABLE (per table):');
  const named = report.tables.filter((t) => !t.err).sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0));
  for (const t of named.slice(0, 20)) console.log(`  ${t.name.padEnd(34)} ${fmtN(t.rows).padStart(10)}${t.virtual ? '  (virtual)' : ''}`);
  const rest = named.slice(20);
  if (rest.length) console.log(`  … +${rest.length} smaller tables, ${fmtN(rest.reduce((s, t) => s + (t.rows || 0), 0))} rows total`);
  for (const t of report.tables.filter((x) => x.err)) console.log(`  ${t.name.padEnd(34)} ${'UNREADABLE'.padStart(10)}  <-- ${t.err}`);
  console.log('\nWHAT LOADS (the actual UI queries):');
  for (const s of report.surfaces) console.log(`  [${s.ok ? '✓' : '✗'}] ${s.name.padEnd(28)} ${s.ok ? `${s.rows} row(s)` : `FAILS: ${s.err}`}`);
  const m = report.messages;
  if (m && m.scan != null) {
    console.log(`\nmessages: ${fmtN(m.scan)} rows (scan==planner: ${m.scan === m.planner ? 'yes — no phantoms' : `NO — planner ${fmtN(m.planner)}`}) · shredded=${m.shredded} · ${m.oldest?.slice(0, 10)} → ${m.newest?.slice(0, 19)}`);
  }
  console.log(problems.length ? `\nPROBLEMS:\n${problems.map((p) => `  ✗ ${p}`).join('\n')}` : '\nno problems found');
}

if (LIVE) {
  // ── report mode: the canonical vault, read-only ─────────────────────────────
  const { dbPath } = await import('../src/paths.js');
  const { readUserMaster, deriveDbKey } = await import('../src/account/keystore.js');
  const { existsSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  // dbPath() honours MYCELIUM_DATA_DIR / MYCELIUM_DB; a bare dev checkout resolves to
  // <repo>/data which usually has no vault. "--live" means THE app's vault, so fall
  // back to the platform app dir when the checkout-local path has nothing to check.
  let p = dbPath();
  if (!existsSync(p)) {
    const appVault = join(homedir(), 'Library', 'Application Support', 'id.mycelium.app', 'mycelium.db');
    if (existsSync(appVault)) { p = appVault; console.log(`(no vault at ${dbPath()} — checking the app vault ${p})`); }
    else { console.error(`FATAL: no vault at ${p} or ${appVault}`); process.exit(2); }
  }
  const hex = readUserMaster();
  if (!hex) { console.error('FATAL: USER_MASTER not in Keychain — cannot open the vault'); process.exit(2); }
  const db = new Database(p, { fileMustExist: true, readonly: true });
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key="x'${deriveDbKey(hex)}'"`);
  db.pragma('cache_size=-100000');
  // The vault's users table can hold >1 row (federation peers, imports) — `LIMIT 1`
  // picked an arbitrary one and every user-scoped surface then read 0 rows, making the
  // whole "what loads" section vacuous. The primary user is the one who owns the data.
  const userId = db.prepare('SELECT user_id FROM messages GROUP BY user_id ORDER BY count(*) DESC LIMIT 1').get()?.user_id
    || db.prepare('SELECT id FROM users LIMIT 1').get()?.id
    || 'local-user';
  const out = checkVault(db, { userId });
  db.close();
  printReport(out);
  const ok = out.problems.length === 0;
  if (!ok) {
    try {
      const { appendCorruptionEvent } = await import('../src/db/integrity.js');
      appendCorruptionEvent(dirname(p), { source: 'db-health', detail: out.problems.join(' ; ').slice(0, 480) });
    } catch { /* ledger is best-effort */ }
  }
  console.log(`\n${ok ? 'VERDICT: GO — every table readable, every surface loads' : 'VERDICT: NO-GO — see problems'}\n`);
  process.exit(ok ? 0 : 1);
}

// ── gate mode: prove the detectors have TEETH on a real-schema temp vault ──────
const { applyMigrations } = await import('../src/db/migrate.js');
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const dir = mkdtempSync(join(tmpdir(), 'myc-health-'));
const db = new Database(join(dir, 'fixture.db'));
applyMigrations(db);
const U = 'u1';
db.prepare("INSERT INTO users (id) VALUES (?)").run(U);
db.prepare("INSERT INTO messages (id, user_id, role, content, created_at) VALUES ('m1', ?, 'user', 'hello', '2026-07-16T08:00:00.000Z')").run(U);
db.prepare("INSERT INTO documents (path, user_id, title, created_at) VALUES ('a.md', ?, 'A', '2026-07-16T08:00:00.000Z')").run(U);

console.log('\ndb-health detectors');

t('clean vault → GO (no problems, all surfaces load)', () => {
  const r = checkVault(db, { userId: U });
  assert.deepEqual(r.problems, []);
  assert.ok(r.report.surfaces.every((s) => s.ok), 'every surface must load on a healthy vault');
  assert.ok(r.report.tables.length > 20, 'the whole schema is enumerated');
});

t('TEETH: a shredded row (page bytes in created_at) is DETECTED', () => {
  db.prepare("INSERT INTO messages (id, user_id, role, content, created_at) VALUES ('bad', ?, 'user', 'x', '{\"peer\":\"lo.myceli')").run(U);
  const r = checkVault(db, { userId: U });
  assert.ok(r.problems.some((p) => /SHREDDED/.test(p)), `must flag the shredded row (got: ${r.problems.join('; ') || 'nothing'})`);
  db.prepare("DELETE FROM messages WHERE id = 'bad'").run();
});

t('TEETH: a missing/broken surface table reads as FAILS, not silence', () => {
  db.exec('ALTER TABLE health_daily RENAME TO health_daily_hidden');
  const r = checkVault(db, { userId: U });
  const s = r.report.surfaces.find((x) => x.name === 'health days');
  assert.equal(s.ok, false, 'the health surface must report FAILS');
  assert.ok(r.problems.some((p) => /health days/.test(p)));
  db.exec('ALTER TABLE health_daily_hidden RENAME TO health_daily');
});

t('a clean vault is GO again after the injected faults are removed', () => {
  const r = checkVault(db, { userId: U });
  assert.deepEqual(r.problems, []);
});

db.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
