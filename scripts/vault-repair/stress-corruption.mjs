#!/usr/bin/env node
// stress-corruption.mjs — try to REPRODUCE the production damage signature, at production
// shape. The one thing this repo has never had.
//
// WHY THE EXISTING HARNESS IS NOT ENOUGH: repro-corruption.mjs scenario A is INSERT-ONLY
// into a single 5-column table with no secondary indexes, no triggers, no FTS, no blobs and
// no transactions — 4 000 rows per worker, seconds of wall clock. It performs no UPDATEs and
// no DELETEs, so it never frees a page, so **it cannot churn the freelist**. The damage this
// vault actually produced was:
//
//     Tree 13639 page 20775: btreeInitPage() returns error code 11
//     Tree 967 page 12352 cell 2: 2nd reference to page 20775
//     Tree 30 page 30 cell 325: 2nd reference to page 20776   (×20 more)
//
// "2nd reference to page N" is two b-trees claiming one page — the signature of freelist
// reuse gone wrong. A harness that never frees a page cannot generate it. So "concurrent
// writers are safe (6/6)" was measured on a workload structurally incapable of showing the
// failure. This harness fixes that: real schema, real mixed workload, real lifecycle.
//
// EXPERIMENTAL DESIGN — the positive control is the point:
//   swap        POSITIVE CONTROL. The stale-WAL swap, which is KNOWN lethal (demonstrated
//               2026-07-16). If this scenario does not corrupt, the harness is not sensitive
//               enough and every other result is meaningless. Run it first.
//   steady      N processes, mixed INSERT/UPDATE/DELETE + blob overflow, real indexes.
//   kill        …plus SIGKILL of a writer mid-transaction — the app's own quit path
//               (main.rs group-kills after a 6 s grace, and src/index.js has no handler).
//   checkpoint  …plus a competing wal_checkpoint(TRUNCATE), which takes an exclusive lock.
//
// A NULL RESULT IS A RESULT — but only alongside a passing positive control, and only for
// the workload actually run. It is never "concurrency is safe"; it is "this shape, this
// long, did not corrupt". Report it that way.
//
// Usage: node scripts/vault-repair/stress-corruption.mjs [scenario] [rounds]
//        scenario ∈ all|swap|steady|kill|checkpoint   (default: all)

import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, copyFileSync, renameSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(SELF), '../..');
const KEY = 'f'.repeat(64); // synthetic — never a real key

// This harness CORRUPTS its target by design. It must be impossible to aim at the real vault.
{
  const { dbPath } = await import('../../src/paths.js');
  let canonical = null; try { canonical = resolve(dbPath()); } catch { /* none here */ }
  const target = process.env.MYCELIUM_DB ? resolve(process.env.MYCELIUM_DB) : null;
  if (canonical && target === canonical) {
    console.error('stress-corruption: REFUSING to run against the canonical vault.');
    process.exit(2);
  }
}

/** The app's EXACT open path — adapter/d1.js, pragma for pragma. */
function openVault(path, { readonly = false } = {}) {
  const db = new Database(path, { readonly });
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key="x'${KEY}'"`);
  db.pragma('temp_store = MEMORY');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_size_limit = 67108864');
  db.pragma('cell_size_check = ON');
  db.pragma('fullfsync = 1');
  return db;
}

// ── worker mode ───────────────────────────────────────────────────────────────
if (process.argv[2] === '--worker') {
  const [, , , path, role, ops] = process.argv; // [node, SELF, '--worker', path, role, ops]
  // NOT `Number(ops) || 4000`. STRESS_OPS=0 is falsy, so the parent's banner announced
  // "0 batched ops" while every worker silently ran 4000 — measured 64,409 rows against a
  // 6,000-row seed. The harness reported a workload it had not run, and the idle-round
  // guard could never fire. Same shape as the parent's own OPS line, fixed there and
  // missed here (second re-review, 2026-07-28).
  const N = (ops !== undefined && ops !== '' ? Number(ops) : 4000);
  const db = openVault(path);
  const ins = db.prepare('INSERT INTO stress_msg (id,user_id,content,blob_col,created_at) VALUES (?,?,?,?,?)');
  const upd = db.prepare('UPDATE stress_msg SET content = ?, blob_col = ? WHERE rowid = ?');
  const del = db.prepare('DELETE FROM stress_msg WHERE rowid = ?');
  const maxRow = () => db.prepare('SELECT max(rowid) AS m FROM stress_msg').get()?.m || 0;
  try {
    for (let i = 0; i < N; i++) {
      // Batches inside transactions — the real write shape, and what makes pages get
      // allocated and freed in bulk rather than one at a time.
      db.transaction(() => {
        for (let k = 0; k < 12; k++) {
          // Big values force OVERFLOW PAGES; overflow-chain damage was in the signature.
          ins.run(`${role}-${i}-${k}`, `u${k % 4}`, 'c'.repeat(200 + ((i * k) % 3000)), Buffer.alloc(600 + ((i + k) % 2200), k), new Date().toISOString());
        }
        const hi = maxRow();
        if (hi > 60) {
          // DELETE + UPDATE are what churn the FREELIST — the mechanism the old harness
          // never exercised, and the one "2nd reference to page" points at.
          for (let k = 0; k < 7; k++) del.run(1 + Math.floor(((i * 7919) + (k * 104729)) % (hi - 1)));
          for (let k = 0; k < 5; k++) upd.run('u'.repeat(150 + ((i + k) % 2600)), Buffer.alloc(400 + ((i * k) % 1800), 7), 1 + Math.floor(((i * 3571) + (k * 7717)) % (hi - 1)));
        }
      })();
      if (i % 400 === 0) process.stdout.write('.');
    }
    db.close();
    process.exit(0);
  } catch (e) {
    // SQLITE_BUSY under contention is expected and is NOT damage.
    process.exit(/BUSY|LOCKED/i.test(String(e.code)) ? 5 : (/CORRUPT|malformed/i.test(String(e.code) + e.message) ? 9 : 3));
  }
}

// ── driver ────────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'myc-stress-'));
const SCENARIO = process.argv[2] || 'all';
const ROUNDS = Number(process.argv[3]) || 3;
const WORKERS = Number(process.env.STRESS_WORKERS) || 4;
const OPS = (process.env.STRESS_OPS !== undefined && process.env.STRESS_OPS !== '' ? Number(process.env.STRESS_OPS) : 1200);

/** Build a vault with the REAL schema, plus an index-heavy stress table. */
function seed(path) {
  const db = openVault(path);
  // The real 111-table schema: FKs, triggers, indexes, FTS — the structures a toy table has
  // none of, and each one is another b-tree that can be mis-linked.
  const init = join(REPO, 'migrations', '0001_init.sql');
  if (existsSync(init)) {
    for (const stmt of readFileSync(init, 'utf8').split(/;\s*$/m)) {
      const s = stmt.trim();
      if (s) { try { db.exec(s); } catch { /* dialect edge cases — best effort */ } }
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS stress_msg (
    id TEXT PRIMARY KEY, user_id TEXT, content TEXT, blob_col BLOB, created_at TEXT)`);
  // SECONDARY INDEXES: each is a separate b-tree sharing the same freelist. Two trees
  // claiming one page is exactly what the production quick_check reported.
  db.exec('CREATE INDEX IF NOT EXISTS ix_stress_user ON stress_msg(user_id, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS ix_stress_content ON stress_msg(content)');
  db.exec('CREATE INDEX IF NOT EXISTS ix_stress_created ON stress_msg(created_at)');
  const ins = db.prepare('INSERT INTO stress_msg (id,user_id,content,blob_col,created_at) VALUES (?,?,?,?,?)');
  db.transaction(() => {
    for (let i = 0; i < 6000; i++) ins.run(`seed-${i}`, `u${i % 4}`, 'x'.repeat(180 + (i % 2400)), Buffer.alloc(500 + (i % 2000), i & 0xff), new Date().toISOString());
  })();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  return path;
}

/** Rows currently in the vault, or null if it cannot be read. */
function rowCount(path) {
  try {
    const db = openVault(path, { readonly: true });
    const n = db.prepare('SELECT count(*) AS n FROM stress_msg').get().n;
    db.close();
    return n;
  } catch { return null; }
}

function verdict(path) {
  try {
    const db = openVault(path, { readonly: true });
    const rows = db.pragma('quick_check').map((r) => r.quick_check ?? r);
    const n = db.prepare('SELECT count(*) AS n FROM stress_msg').get().n;
    db.close();
    return rows.length === 1 && rows[0] === 'ok'
      ? { ok: true, detail: `quick_check ok · ${n} rows` }
      : { ok: false, detail: rows.slice(0, 4).join(' | ') };
  } catch (e) { return { ok: false, detail: `${e.code}: ${e.message}` }; }
}

const workerErrors = [];
const startWorker = (path, role) => {
  const c = spawn(process.execPath, [SELF, '--worker', path, role, String(OPS)], { stdio: ['ignore', 'ignore', 'pipe'] });
  c.stderr.on('data', (d) => { const t = String(d).trim(); if (t) workerErrors.push(t.split('\n')[0].slice(0, 160)); });
  return c;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenarioSteady(path, { kill = false, checkpoint = false } = {}) {
  const kids = [];
  for (let w = 0; w < WORKERS; w++) kids.push(startWorker(path, `w${w}`));
  let killed = 0, ckpt = 0;
  const done = Promise.all(kids.map((c) => new Promise((r) => c.on('exit', (code) => r(code)))));

  if (kill || checkpoint) {
    for (let t = 0; t < 12; t++) {
      await sleep(700);
      if (kill) {
        // SIGKILL mid-transaction — the app's real quit path (group-kill after grace, and
        // src/index.js installs no handler at all, so children die exactly like this).
        const victim = kids.find((c) => c.exitCode === null);
        if (victim) { victim.kill('SIGKILL'); killed++; kids.push(startWorker(path, `r${t}`)); }
      }
      if (checkpoint) {
        // An exclusive checkpoint competing with live writers.
        const r = spawnSync(process.execPath, ['-e', `
          const D=require(${JSON.stringify(join(REPO, 'node_modules/better-sqlite3'))});
          const d=new D(${JSON.stringify(path)});
          d.pragma("cipher='sqlcipher'"); d.pragma("key=\\"x'${KEY}'\\""); d.pragma('busy_timeout=3000');
          try { d.pragma('wal_checkpoint(TRUNCATE)'); } catch {} d.close();`], { timeout: 8000 });
        if (r.status === 0) ckpt++;
      }
    }
  }
  const codes = await done;
  return { killed, ckpt, codes };
}

/**
 * POSITIVE CONTROL: the stale-WAL swap that is KNOWN lethal (demonstrated 2026-07-16, and
 * re-run by verify:wal-guard's sanity case). Three details make it work, all learned the
 * hard way when the first version of this control came back CLEAN:
 *   1. capture the live `-wal` BEFORE closing — a clean close checkpoints and truncates it;
 *   2. remove the `-shm` — with a stale index SQLite will not replay the WAL;
 *   3. overwrite CONTENT (copyFileSync), not rename — a rename gives a new inode and the
 *      live writer keeps its fd on the old one, so nothing is actually hijacked.
 * SAME-SALT lineage, deliberately: on an ENCRYPTED vault a different-salt WAL cannot
 * decrypt, so the dangerous case is an older byte-copy of the SAME file restored over the
 * live one — the exact case src/db/wal-guard.js:33-35 admits is invisible to it.
 */
async function scenarioSwap(path) {
  // gen1: write, then capture its live WAL before any close folds it away.
  const a = openVault(path);
  const ins = a.prepare('INSERT INTO stress_msg (id,user_id,content,blob_col,created_at) VALUES (?,?,?,?,?)');
  a.transaction(() => { for (let i = 0; i < 500; i++) ins.run(`gen1-${i}`, 'u9', 'OLD-WORLD-'.repeat(40), Buffer.alloc(900, 1), 'g1'); })();
  const staleWal = join(dir, 'stale.wal');
  if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, staleWal);
  a.close(); // checkpoints the original — gen1 content is now IN the db file

  // gen2: same lineage (so same SQLCipher salt), evolved differently.
  const gen2 = `${path}.gen2`;
  copyFileSync(path, gen2);
  { const b = openVault(gen2); b.exec("DELETE FROM stress_msg WHERE id LIKE 'gen1-%'"); b.exec('VACUUM'); b.close(); }

  copyFileSync(gen2, path);                              // swap gen2's CONTENT in…
  if (existsSync(staleWal)) copyFileSync(staleWal, `${path}-wal`); // …leaving gen1's WAL
  rmSync(`${path}-shm`, { force: true });                // force a replay on next open
  rmSync(gen2, { force: true });
  return { swapped: true };
}

const SCENARIOS = {
  swap: { label: 'POSITIVE CONTROL — swap a divergent generation under a live writer, stale WAL left', run: scenarioSwap },
  steady: { label: 'steady state — N writers, mixed INSERT/UPDATE/DELETE, blobs, 3 secondary indexes', run: (p) => scenarioSteady(p) },
  kill: { label: 'hard-kill — same workload + SIGKILL a writer mid-transaction (the real quit path)', run: (p) => scenarioSteady(p, { kill: true }) },
  checkpoint: { label: 'checkpoint contention — same workload + competing wal_checkpoint(TRUNCATE)', run: (p) => scenarioSteady(p, { checkpoint: true }) },
};

const picked = SCENARIO === 'all' ? ['swap', 'steady', 'kill', 'checkpoint'] : [SCENARIO];
console.log(`\nstress-corruption — ${WORKERS} workers × ${OPS} batched ops × ${ROUNDS} round(s), real 111-table schema\n`);

const results = [];
let idleRounds = 0; // rounds whose workers wrote nothing — a clean verdict there is vacuous
for (const name of picked) {
  const sc = SCENARIOS[name];
  if (!sc) { console.error(`unknown scenario: ${name}`); process.exit(2); }
  console.log(`── ${name} ──\n   ${sc.label}`);
  let corrupted = null;
  for (let round = 1; round <= ROUNDS && !corrupted; round++) {
    const p = join(dir, `${name}-${round}.db`);
    seed(p);
    process.stdout.write(`   round ${round}: `);
    // MEASURE the seed, never hardcode it: a seed() that silently wrote fewer rows would
    // make the net-rows check compare against a number that was never true.
    const before = rowCount(p);
    const info = await sc.run(p);
    const v = verdict(p);
    const rows = Number(/· (\d+) rows/.exec(v.detail)?.[1] ?? -1);
    const wrote = rows < 0 ? null : rows - before;
    const codes = info.codes ? ` exits=[${info.codes.join(',')}]` : '';
    console.log(`\n     → ${v.ok ? 'CLEAN' : 'CORRUPT'}  ${v.detail}${info.killed ? ` (killed ${info.killed})` : ''}${info.ckpt ? ` (checkpoints ${info.ckpt})` : ''}${codes}`);
    if (workerErrors.length) {
      console.log(`     ⚠️  worker error: ${workerErrors[0]}`);
      workerErrors.length = 0;
    }
    if (name !== 'swap' && wrote !== null && wrote <= 0) {
      idleRounds++;
      console.log(`     ⚠️  WORKERS WROTE NOTHING (net ${wrote} rows). This round proves nothing —`);
      console.log('         a clean verdict on an idle vault measures the harness, not the product.');
    }
    if (!v.ok) corrupted = { round, detail: v.detail };
    for (const f of readdirSync(dir)) { if (f.startsWith(`${name}-${round}`)) { try { rmSync(join(dir, f), { force: true }); } catch { /* */ } } }
  }
  results.push({ name, corrupted });
}

console.log('\n══ RESULTS ══');
for (const r of results) console.log(`  ${r.name.padEnd(11)} ${r.corrupted ? `CORRUPTED on round ${r.corrupted.round} — ${r.corrupted.detail.slice(0, 70)}` : 'clean'}`);

// THREE STATES, NOT TWO. `control` is undefined when the swap scenario was not selected
// (e.g. `stress-corruption.mjs steady 1`), and the old `if (control && !control.corrupted)`
// skipped straight past that into the reassurance branch: the harness printed "Positive
// control corrupted as expected, so the harness can detect damage" having never run the
// control at all, and exited 0. A check that cannot tell "the control corrupted" from "the
// control never ran" is not a check — and the writer-lock-retirement audit
// cites this harness as PROVEN for its C1 criterion. Adversarial review, 2026-07-28.
const control = results.find((r) => r.name === 'swap');
const others = results.filter((r) => r.name !== 'swap');
let exitCode = 0;
if (!control) {
  console.log('\n  ⚠️  NO POSITIVE CONTROL IN THIS RUN. The `swap` scenario was not selected, so');
  console.log('      nothing here demonstrates that the harness can detect damage at all. Every');
  console.log('      "clean" above is UNINFORMATIVE. Re-run including `swap` before citing any of it.');
  exitCode = 2;
} else if (!control.corrupted) {
  console.log('\n  ⚠️  THE POSITIVE CONTROL DID NOT CORRUPT. This harness is not sensitive enough to');
  console.log('      detect the mechanism we already know is lethal, so every "clean" above is');
  console.log('      UNINFORMATIVE — it measures the harness, not the product.');
  exitCode = 2;
} else if (others.every((r) => !r.corrupted)) {
  console.log('\n  Positive control corrupted as expected, so the harness can detect damage.');
  console.log('  The other scenarios stayed clean AT THIS SHAPE AND DURATION. That is evidence,');
  console.log('  not proof: it does not say "concurrency is safe", only that this workload, this');
  console.log('  long, did not corrupt. Raise STRESS_WORKERS / STRESS_OPS / rounds to push further.');
}
// An idle-vault round proves nothing either, and used to be stdout-only against an
// unconditional exit 0 — so a run where every worker died on startup still "passed".
if (idleRounds > 0) {
  console.log(`\n  ⚠️  ${idleRounds} round(s) had workers write NOTHING. Those rounds measure the harness, not the product.`);
  exitCode = 2;
}
rmSync(dir, { recursive: true, force: true });
process.exit(exitCode);
