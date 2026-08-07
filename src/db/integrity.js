// src/db/integrity.js — schedule a DETACHED, throttled vault integrity check at boot.
//
// WHY: P0 fixed the known corruption vector (torn live-file copy), but a cognitive
// vault deserves early detection of ANY future corruption so recovery is lossless (the
// snapshots are now consistent — @see src/db/backup.js). quick_check costs ~24 s on a
// 2 GB vault, so it must NOT run synchronously in the server (it would stall boot / the
// event loop). Instead we spawn src/db/vault-integrity-check.mjs DETACHED (its own
// process, read-only) and throttle it to once/24h. On a corrupt verdict we log loudly
// and drop a marker file the app can surface; we never auto-overwrite the vault (that
// policy is operator-gated). @see the vault-concurrency-fix design.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK_SCRIPT = fileURLToPath(new URL('./vault-integrity-check.mjs', import.meta.url));
// D-140 (QA11D): was a fixed 24 h. Both 2026 corruption events sat undetected inside a
// single day (the 08-05 damage window was ~9 h wide, discovered only when a read
// happened to walk the damaged region). 6 h default = detection beats the operator to
// the symptom; env-tunable, floor 1 h so a typo cannot make the check spin.
const THROTTLE_MS = Math.max(1, Number(process.env.MYCELIUM_INTEGRITY_INTERVAL_H) || 6) * 60 * 60 * 1000;
const STAMP = '.last-integrity-check';
const MARKER = '.vault-corrupt';

/** Absolute path to the corruption marker for a vault, or null. Cheap; the app can
 *  read this to surface "vault may be corrupt — check health" without re-scanning. */
export function vaultCorruptMarkerPath(dbPath) {
  return path.join(path.dirname(dbPath), MARKER);
}

// Append-only corruption LEDGER (JSONL beside the vault). The marker above records
// only the LATEST event; five corruption events over 2026-07-02..16 left no history
// beyond hand-named archive files — which a cleanup then deleted, destroying the
// forensic trail. One line per event: timestamp + source + a CONTENT-FREE detail
// (quick_check output names pages/trees, never user data — §1). Never throws.
const LEDGER = 'corruption-events.jsonl';
export function appendCorruptionEvent(dir, { source, detail = '' } = {}) {
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      source: String(source || 'unknown').slice(0, 60),
      detail: String(detail).slice(0, 500),
      pid: process.pid,
    });
    fs.appendFileSync(path.join(dir, LEDGER), line + '\n');
  } catch { /* a ledger must never break detection */ }
}
export function corruptionLedgerPath(dbPath) {
  return path.join(path.dirname(dbPath), LEDGER);
}

/**
 * Fire-and-forget: spawn a throttled, detached integrity check for the CANONICAL vault.
 * No-ops (and returns a reason) for fixtures, when disabled, or when throttled. Never
 * throws — a detection convenience must never break boot.
 * @param {{ dbPath: string, userHex?: string|null, isCanonical: boolean }} opts
 * @returns {{ scheduled: boolean, reason?: string }}
 */
/**
 * Write the condemnation marker. THE ONLY WRITER — there used to be two, and they drifted:
 * the latch emitted `db` while src/db/integrity.js (the app's own scheduled checker, and
 * the more common condemnation path in practice) emitted `{at, detail}` with no `db`, which
 * made index.js's ownership test vacuously true and let a sibling boot un-condemn the real
 * vault. A format that two places construct is a format that will diverge again.
 * Round-5 review, 2026-07-28.
 * @param {string} dbPath
 * @param {{ at?: string|number, code?: string, op?: string, detail?: string, source: string }} fields
 */
export function writeVaultCorruptMarker(dbPath, fields = {}) {
  const payload = {
    at: fields.at ?? new Date().toISOString(),
    ...(fields.code ? { code: fields.code } : {}),
    ...(fields.op ? { op: fields.op } : {}),
    ...(fields.detail ? { detail: fields.detail } : {}),
    db: path.basename(dbPath), // WHICH file this condemns — load-bearing, see above
    source: fields.source || 'unknown',
  };
  try { fs.writeFileSync(vaultCorruptMarkerPath(dbPath), `${JSON.stringify(payload)}\n`); return true; }
  catch { return false; }
}

/**
 * D-140 (QA11D): re-arm the off-loop check PERIODICALLY, not just at boot. A server
 * that stays up for days used to go unchecked for days — the 08-05 damage sat for
 * ~9 h inside one uptime. Hourly re-arm; the stamp-file throttle above is the real
 * cadence gate (default 6 h), so this costs one stat() per hour. unref'd — a timer
 * must never hold the process open. Returns the timer for tests.
 */
let _periodicTimer = null;
export function armPeriodicIntegrityCheck(opts) {
  // SINGLETON per process (review M2): boot() is called per MCP session in the
  // :4711 sibling (server-http.js), so an unguarded arm leaked one interval —
  // plus its captured opts — per session, firing for vault handles long closed.
  if (_periodicTimer) return _periodicTimer;
  _periodicTimer = setInterval(() => { try { maybeScheduleIntegrityCheck(opts); } catch { /* never break the server */ } }, 60 * 60 * 1000);
  _periodicTimer.unref?.();
  return _periodicTimer;
}

export function maybeScheduleIntegrityCheck({ dbPath, userHex = null, isCanonical }) {
  try {
    if (!isCanonical) return { scheduled: false, reason: 'not-canonical' };
    if (process.env.MYCELIUM_SKIP_INTEGRITY_CHECK) return { scheduled: false, reason: 'disabled' };
    const dir = path.dirname(dbPath);
    const stampPath = path.join(dir, STAMP);

    // Throttle on the stamp file's mtime. Missing/old → run; recent → skip.
    try {
      const ageMs = Date.now() - fs.statSync(stampPath).mtimeMs;
      if (ageMs < THROTTLE_MS) return { scheduled: false, reason: 'throttled' };
    } catch { /* no stamp yet → proceed */ }
    // Stamp NOW so rapid reboots before the scan finishes don't pile up children.
    try { fs.writeFileSync(stampPath, String(Date.now())); } catch { /* best-effort */ }

    // Allowlisted env only (mirror jobs.js): the key travels via env, never argv/logs.
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, MYCELIUM_DB: dbPath };
    if (userHex) env.USER_MASTER = userHex;

    const child = spawn(process.execPath, [CHECK_SCRIPT], {
      detached: true, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > 2000) stdout = stdout.slice(-2000); });
    child.on('error', () => { /* spawn failed — leave detection to the next boot */ });
    child.on('close', (code) => {
      const markerPath = path.join(dir, MARKER);
      if (code === 0) {
        try { fs.rmSync(markerPath); } catch { /* no stale marker */ }
      } else if (code === 1) {
        // CORRUPT — loud + durable, but NEVER auto-overwrite (operator-gated recovery).
        let detail = ''; try { detail = JSON.parse(stdout.trim().split('\n').pop() || '{}').result || ''; } catch { /* */ }
        console.error(`[mycelium] VAULT_CORRUPT: quick_check failed${detail ? ` (${detail})` : ''} — restore a recent consistent snapshot; see scripts/vault-repair/. The vault was NOT modified.`);
        // ONE writer for this format — see writeVaultCorruptMarker's header. This path used
        // to construct its own payload without `db`, which made index.js's ownership test
        // vacuously true and let a sibling boot un-condemn the real vault (2.3 MB written
        // into it, measured). Round-5 review.
        writeVaultCorruptMarker(dbPath, { at: new Date().toISOString(), detail, source: 'scheduled-integrity' });
        appendCorruptionEvent(dir, { source: 'scheduled-integrity', detail });
      } else {
        // code 2 (couldn't open/measure) — warn, don't claim corruption, leave marker as-is.
        console.error('[mycelium] integrity check could not run (open/IO error) — will retry next cycle');
      }
    });
    child.unref(); // don't keep the parent alive for the background scan
    return { scheduled: true };
  } catch (e) {
    console.error(`[mycelium] integrity check not scheduled (${e?.message || e})`);
    return { scheduled: false, reason: 'error' };
  }
}
