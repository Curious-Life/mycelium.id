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
// Auth: TWO independent layers, fail-closed (CLAUDE.md §2, §3).
//   1. isTrustedLoopback(req) — loopback peer AND no proxy headers. Proves SAME HOST.
//   2. X-Bridge-Token — a per-boot random secret. Proves SAME USER. Loopback alone is
//      NOT authentication: on a shared/multi-user Mac (or via any other local uid) a
//      process could POST arbitrary SQL to the DECRYPTED vault. The parent that spawns
//      the bridge mints MYCELIUM_DB_BRIDGE_TOKEN, passes it via inherited env, and the
//      Python client echoes it in the X-Bridge-Token header (checked in constant time).
// Both layers must pass on EVERY route (incl. /healthz). No token configured ⇒ the
// bridge refuses to START; absent/bad header ⇒ 401. Keys + token are read from inherited
// env at startup and NEVER cross the wire (only the token is matched, never echoed).
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
// Env: MYCELIUM_DB, USER_MASTER, SYSTEM_KEY, MYCELIUM_DB_BRIDGE_TOKEN (all inherited,
// all required), MYCELIUM_DB_BRIDGE_PORT (defaults to 8099 for a manual run; the spawner
// passes a random ephemeral port).
import http from 'node:http';
import crypto from 'node:crypto';
import { getDb } from '../src/db/index.js';
import { loadKey } from '../src/crypto/keys.js';
import { deriveDbKey } from '../src/account/keystore.js';
import { isTrustedLoopback } from '../src/http/loopback.js';

const HOST = '127.0.0.1';
const TOKEN_HEADER = 'x-bridge-token';
const EXPECTED_TOKEN = process.env.MYCELIUM_DB_BRIDGE_TOKEN || '';

/** Layer 2 auth: constant-time compare of the per-boot token. Both sides are hashed to
 *  a fixed 32-byte digest first, so there is no length-leak and timingSafeEqual never
 *  throws on unequal-length inputs. Returns false for a missing/empty header. */
function tokenOk(req) {
  const provided = req?.headers?.[TOKEN_HEADER];
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(EXPECTED_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

// Binary transport over JSON: a SQLite BLOB travels as a tagged object
// `{ __b64__: <base64> }`. The tag is applied/stripped at exactly two points —
// params IN (decodeParams) and results OUT (encodeRow) — so raw LE-f32 vector
// columns (Stage A: nomic_embedding, embedding_768, anchor_vector) cross the bridge.
// Normal TEXT/INT/REAL cells are untouched. The inbound check is strict (a plain
// object with ONLY `__b64__:string`) so a real string/number/array param can never
// be mistaken for a blob tag; the outbound only tags actual Buffer cells.
const isBlobTag = (p) =>
  p !== null && typeof p === 'object' && Object.getPrototypeOf(p) === Object.prototype &&
  Object.keys(p).length === 1 && typeof p.__b64__ === 'string';
const decodeParams = (params) =>
  (params || []).map((p) => (isBlobTag(p) ? Buffer.from(p.__b64__, 'base64') : p));
function encodeRow(row) {
  let out = row;
  for (const [k, v] of Object.entries(row)) {
    if (Buffer.isBuffer(v)) { if (out === row) out = { ...row }; out[k] = { __b64__: v.toString('base64') }; }
  }
  return out;
}

/** Run a statement on the RAW keyed handle, replicating Python sqlite3 semantics:
 *  a statement that returns rows → list of row objects; otherwise commit (better-
 *  sqlite3 autocommits) and return []. BLOB params/results cross as `{__b64__}`. */
function rawRun(rawDb, sql, params) {
  const stmt = rawDb.prepare(sql);
  const p = decodeParams(params);
  if (stmt.reader) return stmt.all(...p).map(encodeRow);
  stmt.run(...p);
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
  // Fail closed: never serve the decrypted vault without a per-boot auth token.
  if (EXPECTED_TOKEN.length < 32) {
    throw new Error('MYCELIUM_DB_BRIDGE_TOKEN required (≥32 chars) — the bridge will not serve the decrypted vault without a per-boot auth token');
  }

  // Imported CryptoKeys for the encrypting path; raw hex DB key for the cipher open.
  const [userKey, systemKey] = await Promise.all([loadKey(userHex), loadKey(systemHex)]);
  const dbKeyHex = deriveDbKey(userHex);
  const { db, adapter, close } = getDb({ dbPath, userKey, systemKey, scope: 'personal', dbKeyHex });
  const rawDb = adapter.db; // the keyed better-sqlite3 handle (bypasses auto-crypt)

  const server = http.createServer(async (req, res) => {
    // Fail closed, two layers: same-host (loopback, no proxy hop) AND same-user (token).
    if (!isTrustedLoopback(req)) return send(res, 403, { ok: false, error: 'forbidden: loopback only' });
    if (!tokenOk(req)) return send(res, 401, { ok: false, error: 'unauthorized' });
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
          for (const s of list) { const [sql, p] = parts(s); if (sql && sql.trim()) { rawDb.prepare(sql).run(...decodeParams(p)); n++; } }
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
