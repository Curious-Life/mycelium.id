// pipeline/local-write-bridge.js — Python→Node encrypted-write bridge (V1 local).
//
// The Python pipeline stages can't run the JS vault encryption, so when they
// need to write an ENCRYPTED_FIELDS column (territory activity_timeline, etc.)
// they shell out to this bridge (via local_db.batch_encrypted). It opens the
// local vault through the canonical encrypting adapter — with IMPORTED HKDF
// CryptoKeys (loadKey), not raw hex, so autoEncryptParams can derive scope DEKs
// — and runs each statement through db.rawQuery, which auto-encrypts the
// encrypted columns. This replaces the old cloud d1-write-bridge.js.
//
// Protocol: reads {"statements":[{"sql":..,"params":[..]}]} on stdin, writes a
// single JSON line {"ok":true,"written":N} (or {"ok":false,"error":..}) on
// stdout. Exit 0 on success, 1 on failure.
//
// Env: MYCELIUM_DB, USER_MASTER, SYSTEM_KEY (inherited from the calling stage).
import { getDb } from '../src/db/index.js';
import { loadKey } from '../src/crypto/keys.js';
import { resolveDbKeyHex } from '../src/db/open.js';

async function main() {
  const dbPath = process.env.MYCELIUM_DB;
  const userHex = process.env.USER_MASTER;
  const systemHex = process.env.SYSTEM_KEY;
  if (!dbPath) throw new Error('MYCELIUM_DB not set');
  if (!userHex || !systemHex) throw new Error('USER_MASTER and SYSTEM_KEY required');

  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { statements } = JSON.parse(input || '{}');
  if (!Array.isArray(statements)) throw new Error('expected { statements: [...] }');

  // Imported CryptoKeys (NOT raw hex) — autoEncryptParams needs HKDF keys.
  const [userKey, systemKey] = await Promise.all([loadKey(userHex), loadKey(systemHex)]);
  // Key the open when the vault is at-rest-encrypted (self-detected) — without this
  // the spawn-per-call fallback opened the cipher file UNKEYED → SQLITE_NOTADB.
  const dbKeyHex = resolveDbKeyHex(userHex, dbPath);
  const { db, close } = getDb({ dbPath, userKey, systemKey, scope: 'personal', dbKeyHex });

  let written = 0;
  try {
    for (const s of statements) {
      if (s && s.sql) { await db.rawQuery(s.sql, s.params || []); written++; }
    }
  } finally {
    close();
  }
  process.stdout.write(`${JSON.stringify({ ok: true, written })}\n`);
}

main().catch((err) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(err?.message || err) })}\n`);
  process.exit(1);
});
