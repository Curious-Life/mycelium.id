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
import { mkdir, open, rename, readFile } from 'node:fs/promises';
import { join, dirname, extname, resolve, sep } from 'node:path';
import crypto from 'node:crypto';
import { encrypt, decrypt, getMasterKey } from '../crypto/crypto-local.js';
import { uploadsRoot } from '../paths.js';

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
  const masterKey = await getMasterKey();
  if (!masterKey) throw new Error('getBlob: master key unavailable — cannot decrypt (fail-closed)');
  // Defense in depth: `rel` is a server-minted storage key (join(userId, uuid)),
  // but never let a tampered value traverse out of the uploads root via `..`.
  // Resolve + confine before the read (closes the path-injection on join(root,rel)).
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    throw new Error('getBlob: refusing to read a blob outside the uploads root');
  }
  const raw = await readFile(abs);
  if (raw.length < MAGIC.length || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('getBlob: not a Mycelium blob (bad magic)');
  }
  const envelope = raw.subarray(MAGIC.length).toString('utf8');
  const b64 = await decrypt(envelope, masterKey);
  return Buffer.from(b64, 'base64');
}
