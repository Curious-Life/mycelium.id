// src/db/writer-lock.js — a fail-closed SINGLE-FAMILY writer lock on the canonical vault.
//
// THE FAILURE IT PREVENTS (recurring, has corrupted the production vault repeatedly):
// the desktop app (server-rest) AND a separately-launched MCP server (`node src/index.js`
// with MYCELIUM_DATA_DIR pointing at the live vault, spawned by Claude Desktop) both open
// the ONE SQLite file read/write → concurrent WAL writers from unrelated processes →
// logical b-tree corruption (SQLCipher integrity ok, quick_check fails).
//
// WHY NOT A PLAIN SINGLE-WRITER LOCK: the app opens the vault r/w in server-rest AND, by
// design, in its own pipeline children (clustering / describe / compute stages, spawned
// via jobs.js → run-clustering.sh). Those concurrent same-app handles are tolerated today
// via WAL + busy_timeout=5000 (adapter/d1.js) and MUST keep working. So this is a single-
// *FAMILY* lock: one app family (server-rest + its descendants) OR nothing — a FOREIGN
// process is refused.
//
// FAMILY TEST (belt + suspenders):
//   1. env token — the holder records a random family token; a process presenting the same
//      MYCELIUM_VAULT_FAMILY is family. server-rest sets it on acquire; jobs.js forwards it
//      into the child env allowlist.
//   2. ancestry — the holder's PID is an ancestor of the opener. Covers any child spawned
//      with a bare env that dropped the token (the jobs.js allowlist gotcha) — a pipeline
//      stage is always a descendant of server-rest; the external MCP is a descendant of
//      Claude.app, never of server-rest.
// The external MCP fails BOTH → it is refused, fail-closed, with a clear message.
//
// SCOPE: only the CANONICAL vault (paths.js dbPath()) is locked — i.e. the db this process's
// env actually points at. :memory: and an explicit dbPath that differs from the env (unit
// tests opening a temp db) pass through untouched. NOTE a fixture IS locked when a script
// points MYCELIUM_DB at it, because that is what "canonical" means to paths.js — but it locks
// ITSELF, never the real vault, because the lock file is derived per db file (LOCK_SUFFIX).
// Read-only openers (integrity quick_check, the search sidecar, backup/VACUUM) do NOT go
// through getDb r/w and are unaffected.
//
// Reuses the exact pid-liveness + start-time reclaim model proven in src/db/init.js so a
// hard-killed holder's stale lock is reclaimable (never steals a LIVE holder).
//
// COVERAGE BOUNDARIES (independent review):
//  - The token is minted per-launch by the Tauri shell (src-tauri/src/main.rs
//    mint_vault_family_token) and injected on BOTH sibling node spawns (server-rest +
//    the :4711 --http remote MCP), because they are siblings, not parent/child — ancestry
//    alone would refuse the second one. jobs.js forwards it to pipeline children.
//  - Owner-exit vs. a still-writing family child: the shell puts server-rest in its own
//    process group and group-kills it on quit (main.rs reap → kill_group), reaping the
//    pipeline grandchildren WITH the owner — so the lock isn't dropped while a family
//    writer keeps running. This lock is the fail-closed backstop, not the only guard.
//  - The one-time schema/migrate write in init.js runs under its OWN .vault-init.lock
//    (released before getDb acquires this lock); this lock covers the CONNECTION lifetime,
//    not that init window. Steady-state (migrations current) that window is a no-op read.

import { openSync, writeSync, closeSync, readFileSync, unlinkSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { dbPath as resolveDbPath } from '../paths.js';

// The lock file is derived PER DB FILE (`<vault>.writer.lock`), never a constant basename.
// A constant made every db in a directory share ONE lock: a fixture at data/verify-*.db
// contended for data/mycelium.db.writer.lock — the DEV vault's lock, next door — so four
// verify gates (realm-prune, describe-gating, describe-coverage, history) failed closed
// against a running app for a reason unrelated to what they open. Two different vaults in
// one dir are two vaults; lock identity must follow the db file.
// For the deployed vault (…/id.mycelium.app/mycelium.db) this derives the SAME name it
// always had, so an old-code holder and a new-code process still meet on one lock file.
// RESIDUAL: identity is the db's NAME, not its inode — two names for one file (a symlinked
// db FILE in the same dir) would get two locks. Nothing sets MYCELIUM_DB to such a path;
// pinning the inode instead costs more than it buys (see vaultIdentity below).
const LOCK_SUFFIX = '.writer.lock';
const START_TOLERANCE_MS = 5000; // clock-resolution slack matching a pid's start time
const SELF_START_MS = Math.round(Date.now() - process.uptime() * 1000);
const RECLAIM_RETRY = 5; // O_EXCL races while reclaiming a dead holder

// ── pid liveness (same model as init.js) ──────────────────────────────────────
// A ZOMBIE is not alive. `process.kill(pid, 0)` SUCCEEDS for a <defunct> process — it is
// still in the process table until its parent reaps it — so a naive liveness probe reports
// a corpse as the lock holder FOREVER. Observed live (2026-07-15): server-rest died on an
// uncaught SQLITE_CORRUPT, its pid lingered as <defunct> under an unreaped parent, and every
// subsequent boot hit "vault is already open by another process (pid 75970)" → the app was
// PERMANENTLY BRICKED, with the escape hatch (env-only) unreachable from a Finder launch.
// A zombie holds no fds and can never release the lock, so it must read as DEAD.
function isZombie(pid) {
  try {
    const st = execFileSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return st.startsWith('Z'); // macOS/Linux: 'Z' / 'Z+' = zombie/defunct
  } catch { return false; }     // can't tell → don't claim it's a zombie (fail closed on liveness)
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  return !isZombie(pid);
}
function procStartMs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    if (!out) return null;
    const t = Date.parse(out);
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}
function holderStillLive(pid, recordedStartMs) {
  if (!pidAlive(pid)) return false;
  if (recordedStartMs == null) return true;
  const nowStart = procStartMs(pid);
  // FAIL CLOSED (CLAUDE.md §3): the pid is ALIVE but we can't read its start time
  // (e.g. `ps` missing on a minimal PATH). We cannot PROVE pid-reuse, so we must NOT
  // steal — assume it's the same live holder. Stealing a live foreign lock here would
  // let two writers in = the exact corruption this lock prevents.
  if (nowStart == null) return true;
  return Math.abs(nowStart - recordedStartMs) <= START_TOLERANCE_MS;
}

// Parent pid of `pid` via ps (macOS + Linux). null if unreadable.
function ppidOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const n = parseInt(out, 10);
    return Number.isInteger(n) ? n : null;
  } catch { return null; }
}
// Is `ancestorPid` anywhere in this process's parent chain? Bounded walk to pid 1.
function isAncestorOfSelf(ancestorPid) {
  if (!Number.isInteger(ancestorPid) || ancestorPid <= 0) return false;
  if (ancestorPid === process.pid) return true;
  let p = process.ppid;
  for (let i = 0; i < 40 && Number.isInteger(p) && p > 1; i++) {
    if (p === ancestorPid) return true;
    p = ppidOf(p);
    if (p == null) break;
  }
  return false;
}

// The identity of a vault = realpath(its directory) + its filename. Used BOTH to decide
// "is this the canonical vault" and to derive the lock path, so the two can never disagree.
// The directory is realpath'd (it exists whenever a db is opened) but the basename is kept
// verbatim: resolve() alone leaves /var/… and /private/var/… (or any symlinked dir) looking
// like two different vaults, which would fail OPEN — the canonical test would no-op and two
// writers would share one file unlocked. Realpathing the db FILE instead would make the lock
// path depend on whether the file exists yet, so a first-boot race could pick two different
// lock paths for one vault; the directory is stable either way.
function vaultIdentity(p) {
  const abs = resolve(p);
  try { return join(realpathSync(dirname(abs)), basename(abs)); }
  catch { return abs; } // dir not there yet → nothing to alias with; openSync surfaces it
}

function parseLock(text) {
  // "<pid> <startMs> <familyToken>" — token optional (older format = pid[ start]).
  const [pidStr, startStr, token] = String(text || '').trim().split(/\s+/);
  const pid = parseInt(pidStr, 10);
  const startMs = startStr != null && /^\d+$/.test(startStr) ? parseInt(startStr, 10) : null;
  return { pid: Number.isInteger(pid) ? pid : -1, startMs, token: token || null };
}

const NOOP = { release: () => {} };

/**
 * Acquire (or verify family ownership of) the canonical-vault writer lock.
 * Returns { release } on success — no-op release when we don't own the lockfile
 * (a same-family member riding the holder's lock). THROWS fail-closed when a live
 * FOREIGN process holds the vault. Non-canonical / :memory: / temp vaults → no-op.
 *
 * @param {string} dbPath the path getDb is about to open r/w
 * @returns {{ release: () => void }}
 */
export function acquireVaultWriterLock(dbPath) {
  // Escape hatch for recovery/maintenance tooling that knowingly owns the box.
  if (process.env.MYCELIUM_SKIP_WRITER_LOCK === '1') return NOOP;
  if (!dbPath || dbPath === ':memory:') return NOOP;
  // Only guard THE canonical vault — never test fixtures / temp dbs.
  //
  // NOTE this cannot tell a fixture from the real vault: resolveDbPath() reads MYCELIUM_DB,
  // and MYCELIUM_DB is exactly how a legitimate pipeline child is pointed at the live vault
  // (jobs.js:127). A gate that sets MYCELIUM_DB=<fixture> therefore makes the FIXTURE
  // canonical here, by design of paths.js. That is safe only because the lock path below is
  // derived from the db file: a fixture locks ITSELF (harmless, and correct — two foreign
  // writers on one fixture should still be refused) instead of the real vault's lock file.
  // This test's real job is the OTHER case: an explicit dbPath that differs from the env
  // (unit tests opening a temp db) → no lock at all.
  const dbId = vaultIdentity(dbPath);
  let canonicalId;
  try { canonicalId = vaultIdentity(resolveDbPath()); } catch { return NOOP; }
  if (dbId !== canonicalId) return NOOP;

  const lockPath = dbId + LOCK_SUFFIX;
  const myToken = process.env.MYCELIUM_VAULT_FAMILY || null;

  for (let attempt = 0; attempt <= RECLAIM_RETRY; attempt++) {
    // Try to become the holder (atomic create).
    try {
      const token = myToken || randomBytes(16).toString('hex');
      const fd = openSync(lockPath, 'wx'); // O_CREAT | O_EXCL
      try { writeSync(fd, `${process.pid} ${SELF_START_MS} ${token}`); } finally { closeSync(fd); }
      // We now own the lock. Publish the token so our spawned children inherit family.
      if (!process.env.MYCELIUM_VAULT_FAMILY) process.env.MYCELIUM_VAULT_FAMILY = token;
      return { release: () => releaseIfOwner(lockPath) };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e; // real fs error — surface it
    }

    // Someone holds it. Read + classify.
    let holder;
    try { holder = parseLock(readFileSync(lockPath, 'utf8')); }
    catch { holder = null; }

    if (!holder || holder.pid <= 0 || !holderStillLive(holder.pid, holder.startMs)) {
      // Dead / garbage holder → reclaim and retry the create.
      try { unlinkSync(lockPath); } catch { /* raced with another reclaimer */ }
      continue;
    }

    // Live holder — is it OUR family?
    const sameToken = !!myToken && holder.token === myToken;
    const sameTree = isAncestorOfSelf(holder.pid);
    if (sameToken || sameTree) {
      // Family member riding the holder's lock — allowed, but we don't own the file.
      if (holder.token && !process.env.MYCELIUM_VAULT_FAMILY) process.env.MYCELIUM_VAULT_FAMILY = holder.token;
      return NOOP;
    }

    // A live FOREIGN process holds the vault → fail closed.
    throw new Error(
      `vault is already open by another process (pid ${holder.pid}). Refusing to open a second ` +
      `writer — concurrent writers corrupt the vault. Quit the other app or MCP session using this ` +
      `vault (e.g. a "node src/index.js" mycelium MCP server), then retry. ` +
      `Lock: ${lockPath}`
    );
  }

  // Exhausted reclaim retries against a flapping lock — fail closed rather than gamble.
  throw new Error(`vault writer lock: could not acquire ${lockPath} after ${RECLAIM_RETRY} reclaim attempts`);
}

// Release ONLY if we are still the recorded owner (pid match) — never delete a lock that
// was reclaimed and re-taken by someone else after we crashed/raced.
function releaseIfOwner(lockPath) {
  try {
    const holder = parseLock(readFileSync(lockPath, 'utf8'));
    if (holder.pid === process.pid) unlinkSync(lockPath);
  } catch { /* already gone / unreadable — nothing to release */ }
}

export default acquireVaultWriterLock;
