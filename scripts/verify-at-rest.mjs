// scripts/verify-at-rest.mjs — verify:at-rest gate (A1–A7) for whole-file SQLCipher
// blindness (A′). @see docs/AT-REST-BLINDNESS-DESIGN-2026-06-11.md §8.
//
// Proves end-to-end, against a real temp vault:
//   A1  encrypted vault opaque at rest (no magic header, no plaintext markers)
//   A2  -wal / -shm also opaque (a known plaintext column value is absent from them)
//   A3  fail-closed: wrong key + no key both throw
//   A4  round-trip: keyed open reads the pre-migration data back
//   A5  migration is idempotent + non-destructive (keeps the .pre-cipher copy)
//   A6  Python-via-bridge reads/writes the encrypted vault; bridge rejects proxied req
//   A7  two write semantics: /query raw (no encrypt) vs /batch_encrypted (AES-GCM envelope)
import Database from 'better-sqlite3';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { getDb } from '../src/db/index.js';
import { deriveDbKey, deriveSystemKey } from '../src/account/keystore.js';
import { loadKey } from '../src/crypto/keys.js';
import { ensureVaultEncrypted, isPlaintextSqlite } from '../src/account/db-cipher-migrate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const USER_MASTER = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SYSTEM_KEY = deriveSystemKey(USER_MASTER);
const DB_KEY = deriveDbKey(USER_MASTER);
const PORT = 8231; // test-only port, loopback
const MAGIC = 'SQLite format 3\0';

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log(`  [${c ? '✓' : '✗'}] ${n}${extra ? ' — ' + extra : ''}`); };
const bytesHave = (path, s) => existsSync(path) && readFileSync(path).includes(Buffer.from(s));

function openKeyed(path, key = DB_KEY) {
  const db = new Database(path);
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key="x'${key}'"`);
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

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-at-rest-'));
  const vault = join(dir, 'mycelium.db');
  let bridge = null;
  try {
    // ── seed a PLAINTEXT vault (simulating a pre-A′ vault) ──────────────────
    {
      const db = new Database(vault);
      db.exec(`CREATE TABLE facts(id TEXT PRIMARY KEY, user_id TEXT, category TEXT, key TEXT, value TEXT, UNIQUE(user_id,category,key))`);
      db.exec(`CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)`);
      db.prepare(`INSERT INTO facts(id,user_id,category,key,value) VALUES (?,?,?,?,?)`).run('f1', 'u', 'pre', 'k1', 'PLAINTEXT_PRE_MARKER');
      for (let i = 0; i < 25; i++) db.prepare(`INSERT INTO notes(body) VALUES (?)`).run(`note-${i}`);
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    }
    ok('pre: seeded vault is plaintext', isPlaintextSqlite(vault));

    // ── A5/migration: encrypt in place ──────────────────────────────────────
    const res = ensureVaultEncrypted({ dbPath: vault, dbKeyHex: DB_KEY });
    ok('A5 migration ran (migrated=true, parity OK)', res.migrated === true, `tables=${res.tables}`);
    ok('A5 plaintext .pre-cipher copy kept + still plaintext', !!res.preCipherPath && isPlaintextSqlite(res.preCipherPath));
    const res2 = ensureVaultEncrypted({ dbPath: vault, dbKeyHex: DB_KEY });
    ok('A5 idempotent (2nd run no-op)', res2.migrated === false, res2.reason);

    // ── A1: opaque at rest ──────────────────────────────────────────────────
    ok('A1 no plaintext SQLite magic header', readFileSync(vault).subarray(0, 16).toString('latin1') !== MAGIC);
    ok('A1 seeded plaintext marker absent from ciphertext', !bytesHave(vault, 'PLAINTEXT_PRE_MARKER'));

    // ── A4: round-trip keyed read of pre-migration data ─────────────────────
    {
      const db = openKeyed(vault);
      const v = db.prepare(`SELECT value FROM facts WHERE key='k1'`).get()?.value;
      const n = db.prepare(`SELECT COUNT(*) c FROM notes`).get().c;
      db.close();
      ok('A4 keyed read round-trips pre-migration data', v === 'PLAINTEXT_PRE_MARKER' && n === 25);
    }

    // ── A3: fail-closed ─────────────────────────────────────────────────────
    let noKeyThrew = false, wrongKeyThrew = false;
    try { const db = new Database(vault); db.prepare(`SELECT 1 FROM facts`).get(); db.close(); } catch { noKeyThrew = true; }
    try { const db = openKeyed(vault, 'f'.repeat(64)); db.prepare(`SELECT 1 FROM facts`).get(); db.close(); } catch { wrongKeyThrew = true; }
    ok('A3 no-key open fails closed', noKeyThrew);
    ok('A3 wrong-key open fails closed', wrongKeyThrew);

    // ── start the bridge against the encrypted vault ────────────────────────
    bridge = spawn('node', [join(ROOT, 'pipeline/vault-bridge.js')], {
      env: { ...process.env, MYCELIUM_DB: vault, USER_MASTER, SYSTEM_KEY, MYCELIUM_DB_BRIDGE_PORT: String(PORT) },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    ok('bridge: /healthz reachable', await waitHealthz());

    // ── A6: bridge rejects a proxied request ────────────────────────────────
    const proxied = await bridgeReq('/query', { sql: 'SELECT 1' }, { 'x-forwarded-for': '8.8.8.8' });
    ok('A6 bridge rejects proxied (x-forwarded-for) request', proxied.status === 403);

    // ── A6: read pre-migration data over the bridge ─────────────────────────
    const rd = await bridgeReq('/query', { sql: `SELECT value FROM facts WHERE key='k1'` });
    ok('A6 bridge /query reads the encrypted vault', rd.json?.rows?.[0]?.value === 'PLAINTEXT_PRE_MARKER');

    // ── A7-raw: /query write stays plaintext at the column level ────────────
    await bridgeReq('/query', { sql: `INSERT INTO facts(id,user_id,category,key,value) VALUES (?,?,?,?,?)`, params: ['f2', 'u', 'raw', 'k2', 'RAW_PLAINTEXT_WRITE'] });
    {
      const db = openKeyed(vault);
      const v = db.prepare(`SELECT value FROM facts WHERE key='k2'`).get()?.value;
      db.close();
      ok('A7 /query raw write is NOT column-encrypted', v === 'RAW_PLAINTEXT_WRITE');
    }

    // ── A7-enc: /batch_encrypted write lands as an AES-GCM envelope ──────────
    await bridgeReq('/batch_encrypted', { statements: [{ sql: `INSERT INTO facts(id,user_id,category,key,value) VALUES (?,?,?,?,?)`, params: ['f3', 'u', 'enc', 'k3', 'ENC_SECRET_VALUE'] }] });
    {
      const rawRead = await bridgeReq('/query', { sql: `SELECT value FROM facts WHERE key='k3'` });
      const raw = rawRead.json?.rows?.[0]?.value;
      // Envelopes are stored as base64(JSON{v,s,iv,ct,dk}) — decode before checking shape.
      let env = null; try { env = JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8')); } catch {}
      ok('A7 /batch_encrypted stored an envelope (not plaintext)', raw !== 'ENC_SECRET_VALUE' && !!(env && env.ct && env.iv && env.s && env.dk));
      // adapter (auto-decrypt) reads the plaintext back → proves it's a valid envelope
      const { db, close } = getDb({ dbPath: vault, userKey: await loadKey(USER_MASTER), systemKey: await loadKey(SYSTEM_KEY), dbKeyHex: DB_KEY });
      const dec = (await db.rawQuery(`SELECT value FROM facts WHERE key='k3'`)).results?.[0]?.value;
      close();
      ok('A7 adapter auto-decrypts the envelope back to plaintext', dec === 'ENC_SECRET_VALUE');
    }

    // ── A2: WAL/SHM + main file carry no plaintext column value ──────────────
    const anyHasMarker = [vault, vault + '-wal', vault + '-shm'].some((p) => bytesHave(p, 'RAW_PLAINTEXT_WRITE') || bytesHave(p, 'ENC_SECRET_VALUE'));
    ok('A2 plaintext column value absent from db/-wal/-shm bytes', !anyHasMarker);

    // ── A6: Python end-to-end through the bridge (urllib reroute) ───────────
    const py = spawnSync('python3', ['-c', `
import sys; sys.path.insert(0, ${JSON.stringify(join(ROOT, 'pipeline'))})
import d1_client, local_db
assert d1_client.query("SELECT value FROM facts WHERE key=?", ["k2"])[0]["value"] == "RAW_PLAINTEXT_WRITE"
local_db.batch([{"sql":"INSERT INTO facts(id,user_id,category,key,value) VALUES(?,?,?,?,?)","params":["f4","u","py","k5","PY_BATCH_WRITE"]}])
assert d1_client.query("SELECT value FROM facts WHERE key=?", ["k5"])[0]["value"] == "PY_BATCH_WRITE"
print("PYOK")
`], { env: { ...process.env, MYCELIUM_DB_BRIDGE_URL: `http://127.0.0.1:${PORT}` }, encoding: 'utf8' });
    const pyOk = py.status === 0 && /PYOK/.test(py.stdout || '');
    ok('A6 Python d1_client/local_db read+write via bridge', pyOk, pyOk ? '' : (py.stderr || py.stdout || 'no python3?').trim().split('\n').pop());
  } finally {
    if (bridge) { try { bridge.kill('SIGTERM'); } catch {} }
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n================================================================`);
  console.log(`VERDICT: ${fail === 0 ? 'GO' : 'NO-GO'} — at-rest blindness (A1-A7)  (${pass} pass, ${fail} fail)  EXIT=${fail === 0 ? 0 : 1}`);
  console.log(`================================================================`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('verify:at-rest crashed:', e); process.exit(1); });
