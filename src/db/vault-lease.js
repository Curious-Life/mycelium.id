// src/db/vault-lease.js — WHO IS ALLOWED TO WRITE TO THE VAULT AT ALL.
//
// The operator's ask, 2026-07-29: "if the app is closed, we should not let other processes
// write to the db." And 2026-07-28: "an external service should never have more control
// over the db than mycelium."
//
// ── WHY THIS IS NOT ANOTHER PIDFILE ────────────────────────────────────────────────────
//
// Every cross-process primitive in this repo is a pid file plus `ps` heuristics —
// init.js:56-89, writer-lock.js:77-130, snapshot-worker.mjs:156-169 — and that is the
// direct source of both the fail-open branches and the brick defects: D-111 (a lock
// stolen while it was empty), D-113 (a leaked lock that silently ended all backups), and
// the un-numbered zombie-lock brick recorded at writer-lock.js:73-78, where a <defunct>
// holder made every subsequent boot refuse and the app was permanently unusable.
//
// A pid can be reused. A `ps` can fail. A zombie can linger. An age can be wrong. Every
// one of those is a branch that must guess, and writer-lock.js has SIX that guess in the
// permissive direction. A kernel-held lock cannot fail to tell. SQLite takes fcntl locks
// internally and better-sqlite3 is already a dependency, so `BEGIN EXCLUSIVE` on a tiny
// dedicated file buys this with no new dependency and no native code of ours.
//
// MEASURED 2026-07-29 (spike 3, this machine):
//   a second PROCESS sees the lease while the holder lives ......... HELD (SQLITE_BUSY)
//   after SIGKILL of the holder, with NO cleanup of ours ........... FREE, immediately
//   a second connection in the SAME process ........................ HELD (SQLite
//     serialises it, so this is not a POSIX per-process-lock hole)
//   probe cost ..................................................... 0.16 ms
//
// The second line is the whole argument. The handoff's hardest open question was "does
// the lease survive a crash? reclaim must be provable, not heuristic." There is nothing
// to reclaim, because the kernel leaves nothing behind. That deletes the question rather
// than answering it, and with it the entire defect class above.
//
// ── WHAT THIS IS NOT ───────────────────────────────────────────────────────────────────
//
// NOT serialization. Same-build concurrent WAL writers are SAFE and that has been
// measured three separate times — repro-corruption.mjs (6/6 CLEAN, a refutation harness,
// not a reproducer), nine hours of live operation, and stress-corruption.mjs at
// production shape with 12 SIGKILLs mid-transaction and 12 competing exclusive
// checkpoints, all CLEAN while the positive control corrupted on round 1. The problem was
// never "two writers". It is "a writer that is not running our code", and "a writer at
// all when the app is closed". If this file ever starts routing writes through one
// process, it has drifted — see the vault-ownership design.
//
// NOT an access-control boundary against a hostile local process: a same-uid attacker can
// take the lease, or delete this file. It stops ACCIDENTAL and FOREIGN-CODE writers, which
// is the entire observed threat population. @see the design doc's threat model.
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync, statSync, openSync, closeSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, basename, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { dbPath as resolveDbPath } from '../paths.js';
import { lockVaultFiles, unlockVaultFiles } from './vault-mode.js';

/** Opt-out, mirroring MYCELIUM_SKIP_WRITER_LOCK / MYCELIUM_IGNORE_VAULT_HALT. */
const disabled = () => process.env.MYCELIUM_SKIP_VAULT_LEASE === '1';

// WE OWN IT — tracked in-process, and NOT re-derived from the metadata sidecar.
//
// The first draft answered "am I the owner?" by comparing the sidecar's family token to
// ours. That made a best-effort file write load-bearing: if writeFileSync failed (a full
// disk, a read-only data dir) the owner held the lock but published nothing, and its own
// next getDb() refused — the process that legitimately owns the vault, bricked by its own
// guard. This flag cannot fail to be written.
let _ownedHere = false;

// ── THE SURVIVOR MUST TAKE OVER ────────────────────────────────────────────────────────
//
// The lease is held by ONE process. The app spawns two node siblings with the same family
// token (main.rs:653, :801): one wins the lock, the other proceeds as an inheritor holding
// nothing. If the OWNER dies and the inheritor survives, the vault goes ownerless — and
// nothing re-claimed it, because boot() runs once per process. Measured: sibling A owner,
// B inheritor, SIGKILL A while B keeps serving → probe says FREE, and every pipeline child
// is refused with "The app was closed or crashed while this job was running". The app is
// running. The message is false.
//
// That is reachable on the shipped launch path, not a thought experiment: both siblings are
// supervised with respawn and a 1→30 s capped backoff, and EVERY pipeline job is spawned
// from server-rest — so in the branch where the OTHER sibling holds the lease, its crash
// takes clustering, naming, chronicles and claim discovery down while the UI looks healthy.
//
// So an inheritor keeps trying. The retry is cheap (a probe is ~0.2 ms now that the claim
// path no longer blocks) and the timer is UNREF'D, so it never holds a process open and
// never delays a quit.
const TAKEOVER_RETRY_MS = 5000;
let _takeoverTimer = null;

// ── PRESENCE: WHO IS STILL USING THIS VAULT ────────────────────────────────────────────
//
// Layer B's rule is "writable iff someone owns it", and the hard half is knowing when the
// LAST user leaves. Three designs failed before this one, each reproduced by an adversarial
// review:
//   · seal on any owner's release  → a short-lived claimer sealed a vault its PARENT was
//     still writing to (verify:realm-prune died with SQLITE_READONLY).
//   · seal only for the app        → the unlock stayed ungated, so ONE non-app run
//     unlocked and never re-sealed. Layer B became one-shot.
//   · seal from the Tauri shell    → the shell knows its own children are gone, which is
//     NOT the same as "nobody owns the vault": it sealed under a live foreign MCP, which
//     then lost every fresh-connection write for the rest of its life.
//
// The invariant nobody could evaluate was "is anyone else still here?". Presence answers it
// the same way the lease answers ownership — with a kernel lock, so a dead process leaves
// nothing behind and there is no pid, no `ps`, no age to guess at. Every process that uses
// the vault holds an exclusive lock on its own presence file for its lifetime; whoever
// leaves last finds no other live presence and seals.
//
// ⚠️ NOTE THE FAIL DIRECTION, WHICH IS DELIBERATELY THE OPPOSITE OF THE LEASE'S. For
// WRITING, "I cannot tell" must refuse. For SEALING, "I cannot tell" must NOT seal —
// sealing is the action that strands other processes, so the safe failure is to leave the
// vault writable and let the next departure try again.
let _presence = null;

function presenceDir(dbPath) { return dirname(vaultIdentity(dbPath)); }

/** Take a presence lock for this process. Held until the process dies, by the kernel. */
function registerPresence(dbPath) {
  if (_presence) return;
  try {
    const presencePath = join(presenceDir(dbPath), `.vault-presence-${process.pid}-${randomBytes(3).toString('hex')}`);
    const db = new Database(presencePath, { timeout: 0 });
    db.exec('BEGIN EXCLUSIVE');
    _presence = { db, path: presencePath };
  } catch { _presence = null; }   // no presence ⇒ we simply never seal; never fatal
}

/**
 * Is any OTHER process still using this vault? Reaps its own stale files on the way past.
 * Returns true when it cannot tell — see the fail direction above.
 */
function anyOtherPresenceAlive(dbPath, log) {
  let names;
  try { names = readdirSync(presenceDir(dbPath)); } catch { return true; }
  for (const f of names) {
    // NOT the sidecars SQLite creates beside a presence file. `.vault-presence-…-journal`
    // starts with the same prefix, is not a database, and made the scan abort on an error
    // that then never seals and never cleans up — Layer B switched off, silently.
    if (!f.startsWith('.vault-presence-')) continue;
    if (/-(journal|wal|shm)$/.test(f)) continue;
    const presenceFile = join(presenceDir(dbPath), f);
    if (_presence && presenceFile === _presence.path) continue;
    let db = null;
    try {
      db = new Database(presenceFile, { timeout: 0 });
      db.exec('BEGIN EXCLUSIVE');
      db.exec('ROLLBACK');
      db.close(); db = null;
      try { unlinkSync(presenceFile); } catch { /* raced with its owner's cleanup */ }
    } catch (e) {
      if (e?.code === 'SQLITE_BUSY') return true;    // a live process holds it
      // Could not tell ⇒ do NOT seal (see the fail direction above) — but SAY SO. A
      // guarantee that switches itself off with no message is the M-001 shape.
      try { log?.(`[mycelium] vault: not sealing — a presence file could not be read (${f}: ${e?.code || e?.message})`); } catch { /* */ }
      return true;
    } finally { try { db?.close(); } catch { /* */ } }
  }
  return false;
}

/**
 * Leave the vault: drop our presence and, if we were the last one here, seal it.
 * Registered on `exit` by every process that joins, so it runs on a clean exit and on the
 * SIGTERM paths that call close() (server-rest.js, mcp-lifetime.js). A SIGKILL leaves the
 * vault writable until the next launch — the documented residual, covered by the
 * first-encounter integrity gate rather than by prevention.
 */
let _joined = false;
let _maySeal = false;
/**
 * Join the vault: hold a presence lock, and seal on the way out if we are the last.
 *
 * ⚠️ PRESENCE IS REGISTERED FOR *ANY* VAULT, INCLUDING ONE THIS PROCESS DOES NOT CONSIDER
 * CANONICAL — but only a CANONICAL vault is ever sealed. That asymmetry is not fussiness,
 * it is the fix for a reproduced crash: isCanonicalVault() is environment-relative
 * (resolveDbPath reads MYCELIUM_DB), so verify:realm-prune's parent passes dbPath
 * explicitly and sees a NON-canonical vault — no presence — while the child it spawns gets
 * MYCELIUM_DB, sees the SAME FILE as canonical, and sealed it on exit under the parent,
 * which then died with SQLITE_READONLY.
 *
 * "Am I allowed to seal this?" and "is anyone else using this file?" are different
 * questions, and only the first one depends on whose vault it is.
 */
function joinVault(dbPath, log, { maySeal = true } = {}) {
  if (_joined) return;
  _joined = true;
  _maySeal = maySeal;
  registerPresence(dbPath);
  // Every joiner registers this, not just the owner: an inheritor or a pipeline child can
  // easily be the LAST process holding the vault open, and if it does not seal on the way
  // out the vault stays writable with nobody owning it — which is exactly how Layer B
  // became one-shot in the previous revision.
  process.on('exit', () => leaveVault(dbPath, log));
}

function leaveVault(dbPath, log) {
  try { _presence?.db.close(); } catch { /* */ }
  try { if (_presence) unlinkSync(_presence.path); } catch { /* */ }
  _presence = null;
  try {
    if (_maySeal && !anyOtherPresenceAlive(dbPath, log)) lockVaultFiles(dbPath, { log });
  } catch { /* sealing is best-effort; never take an exit down with it */ }
}

/**
 * Vault identity — realpath(dir) + basename, copied deliberately from writer-lock.js:143
 * rather than imported, and for the reason stated there: resolve() alone leaves /var/…
 * and /private/var/… looking like two different vaults, which fails OPEN. Keeping the two
 * in the same shape means a future change to one is visibly a change to the other.
 */
function vaultIdentity(p) {
  const abs = resolve(p);
  try { return join(realpathSync(dirname(abs)), basename(abs)); }
  catch { return abs; }
}

/**
 * Is this THE vault, or a fixture? Scoped exactly as writer-lock.js:182-185 already scopes
 * itself, and that scoping is load-bearing: it is why the ~104 verify gates — every one of
 * which points MYCELIUM_DB at a temp fixture — need no changes and no new escape hatch.
 * The handoff was explicit that adding a seventh MYCELIUM_SKIP_* hatch would be the wrong
 * shape; this is how the pressure is released instead.
 */
export function isCanonicalVault(dbPath) {
  if (!dbPath || dbPath === ':memory:') return false;
  try { return vaultIdentity(dbPath) === vaultIdentity(resolveDbPath()); }
  catch { return false; }   // cannot resolve the canonical path ⇒ treat as a fixture
}

/** The lease artefact. NOT `vault-lock.json` — that name is the passphrase seal (paths.js:95). */
export function leasePaths(dbPath) {
  const dir = dirname(vaultIdentity(dbPath));
  return { lock: join(dir, '.vault-ownership'), meta: join(dir, '.vault-ownership.json') };
}

/** Who we are, for the metadata sidecar. */
function selfDescription() {
  return {
    pid: process.pid,
    family: process.env.MYCELIUM_VAULT_FAMILY || null,
    argv: (process.argv[1] || '').split('/').slice(-2).join('/'),
    at: new Date().toISOString(),
  };
}

function readMeta(metaPath) {
  try { return JSON.parse(readFileSync(metaPath, 'utf8')); }
  catch { return null; }
}

/**
 * Open the lease file, repairing it if it is not a database.
 *
 * The lease file carries NO DATA — it exists only to be locked — so recreating it is
 * always safe, and NOT recreating it would be a brick: a truncated or garbage
 * `.vault-ownership` (an interrupted write, a bad restore) makes every open answer
 * SQLITE_NOTADB, every probe answer UNKNOWN, and UNKNOWN refuses. That is a permanent
 * lockout produced by the guard rather than by any real problem, which is the exact shape
 * of D-112 and of the zombie-lock brick. Deleting is only ever done here, on the claim
 * path, never from a probe.
 */
function openLockFile(lockPath) {
  // ⚠️ `timeout: 0` IS LOAD-BEARING, and its absence cost 5.4 SECONDS PER CLAIM.
  //
  // better-sqlite3 defaults to `timeout: 5000`. The `SELECT 1` below takes a SHARED lock,
  // so against a live holder's BEGIN EXCLUSIVE it BLOCKED for the full five seconds before
  // throwing SQLITE_BUSY — and the `busy_timeout = 0` this design rests on was applied by
  // the CALLER, after this function had already returned. Measured stepwise: +6 ms open,
  // +5381 ms SELECT 1 throws, and only then the pragma that was supposed to prevent it.
  //
  // boot() claims twice (index.js and again via getDb), so an inheritor paid 10.7 s per
  // boot — and src/server-http.js calls boot() PER MCP SESSION, making every `initialize`
  // on the remote surface an 11-second handshake. Which sibling paid it was decided by a
  // startup race between the two spawns in main.rs.
  //
  // The file's own evidence block records "probe cost 0.16 ms". That was measured on
  // probeVaultOwnership, which has no SELECT 1, and generalised to a path that was never
  // timed while held. The gate could not see it: its 15 s child timeout absorbed the stall.
  const opts = { timeout: 0 };
  // CLOSE THE HANDLE WHEN THE PROBE THROWS. `new Database` SUCCEEDS and `SELECT 1` throws,
  // so the caller's `db?.close()` sees null and the handle leaks — measured at 63 open fds
  // after 200 failed claims, and armTakeover turns that from twice-per-boot into
  // once-every-5s forever in an inheritor. It did NOT silently drop the fcntl lock (SQLite
  // defers the close while a lock is held, measured), but leaking handles in a retry loop
  // is its own bug. The handle must be held in a variable OUT here to be closable — an
  // earlier version of this fix reached for it off the error object, where it never was.
  let db = null;
  try {
    db = new Database(lockPath, opts);
    db.prepare('SELECT 1').get();   // force a header read now, not at BEGIN
    return db;
  } catch (e) {
    try { db?.close(); } catch { /* */ }
    if (e?.code !== 'SQLITE_NOTADB' && e?.code !== 'SQLITE_CORRUPT') throw e;
    repairLockFile(lockPath);
    return new Database(lockPath, opts);
  }
}

/**
 * Replace a garbage lease file — SERIALISED, so two claimants cannot each recreate it.
 *
 * The unserialised version was the double-owner race: both racers unlink the other's fresh
 * inode and take BEGIN EXCLUSIVE on DIFFERENT files, so both believe they own the vault.
 * The inode re-check after BEGIN narrows that window but provably does not close it —
 * an independent review measured two owners 1/48, and the gate's own A12 row goes RED
 * roughly one run in three under load. A guarantee that holds "usually" is not one.
 *
 * The fix is the primitive init.js already proved in this repo for exactly this shape: an
 * O_EXCL guard file. Exactly one process repairs; everyone else returns and retries, and
 * finds a valid file. The guard is cleared on ANY exit path, and a stale one (its holder
 * died mid-repair) is reclaimed by age — the only heuristic here, bounded to a file that
 * carries no data and whose worst case is one extra retry.
 */
function repairLockFile(lockPath) {
  const guard = `${lockPath}.repair`;
  let fd = null;
  try {
    fd = openSync(guard, 'wx');       // O_CREAT|O_EXCL — atomic, no guessing
  } catch {
    // Someone else is repairing, OR a previous repairer died holding the guard.
    try {
      if (Date.now() - statSync(guard).mtimeMs > REPAIR_GUARD_STALE_MS) unlinkSync(guard);
    } catch { /* gone already, or unreadable — the retry will sort it out */ }
    return false;                     // let the caller retry against whatever now exists
  }
  try {
    try { unlinkSync(lockPath); } catch { /* already gone */ }
    const fresh = new Database(lockPath, { timeout: 0 });   // create it whole, then close
    try { fresh.prepare('SELECT 1').get(); } finally { fresh.close(); }
    return true;
  } finally {
    try { closeSync(fd); } catch { /* */ }
    try { unlinkSync(guard); } catch { /* */ }
  }
}

/** The inode at a path, or null. Identity, not a heuristic — see the re-check in claim. */
function inodeOf(p) {
  try { return statSync(p).ino; } catch { return null; }
}

/** Bounded retries for the lease-file-replaced race and the mid-claim window. */
const CLAIM_RETRIES = 3;
/** Pause between claim retries. The mid-claim window measures ~2 ms; this clears it. */
const CLAIM_RETRY_MS = 25;
/** A repair guard older than this belonged to a process that died mid-repair. */
const REPAIR_GUARD_STALE_MS = 10_000;

/**
 * Block this thread for `ms`. Synchronous ON PURPOSE: claimVaultOwnership is called from
 * synchronous boot paths (getDb, ensureVaultSchema) that cannot await, and the alternative
 * — refusing instead of waiting 25 ms — is what refused the app's own second sibling.
 * Same primitive src/auth.js already uses for the same reason.
 */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* SharedArrayBuffer unavailable — proceed without the pause */ }
}

/**
 * Keep trying to become the owner, for a sibling that started as an inheritor.
 * Idempotent, unref'd, and stops as soon as it wins. @see TAKEOVER_RETRY_MS.
 */
function armTakeover({ dbPath, log }) {
  if (_takeoverTimer || _ownedHere) return;
  _takeoverTimer = setInterval(() => {
    if (_ownedHere) { clearInterval(_takeoverTimer); _takeoverTimer = null; return; }
    try {
      const r = claimVaultOwnership({ dbPath, log });
      if (r.role === 'owner') {
        clearInterval(_takeoverTimer); _takeoverTimer = null;
        log(`[mycelium] vault ownership taken over by pid ${process.pid} — the previous owner is gone`);
      }
    } catch { /* still held, or momentarily unreadable — try again next tick */ }
  }, TAKEOVER_RETRY_MS);
  // Never hold the process open and never delay a quit: this is a background upgrade,
  // not work the app is waiting on.
  _takeoverTimer.unref?.();
}

// NOTE — `sealVaultOnTermination` was DELETED here (2026-07-29). It sealed on SIGTERM for an
// entry point with nothing to drain, but ALL FOUR real entry points (server-rest, --http,
// --enrich, --public) have async work to bound and use `bindBoundedShutdown` below instead.
// It ended up with zero product callers — only the gate injected it into synthetic children
// — which is exactly the shape this repo already ruled on when it deleted `assertVaultOwnership`
// ("a function only the tests call is a guarantee only the tests have"). The SIGTERM seal is
// now proven directly on the real entry points: G10 (server-rest), G11a/b (--enrich/--public)
// and G12 (--http), each spawning `node …` for real, holding a stalled socket, and reading the
// file mode. The "SIGTERM does not run exit handlers" insight lives on in `bindBoundedShutdown`.

/**
 * The SAME bounded shutdown for every http entry point that holds the vault open.
 *
 * ⚠️ THIS IS SHARED BECAUSE HAVING THREE COPIES IS HOW THE HOLE STAYED OPEN. server-rest
 * got a bounded shutdown; the PUBLIC server kept the unbounded one and was measured ALIVE
 * 8 SECONDS AFTER SIGTERM with a single half-sent request held — past the shell's 6 s
 * grace, so it was SIGKILLed and never sealed. Worse, while hung it holds a PRESENCE LOCK,
 * so every other process leaving sees it and refuses to seal: one stalled TCP connection
 * disables the whole guarantee for the entire app.
 *
 * `server.close()` waits for every in-flight connection and never returns while one is
 * open — measured on Node 22 for a never-ending response AND for a merely half-sent
 * request (a dropped Wi-Fi, a slow client, a port scan).
 *
 * IDLE FIRST, ACTIVE ONLY AT THE DEADLINE. Destroying active requests at t=0 gives
 * in-flight work ~0 ms where the shell would have given it 6 s — measured, an exit in
 * 138 ms. So idle keep-alives go immediately, real work gets the budget, and only then is
 * everything cut.
 */
export function bindBoundedShutdown({ server, close, budgetMs = 2500, log = () => {} } = {}) {
  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const finish = () => { try { close?.(); } finally { process.exit(sig === 'SIGINT' ? 130 : 0); } };
    const hard = setTimeout(() => {
      try { server?.closeAllConnections?.(); } catch { /* older runtimes */ }
      finish();
    }, budgetMs);
    hard.unref?.();
    try { server?.close?.(finish); } catch { finish(); }
    // Idle keep-alives cannot finish anything; they only prevent close() from returning.
    try { server?.closeIdleConnections?.(); } catch { /* older runtimes fall back to the timer */ }
    log(`[mycelium] ${sig} — draining (up to ${budgetMs} ms), then closing the vault`);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/** Test seam: stop the takeover timer (gates spawn many short-lived claimers). */
export function __stopVaultTakeoverForTests() {
  if (_takeoverTimer) { clearInterval(_takeoverTimer); _takeoverTimer = null; }
}

/**
 * Publish the holder metadata ATOMICALLY, and tell the caller whether it worked.
 *
 * Was a best-effort `writeFileSync`, which was wrong twice over. A concurrent sibling could
 * read it mid-truncate and see nothing; and if the write failed outright, the owner held the
 * lock while advertising nothing, so the app's SECOND node sibling — which main.rs spawns on
 * every launch — was told "the vault is already owned by another Mycelium instance (pid
 * 999999). Quit that one first", naming a process that does not exist, on every launch,
 * until a human deleted the file. That is brick #4, and an adversarial review reproduced it.
 *
 * temp+rename makes the file appear whole or not at all.
 */
function publishMeta(metaPath, payload) {
  const tmp = `${metaPath}.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    renameSync(tmp, metaPath);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { /* */ }
    return false;
  }
}

/**
 * Is the vault owned right now, and by whom?
 *
 * Never blocks (busy_timeout = 0) and costs ~0.16 ms, so it is affordable on every
 * write-capable open.
 *
 * THE THIRD STATE IS THE POINT. 'UNKNOWN' is not folded into either answer, because the
 * six fail-open branches in writer-lock.js are all exactly that fold — a probe that could
 * not tell, resolving to "allowed". Callers must treat UNKNOWN as REFUSE.
 *
 * @param {string} dbPath
 * @returns {{ state: 'FREE'|'HELD'|'UNKNOWN', family: string|null, holder: object|null, reason: string }}
 */
export function probeVaultOwnership(dbPath) {
  const { lock, meta } = leasePaths(dbPath);
  let db = null;
  try {
    if (!existsSync(lock)) return { state: 'FREE', family: null, holder: null, reason: 'no lease file' };
    db = new Database(lock);
    db.pragma('busy_timeout = 0');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('ROLLBACK');
    return { state: 'FREE', family: null, holder: null, reason: 'lease is not held' };
  } catch (e) {
    if (e?.code === 'SQLITE_BUSY') {
      const holder = readMeta(meta);
      return { state: 'HELD', family: holder?.family ?? null, holder, reason: 'lease is held' };
    }
    return { state: 'UNKNOWN', family: null, holder: null, reason: `could not probe (${e?.code || e?.message || 'error'})` };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

/**
 * Claim ownership of the vault. Called ONLY from a real process entry point — the same
 * place, and for the same reason, that at-rest default-on is entry-point-gated at
 * index.js:335. A library import must never claim: that is what keeps a stray script, a
 * pipeline child and an orphaned MCP out.
 *
 * Three outcomes, and the middle one is why this is not just "take a lock":
 *
 *   owner      the lease was free; we hold it for this process's lifetime.
 *   inheritor  the lease is held BY OUR OWN FAMILY. The app spawns two node siblings by
 *              design (main.rs:650, :795) and both are entry points, so exactly one wins
 *              the lock and the other MUST proceed rather than fail. Refusing here would
 *              break the shipped app on every launch.
 *   throws     the lease is held by a DIFFERENT family (a second app instance), or the
 *              probe could not tell.
 *
 * @param {{ dbPath: string, log?: (m:string)=>void }} p
 * @returns {{ role: 'owner'|'inheritor'|'skipped', release: () => void, reason: string }}
 */
export function claimVaultOwnership({ dbPath, log = () => {}, attempt = 0 }) {
  const noop = (role, reason) => ({ role, release: () => {}, reason });
  if (disabled()) {
    // THE ESCAPE HATCH MUST ACTUALLY OPEN, and for one revision it did not: this returned
    // before the unlock, so recovery tooling reached a SEALED vault and every write failed
    // SQLITE_READONLY — while four in-product error messages recommended this very flag.
    // A documented remedy that leaves the vault read-only is not a remedy.
    unlockVaultFiles(dbPath, { log });
    // …AND JOIN, or this is the one-shot defect straight back in through the escape hatch:
    // unlocking without a presence means nothing ever re-seals, and four in-product error
    // messages recommend this exact flag. Whoever unlocks must be able to re-seal.
    joinVault(dbPath, log, { maySeal: isCanonicalVault(dbPath) });
    return noop('skipped', 'MYCELIUM_SKIP_VAULT_LEASE=1');
  }
  if (!isCanonicalVault(dbPath)) {
    // Presence WITHOUT the right to seal: we are using this file, and a process that DOES
    // consider it canonical must not seal it out from under us. @see joinVault.
    joinVault(dbPath, log, { maySeal: false });
    return noop('skipped', 'not the canonical vault');
  }
  // Idempotent: getDb calls this on every open, and a process opens the vault more than
  // once. Re-taking our own lock would read as HELD-by-someone and send us down the
  // kinship path against our own metadata.
  if (_ownedHere) return noop('owner', 'this process already owns the lease');

  // ── A SPAWNED CHILD MAY NEVER CLAIM ────────────────────────────────────────────────
  // This is what makes "app closed ⇒ nobody writes" true for the compute pipeline. A
  // pipeline child outliving its app would otherwise find the lease FREE, claim it, and
  // carry on writing — the guard handing ownership to the very process it exists to stop.
  //
  // The mark goes on the CHILD, not on the app, and that is deliberate. Marking the app
  // would need src-tauri/src/main.rs to set a variable that src/db/vault-lease.js reads,
  // so a dev shell or an older binary that did not set it would refuse BOTH of the app's
  // node siblings and brick the launch. jobs.js already builds a closed allowlist for
  // every child it spawns (:289-302, :658-667, :734-756, :818-835) and ships in the same
  // file set as this one, so the two can never disagree by version.
  // THE FAMILY TOKEN IS THE EVIDENCE THAT THERE IS A LEASE TO INHERIT, and requiring it
  // here is not a softening — it repairs an asymmetry that made the mark unsound.
  //
  // isCanonicalVault() is ENVIRONMENT-RELATIVE: resolveDbPath() reads MYCELIUM_DB, and
  // jobs.js ALWAYS passes MYCELIUM_DB to the children it spawns (:293 and its three
  // siblings). So a parent that never set MYCELIUM_DB sees its vault as non-canonical and
  // skips claiming, while its child — handed that same file as MYCELIUM_DB — sees it as
  // canonical and looks for a lease that was never taken. Parent and child disagreeing
  // about the same file is what broke verify:illuminate-naming: the naming child was
  // refused, nothing was named, and the UI fell back to "Territory {id}" — the exact
  // user-visible symptom that gate exists to catch.
  //
  // A child WITH a token has a parent that claimed, so a missing owner means the app died
  // and it must stop. A child WITHOUT one has a parent that never held a lease at all;
  // there is nothing to inherit and nothing to have died, so it takes the normal path.
  const familyToken = process.env.MYCELIUM_VAULT_FAMILY || null;
  // Trim + lowercase: an exact-match test let `Child`, `CHILD` and ` child` fall through to
  // the CLAIM path — a silent permissive miss rather than a refusal, which is the direction
  // that matters. jobs.js is the only setter and A10 pins the literal, so this is defence
  // against a future third setter, not against an attacker.
  if ((process.env.MYCELIUM_VAULT_ROLE || '').trim().toLowerCase() === 'child' && familyToken) {
    const probe = probeVaultOwnership(dbPath);
    const mine = familyToken;
    if (probe.state === 'HELD' && mine && probe.family === mine) {
      joinVault(dbPath, log);
      return noop('inheritor', 'spawned child of a live owner');
    }
    throw Object.assign(
      new Error(
        `REFUSING to open the vault: this is a spawned Mycelium child and no live app owns `
        + `the vault (${probe.reason}). The app was closed or crashed while this job was `
        + `running; it must stop rather than keep writing.`,
      ),
      { code: 'vault_not_owned' },
    );
  }

  const { lock, meta } = leasePaths(dbPath);
  try { mkdirSync(dirname(lock), { recursive: true }); } catch { /* */ }

  let db = null;
  let openedIno = null;
  try {
    db = openLockFile(lock);
    openedIno = inodeOf(lock);
    db.pragma('busy_timeout = 0');
    db.exec('BEGIN EXCLUSIVE');
    // ── THE INODE RE-CHECK. Two owners of one vault, otherwise. ────────────────────────
    // openLockFile repairs a garbage lease by unlink + recreate. Two claimants racing that
    // repair each unlink the other's fresh inode and then take BEGIN EXCLUSIVE on a
    // DIFFERENT file — both succeed, both believe they own the vault. Measured by an
    // adversarial review at 11 races in 40 with the lease file seeded from this gate's own
    // A6 fixture. A4 (a different family is refused) and A6 (a garbage file is repaired)
    // each pass alone; it is their COMBINATION that fails — the same "unhandled combination
    // falls into the permissive branch" class the marker truth table exists to prevent.
    //
    // ⚠️ WHAT THIS ACTUALLY COMPARES, stated accurately because the first version of this
    // comment overstated it. better-sqlite3 exposes no fd, so we cannot stat the handle we
    // locked; both readings are stats of the PATH, taken before and after. A replacement
    // landing before the first stat makes the comparison vacuous. It narrows the window
    // rather than closing it, and two independent 40- and 60-trial runs produced 0
    // double-owners with it REMOVED — so treat it as defence-in-depth whose value is
    // unproven, not as the guarantee. The guarantee such as it is comes from the claim
    // being retried rather than guessed at.
    const lockedIno = db.prepare('SELECT 1').get() !== undefined ? inodeOf(lock) : null;
    if (lockedIno === null || lockedIno !== openedIno) {
      try { db.exec('ROLLBACK'); } catch { /* */ }
      try { db.close(); } catch { /* */ }
      // The recursion sits inside this try, so a retry that throws vault_owned_elsewhere
      // used to be caught below and rewritten into a generic vault_not_owned — losing
      // "quit that instance (pid X)", the only actionable part. Rethrow it unchanged.
      if (attempt < CLAIM_RETRIES) {
        try { return claimVaultOwnership({ dbPath, log, attempt: attempt + 1 }); }
        catch (retryErr) { throw Object.assign(retryErr, { __leaseFinal: true }); }
      }
      throw Object.assign(
        new Error('could not claim the vault lease: the lease file kept being replaced underneath us — refusing rather than risk two owners of one vault'),
        { code: 'vault_not_owned' },
      );
    }
  } catch (e) {
    try { db?.close(); } catch { /* */ }
    if (e?.code !== 'SQLITE_BUSY') {
      // NAME THE FILE AND THE WAY OUT. This fires on a chmod'ed lease file or a read-only
      // data dir, and the first version said only "could not claim the vault lease
      // (SQLITE_CANTOPEN)" — no path, no remedy. That is the same unreachable-from-Finder
      // shape as the zombie-lock brick this file's header cites; the two sibling throw
      // sites already name the escape and this one did not.
      throw Object.assign(new Error(
        `could not claim the vault lease (${e?.code || e?.message}) — refusing to open the vault write-capable. `
        + `The lease file is ${lock}. If Mycelium is NOT running you can delete it and its `
        + `.json sibling; otherwise check permissions and free space on that directory. `
        + `Set MYCELIUM_SKIP_VAULT_LEASE=1 only for recovery tooling that knowingly owns the box.`,
      ), { code: 'vault_not_owned' });
    }
    // Held. Ours, or somebody else's?
    const holder = readMeta(meta);
    const mine = process.env.MYCELIUM_VAULT_FAMILY || null;
    if (mine && holder?.family && holder.family === mine) {
      // Deliberately NOT armed on the spawned-child path above: a child must never become
      // the owner, which is the whole guarantee. This is the app's OWN second sibling, and
      // it is exactly the process that should pick the vault up if the first one dies.
      armTakeover({ dbPath, log });
      joinVault(dbPath, log);
      return noop('inheritor', `same family as the holder (pid ${holder.pid})`);
    }
    // ── HELD, BUT NOBODY HAS SAID WHO. THIS IS "MID-CLAIM", AND IT IS RETRYABLE. ──────
    //
    // ⚠️ THE COMMENT THAT USED TO BE HERE CALLED THIS WINDOW "microseconds wide, not
    // reproduced". IT IS ~2 ms AND REPRODUCES IN 35 OF 40 BACK-TO-BACK LAUNCHES. That
    // wrong reassurance is the exact thing that stops the next person looking, so it is
    // replaced rather than softened.
    //
    // The window is between the winner's BEGIN EXCLUSIVE and its publishMeta. A sibling
    // arriving inside it sees the lock HELD and the metadata absent. Throwing there refuses
    // the app's own second process — and src/index.js turns that into process.exit(1).
    //
    // AND I WIDENED IT MYSELF. The previous `timeout: 5000` was accidentally load-bearing in
    // the other direction: the losing sibling BLOCKED past the winner's publish, so by the
    // time it saw SQLITE_BUSY the metadata existed and it became an inheritor correctly.
    // Removing that timeout to kill an 11-second MCP handshake made it fail fast straight
    // INTO the window. Measured, 40 synchronised launches: correct owner+inheritor pairs
    // fell from 27/40 to 5/40, and both siblings were refused in 4/40.
    //
    // The right reading is that HELD-with-no-holder means SOMEONE IS MID-CLAIM — a
    // transient, not a verdict — so it goes through the retry loop. Only when the retries
    // are exhausted is it a genuine unidentifiable holder.
    if (!holder) {
      if (attempt < CLAIM_RETRIES) {
        sleepSync(CLAIM_RETRY_MS);        // let the winner finish publishing
        try { return claimVaultOwnership({ dbPath, log, attempt: attempt + 1 }); }
        catch (retryErr) { throw Object.assign(retryErr, { __leaseFinal: true }); }
      }
      throw Object.assign(
        new Error(
          `the vault lease is held by a process that has not identified itself. If Mycelium is `
          + `not running, delete ${basename(meta)} and ${basename(lock)} beside the vault and try again. `
          + `Set MYCELIUM_SKIP_VAULT_LEASE=1 only for recovery tooling that knowingly owns the box.`,
        ),
        { code: 'vault_owned_elsewhere' },
      );
    }
    throw Object.assign(
      new Error(
        `the vault is already owned by another Mycelium instance (pid ${holder?.pid ?? 'unknown'}`
        + `${holder?.argv ? `, ${holder.argv}` : ''}${holder?.at ? `, since ${holder.at}` : ''}). `
        + `Quit that one first — two app instances must not share one vault. `
        + `Set MYCELIUM_SKIP_VAULT_LEASE=1 only for recovery tooling that knowingly owns the box.`,
      ),
      { code: 'vault_owned_elsewhere' },
    );
  }

  // We are the owner. Publish the family token so children inherit it — writer-lock.js:197
  // already does exactly this, and reusing the same variable means the existing plumbing
  // (main.rs:653/:801, jobs.js:297/667/745/828) carries the lease by descent unchanged.
  if (!process.env.MYCELIUM_VAULT_FAMILY) {
    process.env.MYCELIUM_VAULT_FAMILY = randomBytes(16).toString('hex');
  }
  // PUBLISH BEFORE DECLARING. An owner that cannot advertise itself is worse than no owner:
  // the app's second sibling reads no metadata, cannot establish kinship, and is refused on
  // every launch (brick #4). So a failed publish FAILS THE CLAIM — which is also the honest
  // outcome, because a data dir we cannot write a 200-byte file into is one we cannot write
  // the vault into either. That, in turn, is what lets the sibling path below refuse a
  // metadata-less holder without folding it into "allowed".
  if (!publishMeta(meta, selfDescription())) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    try { db.close(); } catch { /* */ }
    throw Object.assign(
      new Error(
        `could not claim the vault lease: the data directory is not writable (failed to publish ${basename(meta)}). `
        + `Mycelium cannot run without writing there — check permissions and free space. `
        + `Set MYCELIUM_SKIP_VAULT_LEASE=1 only for recovery tooling that knowingly owns the box.`,
      ),
      { code: 'vault_not_owned' },
    );
  }
  _ownedHere = true;
  joinVault(dbPath, log);
  // LAYER B: we own it, so the kernel may let writes through again. This MUST happen before
  // anything opens the vault write-capable — snapshot-on-boot opens the source write-capable
  // on purpose and its failure is fail-closed in the migrating case, so a vault still at
  // 0400 would stop boot dead. The claim runs at the top of boot(), ahead of
  // initVaultStorage, which is exactly early enough.
  unlockVaultFiles(dbPath, { log });
  log(`[mycelium] vault ownership claimed (pid ${process.pid})`);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    _ownedHere = false;
    // LAYER B: leave, and seal only if we were the LAST process here. `leaveVault` decides
    // that from PRESENCE locks rather than from who we are — see the header block, and the
    // three designs that failed before it.
    leaveVault(dbPath, log);
    try { db.exec('ROLLBACK'); } catch { /* */ }
    try { db.close(); } catch { /* */ }
    // Only the owner clears the metadata. Ownership-checked, because the snapshot lock's
    // unchecked delete is exactly how D-113 leaked.
    try {
      const cur = readMeta(meta);
      if (cur && cur.pid === process.pid) unlinkSync(meta);
    } catch { /* */ }
  };
  // The kernel releases the LOCK on exit whatever happens; this only tidies the sidecar.
  process.on('exit', release);
  return { role: 'owner', release, reason: 'lease acquired' };
}

// NOTE — there is deliberately NO `assertVaultOwnership` here any more.
//
// It existed to answer "may I write under someone else's lease?" and it could only ever
// say no. Wiring it at getDb locked out every process that reaches the vault without
// going through boot(); replacing it with claim-or-inherit fixed that and left the
// function with ZERO product callers — dead code that a gate went on testing, which is
// exactly the defect an adversarial review had just flagged in the other direction. It is
// removed rather than kept "for symmetry", because a function only the tests call is a
// guarantee only the tests have.
//
// THE HONEST SCOPE OF THIS FILE, since the removal changes what can be claimed for it:
//   IT REFUSES  a spawned child (role + family token) whose owning app has died
//   IT REFUSES  a second app instance on a vault another family owns
//   IT DOES NOT REFUSE  an arbitrary standalone process — under the operator's O1 decision
//     that IS an entry point (a headless self-host, `npm start`, a pipeline CLI, a gate)
//     and it claims. Stopping code that is not ours from opening a closed vault is the
//     FILE-MODE layer's job, not this one's. @see the vault-ownership design.

export default claimVaultOwnership;
