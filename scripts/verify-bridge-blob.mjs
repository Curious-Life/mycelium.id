// scripts/verify-bridge-blob.mjs — verify:bridge-blob
//
// The Python↔Node vault bridge (pipeline/vault-bridge.js) must carry raw BLOB bytes
// BOTH ways so Stage-A raw vector columns (nomic_embedding, embedding_768,
// anchor_vector) cross it: params IN and results OUT travel as {__b64__: <base64>}.
// Before this, rawRun THREW on any BLOB result. This gate spins up the REAL bridge
// against a keyed throwaway SQLCipher vault and proves the round-trip end-to-end:
//   - a raw Float32 BLOB written via a {__b64__} param lands as a BLOB at rest
//   - reading it back returns {__b64__} decoding to the EXACT bytes
//   - a normal string/number param + a normal TEXT cell are untouched (no mis-tag)
//   - the file stays ciphertext at rest
// @see docs/DESIGN-sqlcipher-vectors-768-anchor-2026-06-19.md
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import crypto from 'node:crypto';
import { deriveDbKey } from '../src/account/keystore.js';

const ledger = [];
const rec = (n, c, x = '') => { ledger.push(c); console.log(`  [${c ? '✓' : '✗'}] ${n}${x ? ' — ' + x : ''}`); };
const magic = Buffer.from('SQLite format 3\0', 'latin1');
const header16 = (p) => { const fd = openSync(p, 'r'); try { const b = Buffer.alloc(16); readSync(fd, b, 0, 16, 0); return b; } finally { closeSync(fd); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(port, route, body) {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-bridge-blob-'));
  const dbPath = join(dir, 'v.db');
  const userHex = crypto.randomBytes(32).toString('hex');
  const systemHex = crypto.randomBytes(32).toString('hex');
  const dbKeyHex = deriveDbKey(userHex);
  const port = 8090 + (crypto.randomBytes(1)[0] % 200);

  // Keyed throwaway vault with a BLOB column.
  const db = new Database(dbPath);
  db.pragma(`cipher='sqlcipher'`); db.pragma(`key="x'${dbKeyHex}'"`); db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE t(id TEXT PRIMARY KEY, vec BLOB, label TEXT)`);
  db.close();

  // Spin up the REAL bridge.
  const bridge = spawn('node', [resolve('pipeline/vault-bridge.js')], {
    env: { ...process.env, MYCELIUM_DB: dbPath, USER_MASTER: userHex, SYSTEM_KEY: systemHex, MYCELIUM_DB_BRIDGE_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  bridge.stderr.on('data', (d) => { stderr += d; });

  try {
    // Wait for /healthz.
    let up = false;
    for (let i = 0; i < 50; i++) {
      try { const h = await post(port, '/healthz', {}); if (h?.ok) { up = true; break; } } catch { /* not up */ }
      await sleep(100);
    }
    rec('0 bridge boots + /healthz', up, up ? '' : stderr.slice(0, 200));
    if (!up) throw new Error('bridge did not start');

    // The raw vector to round-trip.
    const vec = new Float32Array([1.0, -0.5, 0.25, 3.14159, -2.0]);
    const raw = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    const b64 = raw.toString('base64');

    // WRITE: a {__b64__} param binds as a BLOB; a normal string param stays TEXT.
    const w = await post(port, '/batch', { statements: [
      { sql: `INSERT INTO t(id, vec, label) VALUES (?, ?, ?)`, params: ['r1', { __b64__: b64 }, 'hello'] },
    ] });
    rec('1 write via {__b64__} param committed', w?.ok === true && w?.count === 1, JSON.stringify(w));

    // READ: the BLOB comes back tagged; the TEXT cell is plain.
    const q = await post(port, '/query', { sql: `SELECT id, vec, label FROM t WHERE id = ?`, params: ['r1'] });
    const row = q?.rows?.[0];
    rec('2 read returns a row', !!row, JSON.stringify(q).slice(0, 120));
    rec('3 BLOB result is tagged {__b64__}', !!(row && row.vec && typeof row.vec.__b64__ === 'string'), row ? `vec=${JSON.stringify(row.vec).slice(0, 40)}` : '');
    const back = row?.vec?.__b64__ ? Buffer.from(row.vec.__b64__, 'base64') : Buffer.alloc(0);
    rec('4 BLOB bytes round-trip EXACTLY', back.equals(raw), `len ${back.length} vs ${raw.length}`);
    rec('5 normal TEXT cell untouched (no mis-tag)', row?.label === 'hello', `label=${JSON.stringify(row?.label)}`);

    // A normal string param is bound as text, not mistaken for a blob tag.
    const q2 = await post(port, '/query', { sql: `SELECT count(*) AS n FROM t WHERE label = ?`, params: ['hello'] });
    rec('6 normal string param passes through (matches)', q2?.rows?.[0]?.n === 1, JSON.stringify(q2?.rows?.[0]));

    // At rest: the stored value is a real BLOB (verify by a direct keyed read).
    const chk = new Database(dbPath, { readonly: true });
    chk.pragma(`cipher='sqlcipher'`); chk.pragma(`key="x'${dbKeyHex}'"`);
    const stored = chk.prepare(`SELECT vec FROM t WHERE id='r1'`).get().vec;
    chk.close();
    rec('7 stored at rest as a raw BLOB (Buffer, exact bytes)', Buffer.isBuffer(stored) && stored.equals(raw), `isBuffer=${Buffer.isBuffer(stored)} len=${stored?.length}`);
  } finally {
    try { bridge.kill('SIGTERM'); } catch { /* */ }
  }
  rec('8 vault ciphertext at rest', !header16(dbPath).equals(magic));
  rmSync(dir, { recursive: true, force: true });

  const pass = ledger.filter(Boolean).length, fail = ledger.length - pass;
  console.log(`\n================================================================`);
  console.log(`VERDICT: ${fail === 0 ? 'GO' : 'NO-GO'} — vault-bridge bidirectional BLOB transport ({__b64__} both ways)  (${pass} pass, ${fail} fail)  EXIT=${fail === 0 ? 0 : 1}`);
  console.log(`================================================================`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('verify:bridge-blob crashed:', e); process.exit(1); });
