// Local encrypted blob store for uploaded file bytes.
//
// File bytes are NOT a db column (only attachment metadata is). So uploaded
// bytes are encrypted-at-rest on local disk using the SAME AES-256-GCM envelope
// as the vault — modeled directly on src/mindfiles/mind-files.js (magic prefix
// + atomic tmp+sync+rename). crypto-local.encrypt() takes a string, so binary
// bytes are base64-encoded before encryption (same trick as the embedding_768
// vector envelope).
//
// On-disk format:  bytes 0..3 magic "MYCB" (Mycelium Blob v1) | 4..n base64 envelope
// Path:            <root>/<userId>/<uuid><ext>.enc   (root defaults to uploadsRoot())
//
// Fail-closed: encrypt() throws if the master key is absent ⇒ no plaintext blob
// is ever written. getMasterKey() resolves USER_MASTER from the same
// ENCRYPTION_MASTER_KEY bridge boot() pins (see src/index.js).
import { mkdir, open, rename, readFile, unlink } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import crypto from 'node:crypto';
import { encrypt, decrypt, getMasterKey } from '../crypto/crypto-local.js';
import { uploadsRoot, isUserNamespacedBlobPath, assertUserNamespacedBlobPath } from '../paths.js';

// The `<userId>/…` namespacing guards live in paths.js (leaf util, so the db
// layer can import them without depending on ingest). Re-exported here because
// putBlob defines the convention they enforce and importers reach for them
// alongside putBlob.
export { isUserNamespacedBlobPath, assertUserNamespacedBlobPath };

const MAGIC = Buffer.from('MYCB', 'latin1'); // 4 bytes, blob format v1
const SCOPE = 'personal';
const FILE_MODE = 0o600;

function safeExt(ext) {
  // keep a short, dotted, alphanumeric extension; drop anything weird.
  if (typeof ext !== 'string') return '';
  const m = ext.match(/^\.?([A-Za-z0-9]{1,12})$/);
  return m ? `.${m[1].toLowerCase()}` : '';
}

/**
 * Encrypt `buffer` and write it to disk. Returns { path, size } where `path` is
 * RELATIVE to `root` (the storage key persisted to attachments.local_path).
 */
export async function putBlob(buffer, { userId, ext = '', root = uploadsRoot() } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('putBlob: buffer (Buffer) required');
  if (typeof userId !== 'string' || !userId) throw new Error('putBlob: userId required');

  const masterKey = await getMasterKey();
  if (!masterKey) throw new Error('putBlob: master key unavailable — refusing to write blob (fail-closed)');

  const rel = join(userId, `${crypto.randomUUID()}${safeExt(ext)}.enc`);
  const finalPath = join(root, rel);
  await mkdir(dirname(finalPath), { recursive: true });

  // bytes → base64 string → envelope → magic-prefixed payload
  const envelope = await encrypt(buffer.toString('base64'), SCOPE, masterKey);
  const payload = Buffer.concat([MAGIC, Buffer.from(envelope, 'utf8')]);

  const tmp = `${finalPath}.tmp`;
  let fh;
  try {
    fh = await open(tmp, 'w', FILE_MODE);
    await fh.writeFile(payload);
    await fh.sync();
  } finally {
    if (fh) await fh.close();
  }
  await rename(tmp, finalPath);
  return { path: rel, size: buffer.length };
}

/** Read + decrypt a blob by its relative storage key. Returns the original Buffer. */
export async function getBlob(rel, { root = uploadsRoot() } = {}) {
  // Type guard: `rel` is a stored storage key (attachments.local_path). Reject a
  // non-string (e.g. an array reaching the lookup from a tampered request) so it
  // can never flow into join() and confuse the path expression.
  if (typeof rel !== 'string' || !rel) throw new Error('getBlob: rel (string storage key) required');
  const masterKey = await getMasterKey();
  if (!masterKey) throw new Error('getBlob: master key unavailable — cannot decrypt (fail-closed)');
  const raw = await readFile(join(root, rel));
  if (raw.length < MAGIC.length || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('getBlob: not a Mycelium blob (bad magic)');
  }
  const envelope = raw.subarray(MAGIC.length).toString('utf8');
  const b64 = await decrypt(envelope, masterKey);
  return Buffer.from(b64, 'base64');
}

/**
 * Reference-counted blob unlink — the reusable form of the SHARED-BLOB GUARD in
 * src/portal-attachments.js (DELETE /attachments/:id). Byte-identical
 * attachments share ONE encrypted blob via the same local_path (vault/obsidian
 * dedup), so a blob is deleted ONLY when no attachment row still references it.
 *
 * CALL ORDER: invoke this AFTER the attachment rows have been deleted, so the
 * COUNT reflects the post-delete world (hence no `id != ?` exclusion — the
 * deleted row is already gone). Never throws: a missing file / gone row leaves
 * unreachable ciphertext, which is safe.
 *
 * @param {object} db                 must expose rawQuery(sql, params) → {results:[{c}]}
 * @param {string} localPath          attachments.local_path (relative storage key)
 * @param {object} [opts]
 * @param {string} [opts.root]        blob root (defaults to uploadsRoot())
 * @returns {Promise<{unlinked:boolean, reason?:string, refs?:number, error?:string}>}
 */
export async function unlinkBlobIfUnreferenced(db, localPath, { root = uploadsRoot() } = {}) {
  if (typeof localPath !== 'string' || !localPath) return { unlinked: false, reason: 'no-path' };
  try {
    // INTENTIONALLY NOT scoped by user_id. The refcount protects ONE physical
    // file (uploadsRoot()/<userId>/<uuid>.enc) — it must be kept if ANY row, of
    // ANY user, still points at it, or we'd destroy that row's bytes. Scoping to
    // one user would let a delete unlink a file another tenant's row references
    // (cross-tenant DATA LOSS) — the OPPOSITE of safe. Blobs are already
    // userId-namespaced at write (putBlob → <userId>/…), so V1 paths never
    // collide across users; the V2 hardening is to ENFORCE that namespacing on
    // import/restore (vault-import, full-export-import), NOT to scope this COUNT.
    const r = await db.rawQuery('SELECT COUNT(*) AS c FROM attachments WHERE local_path = ?', [localPath]);
    const refs = Number(r?.results?.[0]?.c ?? 0);
    if (refs > 0) return { unlinked: false, reason: 'still-referenced', refs };
  } catch (e) {
    // Can't prove it's unreferenced → do NOT unlink (fail-closed: keep the blob
    // rather than risk destroying a sibling's bytes). Orphan ciphertext is safe.
    return { unlinked: false, reason: 'refcount-failed', error: String(e?.code || e) };
  }
  try {
    await unlink(join(root, localPath));
    return { unlinked: true };
  } catch (e) {
    // ENOENT (already gone) is success-equivalent; anything else is reported.
    if (e?.code === 'ENOENT') return { unlinked: true, reason: 'already-gone' };
    return { unlinked: false, reason: 'unlink-failed', error: String(e?.code || e) };
  }
}
