// pipeline/vault-bridge.js — long-running Python→Node loopback DB bridge (V1 local).
//
// At-rest blindness (A′, docs/AT-REST-BLINDNESS-DESIGN-2026-06-11.md): the vault is
// whole-file SQLCipher and ONLY Node opens the cipher. Stock Python `sqlite3` cannot
// read a SQLCipher file, so the pipeline stages reach the vault through THIS service
// instead of `sqlite3.connect`. It promotes the old spawn-per-call local-write-bridge
// into a persistent server (the read volume — ~160 MB across 450+ batched reads in a
// clustering pass — makes per-call Node startup untenable); it opens the keyed vault
// ONCE and serves every Python read/write over loopback.
//
// Topology mirrors embed-service.py / transcribe-service.py: a long-running 127.0.0.1
// server the pipeline owns (run-clustering.sh starts it, waits on /healthz, kills it
// on EXIT). NEVER expose this port (CLAUDE.md §13) — it serves DECRYPTED rows.
//
// Auth: isTrustedLoopback(req) — loopback peer AND no proxy headers (same trust model
// as src/internal-router.js, which already returns plaintext secrets over loopback).
// Keys are read from inherited env at startup and NEVER cross the wire.
//
// Two write semantics, preserved exactly from the Python layer being replaced:
//   POST /query, /batch          RAW — run on the raw keyed handle, NO auto-encrypt /
//                                NO auto-decrypt (byte-identical to today's sqlite3;
//                                encrypted columns return raw envelopes, caller
//                                decrypts via crypto_local). @see d1_client.query,
//                                local_db.query/batch.
//   POST /batch_encrypted        ENCRYPTING — run through the adapter (autoEncrypt/
//                                autoDecrypt) so ENCRYPTED_FIELDS columns land as
//                                AES-GCM envelopes. @see local_db.batch_encrypted.
//
// Env: MYCELIUM_DB, USER_MASTER, SYSTEM_KEY (inherited), MYCELIUM_DB_BRIDGE_PORT (8099).
import http from 'node:http';
import { getDb } from '../src/db/index.js';
import { loadKey } from '../src/crypto/keys.js';
import { deriveDbKey } from '../src/account/keystore.js';
import { isTrustedLoopback } from '../src/http/loopback.js';

const HOST = '127.0.0.1';

/** Run a statement on the RAW keyed handle, replicating Python sqlite3 semantics:
 *  a statement that returns rows → list of row objects; otherwise commit (better-
 *  sqlite3 autocommits) and return []. Fail closed on BLOB results (see note). */
function rawRun(rawDb, sql, params) {
  const stmt = rawDb.prepare(sql);
  if (stmt.reader) {
    const rows = stmt.all(...(params || []));
    for (const row of rows) {
      for (const v of Object.values(row)) {
        if (Buffer.isBuffer(v)) {
          throw new Error('vault-bridge: BLOB column in result set is not supported over the bridge (no base64 transport) — the pipeline reads only TEXT envelope columns');
        }
      }
    }
    return rows;
  }
  stmt.run(...(params || []));
  return [];
}

function parts(s) {
  if (s && typeof s === 'object' && !Array.isArray(s)) return [s.sql || '', s.params || []];
  if (Array.isArray(s)) return [s[0], s[1] || []];
  return [String(s), []];
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  let buf = '';
  for await (const chunk of req) buf += chunk;
  return buf ? JSON.parse(buf) : {};
}

async function main() {
  const dbPath = process.env.MYCELIUM_DB;
  const userHex = process.env.USER_MASTER;
  const systemHex = process.env.SYSTEM_KEY;
  const port = Number(process.env.MYCELIUM_DB_BRIDGE_PORT || 8099);
  if (!dbPath) throw new Error('MYCELIUM_DB not set');
  if (!userHex || !systemHex) throw new Error('USER_MASTER and SYSTEM_KEY required');

  // Imported CryptoKeys for the encrypting path; raw hex DB key for the cipher open.
  const [userKey, systemKey] = await Promise.all([loadKey(userHex), loadKey(systemHex)]);
  const dbKeyHex = deriveDbKey(userHex);
  const { db, adapter, close } = getDb({ dbPath, userKey, systemKey, scope: 'personal', dbKeyHex });
  const rawDb = adapter.db; // the keyed better-sqlite3 handle (bypasses auto-crypt)

  const server = http.createServer(async (req, res) => {
    // Fail closed: loopback-only, reject any proxied request.
    if (!isTrustedLoopback(req)) return send(res, 403, { ok: false, error: 'forbidden: loopback only' });
    if (req.method !== 'POST' && req.url !== '/healthz') return send(res, 405, { ok: false, error: 'POST only' });
    try {
      if (req.url === '/healthz') return send(res, 200, { ok: true });
      const payload = await readBody(req);
      if (req.url === '/query') {
        const rows = rawRun(rawDb, payload.sql, payload.params || []);
        return send(res, 200, { ok: true, rows });
      }
      if (req.url === '/batch') {
        const stmts = payload.statements || [];
        const tx = rawDb.transaction((list) => {
          let n = 0;
          for (const s of list) { const [sql, p] = parts(s); if (sql && sql.trim()) { rawDb.prepare(sql).run(...p); n++; } }
          return n;
        });
        return send(res, 200, { ok: true, count: tx(stmts) });
      }
      if (req.url === '/batch_encrypted') {
        const stmts = payload.statements || [];
        let written = 0;
        for (const s of stmts) { if (s && s.sql) { await db.rawQuery(s.sql, s.params || []); written++; } }
        return send(res, 200, { ok: true, written });
      }
      return send(res, 404, { ok: false, error: `unknown route ${req.url}` });
    } catch (err) {
      // Never leak vault data in errors (CLAUDE.md §1) — message only.
      return send(res, 500, { ok: false, error: String(err?.message || err) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, resolve);
  });
  process.stderr.write(`[vault-bridge] listening on ${HOST}:${port}\n`);

  const shutdown = () => { try { server.close(); } finally { try { close(); } catch {} process.exit(0); } };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`[vault-bridge] fatal: ${String(err?.message || err)}\n`);
  process.exit(1);
});
