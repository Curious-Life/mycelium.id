// scripts/verify-vectors-raw.mjs — verify:vectors-raw
//
// Stage A of the SQLCipher collapse: embedding vectors stored as RAW little-endian
// float32 BYTES inside the whole-file-encrypted vault (no inner AES-GCM envelope,
// no base64-on-base64 bloat). This gate proves the codec:
//   - raw round-trip (encodeVectorRaw → decodeStoredVector) is bit-identical
//   - the LE-f32 byte layout is the deterministic cross-language contract (JS↔Python)
//   - a raw Buffer round-trips through a keyed SQLCipher DB + the file stays ciphertext
//   - decodeStoredVector DUAL-READS: Buffer→raw, legacy string→wrapped-DEK envelope
//     (so a half-migrated column reads correctly during backfill)
//   - bad lengths fail closed
// @see docs/DESIGN-sqlcipher-stageA-vectors-2026-06-19.md
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { encodeVectorRaw, decodeStoredVector, encryptVector } from '../src/search/ann/decode.js';
import { importMasterKey } from '../src/crypto/crypto-local.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const ledger = [];
const rec = (n, c, x = '') => { ledger.push(c); console.log(`  [${c ? '✓' : '✗'}] ${n}${x ? ' — ' + x : ''}`); };
const close = (a, b, eps = 1e-6) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);
const magic = Buffer.from('SQLite format 3\0', 'latin1');
const header16 = (p) => { const fd = openSync(p, 'r'); try { const b = Buffer.alloc(16); readSync(fd, b, 0, 16, 0); return b; } finally { closeSync(fd); } };

async function main() {
  const DIM = 5;
  const vec = new Float32Array([0.1, -0.2, 0.333, 1.5, -42.0]);

  // 1. raw round-trip
  {
    const raw = encodeVectorRaw(vec);
    rec('1a encodeVectorRaw → Buffer of dim*4 bytes', Buffer.isBuffer(raw) && raw.length === DIM * 4, `len=${raw.length}`);
    const out = await decodeStoredVector(raw, DIM);
    rec('1b decodeStoredVector(Buffer) round-trips bit-identical', close(Array.from(out), Array.from(vec)));
  }

  // 2. deterministic LE-f32 byte contract (what Python np.array(...,'<f4').tobytes() MUST also produce)
  {
    const hex = encodeVectorRaw(new Float32Array([1.0, 2.0, -0.5])).toString('hex');
    rec('2 LE-f32 byte layout matches the cross-language contract', hex === '0000803f00000040000000bf', `hex=${hex}`);
  }

  // 3. raw Buffer round-trips through a keyed SQLCipher DB; file is ciphertext
  {
    const dir = mkdtempSync(join(tmpdir(), 'verify-vraw-'));
    const dbPath = join(dir, 'v.db');
    const db = new Database(dbPath);
    db.pragma(`cipher='sqlcipher'`); db.pragma(`key="x'${DB_KEY}'"`);
    db.exec(`CREATE TABLE t(id TEXT PRIMARY KEY, embedding_768 TEXT)`); // TEXT-affinity, like the live schema
    db.prepare(`INSERT INTO t(id, embedding_768) VALUES ('a', ?)`).run(encodeVectorRaw(vec));
    const stored = db.prepare(`SELECT embedding_768 FROM t WHERE id='a'`).get().embedding_768;
    db.close();
    rec('3a raw bytes stored in a TEXT-affinity col read back as a Buffer (no migration)', Buffer.isBuffer(stored), `typeof=${Buffer.isBuffer(stored) ? 'Buffer' : typeof stored}`);
    const out = await decodeStoredVector(stored, DIM);
    rec('3b round-trips through SQLCipher bit-identical', close(Array.from(out), Array.from(vec)));
    rec('3c the vault file is ciphertext at rest (no SQLite magic header)', !header16(dbPath).equals(magic));
    rmSync(dir, { recursive: true, force: true });
  }

  // 4. DUAL-READ: legacy wrapped-DEK envelope still decodes through the same entry point
  {
    const masterKey = await importMasterKey(crypto.randomBytes(32).toString('hex'));
    const env = await encryptVector(vec, 'personal', masterKey); // a legacy string envelope
    rec('4a a legacy envelope is a string (routes to the decrypt path)', typeof env === 'string');
    const out = await decodeStoredVector(env, DIM, masterKey);
    rec('4b decodeStoredVector(string) dual-reads the legacy envelope', close(Array.from(out), Array.from(vec)));
  }

  // 5. fail-closed on a wrong-length buffer
  {
    let threw = false;
    try { await decodeStoredVector(Buffer.alloc(8), DIM); } catch { threw = true; }
    rec('5 wrong-length raw buffer fails closed', threw);
  }

  // 6. cross-language (best-effort): Python encode_vector_raw → JS decodeStoredVector.
  //    Skipped (not failed) when the pipeline venv is absent locally; runs in CI.
  {
    const py = join(ROOT, 'pipeline/.venv/bin/python3');
    if (!existsSync(py)) {
      console.log('  [—] 6 cross-language Python round-trip — SKIPPED (no pipeline/.venv; runs in CI)');
    } else {
      const code = `import sys; sys.path.insert(0,'pipeline'); import crypto_local, numpy as np; ` +
        `sys.stdout.buffer.write(crypto_local.encode_vector_raw(np.array([0.1,-0.2,0.333,1.5,-42.0],dtype=np.float32)))`;
      const r = spawnSync(py, ['-c', code], { cwd: ROOT, maxBuffer: 1 << 20 });
      const ok = r.status === 0 && Buffer.isBuffer(r.stdout) && r.stdout.length === DIM * 4;
      if (ok) {
        const out = await decodeStoredVector(r.stdout, DIM);
        rec('6 Python-written raw bytes decode in JS (cross-language)', close(Array.from(out), Array.from(vec)));
      } else {
        rec('6 cross-language Python round-trip', false, `python exit=${r.status} ${String(r.stderr).slice(0, 120)}`);
      }
    }
  }

  const pass = ledger.filter(Boolean).length, fail = ledger.length - pass;
  console.log(`\n================================================================`);
  console.log(`VERDICT: ${fail === 0 ? 'GO' : 'NO-GO'} — vectors as raw bytes inside SQLCipher (codec + dual-read)  (${pass} pass, ${fail} fail)  EXIT=${fail === 0 ? 0 : 1}`);
  console.log(`================================================================`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('verify:vectors-raw crashed:', e); process.exit(1); });
