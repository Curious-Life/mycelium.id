// verify:embedding-novelty — proves pipeline/compute-embedding-novelty.py computes the
// Tier-1 per-territory novelty (intra-territory NN cosine-distance dispersion) end-to-
// end on a seeded vault: a SPREAD territory scores higher novelty than a TIGHT one, the
// value is ENCRYPTED at rest (and the adapter decrypts it), the min-length gate flags
// short territories, and it UPDATEs the complexity_snapshots rows compute-complexity
// wrote. Network-free (real 768-D envelopes; no model). PASS/FAIL ledger; exit 0 iff GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { encryptVector } from '../src/search/ann/decode.js';
import { importMasterKey } from '../src/crypto/crypto-local.js';

const DB = 'data/verify-embnov.db', KCV = 'data/verify-embnov-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';
const PY = 'pipeline/.venv/bin/python3';
const DIM = 768;

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const isEnvelope = (v) => { if (typeof v !== 'string') return false; try { const o = JSON.parse(Buffer.from(v, 'base64').toString('utf8')); return !!(o.v && o.s && o.iv && o.ct && o.dk); } catch { return false; } };
const masterKey = await importMasterKey(userHex);

function unit(fn) { const v = new Float32Array(DIM); for (let d = 0; d < DIM; d++) v[d] = fn(d); let nrm = 0; for (let d = 0; d < DIM; d++) nrm += v[d] * v[d]; nrm = Math.sqrt(nrm) || 1; for (let d = 0; d < DIM; d++) v[d] /= nrm; return v; }
const now = Date.now();
let mid = 0;
async function seed(territoryId, vecFor, count) {
  for (let i = 0; i < count; i++) {
    const id = `m-${mid++}`;
    const iso = new Date(now - (count - i) * 86400000).toISOString().replace('Z', '+00:00');
    const env = await encryptVector(vecFor(i), 'personal', masterKey);
    await db.rawQuery(`INSERT INTO messages (id, user_id, role, content, embedding_768, created_at) VALUES (?,?,'user',NULL,?,?)`, [id, U, env, iso]);
    await db.rawQuery(`INSERT INTO clustering_points (user_id, source_type, source_id, territory_id, realm_id, created_at) VALUES (?,?,?,?,?,?)`, [U, 'message', id, territoryId, 0, iso]);
  }
}
// Territory 1 — TIGHT: all messages share ONE direction → NN distance ≈ 0 → low novelty.
await seed(1, () => unit((d) => Math.sin((d + 1) * 0.011)), 6);
// Territory 2 — SPREAD: each message a distinct direction → high NN distance → high novelty.
await seed(2, (i) => unit((d) => Math.sin((d + 1) * (0.011 + i * 0.05)) + Math.cos((d + 1) * (0.02 + i * 0.07))), 6);
// Territory 3 — single message → n<2 → the stage must acc.skip() WITHOUT crashing (the
// live bug: Python Accumulator lacked skip(); the gate missed it with ≥2-msg territories).
await seed(3, () => unit((d) => Math.cos((d + 1) * 0.03)), 1);

const env0 = { ...process.env, PYTHONPATH: 'pipeline', MYCELIUM_DB: DB, MYCELIUM_KCV: KCV, MYCELIUM_USER_ID: U, USER_MASTER: userHex, SYSTEM_KEY: systemHex };
// compute-complexity first (creates the territory rows the novelty stage UPDATEs).
const cx = spawnSync('node', ['pipeline/compute-complexity.js'], { encoding: 'utf8', env: env0 });
const nov = spawnSync(PY, ['pipeline/compute-embedding-novelty.py'], { encoding: 'utf8', env: env0 });
rec('N1. both stages exit 0', cx.status === 0 && nov.status === 0,
  nov.status !== 0 ? (nov.stderr || nov.stdout || '').slice(-400) : (nov.stdout.match(/\[novelty\].*scored.*/)?.[0] || ''));

try {
  // N2. SPREAD novelty > TIGHT novelty (the discrimination — adapter decrypts to number).
  const get = async (tid) => (await db.rawQuery(`SELECT embedding_novelty, embedding_novelty_low_conf FROM complexity_snapshots WHERE user_id=? AND level='territory' AND level_id=?`, [U, tid]));
  const t1 = (await get(1)).results?.[0] || (await get(1))[0];
  const t2 = (await get(2)).results?.[0] || (await get(2))[0];
  const nv1 = Number(t1?.embedding_novelty), nv2 = Number(t2?.embedding_novelty);
  rec('N2. spread territory novelty > tight territory novelty (NN-dispersion discriminates)',
    Number.isFinite(nv1) && Number.isFinite(nv2) && nv2 > nv1,
    `tight=${nv1} spread=${nv2}`);

  // N3. embedding_novelty is an ENVELOPE at rest (encrypted), low-conf flag plaintext.
  const raw = new Database(DB, { readonly: true });
  const rawRow = raw.prepare(`SELECT embedding_novelty, embedding_novelty_low_conf FROM complexity_snapshots WHERE user_id=? AND level='territory' AND level_id=2`).get(U);
  raw.close();
  // SQLCipher collapse (Stage B/C cut 5): embedding_novelty is PLAINTEXT-in-cipher —
  // at-rest = whole-file SQLCipher (verify:at-rest), not a per-field envelope.
  rec('N3. embedding_novelty PLAINTEXT-in-cipher (collapse cut 5; verify:at-rest); low_conf flag plaintext',
    !isEnvelope(rawRow?.embedding_novelty) && (rawRow.embedding_novelty_low_conf === 0 || rawRow.embedding_novelty_low_conf === 1),
    `plain=${!isEnvelope(rawRow?.embedding_novelty)} low_conf=${rawRow?.embedding_novelty_low_conf}`);

  // N4. min-length gate: re-run with MIN above the seed size → low_conf flips to 1.
  const nov2 = spawnSync(PY, ['pipeline/compute-embedding-novelty.py'], { encoding: 'utf8', env: { ...env0, EMBEDDING_NOVELTY_MIN: '9' } });
  const t2b = (await db.rawQuery(`SELECT embedding_novelty_low_conf FROM complexity_snapshots WHERE user_id=? AND level='territory' AND level_id=2`, [U])).results?.[0];
  rec('N4. min-length gate: n(6) < MIN(9) → embedding_novelty_low_conf=1', nov2.status === 0 && Number(t2b?.embedding_novelty_low_conf) === 1,
    `low_conf=${t2b?.embedding_novelty_low_conf}`);
} finally {
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const ok = ledger.every(Boolean);
console.log(`\n${'='.repeat(64)}\nVERDICT: ${ok ? 'GO — embedding-novelty computes; spread>tight; encrypted at rest; min-length gate' : 'NO-GO — see FAIL rows'}  EXIT=${ok ? 0 : 1}\n${'='.repeat(64)}`);
process.exit(ok ? 0 : 1);
