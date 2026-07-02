// src/db/integrity.js — schedule a DETACHED, throttled vault integrity check at boot.
//
// WHY: P0 fixed the known corruption vector (torn live-file copy), but a cognitive
// vault deserves early detection of ANY future corruption so recovery is lossless (the
// snapshots are now consistent — @see src/db/backup.js). quick_check costs ~24 s on a
// 2 GB vault, so it must NOT run synchronously in the server (it would stall boot / the
// event loop). Instead we spawn src/db/vault-integrity-check.mjs DETACHED (its own
// process, read-only) and throttle it to once/24h. On a corrupt verdict we log loudly
// and drop a marker file the app can surface; we never auto-overwrite the vault (that
// policy is operator-gated). @see docs/VAULT-CONCURRENCY-FIX-DESIGN-2026-07-01.md.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK_SCRIPT = fileURLToPath(new URL('./vault-integrity-check.mjs', import.meta.url));
const THROTTLE_MS = 24 * 60 * 60 * 1000; // once per day
const STAMP = '.last-integrity-check';
const MARKER = '.vault-corrupt';

/** Absolute path to the corruption marker for a vault, or null. Cheap; the app can
 *  read this to surface "vault may be corrupt — check health" without re-scanning. */
export function vaultCorruptMarkerPath(dbPath) {
  return path.join(path.dirname(dbPath), MARKER);
}

/**
 * Fire-and-forget: spawn a throttled, detached integrity check for the CANONICAL vault.
 * No-ops (and returns a reason) for fixtures, when disabled, or when throttled. Never
 * throws — a detection convenience must never break boot.
 * @param {{ dbPath: string, userHex?: string|null, isCanonical: boolean }} opts
 * @returns {{ scheduled: boolean, reason?: string }}
 */
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
        try { fs.writeFileSync(markerPath, JSON.stringify({ at: Date.now(), detail })); } catch { /* */ }
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
