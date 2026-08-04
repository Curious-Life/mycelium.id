#!/usr/bin/env node
// src/db/vault-copy-worker.mjs — one consistent vault copy in a CHILD process
// (D-130). The boot-path pre-migration snapshot used to run `VACUUM INTO`
// synchronously on the server's event loop (snapshot-on-boot.js snapshotSync) —
// on the operator's 788 MB restore that pegged a core 15+ minutes with
// /account/status unable to answer. This child does the same copy off the
// parent's loop; the parent awaits the exit code (still under the init lock,
// so cross-process boot racers serialize exactly as before).
//
// READ-ONLY OPEN — and this differs from the sync twin (snapshot-on-boot.js:43-50)
// DELIBERATELY, not accidentally: the sync twin must stay write-capable because its
// direct callers (ensureVaultSchema's gate consumers) run it OUTSIDE the init lock,
// where the N=4 racing-migrations case broke a read-only handle (measured
// 2026-07-28). THIS child has exactly one launch context — awaited by
// maybeSnapshotBeforeMigrateOffloop from initVaultStorage WHILE THE PARENT HOLDS
// THE CROSS-PROCESS INIT LOCK — so no family sibling can be mid-migration during
// the copy, which is the settled-vault context snapshot-worker.mjs (also read-only)
// already relies on. Read-only keeps the vault-open-chokepoint ratchet at its
// ceiling (a write-capable opener may not be added; the ratchet may only shrink)
// and cannot write to a damaged vault. verify:at-rest-migration remains the gate
// that would catch this reasoning being wrong.
//
// Env contract (allowlisted by the spawner, key NEVER in argv — the
// snapshot-worker.mjs precedent):
//   MYCELIUM_COPY_SRC   absolute path of the vault to copy   (required)
//   MYCELIUM_COPY_DEST  absolute path of the final snapshot  (required)
//   MYCELIUM_SNAPSHOT_KEY  64-hex db-file key; absent = plaintext vault
//
// Protocol: writes to <dest>.tmp, verifies the copy (page_count, quick_check,
// sqlite_master — the snapshot-worker.mjs bar), chmod 600, atomic rename to
// <dest>. Exit 0 = written+verified; exit 2 = failed (content-free reason on
// stderr). A torn temp file is removed on every failure path.
//
// SECURITY: stderr carries classifications only — never paths' basenames are
// secret-free anyway, but no row content, no key material (§1, §4).

import Database from 'better-sqlite3';
import { rmSync, chmodSync, renameSync } from 'node:fs';

const SRC = process.env.MYCELIUM_COPY_SRC || null;
const DEST = process.env.MYCELIUM_COPY_DEST || null;
const KEY = process.env.MYCELIUM_SNAPSHOT_KEY || null;

function fail(reason) {
  try { process.stderr.write(`[vault-copy] ${reason}\n`); } catch { /* */ }
  process.exit(2);
}

if (!SRC || !DEST) fail('missing src/dest env');
if (KEY && !/^[0-9a-f]{64}$/i.test(KEY)) fail('bad key shape');

const tmp = `${DEST}.tmp`;
const cleanupTmp = () => { for (const sfx of ['', '-wal', '-shm']) { try { rmSync(tmp + sfx, { force: true }); } catch { /* */ } } };

try {
  cleanupTmp();
  // READ-ONLY (see header — the init-lock launch context makes this safe here
  // while the sync twin cannot be; VACUUM INTO succeeds on a read-only handle,
  // measured 2026-07-28 per the openers-allowlist README).
  const src = new Database(SRC, { readonly: true, fileMustExist: true });
  try {
    if (KEY) {
      src.pragma(`cipher='sqlcipher'`);
      src.pragma(`key="x'${KEY}'"`);
    }
    src.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally { try { src.close(); } catch { /* */ } }
  try { chmodSync(tmp, 0o600); } catch { /* best-effort */ }

  // Verify BEFORE the rename — a snapshot that cannot restore is not a snapshot
  // (the snapshot-worker.mjs bar: page_count ≠ 0, quick_check exactly 'ok',
  // sqlite_master non-empty).
  const check = new Database(tmp, { readonly: true, fileMustExist: true });
  try {
    if (KEY) {
      check.pragma(`cipher='sqlcipher'`);
      check.pragma(`key="x'${KEY}'"`);
    }
    const pages = Number(check.pragma('page_count', { simple: true }));
    if (!(pages > 0)) throw new Error('empty copy');
    const qc = check.pragma('quick_check', { simple: true });
    if (qc !== 'ok') throw new Error('quick_check failed');
    const tables = check.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get();
    if (!(Number(tables?.n) > 0)) throw new Error('no schema in copy');
  } finally { try { check.close(); } catch { /* */ } }

  renameSync(tmp, DEST);
  process.exit(0);
} catch (e) {
  cleanupTmp();
  fail(String(e?.code || e?.message || 'copy-failed').slice(0, 200));
}
