// nonce.js — single-use, short-TTL challenge nonces (replay protection). The
// client GETs /v1/challenge, signs action|handle|nonce, and POSTs the claim; the
// nonce is consumed on first use so a captured claim cannot be replayed.
//
// Two backends:
//   - { db } given (production): a `nonces` table in the registry sqlite — so a
//     nonce issued by one control-plane instance is consumable by another sharing
//     the DB (HA), and it survives a restart. Single-use is atomic via
//     `DELETE … RETURNING`.
//   - no db (tests/dev/single-process): bounded in-memory Map + sweep (OOM-safe).
import crypto from 'node:crypto';

export function createNonceStore({ ttlMs = 5 * 60 * 1000, maxSize = 100000, now = () => Date.now(), db = null } = {}) {
  if (db) {
    db.exec('CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_nonces_exp ON nonces(expires_at)');
    const insert = db.prepare('INSERT INTO nonces (nonce, expires_at) VALUES (?, ?)');
    const take = db.prepare('DELETE FROM nonces WHERE nonce = ? RETURNING expires_at'); // atomic single-use
    const purge = db.prepare('DELETE FROM nonces WHERE expires_at < ?');
    return {
      issue() { const n = crypto.randomBytes(18).toString('base64url'); insert.run(n, now() + ttlMs); return n; },
      consume(n) { if (typeof n !== 'string') return false; const row = take.get(n); return !!row && row.expires_at >= now(); },
      sweep() { purge.run(now()); },
      startSweeper(intervalMs = 60000) { const t = setInterval(() => purge.run(now()), intervalMs); if (t && typeof t.unref === 'function') t.unref(); return t; },
      size() { return db.prepare('SELECT COUNT(*) AS n FROM nonces').get().n; },
    };
  }

  const m = new Map(); // nonce → expiresAt
  function sweep() { const t = now(); for (const [k, v] of m) if (v < t) m.delete(k); }
  return {
    issue() {
      if (m.size >= maxSize) sweep();
      if (m.size >= maxSize) { const oldest = m.keys().next().value; if (oldest !== undefined) m.delete(oldest); }
      const n = crypto.randomBytes(18).toString('base64url');
      m.set(n, now() + ttlMs);
      return n;
    },
    consume(n) {
      if (typeof n !== 'string') return false;
      const exp = m.get(n);
      if (exp === undefined) return false;
      m.delete(n);
      return exp >= now();
    },
    sweep,
    startSweeper(intervalMs = 60000) { const t = setInterval(sweep, intervalMs); if (t && typeof t.unref === 'function') t.unref(); return t; },
    size() { return m.size; },
  };
}
