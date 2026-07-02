// src/db/disk-guard.js — fail-closed disk-space guard for large vault operations.
//
// WHY: a full/near-full disk is the co-factor behind the vault corruptions. On
// ENOSPC, writes throw "database or disk is full", the WAL balloons (31 MB in the
// repro) and the pipeline children catch-and-return-0 (the silent "describe-more did
// nothing / stuck Describing…" symptom). A 2 GB backup copy or a Generate run on a
// near-full disk is exactly what tips it over. Nothing guarded disk space before this
// (only RAM, in src/hardware/detect.js). @see docs/VAULT-CONCURRENCY-FIX-DESIGN-2026-07-01.md.
//
// POLICY (fail-closed, CLAUDE.md §3): refuse a large vault write/backup unless free
// space on the vault's volume >= max(factor * vaultSize, floorGb). factor=2 covers a
// full VACUUM INTO snapshot (~vault size) plus WAL/temp headroom; floorGb is an
// absolute floor for a small/empty vault.
import fs from 'node:fs';
import path from 'node:path';

const GiB = 2 ** 30;

/**
 * Measure free space on the vault's volume vs. what a large op needs.
 * @param {string} vaultPath
 * @param {{ floorGb?: number, factor?: number }} [opts]
 * @returns {{ ok: boolean, freeBytes: number, needBytes: number, vaultBytes: number,
 *             freeGb: number, needGb: number }}
 */
export function vaultDiskHeadroom(vaultPath, { floorGb = 3, factor = 2 } = {}) {
  const dir = path.dirname(vaultPath);
  let freeBytes;
  try {
    // statfsSync (node >=18.15) reports blocks; bavail = blocks free to unprivileged.
    const st = fs.statfsSync(dir);
    freeBytes = Number(st.bavail) * Number(st.bsize);
  } catch (e) {
    // Can't MEASURE the volume (transient FS error, unusual mount). A guard must never
    // be worse than the no-guard baseline: degrade to "proceed" (ok, unmeasured) rather
    // than throw a non-DISK_LOW error up a fire-and-forget starter or block all writes
    // forever. Surface a warning so it's visible; never include a path in a way that
    // could leak (dir only). @see the reviewer note in the design doc's revision history.
    console.error(`[mycelium] disk-guard could not measure free space (${e.code || e.message}) — proceeding unguarded`);
    return { ok: true, unmeasured: true, freeBytes: Infinity, needBytes: 0, vaultBytes: 0, freeGb: Infinity, needGb: 0 };
  }
  let vaultBytes = 0;
  try { vaultBytes = fs.statSync(vaultPath).size; } catch { /* vault not created yet */ }
  const needBytes = Math.max(vaultBytes * factor, floorGb * GiB);
  return {
    ok: freeBytes >= needBytes,
    freeBytes, needBytes, vaultBytes,
    freeGb: +(freeBytes / GiB).toFixed(1),
    needGb: +(needBytes / GiB).toFixed(1),
  };
}

/**
 * Throw a tagged DISK_LOW error when headroom is insufficient. The message carries
 * only sizes (never vault contents, CLAUDE.md §1). Callers map err.code === 'DISK_LOW'
 * to a structured { status: 'disk_low' } response so the UI can say "free N GB".
 * @param {string} vaultPath
 * @param {{ floorGb?: number, factor?: number }} [opts]
 * @returns {ReturnType<typeof vaultDiskHeadroom>}
 */
export function assertVaultDiskHeadroom(vaultPath, opts) {
  const r = vaultDiskHeadroom(vaultPath, opts);
  if (!r.ok) {
    const err = new Error(`DISK_LOW: free ${r.freeGb}GB < required ${r.needGb}GB on the vault volume`);
    err.code = 'DISK_LOW';
    err.detail = r;
    throw err;
  }
  return r;
}
