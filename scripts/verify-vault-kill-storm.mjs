#!/usr/bin/env node
// scripts/verify-vault-kill-storm.mjs — D-140: the vault-corruption kill-storm harness.
//
// WHY: the operator's 67k-message vault corrupted twice on clean starts (07-30, 08-05)
// with the signature "every page HMAC authenticates, yet the DB is malformed" — LOGICAL
// corruption: valid pages spliced into an inconsistent B-tree. The durability pragmas
// (WAL + fullfsync, src/adapter/d1.js:62-96) say a bare SIGKILL must not do this, so the
// mechanism is coordination-level. This harness runs the REAL write topology (the shapes
// the two corruption incidents exhibited) on a SYNTHETIC vault and
// applies the real interruption modes: mid-transaction SIGKILL, checkpoint-timed
// SIGKILL, the D-136 group sweep, the kernel-OOM orphan-overlap (S1), and the 32-boot
// crash-loop replay — plus POSITIVE CONTROLS (split -shm, stale-db+hot-WAL splice) that
// must corrupt, proving the detector can see what it claims to see. A run where every
// kill round is clean AND every control corrupts is a meaningful green; anything else
// is a finding.
//
// Everything runs on synthetic keyed SQLCipher vaults in a temp dir; the canonical
// vault is refused by path identity (no env override honoured).
//
// Usage:
//   node scripts/verify-vault-kill-storm.mjs               # bounded rounds (gate mode)
//   KS_SOAK=1 node scripts/verify-vault-kill-storm.mjs     # long-soak (release qualification)
//   KS_ROWS=30000 KS_ROUNDS_K1=30 ... per-scenario overrides
//
// NOTE on detection: better-sqlite3-multiple-ciphers silently no-ops
// `PRAGMA cipher_integrity_check` (measured 2026-08-06: returns [] on a physically
// tampered page — an unknown-pragma false green), and the real `sqlcipher` CLI cannot
// read mc-created files at all (page-1 HMAC failure on a CLEAN file — measured). So no
// page-authenticity discriminator exists for this build; the detector classifies by
// behaviour (structural error rows vs decrypt-layer throw) and preserves every corrupt
// round's family as a corpse for manual autopsy.
//
// TEETH, always-on: the P1/P2 positive controls are live mutations — each run must
// CORRUPT them or the verdict is NO-CONFIDENCE (exit 1). A harness that cannot corrupt
// anything cannot prove its clean rounds mean anything (M-001).
// MUTATION-TESTED: (D-140, 2026-08-06) verifyVault gutted to `return CLEAN` (the
// detector blinded — the exact false-green shape M-001 documents) → P1/P2 report clean,
// controlsProveTeeth false → VERDICT: NO-CONFIDENCE, EXIT 1. Restored → GO.
// MUTATION-TESTED: (D-140, 2026-08-06, by construction each run) P1 unlinks -shm under
// two live writers and P2 swaps a stale db under a hot -wal — both must produce
// STRUCTURAL/LOST_COMMIT verdicts every run (observed: "Child page depth differs",
// btreeInitPage error 11, malformed) or the gate REDs itself.
// MUTATION-TESTED: (D-140, 2026-08-06, round 2 — review M10) verifyVault's ledger-
// reconciliation branch DELETED → P3 reports CLEAN (LOST_COMMIT=0) → NO-CONFIDENCE,
// EXIT 1. Restored → GO. (Before P3 existed this mutant SURVIVED — the structural
// controls never exercised the durability branch.)
// MUTATION-TESTED: (D-140, 2026-08-06, round 2 — review M11) verifyVault's
// PARTIAL_TXN atomicity branch DELETED → P4 reports CLEAN (PARTIAL_TXN=0) →
// NO-CONFIDENCE, EXIT 1. Restored → GO. (Also a pre-P4 survivor.)

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import Database from 'better-sqlite3';
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, rmSync, existsSync, appendFileSync, readFileSync,
  cpSync, copyFileSync, unlinkSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '..');
const MIGRATIONS = join(ROOT, 'migrations');

// ── refuse the canonical vault (this harness corrupts its target BY DESIGN) ──
{
  const { dbPath } = await import(join(ROOT, 'src/paths.js'));
  let canonical = null; try { canonical = resolve(dbPath()); } catch { /* none here */ }
  const target = process.env.MYCELIUM_DB ? resolve(process.env.MYCELIUM_DB) : null;
  if (canonical && target === canonical) {
    console.error('kill-storm: REFUSING to run against the canonical vault.');
    process.exit(2);
  }
}

const KEY = 'a'.repeat(64); // synthetic — no real key, no real data
const SOAK = process.env.KS_SOAK === '1';
const ROWS = Number(process.env.KS_ROWS) || (SOAK ? 30000 : 12000);
const N = (name, dflt) => Number(process.env[`KS_ROUNDS_${name}`]) || dflt;

// ── the adapter's EXACT open path (src/adapter/d1.js:48-96) ─────────────────
export function openVault(path, { readonly = false, bootShape = false } = {}) {
  const db = new Database(path, readonly ? { readonly: true, fileMustExist: true } : {});
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key="x'${KEY}'"`);
  db.pragma('temp_store = MEMORY');
  if (!bootShape && !readonly) {
    // adapter shape (d1.js:62-96); the boot handle (init.js:408-413) sets NONE of these
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_size_limit = 67108864');
    db.pragma('cell_size_check = ON');
    db.pragma('fullfsync = 1');
  }
  return db;
}

// ── generic row filler: introspect real columns, satisfy NOT NULLs ──────────
function makeInsert(db, table, overrides = {}) {
  const cols = db.pragma(`table_info(${table})`);
  const use = cols.filter((c) => c.pk === 1 || c.notnull === 1 || c.name in overrides
    || ['user_id', 'content', 'created_at', 'scope'].includes(c.name));
  const names = use.map((c) => c.name);
  const stmt = db.prepare(`INSERT OR IGNORE INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`);
  return (vals) => stmt.run(names.map((n) => {
    if (n in vals) return vals[n];
    const c = use.find((x) => x.name === n);
    if (/INT|REAL|NUM/i.test(c.type || '')) return 0;
    return '';
  }));
}

// ═════════════════════════════ CHILD MODES ══════════════════════════════════
// KS_ROLE: app | bridge | boot | ckpt | leader — each models a real writer
// (topology doc §2.5). Children run until SIGKILLed; commit counts go to an
// append-only ledger so the parent can reconcile durability after the kill.
if (process.env.KS_ROLE) {
  const role = process.env.KS_ROLE;
  const path = process.env.KS_DB;
  const tag = process.env.KS_TAG || 'x';
  const ledger = `${path}.ledger-${role}-${tag}`;
  const mark = (() => { let n = 0; return () => { if (++n % 25 === 0) appendFileSync(ledger, `${n}\n`); return n; }; })();

  try {
    if (role === 'leader') {
      // group-sweep target: owns a pgid (spawned detached); its children inherit it —
      // the parent kills -pid, modeling crash-reaper.js:109-114.
      const mk = (r, t) => spawn(process.execPath, [SELF], {
        env: { ...process.env, KS_ROLE: r, KS_TAG: t }, stdio: 'ignore',
      });
      mk('app', `${tag}a`); mk('bridge', `${tag}b`);
      setInterval(() => {}, 1000); // stay alive until swept
      await new Promise(() => {}); // never fall through into the parent section
    } else if (role === 'app') {
      // server-rest shape: Telegram 3-commit ingest + per-row embed UPDATE storm
      // + periodic wal_checkpoint(TRUNCATE) (backfill.js:102 shape).
      const db = openVault(path);
      const insMsg = makeInsert(db, 'messages');
      const hasAtt = db.prepare(`SELECT 1 FROM sqlite_master WHERE name='attachments'`).get();
      const insAtt = hasAtt ? makeInsert(db, 'attachments') : null;
      const upd = db.prepare(`UPDATE messages SET embedding_768 = ? WHERE id = ?`);
      for (let i = 0; ; i++) {
        const id = `app-${tag}-${i}`;
        try {
          if (insAtt) insAtt({ id: `att-${tag}-${i}`, user_id: `u-${tag}`, local_path: `/blob/${i}` });
          insMsg({ id, user_id: `u-${tag}`, content: `m ${'y'.repeat(180)}`, created_at: new Date().toISOString() });
          mark();
          if (i % 7 === 0) { // embed-drain burst: per-row autocommits (messages.js:466 shape)
            for (let k = 0; k < 12; k++) { try { upd.run(Buffer.alloc(96, k), `app-${tag}-${Math.max(0, i - k)}`); } catch { /* busy */ } }
          }
          if (i % 40 === 0) { try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* busy */ } }
        } catch { /* busy — keep hammering */ }
      }
    } else if (role === 'bridge') {
      // vault-bridge shape: 50-stmt real transactions (/batch, vault-bridge.js:158)
      // interleaved with autocommit loops (/batch_encrypted) + fisher-style upserts.
      const db = openVault(path);
      const insCp = makeInsert(db, 'clustering_points');
      // clustering_points carries a UNIQUE constraint over source columns (measured:
      // identical source_type/source_id → OR IGNORE skips, changes=0) — every row gets
      // distinct source_id so the ledger's committed count is honest.
      const tx = db.transaction((batchTag, base) => {
        for (let k = 0; k < 50; k++) {
          insCp({ id: `cp-${batchTag}-${k}`, user_id: batchTag, message_id: `m-${base + k}`, source_type: 'h', source_id: `${batchTag}-${k}` });
        }
      });
      const insFt = (() => {
        try { return makeInsert(db, 'fisher_trajectory'); } catch { return null; }
      })();
      for (let b = 0; ; b++) {
        const batchTag = `bt-${tag}-${b}`;
        try { tx(batchTag, b * 50); mark(); } catch { /* busy */ }
        // autocommit loop shape (/batch_encrypted): 10 singles
        for (let k = 0; k < 10; k++) { try { insCp({ id: `ac-${tag}-${b}-${k}`, user_id: `ac-${tag}`, source_type: 'h', source_id: `ac-${tag}-${b}-${k}` }); } catch { /* busy */ } }
        if (insFt && b % 5 === 0) { try { insFt({ id: `ft-${tag}-${b}`, user_id: `u-${tag}`, level: 0 }); } catch { /* busy/shape */ } }
      }
    } else if (role === 'boot') {
      // init.js:408 shape: raw latch-less handle (cipher/key/temp_store ONLY, no WAL
      // pragma, better-sqlite3 default busy_timeout=0) running the REAL migrations,
      // with the self-heal branch periodically forced (drop a leaf table → full re-apply).
      const { applyMigrations } = await import(join(ROOT, 'src/db/migrate.js'));
      for (let r = 0; ; r++) {
        const db = openVault(path, { bootShape: true });
        try {
          if (r % 2 === 1) { try { db.exec('DROP TABLE IF EXISTS oauth_states'); } catch { /* busy */ } }
          applyMigrations(db, MIGRATIONS);
          appendFileSync(ledger, `boot-round ${r}\n`);
        } catch { /* busy/locked — the real boot would crash-loop; we loop */ }
        try { db.close(); } catch { /* */ }
        await new Promise((res) => setTimeout(res, 30));
      }
    } else if (role === 'snap') {
      // snapshot-worker.mjs shape: repeated read-only VACUUM INTO — a long READ
      // transaction that starves checkpoints while writers hammer (the 08:09 snapshot
      // sits at the incident window's edge).
      for (let i = 0; ; i++) {
        const db = openVault(path, { readonly: true });
        const out = `${path}.snap-${tag}-${i % 3}`;
        try { rmSync(out, { force: true }); } catch { /* */ }
        try { db.exec(`VACUUM INTO '${out}'`); appendFileSync(ledger, `snap ${i}\n`); } catch { /* busy */ }
        try { db.close(); } catch { /* */ }
      }
    } else if (role === 'ckpt') {
      // checkpoint hammer, with a stdout marker right before each checkpoint so the
      // parent can time SIGKILL into the checkpoint body.
      const db = openVault(path);
      const insMsg = makeInsert(db, 'messages');
      for (let i = 0; ; i++) {
        try { insMsg({ id: `ck-${tag}-${i}`, user_id: `u-ck`, content: 'c'.repeat(400), created_at: new Date().toISOString() }); } catch { /* busy */ }
        if (i % 3 === 0) {
          process.stdout.write('C\n');
          try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* busy */ }
        }
      }
    }
  } catch (e) {
    // A corrupt read inside a child is a FINDING, not a crash: signal via exit code.
    if (/malformed|SQLITE_CORRUPT/i.test(String(e?.message))) process.exit(9);
    console.error(`[${role}] ${e.message}`); process.exit(3);
  }
  process.exit(0); // a child role must NEVER fall through into the parent section
}

// ═════════════════════════════ PARENT ═══════════════════════════════════════

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORPSES = process.env.KS_CORPSE_DIR || join(tmpdir(), 'myc-killstorm-corpses');
mkdirSync(CORPSES, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), 'myc-killstorm-'));
const TEMPLATE = join(dir, 'template.db');

function seedTemplate() {
  const t0 = Date.now();
  const { execSync } = { execSync: null }; // no shell — keep it explicit below
  const db = openVault(TEMPLATE);
  // real schema: the actual migrations, exactly as boot applies them
  return import(join(ROOT, 'src/db/migrate.js')).then(({ applyMigrations }) => {
    applyMigrations(db, MIGRATIONS);
    const insMsg = makeInsert(db, 'messages');
    const seedTx = db.transaction(() => {
      for (let i = 0; i < ROWS; i++) {
        insMsg({ id: `seed-${i}`, user_id: 'u-seed', content: `s ${'x'.repeat(180)}`, created_at: new Date(1700000000000 + i * 1000).toISOString() });
      }
    });
    seedTx();
    db.pragma('wal_checkpoint(TRUNCATE)');
    const n = db.prepare('SELECT count(*) c FROM messages').get().c;
    db.close();
    console.log(`  template seeded: ${n} messages, real schema, ${Date.now() - t0} ms`);
    return n;
  });
}

let SEEDED = 0;

// APFS clonefile (cp -c) → instant per-round copies; fall back to plain copy.
function cloneFamily(src, dst) {
  for (const sfx of ['', '-wal', '-shm']) {
    if (!existsSync(src + sfx)) continue;
    try { execFileSync('cp', ['-c', src + sfx, dst + sfx]); }
    catch { copyFileSync(src + sfx, dst + sfx); }
  }
}
function rmFamily(p) {
  for (const f of readdirSync(dirname(p))) {
    if (f.startsWith(p.split('/').pop())) { try { rmSync(join(dirname(p), f)); } catch { /* */ } }
  }
}

/**
 * Verify one round's vault. Returns { verdict, detail }:
 *   CLEAN       — quick_check ok, counts reconcile
 *   STRUCTURAL  — the DB opens/decrypts but reports structural rows (D-140 class)
 *   UNREADABLE  — open/first-read throws (decrypt-layer or headerless: torn class)
 *   PARTIAL_TXN — a 50-stmt /batch transaction is visible partially applied
 *   LOST_COMMIT — committed (ledgered) rows are missing after the kill
 */
function verifyVault(p, { corpseTag } = {}) {
  // preserve BEFORE the verify-open mutates the family via WAL recovery
  const corpse = join(CORPSES, `${corpseTag || 'round'}-${Date.now()}`);
  cloneCorpse: {
    mkdirSync(corpse, { recursive: true });
    for (const sfx of ['', '-wal', '-shm']) {
      if (existsSync(p + sfx)) { try { execFileSync('cp', ['-c', p + sfx, join(corpse, `v.db${sfx}`)]); } catch { copyFileSync(p + sfx, join(corpse, `v.db${sfx}`)); } }
    }
  }
  let db;
  try {
    db = openVault(p);
    db.prepare('SELECT count(*) c FROM sqlite_master').get();
  } catch (e) {
    try { db?.close(); } catch { /* */ }
    return { verdict: 'UNREADABLE', detail: String(e.message).slice(0, 120), corpse };
  }
  try {
    const qc = db.pragma('quick_check');
    const qcTxt = qc.map((r) => r.quick_check ?? Object.values(r)[0]).join(' | ');
    if (qcTxt !== 'ok') {
      let icTxt = '';
      try { icTxt = db.pragma('integrity_check').map((r) => Object.values(r)[0]).join(' | ').slice(0, 300); } catch (e) { icTxt = `ic threw: ${e.message}`; }
      db.close();
      return { verdict: 'STRUCTURAL', detail: `${qcTxt.slice(0, 200)} ── ${icTxt}`, corpse };
    }
    // reconciliation: ledgered commits must all be present (synchronous=NORMAL WAL —
    // a SIGKILL cannot lose a committed txn; only power loss can)
    for (const f of readdirSync(dirname(p)).filter((f) => f.includes('.ledger-'))) {
      const lines = readFileSync(join(dirname(p), f), 'utf8').trim().split('\n').filter(Boolean);
      if (!lines.length || f.includes('-boot-')) continue;
      const floor = Number(lines[lines.length - 1]) || 0;
      const m = f.match(/\.ledger-([a-z]+)-(.+)$/); // tags may contain hyphens (k5-0a)
      const role = m?.[1];
      const tag = m?.[2];
      if (!role || !tag) continue;
      if (role === 'app') {
        const c = db.prepare(`SELECT count(*) c FROM messages WHERE id LIKE 'app-${tag}-%'`).get().c;
        if (c < floor) { db.close(); return { verdict: 'LOST_COMMIT', detail: `app-${tag}: ledger ${floor} > present ${c}`, corpse }; }
      } else if (role === 'bridge') {
        const c = db.prepare(`SELECT count(*) c FROM clustering_points WHERE id LIKE 'cp-bt-${tag}-%'`).get().c;
        if (c < floor * 50) { db.close(); return { verdict: 'LOST_COMMIT', detail: `bridge-${tag}: ledger ${floor} batches > present ${c} rows`, corpse }; }
      }
    }
    // /batch atomicity: every 50-stmt transaction is all-or-nothing
    const partial = db.prepare(
      `SELECT user_id, count(*) c FROM clustering_points WHERE user_id LIKE 'bt-%' GROUP BY user_id HAVING c % 50 != 0`,
    ).all();
    if (partial.length) {
      db.close();
      return { verdict: 'PARTIAL_TXN', detail: partial.slice(0, 3).map((r) => `${r.user_id}=${r.c}`).join(','), corpse };
    }
    db.close();
    rmSync(corpse, { recursive: true, force: true }); // clean round → no corpse
    return { verdict: 'CLEAN', detail: '', corpse: null };
  } catch (e) {
    try { db.close(); } catch { /* */ }
    return { verdict: 'STRUCTURAL', detail: `during checks: ${String(e.message).slice(0, 120)}`, corpse };
  }
}

// NOTE (measured 2026-08-06): the real `sqlcipher` CLI CANNOT adjudicate corpses —
// it fails HMAC on page 1 of even a CLEAN file created by better-sqlite3-multiple-
// ciphers, and mc itself silently no-ops `PRAGMA cipher_integrity_check`. There is
// therefore NO working page-authenticity discriminator for this build's files; the
// harness's evidence is WHICH INTERRUPTION MODE corrupts, and corpses are preserved
// for manual autopsy only. (This also means the D-140 row's "every page HMAC
// authenticates" forensic claim is unverifiable with either tool — recorded there.)

const results = [];
function record(scenario, round, r) {
  results.push({ scenario, round, ...r });
  if (r.verdict !== 'CLEAN') {
    console.log(`  ❌ ${scenario} round ${round}: ${r.verdict} — ${r.detail}`);
    console.log(`     corpse: ${r.corpse}`);
  }
}

const mkChild = (roundDb, role, tag, extraEnv = {}) => spawn(process.execPath, [SELF], {
  env: { ...process.env, KS_ROLE: role, KS_DB: roundDb, KS_TAG: tag, ...extraEnv },
  stdio: role === 'ckpt' ? ['ignore', 'pipe', 'ignore'] : 'ignore',
});
const killHard = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
// NB: a SIGKILLed child has exitCode === null and signalCode === 'SIGKILL'; checking
// exitCode alone leaves the promise pending forever and drains the event loop.
const waitExit = (child) => (child.exitCode !== null || child.signalCode !== null)
  ? Promise.resolve()
  : new Promise((r) => child.once('exit', r));

function roundPath(scenario, round) {
  const d = join(dir, `${scenario}-${round}`);
  mkdirSync(d, { recursive: true });
  const p = join(d, 'v.db');
  cloneFamily(TEMPLATE, p);
  return p;
}

// ── scenarios ───────────────────────────────────────────────────────────────

async function K1(rounds) { // SIGKILL individual writers mid-transaction
  console.log(`\nK1 — SIGKILL writers mid-transaction (${rounds} rounds)`);
  for (let r = 0; r < rounds; r++) {
    const p = roundPath('K1', r);
    const a = mkChild(p, 'app', `k1a${r}`);
    const b = mkChild(p, 'bridge', `k1b${r}`);
    await sleep(250 + Math.random() * 350);
    killHard(a.pid); await sleep(20 + Math.random() * 60); killHard(b.pid);
    await Promise.all([waitExit(a), waitExit(b)]);
    record('K1', r, verifyVault(p, { corpseTag: `K1-${r}` }));
  }
}

async function K2(rounds) { // SIGKILL timed into wal_checkpoint(TRUNCATE)
  console.log(`\nK2 — checkpoint-timed SIGKILL (${rounds} rounds)`);
  for (let r = 0; r < rounds; r++) {
    const p = roundPath('K2', r);
    const w = mkChild(p, 'app', `k2w${r}`);
    const c = mkChild(p, 'ckpt', `k2c${r}`);
    let killed = false;
    let seen = 0;
    const target = 3 + Math.floor(Math.random() * 6);
    c.stdout.on('data', (buf) => {
      seen += String(buf).split('C').length - 1;
      if (!killed && seen >= target) {
        killed = true;
        setTimeout(() => { killHard(c.pid); killHard(w.pid); }, Math.floor(Math.random() * 12)); // land INSIDE the checkpoint body
      }
    });
    await sleep(900);
    if (!killed) { killHard(c.pid); killHard(w.pid); }
    await Promise.all([waitExit(w), waitExit(c)]);
    record('K2', r, verifyVault(p, { corpseTag: `K2-${r}` }));
  }
}

async function K3(rounds) { // the D-136 group sweep: SIGKILL the whole process group at once
  console.log(`\nK3 — group-sweep SIGKILL of the whole family (${rounds} rounds)`);
  for (let r = 0; r < rounds; r++) {
    const p = roundPath('K3', r);
    const leader = spawn(process.execPath, [SELF], {
      env: { ...process.env, KS_ROLE: 'leader', KS_DB: p, KS_TAG: `k3-${r}` },
      stdio: 'ignore', detached: true, // own pgid — the sweep target
    });
    await sleep(400 + Math.random() * 400);
    try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* */ }
    await waitExit(leader);
    await sleep(80); // grandchildren die with the group
    record('K3', r, verifyVault(p, { corpseTag: `K3-${r}` }));
  }
}

async function K4(rounds) { // S1: orphan writer overlapping the next generation's boot
  console.log(`\nK4 — orphan-overlap: gen-N writer survives while gen-N+1 boots + writes (${rounds} rounds)`);
  const { applyMigrations } = await import(join(ROOT, 'src/db/migrate.js'));
  for (let r = 0; r < rounds; r++) {
    const p = roundPath('K4', r);
    const orphan = mkChild(p, 'bridge', `k4o${r}`); // gen-N pipeline child, never told to stop
    await sleep(150);
    // gen N+1 "boot": DDL/self-heal on the raw latch-less handle, racing the orphan
    const bootDb = openVault(p, { bootShape: true });
    try { bootDb.exec('DROP TABLE IF EXISTS oauth_states'); } catch { /* busy */ }
    try { applyMigrations(bootDb, MIGRATIONS); } catch { /* busy — real boot would retry */ }
    try { bootDb.close(); } catch { /* */ }
    // gen N+1 app writer + checkpoints, still racing the orphan
    const app = mkChild(p, 'app', `k4n${r}`);
    await sleep(350 + Math.random() * 250);
    killHard(orphan.pid); // the orphan finally dies mid-write
    await sleep(120);
    killHard(app.pid);
    await Promise.all([waitExit(orphan), waitExit(app)]);
    record('K4', r, verifyVault(p, { corpseTag: `K4-${r}` }));
  }
}

async function K5(cycles) { // the 32-boot crash-loop replay
  console.log(`\nK5 — crash-loop replay (${cycles} boot cycles on ONE vault)`);
  const p = roundPath('K5', 0);
  for (let c = 0; c < cycles; c++) {
    const leader = spawn(process.execPath, [SELF], {
      env: { ...process.env, KS_ROLE: 'leader', KS_DB: p, KS_TAG: `k5-${c}` },
      stdio: 'ignore', detached: true,
    });
    await sleep(180 + Math.random() * 250);
    try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* */ }
    await waitExit(leader);
    await sleep(50);
    // the next "boot": open → WAL recovery → brief write → close (then loop kills again)
    try {
      const db = openVault(p);
      const qc = db.pragma('quick_check');
      const t = qc.map((r0) => Object.values(r0)[0]).join('');
      db.close();
      if (t !== 'ok') { record('K5', c, verifyVault(p, { corpseTag: `K5-${c}` })); return; }
    } catch (e) {
      record('K5', c, { verdict: 'UNREADABLE', detail: String(e.message).slice(0, 120), corpse: null });
      return;
    }
  }
  record('K5', cycles, verifyVault(p, { corpseTag: 'K5-final' }));
}

async function K6(rounds) { // snapshot VACUUM INTO racing writers + kill storms
  console.log(`\nK6 — read-only VACUUM INTO (snapshot shape) racing writers, killed mid-copy (${rounds} rounds)`);
  for (let r = 0; r < rounds; r++) {
    const p = roundPath('K6', r);
    const s = mkChild(p, 'snap', `k6s${r}`);
    const a = mkChild(p, 'app', `k6a${r}`);
    const c = mkChild(p, 'ckpt', `k6c${r}`);
    await sleep(500 + Math.random() * 400);
    [s, a, c].forEach((x) => killHard(x.pid));
    await Promise.all([s, a, c].map(waitExit));
    record('K6', r, verifyVault(p, { corpseTag: `K6-${r}` }));
  }
}

async function P1(rounds) { // POSITIVE CONTROL: split -shm (a known corruption recipe)
  console.log(`\nP1 — positive control: unlink -shm under live writers, add a third writer (${rounds} rounds)`);
  for (let r = 0; r < rounds; r++) {
    const p = roundPath('P1', r);
    const a = mkChild(p, 'app', `p1a${r}`);
    const b = mkChild(p, 'bridge', `p1b${r}`);
    await sleep(300);
    try { unlinkSync(`${p}-shm`); } catch { /* not there yet */ }
    const c = mkChild(p, 'app', `p1c${r}`); // opens AFTER the unlink → fresh -shm → split brain
    await sleep(1200);
    [a, b, c].forEach((x) => killHard(x.pid));
    await Promise.all([a, b, c].map(waitExit));
    record('P1', r, verifyVault(p, { corpseTag: `P1-${r}` }));
  }
}

async function P2(rounds) { // POSITIVE CONTROL: stale-db + hot-WAL splice (restore-shape)
  console.log(`\nP2 — positive control: stale db swapped in under a hot -wal (${rounds} rounds)`);
  for (let r = 0; r < rounds; r++) {
    const p = roundPath('P2', r);
    const stale = `${p}.stale`;
    // cold copy = the "restored" file (same salt, same key). cp -c (APFS clonefile)
    // is darwin-only — GNU cp rejects it (CI ubuntu, measured) — so fall back.
    try { execFileSync('cp', ['-c', p, stale]); } catch { copyFileSync(p, stale); }
    const w = mkChild(p, 'app', `p2w${r}`);
    await sleep(700); // advance db + wal well past the stale copy
    killHard(w.pid); await waitExit(w); // leaves a hot -wal
    // the splice: swap the stale db under the newer generation's -wal (install/restore shape)
    unlinkSync(p); copyFileSync(stale, p);
    try { unlinkSync(`${p}-shm`); } catch { /* force wal-index recovery */ }
    record('P2', r, verifyVault(p, { corpseTag: `P2-${r}` })); // recovery replays new frames onto the stale db
  }
}

function P3() { // DETECTOR CONTROL: the LOST_COMMIT branch (review round 2, M10)
  // No processes: fabricate a ledger floor above the actual row count on a clean
  // clone — reconciliation must convict. Without this, deleting the reconciliation
  // branch survived GO (both process-controls corrupt structurally first).
  console.log(`\nP3 — detector control: ledger floor above row count → LOST_COMMIT`);
  const p = roundPath('P3', 0);
  appendFileSync(`${p}.ledger-app-p3x`, '999999\n');
  record('P3', 0, verifyVault(p, { corpseTag: 'P3-0' }));
}

function P4() { // DETECTOR CONTROL: the PARTIAL_TXN branch (review round 2, M11)
  // A /batch tag with 30 of 50 rows on an otherwise-clean vault — atomicity
  // accounting must convict.
  console.log(`\nP4 — detector control: 30/50 rows under one batch tag → PARTIAL_TXN`);
  const p = roundPath('P4', 0);
  const db = openVault(p);
  const ins = makeInsert(db, 'clustering_points');
  for (let k = 0; k < 30; k++) ins({ id: `cp-bt-p4x-0-${k}`, user_id: 'bt-p4x-0', message_id: `m-${k}`, source_type: 'h', source_id: `p4x-${k}` });
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  record('P4', 0, verifyVault(p, { corpseTag: 'P4-0' }));
}

// ── run ─────────────────────────────────────────────────────────────────────
console.log(`vault kill-storm — synthetic SQLCipher, ${ROWS} rows, real schema, adapter-exact pragmas`);
console.log(`temp: ${dir}\ncorpses: ${CORPSES}`);

SEEDED = await seedTemplate();

const t0 = Date.now();
await K1(N('K1', SOAK ? 200 : 8));
await K2(N('K2', SOAK ? 400 : 12));
await K3(N('K3', SOAK ? 200 : 8));
await K4(N('K4', SOAK ? 200 : 8));
await K5(N('K5', 32));
await K6(N('K6', SOAK ? 200 : 8));
await P1(N('P1', SOAK ? 10 : 3));
await P2(N('P2', SOAK ? 6 : 2));
P3();
P4();

// ── verdict ─────────────────────────────────────────────────────────────────
const by = (s) => results.filter((r) => r.scenario === s);
const bad = (s) => by(s).filter((r) => r.verdict !== 'CLEAN');
const killScenarios = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6'];
const killCorrupt = killScenarios.flatMap(bad);
const p1Corrupt = bad('P1').length;
const p2Corrupt = bad('P2').length;
const p3Lost = by('P3').filter((r) => r.verdict === 'LOST_COMMIT').length;
const p4Partial = by('P4').filter((r) => r.verdict === 'PARTIAL_TXN').length;

console.log(`\n──── SUMMARY (${Math.round((Date.now() - t0) / 1000)} s) ────`);
for (const s of [...killScenarios, 'P1', 'P2', 'P3', 'P4']) {
  const all = by(s); const b = bad(s);
  const label = s === 'K5' ? `${all.length - b.length}/${all.length} loop(s) of 32 cycles clean` : `${all.length - b.length}/${all.length} clean`;
  console.log(`  ${s}: ${label}${b.length ? ` — ${b.map((x) => x.verdict).join(',')}` : ''}`);
}

// Gate semantics: kill rounds must be CLEAN, and every positive control must CONVICT
// on its own branch — a harness that cannot corrupt anything (or a detector missing a
// branch) cannot prove the kill rounds mean anything (M-001). P3/P4 pin the
// LOST_COMMIT and PARTIAL_TXN branches specifically (review round 2: both branches
// survived deletion when only the structural controls existed).
const controlsProveTeeth = p1Corrupt > 0 && p2Corrupt > 0 && p3Lost > 0 && p4Partial > 0;
if (killCorrupt.length) {
  console.log(`\nVERDICT: REPRODUCED — ${killCorrupt.length} kill round(s) corrupted the vault. Corpses preserved for autopsy.`);
  process.exit(1);
} else if (!controlsProveTeeth) {
  console.log(`\nVERDICT: NO-CONFIDENCE — kill rounds clean but controls did not all convict (P1=${p1Corrupt}, P2=${p2Corrupt}, P3 LOST_COMMIT=${p3Lost}, P4 PARTIAL_TXN=${p4Partial}); the detector is unproven. EXIT 1.`);
  process.exit(1);
} else {
  console.log(`\nVERDICT: GO — every kill round clean; all four positive controls convicted on their branches (detector has teeth). EXIT 0.`);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  try { rmSync(CORPSES, { recursive: true, force: true }); } catch { /* control corpses only — kill-round corpses never reach a GO */ }
  process.exit(0);
}
