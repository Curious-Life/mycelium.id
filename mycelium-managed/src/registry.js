// registry.js — the handle registry (handle → publicKey, frps token, acme-dns
// subdomain) + the per-handle ACTIVE-tunnel slot (run_id + last-seen) used by the
// relay hook to enforce one active tunnel per handle. First-claim-wins keyed by
// publicKey; the same key may re-provision its own handle. Source of truth for
// provisioning (writes) AND the frps Login/NewProxy/CloseProxy/Ping hook (reads).
//
// TOCTOU-safe provisioning: claim() inserts an atomic PLACEHOLDER before any
// external side-effect, finalize() fills the token+subdomain, remove() rolls back.
import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export function openRegistry(path) {
  const db = new Database(path);
  // Harden the registry at rest (defense-in-depth, mirrors the Mac auth.db's
  // hardenDbPerms in src/remote/config.js): this DB holds every tenant's live
  // frps_token (a bearer credential) AND the Stripe linkage — SQLite's default
  // 0644 is world-readable. Best-effort: dir 0700, file 0600. A :memory: DB or a
  // path whose dir we can't chmod just no-ops. The operator's 0600 systemd env +
  // full-disk encryption remain the outer layers; this is the floor, not ceiling.
  if (path && path !== ':memory:') {
    try { chmodSync(dirname(path), 0o700); } catch { /* */ }
    try { chmodSync(path, 0o600); } catch { /* */ }
  }
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
  for (const col of ['active_run_id TEXT', 'active_at INTEGER', 'hold_expires_at INTEGER']) {
    try { db.exec(`ALTER TABLE handles ADD COLUMN ${col}`); } catch { /* column exists */ }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_handles_pk ON handles(public_key)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_handles_token ON handles(frps_token)');

  // Entitlement (relay billing) is keyed by PUBLIC KEY — the tenant's stable
  // identity — NOT the handle. A handle is a name the same key can release and
  // re-claim (or rename) without losing a paid subscription; Stripe likewise
  // binds a customer→subscription independent of any DNS name. So entitlement
  // lives in its own table and SURVIVES handle release (release() drops the
  // handles row, never this). NO card/PAN/email here — only the Stripe customer
  // id + a paid-through epoch (the registry still "never sees vault data").
  db.exec(`CREATE TABLE IF NOT EXISTS entitlements (
     public_key         TEXT PRIMARY KEY,
     stripe_customer_id TEXT,
     paid_until         INTEGER,
     updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
   )`);

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
      // Finalizing means the handle is live (has a token) — it's no longer a
      // pending reservation, so clear any hold so the sweeper never touches it.
      db.prepare('UPDATE handles SET frps_token = ?, acme_subdomain = ?, hold_expires_at = NULL WHERE handle = ?').run(frpsToken, acmeSubdomain, handle);
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

    // ── Entitlement (relay billing), keyed by public_key ──────────────────────
    // Upsert the paid-through state for a tenant. Called by the Stripe webhook
    // (O4): checkout/invoice.paid → set paidUntil; payment_failed/cancel → clear.
    setEntitlement({ publicKey, stripeCustomerId = null, paidUntil = null }) {
      if (!publicKey) return { ok: false };
      db.prepare(
        `INSERT INTO entitlements (public_key, stripe_customer_id, paid_until, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(public_key) DO UPDATE SET
           stripe_customer_id = COALESCE(excluded.stripe_customer_id, entitlements.stripe_customer_id),
           paid_until = excluded.paid_until,
           updated_at = datetime('now')`,
      ).run(publicKey, stripeCustomerId, paidUntil);
      return { ok: true };
    },
    getEntitlement(publicKey) {
      if (!publicKey) return undefined;
      return db.prepare('SELECT * FROM entitlements WHERE public_key = ?').get(publicKey);
    },
    // Lapse a subscription: zero the paid-through but KEEP stripe_customer_id so
    // re-subscribe is one click (no new Stripe customer).
    clearEntitlement(publicKey) {
      db.prepare("UPDATE entitlements SET paid_until = 0, updated_at = datetime('now') WHERE public_key = ?").run(publicKey);
    },
    // Is the tunnel for THIS handle currently allowed? Joins the handle's owning
    // public_key → its entitlement. Fail-CLOSED: unknown handle or no entitlement
    // row → false. A grace window (graceMs) absorbs Stripe dunning before drop.
    isEntitled(handle, now = Date.now(), graceMs = 0) {
      const row = db.prepare(
        `SELECT e.paid_until AS paid_until
           FROM handles h JOIN entitlements e ON e.public_key = h.public_key
          WHERE h.handle = ?`,
      ).get(handle);
      if (!row || row.paid_until == null) return false;
      return now < Number(row.paid_until) + graceMs;
    },

    // ── Reservation hold (reserve-then-pay, O5) ───────────────────────────────
    // Mark an unpaid placeholder claim with a sweep deadline. Only a placeholder
    // (no token yet) should carry a hold; finalize() clears it.
    setHold(handle, holdExpiresAt) {
      db.prepare("UPDATE handles SET hold_expires_at = ? WHERE handle = ? AND frps_token = ''").run(holdExpiresAt, handle);
    },
    // Delete expired UNPAID placeholders only (frps_token='' AND hold elapsed).
    // A finalized/live handle has a token and a NULL hold → never swept. Returns
    // the count freed.
    sweepExpiredHolds(now = Date.now()) {
      const info = db.prepare(
        "DELETE FROM handles WHERE frps_token = '' AND hold_expires_at IS NOT NULL AND hold_expires_at < ?",
      ).run(now);
      return info.changes || 0;
    },

    close() { db.close(); },
  };
}
