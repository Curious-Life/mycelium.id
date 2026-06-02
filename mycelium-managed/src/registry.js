// registry.js — the handle registry (handle → publicKey, frps token, acme-dns
// subdomain). First-claim-wins keyed by publicKey; the same key may re-provision
// its own handle. Source of truth for BOTH provisioning (writes) and the frps
// NewProxy auth-hook (reads) — so reconnections are authorized from a local read.
//
// TOCTOU-safe provisioning: `claim()` inserts an atomic PLACEHOLDER row BEFORE any
// external side-effect (acme-dns/DNS), `finalize()` fills in the token+subdomain,
// and `remove()` rolls the placeholder back if provisioning fails. Because claim()
// is synchronous (single-threaded Node), two racers can't both insert — the loser
// sees the existing row and gets `taken` without doing any external work.
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
    // A placeholder (empty frps_token) is NOT a usable tunnel credential: getByToken
    // ignores empty tokens so a half-provisioned row can't authorize a tunnel.
    getByToken(token) {
      if (!token) return undefined;
      return db.prepare('SELECT * FROM handles WHERE frps_token = ?').get(token);
    },

    /** Atomic placeholder reservation. First-claim-wins; same key → reclaim. */
    claim({ handle, publicKey }) {
      const existing = db.prepare('SELECT * FROM handles WHERE handle = ?').get(handle);
      if (existing) {
        if (existing.public_key !== publicKey) return { ok: false, taken: true };
        return { ok: true, reclaimed: true };
      }
      db.prepare("INSERT INTO handles (handle, public_key, frps_token, acme_subdomain) VALUES (?, ?, '', '')")
        .run(handle, publicKey);
      return { ok: true, reclaimed: false };
    },

    /** Fill in the real token + acme subdomain after external provisioning succeeds. */
    finalize({ handle, frpsToken, acmeSubdomain }) {
      db.prepare('UPDATE handles SET frps_token = ?, acme_subdomain = ? WHERE handle = ?')
        .run(frpsToken, acmeSubdomain, handle);
    },

    /** Roll back a placeholder this key owns (used when provisioning fails). */
    remove({ handle, publicKey }) {
      db.prepare('DELETE FROM handles WHERE handle = ? AND public_key = ?').run(handle, publicKey);
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
