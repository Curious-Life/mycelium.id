// src/db/vault-halt.js — the fail-STOP latch for structural vault damage.
//
// THE FAILURE IT PREVENTS (observed 2026-07-26/27 on the production vault, in the app's
// own log): SQLite reported "database disk image is malformed" on a write, an ordinary
// catch block swallowed it as a local failure, and the app went on to write 3,840 more
// embeddings into the damaged file — then ran for another ~800 log lines and four
// reboots. One bad page became an unrecoverable vault.
//
//   server-rest.log:212  [llm-usage] record failed: database disk image is malformed
//   server-rest.log:213  [llm-usage] record failed: database disk image is malformed
//   server-rest.log:214  [enrich] embedded 3840 message(s) in-process
//
// WHY A LATCH AND NOT 432 FIXED CATCH BLOCKS: this repo has 432 try/catch blocks that
// wrap a DB call and neither rethrow nor exit (158 of them on write paths), plus 205
// inline `.catch(() => …)` swallows. Auditing them one at a time is the whack-a-mole
// that produced the previous five durability patches. Instead, corruption is latched
// PROCESS-WIDE and re-checked at the adapter chokepoint BEFORE the file is touched
// (src/adapter/d1.js). After the first trip, every later call refuses up front — so the
// existing catches swallow a REFUSAL instead of completing a write. They become
// harmless without being changed. Damage is bounded to the statements already in flight.
//
// WHY NOT REPAIR / CHECKPOINT / SNAPSHOT ON TRIP: every one of those WRITES to a file we
// have just proven unsafe to write. Hand-repair is also what re-infected the vault across
// 2026-07-14/15 (see the 2026-07-16 root-cause doc, "Why it kept re-igniting"). This
// module records and refuses. It never touches the vault. Recovery is operator-gated
// through scripts/vault-repair/install-vault.mjs.
//
// WHY NOT process.exit(): server-rest is supervised with backoff respawn
// (src-tauri/src/main.rs). Exiting on corruption yields a respawn loop that reopens the
// damaged file — strictly worse than staying up and refusing.
//
// CONTENT-FREE (CLAUDE.md §1): the recorded context is a statement SHAPE ("INSERT
// llm_usage") — a verb and a table name, both of which are code. Bound params carry
// plaintext and are NEVER passed in here.

import fs from 'node:fs';
import Database from 'better-sqlite3';
import path from 'node:path';
import { recordDurabilityEvent, isCorruptionError } from './durability-log.js';
import { vaultCorruptMarkerPath, appendCorruptionEvent, writeVaultCorruptMarker } from './integrity.js';

/** Thrown by assertVaultUsable() once the latch is set. Distinct from the original
 *  SQLITE_CORRUPT so callers/gates can tell "the vault broke" from "we already knew". */
export class VaultHaltedError extends Error {
  constructor(state) {
    super(
      'vault access refused: this vault reported structural damage (SQLite: database disk ' +
      'image is malformed) and Mycelium has stopped writing to it to prevent further loss. ' +
      'Your data on disk is frozen as-is. Recover with scripts/vault-repair/ (see ' +
      'install-vault.mjs) or restore a snapshot — do not delete the file.',
    );
    this.code = 'VAULT_HALTED';
    this.haltedAt = state?.at ?? null;
    this.sqliteCode = state?.sqliteCode ?? null;
  }
}

// Process-wide, deliberately module-level: one vault per process, and the latch must
// outlive any individual adapter/connection so a reconnect cannot clear it.
let _state = null;

/** Recovery/maintenance tooling that knowingly owns the box (mirrors
 *  MYCELIUM_SKIP_WRITER_LOCK). Read at call time so tests can toggle it.
 *
 *  ⚠️ This restores UNRESTRICTED writes to a vault proven damaged — i.e. exactly the
 *  pre-2026-07-28 behaviour that lost the vault. It exists because recovery tooling must
 *  be able to touch a condemned file, and for nothing else. Its use is recorded once
 *  (below) so a durability log never shows a quiet vault where the hatch was simply left
 *  set in someone's shell. */
let _bypassNoted = false;
function bypassed() {
  const on = process.env.MYCELIUM_IGNORE_VAULT_HALT === '1';
  if (on && _state && !_bypassNoted) {
    _bypassNoted = true;
    try { recordDurabilityEvent('vault-halt-bypassed', { code: _state.sqliteCode, op: _state.op }); } catch { /* */ }
  }
  return on;
}

/**
 * Reduce a statement to a content-free shape: verb + table.
 *
 * §1 IS THE WHOLE POINT OF THIS FUNCTION, and the obvious implementation violates it.
 * A first version scanned the whole statement for /\bFROM\s+(\w+)/ and claimed the
 * `[A-Za-z0-9_]` charset "excludes literals". It does not — it excludes QUOTES, not the
 * text between them. Independent review measured, on real inputs:
 *
 *   UPDATE settings SET value = 'imported from gmail_backup_2019'  →  "UPDATE gmail_backup_2019"
 *   INSERT INTO notes (body) VALUES ('a letter from Margaret …')   →  "INSERT Margaret"
 *   UPDATE documents SET body='x' WHERE title='into oblivion_…'    →  "UPDATE oblivion_therapy"
 *
 * i.e. any user literal containing "from <word>" or "into <word>" was copied verbatim
 * into durability-events.jsonl, .vault-corrupt and stderr.
 *
 * So: strip SQL string literals FIRST, then match only at the position the verb fixes.
 * Two independent defences — a literal cannot survive step 1, and even if one did it
 * could not be at an anchored table position.
 *
 * @param {string} sql
 * @returns {string} e.g. "INSERT llm_usage" | "SELECT documents" | "UPDATE"
 */
export function sqlShape(sql) {
  // 1. Remove single-quoted string literals (SQLite: '' is the escape; "" and `` are
  //    IDENTIFIER quoting, so those are left for the anchored match below).
  const s = String(sql || '').replace(/'(?:[^']|'')*'/g, "''").trim();

  const m = /^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|VACUUM|WITH)\b/i.exec(s);
  const verb = m ? m[1].toUpperCase() : 'UNKNOWN';

  // 2. Anchored to the start of the statement — never a free scan of the tail.
  //    A SELECT's FROM is the one clause that legitimately floats, so it is matched only
  //    up to the first clause keyword that can introduce user data.
  const ident = '["`\\[]?([A-Za-z_][A-Za-z0-9_]{0,62})';
  const t =
    new RegExp(`^\\s*INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${ident}`, 'i').exec(s) ||
    new RegExp(`^\\s*REPLACE\\s+INTO\\s+${ident}`, 'i').exec(s) ||
    new RegExp(`^\\s*UPDATE\\s+(?:OR\\s+\\w+\\s+)?${ident}`, 'i').exec(s) ||
    new RegExp(`^\\s*DELETE\\s+FROM\\s+${ident}`, 'i').exec(s) ||
    new RegExp(`^\\s*SELECT\\b[^'"]*?\\sFROM\\s+${ident}`, 'i').exec(s);

  return t ? `${verb} ${t[1]}` : verb;
}

/**
 * Latch structural damage. Idempotent — the first trip wins and later ones are silent,
 * so a burst of failing statements produces ONE forensic record, not thousands.
 * Never throws: a failing black box must not mask the corruption it is recording.
 *
 * @param {Error} err  the SQLite error that proved the damage
 * @param {{ op?: string, dbPath?: string|null }} [ctx] content-free context
 * @returns {object} the halt state
 */
export function tripVaultHalt(err, ctx = {}) {
  if (_state) return _state;

  _state = {
    halted: true,
    at: new Date().toISOString(),
    sqliteCode: String(err?.code || '') || 'SQLITE_CORRUPT',
    op: ctx.op || null,
    pid: process.pid,
  };

  // Loud, once. This is the line an operator greps for.
  // WRAPPED: on a Finder launch stderr can be closed (the premise of durability-log.js
  // itself), and this was the one statement in tripVaultHalt that could throw. It sits
  // upstream of the forensic writes, so an EPIPE here would have masked the very
  // SQLITE_CORRUPT it is announcing (independent review, 2026-07-28).
  try {
    console.error(
      `[mycelium] VAULT HALTED — SQLite reported structural damage (${_state.sqliteCode}` +
      `${_state.op ? ` on ${_state.op}` : ''}). All further vault access is refused so the ` +
      `damage cannot spread. The file has NOT been modified, deleted or repaired. ` +
      `See scripts/vault-repair/README.md.`,
    );
  } catch { /* stderr gone — the JSONL below is the durable record anyway */ }

  // Forensics. Both are fail-soft by contract; wrapped anyway so neither can shadow the
  // other, and so a read-only data dir cannot turn a corruption into a crash.
  try {
    recordDurabilityEvent('sqlite-corrupt', {
      code: _state.sqliteCode,
      op: _state.op,
      source: 'query-chokepoint',
    });
  } catch { /* black box must never take the plane down */ }

  const dbPath = ctx.dbPath || null;
  if (dbPath) {
    try {
      appendCorruptionEvent(path.dirname(dbPath), {
        source: 'runtime-query',
        detail: `${_state.sqliteCode}${_state.op ? ` ${_state.op}` : ''}`,
      });
    } catch { /* ledger is best-effort */ }
    // The marker is what makes the NEXT boot refuse cleanly instead of reopening a
    // damaged file and replaying its WAL. Written last: it is the durable half.
    writeVaultCorruptMarker(dbPath, { at: _state.at, code: _state.sqliteCode, op: _state.op, source: 'runtime-query' });
  }

  return _state;
}

/**
 * Read the `.vault-corrupt` marker for a vault, if this box has already condemned it.
 * The counterpart to the write in tripVaultHalt — and the reason that write is worth
 * doing at all. Consumed by boot (src/index.js) so a condemned vault is not reopened,
 * and it is the ONLY cross-process signal: the latch above is per-process, so this is
 * what stops the pipeline children writing to a file server-rest has already halted on.
 *
 * @param {string} dbPath
 * @returns {{ at?: string, code?: string, op?: string, source?: string }|null}
 */
export function readVaultCorruptMarker(dbPath) {
  if (!dbPath || dbPath === ':memory:') return null;
  try {
    const body = fs.readFileSync(vaultCorruptMarkerPath(dbPath), 'utf8').trim();
    // PRESENCE is the signal, not parseability. Returning null for an empty or unparseable
    // marker collapsed "no marker" into "damaged marker" and FAILED OPEN: boot skipped every
    // branch and opened the condemned vault read/write. tripVaultHalt writes this file with a
    // plain truncate-then-write, so a crash or ENOSPC mid-write leaves exactly the 0-byte
    // case. Adversarial review round 4, 2026-07-28.
    if (!body) return { source: 'unreadable-marker', unreadable: true };
    // Tolerate the legacy plain-text marker (integrity.js wrote quick_check output here
    // before this module existed).
    // The parse RESULT must be an object, not merely parseable. A first line of `null`,
    // `0`, `false` or `""` parses fine to a FALSY value, and `if (mark)` in src/index.js
    // then skips the entire gate — measured: 2.27 MB written into a condemned vault for
    // four of the five falsy shapes, while the "presence is the signal, not parseability"
    // invariant sits four lines above. Round-6 review, 2026-07-28.
    try {
      const parsed = JSON.parse(body.split('\n')[0]);
      if (parsed && typeof parsed === 'object') return parsed;
      return { source: 'unreadable-marker', unreadable: true };
    } catch { return { source: 'integrity-check' }; } // legacy plain-text marker
  } catch (e) {
    // ENOENT is the ONLY healthy answer. Anything else (EACCES, EIO) means a marker we
    // cannot read, and "we could not read the condemnation" is not "there was none".
    if (e && e.code === 'ENOENT') return null;
    return { source: 'unreadable-marker', unreadable: true, reason: e?.code || 'error' };
  }
}

/**
 * Clear the condemnation marker. Called ONLY after an integrity check has just proven the
 * file healthy — a marker that clears itself on anything less would be worthless, and a
 * marker nothing can clear is a permanent lockout (which is what the first version was).
 * @param {string} dbPath
 */
export function clearVaultCorruptMarker(dbPath) {
  if (!dbPath || dbPath === ':memory:') return false;
  try { fs.rmSync(vaultCorruptMarkerPath(dbPath), { force: true }); return true; }
  catch { return false; }
}

/**
 * SYNCHRONOUS read-only integrity verdict for a keyed vault — the "prove yourself" check a
 * flagged vault must pass at boot. Read-only by construction: this runs on a file we
 * currently distrust, so it must not be able to write to it.
 *
 * @param {string} dbPath
 * @param {string|null} dbKeyHex 64-char hex, or null for a plaintext vault
 * @returns {{ ok: boolean, reason: string }}
 */
export function verifyVaultIntegritySync(dbPath, dbKeyHex) {
  let db = null;
  // ABSENT is its own answer, and it is NOT damage. A user whose vault was condemned
  // does the obvious thing and deletes mycelium.db to start over — but the marker is a
  // SIBLING of the vault, so it outlives the file it describes. Folding "gone" into
  // "damaged" made every later boot throw before initVaultStorage could create a fresh
  // vault: an in-product-unrecoverable brick, and the THIRD instance of that class in
  // this change set. Adversarial review, 2026-07-28.
  if (!fs.existsSync(dbPath)) return { ok: false, verified: true, absent: true, reason: 'vault file does not exist' };
  // Classify a 0-byte vault WITHOUT opening it — the open deletes a -wal beside it, and
  // those pages are exactly what this verdict exists to preserve. @see
  // vaultLooksStructurallySane for the measurement.
  try {
    if (fs.statSync(dbPath).size === 0) {
      return { ok: false, verified: true, empty: true, reason: 'the vault file is empty (0 bytes) — nothing to verify' };
    }
  } catch { /* unreadable — the open below reports it honestly */ }
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    if (dbKeyHex) {
      db.pragma(`cipher='sqlcipher'`);
      db.pragma(`key="x'${dbKeyHex}'"`);
      // A KEYED OPEN OF A PLAINTEXT FILE REPORTS SQLITE_NOTADB. The marker gate runs BEFORE
      // the at-rest migration, so under the app's default (MYCELIUM_AT_REST=1) a vault that
      // is still plaintext was verified WITH a key, answered NOTADB, and fell into the
      // inconclusive branch — which refuses. That bricked every still-plaintext condemned
      // vault, i.e. exactly the population this change set exists for, and made the
      // self-heal branch unreachable in production. The caller now passes a key only for an
      // encrypted vault; this reopen is the second layer. Round 4, 2026-07-28.
      try { db.prepare('SELECT count(*) FROM sqlite_master').get(); }
      catch (keyed) {
        if (String(keyed?.code) !== 'SQLITE_NOTADB') throw keyed;
        try { db.close(); } catch { /* */ }
        db = new Database(dbPath, { readonly: true, fileMustExist: true }); // plaintext retry
      }
    }
    db.pragma('query_only = true');
    // A sibling holding the file must not read as "cannot verify" — that is an
    // inconclusive answer, and inconclusive answers now refuse (see below).
    try { db.pragma('busy_timeout = 10000'); } catch { /* older builds */ }
    // AN EMPTY FILE PASSES quick_check VACUOUSLY. A 0-byte SQLite file answers "ok" and
    // has an empty sqlite_master, so a condemned vault that got TRUNCATED — an interrupted
    // install-vault copy, ENOSPC, a failed restore — used to read as REPAIRED: boot cleared
    // the marker, told the owner "quick_check now passes (repaired or restored)", and wrote
    // 2.7 MB of fresh schema over it, destroying the -wal remnants a repair tool would use.
    // Measured with a 103 KB -wal holding 3,000 uncheckpointed rows still beside it.
    // This is the "cannot tell 'it worked' from 'nothing ran'" class, in the one place it
    // costs the user their data. Adversarial review round 3, 2026-07-28.
    const pages = Number(db.pragma('page_count', { simple: true }) ?? 0);
    if (!Number.isFinite(pages) || pages === 0) {
      return { ok: false, verified: true, empty: true, reason: 'the vault file is empty (0 pages) — nothing to verify' };
    }
    const rows = db.pragma('quick_check');
    const verdict = rows.map((r) => r.quick_check ?? r).join(' | ');
    return verdict === 'ok'
      ? { ok: true, verified: true, reason: 'ok' }
      : { ok: false, verified: true, reason: `quick_check: ${verdict.slice(0, 160)}` };
  } catch (e) {
    // A THROWN SQLITE_CORRUPT/NOTADB IS A VERDICT, NOT A NON-ANSWER. quick_check throws
    // outright when the damage is bad enough — a shredded page 1 is the shape the
    // 2026-07-26 vault was found in. Folding that into "could not look" made this
    // function fail OPEN: the first version of this branch let boot continue, and an
    // adversarial review then wrote 3,840 rows — the production number — into a vault
    // this box had already condemned, through the real boot(). That is precisely the
    // bleed the whole change set exists to stop, reintroduced by the fix for the
    // lockout. Measured 2026-07-28.
    if (isCorruptionError(e)) {
      return { ok: false, verified: true, reason: `quick_check threw ${e?.code || 'SQLITE_CORRUPT'}` };
    }
    // Genuinely inconclusive (locked, permissions, an I/O error): say so, and let the
    // caller REFUSE. "We could not disprove the condemnation" is not a licence to write.
    return { ok: false, verified: false, reason: `could not verify (${e?.code || e?.message || 'error'})` };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

/**
 * D-117 — THE CHEAP CHECK, for the FIRST-ENCOUNTER path.
 *
 * verifyVaultIntegritySync runs `PRAGMA quick_check`, which reads every page: ~1 s on
 * this machine's 86 MB vault, ~24 s on 2 GB. That is affordable ONCE, before a rewrite;
 * it is not affordable on every boot. This is the O(1) half — page count plus a header
 * parse — and it catches the shapes that actually turn up: a truncated file (an
 * interrupted copy, ENOSPC, a half-finished restore) and a shredded page 1, which is
 * how the 2026-07-26 vault was found.
 *
 * ⚠️ DELIBERATELY NOT A VERDICT. Its result must never reach decideMarkerAction(): a
 * shallow "looks fine" is not evidence a condemnation can be CLEARED on, and wiring it
 * into VERDICT_KINDS would make that mistake one typo away. Its own three-valued type
 * (true | false | null) keeps the confusion structurally impossible rather than merely
 * discouraged — the same reason decideMarkerAction is a total function over named axes.
 *
 * @param {string} dbPath
 * @param {string|null} dbKeyHex
 * @returns {{ sane: boolean|null, reason: string }} null = could not tell (NOT "fine")
 */
export function vaultLooksStructurallySane(dbPath, dbKeyHex) {
  if (!dbPath || dbPath === ':memory:') return { sane: true, reason: 'not a file vault' };
  if (!fs.existsSync(dbPath)) return { sane: true, reason: 'no vault yet — nothing to damage' };
  // ⚠️ ANSWER "EMPTY" WITHOUT OPENING. Measured 2026-07-29: opening a 0-byte vault
  // read-only DELETES a -wal sitting beside it — 105,472 bytes present before the open,
  // gone after. Those uncheckpointed pages are the ONLY recoverable content a truncated
  // vault has, and preserving them is the entire stated purpose of the `empty` verdict
  // (see verifyVaultIntegritySync, which records the real incident: "a 103 KB -wal holding
  // 3,000 uncheckpointed rows still beside it"). The probe was destroying the evidence it
  // exists to protect. A 0-byte file needs no open to classify.
  try {
    if (fs.statSync(dbPath).size === 0) return { sane: false, reason: 'the vault file is empty (0 pages)' };
  } catch { /* unreadable — fall through to the open, which will say so */ }
  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    if (dbKeyHex) {
      db.pragma(`cipher='sqlcipher'`);
      db.pragma(`key="x'${dbKeyHex}'"`);
      // Same plaintext-retry as verifyVaultIntegritySync: a keyed open of a
      // still-plaintext file answers NOTADB, and that is not damage.
      try { db.prepare('SELECT count(*) FROM sqlite_master').get(); }
      catch (keyed) {
        if (String(keyed?.code) !== 'SQLITE_NOTADB') throw keyed;
        try { db.close(); } catch { /* */ }
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
      }
    }
    db.pragma('query_only = true');
    // A sibling holding the file must read as "could not tell", never as damage.
    try { db.pragma('busy_timeout = 10000'); } catch { /* older builds */ }
    const pages = Number(db.pragma('page_count', { simple: true }) ?? 0);
    if (!Number.isFinite(pages) || pages === 0) {
      return { sane: false, reason: 'the vault file is empty (0 pages)' };
    }
    // Page 1 must parse as a schema. A shredded header throws here rather than
    // returning something wrong, which is exactly the signal we want.
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    return { sane: true, reason: `${pages} pages, header readable` };
  } catch (e) {
    if (isCorruptionError(e)) return { sane: false, reason: `${e?.code || 'SQLITE_CORRUPT'} reading the header` };
    return { sane: null, reason: `could not tell (${e?.code || e?.message || 'error'})` };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

/** @returns {boolean} true once structural damage has been latched in this process. */
export function isVaultHalted() {
  return _state !== null && !bypassed();
}

/** @returns {object|null} the halt state (content-free), or null. */
export function vaultHaltState() {
  return _state ? { ..._state } : null;
}

/**
 * The gate. Called at the top of every adapter query BEFORE the file is touched.
 * Throws VaultHaltedError once the latch is set; a no-op otherwise (one null check —
 * this sits on the hottest path in the app).
 */
export function assertVaultUsable() {
  if (_state !== null && !bypassed()) throw new VaultHaltedError(_state);
}

/**
 * Classify-and-latch in one call, for use inside a catch. Returns true when the error
 * was structural damage (and the latch is now set), false for transient errors
 * (SQLITE_BUSY / SQLITE_LOCKED / IOERR) which must NOT halt the vault.
 */
export function noteQueryError(err, ctx = {}) {
  if (!isCorruptionError(err)) return false;
  tripVaultHalt(err, ctx);
  return true;
}

/** Test-only: clear the latch. Never called from src/. */
export function __resetVaultHaltForTests() {
  _state = null;
}

export default assertVaultUsable;

// ─────────────────────────────────────────────────────────────────────────────────────
// THE MARKER DECISION — one pure, TOTAL function over a declared state space.
//
// Why this exists rather than a chain of if/else in src/index.js: six adversarial review
// rounds each found a defect here, and every one was an UNHANDLED COMBINATION that fell
// into a permissive branch — a condemned vault opened and written to, or a healthy one
// bricked. The branches were individually correct; the state space was never enumerated,
// so "did I miss a case?" stayed a judgement call, and it was wrong six times.
//
// Splitting the decision out converts that judgement into a COVERAGE COUNT a gate can
// check: MARKER_KINDS × VERDICT_KINDS is a finite cartesian product, verify:vault-fail-stop
// asserts a row for every pair, and an unenumerated pair throws here rather than silently
// picking a branch. Adding a state to either axis therefore FAILS until it is tabled.
//
// The two axes are deliberately coarse — they are the properties the decision actually
// turns on, not the shape of the objects that carry them.

/** The kinds of `.vault-corrupt` marker `readVaultCorruptMarker` can yield. */
export const MARKER_KINDS = Object.freeze(['none', 'owns-this-file', 'names-other-file']);

/** The kinds of verdict `verifyVaultIntegritySync` can yield. */
export const VERDICT_KINDS = Object.freeze(['ok', 'absent', 'empty', 'damaged', 'inconclusive']);

/** @returns {'none'|'owns-this-file'|'names-other-file'} */
export function markerKind(mark, dbFile) {
  if (!mark) return 'none';
  // No `db` field ⇒ a legacy marker (from a build before the field existed) or the
  // unreadable sentinel. It cannot prove it means another file, so it is treated as OWNING
  // this one. That is unambiguously right for REFUSING — an unowned condemnation still
  // refuses, since the verdict is about the file being opened.
  //
  // ⚠️ It is a JUDGEMENT for CLEARING, not a guarantee, and an earlier version of this
  // comment overstated it (round-7 review). A no-`db` marker condemning vault A IS cleared
  // by booting a healthy vault B in the same directory — the round-4 defect, surviving in
  // this one corner. Accepted deliberately: the alternative is that legacy markers can
  // never self-heal, which is the permanent lockout of D-112, and two vaults sharing one
  // data dir is not a shipped configuration. Every marker written from this release
  // carries `db`, so the corner closes as installs turn over.
  if (!mark.db) return 'owns-this-file';
  return mark.db === dbFile ? 'owns-this-file' : 'names-other-file';
}

/** @returns {'ok'|'absent'|'empty'|'damaged'|'inconclusive'} */
export function verdictKind(verdict) {
  if (!verdict) return 'inconclusive';
  if (verdict.absent) return 'absent';
  if (verdict.empty) return 'empty';
  if (verdict.ok) return 'ok';
  if (verdict.verified) return 'damaged';
  return 'inconclusive';
}

/**
 * Decide what boot does about a condemnation marker. PURE — no I/O, no throwing for
 * control flow; the caller performs the action.
 *
 * @param {{ mark: object|null, verdict: object|null, dbFile: string }} o
 * @returns {{ action: 'BOOT'|'REFUSE', clearMarker: boolean, kind: string, why: string }}
 */
export function decideMarkerAction({ mark, verdict, dbFile }) {
  const mk = markerKind(mark, dbFile);
  if (mk === 'none') return { action: 'BOOT', clearMarker: false, kind: 'none/–', why: 'no condemnation on record' };

  const vk = verdictKind(verdict);
  const owns = mk === 'owns-this-file';
  const kind = `${mk}/${vk}`;

  switch (vk) {
    // PROVEN HEALTHY. Clear only a marker that is ours to clear — the marker file is
    // directory-scoped, so clearing one that names another vault un-condemns THAT vault.
    case 'ok':
      return { action: 'BOOT', clearMarker: owns, kind, why: 'quick_check now passes — repaired or restored' };

    // THE FILE IS GONE. A marker cannot condemn a file that does not exist, and refusing
    // here is how a user who deleted a damaged vault to start over is locked out entirely.
    case 'absent':
      return { action: 'BOOT', clearMarker: owns, kind, why: 'the condemned file is no longer at this path' };

    // EMPTY IS NOT REPAIRED. quick_check answers "ok" on a 0-byte file; a truncated main
    // file may still have a -wal holding uncheckpointed rows, and booting writes a fresh
    // schema over exactly the material a repair tool needs.
    case 'empty':
      return { action: 'REFUSE', clearMarker: false, kind, why: 'the vault file is empty — truncated, not repaired' };

    // PROVEN DAMAGED.
    case 'damaged':
      return { action: 'REFUSE', clearMarker: false, kind, why: 'the vault is still structurally damaged' };

    // COULD NOT CHECK. Not a licence to write: the marker says condemned and we could not
    // disprove it. Note this REFUSES regardless of ownership — a verdict is about the file
    // being opened, so a marker naming another vault does not make this one safe.
    case 'inconclusive':
      return { action: 'REFUSE', clearMarker: false, kind, why: 'the condemnation could not be re-checked' };

    default:
      // UNENUMERATED. Fail closed and loudly: every previous defect here was a new state
      // quietly taking a permissive path.
      throw new Error(`decideMarkerAction: unhandled verdict kind "${vk}" — enumerate it in VERDICT_KINDS and table it`);
  }
}
