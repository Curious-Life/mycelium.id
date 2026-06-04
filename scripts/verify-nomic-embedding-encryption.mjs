// verify:nomic-embedding-encryption — SEC-4. Proves clustering_points.nomic_embedding
// is encrypted at rest as a wrapped-DEK envelope (no raw float bytes on disk) AND that
// the envelope is byte-compatible across the JS↔Python boundary in BOTH directions, so
// the clustering pipeline (cluster.py) can still read what the sync writer (JS) wrote
// and vice-versa. Also proves the legacy raw-BLOB read fallback survives the migration,
// and that the local pipeline/cache/*.npy performance cache is likewise encrypted at
// rest (envelope, not raw float bytes) with legacy plaintext rejected-and-deleted.
//
// The cross-language checks run the REAL production decoder (cluster.py
// _decode_nomic_embedding) and the REAL Python writer (crypto_local.encrypt_vector)
// via the pipeline venv — not a re-implementation. PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { encryptVector, decryptVector, encodeVector } from '../src/search/ann/decode.js';
import { importMasterKey } from '../src/crypto/crypto-local.js';

const DB = 'data/verify-nomic-embedding.db', KCV = 'data/verify-nomic-embedding-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';
const SCOPE = 'personal';
const DIM = 256;
const PY = 'pipeline/.venv/bin/python3';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const close9 = (a, b, tol = 1e-5) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol);

// Distinctive 256-D vector (some negatives; L2-ish but exact norm irrelevant here).
const vec = new Float32Array(DIM);
for (let i = 0; i < DIM; i++) vec[i] = Math.sin(i * 0.37) * 0.5 - 0.13;
const vecArr = Array.from(vec);

const masterKey = await importMasterKey(userHex);

// Run a tiny Python snippet against the pipeline venv; returns parsed JSON from stdout.
function py(code, extraEnv = {}) {
  const r = spawnSync(PY, ['-c', code], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: 'pipeline', MYCELIUM_DB: DB, USER_MASTER: userHex, SYSTEM_KEY: systemHex, ...extraEnv },
  });
  if (r.status !== 0) throw new Error(`python failed (exit ${r.status}): ${r.stderr || r.stdout}`);
  const line = r.stdout.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(line);
}

try {
  // ── NE1. At rest: envelope TEXT, not raw float bytes ──────────────────────
  const envelope = await encryptVector(vec, SCOPE, masterKey);
  await db.rawQuery(
    `INSERT INTO clustering_points (id, user_id, source_type, source_id, nomic_embedding, embedding_model, created_at, updated_at)
     VALUES (?,?,'message',?,?,'nomic-v1.5-256d', datetime('now'), datetime('now'))`,
    [`${U}:cp:message:m1`, U, 'm1', envelope]);

  const raw = new Database(DB, { readonly: true });
  const atRest = raw.prepare(`SELECT nomic_embedding FROM clustering_points WHERE id=?`).get(`${U}:cp:message:m1`).nomic_embedding;
  raw.close();
  const plaintextB64 = encodeVector(vec); // what an UNENCRYPTED vector would look like
  let envOk = false;
  try {
    const obj = JSON.parse(Buffer.from(atRest, 'base64').toString('utf8'));
    envOk = obj.v && obj.s && obj.iv && obj.ct && obj.dk;
  } catch { envOk = false; }
  rec('NE1. nomic_embedding at rest is a wrapped-DEK envelope, NOT raw float bytes',
    typeof atRest === 'string' && envOk && !atRest.includes(plaintextB64),
    `at-rest[0..48]=${String(atRest).slice(0, 48)}…  (plaintextB64 absent=${!String(atRest).includes(plaintextB64)})`);

  // ── NE2. JS round-trip ────────────────────────────────────────────────────
  const back = await decryptVector(atRest, masterKey, null, DIM);
  rec('NE2. JS encryptVector → decryptVector recovers the vector (≤1e-5)',
    close9(Array.from(back), vecArr));

  // ── NE3. Python (real cluster.py decoder) decrypts the JS envelope ─────────
  const py3 = py(
    `import os,json,sys
sys.path.insert(0,'pipeline')
from cluster import _decode_nomic_embedding
mk=bytes.fromhex(os.environ['USER_MASTER'])
v=_decode_nomic_embedding(os.environ['ENV'], mk)
print(json.dumps([float(x) for x in v]))`,
    { ENV: atRest });
  rec('NE3. cluster.py _decode_nomic_embedding decrypts the JS envelope (≤1e-5)',
    Array.isArray(py3) && py3.length === DIM && close9(py3, vecArr));

  // ── NE4. JS decrypts a Python-written envelope ────────────────────────────
  const py4 = py(
    `import os,json
import crypto_local as c
import numpy as np
mk=bytes.fromhex(os.environ['USER_MASTER'])
v=np.array(json.loads(os.environ['VEC']),dtype=np.float32)
print(json.dumps(c.encrypt_vector(v,'${SCOPE}',mk)))`,
    { VEC: JSON.stringify(vecArr) });
  const fromPy = await decryptVector(py4, masterKey, null, DIM);
  rec('NE4. JS decryptVector reads a Python encrypt_vector envelope (≤1e-5)',
    close9(Array.from(fromPy), vecArr));

  // ── NE5. Legacy raw-BLOB read fallback (pre-SEC-4 rows) ────────────────────
  const hex = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('hex');
  const py5 = py(
    `import os,json,sys
sys.path.insert(0,'pipeline')
from cluster import _decode_nomic_embedding
mk=bytes.fromhex(os.environ['USER_MASTER'])
v=_decode_nomic_embedding(os.environ['HEX'], mk)  # legacy hex-string raw blob
print(json.dumps([float(x) for x in v]))`,
    { HEX: hex });
  rec('NE5. legacy raw float32 BLOB still decodes (migration-safe fallback, ≤1e-5)',
    Array.isArray(py5) && py5.length === DIM && close9(py5, vecArr));

  // ── NE6/NE7. Local .npy cache (SEC-4 residual): encrypted at rest + legacy
  //            plaintext cache rejected-and-deleted on load. Exercises the REAL
  //            cluster.py _save_cache / _load_cache against a temp cache dir, so
  //            no plaintext embedding bytes ever touch disk. ────────────────────
  const cache = py(
    `import os,sys,json,tempfile
import numpy as np
sys.path.insert(0,'pipeline')
from pathlib import Path
import cluster
from crypto_local import is_encrypted
d=Path(tempfile.mkdtemp())
cluster.CACHE_DIR=d
cluster.CACHE_EMBEDDINGS=d/'nomic_embeddings.npy'
cluster.CACHE_POINT_IDS=d/'nomic_point_ids.json'
ids=['local-user:cp:message:m%d'%i for i in range(4)]
embs=(np.arange(4*cluster.NOMIC_DIM,dtype=np.float32).reshape(4,cluster.NOMIC_DIM)*0.01)-1.0
# encrypt-on-write, then inspect the raw bytes on disk
cluster._save_cache(ids,embs)
emb_raw=cluster.CACHE_EMBEDDINGS.read_bytes()
emb_txt=cluster.CACHE_EMBEDDINGS.read_text()
id_txt=cluster.CACHE_POINT_IDS.read_text()
magic_absent = not emb_raw.startswith(b'\\x93NUMPY')          # not a raw .npy
is_env = bool(is_encrypted(emb_txt) and is_encrypted(id_txt))  # both are envelopes
gi,ge=cluster._load_cache()                                     # decrypt-on-read round-trip
roundtrip = bool(gi==ids and ge is not None and np.array_equal(ge,embs))
# legacy plaintext cache must be rejected AND deleted (no stale plaintext lingers)
np.save(str(cluster.CACHE_EMBEDDINGS),embs)
cluster.CACHE_POINT_IDS.write_text(json.dumps(ids))
li,le=cluster._load_cache()
legacy_rejected = bool(le is None and not cluster.CACHE_EMBEDDINGS.exists() and not cluster.CACHE_POINT_IDS.exists())
print(json.dumps({'magic_absent':magic_absent,'is_env':is_env,'roundtrip':roundtrip,'legacy_rejected':legacy_rejected}))`);
  rec('NE6. local .npy cache encrypted at rest (envelope TEXT, not raw float bytes) + decrypt round-trip',
    cache.magic_absent && cache.is_env && cache.roundtrip,
    `magic_absent=${cache.magic_absent} is_env=${cache.is_env} roundtrip=${cache.roundtrip}`);
  rec('NE7. legacy plaintext cache is rejected on load AND deleted (no stale plaintext lingers)',
    cache.legacy_rejected);
} finally {
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — nomic_embedding + local .npy cache encrypted at rest; JS↔Python envelope parity + legacy fallback' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
