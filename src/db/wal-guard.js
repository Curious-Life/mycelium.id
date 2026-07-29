// src/db/wal-guard.js — refuse to let SQLite replay a WAL that belongs to a DIFFERENT
// database file generation.
//
// THE MECHANISM THIS KILLS (demonstrated 2026-07-16, and the #1 fit for every vault
// corruption since 2026-07-14): SQLite binds a -wal to its database by FILENAME, not by
// content. If the database file is REPLACED (a repair swap, a restore, a rebuild) while a
// stale mycelium.db-wal from the previous file remains on disk, the next open silently
// replays the old generation's frames INTO the new file. On a 2 GB vault where the WAL
// holds a fraction of the pages, the result is a chimera — mostly new-generation pages
// with old-generation pages spliced in at their old positions: invalid page pointers,
// rowids out of order, freelist size wrong, index/table disagreement. Exactly the damage
// signature observed five times in two weeks. A fresh rebuild swapped WITH its stale WAL
// died within ~2.5 hours; the identical rebuild swapped with the sidecars removed
// survived indefinitely.
//
// THE GUARD: we record the vault file's generation identity in
// <dataDir>/.vault-binding.json and compare it before any open replays a WAL. The
// TRIGGER is the SQLCipher KDF SALT (the file's first 16 bytes): stable across every
// write to the same file, present in any byte-copy of it, freshly random in every
// rebuilt / VACUUM INTO file — the production corruption vector. On a proven salt
// mismatch with a -wal present, the -wal/-shm are QUARANTINED (renamed aside, never
// deleted) and the swapped-in file opens exactly as its creator validated it.
//
// The inode is recorded but is NOT a trigger (independent review 2026-07-16, two
// PoC-proven false quarantines): legitimate whole-family restores (Time Machine, a new
// Mac) change the inode while the WAL remains same-generation committed data. Inode
// change without salt change = the file MOVED → refresh the binding, touch nothing.
//
// ⚠️ ONE CASE THIS LIST USED TO CLAIM AND DOES NOT ACTUALLY COVER (measured 2026-07-29,
// adversarial review): re-installing an archived `.replaced-*` TRIPLE. install-vault
// archives db+`-wal` together and rebinds to the new generation, so restoring that triple
// later presents a WAL whose salt does not match the recorded binding — it IS quarantined,
// and the restored db opens without its own committed frames. Non-destructive (the WAL is
// renamed aside, never deleted) and loud, and the trade is still right, but it was listed
// among the cases the salt trigger avoids and it is not one. Newly reachable for
// born-encrypted vaults too, now that they carry a binding from their first boot.
//
// FAIL-OPEN without proof: no recorded binding, a plaintext (magic-header) side, or an
// unreadable header → we cannot judge, so we DO NOTHING and record the binding for next
// time. A false quarantine discards committed transactions — worse than the disease.
// Consequences accepted and documented: a PLAINTEXT vault (dev-only) is unguarded, and a
// byte-copy of an OLDER state of the SAME lineage restored over the live file (same
// salt) is invisible. scripts/vault-repair/install-vault.mjs is the mitigation for both.
//
// FAIL-CLOSED with proof: if a provably-foreign WAL cannot be quarantined (EPERM etc.),
// the guard THROWS — refusing the open beats replaying the bomb (§3, §10) — and does
// NOT rebind, so the next boot re-detects instead of trusting.
//
// SECURITY (§1): the binding file holds inode/birthtime/salt-hex — file metadata and
// ciphertext header bytes, no content, no keys. The quarantined WAL is SQLCipher
// ciphertext and stays inside dataDir.

import { existsSync, statSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const BINDING_FILE = '.vault-binding.json';

// The first 16 bytes of an SQLCipher database are its KDF SALT: fixed at file creation,
// untouched by every subsequent write (including checkpoints and in-place VACUUM), and
// freshly random in any rebuilt / VACUUM INTO / restored file. That makes it a perfect
// generation fingerprint for the encrypted vault — it even catches a cp-style swap that
// overwrites the file IN PLACE and therefore keeps the same inode (renames change the
// inode; cp does not). A PLAINTEXT SQLite file's first 16 bytes are the constant magic
// string, identical across all files — the header check is deliberately inert there and
// identity falls back to inode+birthtime (plaintext vaults are dev-only).
const SQLITE_MAGIC_HEX = Buffer.from('SQLite format 3\0').toString('hex');
function headerHex16(p) {
  try {
    const fd = openSync(p, 'r');
    try {
      const b = Buffer.alloc(16);
      const n = readSync(fd, b, 0, 16, 0);
      return n === 16 ? b.toString('hex') : null;
    } finally { closeSync(fd); }
  } catch { return null; }
}

/** The identity of a file generation: anything that survives writes but not replacement. */
function fileIdentity(p) {
  const st = statSync(p, { bigint: true });
  return {
    ino: String(st.ino),
    birthtimeMs: String(st.birthtimeMs),
    dev: String(st.dev),
    header: headerHex16(p),
  };
}

function bindingPath(dbPath) {
  return path.join(path.dirname(dbPath), BINDING_FILE);
}

function readBinding(dbPath) {
  try {
    const b = JSON.parse(readFileSync(bindingPath(dbPath), 'utf8'));
    return b && typeof b === 'object' && b.ino ? b : null;
  } catch { return null; }
}

/** Record the CURRENT db file as the rightful owner of any future -wal. Call after a
 *  successful open, and after any deliberate swap/restore (install tooling does). */
export function recordVaultBinding(dbPath) {
  // ATOMIC. This file is the single point of failure for the whole guard: a torn, empty or
  // `ino`-less binding SILENTLY DISARMS it — measured, 3/3 tamper shapes leaving the foreign
  // -wal in place to be replayed — and readBinding() returning null is indistinguishable
  // from "first run", which is the permissive branch.
  //
  // A bare writeFileSync TRUNCATES BEFORE IT FAILS, so an ENOSPC or EIO on any boot destroys
  // a previously-good binding. A full disk is precisely the state in which a stale foreign
  // WAL exists, so the failure mode is correlated with the thing being guarded against.
  // Every neighbouring artefact in this subsystem already publishes atomically for exactly
  // this reason — publishMeta (vault-lease.js), publishLock (init.js), the snapshot worker,
  // install-vault — and this one was the exception until the ownership work made it
  // load-bearing on every boot rather than only after a migration.
  const target = bindingPath(dbPath);
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, JSON.stringify({ ...fileIdentity(dbPath), at: new Date().toISOString() }));
    // Rename is atomic WITHIN a run: a reader sees the old file or the new one, never a
    // half-written one, which is the failure this fixes. It is NOT a durability claim —
    // there is no fsync of the file or the directory, so a power loss can still surface a
    // zero-length binding, i.e. readBinding()→null, the permissive branch. Stated because
    // this is the one file whose whole thesis is that a crash is when the binding matters.
    // (publishMeta and publishLock do not fsync either; matching them, not excusing it.)
    renameSync(tmp, target);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { /* */ }
    return false;              // an unwritable binding disarms the guard; a TORN one is worse
  }
}

/**
 * Guard the canonical vault against foreign-WAL replay. Call BEFORE the first open
 * (getDb / ensureVaultSchema / any keyed Database() on the canonical path).
 *
 * @param {string} dbPath canonical vault path
 * @param {{log?: (m:string)=>void, onEvent?: (e:object)=>void}} [opts]
 * @returns {{checked: boolean, quarantined: string[]}} what happened (for gates/telemetry)
 */
export function guardAgainstForeignWal(dbPath, { log, onEvent } = {}) {
  const out = { checked: false, quarantined: [] };
  try {
    if (!dbPath || !existsSync(dbPath)) return out;          // fresh vault — nothing to guard
    const wal = `${dbPath}-wal`;
    const hasWal = existsSync(wal) && (() => { try { return statSync(wal).size > 0; } catch { return true; } })();
    const binding = readBinding(dbPath);
    out.checked = true;

    if (!hasWal) {
      // No (or empty) WAL → nothing replayable. Refresh the binding to the current file
      // so a just-swapped-in vault becomes the recorded generation.
      recordVaultBinding(dbPath);
      return out;
    }
    if (!binding) {
      // A WAL exists but we have no recorded generation — first run under the guard.
      // We cannot prove the WAL foreign, so we must let it replay (it is almost always
      // the app's own crash WAL). Record the binding for every open after this one.
      recordVaultBinding(dbPath);
      return out;
    }

    const cur = fileIdentity(dbPath);
    // THE TRIGGER IS THE SALT, NOT THE INODE (independent review 2026-07-16, two
    // PoC-proven false quarantines in the inode-based draft):
    //  - An inode change alone is NOT proof of a foreign WAL: a legitimate whole-family
    //    restore (db + its OWN matching -wal moved back together — Time Machine, a new
    //    Mac, re-installing an archived .replaced-* triple) changes the inode while the
    //    WAL is same-generation committed data. Quarantining it silently drops commits.
    //  - The SQLCipher KDF salt (first 16 bytes) is the true generation mark: stable
    //    across every write to the same file, present in any byte-copy of it, and
    //    freshly random in every rebuilt / VACUUM INTO / restored-other-lineage file —
    //    which is precisely the production corruption mechanism (a rebuilt vault swapped
    //    beside a stale WAL). Both sides must be real ciphertext headers; a plaintext
    //    magic header or an unreadable side is NOT comparable and must never fire.
    // CONSEQUENCES, stated honestly: a PLAINTEXT vault (dev-only) is unguarded, and a
    // byte-copy of an OLDER state of the SAME lineage restored over the live file (same
    // salt) is invisible — install-vault.mjs is the mitigation for both. That trade is
    // deliberate: this guard must never destroy a legitimate WAL (§3 in the direction
    // that protects data), so it fires only on proof.
    const saltComparable = Boolean(cur.header && binding.header
      && cur.header !== SQLITE_MAGIC_HEX && binding.header !== SQLITE_MAGIC_HEX);
    const saltChanged = saltComparable && cur.header !== binding.header;
    if (!saltChanged) {
      // Same generation (or no proof). If the file MOVED (inode changed) refresh the
      // binding so the new location/identity is the recorded owner going forward.
      if (cur.ino !== binding.ino || cur.dev !== binding.dev) recordVaultBinding(dbPath);
      return out;
    }

    // PROVEN mismatch: the vault content was replaced (new cipher salt) while a
    // non-empty -wal from the previous generation remained. Replaying it would splice
    // old pages into the new file — the exact corruption this vault suffered five times.
    // Quarantine, never delete. A rename that fails because the file is ALREADY GONE
    // (ENOENT — the sibling process raced us to the same quarantine) counts as done;
    // any OTHER failure (EPERM after a sudo'd repair, a read-only volume) means the bomb
    // is still armed → FAIL CLOSED: refuse the open rather than replay it (§3, §10).
    // Deliberately do NOT rebind on failure — the next boot must re-detect, not trust.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const sfx of ['-wal', '-shm']) {
      const f = `${dbPath}${sfx}`;
      if (!existsSync(f)) continue;
      const q = `${f}.foreign-${stamp}`;
      try {
        renameSync(f, q);
        out.quarantined.push(path.basename(q));
      } catch (e) {
        if (e?.code === 'ENOENT') continue;                   // a racing family member quarantined it
        try { onEvent?.({ kind: 'foreign-wal-quarantine-failed', at: new Date().toISOString(), sfx, code: String(e?.code || 'error') }); } catch { /* */ }
        throw new Error(
          `[wal-guard] a FOREIGN -wal from a previous vault generation is present and could not be `
          + `quarantined (${e?.code || 'error'} on ${path.basename(f)}). Opening now would replay old pages `
          + `into the current vault (the proven corruption mechanism). Refusing to open. Move `
          + `${path.basename(f)} aside manually, then relaunch.`,
        );
      }
    }
    const msg = `[wal-guard] QUARANTINED foreign WAL sidecar(s) [${out.quarantined.join(', ')}] — the vault content `
      + `was replaced (cipher salt changed) while a stale -wal remained. Replaying it would have spliced `
      + `previous-generation pages into this file (the proven corruption mechanism). The swapped-in vault `
      + `opens exactly as validated.`;
    (log || ((m) => process.stderr.write(`${m}\n`)))(msg);
    try { onEvent?.({ kind: 'foreign-wal-quarantined', at: new Date().toISOString(), quarantined: out.quarantined, prevIno: binding.ino, curIno: cur.ino }); } catch { /* telemetry is best-effort */ }
    recordVaultBinding(dbPath);
    return out;
  } catch (e) {
    // Fail-closed ONLY for the armed-bomb case above; every other internal error must
    // never block a boot — the guard exists to prevent damage, not cause outage.
    if (/could not be quarantined/.test(String(e?.message))) throw e;
    return out;
  }
}

export default guardAgainstForeignWal;
