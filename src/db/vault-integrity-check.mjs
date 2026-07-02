// src/db/vault-integrity-check.mjs — standalone, READ-ONLY vault integrity probe.
// (Under src/, not scripts/, so the packaged app bundle — src/ pipeline/ migrations/
//  package.json portal-app/build/ — actually ships it; scripts/ is NOT bundled.)
//
// Runs `PRAGMA quick_check(1)` on the vault and exits 0 (ok) / 1 (corrupt) / 2 (error).
// Kept OUT of the server process on purpose: quick_check reads every page (~24 s on a
// 2 GB vault) and a sync call would stall the event loop / block boot. The boot path
// spawns this DETACHED + throttled (src/db/integrity.js) so the scan runs in the
// background without touching request latency. READ-ONLY — it never writes the vault,
// so it can never itself be the concurrent writer that a byte-copy would tear.
// @see docs/VAULT-CONCURRENCY-FIX-DESIGN-2026-07-01.md.
//
// Env: MYCELIUM_DB (required), USER_MASTER (required for the encrypted canonical vault;
// omitted → plaintext open for fixtures). Prints one JSON line to stdout.
import Database from 'better-sqlite3';

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function main() {
  const dbPath = process.env.MYCELIUM_DB;
  if (!dbPath) { out({ ok: false, error: 'MYCELIUM_DB not set' }); process.exit(2); }

  let dbKeyHex = null;
  const userHex = process.env.USER_MASTER;
  if (userHex) {
    const { deriveDbKey } = await import('../account/keystore.js');
    dbKeyHex = deriveDbKey(userHex);
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    if (dbKeyHex) {
      db.pragma(`cipher='sqlcipher'`);
      db.pragma(`key="x'${dbKeyHex}'"`);
    }
    // Belt-and-suspenders on top of the readonly open: forbid writes at the SQL layer
    // too, so this probe can NEVER be the concurrent writer that a byte-copy would tear.
    // (A readonly WAL open still participates in the standard -shm coordination — that is
    // shared-memory only and never mutates the vault DB file.)
    db.pragma('query_only = true');
    const rows = db.prepare('PRAGMA quick_check(1)').all();
    const result = rows.map((r) => r.quick_check).join('; ');
    const ok = result === 'ok';
    // Never echo any page/row content — only the pragma's own status string.
    out({ ok, result: ok ? 'ok' : result.slice(0, 200) });
    process.exit(ok ? 0 : 1);
  } catch (e) {
    // A keyed-open failure or IO error is NOT a clean "corrupt" verdict — surface as 2.
    out({ ok: false, error: String(e?.message || e).slice(0, 200) });
    process.exit(2);
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

main();
