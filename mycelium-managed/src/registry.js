// registry.js — the handle registry (handle → publicKey, frps token, acme-dns
// subdomain). First-claim-wins keyed by publicKey; the same key may re-provision
// its own handle (rotating the token). This DB is the source of truth that BOTH
// the provision API (writes) and the frps NewProxy auth-hook (reads) consult —
// so reconnections are authorized from a local read, never a live API call.
import Database from 'better-sqlite3';

export function openRegistry(path) {
  const db = new Database(path);
  db.exec(`CREATE TABLE IF NOT EXISTS handles (
     handle         TEXT PRIMARY KEY,
     public_key     TEXT NOT NULL,
     frps_token     TEXT NOT NULL,
     acme_subdomain TEXT NOT NULL,
     created_at     TEXT NOT NULL DEFAULT (datetime('now'))
   )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_handles_pk ON handles(public_key)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_handles_token ON handles(frps_token)');

  return {
    db,
    get(handle) { return db.prepare('SELECT * FROM handles WHERE handle = ?').get(handle); },
    getByToken(token) { return db.prepare('SELECT * FROM handles WHERE frps_token = ?').get(token); },

    /** First-claim-wins by publicKey; same key re-provisions (rotates token). */
    reserve({ handle, publicKey, frpsToken, acmeSubdomain }) {
      const existing = db.prepare('SELECT * FROM handles WHERE handle = ?').get(handle);
      if (existing) {
        if (existing.public_key !== publicKey) return { ok: false, reason: 'taken' };
        db.prepare('UPDATE handles SET frps_token = ?, acme_subdomain = ? WHERE handle = ?')
          .run(frpsToken, acmeSubdomain, handle);
        return { ok: true, reclaimed: true };
      }
      db.prepare('INSERT INTO handles (handle, public_key, frps_token, acme_subdomain) VALUES (?, ?, ?, ?)')
        .run(handle, publicKey, frpsToken, acmeSubdomain);
      return { ok: true, reclaimed: false };
    },

    release({ handle, publicKey }) {
      const ex = db.prepare('SELECT * FROM handles WHERE handle = ?').get(handle);
      if (!ex) return { ok: true };
      if (ex.public_key !== publicKey) return { ok: false, reason: 'not owner' };
      db.prepare('DELETE FROM handles WHERE handle = ?').run(handle);
      return { ok: true };
    },

    close() { db.close(); },
  };
}
