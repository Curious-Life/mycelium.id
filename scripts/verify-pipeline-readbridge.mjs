// scripts/verify-pipeline-readbridge.mjs — verify:pipeline-readbridge (Phase 1 step 4).
//
// Once the vault is whole-file encrypted (step 5), stock Python sqlite3 cannot
// open it, so the clustering/measurement pipeline reads through pipeline/
// vault-bridge.js instead of sqlite3.connect (opt-in: MYCELIUM_DB_BRIDGE_URL).
// verify:at-rest A6/A7 prove the bridge round-trips `facts`; THIS gate proves the
// actual CLUSTERING read SHAPES (cluster.py:274 content-JOIN + the nomic_embedding
// read) round-trip with parity, and that the bridge's BLOB-rejection guard fires
// (the one pre-step-5 requirement: nomic_embedding must be a TEXT envelope, never
// a raw BLOB — ties to the sync-clustering-points backfill).
import Database from 'better-sqlite3';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveDbKey, deriveSystemKey } from '../src/account/keystore.js';
import { ensureVaultEncrypted } from '../src/account/db-cipher-migrate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const USER_MASTER = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SYSTEM_KEY = deriveSystemKey(USER_MASTER);
const DB_KEY = deriveDbKey(USER_MASTER);
const PORT = 8232;

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log(`  [${c ? '✓' : '✗'}] ${n}${extra ? ' — ' + extra : ''}`); };

function openKeyed(path) {
  const db = new Database(path);
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key="x'${DB_KEY}'"`);
  return db;
}
async function bridgeReq(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': data.length } : {}), ...headers } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null })); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
async function waitHealthz(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await bridgeReq('/healthz', null); if (r.status === 200 && r.json?.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// A nomic_embedding as the pipeline stores it post-SEC-4: a TEXT envelope string.
const ENVELOPE = 'eyJ2IjoxLCJzIjoicGVyc29uYWwiLCJpdiI6IkFBIiwiY3QiOiJCQiIsImRrIjoiQ0MifQ==';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-readbridge-'));
  const vault = join(dir, 'mycelium.db');
  let bridge = null;
  try {
    // ── seed a plaintext vault with the clustering read surface ──────────────
    {
      const db = new Database(vault);
      db.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY, user_id TEXT, content TEXT);
               CREATE TABLE documents(id TEXT PRIMARY KEY, user_id TEXT, content TEXT);
               CREATE TABLE attachments(id TEXT PRIMARY KEY, transcript TEXT, description TEXT);
               CREATE TABLE clustering_points(id TEXT PRIMARY KEY, user_id TEXT, source_id TEXT, source_type TEXT, scope TEXT DEFAULT 'org', nomic_embedding BLOB)`);
      db.prepare(`INSERT INTO messages(id,user_id,content) VALUES (?,?,?)`).run('m1', 'u', 'CONTENT_ENVELOPE_M1');
      // cp1: normal — TEXT-envelope nomic_embedding (the post-SEC-4 shape)
      db.prepare(`INSERT INTO clustering_points(id,user_id,source_id,source_type,nomic_embedding) VALUES (?,?,?,?,?)`).run('cp1', 'u', 'm1', 'message', ENVELOPE);
      // cp2: NULL nomic_embedding (un-embedded point — must be readable)
      db.prepare(`INSERT INTO clustering_points(id,user_id,source_id,source_type,nomic_embedding) VALUES (?,?,?,?,?)`).run('cp2', 'u', 'm1', 'message', null);
      // cp3: a RAW BLOB nomic_embedding (legacy/un-re-encrypted) — the bridge must reject it
      db.prepare(`INSERT INTO clustering_points(id,user_id,source_id,source_type,nomic_embedding) VALUES (?,?,?,?,?)`).run('cp3', 'u', 'm1', 'message', Buffer.from([1, 2, 3, 4]));
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    }

    // ── encrypt it (step-5 migration) so the bridge is the ONLY reader ───────
    const res = ensureVaultEncrypted({ dbPath: vault, dbKeyHex: DB_KEY });
    ok('vault encrypted (migration ran)', res.migrated === true, `tables=${res.tables}`);

    bridge = spawn('node', [join(ROOT, 'pipeline/vault-bridge.js')], {
      env: { ...process.env, MYCELIUM_DB: vault, USER_MASTER, SYSTEM_KEY, MYCELIUM_DB_BRIDGE_PORT: String(PORT) },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    ok('bridge: /healthz reachable', await waitHealthz());

    // direct keyed read = ground truth for parity
    const direct = openKeyed(vault);
    const dContent = direct.prepare(`SELECT cp.id, m.content AS content FROM clustering_points cp LEFT JOIN messages m ON m.id=cp.source_id AND cp.source_type='message' WHERE cp.id='cp1' AND cp.user_id='u'`).get();
    const dNomic = direct.prepare(`SELECT id, nomic_embedding FROM clustering_points WHERE id IN ('cp1','cp2') ORDER BY id`).all();
    direct.close();

    // P1: clustering content JOIN (cluster.py:274 shape) round-trips via bridge
    const p1 = await bridgeReq('/query', { sql: `SELECT cp.id, m.content AS content FROM clustering_points cp LEFT JOIN messages m ON m.id=cp.source_id AND cp.source_type='message' WHERE cp.id=? AND cp.user_id=?`, params: ['cp1', 'u'] });
    ok('P1 clustering content-JOIN read parity via bridge',
      p1.status === 200 && p1.json?.rows?.[0]?.content === dContent.content && dContent.content === 'CONTENT_ENVELOPE_M1',
      `content=${p1.json?.rows?.[0]?.content}`);

    // P2: nomic_embedding read (TEXT envelope + NULL) round-trips with parity
    const p2 = await bridgeReq('/query', { sql: `SELECT id, nomic_embedding FROM clustering_points WHERE id IN ('cp1','cp2') ORDER BY id` });
    const rows = p2.json?.rows || [];
    ok('P2 nomic_embedding (TEXT envelope + NULL) read parity via bridge',
      p2.status === 200 && rows.length === 2 &&
      rows[0].nomic_embedding === dNomic[0].nomic_embedding && rows[0].nomic_embedding === ENVELOPE &&
      rows[1].nomic_embedding === null,
      `cp1=${String(rows[0]?.nomic_embedding).slice(0, 8)}… cp2=${rows[1]?.nomic_embedding}`);

    // P3: a RAW BLOB column in the result set is REJECTED (the pre-step-5 guard)
    const p3 = await bridgeReq('/query', { sql: `SELECT id, nomic_embedding FROM clustering_points WHERE id='cp3'` });
    ok('P3 bridge rejects a raw-BLOB nomic_embedding (must be TEXT envelope before step 5)',
      p3.status === 500 && /BLOB/.test(p3.json?.error || ''),
      `status=${p3.status} err=${(p3.json?.error || '').slice(0, 40)}`);

    // P4: Python local_db reroute runs the real nomic_embedding read shape e2e
    const py = spawnSync('python3', ['-c', `
import sys; sys.path.insert(0, ${JSON.stringify(join(ROOT, 'pipeline'))})
import local_db
rows = local_db.query("SELECT id, nomic_embedding FROM clustering_points WHERE id=?", ["cp1"])
assert rows[0]["nomic_embedding"] == ${JSON.stringify(ENVELOPE)}, rows
print("PYOK")
`], { env: { ...process.env, MYCELIUM_DB_BRIDGE_URL: `http://127.0.0.1:${PORT}` }, encoding: 'utf8' });
    const pyOk = py.status === 0 && /PYOK/.test(py.stdout || '');
    ok('P4 Python local_db reads nomic_embedding via the bridge reroute (opt-in URL)',
      pyOk, pyOk ? '' : (py.stderr || py.stdout || 'no python3?').trim().split('\n').pop());
  } finally {
    if (bridge) { try { bridge.kill('SIGTERM'); } catch {} }
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n================================================================`);
  console.log(`VERDICT: ${fail === 0 ? 'GO' : 'NO-GO'} — pipeline read bridge: clustering reads round-trip the encrypted vault  (${pass} pass, ${fail} fail)  EXIT=${fail === 0 ? 0 : 1}`);
  console.log(`================================================================`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('verify:pipeline-readbridge crashed:', e); process.exit(1); });
