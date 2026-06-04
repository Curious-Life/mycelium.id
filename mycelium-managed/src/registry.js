// registry.js — the handle registry (handle → publicKey, frps token, acme-dns
// subdomain) + the per-handle ACTIVE-tunnel slot (run_id + last-seen) used by the
// relay hook to enforce one active tunnel per handle. First-claim-wins keyed by
// publicKey; the same key may re-provision its own handle. Source of truth for
// provisioning (writes) AND the frps Login/NewProxy/CloseProxy/Ping hook (reads).
//
// TOCTOU-safe provisioning: claim() inserts an atomic PLACEHOLDER before any
// external side-effect, finalize() fills the token+subdomain, remove() rolls back.
import Database from 'better-sqlite3';

export function openRegistry(path) {
  const db = new Database(path);
  db.exec(`CREATE TABLE IF NOT EXISTS handles (
     handle         TEXT PRIMARY KEY,
     public_key     TEXT NOT NULL,
     frps_token     TEXT NOT NULL,
     acme_subdomain TEXT NOT NULL,
     active_run_id  TEXT,
     active_at      INTEGER,
     created_at     TEXT NOT NULL DEFAULT (datetime('now'))
   )`);
  // Idempotent migration for DBs created before the active-proxy columns existed.
  for (const col of ['active_run_id TEXT', 'active_at INTEGER']) {
    try { db.exec(`ALTER TABLE handles ADD COLUMN ${col}`); } catch { /* column exists */ }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_handles_pk ON handles(public_key)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_handles_token ON handles(frps_token)');

  return {
    db,
    get(handle) { return db.prepare('SELECT * FROM handles WHERE handle = ?').get(handle); },
    getByToken(token) {
      if (!token) return undefined; // an empty placeholder token is never a credential
      return db.prepare('SELECT * FROM handles WHERE frps_token = ?').get(token);
    },

    claim({ handle, publicKey }) {
      const existing = db.prepare('SELECT * FROM handles WHERE handle = ?').get(handle);
      if (existing) {
        if (existing.public_key !== publicKey) return { ok: false, taken: true };
        return { ok: true, reclaimed: true };
      }
      db.prepare("INSERT INTO handles (handle, public_key, frps_token, acme_subdomain) VALUES (?, ?, '', '')").run(handle, publicKey);
      return { ok: true, reclaimed: false };
    },
    finalize({ handle, frpsToken, acmeSubdomain }) {
      db.prepare('UPDATE handles SET frps_token = ?, acme_subdomain = ? WHERE handle = ?').run(frpsToken, acmeSubdomain, handle);
    },
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

    // ── Active-tunnel slot (single-active-proxy enforcement) ──
    getActiveProxy(handle) {
      const r = db.prepare('SELECT active_run_id, active_at FROM handles WHERE handle = ?').get(handle);
      return r ? { runId: r.active_run_id || null, at: r.active_at || 0 } : { runId: null, at: 0 };
    },
    setActiveProxy(handle, runId, at) {
      db.prepare('UPDATE handles SET active_run_id = ?, active_at = ? WHERE handle = ?').run(runId ?? null, at, handle);
    },
    refreshActiveProxy(handle, runId, at) {
      db.prepare('UPDATE handles SET active_at = ? WHERE handle = ? AND active_run_id = ?').run(at, handle, runId ?? null);
    },
    clearActiveProxyIf(handle, runId) { // compare-and-clear: only the owning run_id frees the slot
      db.prepare('UPDATE handles SET active_run_id = NULL, active_at = NULL WHERE handle = ? AND active_run_id = ?').run(handle, runId ?? null);
    },

    close() { db.close(); },
  };
}
