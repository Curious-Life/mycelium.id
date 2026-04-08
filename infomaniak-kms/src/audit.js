/**
 * KMS Audit Log — Append-only SQLite with HMAC chain.
 *
 * Every key operation is logged with a tamper-evident HMAC chain.
 * Each entry's HMAC covers the previous entry's HMAC + current data,
 * creating a linked chain. If any entry is modified or deleted,
 * all subsequent HMACs break.
 */

import Database from 'better-sqlite3';
import { createHmac, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';

const AUDIT_DIR = process.env.KMS_AUDIT_DIR || '/etc/kms/audit';
const AUDIT_KEY_PATH = join(AUDIT_DIR, 'audit.key');
const DB_PATH = join(AUDIT_DIR, 'audit.db');

let db;
let auditKey;
let insertStmt;
let lastHmac = '';

/**
 * Initialize audit log. Creates DB and key if they don't exist.
 */
export function initAudit() {
  // Ensure audit directory exists
  if (!existsSync(AUDIT_DIR)) {
    mkdirSync(AUDIT_DIR, { recursive: true });
  }

  // Generate or load audit HMAC key
  if (!existsSync(AUDIT_KEY_PATH)) {
    const key = randomBytes(32).toString('hex');
    writeFileSync(AUDIT_KEY_PATH, key, { mode: 0o400 });
    console.log('[audit] Generated new audit HMAC key');
  }
  auditKey = readFileSync(AUDIT_KEY_PATH, 'utf-8').trim();

  // Open SQLite database
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL'); // durability over performance for audit

  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      customer_id TEXT,
      action TEXT NOT NULL,
      cert_fingerprint TEXT,
      source_ip TEXT,
      details TEXT,
      hmac TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_customer ON audit_log(customer_id);
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
  `);

  // Load last HMAC for chain continuity
  const lastRow = db.prepare('SELECT hmac FROM audit_log ORDER BY id DESC LIMIT 1').get();
  lastHmac = lastRow?.hmac || '';

  insertStmt = db.prepare(`
    INSERT INTO audit_log (customer_id, action, cert_fingerprint, source_ip, details, hmac)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  console.log(`[audit] Initialized: ${DB_PATH} (${db.prepare('SELECT COUNT(*) as c FROM audit_log').get().c} entries)`);
}

/**
 * Log an audit entry. Synchronous (SQLite write).
 * @param {Object} entry
 * @param {string} entry.customerId
 * @param {string} entry.action — 'unwrap', 'wrap', 'rotate', 'delete', 'error', 'backup', 'restore'
 * @param {string} [entry.certFingerprint]
 * @param {string} [entry.sourceIp]
 * @param {Object} [entry.details] — action-specific data (serialized as JSON)
 */
export function logAudit({ customerId, action, certFingerprint, sourceIp, details }) {
  const detailsJson = details ? JSON.stringify(details) : null;

  // Compute HMAC: chain previous + current data
  const hmacData = `${lastHmac}|${customerId || ''}|${action}|${detailsJson || ''}`;
  const hmac = createHmac('sha256', auditKey).update(hmacData).digest('hex');

  insertStmt.run(customerId || null, action, certFingerprint || null, sourceIp || null, detailsJson, hmac);
  lastHmac = hmac;
}

/**
 * Query audit log with filters.
 * @param {Object} filters
 * @param {string} [filters.customerId]
 * @param {string} [filters.action]
 * @param {string} [filters.since] — ISO timestamp
 * @param {number} [filters.limit] — max entries (default 100)
 * @returns {Array}
 */
export function queryAudit({ customerId, action, since, limit = 100 } = {}) {
  let sql = 'SELECT * FROM audit_log WHERE 1=1';
  const params = [];

  if (customerId) { sql += ' AND customer_id = ?'; params.push(customerId); }
  if (action) { sql += ' AND action = ?'; params.push(action); }
  if (since) { sql += ' AND timestamp >= ?'; params.push(since); }

  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(Math.min(limit, 1000));

  return db.prepare(sql).all(...params);
}

/**
 * Verify HMAC chain integrity. Checks every entry sequentially.
 * @returns {{ valid: boolean, totalEntries: number, brokenAt?: number }}
 */
export function verifyIntegrity() {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id ASC').all();
  let prevHmac = '';

  for (const row of rows) {
    const detailsJson = row.details || '';
    const hmacData = `${prevHmac}|${row.customer_id || ''}|${row.action}|${detailsJson}`;
    const expected = createHmac('sha256', auditKey).update(hmacData).digest('hex');

    if (expected !== row.hmac) {
      return { valid: false, totalEntries: rows.length, brokenAt: row.id };
    }
    prevHmac = row.hmac;
  }

  return { valid: true, totalEntries: rows.length };
}

/**
 * Detect anomalies in recent audit entries.
 * @param {number} windowMinutes — lookback window (default 60)
 * @returns {Array<{ type: string, detail: string }>}
 */
export function detectAnomalies(windowMinutes = 60) {
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const recent = db.prepare(
    'SELECT customer_id, action, COUNT(*) as cnt FROM audit_log WHERE timestamp >= ? GROUP BY customer_id, action'
  ).all(since);

  const anomalies = [];

  for (const row of recent) {
    if (row.action === 'unwrap' && row.cnt > 100) {
      anomalies.push({ type: 'excessive_unwrap', detail: `${row.customer_id}: ${row.cnt} unwraps in ${windowMinutes}min` });
    }
    if (row.action === 'delete') {
      anomalies.push({ type: 'customer_deleted', detail: `${row.customer_id} KEK deleted` });
    }
    if (row.action === 'error' && row.cnt > 10) {
      anomalies.push({ type: 'excessive_errors', detail: `${row.customer_id}: ${row.cnt} errors in ${windowMinutes}min` });
    }
  }

  return anomalies;
}
