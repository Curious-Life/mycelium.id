// src/account/backup.js — produce and restore a ZERO-KNOWLEDGE snapshot of the
// vault, so device loss is recoverable: "back up your vault" → a single
// `.myvault` file the user keeps in their own storage, and "restore from backup"
// → drop that file back + paste the recovery key (the existing /account/restore
// path then verifies the key against the restored kcv.json and opens the REAL
// data — see docs/VAULT-BACKUP-AND-REMOTE-ACCESS-DESIGN-2026-06-08.md).
//
// WHY THIS IS SAFE TO PRODUCE WITHOUT A KEY: encryption is column-level — every
// sensitive cell in mycelium.db is an AES-256-GCM wrapped-DEK envelope
// (src/crypto/crypto-local.js). The SQLite *file* is therefore ciphertext at the
// page level; copying it leaks nothing without the recovery key. The snapshot is
// taken with better-sqlite3's online-backup API from a FRESH connection (the live
// raw handle is not exposed through boot()), which yields ONE consistent file with
// the WAL folded in — no torn -wal/-shm copy.
//
// WHAT'S IN / OUT (design §1): IN = mycelium.db (snapshot) + kcv.json (non-secret
// verifier, REQUIRED so restore is not the silent-empty-vault footgun) + uploads/
// (encrypted blobs) + remote.json (non-secret config, if present). OUT = auth.db
// (holds the operator password hash + OAuth signing secret — never shipped
// off-device; regenerable) and vault-lock.json (a recovery-key restore turns the
// passphrase lock off anyway).
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import crypto from 'node:crypto';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, chmodSync,
  readdirSync, statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertEntryCount } from '../ingest/import-parsers.js';
import { resolveDbKeyHex } from '../db/open.js';

export const ARCHIVE_VERSION = 1;
export const ARCHIVE_EXT = '.myvault';
// Soft guidance only — we log above this, we do NOT refuse (a backup must work for
// large vaults). Streaming (node-tar) is the named fast-follow if GB vaults appear.
export const BACKUP_SOFT_LIMIT_BYTES = 1_000_000_000;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Consistent snapshot of the SQLite vault into destPath, using a fresh connection
 * (decoupled from boot).
 *
 * - PLAINTEXT vault (no dbKeyHex): the online-backup API (consistent single file,
 *   WAL folded in). Unchanged.
 * - ENCRYPTED vault (at-rest A′, dbKeyHex supplied): the online-backup API can't
 *   span a keyed source and a plaintext target ("incompatible source and target"),
 *   so snapshot via `VACUUM INTO` from the KEYED connection. Verified: that writes
 *   a CONSISTENT, still-ENCRYPTED single-file snapshot (cipher dest, readable only
 *   with the key) — so the `.myvault` stays ciphertext at rest. VACUUM INTO uses a
 *   read transaction, so it's safe under concurrent writes.
 *
 * @param {string} srcDbPath
 * @param {string} destPath
 * @param {{ dbKeyHex?: string|null }} [opts]
 */
export async function snapshotDb(srcDbPath, destPath, { dbKeyHex = null } = {}) {
  if (!existsSync(srcDbPath)) throw new Error(`no vault db at ${srcDbPath}`);
  if (dbKeyHex) {
    if (!/^[0-9a-f]{64}$/i.test(dbKeyHex)) throw new Error('snapshotDb: dbKeyHex must be 64-char hex');
    // VACUUM INTO requires the target to not exist.
    for (const sfx of ['', '-wal', '-shm']) { try { rmSync(destPath + sfx); } catch { /* */ } }
    const db = new Database(srcDbPath, { fileMustExist: true });
    try {
      db.pragma(`cipher='sqlcipher'`);
      db.pragma(`key="x'${dbKeyHex}'"`);
      db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
    } finally {
      try { db.close(); } catch { /* */ }
    }
    restrictTempPerms(destPath);
    return;
  }
  const src = new Database(srcDbPath, { fileMustExist: true });
  try {
    await src.backup(destPath);   // online backup: consistent single file, WAL folded in
  } finally {
    try { src.close(); } catch { /* */ }
  }
  // The plaintext-branch snapshot lands in os.tmpdir() with the default umask;
  // restrict it to owner-only so a transient vault copy (even field-encrypted) is
  // never group/world-readable on a shared temp dir. Best-effort (never fail a
  // backup on chmod). Ciphertext (VACUUM INTO) branch gets the same hygiene above.
  restrictTempPerms(destPath);
}

/** Owner-only (0600) perms on a transient snapshot file. Best-effort. */
function restrictTempPerms(p) {
  try { chmodSync(p, 0o600); } catch { /* best-effort: chmod must never fail a backup */ }
}

/** Recursively list files under root as { abs, rel } (rel uses forward slashes). */
function walk(root, base = root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const abs = path.join(root, name);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walk(abs, base));
    else if (st.isFile()) out.push({ abs, rel: path.relative(base, abs).split(path.sep).join('/') });
  }
  return out;
}

/**
 * Build the `.myvault` archive (a STORE-compressed zip; ciphertext is
 * incompressible) as a Buffer. Sources are explicit paths so per-item env
 * overrides (MYCELIUM_DB, MYCELIUM_KCV, MYCELIUM_UPLOADS_ROOT…) are honoured.
 *
 * @param {object} p
 * @param {string} p.dbPath    source mycelium.db
 * @param {string} p.kcvPath   source kcv.json (must exist — it's the restore verifier)
 * @param {string} [p.uploadsRoot]  uploads dir (optional; absent → no blobs)
 * @param {string} [p.remoteConfigPath]  remote.json (optional, non-secret)
 * @param {string} [p.app]     app version string for the manifest
 * @returns {Promise<{ buffer: Buffer, manifest: object }>}
 */
export async function buildVaultArchive({ dbPath, kcvPath, uploadsRoot, remoteConfigPath, app = 'mycelium-v1' }) {
  if (!existsSync(kcvPath)) throw new Error('refusing to back up: no kcv.json (vault not initialised)');

  // At-rest A′: when the vault is whole-file encrypted, the snapshot must open
  // keyed (else the backup fails / can't read). resolveDbKeyHex returns null when
  // at-rest is off (MYCELIUM_AT_REST unset) → the plaintext online-backup path,
  // unchanged. The DB key derives from USER_MASTER, which boot pins to env.
  const dbKeyHex = resolveDbKeyHex(process.env.ENCRYPTION_MASTER_KEY || '', dbPath);

  const tmpSnap = path.join(os.tmpdir(), `myvault-snap-${process.pid}-${sha256(Buffer.from(dbPath + Date.now())).slice(0, 12)}.db`);
  try {
    await snapshotDb(dbPath, tmpSnap, { dbKeyHex });
    const dbBuf = readFileSync(tmpSnap);
    const kcvBuf = readFileSync(kcvPath);

    const zip = new JSZip();
    zip.file('mycelium.db', dbBuf);
    zip.file('kcv.json', kcvBuf);
    if (remoteConfigPath && existsSync(remoteConfigPath)) zip.file('remote.json', readFileSync(remoteConfigPath));

    const uploads = uploadsRoot ? walk(uploadsRoot) : [];
    for (const f of uploads) zip.file(`uploads/${f.rel}`, readFileSync(f.abs));

    const manifest = {
      v: ARCHIVE_VERSION,
      createdAt: new Date().toISOString(),
      app,
      dbBytes: dbBuf.length,
      kcvSha256: sha256(kcvBuf),
      uploadCount: uploads.length,
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    return { buffer, manifest };
  } finally {
    try { if (existsSync(tmpSnap)) rmSync(tmpSnap); } catch { /* */ }
  }
}

/**
 * Validate an uploaded archive WITHOUT touching the live data dir. Fail-closed:
 * any structural problem returns { error }. On success returns the parsed zip +
 * manifest so the caller can extract.
 * @returns {Promise<{ ok:true, zip, manifest } | { ok:false, error:string }>}
 */
export async function validateArchive(buffer) {
  let zip;
  try { zip = await JSZip.loadAsync(buffer); assertEntryCount(zip); }
  catch (e) {
    if (e?.code === 'TOO_MANY_ENTRIES') return { ok: false, error: 'this backup has too many entries — refusing to restore (possible archive bomb).' };
    return { ok: false, error: 'unrecognized file — that is not a Mycelium backup (.myvault).' };
  }

  const manFile = zip.file('manifest.json');
  const dbFile = zip.file('mycelium.db');
  const kcvFile = zip.file('kcv.json');
  if (!manFile || !dbFile || !kcvFile) {
    return { ok: false, error: 'this backup is incomplete (missing manifest, database, or key-check file).' };
  }
  let manifest;
  try { manifest = JSON.parse(await manFile.async('string')); }
  catch { return { ok: false, error: 'this backup has a corrupt manifest.' }; }
  if (manifest.v !== ARCHIVE_VERSION) {
    return { ok: false, error: `unsupported backup version (${manifest.v}); this app reads v${ARCHIVE_VERSION}.` };
  }
  // Confirm the kcv in the archive is the one the manifest was sealed with — guards
  // against a tampered/mismatched key-check file that could mislead the key paste.
  const kcvBuf = Buffer.from(await kcvFile.async('uint8array'));
  if (manifest.kcvSha256 && sha256(kcvBuf) !== manifest.kcvSha256) {
    return { ok: false, error: 'this backup is inconsistent (key-check file does not match its manifest).' };
  }
  return { ok: true, zip, manifest };
}

/** Move an existing path aside to `<path>.pre-restore.<ts>` (returns new path or null). */
function moveAside(p, ts) {
  if (!existsSync(p)) return null;
  const dest = `${p}.pre-restore.${ts}`;
  renameSync(p, dest);
  return dest;
}

/**
 * Restore an archive onto disk. Validates first; refuses to clobber an existing
 * vault unless { overwrite:true }, in which case the prior db/kcv/uploads are
 * moved aside (never destroyed) before the restored files land. Writes the db via
 * a temp+rename so a failure can't leave a half-written vault.
 *
 * Does NOT open the vault — that's the existing /account/restore key paste, which
 * verifies the recovery key against the restored kcv.json.
 *
 * @returns {Promise<{ ok:true, manifest, movedAside:string[] } >}
 */
/**
 * Resolve a `uploads/<rel>` archive entry to its on-disk destination IFF it stays
 * contained under uploadsRoot; otherwise null (skip). A substring '..' check is
 * fragile (backslashes, absolute paths, normalization); path.resolve containment
 * is the correct test. Exported for the verify gate.
 * @param {string} uploadsRoot  the uploads dir
 * @param {string} entryName    the archive entry name ('uploads/<rel>')
 * @returns {string|null}        absolute dest path, or null if it escapes
 */
export function safeUploadDest(uploadsRoot, entryName) {
  const root = path.resolve(uploadsRoot);
  const rel = String(entryName || '').slice('uploads/'.length);
  if (!rel) return null;
  const dest = path.resolve(root, rel);
  if (dest !== root && !dest.startsWith(root + path.sep)) return null;
  return dest;
}

export async function restoreVaultArchive({ buffer, dbPath, kcvPath, uploadsRoot, overwrite = false }) {
  const v = await validateArchive(buffer);
  if (!v.ok) { const e = new Error(v.error); e.code = 'invalid_archive'; throw e; }
  const { zip, manifest } = v;

  if (existsSync(kcvPath) && !overwrite) {
    const e = new Error('a vault already exists here — pass overwrite to replace it.');
    e.code = 'vault_exists';
    throw e;
  }

  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
  const movedAside = [];
  // Move the current vault aside first (recoverable), so a restore is reversible.
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, kcvPath, uploadsRoot]) {
    const moved = moveAside(p, ts);
    if (moved) movedAside.push(moved);
  }

  // Write the db via temp+rename (atomic on the same filesystem).
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const dbBuf = Buffer.from(await zip.file('mycelium.db').async('uint8array'));
  const dbTmp = `${dbPath}.restore.tmp`;
  writeFileSync(dbTmp, dbBuf);
  renameSync(dbTmp, dbPath);

  mkdirSync(path.dirname(kcvPath), { recursive: true });
  writeFileSync(kcvPath, Buffer.from(await zip.file('kcv.json').async('uint8array')));

  // remote.json is optional and non-secret; restore it next to the kcv if present.
  const remoteEntry = zip.file('remote.json');
  if (remoteEntry) {
    const remotePath = path.join(path.dirname(kcvPath), 'remote.json');
    writeFileSync(remotePath, Buffer.from(await remoteEntry.async('uint8array')));
  }

  // uploads/<...> → uploadsRoot/<...>
  if (uploadsRoot) {
    const entries = Object.values(zip.files).filter((f) => !f.dir && f.name.startsWith('uploads/'));
    for (const entry of entries) {
      const dest = safeUploadDest(uploadsRoot, entry.name); // null → escapes uploadsRoot
      if (!dest) continue;
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, Buffer.from(await entry.async('uint8array')));
    }
  }

  return { ok: true, manifest, movedAside };
}
