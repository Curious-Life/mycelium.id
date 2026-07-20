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
  readdirSync, statSync, lstatSync,
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

// Per-ENTRY uncompressed-size cap for extraction (decompression-bomb guard). A
// single archive member declaring more than this is skipped+warned rather than
// inflated into memory. Generous so legitimate blobs/samples pass untouched.
export const MAX_ENTRY_BYTES = 500 * 1024 * 1024;

// Dedicated cap for the MANDATORY member `mycelium.db`, which is the WHOLE vault and
// so legitimately dwarfs any single upload blob — it gets far more headroom than
// MAX_ENTRY_BYTES. Still a hard bound so a DEFLATE-bombed db can't inflate unbounded
// into memory: every member is inflated through readEntryCapped, whose streaming
// ceiling aborts at the cap. 3 GiB is ~3x the whole-backup soft limit
// (BACKUP_SOFT_LIMIT_BYTES) and sits below the zip u32 size-field ceiling, so the
// declared-size fast-reject also engages. kcv.json (a tiny JSON verifier) is held to
// MAX_ENTRY_BYTES, which is already absurdly generous for it.
export const MAX_DB_BYTES = 3 * 1024 * 1024 * 1024;

// On-disk format magics (must match the live writers):
//   mind files  → 'MIND' (src/mindfiles/mind-files.js:41)
//   voice .mvs  → 'MVS1' (src/tts/voice-sample-store.js:35)
// The whole `.myvault` is itself UNENCRYPTED (a STORE zip); its safety rests on
// every member being individually ciphertext. So we refuse to SHIP any mind/voice
// file lacking its magic — a stray legacy plaintext file would otherwise leak in
// the clear inside the backup.
const MIND_MAGIC = Buffer.from('MIND', 'latin1');
const VOICE_MAGIC = Buffer.from('MVS1', 'latin1');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Decompression-bomb guard primitive: true iff an archive member DECLARES an
 * uncompressed size over `cap`, checked from `_data.uncompressedSize` WITHOUT
 * inflating. JSZip reads the zip's 32-bit size field as a SIGNED int, so a declared
 * size in the 2–4 GiB range arrives negative — recover the unsigned value before
 * comparing, or a >2 GiB bomb would read negative and slip past the cap. A member
 * that declares no numeric size (older/foreign tooling) is NOT rejected here
 * (fail-open on the advisory field is acceptable; it only widens who reaches the
 * inflate, and the whole upload is already bounded by the 5 GB multipart limit).
 * Exported for the verify gate.
 * @param {{ _data?: { uncompressedSize?: number } }} entry
 * @param {number} cap
 */
export function entryExceedsCap(entry, cap) {
  let declared = entry?._data?.uncompressedSize;
  if (typeof declared !== 'number' || !Number.isFinite(declared)) return false;
  if (declared < 0) declared >>>= 0;   // JSZip reads the u32 size field signed — recover unsigned
  return declared > cap;
}

/**
 * Inflate ONE archive member to a Buffer under a HARD byte ceiling. Two independent
 * layers, mirroring src/ingest/import-parsers.js readTextEntry — because the DECLARED
 * size alone is not a real bomb guard: it is attacker-controlled, and a crafted
 * decompression bomb declares a SMALL size but its DEFLATE stream inflates huge.
 * JSZip's `.async()` inflates the WHOLE stream into memory before its own
 * size-mismatch check fires, so a declared-size-only guard is bypassed by exactly the
 * shape it is meant to stop.
 *   1) fast reject on the declared size (entryExceedsCap) — kills honest bombs ~free;
 *   2) a STREAMING byte counter (`entry.nodeStream`) that destroys the inflate the
 *      instant output passes `cap` — bounds real memory even when the header lies low
 *      (or a future jszip drops the internal size field, making layer 1 a no-op).
 * Throws an Error with code 'invalid_archive' on over-cap, a missing entry, or a
 * stream error (fail-closed). `label` names the member in the user-facing message —
 * NAME/label only, never member bytes. Exported for the verify gate.
 * @returns {Promise<Buffer>}
 */
export async function readEntryCapped(entry, cap, label) {
  const bomb = () => {
    const e = new Error(`this backup's ${label} exceeds the safe size cap — refusing to inflate (possible decompression bomb).`);
    e.code = 'invalid_archive';
    return e;
  };
  if (!entry) { const e = new Error(`this backup is missing its ${label}.`); e.code = 'invalid_archive'; throw e; }
  if (entryExceedsCap(entry, cap)) throw bomb();          // layer 1
  return new Promise((resolve, reject) => {                // layer 2
    let total = 0; const chunks = []; let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    let stream;
    try { stream = entry.nodeStream('nodebuffer'); }
    catch { const e = new Error(`this backup's ${label} could not be read.`); e.code = 'invalid_archive'; return done(reject, e); }
    stream.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > cap) { try { stream.destroy(); } catch { /* */ } return done(reject, bomb()); }
      chunks.push(chunk);
    });
    stream.on('end', () => done(resolve, Buffer.concat(chunks)));
    const corrupt = () => { const e = new Error(`this backup's ${label} is corrupt or truncated.`); e.code = 'invalid_archive'; done(reject, e); };
    stream.on('error', corrupt);
    // Fail-closed backstop (mirrors import-parsers.js readTextEntry): a stream that
    // 'close's without ever firing 'end'/'error' (aborted/truncated) must still
    // settle the promise — else restore would hang forever. No-op after any prior
    // settle (success 'end', the cap abort, or 'error'), thanks to the `settled` latch.
    stream.on('close', corrupt);
  });
}

/** First-N-bytes magic check on a file (fail-closed: unreadable/short → false). */
function hasMagic(abs, magic) {
  try {
    const head = readFileSync(abs).subarray(0, magic.length);
    return head.length === magic.length && head.equals(magic);
  } catch { return false; }
}

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
 * Like walk(), but for the agent's interior (mind/ + voice-samples/): uses
 * lstatSync so SYMLINKS are never followed (a planted symlink must not slurp a
 * target outside the root into the archive — a data-exfil / dangling-link hazard),
 * and skips in-flight `*.tmp` files (mind writes are temp+rename; a half-written
 * `.tmp` snapshot must not land in the backup). Only REAL regular files are added.
 */
function walkNoSymlink(root, base = root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const abs = path.join(root, name);
    let st;
    try { st = lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink()) continue;          // never follow — skip the link itself
    if (st.isDirectory()) out.push(...walkNoSymlink(abs, base));
    else if (st.isFile()) {
      if (name.endsWith('.tmp')) continue;       // in-flight write — skip
      out.push({ abs, rel: path.relative(base, abs).split(path.sep).join('/') });
    }
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
 * @param {string} [p.mindRoot]  the agent's mind dir (<agentRoot>/mind; optional).
 *   Walked byte-verbatim into `mind/<rel>` — these are already-encrypted MIND-magic
 *   files, so this is a RAW COPY (no re-encrypt, no decrypt); a same-key restore
 *   round-trips them exactly.
 * @param {string} [p.voiceSamplesRoot]  frozen voice-sample dir (optional). Walked
 *   byte-verbatim into `voice-samples/<rel>` — encrypted `.mvs` files, raw copy.
 * @param {string} [p.app]     app version string for the manifest
 * @returns {Promise<{ buffer: Buffer, manifest: object }>}
 */
export async function buildVaultArchive({ dbPath, kcvPath, uploadsRoot, remoteConfigPath, mindRoot, voiceSamplesRoot, app = 'mycelium-v1' }) {
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

    // The agent's on-disk interior. BYTE-VERBATIM: these are self-contained,
    // already-encrypted files (MIND-magic mind files, MVS1-magic `.mvs` voice
    // samples). We do NOT decrypt or re-encrypt — a same-key restore reproduces
    // them exactly. Symlinks are skipped (never followed) and `*.tmp` in-flight
    // files are excluded (see walkNoSymlink). Every shipped file is magic-checked:
    // a file lacking its format magic is NOT ciphertext of the expected shape and
    // is skipped+warned rather than leaked in the clear inside the unencrypted zip.
    const mindWalked = (mindRoot && existsSync(mindRoot)) ? walkNoSymlink(mindRoot) : [];
    const mind = mindWalked.filter((f) => hasMagic(f.abs, MIND_MAGIC));
    for (const f of mindWalked) {
      if (!mind.includes(f)) { console.warn(`[backup] skipping non-MIND-magic file in mind/: ${f.rel}`); continue; }
      zip.file(`mind/${f.rel}`, readFileSync(f.abs));
    }
    const voiceWalked = (voiceSamplesRoot && existsSync(voiceSamplesRoot)) ? walkNoSymlink(voiceSamplesRoot) : [];
    const voice = voiceWalked.filter((f) => hasMagic(f.abs, VOICE_MAGIC));
    for (const f of voiceWalked) {
      if (!voice.includes(f)) { console.warn(`[backup] skipping non-MVS1-magic file in voice-samples/: ${f.rel}`); continue; }
      zip.file(`voice-samples/${f.rel}`, readFileSync(f.abs));
    }
    // Continuity tripwire: a wired-but-empty interior usually means the resolver
    // pointed at the wrong dir (the cwd-divergence footgun) — a SILENT empty
    // backup of the agent's self. Warn so it's caught, not shipped unnoticed.
    if (mindRoot && mind.length === 0) {
      console.warn('[backup] agent mind interior appears EMPTY — the backup carries no mind files (wrong agentRoot? not yet initialised?).');
    }

    const manifest = {
      v: ARCHIVE_VERSION,
      createdAt: new Date().toISOString(),
      app,
      dbBytes: dbBuf.length,
      kcvSha256: sha256(kcvBuf),
      uploadCount: uploads.length,
      // Advisory only — restore NEVER requires these (additive; old archives lack
      // them, new apps tolerate their absence). Not a security boundary.
      mindCount: mind.length,
      voiceCount: voice.length,
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
  // Decompression-bomb guard for the MANDATORY members — read directly here and in
  // restore (unlike the optional families, which go through writeEntrySafe). The db
  // is not inflated here (restore streams it under a hard cap BEFORE any disk move),
  // so a cheap declared-size fast-reject catches an honestly-oversized db early with
  // a clear message. The manifest + kcv ARE inflated here (JSON.parse / sha check),
  // so they go through readEntryCapped's streaming ceiling — bounding memory even
  // against a header that lies low. db → roomier MAX_DB_BYTES; JSON → MAX_ENTRY_BYTES.
  if (entryExceedsCap(dbFile, MAX_DB_BYTES)) {
    return { ok: false, error: 'this backup is implausibly large (its database exceeds the safe size cap) — refusing to restore (possible decompression bomb).' };
  }
  let manifest, kcvBuf;
  try {
    manifest = JSON.parse((await readEntryCapped(manFile, MAX_ENTRY_BYTES, 'manifest')).toString('utf8'));
  } catch (e) {
    if (e?.code === 'invalid_archive') return { ok: false, error: e.message };
    return { ok: false, error: 'this backup has a corrupt manifest.' };
  }
  if (manifest.v !== ARCHIVE_VERSION) {
    return { ok: false, error: `unsupported backup version (${manifest.v}); this app reads v${ARCHIVE_VERSION}.` };
  }
  // Confirm the kcv in the archive is the one the manifest was sealed with — guards
  // against a tampered/mismatched key-check file that could mislead the key paste.
  try { kcvBuf = await readEntryCapped(kcvFile, MAX_ENTRY_BYTES, 'key-check file'); }
  catch (e) { return { ok: false, error: e?.code === 'invalid_archive' ? e.message : 'this backup has an unreadable key-check file.' }; }
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
  // Reject dest === root too: an entry like `<prefix>/.` resolves to the root dir
  // itself, and writeFileSync(root) then throws EISDIR (poison-entry guard).
  if (dest === root || !dest.startsWith(root + path.sep)) return null;
  return dest;
}

/**
 * Resolve a `mind/<rel>` archive entry to its on-disk destination IFF it stays
 * contained under mindRoot; otherwise null (skip). Same zip-slip containment as
 * safeUploadDest (path.resolve, not a substring '..' check). Exported for the gate.
 * @param {string} mindRoot   the agent's mind dir (<agentRoot>/mind)
 * @param {string} entryName  the archive entry name ('mind/<rel>')
 * @returns {string|null}     absolute dest path, or null if it escapes
 */
export function safeMindDest(mindRoot, entryName) {
  const root = path.resolve(mindRoot);
  const rel = String(entryName || '').slice('mind/'.length);
  if (!rel) return null;
  const dest = path.resolve(root, rel);
  // Reject dest === root too: an entry like `<prefix>/.` resolves to the root dir
  // itself, and writeFileSync(root) then throws EISDIR (poison-entry guard).
  if (dest === root || !dest.startsWith(root + path.sep)) return null;
  return dest;
}

/**
 * Resolve a `voice-samples/<rel>` archive entry to its on-disk destination IFF it
 * stays contained under voiceRoot; otherwise null (skip). Mirrors safeUploadDest.
 * @param {string} voiceRoot  the voice-samples dir
 * @param {string} entryName  the archive entry name ('voice-samples/<rel>')
 * @returns {string|null}     absolute dest path, or null if it escapes
 */
export function safeVoiceDest(voiceRoot, entryName) {
  const root = path.resolve(voiceRoot);
  const rel = String(entryName || '').slice('voice-samples/'.length);
  if (!rel) return null;
  const dest = path.resolve(root, rel);
  // Reject dest === root too: an entry like `<prefix>/.` resolves to the root dir
  // itself, and writeFileSync(root) then throws EISDIR (poison-entry guard).
  if (dest === root || !dest.startsWith(root + path.sep)) return null;
  return dest;
}

/**
 * Extract ONE archive entry to `dest`, defensively. Never throws — a poison entry
 * (NUL in name, file-then-dir ordering collision, EISDIR, oversized/bomb) is warned
 * (NAME ONLY, never bytes) and skipped so the restore loop always completes and
 * the caller still returns its movedAside receipt. Inflates through readEntryCapped,
 * so a bomb entry (even one lying about its declared size) is aborted mid-inflate and
 * skipped rather than OOMing.
 * @returns {Promise<boolean>} true iff written.
 */
async function writeEntrySafe(entry, dest, { mode } = {}) {
  try {
    const bytes = await readEntryCapped(entry, MAX_ENTRY_BYTES, entry?.name || 'entry');
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, bytes, mode ? { mode } : undefined);
    return true;
  } catch (err) {
    // NAME ONLY — a restore must never echo file bytes into a log.
    console.warn(`[restore] skipping unwritable archive entry: ${entry?.name} (${err?.code || 'error'})`);
    return false;
  }
}

export async function restoreVaultArchive({ buffer, dbPath, kcvPath, uploadsRoot, mindRoot, voiceSamplesRoot, overwrite = false }) {
  const v = await validateArchive(buffer);
  if (!v.ok) { const e = new Error(v.error); e.code = 'invalid_archive'; throw e; }
  const { zip, manifest } = v;

  if (existsSync(kcvPath) && !overwrite) {
    const e = new Error('a vault already exists here — pass overwrite to replace it.');
    e.code = 'vault_exists';
    throw e;
  }

  // Materialize + bomb-cap the MANDATORY members BEFORE any destructive move, so a
  // bomb (including one that LIES about its declared size — readEntryCapped streams
  // with a hard byte ceiling, not just a declared-size check) aborts with ZERO disk
  // mutation: nothing is moved aside, the prior vault is untouched, and the caller
  // sees a clean invalid_archive. remote.json is optional but read the same way — it
  // was the one uncapped raw `.async()` left (and it landed AFTER the db/kcv were
  // already committed, so an oversize there used to crash mid-restore).
  const dbBuf = await readEntryCapped(zip.file('mycelium.db'), MAX_DB_BYTES, 'database');
  const kcvBuf = await readEntryCapped(zip.file('kcv.json'), MAX_ENTRY_BYTES, 'key-check file');
  const remoteEntry = zip.file('remote.json');
  const remoteBuf = remoteEntry ? await readEntryCapped(remoteEntry, MAX_ENTRY_BYTES, 'remote config') : null;

  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
  const movedAside = [];
  // Move the current vault aside first (recoverable), so a restore is reversible.
  // mindRoot/voiceSamplesRoot are moved aside too so the agent's prior interior is
  // never destroyed on an overwrite — only relocated (recoverable).
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, kcvPath, uploadsRoot, mindRoot, voiceSamplesRoot]) {
    if (!p) continue;
    const moved = moveAside(p, ts);
    if (moved) movedAside.push(moved);
  }

  // Write the db via temp+rename (atomic on the same filesystem).
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const dbTmp = `${dbPath}.restore.tmp`;
  writeFileSync(dbTmp, dbBuf);
  renameSync(dbTmp, dbPath);

  mkdirSync(path.dirname(kcvPath), { recursive: true });
  writeFileSync(kcvPath, kcvBuf);

  // remote.json is optional and non-secret; restore it next to the kcv if present.
  if (remoteBuf) {
    const remotePath = path.join(path.dirname(kcvPath), 'remote.json');
    writeFileSync(remotePath, remoteBuf);
  }

  // uploads/<...> → uploadsRoot/<...>
  if (uploadsRoot) {
    const entries = Object.values(zip.files).filter((f) => !f.dir && f.name.startsWith('uploads/'));
    for (const entry of entries) {
      const dest = safeUploadDest(uploadsRoot, entry.name); // null → escapes uploadsRoot
      if (!dest) continue;
      await writeEntrySafe(entry, dest);
    }
  }

  // mind/<...> → mindRoot/<...>  and  voice-samples/<...> → voiceSamplesRoot/<...>.
  // BYTE-VERBATIM (already-encrypted files; no re-encrypt/decrypt). Extracted
  // through the zip-slip guards (safeMindDest/safeVoiceDest → null skips an entry
  // that escapes its root). FAIL-LOUD: if the archive carries such entries but the
  // destination root wasn't wired, warn + skip that family — never silent, never
  // throw (a same-key restore of db+kcv still succeeds).
  const mindEntries = Object.values(zip.files).filter((f) => !f.dir && f.name.startsWith('mind/'));
  if (mindEntries.length) {
    if (!mindRoot) {
      console.warn(`[restore] archive carries ${mindEntries.length} mind/ file(s) but no mindRoot was wired — skipping the agent interior (continuity gap).`);
    } else {
      for (const entry of mindEntries) {
        const dest = safeMindDest(mindRoot, entry.name); // null → escapes mindRoot
        if (!dest) continue;
        await writeEntrySafe(entry, dest, { mode: 0o600 });
      }
    }
  }

  const voiceEntries = Object.values(zip.files).filter((f) => !f.dir && f.name.startsWith('voice-samples/'));
  if (voiceEntries.length) {
    if (!voiceSamplesRoot) {
      console.warn(`[restore] archive carries ${voiceEntries.length} voice-samples/ file(s) but no voiceSamplesRoot was wired — skipping the voice identity (continuity gap).`);
    } else {
      for (const entry of voiceEntries) {
        const dest = safeVoiceDest(voiceSamplesRoot, entry.name); // null → escapes voiceSamplesRoot
        if (!dest) continue;
        await writeEntrySafe(entry, dest, { mode: 0o600 });
      }
    }
  }

  return { ok: true, manifest, movedAside };
}
