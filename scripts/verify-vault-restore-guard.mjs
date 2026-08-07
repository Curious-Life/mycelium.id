#!/usr/bin/env node
// verify:vault-restore-guard — D-140 (QA11D): destructive file operations on the vault
// family must REFUSE while any process holds an OPEN FD on it — and must NOT refuse the
// recovery topology (a lease/presence record with zero vault fds), which is the flagship
// "vault condemned → restore a backup" flow.
//
// The kill-storm harness's positive controls prove the mechanism this guards against:
// renaming/unlinking db/-wal/-shm under a live fd splices individually-valid pages into
// a malformed B-tree (P1 split -shm, P2 stale-db+hot-WAL). The guard is fd-level
// (lsof), NOT lease/presence-level: the first revision asked the lease layer and
// adversarial review REPRODUCED the permanent-409 lockout it caused in recovery mode
// (own lease held by a throwing boot + the :4711 sibling's lifetime presence). B3 below
// is that blocker's regression test.
//
// Checks:
//   A. vaultInUse() primitive: free → false · a live OPEN HANDLE on the vault → true ·
//      lease+presence held with ZERO vault fds (recovery topology) → FALSE ·
//      lsof spawn-failure → true (the fail direction, injected via the _exec seam)
//   B. restoreVaultArchive END TO END: open handle → vault_in_use refusal with ZERO
//      disk mutation; handle closed → the SAME restore succeeds; B3: succeeds WITH the
//      lease held and presence files on disk (the reproduced-blocker topology).
//   C. keyOpensVault -shm hygiene: free → the probe's -shm is removed · open handle →
//      the -shm is LEFT (never unlink under a live fd).
//   D. the forensic ring THROUGH THE REAL ADAPTER: a write with a user literal
//      containing a canary reaches the sqlite-corrupt event as verb+table ONLY — the
//      canary must appear NOWHERE in the durability log (CLAUDE.md §1), and the wiring
//      (d1.js → noteWriteShape) is what carries it, not a direct call.
//
// MUTATION-TESTED: (D-140, 2026-08-06) the vaultInUse guard in restoreVaultArchive
// deleted (the pre-fix shape: move-aside proceeds regardless) → B1 RED
// ("restore succeeded despite live holder", B1b reports the family WAS moved)
// while A*/C*/D* stay GREEN. Restored → GO.
// MUTATION-TESTED: (D-140, 2026-08-06, re-run after the C2 split) the keys.js -shm
// cleanup guard reverted to the unconditional `rmSync` → C2b RED on darwin (the -shm
// vanishes from under the live holder — the split-brain recipe) while C1/C2a stay
// GREEN. Restored → GO. (C2b is darwin-only: ubuntu CI 2026-08-06 showed SQLite may
// itself unlink a sole-user shm on close — safe, and why the check is split.)
// MUTATION-TESTED: (D-140, 2026-08-06, round 2) vaultInUse fail direction flipped
// (spawn-failure → `return false`; the fail-open shape review M1 found untested) →
// A5 RED (injected failing exec reads as "free"). Restored → GO.
// MUTATION-TESTED: (D-140, 2026-08-06, round 2) d1.js:167 `noteWriteShape(sql)` fed RAW
// SQL instead of sqlShape(sql) (the §1 plaintext-leak shape review M6 found both gates
// blind to) → D3 RED (the canary literal appears in durability-events.jsonl) and D1 RED
// (counts keyed by raw SQL, not shapes). Restored → GO.
// MUTATION-TESTED: (D-140, 2026-08-06, round 2) d1.js:167 noteWriteShape call DELETED
// (review M7's surviving mutant — the old check D proved the ring, never the wiring) →
// D1 RED (inFlight.counts empty despite real adapter writes). Restored → GO.
// MUTATION-TESTED: (D-140, 2026-08-06, round 3 — the re-review BLOCKER) vaultInUse's
// spawn-failure discriminator reverted to `e.status === undefined` (real Node ENOENT
// carries status: null, so that shape fails OPEN — reproduced by review) → A5 RED
// (the injected real-shape error reads as "free"). Restored → GO.
// MUTATION-TESTED: (D-140, 2026-08-06, round 3 — review mutant N1) the lsof family
// list narrowed to db-only (-wal/-shm silently dropped) → A6 RED (a sidecar-only
// holder — a backup tool mid-copy of the -wal — reads as "free"). Restored → GO.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';

const readdirLocal = (d) => { try { return readdirSync(d); } catch { return []; } };

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');

const ledger = [];
let allPass = true;
function rec(name, pass, detail = '') {
  ledger.push(`  [${pass ? '✓' : '✗'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) allPass = false;
}

const dir = mkdtempSync(join(tmpdir(), 'myc-restore-guard-'));
const dbPath = join(dir, 'mycelium.db');
const kcvPath = join(dir, 'kcv.json');

// A synthetic user key — the vault is encrypted with deriveDbKey(userHex), exactly as
// the app does it, so keyOpensVault's real derivation path runs.
const { deriveDbKey } = await import(join(ROOT, 'src/account/keystore.js'));
const userHex = 'b'.repeat(64);
const dbKeyHex = deriveDbKey(userHex);

function makeVault() {
  const db = new Database(dbPath);
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key="x'${dbKeyHex}'"`);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, v TEXT)');
  db.prepare('INSERT OR REPLACE INTO t VALUES (?, ?)').run('k', 'v');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}
makeVault();
writeFileSync(kcvPath, JSON.stringify({ v: 1, user: {}, system: {} })); // presence only; unlock() is not under test

const { vaultInUse } = await import(join(ROOT, 'src/db/vault-lease.js'));

// a live holder with a REAL OPEN FD on the vault — what the guard actually refuses
function holdVaultOpen() {
  const h = new Database(dbPath);
  h.pragma(`cipher='sqlcipher'`); h.pragma(`key="x'${dbKeyHex}'"`);
  h.prepare('SELECT count(*) FROM sqlite_master').get();
  return { release: () => { try { h.close(); } catch { /* */ } } };
}

// ── A. the primitive (fd-level semantics) ───────────────────────────────────
rec('A1 settled vault, no open fds → vaultInUse false', vaultInUse(dbPath) === false);
{
  const h = holdVaultOpen();
  rec('A2 a live OPEN HANDLE on the vault → vaultInUse true', vaultInUse(dbPath) === true);
  h.release();
}
{
  // THE BLOCKER TOPOLOGY (review round 1, reproduced): lease held + presence files on
  // disk, but ZERO vault fds — recovery mode. The guard must answer FALSE.
  const lockPath = join(dir, '.vault-ownership');
  const lease = new Database(lockPath, { timeout: 0 });
  lease.exec('BEGIN EXCLUSIVE');
  const presencePath = join(dir, `.vault-presence-99999-abc`);
  const presence = new Database(presencePath, { timeout: 0 });
  presence.exec('BEGIN EXCLUSIVE');
  rec('A3 lease + presence held, zero vault fds (recovery topology) → vaultInUse FALSE',
    vaultInUse(dbPath) === false);
  try { presence.exec('ROLLBACK'); } catch { /* */ } presence.close(); rmSync(presencePath, { force: true });
  try { lease.exec('ROLLBACK'); } catch { /* */ } lease.close();
  rmSync(lockPath, { force: true }); rmSync(`${lockPath}.json`, { force: true });
}
rec('A4 all released → vaultInUse false (no lockout)', vaultInUse(dbPath) === false);
{
  // the FAIL DIRECTION (review M1 + round-2 blocker): an lsof that cannot run must
  // read as IN USE. The injected error carries the REAL Node ENOENT shape —
  // `status: null`, NOT undefined (round 2 reproduced a fail-open exactly because
  // the earlier injected shape had no status property, which real Node never throws).
  const failingExec = () => { throw Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT', status: null, stdout: undefined }); };
  rec('A5 lsof spawn-failure (real ENOENT shape: status null) → vaultInUse true (fail closed)',
    vaultInUse(dbPath, () => {}, { _exec: failingExec }) === true);
}
{
  // review round 2, mutant N1 (family list silently narrowed): a holder with an fd
  // on ONLY a sidecar — a backup tool mid-copy of the -wal — must still count.
  // Renaming a hot -wal out from under such a reader is the P2 splice shape.
  const { spawn } = await import('node:child_process');
  writeFileSync(`${dbPath}-wal`, Buffer.alloc(32)); // a wal to hold (content irrelevant)
  const sidecarHolder = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const fd = fs.openSync(process.env.W_PATH, 'r');
    console.log('ready');
    setInterval(() => {}, 1000);
  `], { env: { ...process.env, W_PATH: `${dbPath}-wal` }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('sidecar holder never ready')), 15000);
    sidecarHolder.stdout.on('data', (d) => { if (String(d).includes('ready')) { clearTimeout(t); res(); } });
    sidecarHolder.on('exit', () => { clearTimeout(t); rej(new Error('sidecar holder died')); });
  }).catch((e) => rec('A6 sidecar holder ready', false, e.message));
  rec('A6 an fd on ONLY the -wal (no db handle) → vaultInUse true (family list not narrowed)',
    vaultInUse(dbPath) === true);
  try { sidecarHolder.kill('SIGKILL'); } catch { /* */ }
  rmSync(`${dbPath}-wal`, { force: true });
}

// ── B. restoreVaultArchive end to end ───────────────────────────────────────
const { streamVaultArchive, restoreVaultArchive } = await import(join(ROOT, 'src/account/backup.js'));

// a real archive of the synthetic vault, via the real exporter (which derives the
// db key from env exactly as the app does — synthetic key, synthetic vault)
process.env.USER_MASTER = userHex;
process.env.ENCRYPTION_MASTER_KEY = userHex; // streamVaultArchive's key source (backup.js:344)
process.env.MYCELIUM_DB = dbPath;
const chunks = [];
await streamVaultArchive({
  dbPath, kcvPath, uploadsRoot: null, remoteConfigPath: null, mindRoot: null, voiceSamplesRoot: null,
  out: new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } }),
});
const archive = Buffer.concat(chunks);
rec('B0 exporter produced an archive', archive.length > 500, `${archive.length} bytes`);

{
  const h = holdVaultOpen();
  let code = null;
  try {
    await restoreVaultArchive({ buffer: archive, dbPath, kcvPath, uploadsRoot: null, mindRoot: null, voiceSamplesRoot: null, overwrite: true });
  } catch (e) { code = e?.code; }
  rec('B1 open vault handle → restore REFUSED with vault_in_use', code === 'vault_in_use', `code=${code}`);
  const movedAside = readdirLocal(dir).filter((f) => f.includes('.pre-restore.'));
  rec('B1b zero disk mutation on refusal (db in place, no .pre-restore.* siblings)',
    existsSync(dbPath) && movedAside.length === 0, movedAside.join(',').slice(0, 80));
  h.release();
}
{
  let err = null;
  try {
    await restoreVaultArchive({ buffer: archive, dbPath, kcvPath, uploadsRoot: null, mindRoot: null, voiceSamplesRoot: null, overwrite: true });
  } catch (e) { err = e; }
  rec('B2 handle closed → the SAME restore succeeds (guard is not a lockout)', err === null, err ? `${err.code || err.message}` : '');
  rec('B2b restored vault opens and reads', (() => {
    try {
      const db = new Database(dbPath, { readonly: true });
      db.pragma(`cipher='sqlcipher'`); db.pragma(`key="x'${dbKeyHex}'"`);
      const v = db.prepare('SELECT v FROM t WHERE id=?').get('k')?.v;
      db.close();
      return v === 'v';
    } catch { return false; }
  })());
}
{
  // B3 — the reproduced blocker's REGRESSION TEST: restore must SUCCEED while the
  // lease is held and presence files exist, as long as no vault fd is open (recovery
  // mode: boot claimed, then the corrupt-marker check refused; the sibling idles).
  const lockPath = join(dir, '.vault-ownership');
  const lease = new Database(lockPath, { timeout: 0 });
  lease.exec('BEGIN EXCLUSIVE');
  const presencePath = join(dir, `.vault-presence-99999-abc`);
  const presence = new Database(presencePath, { timeout: 0 });
  presence.exec('BEGIN EXCLUSIVE');
  let err = null;
  try {
    await restoreVaultArchive({ buffer: archive, dbPath, kcvPath, uploadsRoot: null, mindRoot: null, voiceSamplesRoot: null, overwrite: true });
  } catch (e) { err = e; }
  rec('B3 recovery topology (lease held, presence on disk, zero vault fds) → restore SUCCEEDS',
    err === null, err ? `${err.code || err.message}` : '');
  try { presence.exec('ROLLBACK'); } catch { /* */ } presence.close(); rmSync(presencePath, { force: true });
  try { lease.exec('ROLLBACK'); } catch { /* */ } lease.close();
  rmSync(lockPath, { force: true }); rmSync(`${lockPath}.json`, { force: true });
}

// ── C. keyOpensVault -shm hygiene ───────────────────────────────────────────
// unlock() with no kcv present reaches keyOpensVault (the KCV-missing branch).
// POSITIVE PRECONDITION (green-for-the-wrong-reason guard): B's restores replaced the
// vault with the archived copy, which is NOT in WAL mode — and a readonly probe only
// materialises a -shm on a WAL db. Re-arm WAL and PROVE it, or C1/C2 test nothing.
{
  const db = new Database(dbPath);
  db.pragma(`cipher='sqlcipher'`); db.pragma(`key="x'${dbKeyHex}'"`);
  const jm = db.pragma('journal_mode = WAL', { simple: true });
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  rec('C0 precondition: vault is in WAL mode (a readonly probe creates a -shm)', jm === 'wal', `journal_mode=${jm}`);
}
rmSync(kcvPath, { force: true });
const { unlock } = await import(join(ROOT, 'src/crypto/keys.js'));
const shm = `${dbPath}-shm`;
{
  rmSync(shm, { force: true });
  await unlock({ userHex, systemHex: 'c'.repeat(64), kcvPath, dbPath }); // creates kcv (key matches)
  rec('C1 no open fds → probe leaves no -shm (presence promise holds)', !existsSync(shm));
  rmSync(kcvPath, { force: true }); // re-arm the probe branch for C2
}
{
  // The holder must be a SEPARATE PROCESS: an in-process holder shares SQLite's shm
  // object (unixInodeInfo), so after the rm below the probe would silently reuse the
  // holder's mapping and never recreate the file — the branch under test never runs.
  // Out-of-process, the probe creates a fresh -shm (shmExisted=false) while the
  // holder's fds keep the vault in use — exactly the split-brain window the guard
  // must refuse to widen.
  // The holder is a PLAIN-FD child (the A6 pattern, proven visible on every CI
  // platform), deliberately not a SQLite child: the guard is fd-level and cannot
  // tell a SQLite fd from any other, and the earlier better-sqlite3 holder was a
  // CI heisenchild — alive on ubuntu with zero vault fds (measured via its own
  // /proc fd table, 2026-08-06) while the identical construction held on darwin.
  const { spawn } = await import('node:child_process');
  const holder = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const a = fs.openSync(process.env.H_DB, 'r');
    console.log('ready');
    setInterval(() => {}, 1000);
  `], { cwd: ROOT, env: { ...process.env, H_DB: dbPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('holder never became ready')), 15000);
    holder.stdout.on('data', (d) => { if (String(d).includes('ready')) { clearTimeout(t); res(); } });
    holder.on('exit', () => { clearTimeout(t); rej(new Error('holder died')); });
  }).catch((e) => rec('C2 holder child ready', false, e.message));
  rmSync(shm, { force: true }); // the probe becomes the shm creator; the holder keeps its unlinked mapping
  await unlock({ userHex, systemHex: 'c'.repeat(64), kcvPath, dbPath });
  // Two claims, split because only one is platform-stable (CI 2026-08-06: the combined
  // check REDded on ubuntu while darwin passed — SQLite itself may legitimately unlink
  // a SOLE-USER shm on close, which is safe: with a second attacher present it cannot
  // take the exclusive DMS lock, so only a private shm ever goes that way):
  //   C2a — the guard SEES the out-of-process holder (lsof over the family). Platform-
  //         independent; if this REDs anywhere, the guard is truly fail-open there.
  //   C2b — the probe-created -shm survives (the guard skipped its rm). Behavioural,
  //         asserted on darwin only — the packaged platform, and where every mutation
  //         is executed (the repo's "behavioural arm not asserted off darwin" idiom,
  //         cf. verify-gate-stdout-flush).
  const inUseNow = vaultInUse(dbPath);
  let c2aDetail = '';
  if (inUseNow !== true) {
    // content-free diagnostics for a platform we cannot debug locally
    let holderAlive = false; try { process.kill(holder.pid, 0); holderAlive = true; } catch { /* */ }
    let lsofRaw = '';
    try { lsofRaw = (await import('node:child_process')).execFileSync('lsof', ['-t', dbPath], { encoding: 'utf8' }).trim().replace(/\n/g, ','); }
    catch (e) { lsofRaw = `status=${e?.status} stdout=${String(e?.stdout || '').trim().replace(/\n/g, ',')}`; }
    // ground truth: what does the holder's own fd table say? (paths under OUR temp dir
    // only — everything else reduced to a count; content-free)
    let fdDump = 'n/a';
    if (process.platform === 'linux') {
      try {
        const names = readdirLocal(`/proc/${holder.pid}/fd`);
        const ours = []; let others = 0;
        for (const fd of names) {
          try {
            const t = (await import('node:fs')).readlinkSync(`/proc/${holder.pid}/fd/${fd}`);
            if (t.includes(dirname(dbPath))) ours.push(t.replace(dirname(dbPath), '~')); else others += 1;
          } catch { others += 1; }
        }
        fdDump = `ours=[${ours.join(' | ')}] others=${others}`;
      } catch (e) { fdDump = `fd-dir unreadable: ${e?.code || e?.message}`; }
    }
    c2aDetail = `holderAlive=${holderAlive} platform=${process.platform} lsofDb:[${lsofRaw}] holderFds:{${fdDump}} family=[${['', '-wal', '-shm'].map((s) => existsSync(dbPath + s) ? 1 : 0).join(',')}]`;
  }
  rec('C2a out-of-process holder is visible to the guard (fd-level)', inUseNow === true, c2aDetail);
  const shmKept = existsSync(shm);
  if (process.platform === 'darwin') {
    rec('C2b the probe-created -shm is LEFT IN PLACE (guard skipped the rm — darwin behavioural arm)', shmKept);
  } else {
    rec(`C2b behavioural arm asserted on darwin only (measured here: shm survived = ${shmKept})`, true);
  }
  try { holder.kill('SIGKILL'); } catch { /* */ }
  rmSync(shm, { force: true });
}

// ── D. the forensic ring THROUGH THE REAL ADAPTER (review M6/M7) ────────────
{
  const CANARY = 'canary_secret_word_9137';
  const childSrc = `
    import Database from 'better-sqlite3';
    import { createDb } from ${JSON.stringify(join(ROOT, 'src/adapter/d1.js'))};
    import { tripVaultHalt, __resetVaultHaltForTests } from ${JSON.stringify(join(ROOT, 'src/db/vault-halt.js'))};
    const dbPath = process.env.D_DB;
    // plaintext fixture vault, non-encrypted columns (the verify-vault-fail-stop idiom)
    { const b = new Database(dbPath); b.exec('CREATE TABLE IF NOT EXISTS llm_usage (id INTEGER PRIMARY KEY, payload TEXT)'); b.close(); }
    __resetVaultHaltForTests();
    const a = createDb({ dbPath, userKey: null, systemKey: null });
    await a.d1Query('INSERT INTO llm_usage(payload) VALUES (?)', ['x']);
    await a.d1Query("UPDATE llm_usage SET payload = 'a note from CANARY_LITERAL here' WHERE id = 1");
    await a.d1Query('INSERT INTO llm_usage(payload) VALUES (?)', ['y']);
    const e = new Error('database disk image is malformed'); e.code = 'SQLITE_CORRUPT';
    tripVaultHalt(e, { op: 'SELECT llm_usage', dbPath: null });
    a.close();
  `.replaceAll('CANARY_LITERAL', CANARY);
  const ddir = mkdtempSync(join(tmpdir(), 'myc-ring-'));
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    MYCELIUM_HOME: ddir, MYCELIUM_DATA_DIR: ddir, D_DB: join(ddir, 'fixture.db'),
  };
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', childSrc], { env, cwd: ROOT, encoding: 'utf8' });
  let events = [];
  let logFile = null;
  const walk = (d) => {
    for (const f of readdirLocal(d)) {
      const p = join(d, f);
      if (f === 'durability-events.jsonl') { logFile = p; return; }
      try { if (readdirLocal(p).length) walk(p); } catch { /* not a dir */ }
      if (logFile) return;
    }
  };
  walk(ddir);
  if (logFile) {
    events = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  const corrupt = events.find((ev) => ev.kind === 'sqlite-corrupt');
  rec('D2 sqlite-corrupt event recorded by the trip (real adapter writes preceding it)', !!corrupt,
    corrupt ? '' : `stderr: ${String(r.stderr).slice(0, 160)}`);
  const counts = corrupt?.inFlight?.counts || {};
  rec('D1 event carries shapes from the ADAPTER wiring (verb+table keys, correct counts)',
    counts['INSERT llm_usage'] === 2 && counts['UPDATE llm_usage'] === 1,
    JSON.stringify(counts).slice(0, 120));
  const rawLog = logFile ? readFileSync(logFile, 'utf8') : '';
  rec('D3 the user literal appears NOWHERE in the durability log (§1)', logFile !== null && !rawLog.includes(CANARY));
  rmSync(ddir, { recursive: true, force: true });
}

// ── verdict ─────────────────────────────────────────────────────────────────
console.log('\nverify:vault-restore-guard — D-140 destructive-file-op guards');
for (const l of ledger) console.log(l);
try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
console.log(`VERDICT: ${allPass ? 'GO' : 'NO-GO'}  EXIT=${allPass ? 0 : 1}`);
process.exit(allPass ? 0 : 1);
