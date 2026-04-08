/**
 * Cloudflare D1 + Vectorize Backend for DB Abstraction Layer
 *
 * Calls MYA Worker proxy endpoints over HTTP.
 * Primary database backend — all data flows through here.
 *
 * SWISS VAULT: All encryption/decryption happens HERE on the VPS.
 * The Worker never has the master key — it stores and returns ciphertext only.
 * Master key loaded from ENCRYPTION_MASTER_KEY env var (VPS-only).
 *
 * Worker endpoints used:
 *   POST /api/db/query   — execute SQL on D1 (passthrough, no crypto)
 *   POST /api/db/batch   — batch SQL statements (passthrough)
 *   POST /api/vectors/upsert — upsert to Vectorize index
 *   POST /api/vectors/query  — similarity search
 *   POST /api/search/hybrid  — keyword + semantic search
 *
 * Auth: AGENT_TOKEN or MYA_WORKER_SECRET in Authorization header.
 */

import crypto from 'crypto';
import {
  importMasterKeyFromTmpfs,
  getMasterKeyFromBestSource,
  getSystemKeyFromBestSource,
  autoEncryptParams,
  autoDecryptResults,
  inferScope,
  setAuditCallback,
  SYSTEM_KEY_TABLES,
} from './crypto-local.js';

// Scope enforcement — restrict which encryption scopes this agent can decrypt.
// Set AGENT_SCOPES='["personal","org"]' in ecosystem.config.cjs per agent.
// null = no restriction (admin/portal mode).
const ALLOWED_SCOPES = process.env.AGENT_SCOPES
  ? JSON.parse(process.env.AGENT_SCOPES)
  : null;

// Lazy master key — loaded once on first DB call (or refreshed via KMS TTL).
// USER_MASTER_KEY encrypts customer vault data (messages, documents, wealth, etc.)
let _masterKey = null;
let _masterKeyPromise = null;

// Lazy system key — loaded once on first DB call.
// SYSTEM_KEY encrypts operator infrastructure data (the `secrets` table).
// Loaded independently of the master key so the agent can boot and manage
// its infrastructure secrets even before the customer provides their master key.
let _systemKey = null;
let _systemKeyPromise = null;

async function getMasterKey() {
  if (_masterKey) return _masterKey;
  // If a fetch is in progress, wait for it
  if (_masterKeyPromise) {
    const result = await _masterKeyPromise;
    if (result) return result;
    // Previous fetch returned null — clear so we can re-attempt (e.g. after restore)
    _masterKeyPromise = null;
  }

  _masterKeyPromise = (async () => {
    // Best source: KMS (Swiss jurisdiction) → tmpfs → env
    _masterKey = await getMasterKeyFromBestSource();
    if (!_masterKey) {
      console.warn('[db-d1] No USER_MASTER_KEY available (no KMS, no tmpfs, no env) — customer data encryption disabled');
    }
    return _masterKey;
  })();

  return _masterKeyPromise;
}

async function getSystemKey() {
  if (_systemKey) return _systemKey;
  if (_systemKeyPromise) {
    const result = await _systemKeyPromise;
    if (result) return result;
    _systemKeyPromise = null;
  }

  _systemKeyPromise = (async () => {
    _systemKey = await getSystemKeyFromBestSource();
    if (!_systemKey) {
      console.warn('[db-d1] No SYSTEM_KEY available — secrets table encryption disabled');
    }
    return _systemKey;
  })();

  return _systemKeyPromise;
}

/** Force reset the master key cache. Called during key rotation. */
function resetMasterKeyCache() {
  _masterKey = null;
  _masterKeyPromise = null;
}

/** Force reset the system key cache. Called during operator key rotation. */
function resetSystemKeyCache() {
  _systemKey = null;
  _systemKeyPromise = null;
}

/**
 * Extract the target table name from an INSERT/UPDATE/REPLACE statement.
 * Returns lowercase table name or null.
 */
function extractWriteTable(sql) {
  const m = sql.match(/(?:INSERT|UPDATE|REPLACE)\s+(?:OR\s+(?:IGNORE|REPLACE)\s+)?(?:INTO\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/i);
  return m?.[1]?.toLowerCase() || null;
}

/**
 * Determine which key family a given write statement needs.
 *   'system' → operator infrastructure tables (secrets)
 *   'user'   → customer vault tables (everything else in ENCRYPTED_FIELDS)
 *   null     → not an encrypted write
 */
async function keyFamilyForWrite(sql) {
  if (!/^\s*(INSERT|UPDATE|REPLACE)\s/i.test(sql)) return null;
  const table = extractWriteTable(sql);
  if (!table) return null;
  if (SYSTEM_KEY_TABLES.has(table)) return 'system';
  const { ENCRYPTED_FIELDS } = await import('./crypto-local.js');
  if (ENCRYPTED_FIELDS[table]?.length > 0) return 'user';
  return null;
}

// Secrets read lazily at call time — not cached at module level.
// This allows bootstrap-secrets.js to populate process.env before first DB call.

/** Build authorization headers — prefer per-agent token, fall back to legacy shared secret */
function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const agentToken = process.env.AGENT_TOKEN;
  const workerSecret = process.env.MYA_WORKER_SECRET;
  const agentId = process.env.AGENT_ID;
  const tenantId = process.env.MYA_USER_ID;
  if (agentToken) {
    headers['Authorization'] = `Bearer ${agentToken}`;
  } else if (workerSecret) {
    headers['Authorization'] = `Bearer ${workerSecret}`;
    if (agentId) headers['X-Agent-ID'] = agentId;
  }
  // Tenant routing — Worker uses this to select the correct D1 database
  if (tenantId) headers['X-Tenant-ID'] = tenantId;
  return headers;
}

/**
 * Auth headers WITHOUT tenant routing — queries hit the owner's D1 (management data
 * tables: provisioning_jobs, handle_reservations, etc.). Uses AGENT_TOKEN only —
 * the legacy ADMIN_SECRET fallback was removed as part of the two-key separation
 * work because ADMIN_SECRET (operator god-mode) must not exist on customer VPSes.
 *
 * Worker side accepts AGENT_TOKEN for management-table queries because those
 * tables are NOT in the USER_DATA_TABLES safety list in db-proxy.ts.
 */
function ownerHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const agentToken = process.env.AGENT_TOKEN;
  if (agentToken) {
    headers['Authorization'] = `Bearer ${agentToken}`;
  }
  // No X-Tenant-ID — intentionally queries owner's D1
  return headers;
}

/**
 * Tenant-admin headers: same as authHeaders() but kept as a separate function
 * for code clarity. The "admin" semantics live entirely on the VPS side
 * (autoDecryptResults with allowedScopes=null), NOT in the auth header. The
 * Worker doesn't enforce a scope filter — it just runs the SQL.
 *
 * Pre-Option-3 this function used ADMIN_SECRET to bypass the Worker's owner-DB
 * SELECT-without-user_id safety check; that escape hatch was removed because
 * tenant DB queries don't trip the safety check at all (it only runs when
 * !tenantId in db-proxy.ts), so AGENT_TOKEN works fine.
 */
function adminHeaders() {
  return authHeaders();
}

/**
 * Execute a SQL query on D1 via the Worker proxy.
 * Transparent encryption: encrypts params on write, decrypts results on read.
 * Master key stays on VPS — Worker never sees plaintext.
 *
 * @param {string} sql - SQL statement
 * @param {Array} [params] - Bind parameters
 * @returns {Promise<{results: Array, meta: Object}>}
 */
async function d1Query(sql, params = []) {
  const [masterKey, systemKey] = await Promise.all([getMasterKey(), getSystemKey()]);

  // SECURITY: Reject writes to encrypted tables when the required key is missing.
  // Silently storing plaintext would break the Swiss Vault guarantee.
  if (params.length > 0) {
    const family = await keyFamilyForWrite(sql);
    if (family === 'system' && !systemKey) {
      throw new Error(`REFUSE: write to 'secrets' table rejected — no SYSTEM_KEY available on tmpfs. Check /run/mycelium/system.key.`);
    }
    if (family === 'user' && !masterKey) {
      const table = extractWriteTable(sql);
      throw new Error(`REFUSE: write to encrypted table '${table}' rejected — no USER_MASTER_KEY available. Restore key via Settings → Vault Security.`);
    }
  }

  // Auto-encrypt params on write (INSERT/UPDATE) — routes by target table.
  if (params.length > 0) {
    const scope = inferScope({ table: null, agent_id: process.env.AGENT_ID });
    const userId = process.env.MYA_USER_ID || process.env.USER_ID || null;
    sql = await autoEncryptParams(sql, params, scope, masterKey, userId, { systemKey });
  }

  const res = await fetch(`${process.env.MYA_WORKER_URL}/api/db/query`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`D1 query failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();

  // Auto-decrypt results on read (scope-enforced). Pass both keys so that
  // rows from the secrets table (v3 envelopes, kf='system') and rows from
  // customer tables (v1/v2 envelopes) all decrypt correctly.
  if (data.results?.length) {
    data.results = await autoDecryptResults(data.results, masterKey, ALLOWED_SCOPES, { systemKey });
  }

  return data;
}

/**
 * d1Query with admin auth headers. Same encryption/decryption as d1Query
 * but uses ADMIN_SECRET for Worker auth (full-scope access).
 * Admin queries bypass scope enforcement (allowedScopes = null).
 */
async function d1QueryAdmin(sql, params = []) {
  const [masterKey, systemKey] = await Promise.all([getMasterKey(), getSystemKey()]);

  // SECURITY: reject writes to encrypted tables without the required key
  if (params.length > 0) {
    const family = await keyFamilyForWrite(sql);
    if (family === 'system' && !systemKey) {
      throw new Error(`REFUSE: admin write to 'secrets' table rejected — no SYSTEM_KEY available.`);
    }
    if (family === 'user' && !masterKey) {
      const table = extractWriteTable(sql);
      throw new Error(`REFUSE: admin write to encrypted table '${table}' rejected — no USER_MASTER_KEY available.`);
    }
  }

  if (params.length > 0) {
    const scope = inferScope({ table: null, agent_id: process.env.AGENT_ID });
    const userId = process.env.MYA_USER_ID || process.env.USER_ID || null;
    sql = await autoEncryptParams(sql, params, scope, masterKey, userId, { systemKey });
  }

  const res = await fetch(`${process.env.MYA_WORKER_URL}/api/db/query`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`D1 admin query failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();

  // Admin queries: no scope restriction (null = decrypt all scopes)
  if (data.results?.length) {
    data.results = await autoDecryptResults(data.results, masterKey, null, { systemKey });
  }

  return data;
}

/**
 * Execute a batch of SQL statements on D1.
 * @param {Array<{sql: string, params?: Array}>} statements
 * @returns {Promise<Array<{results: Array, meta: Object}>>}
 */
async function d1Batch(statements) {
  const [masterKey, systemKey] = await Promise.all([getMasterKey(), getSystemKey()]);

  // SECURITY: reject writes to encrypted tables without the required key
  for (const stmt of statements) {
    if (!stmt.params?.length) continue;
    const family = await keyFamilyForWrite(stmt.sql);
    if (family === 'system' && !systemKey) {
      throw new Error(`REFUSE: batch write to 'secrets' table rejected — no SYSTEM_KEY available.`);
    }
    if (family === 'user' && !masterKey) {
      const table = extractWriteTable(stmt.sql);
      throw new Error(`REFUSE: batch write to encrypted table '${table}' rejected — no USER_MASTER_KEY available.`);
    }
  }

  // Auto-encrypt params in each statement — routes by target table
  {
    const scope = inferScope({ table: null, agent_id: process.env.AGENT_ID });
    const userId = process.env.MYA_USER_ID || process.env.USER_ID || null;
    for (const stmt of statements) {
      if (stmt.params?.length) {
        stmt.sql = await autoEncryptParams(stmt.sql, stmt.params, scope, masterKey, userId, { systemKey });
      }
    }
  }

  const res = await fetch(`${process.env.MYA_WORKER_URL}/api/db/batch`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ statements }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`D1 batch failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();

  // Auto-decrypt results in each batch response (scope-enforced)
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item.results?.length) {
        item.results = await autoDecryptResults(item.results, masterKey, ALLOWED_SCOPES, { systemKey });
      }
    }
  }

  return data;
}

/**
 * Re-wrap all encrypted records with a new master key.
 * The ciphertext (ct) and IV (iv) stay unchanged — only the wrapped DEK
 * (dk field of each envelope) is replaced. This is the core of master key
 * rotation: O(n) records but cheap per record (~1ms each).
 *
 * @param {CryptoKey} oldMasterKey - current master key (HKDF base)
 * @param {CryptoKey} newMasterKey - new master key (HKDF base)
 * @param {(progress: { table: string, processed: number, total: number, errors: number }) => void} onProgress
 * @returns {Promise<{ tablesProcessed: number, rowsRewrapped: number, errors: number }>}
 */
async function rewrapAllRecords(oldMasterKey, newMasterKey, onProgress = () => {}) {
  const { ENCRYPTED_FIELDS, rewrapEnvelope, isEncrypted } = await import('./crypto-local.js');

  let tablesProcessed = 0;
  let rowsRewrapped = 0;
  let totalErrors = 0;

  for (const [table, fields] of Object.entries(ENCRYPTED_FIELDS)) {
    if (!fields.length) continue;

    // Check table exists
    let tableExists = true;
    try {
      await d1QueryAdmin(`SELECT 1 FROM ${table} LIMIT 0`);
    } catch {
      tableExists = false;
    }
    if (!tableExists) {
      onProgress({ table, processed: 0, total: 0, errors: 0, skipped: true });
      continue;
    }

    // Determine primary key (id or rowid)
    let pkCol = 'id';
    try {
      await d1QueryAdmin(`SELECT id FROM ${table} LIMIT 1`);
    } catch {
      pkCol = 'rowid';
    }

    // Build WHERE clause: at least one encrypted field is non-null
    const whereOr = fields.map(f => `${f} IS NOT NULL`).join(' OR ');

    // Count rows
    let total;
    try {
      const countResult = await d1QueryAdmin(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${whereOr}`);
      total = countResult.results?.[0]?.cnt || 0;
    } catch {
      onProgress({ table, processed: 0, total: 0, errors: 1, skipped: true });
      continue;
    }
    if (total === 0) {
      onProgress({ table, processed: 0, total: 0, errors: 0 });
      continue;
    }

    onProgress({ table, processed: 0, total, errors: 0 });

    let processed = 0, errors = 0, offset = 0;
    const BATCH_SIZE = 100;

    while (true) {
      const selectCols = [pkCol, ...fields].filter((v, i, a) => a.indexOf(v) === i);
      let result;
      try {
        result = await d1QueryAdmin(
          `SELECT ${selectCols.join(', ')} FROM ${table} WHERE ${whereOr} ORDER BY ${pkCol} LIMIT ? OFFSET ?`,
          [BATCH_SIZE, offset]
        );
      } catch (err) {
        errors++;
        break;
      }

      const rows = result.results || [];
      if (rows.length === 0) break;

      for (const row of rows) {
        const updates = [];
        const params = [];

        for (const field of fields) {
          const val = row[field];
          if (val && typeof val === 'string' && isEncrypted(val)) {
            try {
              const newEnvelope = await rewrapEnvelope(val, oldMasterKey, newMasterKey);
              updates.push(`${field} = ?`);
              params.push(newEnvelope);
            } catch (err) {
              errors++;
              if (errors <= 3) console.error(`[rewrap] ${table}.${field} on ${row[pkCol]}: ${err.message}`);
            }
          }
        }

        if (updates.length > 0) {
          try {
            params.push(row[pkCol]);
            await d1QueryAdmin(`UPDATE ${table} SET ${updates.join(', ')} WHERE ${pkCol} = ?`, params);
            processed++;
            rowsRewrapped++;
          } catch (err) {
            errors++;
          }
        }
      }

      offset += rows.length;
      onProgress({ table, processed, total, errors });
    }

    totalErrors += errors;
    tablesProcessed++;
    onProgress({ table, processed, total, errors, complete: true });
  }

  return { tablesProcessed, rowsRewrapped, errors: totalErrors };
}

/**
 * Upsert vectors into a Vectorize index.
 * @param {string} index - 'search' or 'cluster'
 * @param {Array<{id: string, values: number[], metadata: Object}>} vectors
 */
async function vectorUpsert(index, vectors) {
  const res = await fetch(`${process.env.MYA_WORKER_URL}/api/vectors/upsert`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ index, vectors }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Vectorize upsert failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Query Vectorize for similarity search.
 * @param {Object} opts
 * @param {string} opts.index - 'search' (1024D BGE-M3) or 'cluster' (256D Nomic)
 * @param {Array<number>} opts.vector - Query vector
 * @param {number} [opts.topK=5] - Number of results
 * @param {Object} [opts.filter] - Metadata filter
 * @returns {Promise<Array<{id: string, score: number, metadata: Object}>>}
 */
async function vectorQuery(opts) {
  // Vectorize metadata filtering is broken in the Worker proxy — filters return
  // empty even when metadata exists. Workaround: fetch extra results without
  // filter, then filter in JS. Over-fetch 4x to compensate for post-filtering.
  const wantedFilter = opts.filter;
  const topK = wantedFilter ? (opts.topK || 5) * 4 : (opts.topK || 5);
  const queryBody = { index: opts.index, vector: opts.vector, topK };

  const res = await fetch(`${process.env.MYA_WORKER_URL}/api/vectors/query`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(queryBody),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Vectorize query failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  let matches = data.matches || [];

  // Post-filter by metadata if filter was provided
  if (wantedFilter && matches.length) {
    matches = matches.filter(m => {
      if (!m.metadata) return false;
      return Object.entries(wantedFilter).every(([k, v]) => m.metadata[k] === v);
    });
  }

  // Trim back to requested count
  return matches.slice(0, opts.topK || 5);
}

/**
 * Hybrid search: keyword (D1 FTS5) + semantic (Vectorize), merged with RRF.
 * SWISS VAULT: Worker returns ciphertext — decrypt results locally.
 */
async function hybridSearch(opts) {
  const res = await fetch(`${process.env.MYA_WORKER_URL}/api/search/hybrid`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(opts),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Hybrid search failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();

  // Auto-decrypt results locally (Worker no longer decrypts)
  const [masterKey, systemKey] = await Promise.all([getMasterKey(), getSystemKey()]);
  if (data.results?.length) {
    data.results = await autoDecryptResults(data.results, masterKey, null, { systemKey });
  }

  return data;
}

/**
 * Helper: first row or null.
 */
function firstRow(result) {
  return result?.results?.[0] || null;
}

/** Parse health_daily row — convert encrypted string values back to numbers. */
function parseHealthRow(row) {
  if (!row) return null;
  const numFields = [
    'sleep_duration_min', 'sleep_in_bed_min', 'sleep_efficiency',
    'sleep_deep_min', 'sleep_rem_min', 'sleep_core_min', 'sleep_awake_min',
    'hrv_avg', 'hrv_sleep_avg', 'resting_hr',
    'steps', 'active_energy_kcal', 'workout_count', 'workout_minutes',
    'mindful_minutes',
  ];
  const parsed = { ...row };
  for (const f of numFields) {
    if (parsed[f] != null && parsed[f] !== '') parsed[f] = Number(parsed[f]);
    else parsed[f] = null;
  }
  if (parsed.workout_types && typeof parsed.workout_types === 'string') {
    try { parsed.workout_types = JSON.parse(parsed.workout_types); } catch { parsed.workout_types = []; }
  }
  return parsed;
}

/** Compute health summary with averages, trends, and anomalies from decrypted rows. */
function computeHealthSummary(rows, today) {
  if (!rows.length) return { today: null, averages: {}, trends: {}, anomalies: [], days: [] };

  const todayRow = rows.find(r => r.date === today) || rows[rows.length - 1] || null;
  const metrics = ['sleep_duration_min', 'hrv_avg', 'resting_hr', 'steps', 'active_energy_kcal', 'mindful_minutes'];

  // Averages (ignore nulls)
  const averages = {};
  for (const m of metrics) {
    const vals = rows.map(r => r[m]).filter(v => v != null);
    averages[m] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
  }

  // Trends: compare last 3 days vs prior days
  const trends = {};
  for (const m of metrics) {
    const vals = rows.map(r => r[m]).filter(v => v != null);
    if (vals.length < 4) { trends[m] = 'insufficient'; continue; }
    const recent = vals.slice(-3);
    const prior = vals.slice(0, -3);
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const priorAvg = prior.reduce((a, b) => a + b, 0) / prior.length;
    const pctChange = priorAvg ? (recentAvg - priorAvg) / priorAvg : 0;
    if (pctChange > 0.1) trends[m] = 'improving';
    else if (pctChange < -0.1) trends[m] = 'declining';
    else trends[m] = 'stable';
    // Invert for resting_hr (lower is better)
    if (m === 'resting_hr' && trends[m] !== 'stable') {
      trends[m] = trends[m] === 'improving' ? 'declining' : 'improving';
    }
  }

  // Anomalies: >1.5σ from mean
  const anomalies = [];
  for (const m of metrics) {
    const vals = rows.map(r => ({ date: r.date, val: r[m] })).filter(v => v.val != null);
    if (vals.length < 3) continue;
    const mean = vals.reduce((a, b) => a + b.val, 0) / vals.length;
    const std = Math.sqrt(vals.reduce((a, b) => a + (b.val - mean) ** 2, 0) / vals.length);
    if (std === 0) continue;
    for (const v of vals) {
      if (Math.abs(v.val - mean) > 1.5 * std) {
        anomalies.push({ date: v.date, metric: m, value: v.val, baseline: Math.round(mean * 10) / 10 });
      }
    }
  }

  return { today: todayRow, averages, trends, anomalies, days: rows };
}

export { vectorUpsert, rewrapAllRecords, resetMasterKeyCache, resetSystemKeyCache };

export function createD1Backend() {
  if (!process.env.MYA_WORKER_URL || (!process.env.AGENT_TOKEN && !process.env.MYA_WORKER_SECRET)) {
    console.warn('[db-d1] Missing MYA_WORKER_URL or AGENT_TOKEN/MYA_WORKER_SECRET — D1 operations will fail');
  }

  const db = {
    _client: null, // No raw client for D1

    /** Raw D1 query — use sparingly, prefer structured methods */
    async rawQuery(sql, params = []) {
      const result = await d1Query(sql, params);
      return result.results || [];
    },

    /** Raw query through worker db-proxy (auto-decrypts encrypted fields) */
    async rawQueryDecrypted(sql, params = []) {
      const result = await d1QueryAdmin(sql, params);
      return result.results || [];
    },

    /** Query the OWNER's D1 (management tables: provisioning_jobs, waitlist, etc.) */
    async rawQueryOwner(sql, params = []) {
      const res = await fetch(`${process.env.MYA_WORKER_URL}/api/db/query`, {
        method: 'POST',
        headers: ownerHeaders(),
        body: JSON.stringify({ sql, params }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Owner D1 query failed (${res.status}): ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      return data.results || [];
    },

    /** Shorthand for d1Query (used internally) */
    d1Query,
    d1QueryAdmin,

    // ── Messages ────────────────────────────────────────────────────────────

    messages: {
      async insert(rows) {
        const arr = Array.isArray(rows) ? rows : [rows];
        const placeholders = arr.map(() =>
          `(${Object.keys(arr[0]).map(() => '?').join(', ')})`
        ).join(', ');
        const cols = Object.keys(arr[0]).join(', ');
        const params = arr.flatMap(r => Object.values(r));

        const result = await d1Query(
          `INSERT INTO messages (${cols}) VALUES ${placeholders} RETURNING id`,
          params,
        );
        return result.results || [];
      },

      /** INSERT OR IGNORE — skips rows with duplicate IDs. Returns inserted rows. */
      async insertIgnore(rows) {
        const arr = Array.isArray(rows) ? rows : [rows];
        if (arr.length === 0) return [];
        // D1 has a ~100 parameter limit per query. With ~8 cols per row, batch ~10 rows at a time.
        const cols = Object.keys(arr[0]);
        const colNames = cols.join(', ');
        const allInserted = [];
        const ROWS_PER_STMT = Math.max(1, Math.floor(95 / cols.length));
        // Build individual statements, then send in d1Batch groups of 50 statements
        const statements = [];
        for (let i = 0; i < arr.length; i += ROWS_PER_STMT) {
          const batch = arr.slice(i, i + ROWS_PER_STMT);
          const placeholders = batch.map(() =>
            `(${cols.map(() => '?').join(', ')})`
          ).join(', ');
          const params = batch.flatMap(r => cols.map(c => r[c]));
          statements.push({
            sql: `INSERT OR IGNORE INTO messages (${colNames}) VALUES ${placeholders}`,
            params,
          });
        }
        // d1Batch sends multiple statements in one HTTP round-trip
        const BATCH_SIZE = 50;
        for (let i = 0; i < statements.length; i += BATCH_SIZE) {
          const stmtBatch = statements.slice(i, i + BATCH_SIZE);
          try {
            const results = await d1Batch(stmtBatch);
            for (const r of results) {
              allInserted.push(...(r.results || []));
            }
          } catch (err) {
            // Fallback: execute one-by-one
            for (const stmt of stmtBatch) {
              try {
                const r = await d1Query(stmt.sql, stmt.params);
                allInserted.push(...(r.results || []));
              } catch { /* skip duplicates */ }
            }
          }
        }
        return allInserted;
      },

      /** Check which message IDs already exist. Returns Set of existing IDs. */
      async getExistingIds(userId, ids) {
        const existing = new Set();
        // D1 has ~100 param limit; 1 for userId + up to 90 IDs per batch
        for (let i = 0; i < ids.length; i += 90) {
          const batch = ids.slice(i, i + 90);
          const placeholders = batch.map(() => '?').join(', ');
          const result = await d1Query(
            `SELECT id FROM messages WHERE user_id = ? AND id IN (${placeholders})`,
            [userId, ...batch],
          );
          for (const row of result.results || []) {
            existing.add(row.id);
          }
        }
        return existing;
      },

      /**
       * Get all conversation_ids already imported for a given source (e.g. 'linkedin').
       * Used for dedup: if a conversation_id exists, skip the whole thread.
       */
      async getExistingConversationIds(userId, source) {
        const result = await d1Query(
          `SELECT DISTINCT conversation_id FROM messages WHERE user_id = ? AND source = ? AND conversation_id IS NOT NULL`,
          [userId, source],
        );
        return new Set((result.results || []).map(r => r.conversation_id));
      },

      async selectRecent(userId, { limit = 10, agentId, since, scope } = {}) {
        let sql = `SELECT id, content, role, source, agent_id, attachment_id, tags, entities, scope, created_at FROM messages WHERE user_id = ?`;
        const params = [userId];
        if (agentId) {
          // personal-agent has a legacy ID (mya-personal) — include both
          if (agentId === 'personal-agent') {
            sql += ` AND agent_id IN ('personal-agent', 'mya-personal')`;
          } else {
            sql += ` AND agent_id = ?`;
            params.push(agentId);
          }
        }
        if (scope) {
          // Scope filtering: 'personal' sees personal+org, 'org' sees org only, 'all' sees everything
          if (scope === 'personal') {
            sql += ` AND scope IN ('personal', 'org')`;
          } else if (scope === 'wealth') {
            sql += ` AND scope IN ('wealth', 'org')`;
          } else if (scope !== 'all') {
            sql += ` AND scope = ?`;
            params.push(scope);
          }
        }
        if (since) {
          sql += ` AND created_at >= ?`;
          params.push(since);
        }
        sql += ` ORDER BY created_at DESC LIMIT ?`;
        params.push(limit);
        const result = await d1Query(sql, params);
        return result.results || [];
      },

      async selectPaginated(userId, { since, until, offset = 0, limit = 30, channel, agentId, excludeAgentId } = {}) {
        let where = `WHERE user_id = ?`;
        const params = [userId];
        if (since) { where += ` AND created_at >= ?`; params.push(since); }
        if (until) { where += ` AND created_at < ?`; params.push(until); }
        if (channel) { where += ` AND source LIKE ?`; params.push(`${channel}%`); }
        if (agentId) { where += ` AND agent_id = ?`; params.push(agentId); }
        if (excludeAgentId) {
          const ids = Array.isArray(excludeAgentId) ? excludeAgentId : [excludeAgentId];
          const placeholders = ids.map(() => '?').join(', ');
          where += ` AND (agent_id NOT IN (${placeholders}) OR agent_id IS NULL)`;
          params.push(...ids);
        }

        const countResult = await d1Query(
          `SELECT COUNT(*) as count FROM messages ${where}`, params
        );
        const total = countResult.results?.[0]?.count || 0;

        const dataResult = await d1Query(
          `SELECT content, role, source, agent_id, created_at FROM messages ${where} ORDER BY created_at ASC LIMIT ? OFFSET ?`,
          [...params, limit, offset]
        );

        return {
          messages: dataResult.results || [],
          total,
          offset,
          limit,
          hasMore: offset + limit < total,
        };
      },

      async selectByAgent(agentId, { offset = 0, limit = 50 } = {}) {
        const userId = process.env.MYA_USER_ID;
        const countResult = await d1Query(
          `SELECT COUNT(*) as count FROM messages WHERE agent_id = ? AND user_id = ?`,
          [agentId, userId],
        );
        const count = countResult.results?.[0]?.count || 0;

        const result = await d1Query(
          `SELECT id, role, content, created_at, metadata FROM messages WHERE agent_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          [agentId, userId, limit, offset],
        );
        return { data: result.results || [], count };
      },

      async selectTimeline(userId, { limit = 50, before, afterId } = {}) {
        let sql = `SELECT id, role, content, source, agent_id, created_at, message_type, attachment_id FROM messages WHERE user_id = ?`;
        const params = [userId];
        if (before) {
          sql += ` AND created_at < ?`;
          params.push(before);
        }
        if (afterId) {
          sql += ` AND rowid < (SELECT rowid FROM messages WHERE id = ?)`;
          params.push(afterId);
        }
        sql += ` ORDER BY created_at DESC LIMIT ?`;
        params.push(limit);
        const result = await d1Query(sql, params);
        return result.results || [];
      },

      async countByUser(userId) {
        const result = await d1Query(`SELECT COUNT(*) as count FROM messages WHERE user_id = ?`, [userId]);
        return firstRow(result)?.count || 0;
      },

      async selectAll(userId, { limit = 500, offset = 0 } = {}) {
        const result = await d1Query(
          `SELECT id, role, content, source, agent_id, created_at, message_type, attachment_id FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          [userId, limit, offset],
        );
        return result.results || [];
      },

      async listAgentIds() {
        const userId = process.env.MYA_USER_ID;
        const result = await d1Query(
          `SELECT DISTINCT agent_id FROM messages WHERE agent_id IS NOT NULL AND user_id = ?`,
          [userId],
        );
        return (result.results || []).map(r => r.agent_id);
      },

      async hybridSearch({ agentId, query, embedding, after, before, limit = 10 }) {
        const data = await hybridSearch({
          agentId,
          query,
          embedding,
          after: after || null,
          before: before || null,
          limit,
        });
        return data.results || data;
      },

      async matchMessages(embedding, userId, count = 5) {
        const matches = await vectorQuery({
          index: 'search',
          vector: embedding,
          topK: count,
          filter: { type: 'message', userId },
        });

        if (!matches.length) return [];

        // Fetch full rows from D1
        const ids = matches.map(m => m.id);
        const placeholders = ids.map(() => '?').join(', ');
        const result = await d1Query(
          `SELECT id, content, role, source, agent_id, created_at, entity_summary FROM messages WHERE id IN (${placeholders})`,
          ids,
        );

        // Merge scores and sort
        const scoreMap = new Map(matches.map(m => [m.id, m.score]));
        return (result.results || [])
          .map(row => ({ ...row, similarity: scoreMap.get(row.id) || 0 }))
          .sort((a, b) => b.similarity - a.similarity);
      },

      async matchDocuments(embedding, userId, count = 5, includeInternal = false) {
        const filter = { type: 'document', userId };
        const matches = await vectorQuery({
          index: 'search',
          vector: embedding,
          topK: count,
          filter,
        });

        if (!matches.length) return [];

        const ids = matches.map(m => m.id);
        const placeholders = ids.map(() => '?').join(', ');
        let sql = `SELECT id, path, title, summary, content FROM documents WHERE id IN (${placeholders})`;
        if (!includeInternal) sql += ` AND is_internal = 0`;
        const result = await d1Query(sql, ids);

        const scoreMap = new Map(matches.map(m => [m.id, m.score]));
        return (result.results || [])
          .map(row => ({ ...row, similarity: scoreMap.get(row.id) || 0 }))
          .sort((a, b) => b.similarity - a.similarity);
      },
    },

    // ── Events ──────────────────────────────────────────────────────────────

    events: {
      insert(event) {
        // Fire-and-forget — don't await, don't throw
        const cols = Object.keys(event).join(', ');
        const placeholders = Object.keys(event).map(() => '?').join(', ');
        d1Query(
          `INSERT INTO agent_events (${cols}) VALUES (${placeholders})`,
          Object.values(event),
        ).catch(() => {});
      },
    },

    // ── Agent Tasks ─────────────────────────────────────────────────────────

    agentTasks: {
      async create(task) {
        const cols = Object.keys(task).join(', ');
        const placeholders = Object.keys(task).map(() => '?').join(', ');
        const result = await d1Query(
          `INSERT INTO agent_tasks (${cols}) VALUES (${placeholders}) RETURNING id`,
          Object.values(task),
        );
        return firstRow(result);
      },

      async getPending(agentId, limit = 10) {
        const result = await d1Query(
          `SELECT * FROM agent_tasks WHERE agent_id = ? AND status = 'pending' ORDER BY priority DESC, created_at ASC LIMIT ?`,
          [agentId, limit],
        );
        return result.results || [];
      },

      async getInProgress(agentId) {
        const result = await d1Query(
          `SELECT * FROM agent_tasks WHERE agent_id = ? AND status = 'in_progress'`,
          [agentId],
        );
        return result.results || [];
      },

      async start(taskId) {
        await d1Query(
          `UPDATE agent_tasks SET status = 'in_progress', started_at = ? WHERE id = ?`,
          [new Date().toISOString(), taskId],
        );
      },

      async complete(taskId, result, summary) {
        await d1Query(
          `UPDATE agent_tasks SET status = 'completed', completed_at = ?, result = ?, summary = ? WHERE id = ?`,
          [new Date().toISOString(), result, summary, taskId],
        );
      },

      async fail(taskId, errorMessage) {
        await d1Query(
          `UPDATE agent_tasks SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`,
          [new Date().toISOString(), errorMessage, taskId],
        );
      },

      async getToReport(agentId) {
        const result = await d1Query(
          `SELECT * FROM agent_tasks WHERE agent_id = ? AND status = 'completed' AND reported_at IS NULL`,
          [agentId],
        );
        return result.results || [];
      },

      async markReported(taskId) {
        await d1Query(
          `UPDATE agent_tasks SET reported_at = ? WHERE id = ?`,
          [new Date().toISOString(), taskId],
        );
      },
    },

    // ── Attachments ─────────────────────────────────────────────────────────

    attachments: {
      async insert(record) {
        const cols = Object.keys(record).join(', ');
        const placeholders = Object.keys(record).map(() => '?').join(', ');
        const result = await d1Query(
          `INSERT INTO attachments (${cols}) VALUES (${placeholders}) RETURNING id`,
          Object.values(record),
        );
        return firstRow(result);
      },

      async getById(id) {
        const result = await d1Query(
          `SELECT id, user_id, r2_key, stream_uid, file_name, file_type, file_size, transcript, description, created_at FROM attachments WHERE id = ?`,
          [id],
        );
        return firstRow(result);
      },

      async getByIds(ids) {
        if (!ids.length) return [];
        const placeholders = ids.map(() => '?').join(', ');
        const result = await d1Query(
          `SELECT id, r2_key, stream_uid, file_name, file_type, file_size, transcript, description FROM attachments WHERE id IN (${placeholders})`,
          ids,
        );
        return result.results || [];
      },

      async listByUser(userId, { type, search, limit = 50, offset = 0, onlyTypes } = {}) {
        const conditions = ['user_id = ?'];
        const params = [userId];
        if (type) {
          // 'file' filter matches text, pdf, document, and file types
          if (type === 'file') {
            conditions.push("file_type IN ('file', 'text', 'pdf', 'document')");
          } else {
            conditions.push('file_type = ?');
            params.push(type);
          }
        }
        if (onlyTypes && onlyTypes.length > 0) {
          conditions.push(`file_type IN (${onlyTypes.map(() => '?').join(', ')})`);
          params.push(...onlyTypes);
        }
        if (search) {
          conditions.push('(file_name LIKE ? OR description LIKE ?)');
          params.push(`%${search}%`, `%${search}%`);
        }
        const where = conditions.join(' AND ');
        params.push(limit, offset);
        const result = await d1Query(
          `SELECT id, user_id, r2_key, stream_uid, file_name, file_type, file_size, transcript, description, metadata, created_at FROM attachments WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          params,
        );
        return result.results || [];
      },

      async countByUser(userId, { type, search, onlyTypes } = {}) {
        const conditions = ['user_id = ?'];
        const params = [userId];
        if (type) {
          if (type === 'file') {
            conditions.push("file_type IN ('file', 'text', 'pdf', 'document')");
          } else {
            conditions.push('file_type = ?');
            params.push(type);
          }
        }
        if (onlyTypes && onlyTypes.length > 0) {
          conditions.push(`file_type IN (${onlyTypes.map(() => '?').join(', ')})`);
          params.push(...onlyTypes);
        }
        if (search) {
          conditions.push('(file_name LIKE ? OR description LIKE ?)');
          params.push(`%${search}%`, `%${search}%`);
        }
        const where = conditions.join(' AND ');
        const result = await d1Query(
          `SELECT COUNT(*) as count FROM attachments WHERE ${where}`,
          params,
        );
        return firstRow(result)?.count || 0;
      },

      async update(id, fields) {
        const keys = Object.keys(fields);
        if (!keys.length) return;
        const sets = keys.map(k => `${k} = ?`).join(', ');
        await d1Query(
          `UPDATE attachments SET ${sets} WHERE id = ?`,
          [...Object.values(fields), id],
        );
      },

      async delete(id, userId) {
        await d1Query(
          `DELETE FROM attachments WHERE id = ? AND user_id = ?`,
          [id, userId],
        );
      },
    },

    // ── Users ───────────────────────────────────────────────────────────────

    users: {
      async count() {
        const result = await d1Query(`SELECT COUNT(*) as count FROM users`);
        return firstRow(result)?.count || 0;
      },

      async create(id, displayName) {
        await d1Query(
          `INSERT INTO users (id, display_name) VALUES (?, ?)`,
          [id, displayName],
        );
      },

      async getTimezone(userId) {
        const result = await d1Query(
          `SELECT timezone FROM users WHERE id = ?`,
          [userId],
        );
        return firstRow(result)?.timezone || null;
      },

      async updateTimezone(userId, timezone) {
        await d1Query(
          `UPDATE users SET timezone = ? WHERE id = ?`,
          [timezone, userId],
        );
      },

      async updateSettings(userId, settings) {
        await d1Query(
          `UPDATE users SET settings = ? WHERE id = ?`,
          [JSON.stringify(settings), userId],
        );
      },

      async getSettings(userId) {
        const result = await d1Query(
          `SELECT settings FROM users WHERE id = ?`,
          [userId],
        );
        const raw = firstRow(result)?.settings;
        return raw ? JSON.parse(raw) : {};
      },

      /** Get the first (primary) user — for single-user app token auth. */
      async getFirst() {
        const result = await d1Query(
          `SELECT id, display_name, timezone, settings FROM users LIMIT 1`,
        );
        return firstRow(result);
      },
    },

    // ── User Identities ─────────────────────────────────────────────────────

    userIdentities: {
      async lookupByDiscord(discordUserId) {
        const result = await d1Query(
          `SELECT user_id FROM user_identities WHERE provider = 'discord' AND provider_id = ?`,
          [discordUserId],
        );
        return firstRow(result)?.user_id || null;
      },

      async list(userId) {
        const result = await d1Query(
          `SELECT id, provider, provider_username, provider_avatar, verified_at, created_at FROM user_identities WHERE user_id = ?`,
          [userId],
        );
        return result.results || [];
      },

      async unlink(userId, provider) {
        await d1Query(
          `DELETE FROM user_identities WHERE user_id = ? AND provider = ?`,
          [userId, provider],
        );
      },

      async link(params) {
        // Replicate the link_user_identity RPC logic as an upsert
        await d1Query(
          `INSERT INTO user_identities (user_id, provider, provider_id, provider_username, provider_avatar, verified_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, provider) DO UPDATE SET
             provider_id = excluded.provider_id,
             provider_username = excluded.provider_username,
             provider_avatar = excluded.provider_avatar,
             verified_at = excluded.verified_at`,
          [
            params.p_user_id,
            params.p_provider,
            params.p_provider_id,
            params.p_provider_username || null,
            params.p_provider_avatar || null,
            new Date().toISOString(),
          ],
        );
        return true;
      },
    },

    // ── Sessions ────────────────────────────────────────────────────────────

    sessions: {
      async getByToken(token) {
        const result = await d1Query(
          `SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?`,
          [token, new Date().toISOString()],
        );
        return firstRow(result)?.user_id || null;
      },

      async create(token, userId, expiresAt) {
        await d1Query(
          `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
          [token, userId, expiresAt],
        );
      },

      async delete(token) {
        await d1Query(`DELETE FROM sessions WHERE token = ?`, [token]);
      },

      async getUserByToken(token) {
        const result = await d1Query(
          `SELECT s.user_id, u.display_name, u.timezone, u.settings
           FROM sessions s JOIN users u ON s.user_id = u.id
           WHERE s.token = ? AND s.expires_at > ?`,
          [token, new Date().toISOString()],
        );
        return firstRow(result);
      },
    },

    // ── Passkey Credentials ───────────────────────────────────────────────

    passkeys: {
      async listByUser(userId) {
        const result = await d1Query(
          `SELECT credential_id, public_key, counter, prf_salt FROM passkey_credentials WHERE user_id = ?`,
          [userId],
        );
        return result.results || [];
      },

      async getByCredentialId(credentialId) {
        const result = await d1Query(
          `SELECT * FROM passkey_credentials WHERE credential_id = ?`,
          [credentialId],
        );
        return firstRow(result);
      },

      async create(userId, credentialId, publicKey, counter, prfSalt = null) {
        await d1Query(
          `INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, prf_salt) VALUES (?, ?, ?, ?, ?)`,
          [userId, credentialId, publicKey, counter, prfSalt],
        );
      },

      async updateCounter(credentialId, counter) {
        await d1Query(
          `UPDATE passkey_credentials SET counter = ? WHERE credential_id = ?`,
          [counter, credentialId],
        );
      },
    },

    // ── Registration Tokens ───────────────────────────────────────────────

    registrationTokens: {
      async create(code, userId) {
        await d1Query(
          `INSERT INTO registration_tokens (code, created_by) VALUES (?, ?)`,
          [code, userId],
        );
      },

      async validate(code) {
        const result = await d1Query(
          `SELECT created_by as user_id FROM registration_tokens WHERE code = ? AND used_by IS NULL`,
          [code],
        );
        return firstRow(result);
      },

      async delete(code) {
        await d1Query(`DELETE FROM registration_tokens WHERE code = ?`, [code]);
      },
    },

    // ── OAuth States ────────────────────────────────────────────────────────

    oauthStates: {
      async insert(state) {
        const cols = Object.keys(state).join(', ');
        const placeholders = Object.keys(state).map(() => '?').join(', ');
        await d1Query(
          `INSERT INTO oauth_states (${cols}) VALUES (${placeholders})`,
          Object.values(state),
        );
      },

      async validate(state, provider) {
        const result = await d1Query(
          `SELECT user_id, redirect_url FROM oauth_states WHERE state = ? AND provider = ? AND expires_at > ?`,
          [state, provider, new Date().toISOString()],
        );
        return firstRow(result);
      },

      async delete(state) {
        await d1Query(
          `DELETE FROM oauth_states WHERE state = ?`,
          [state],
        );
      },
    },

    // ── Documents ───────────────────────────────────────────────────────────

    documents: {
      async get(userId, path) {
        const result = await d1Query(
          `SELECT * FROM documents WHERE user_id = ? AND path = ?`,
          [userId, path],
        );
        return firstRow(result);
      },

      async upsert(doc) {
        const cols = Object.keys(doc).join(', ');
        const placeholders = Object.keys(doc).map(() => '?').join(', ');
        // Build SET clause for ON CONFLICT (exclude user_id and path)
        const updateCols = Object.keys(doc).filter(c => c !== 'user_id' && c !== 'path');
        const setClause = updateCols.map(c => `${c} = excluded.${c}`).join(', ');

        const result = await d1Query(
          `INSERT INTO documents (${cols}) VALUES (${placeholders})
           ON CONFLICT (user_id, path) DO UPDATE SET ${setClause}
           RETURNING *`,
          Object.values(doc),
        );
        return firstRow(result);
      },

      async list(userId, { category, folderId, pinnedOnly, internalOnly = false } = {}) {
        let sql = `SELECT path, title, summary, folder_id, is_pinned AS pinned, source_type, created_by, updated_at FROM documents WHERE user_id = ? AND is_internal = ?`;
        const params = [userId, internalOnly ? 1 : 0];
        if (category) {
          sql += ` AND path LIKE ?`;
          params.push(`${category}/%`);
        }
        if (folderId) {
          sql += ` AND folder_id = ?`;
          params.push(folderId);
        }
        if (pinnedOnly) {
          sql += ` AND is_pinned = 1`;
        }
        sql += ` ORDER BY updated_at DESC`;
        const result = await d1Query(sql, params);
        return result.results || [];
      },

      async pin(userId, path) {
        await d1Query(
          `UPDATE documents SET is_pinned = 1 WHERE user_id = ? AND path = ?`,
          [userId, path],
        );
      },

      async unpin(userId, path) {
        await d1Query(
          `UPDATE documents SET is_pinned = 0 WHERE user_id = ? AND path = ?`,
          [userId, path],
        );
      },

      async moveToFolder(userId, path, folderId) {
        await d1Query(
          `UPDATE documents SET folder_id = ? WHERE user_id = ? AND path = ?`,
          [folderId, userId, path],
        );
      },

      async delete(userId, path) {
        await d1Query(
          `DELETE FROM documents WHERE user_id = ? AND path = ?`,
          [userId, path],
        );
      },
    },

    // ── Tasks (user tasks) ──────────────────────────────────────────────────

    tasks: {
      async create(task) {
        const cols = Object.keys(task).join(', ');
        const placeholders = Object.keys(task).map(() => '?').join(', ');
        const result = await d1Query(
          `INSERT INTO tasks (${cols}) VALUES (${placeholders}) RETURNING *`,
          Object.values(task),
        );
        return firstRow(result);
      },
    },

    // ── Folders ─────────────────────────────────────────────────────────────

    folders: {
      async list(userId) {
        const result = await d1Query(
          `SELECT id, name, parent_id, description, document_count FROM folders WHERE user_id = ? ORDER BY name`,
          [userId],
        );
        return result.results || [];
      },

      async create(userId, name, parentId = null) {
        const id = crypto.randomUUID();
        await d1Query(
          `INSERT INTO folders (id, user_id, name, parent_id) VALUES (?, ?, ?, ?)`,
          [id, userId, name, parentId],
        );
        return { id, name, parent_id: parentId };
      },

      async rename(userId, folderId, name) {
        await d1Query(
          `UPDATE folders SET name = ? WHERE id = ? AND user_id = ?`,
          [name, folderId, userId],
        );
      },

      async delete(userId, folderId) {
        // Move documents in this folder to no folder
        await d1Query(
          `UPDATE documents SET folder_id = NULL WHERE folder_id = ? AND user_id = ?`,
          [folderId, userId],
        );
        // Move child folders to parent of deleted folder
        const folder = await d1Query(
          `SELECT parent_id FROM folders WHERE id = ? AND user_id = ?`,
          [folderId, userId],
        );
        const parentId = folder.results?.[0]?.parent_id || null;
        await d1Query(
          `UPDATE folders SET parent_id = ? WHERE parent_id = ? AND user_id = ?`,
          [parentId, folderId, userId],
        );
        await d1Query(
          `DELETE FROM folders WHERE id = ? AND user_id = ?`,
          [folderId, userId],
        );
      },
    },

    // ── Canvases ────────────────────────────────────────────────────────────

    canvases: {
      async list(userId) {
        const result = await d1Query(
          `SELECT name, description FROM canvas_workspaces WHERE user_id = ? ORDER BY name`,
          [userId],
        );
        return result.results || [];
      },

      async addDocument(userId, canvasName, documentPath) {
        // Look up workspace ID first
        const ws = await d1Query(
          `SELECT id FROM canvas_workspaces WHERE user_id = ? AND name = ?`,
          [userId, canvasName],
        );
        const workspaceId = firstRow(ws)?.id;
        if (!workspaceId) throw new Error(`Canvas "${canvasName}" not found`);

        // Look up document ID
        const doc = await d1Query(
          `SELECT id FROM documents WHERE user_id = ? AND path = ?`,
          [userId, documentPath],
        );
        const docId = firstRow(doc)?.id;
        if (!docId) throw new Error(`Document "${documentPath}" not found`);

        await d1Query(
          `INSERT INTO canvas_nodes (workspace_id, user_id, node_type, ref_id, position_x, position_y, width, height, created_at)
           VALUES (?, ?, 'document', ?, 0, 0, 300, 200, ?)`,
          [workspaceId, userId, docId, new Date().toISOString()],
        );
      },
    },

    // ── Mindscape (direct D1 queries for visualization) ────────────────────

    mindscape: {
      /** Fetch all clustering points with 3D coordinates for a user */
      async getPoints(userId, limit = 100000) {
        const result = await d1Query(
          `SELECT id, source_id, atom_id, territory_id, theme_id, realm_id,
                  landscape_x, landscape_y, landscape_z, source_type, created_at
           FROM clustering_points
           WHERE user_id = ? AND landscape_x IS NOT NULL
           ORDER BY created_at DESC
           LIMIT ?`,
          [userId, limit],
        );
        return result.results || [];
      },

      /** Noise/unclustered point stats */
      async getNoiseStats(userId) {
        const result = await d1Query(
          `SELECT
             COUNT(*) as total,
             SUM(CASE WHEN territory_id IS NULL OR territory_id = -1 THEN 1 ELSE 0 END) as noise
           FROM clustering_points
           WHERE user_id = ? AND landscape_x IS NOT NULL`,
          [userId],
        );
        const row = (result.results || [])[0] || { total: 0, noise: 0 };
        return {
          total: row.total || 0,
          noise: row.noise || 0,
          noisePct: row.total > 0 ? ((row.noise / row.total) * 100).toFixed(1) : '0',
        };
      },

      /** Fetch all theme cards for a user */
      async getThemeCards(userId) {
        const result = await d1Query(
          `SELECT theme_id, territory_id, title, essence, message_count,
                  explored_count, explored_percent, top_entities,
                  story_birth, story_arc, story_peak_moments, story_current_chapter,
                  uncertainty_open_questions, uncertainty_edges
           FROM theme_cards WHERE user_id = ?`,
          [userId],
        );
        return (result.results || []).map(row => ({
          ...row,
          top_entities: parseJson(row.top_entities),
          uncertainty_open_questions: parseJson(row.uncertainty_open_questions),
        }));
      },

      /** Fetch all territory profiles for a user */
      async getTerritoryProfiles(userId) {
        const result = await d1Query(
          `SELECT territory_id, realm_id, semantic_theme_id, name, essence,
                  archetype_type, archetype_character,
                  message_count, explored_count, explored_percent,
                  top_entities, signature_patterns,
                  story_birth, story_arc, story_peak_moments, story_current_chapter,
                  uncertainty_open_questions, uncertainty_edges,
                  agent_expertise, agent_curious_about, agent_can_help_with, agent_would_consult,
                  visibility
           FROM territory_profiles WHERE user_id = ?`,
          [userId],
        );
        return (result.results || []).map(row => ({
          ...row,
          top_entities: parseJson(row.top_entities),
          signature_patterns: parseJson(row.signature_patterns),
          story_peak_moments: parseJson(row.story_peak_moments),
          uncertainty_open_questions: parseJson(row.uncertainty_open_questions),
          agent_can_help_with: parseJson(row.agent_can_help_with),
          agent_would_consult: parseJson(row.agent_would_consult),
        }));
      },

      /** Fetch all realms for a user */
      async getRealms(userId) {
        const result = await d1Query(
          `SELECT realm_id, name, essence, archetype_type, archetype_character,
                  territory_count, message_count, top_entities, signature_patterns,
                  story_birth, story_arc, story_peak_moments, story_current_chapter,
                  uncertainty_open_questions, uncertainty_edges,
                  agent_expertise, agent_curious_about, agent_can_help_with,
                  activity_timeline
           FROM realms WHERE user_id = ?`,
          [userId],
        );
        return (result.results || []).map(row => ({
          ...row,
          top_entities: parseJson(row.top_entities),
          signature_patterns: parseJson(row.signature_patterns),
          story_peak_moments: parseJson(row.story_peak_moments),
          uncertainty_open_questions: parseJson(row.uncertainty_open_questions),
          agent_can_help_with: parseJson(row.agent_can_help_with),
          activity_timeline: parseJson(row.activity_timeline),
        }));
      },

      /** Fetch all semantic themes for a user */
      async getSemanticThemes(userId) {
        const result = await d1Query(
          `SELECT realm_id, semantic_theme_id, name, essence,
                  territory_count, message_count, territory_ids,
                  included_territory_count, coverage_percent,
                  top_entities, signature_patterns,
                  story_birth, story_arc, story_current_chapter,
                  uncertainty_open_questions
           FROM semantic_themes WHERE user_id = ?`,
          [userId],
        );
        return (result.results || []).map(row => ({
          ...row,
          territory_ids: parseJson(row.territory_ids),
          top_entities: parseJson(row.top_entities),
          signature_patterns: parseJson(row.signature_patterns),
          uncertainty_open_questions: parseJson(row.uncertainty_open_questions),
        }));
      },
    },

    // ── Cluster Growth Events ────────────────────────────────────────────────

    clusterEvents: {
      async getRecent(userId, { limit = 50, level, since } = {}) {
        let sql = `SELECT * FROM cluster_events WHERE user_id = ?`;
        const params = [userId];
        if (level) { sql += ` AND level = ?`; params.push(level); }
        if (since) { sql += ` AND created_at >= ?`; params.push(since); }
        sql += ` ORDER BY created_at DESC LIMIT ?`;
        params.push(limit);
        const result = await d1Query(sql, params);
        return (result.results || []).map(row => ({
          ...row,
          old_cluster_ids: parseJson(row.old_cluster_ids),
          new_cluster_ids: parseJson(row.new_cluster_ids),
          sample_tags: parseJson(row.sample_tags),
          sample_entities: parseJson(row.sample_entities),
        }));
      },

      async getByVersion(userId, clusterVersion) {
        const result = await d1Query(
          `SELECT * FROM cluster_events WHERE user_id = ? AND cluster_version = ? ORDER BY level, event_type`,
          [userId, clusterVersion],
        );
        return (result.results || []).map(row => ({
          ...row,
          old_cluster_ids: parseJson(row.old_cluster_ids),
          new_cluster_ids: parseJson(row.new_cluster_ids),
          sample_tags: parseJson(row.sample_tags),
          sample_entities: parseJson(row.sample_entities),
        }));
      },

      async getSummary(userId) {
        const result = await d1Query(`
          SELECT level, event_type, COUNT(*) as count,
                 MAX(created_at) as last_at
          FROM cluster_events WHERE user_id = ?
          GROUP BY level, event_type
          ORDER BY level, event_type
        `, [userId]);
        return result.results || [];
      },
    },

    // ── Territory Living Documents ───────────────────────────────────────────

    territoryDocs: {
      /** Get territories needing description (no description_version or outdated) */
      async getNeedingDescription(userId, currentVersion) {
        const result = await d1Query(`
          SELECT tp.territory_id, tp.name, tp.essence, tp.story_birth, tp.story_arc,
                 tp.story_current_chapter, tp.signature_patterns, tp.open_questions,
                 tp.description_version, tp.point_count_at_description, tp.message_count,
                 tp.steward_agent_id, tp.growth_state, tp.energy, tp.vitality, tp.velocity,
                 tp.moments_of_interest, tp.realm_id
          FROM territory_profiles tp
          WHERE tp.user_id = ?
            AND (tp.description_version IS NULL OR tp.description_version != ?)
          ORDER BY tp.message_count DESC
        `, [userId, currentVersion]);
        return (result.results || []).map(row => ({
          ...row,
          signature_patterns: parseJson(row.signature_patterns),
          moments_of_interest: parseJson(row.moments_of_interest),
        }));
      },

      /** Get all territory profiles with dynamics for a user */
      async getAllWithDynamics(userId) {
        const result = await d1Query(`
          SELECT territory_id, realm_id, name, essence, archetype_type, archetype_character,
                 message_count, steward_agent_id, growth_state, energy, vitality, velocity,
                 point_delta, description_version, point_count_at_description,
                 story_birth, story_arc, story_current_chapter, story_peak_moments,
                 signature_patterns, uncertainty_open_questions, uncertainty_edges,
                 agent_expertise, agent_can_help_with, agent_curious_about, agent_would_consult,
                 moments_of_interest,
                 last_described_at, top_entities,
                 activity_timeline, centroid_3d,
                 explored_count, explored_percent, semantic_theme_id,
                 chronicle, chronicle_cursor
          FROM territory_profiles WHERE user_id = ?
          ORDER BY energy DESC NULLS LAST
        `, [userId]);
        return (result.results || []).map(row => ({
          ...row,
          top_entities: parseJson(row.top_entities),
          signature_patterns: parseJson(row.signature_patterns),
          story_peak_moments: parseJson(row.story_peak_moments),
          uncertainty_open_questions: parseJson(row.uncertainty_open_questions),
          agent_can_help_with: parseJson(row.agent_can_help_with),
          agent_would_consult: parseJson(row.agent_would_consult),
          moments_of_interest: parseJson(row.moments_of_interest),
          activity_timeline: parseJson(row.activity_timeline),
          centroid_3d: parseJson(row.centroid_3d),
        }));
      },

      /** Get a single territory profile by territory_id */
      async getByTerritoryId(userId, territoryId) {
        const result = await d1Query(`
          SELECT * FROM territory_profiles
          WHERE user_id = ? AND territory_id = ?
        `, [userId, territoryId]);
        const row = (result.results || [])[0];
        if (!row) return null;
        return {
          ...row,
          top_entities: parseJson(row.top_entities),
          signature_patterns: parseJson(row.signature_patterns),
          story_peak_moments: parseJson(row.story_peak_moments),
          uncertainty_open_questions: parseJson(row.uncertainty_open_questions),
          agent_can_help_with: parseJson(row.agent_can_help_with),
          agent_would_consult: parseJson(row.agent_would_consult),
          moments_of_interest: parseJson(row.moments_of_interest),
        };
      },

      /** Upsert dynamics (computed fields, not LLM-generated) */
      async upsertDynamics(userId, territoryId, dynamics) {
        await d1Query(`
          INSERT INTO territory_profiles (user_id, territory_id, energy, vitality, velocity,
            growth_state, steward_agent_id, message_count, point_delta, realm_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(territory_id, user_id) DO UPDATE SET
            energy = excluded.energy, vitality = excluded.vitality,
            velocity = excluded.velocity, growth_state = excluded.growth_state,
            steward_agent_id = excluded.steward_agent_id,
            message_count = excluded.message_count, point_delta = excluded.point_delta,
            realm_id = excluded.realm_id, updated_at = datetime('now')
        `, [userId, territoryId, dynamics.energy, dynamics.vitality, dynamics.velocity,
            dynamics.growth_state, dynamics.steward_agent_id, dynamics.message_count,
            dynamics.point_delta, dynamics.realm_id]);
      },

      /** Upsert full description (LLM-generated fields) */
      async upsertDescription(userId, territoryId, desc, version, rawResponse) {
        await d1Query(`
          INSERT INTO territory_profiles (user_id, territory_id, name, essence,
            archetype_type, archetype_character,
            story_birth, story_arc, story_current_chapter, story_peak_moments,
            signature_patterns, uncertainty_open_questions, uncertainty_edges,
            agent_expertise, agent_curious_about, agent_can_help_with, agent_would_consult,
            top_entities,
            description_version, point_count_at_description, last_described_at,
            generation_model, raw_response)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'claude-opus', ?)
          ON CONFLICT(territory_id, user_id) DO UPDATE SET
            name = excluded.name, essence = excluded.essence,
            archetype_type = excluded.archetype_type, archetype_character = excluded.archetype_character,
            story_birth = excluded.story_birth, story_arc = excluded.story_arc,
            story_current_chapter = excluded.story_current_chapter,
            story_peak_moments = excluded.story_peak_moments,
            signature_patterns = excluded.signature_patterns,
            uncertainty_open_questions = excluded.uncertainty_open_questions,
            uncertainty_edges = excluded.uncertainty_edges,
            agent_expertise = excluded.agent_expertise,
            agent_curious_about = excluded.agent_curious_about,
            agent_can_help_with = excluded.agent_can_help_with,
            agent_would_consult = excluded.agent_would_consult,
            top_entities = excluded.top_entities,
            description_version = excluded.description_version,
            point_count_at_description = excluded.point_count_at_description,
            last_described_at = excluded.last_described_at,
            generation_model = excluded.generation_model,
            raw_response = excluded.raw_response,
            updated_at = datetime('now')
        `, [userId, territoryId, desc.name, desc.essence,
            desc.archetype_type, desc.archetype_character,
            desc.story_birth, desc.story_arc, desc.story_current_chapter,
            JSON.stringify(desc.story_peak_moments || []),
            JSON.stringify(desc.signature_patterns || []),
            JSON.stringify(desc.uncertainty_open_questions || []),
            desc.uncertainty_edges,
            desc.agent_expertise, desc.agent_curious_about,
            JSON.stringify(desc.agent_can_help_with || []),
            JSON.stringify(desc.agent_would_consult || []),
            JSON.stringify(desc.top_entities || []),
            version, desc.point_count,
            rawResponse || JSON.stringify(desc)]);
      },

      /** Append a moment of interest to a territory */
      async appendMoment(userId, territoryId, moment) {
        const existing = await d1Query(
          `SELECT moments_of_interest FROM territory_profiles WHERE user_id = ? AND territory_id = ?`,
          [userId, territoryId],
        );
        const row = (existing.results || [])[0];
        const moments = parseJson(row?.moments_of_interest) || [];
        moments.push(moment);
        // Keep last 20 moments
        const trimmed = moments.slice(-20);
        await d1Query(
          `UPDATE territory_profiles SET moments_of_interest = ?, updated_at = datetime('now')
           WHERE user_id = ? AND territory_id = ?`,
          [JSON.stringify(trimmed), userId, territoryId],
        );
      },

      /**
       * Get today's territory activations: which territories received messages,
       * how many, who (which agents), and how that compares to baseline energy.
       * Returns territories sorted by surprise (deviation from expected).
       */
      async getDailyActivations(userId, date) {
        // date = 'YYYY-MM-DD'
        const since = `${date}T00:00:00Z`;
        const until = `${date}T23:59:59Z`;

        // Count today's messages per territory
        const activations = await d1Query(`
          SELECT cp.territory_id, cp.realm_id,
                 COUNT(*) as today_count,
                 GROUP_CONCAT(DISTINCT m.agent_id) as agents,
                 GROUP_CONCAT(DISTINCT m.source) as sources
          FROM messages m
          JOIN clustering_points cp ON cp.source_id = m.id AND cp.source_type = 'message'
          WHERE m.user_id = ? AND m.created_at >= ? AND m.created_at <= ?
            AND cp.territory_id IS NOT NULL
          GROUP BY cp.territory_id
          ORDER BY today_count DESC
        `, [userId, since, until]);

        if (!activations.results?.length) return { active: [], silent: [], date };

        const activeTerritoryIds = (activations.results || []).map(a => a.territory_id);

        // Get profiles for active territories
        const placeholders = activeTerritoryIds.map(() => '?').join(',');
        const profiles = await d1Query(`
          SELECT territory_id, name, essence, energy, growth_state, vitality,
                 velocity, message_count, steward_agent_id, realm_id
          FROM territory_profiles
          WHERE user_id = ? AND territory_id IN (${placeholders})
        `, [userId, ...activeTerritoryIds]);

        const profileMap = {};
        for (const p of (profiles.results || [])) {
          profileMap[p.territory_id] = p;
        }

        // Get total messages today for baseline
        const totalResult = await d1Query(`
          SELECT COUNT(*) as total FROM messages
          WHERE user_id = ? AND created_at >= ? AND created_at <= ?
        `, [userId, since, until]);
        const totalToday = totalResult.results?.[0]?.total || 1;

        // Compute activation with surprise score
        const active = (activations.results || []).map(a => {
          const profile = profileMap[a.territory_id] || {};
          const todayEnergy = a.today_count / totalToday;
          const baselineEnergy = profile.energy || 0;
          // Surprise = how much today's activation deviates from baseline
          // Positive = more active than usual, negative = less active than usual
          const surprise = baselineEnergy > 0
            ? (todayEnergy - baselineEnergy) / baselineEnergy
            : (a.today_count > 2 ? 1.0 : 0.5); // new territory with activity = surprising
          return {
            territory_id: a.territory_id,
            realm_id: a.realm_id,
            name: profile.name || `Territory ${a.territory_id}`,
            essence: profile.essence,
            today_count: a.today_count,
            today_energy: Math.round(todayEnergy * 1000) / 1000,
            baseline_energy: Math.round((baselineEnergy || 0) * 1000) / 1000,
            surprise: Math.round(surprise * 100) / 100,
            growth_state: profile.growth_state,
            agents: a.agents ? a.agents.split(',').filter(Boolean) : [],
            sources: a.sources ? a.sources.split(',').filter(Boolean) : [],
          };
        }).sort((a, b) => Math.abs(b.surprise) - Math.abs(a.surprise));

        // Find normally-active territories that went silent today
        const silentResult = await d1Query(`
          SELECT territory_id, name, essence, energy, growth_state, message_count
          FROM territory_profiles
          WHERE user_id = ? AND energy > 0.02 AND territory_id NOT IN (${placeholders})
          ORDER BY energy DESC LIMIT 10
        `, [userId, ...activeTerritoryIds]);

        const silent = (silentResult.results || []).map(s => ({
          territory_id: s.territory_id,
          name: s.name || `Territory ${s.territory_id}`,
          essence: s.essence,
          baseline_energy: Math.round((s.energy || 0) * 1000) / 1000,
          growth_state: s.growth_state,
          message_count: s.message_count,
        }));

        return { active, silent, date, total_messages: totalToday };
      },
    },

    // ── Semantic Search ─────────────────────────────────────────────────────

    search: {
      async lookupTerritoryByName(userId, name) {
        const result = await d1Query(
          `SELECT territory_id, name FROM territory_profiles
           WHERE user_id = ? AND LOWER(name) LIKE LOWER(?)
           LIMIT 5`,
          [userId, `%${name}%`],
        );
        return result.results || [];
      },

      async matchTerritories(embedding, userId, count = 5) {
        const matches = await vectorQuery({
          index: 'search',
          vector: embedding,
          topK: count,
          filter: { type: 'territory_profile', userId },
        });

        if (!matches.length) return [];

        const ids = matches.map(m => m.id);
        const placeholders = ids.map(() => '?').join(', ');
        const result = await d1Query(
          `SELECT id, territory_id, name, essence, message_count, top_entities FROM territory_profiles WHERE id IN (${placeholders})`,
          ids,
        );

        const scoreMap = new Map(matches.map(m => [m.id, m.score]));
        return (result.results || [])
          .map(row => ({
            ...row,
            top_entities: parseJson(row.top_entities),
            similarity: scoreMap.get(row.id) || 0,
          }))
          .sort((a, b) => b.similarity - a.similarity);
      },

      async matchRealms(embedding, userId, count = 5) {
        const matches = await vectorQuery({
          index: 'search',
          vector: embedding,
          topK: count,
          filter: { type: 'realm', userId },
        });

        if (!matches.length) return [];

        const ids = matches.map(m => m.id);
        const placeholders = ids.map(() => '?').join(', ');
        const result = await d1Query(
          `SELECT id, realm_id, name, essence, territory_count, message_count FROM realms WHERE id IN (${placeholders})`,
          ids,
        );

        const scoreMap = new Map(matches.map(m => [m.id, m.score]));
        return (result.results || [])
          .map(row => ({ ...row, similarity: scoreMap.get(row.id) || 0 }))
          .sort((a, b) => b.similarity - a.similarity);
      },

      async matchThemes(embedding, userId, count = 5) {
        const matches = await vectorQuery({
          index: 'search',
          vector: embedding,
          topK: count,
          filter: { type: 'semantic_theme', userId },
        });

        if (!matches.length) return [];

        const ids = matches.map(m => m.id);
        const placeholders = ids.map(() => '?').join(', ');
        const result = await d1Query(
          `SELECT id, semantic_theme_id, name, essence, territory_count, message_count FROM semantic_themes WHERE id IN (${placeholders})`,
          ids,
        );

        const scoreMap = new Map(matches.map(m => [m.id, m.score]));
        return (result.results || [])
          .map(row => ({ ...row, similarity: scoreMap.get(row.id) || 0 }))
          .sort((a, b) => b.similarity - a.similarity);
      },
    },

    // ── Topology (co-firing analysis) ───────────────────────────────────────

    topology: {
      async getCoFiring(params) {
        const col = cofireCol(params.p_scale);
        // Neighbors of a territory — JOINed with profiles for names.
        // Uses UNION to handle both directions of the symmetric co-fire table.
        const result = await d1Query(
          `WITH neighbors AS (
             SELECT territory_b as neighbor_id, ${col} as cofire_strength
             FROM territory_cofire WHERE user_id = ? AND territory_a = ? AND ${col} > ?
             UNION ALL
             SELECT territory_a as neighbor_id, ${col} as cofire_strength
             FROM territory_cofire WHERE user_id = ? AND territory_b = ? AND ${col} > ?
           )
           SELECT n.neighbor_id as territory_id, tp.name, tp.message_count, n.cofire_strength
           FROM neighbors n
           JOIN territory_profiles tp ON tp.territory_id = n.neighbor_id AND tp.user_id = ?
           ORDER BY n.cofire_strength DESC
           LIMIT ?`,
          [
            params.p_user_id, params.p_territory_id, params.p_min_strength || 0.1,
            params.p_user_id, params.p_territory_id, params.p_min_strength || 0.1,
            params.p_user_id, params.p_limit || 10,
          ],
        );
        return result.results || [];
      },

      async getOrphans(params) {
        const col = cofireCol(params.p_scale);
        const minCofire = params.p_min_cofire || 0.1;
        // High-content territories with few co-firing connections
        const result = await d1Query(
          `WITH territory_conn AS (
             SELECT tp.territory_id, tp.name, tp.essence, tp.message_count,
               (SELECT COUNT(*) FROM territory_cofire tc
                WHERE tc.user_id = ?
                  AND (tc.territory_a = tp.territory_id OR tc.territory_b = tp.territory_id)
                  AND tc.${col} > ?) as connection_count
             FROM territory_profiles tp
             WHERE tp.user_id = ? AND tp.message_count >= ?
           )
           SELECT * FROM territory_conn
           WHERE connection_count <= ?
           ORDER BY message_count DESC
           LIMIT ?`,
          [
            params.p_user_id, minCofire,
            params.p_user_id, params.p_min_messages || 5,
            params.p_max_connections || 3,
            params.p_limit || 10,
          ],
        );
        return result.results || [];
      },

      async getBridges(params) {
        const col = cofireCol(params.p_scale);
        // Territories connecting many others across different realms
        const result = await d1Query(
          `WITH all_conn AS (
             SELECT territory_a as tid, territory_b as neighbor_id, ${col} as strength
             FROM territory_cofire WHERE user_id = ? AND ${col} > ?
             UNION ALL
             SELECT territory_b as tid, territory_a as neighbor_id, ${col} as strength
             FROM territory_cofire WHERE user_id = ? AND ${col} > ?
           )
           SELECT
             c.tid as territory_id,
             tp.name,
             COUNT(DISTINCT c.neighbor_id) as connection_count,
             COUNT(DISTINCT tp2.realm_id) as connected_realms,
             SUM(c.strength) as total_cofire_strength
           FROM all_conn c
           JOIN territory_profiles tp ON tp.territory_id = c.tid AND tp.user_id = ?
           LEFT JOIN territory_profiles tp2 ON tp2.territory_id = c.neighbor_id AND tp2.user_id = ?
           GROUP BY c.tid
           HAVING COUNT(DISTINCT c.neighbor_id) >= ?
           ORDER BY connection_count DESC
           LIMIT ?`,
          [
            params.p_user_id, params.p_min_cofire || 0.05,
            params.p_user_id, params.p_min_cofire || 0.05,
            params.p_user_id, params.p_user_id,
            params.p_min_connections || 3,
            params.p_limit || 10,
          ],
        );
        return result.results || [];
      },

      async getGaps(params) {
        const col = cofireCol(params.p_scale);
        // Semantically close territory pairs that don't co-fire
        const result = await d1Query(
          `SELECT
             tn.neighbor_id as territory_id,
             tp.name,
             tp.message_count,
             (1.0 - COALESCE(tn.distance, 0)) as semantic_similarity,
             0 as cofire_strength,
             (1.0 - COALESCE(tn.distance, 0)) as gap_score
           FROM territory_neighbors tn
           JOIN territory_profiles tp ON tp.territory_id = tn.neighbor_id AND tp.user_id = tn.user_id
           WHERE tn.user_id = ? AND tn.territory_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM territory_cofire tc
               WHERE tc.user_id = ?
                 AND ((tc.territory_a = tn.territory_id AND tc.territory_b = tn.neighbor_id)
                   OR (tc.territory_b = tn.territory_id AND tc.territory_a = tn.neighbor_id))
                 AND tc.${col} > ?
             )
           ORDER BY tn.distance ASC
           LIMIT ?`,
          [
            params.p_user_id, params.p_territory_id,
            params.p_user_id, params.p_max_cofire || 0.05,
            params.p_limit || 10,
          ],
        );
        return result.results || [];
      },

      async getCluster(params) {
        const col = cofireCol(params.p_scale);
        // Territories in the same theme, with co-fire strength to seed territory
        const result = await d1Query(
          `SELECT tp.territory_id, tp.name, tp.essence, tp.message_count,
             1 as depth,
             COALESCE(
               (SELECT tc.${col} FROM territory_cofire tc
                WHERE tc.user_id = ?
                  AND ((tc.territory_a = ? AND tc.territory_b = cp.territory_id)
                    OR (tc.territory_b = ? AND tc.territory_a = cp.territory_id))
               ), 0) as path_strength
           FROM clustering_points cp
           JOIN territory_profiles tp ON tp.territory_id = cp.territory_id AND tp.user_id = cp.user_id
           WHERE cp.user_id = ? AND cp.territory_id != ?
             AND cp.theme_id IN (
               SELECT theme_id FROM clustering_points WHERE user_id = ? AND territory_id = ?
             )
           ORDER BY path_strength DESC
           LIMIT ?`,
          [
            params.p_user_id, params.p_territory_id, params.p_territory_id,
            params.p_user_id, params.p_territory_id,
            params.p_user_id, params.p_territory_id,
            params.p_limit || 20,
          ],
        );
        return result.results || [];
      },
    },

    // ── Wealth Module ────────────────────────────────────────────────────

    wealth: {
      // -- Portfolios --

      async listPortfolios(userId) {
        const result = await d1Query(
          `SELECT p.*, pa.role
           FROM wealth_portfolios p
           JOIN wealth_portfolio_access pa ON pa.portfolio_id = p.id
           WHERE pa.user_id = ?
           ORDER BY p.created_at`,
          [userId],
        );
        return result.results || [];
      },

      async getPortfolio(portfolioId, userId) {
        const result = await d1Query(
          `SELECT p.*, pa.role
           FROM wealth_portfolios p
           JOIN wealth_portfolio_access pa ON pa.portfolio_id = p.id
           WHERE p.id = ? AND pa.user_id = ?`,
          [portfolioId, userId],
        );
        return result.results?.[0] || null;
      },

      async createPortfolio(userId, name, baseCurrency = 'EUR', type = 'personal') {
        const id = crypto.randomUUID();
        await d1Batch([
          {
            sql: `INSERT INTO wealth_portfolios (id, name, type, base_currency) VALUES (?, ?, ?, ?)`,
            params: [id, name, type, baseCurrency],
          },
          {
            sql: `INSERT INTO wealth_portfolio_access (portfolio_id, user_id, role) VALUES (?, ?, 'owner')`,
            params: [id, userId],
          },
        ]);
        return { id, name, type, base_currency: baseCurrency };
      },

      async deletePortfolio(portfolioId, userId) {
        // Only owner can delete
        const access = await d1Query(
          `SELECT role FROM wealth_portfolio_access WHERE portfolio_id = ? AND user_id = ?`,
          [portfolioId, userId],
        );
        if (access.results?.[0]?.role !== 'owner') throw new Error('Only owner can delete portfolio');
        await d1Batch([
          { sql: `DELETE FROM wealth_transactions WHERE portfolio_id = ?`, params: [portfolioId] },
          { sql: `DELETE FROM wealth_positions WHERE portfolio_id = ?`, params: [portfolioId] },
          { sql: `DELETE FROM wealth_snapshots WHERE portfolio_id = ?`, params: [portfolioId] },
          { sql: `DELETE FROM wealth_portfolio_access WHERE portfolio_id = ?`, params: [portfolioId] },
          { sql: `DELETE FROM wealth_portfolios WHERE id = ?`, params: [portfolioId] },
        ]);
      },

      async sharePortfolio(portfolioId, userId, targetUserId, role = 'viewer') {
        await d1Query(
          `INSERT OR REPLACE INTO wealth_portfolio_access (portfolio_id, user_id, role) VALUES (?, ?, ?)`,
          [portfolioId, targetUserId, role],
        );
      },

      async removePortfolioAccess(portfolioId, targetUserId) {
        await d1Query(
          `DELETE FROM wealth_portfolio_access WHERE portfolio_id = ? AND user_id = ?`,
          [portfolioId, targetUserId],
        );
      },

      // -- Assets --

      async getAsset(symbol, type) {
        const result = await d1Query(
          `SELECT * FROM wealth_assets WHERE symbol = ? AND type = ?`,
          [symbol, type],
        );
        return result.results?.[0] || null;
      },

      async getAssetById(id) {
        const result = await d1Query(
          `SELECT * FROM wealth_assets WHERE id = ?`,
          [id],
        );
        return result.results?.[0] || null;
      },

      async findAssets(query) {
        const result = await d1Query(
          `SELECT * FROM wealth_assets WHERE symbol LIKE ? OR name LIKE ? ORDER BY symbol LIMIT 20`,
          [`%${query}%`, `%${query}%`],
        );
        return result.results || [];
      },

      async upsertAsset({ symbol, name, type, exchange, currency, lookup_id, price_source }) {
        // Try to find existing
        const existing = await d1Query(
          `SELECT * FROM wealth_assets WHERE symbol = ? AND type = ?`,
          [symbol, type],
        );
        if (existing.results?.[0]) {
          const asset = existing.results[0];
          // Update if any fields changed
          await d1Query(
            `UPDATE wealth_assets SET name = ?, exchange = ?, currency = ?, lookup_id = ?, price_source = ? WHERE id = ?`,
            [name || asset.name, exchange ?? asset.exchange, currency || asset.currency, lookup_id ?? asset.lookup_id, price_source || asset.price_source, asset.id],
          );
          return { ...asset, name: name || asset.name, exchange: exchange ?? asset.exchange, currency: currency || asset.currency, lookup_id: lookup_id ?? asset.lookup_id, price_source: price_source || asset.price_source };
        }
        const id = crypto.randomUUID();
        await d1Query(
          `INSERT INTO wealth_assets (id, symbol, name, type, exchange, currency, lookup_id, price_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, symbol, name, type, exchange || null, currency, lookup_id || null, price_source || 'manual'],
        );
        return { id, symbol, name, type, exchange, currency, lookup_id, price_source };
      },

      // -- Transactions --

      async addTransaction(tx) {
        const id = crypto.randomUUID();
        await d1Query(
          `INSERT INTO wealth_transactions (id, portfolio_id, asset_id, type, quantity, price_per_unit, currency, exchange_rate, fees, transacted_at, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, tx.portfolio_id, tx.asset_id, tx.type, tx.quantity, tx.price_per_unit, tx.currency, tx.exchange_rate || 1, tx.fees || 0, tx.transacted_at, tx.notes || null],
        );
        return id;
      },

      async editTransaction(transactionId, fields) {
        const sets = [];
        const params = [];
        for (const [key, val] of Object.entries(fields)) {
          if (['portfolio_id', 'asset_id', 'type', 'quantity', 'price_per_unit', 'currency', 'exchange_rate', 'fees', 'transacted_at', 'notes'].includes(key)) {
            sets.push(`${key} = ?`);
            params.push(val);
          }
        }
        if (sets.length === 0) return;
        params.push(transactionId);
        await d1Query(`UPDATE wealth_transactions SET ${sets.join(', ')} WHERE id = ?`, params);
      },

      async deleteTransaction(transactionId) {
        const result = await d1Query(`SELECT portfolio_id, asset_id FROM wealth_transactions WHERE id = ?`, [transactionId]);
        const tx = result.results?.[0];
        if (!tx) throw new Error('Transaction not found');
        await d1Query(`DELETE FROM wealth_transactions WHERE id = ?`, [transactionId]);
        return tx; // Caller uses this to recalculate position
      },

      async getTransaction(transactionId) {
        const result = await d1Query(`SELECT * FROM wealth_transactions WHERE id = ?`, [transactionId]);
        return result.results?.[0] || null;
      },

      async listTransactions(portfolioId, { symbol, type, asset_id, from, to, limit = 100 } = {}) {
        let sql = `SELECT t.*, a.symbol, a.name as asset_name, a.type as asset_type
                    FROM wealth_transactions t
                    JOIN wealth_assets a ON a.id = t.asset_id
                    WHERE t.portfolio_id = ?`;
        const params = [portfolioId];
        if (asset_id) { sql += ` AND t.asset_id = ?`; params.push(asset_id); }
        if (symbol) { sql += ` AND a.symbol = ?`; params.push(symbol); }
        if (type) { sql += ` AND t.type = ?`; params.push(type); }
        if (from) { sql += ` AND t.transacted_at >= ?`; params.push(from); }
        if (to) { sql += ` AND t.transacted_at <= ?`; params.push(to); }
        sql += ` ORDER BY t.transacted_at DESC LIMIT ?`;
        params.push(limit);
        const result = await d1Query(sql, params);
        return result.results || [];
      },

      // -- Positions --

      async getPositions(portfolioId) {
        const result = await d1Query(
          `SELECT p.*, a.symbol, a.name as asset_name, a.type as asset_type, a.currency, a.price_source, a.lookup_id
           FROM wealth_positions p
           JOIN wealth_assets a ON a.id = p.asset_id
           WHERE p.portfolio_id = ? AND p.quantity != 0
           ORDER BY p.total_invested DESC`,
          [portfolioId],
        );
        return result.results || [];
      },

      async recalculatePosition(portfolioId, assetId) {
        const result = await d1Query(
          `SELECT * FROM wealth_transactions WHERE portfolio_id = ? AND asset_id = ? ORDER BY transacted_at ASC`,
          [portfolioId, assetId],
        );
        const txs = result.results || [];

        let quantity = 0;
        let totalCost = 0; // in portfolio base currency
        let realizedPnl = 0;

        for (const tx of txs) {
          const costInBase = tx.price_per_unit * tx.exchange_rate;
          switch (tx.type) {
            case 'buy':
            case 'transfer_in':
            case 'staking_reward':
              totalCost += tx.quantity * costInBase + (tx.fees || 0) * tx.exchange_rate;
              quantity += tx.quantity;
              break;
            case 'sell':
            case 'transfer_out': {
              const avgCost = quantity > 0 ? totalCost / quantity : 0;
              const proceeds = tx.quantity * costInBase - (tx.fees || 0) * tx.exchange_rate;
              if (tx.type === 'sell') {
                realizedPnl += proceeds - tx.quantity * avgCost;
              }
              totalCost -= tx.quantity * avgCost;
              quantity -= tx.quantity;
              break;
            }
            case 'dividend':
              // Dividends are income, no position change. price_per_unit = total amount.
              realizedPnl += tx.price_per_unit * tx.exchange_rate;
              break;
          }
        }

        const avgCostBasis = quantity > 0 ? totalCost / quantity : 0;

        await d1Query(
          `INSERT OR REPLACE INTO wealth_positions (portfolio_id, asset_id, quantity, avg_cost_basis, total_invested, realized_pnl)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [portfolioId, assetId, quantity, avgCostBasis, totalCost, realizedPnl],
        );

        return { quantity, avg_cost_basis: avgCostBasis, total_invested: totalCost, realized_pnl: realizedPnl };
      },

      // -- Snapshots --

      async recordSnapshot(portfolioId, date, totalValue, currency) {
        await d1Query(
          `INSERT OR REPLACE INTO wealth_snapshots (portfolio_id, date, total_value, currency) VALUES (?, ?, ?, ?)`,
          [portfolioId, date, totalValue, currency],
        );
      },

      async getSnapshots(portfolioId, { from, to, limit = 365 } = {}) {
        let sql = `SELECT * FROM wealth_snapshots WHERE portfolio_id = ?`;
        const params = [portfolioId];
        if (from) { sql += ` AND date >= ?`; params.push(from); }
        if (to) { sql += ` AND date <= ?`; params.push(to); }
        sql += ` ORDER BY date ASC LIMIT ?`;
        params.push(limit);
        const result = await d1Query(sql, params);
        return result.results || [];
      },

      // -- Watchlist --

      async getWatchlist(userId) {
        const result = await d1Query(
          `SELECT w.*, a.symbol, a.name as asset_name, a.type as asset_type, a.currency, a.price_source, a.lookup_id
           FROM wealth_watchlist w
           JOIN wealth_assets a ON a.id = w.asset_id
           WHERE w.user_id = ?
           ORDER BY w.added_at DESC`,
          [userId],
        );
        return result.results || [];
      },

      async addToWatchlist(userId, assetId, { targetHigh, targetLow, notes } = {}) {
        await d1Query(
          `INSERT OR REPLACE INTO wealth_watchlist (user_id, asset_id, target_price_high, target_price_low, notes) VALUES (?, ?, ?, ?, ?)`,
          [userId, assetId, targetHigh || null, targetLow || null, notes || null],
        );
      },

      async removeFromWatchlist(userId, assetId) {
        await d1Query(
          `DELETE FROM wealth_watchlist WHERE user_id = ? AND asset_id = ?`,
          [userId, assetId],
        );
      },
    },

    // ── Activity Tracking ────────────────────────────────────────────────
    activity: {
      async syncSessions(sessions) {
        for (const s of sessions) {
          await d1Query(
            `INSERT OR REPLACE INTO activity_sessions
             (id, agent_id, app_bundle, app_name, window_title, url, category,
              productivity, started_at, ended_at, duration_s, idle, date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              s.id, s.agent_id || 'personal-agent',
              s.app_bundle, s.app_name, s.window_title || null,
              s.url || null, s.category || 'other', s.productivity || 50,
              s.started_at, s.ended_at, s.duration_s || 0,
              s.idle || 0, s.date,
            ],
          );
        }
        return sessions.length;
      },

      async getSessions(agentId, { date, from, to, category, limit = 200 } = {}) {
        let sql = `SELECT * FROM activity_sessions WHERE agent_id = ? AND app_bundle != 'com.apple.loginwindow'`;
        const params = [agentId || 'personal-agent'];
        if (date) { sql += ` AND date = ?`; params.push(date); }
        if (from) { sql += ` AND started_at >= ?`; params.push(from); }
        if (to) { sql += ` AND started_at <= ?`; params.push(to); }
        if (category) { sql += ` AND category = ?`; params.push(category); }
        sql += ` ORDER BY started_at DESC LIMIT ?`;
        params.push(limit);
        const result = await d1Query(sql, params);
        return result.results || [];
      },

      async getTopApps(agentId, { date, from, to, limit = 10 } = {}) {
        let where = `agent_id = ? AND idle = 0 AND app_bundle != 'com.apple.loginwindow'`;
        const params = [agentId || 'personal-agent'];
        if (date) { where += ` AND date = ?`; params.push(date); }
        if (from) { where += ` AND date >= ?`; params.push(from); }
        if (to) { where += ` AND date <= ?`; params.push(to); }
        params.push(limit);
        const result = await d1Query(
          `SELECT app_name, app_bundle, category, SUM(duration_s) as total_s, COUNT(*) as sessions
           FROM activity_sessions WHERE ${where}
           GROUP BY app_bundle ORDER BY total_s DESC LIMIT ?`, params);
        return result.results || [];
      },

      async getTopDomains(agentId, { date, from, to, limit = 15 } = {}) {
        let where = `agent_id = ? AND idle = 0 AND app_bundle != 'com.apple.loginwindow' AND url IS NOT NULL AND url != ''`;
        const params = [agentId || 'personal-agent'];
        if (date) { where += ` AND date = ?`; params.push(date); }
        if (from) { where += ` AND date >= ?`; params.push(from); }
        if (to) { where += ` AND date <= ?`; params.push(to); }
        params.push(limit);
        const result = await d1Query(
          `SELECT
             REPLACE(REPLACE(
               SUBSTR(url, 1, CASE WHEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') > 0
                 THEN INSTR(url, '://') + 2 + INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/')
                 ELSE LENGTH(url) END
             ), 'https://', ''), 'http://', '') as domain,
             category, SUM(duration_s) as total_s, COUNT(*) as sessions, AVG(productivity) as productivity_avg
           FROM activity_sessions WHERE ${where}
           GROUP BY domain ORDER BY total_s DESC LIMIT ?`, params);
        return result.results || [];
      },

      async getCategoryBreakdown(agentId, { date, from, to } = {}) {
        let where = `agent_id = ? AND app_bundle != 'com.apple.loginwindow'`;
        const params = [agentId || 'personal-agent'];
        if (date) { where += ` AND date = ?`; params.push(date); }
        if (from) { where += ` AND date >= ?`; params.push(from); }
        if (to) { where += ` AND date <= ?`; params.push(to); }
        const result = await d1Query(
          `SELECT category, SUM(duration_s) as total_s, COUNT(*) as sessions,
                  AVG(productivity) as productivity_avg
           FROM activity_sessions WHERE ${where}
           GROUP BY category ORDER BY total_s DESC`, params);
        return result.results || [];
      },

      async getDailySummary(agentId, { from, to } = {}) {
        let sql = `SELECT date, SUM(duration_s) as total_s, SUM(CASE WHEN idle = 0 THEN duration_s ELSE 0 END) as active_s,
                          SUM(CASE WHEN idle = 1 THEN duration_s ELSE 0 END) as idle_s,
                          AVG(CASE WHEN idle = 0 THEN productivity END) as productivity_avg,
                          COUNT(*) as sessions
                   FROM activity_sessions WHERE agent_id = ? AND app_bundle != 'com.apple.loginwindow'`;
        const params = [agentId || 'personal-agent'];
        if (from) { sql += ` AND date >= ?`; params.push(from); }
        if (to) { sql += ` AND date <= ?`; params.push(to); }
        sql += ` GROUP BY date ORDER BY date DESC`;
        const result = await d1Query(sql, params);
        return result.results || [];
      },
    },

    // ── Health (Apple Health daily summaries) ────────────────────────────

    health: {
      /** Sync daily health summaries. All fields encrypted via db-proxy (personal scope). */
      async syncDays(userId, days) {
        let synced = 0;
        for (const d of days) {
          const id = `${userId}:${d.date}`;
          await d1QueryAdmin(
            `INSERT OR REPLACE INTO health_daily
             (id, user_id, date,
              sleep_duration_min, sleep_in_bed_min, sleep_efficiency,
              sleep_deep_min, sleep_rem_min, sleep_core_min, sleep_awake_min,
              sleep_start, sleep_end,
              hrv_avg, hrv_sleep_avg, resting_hr,
              steps, active_energy_kcal, workout_count, workout_minutes, workout_types,
              mindful_minutes, source, scope, updated_at)
             VALUES (?, ?, ?,  ?, ?, ?,  ?, ?, ?, ?,  ?, ?,  ?, ?, ?,  ?, ?, ?, ?, ?,  ?, 'apple_health', 'personal', ?)`,
            [id, userId, d.date,
             d.sleep_duration_min ?? null, d.sleep_in_bed_min ?? null, d.sleep_efficiency ?? null,
             d.sleep_deep_min ?? null, d.sleep_rem_min ?? null, d.sleep_core_min ?? null, d.sleep_awake_min ?? null,
             d.sleep_start ?? null, d.sleep_end ?? null,
             d.hrv_avg ?? null, d.hrv_sleep_avg ?? null, d.resting_hr ?? null,
             d.steps ?? null, d.active_energy_kcal ?? null, d.workout_count ?? null, d.workout_minutes ?? null,
             d.workout_types ? JSON.stringify(d.workout_types) : null,
             d.mindful_minutes ?? null, new Date().toISOString()],
          );
          synced++;
        }
        return synced;
      },

      /** Get a single day's health data (decrypted). */
      async getDay(userId, date) {
        const result = await d1QueryAdmin(
          `SELECT * FROM health_daily WHERE user_id = ? AND date = ?`,
          [userId, date],
        );
        return parseHealthRow(firstRow(result));
      },

      /** Get health data for a date range (decrypted). */
      async getRange(userId, from, to) {
        const result = await d1QueryAdmin(
          `SELECT * FROM health_daily WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date`,
          [userId, from, to],
        );
        return (result.results || []).map(parseHealthRow);
      },

      /** Get summary with averages, trends, and anomalies (computed from decrypted data). */
      async getSummary(userId, days = 7) {
        const to = new Date().toISOString().split('T')[0];
        const from = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
        const rows = await this.getRange(userId, from, to);
        return computeHealthSummary(rows, to);
      },
    },

    // ── People / Contacts ──────────────────────────────────────────────────

    people: {
      /**
       * Load existing name→id map for a user. Call once before bulk upserts.
       * Proxy auto-decrypts names so we can match plaintext.
       */
      async loadNameIndex(userId) {
        const result = await d1QueryAdmin(
          `SELECT id, name FROM people WHERE user_id = ?`, [userId],
        );
        const map = new Map();
        for (const r of result.results || []) {
          if (r.name) map.set(r.name, r.id);
        }
        return map;
      },

      /**
       * Upsert a contact using a pre-loaded name index for dedup.
       * Encryption produces different ciphertext per insert, so SQL ON CONFLICT
       * can't dedup. Instead we check the decrypted name index and UPDATE or INSERT.
       */
      async upsert(record, nameIndex) {
        const { user_id, name, source, linkedin_url, email, phone, company, position,
                connected_at, last_interaction_at, interaction_count, status } = record;

        const existingId = nameIndex?.get(name);

        if (existingId) {
          await d1Query(
            `UPDATE people SET
               linkedin_url = COALESCE(NULLIF(?, ''), linkedin_url),
               email = COALESCE(NULLIF(?, ''), email),
               phone = COALESCE(NULLIF(?, ''), phone),
               company = COALESCE(NULLIF(?, ''), company),
               position = COALESCE(NULLIF(?, ''), position),
               connected_at = COALESCE(?, connected_at),
               last_interaction_at = CASE WHEN ? > COALESCE(last_interaction_at, '') THEN ? ELSE last_interaction_at END,
               interaction_count = MAX(COALESCE(?, 0), COALESCE(interaction_count, 0)),
               source = CASE WHEN source = 'manual' THEN ? ELSE source END
             WHERE id = ?`,
            [linkedin_url || null, email || null, phone || null, company || null,
             position || null, connected_at || null,
             last_interaction_at || null, last_interaction_at || null,
             interaction_count || 0, source || 'manual', existingId],
          );
        } else {
          await d1Query(
            `INSERT INTO people (id, user_id, name, source, linkedin_url, email, phone, company, position, connected_at, last_interaction_at, interaction_count, status)
             VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [user_id, name, source || 'manual', linkedin_url || null, email || null, phone || null,
             company || null, position || null, connected_at || null,
             last_interaction_at || null, interaction_count || 0, status || 'connected'],
          );
          // Add to index so subsequent upserts in same batch don't re-insert
          if (nameIndex) nameIndex.set(name, 'pending');
        }
      },

      async getBySource(userId, source) {
        const result = await d1QueryAdmin(
          `SELECT id, name, linkedin_url, email, status FROM people WHERE user_id = ? AND source = ?`,
          [userId, source],
        );
        return result.results || [];
      },
    },

    // ── Profiles ───────────────────────────────────────────────────────────

    profiles: {
      async get(userId) {
        const result = await d1Query(
          `SELECT * FROM user_profiles WHERE user_id = ?`,
          [userId],
        );
        return result.results?.[0] || null;
      },

      async getByHandle(handle) {
        const result = await d1QueryAdmin(
          `SELECT * FROM user_profiles WHERE handle = ?`,
          [handle],
        );
        return result.results?.[0] || null;
      },

      async upsert(userId, data) {
        const fields = [];
        const values = [];
        const updates = [];
        for (const [k, v] of Object.entries(data)) {
          if (v !== undefined) {
            fields.push(k);
            values.push(v);
            updates.push(`${k} = excluded.${k}`);
          }
        }
        fields.push('user_id');
        values.push(userId);
        updates.push("updated_at = datetime('now')");

        const placeholders = fields.map(() => '?').join(', ');
        await d1Query(
          `INSERT INTO user_profiles (${fields.join(', ')}) VALUES (${placeholders})
           ON CONFLICT (user_id) DO UPDATE SET ${updates.join(', ')}`,
          values,
        );
      },

      async setHandle(userId, handle) {
        // Validate handle format
        if (!handle || !/^[a-z0-9][a-z0-9_]{2,29}$/.test(handle)) {
          throw new Error('Handle must be 3-30 chars, lowercase alphanumeric + underscore');
        }
        const reserved = ['admin', 'support', 'api', 'system', 'mycelium', 'vault', 'login', 'signup', 'profile', 'settings', 'help', 'about', 'discover', 'connections'];
        if (reserved.includes(handle)) {
          throw new Error('This handle is reserved');
        }

        // Reserve handle globally in owner D1 (atomic uniqueness)
        try {
          const res = await fetch(`${process.env.MYA_WORKER_URL}/api/db/query`, {
            method: 'POST',
            headers: ownerHeaders(),
            body: JSON.stringify({
              sql: 'INSERT OR IGNORE INTO handle_reservations (handle, user_id) VALUES (?, ?)',
              params: [handle, userId],
            }),
            signal: AbortSignal.timeout(10000),
          });
          if (res.ok) {
            const checkRes = await fetch(`${process.env.MYA_WORKER_URL}/api/db/query`, {
              method: 'POST',
              headers: ownerHeaders(),
              body: JSON.stringify({
                sql: 'SELECT user_id FROM handle_reservations WHERE handle = ?',
                params: [handle],
              }),
              signal: AbortSignal.timeout(10000),
            });
            if (checkRes.ok) {
              const checkData = await checkRes.json();
              const owner = checkData.results?.[0]?.user_id;
              if (owner && owner !== userId) {
                throw new Error('This handle is already taken');
              }
            }
          }
        } catch (e) {
          if (e.message === 'This handle is already taken') throw e;
          // Owner D1 unreachable — fall through to local check
        }

        // Also check local tenant D1
        const localCheck = await d1Query(
          `SELECT user_id FROM user_profiles WHERE handle = ? AND user_id != ?`,
          [handle, userId],
        );
        if (localCheck.results?.length > 0) {
          throw new Error('This handle is already taken');
        }

        await d1Query(
          `INSERT INTO user_profiles (user_id, handle, updated_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT (user_id) DO UPDATE SET handle = excluded.handle, updated_at = datetime('now')`,
          [userId, handle],
        );
      },

      async computeFingerprint(userId) {
        // Territory + realm counts
        const countResult = await d1Query(
          `SELECT
             COUNT(DISTINCT territory_id) as territory_count,
             COUNT(DISTINCT realm_id) as realm_count
           FROM territory_profiles WHERE user_id = ?`,
          [userId],
        );
        const counts = countResult.results?.[0] || {};

        // Message count + member since
        const msgResult = await d1Query(
          `SELECT COUNT(*) as message_count, MIN(created_at) as member_since
           FROM messages WHERE user_id = ?`,
          [userId],
        );
        const msgs = msgResult.results?.[0] || {};

        // Realm names for public profile
        const realmResult = await d1Query(
          `SELECT DISTINCT realm_id, name FROM territory_profiles
           WHERE user_id = ? AND realm_id IS NOT NULL AND name IS NOT NULL
           ORDER BY realm_id`,
          [userId],
        );
        const realmNames = {};
        for (const r of (realmResult.results || [])) {
          if (r.realm_id != null && !realmNames[r.realm_id]) {
            realmNames[r.realm_id] = r.name;
          }
        }

        // Depth: avg intra-cluster distance (use territory message counts as proxy)
        // Higher message counts per territory = deeper engagement
        const depthResult = await d1Query(
          `SELECT AVG(message_count) as avg_depth, MAX(message_count) as max_depth
           FROM territory_profiles WHERE user_id = ? AND message_count > 0`,
          [userId],
        );
        const depthData = depthResult.results?.[0] || {};
        const maxPossibleDepth = 500; // normalize against
        const depthScore = Math.min(1, (depthData.avg_depth || 0) / maxPossibleDepth);

        // Breadth: territory count normalized (300 territories = 1.0)
        const breadthScore = Math.min(1, (counts.territory_count || 0) / 300);

        // Coherence: fraction of territories with chronicles (as proxy for integration)
        const coherenceResult = await d1Query(
          `SELECT COUNT(*) as with_chronicle FROM territory_profiles
           WHERE user_id = ? AND chronicle IS NOT NULL AND LENGTH(chronicle) > 10`,
          [userId],
        );
        const withChronicle = coherenceResult.results?.[0]?.with_chronicle || 0;
        const coherenceScore = counts.territory_count > 0
          ? Math.min(1, withChronicle / counts.territory_count) : 0;

        // Exploration: how spread across realms (entropy-like)
        const realmDistResult = await d1Query(
          `SELECT realm_id, COUNT(*) as count FROM territory_profiles
           WHERE user_id = ? AND realm_id IS NOT NULL GROUP BY realm_id`,
          [userId],
        );
        const realmDist = realmDistResult.results || [];
        const totalInRealms = realmDist.reduce((s, r) => s + r.count, 0);
        let entropy = 0;
        if (totalInRealms > 0) {
          for (const r of realmDist) {
            const p = r.count / totalInRealms;
            if (p > 0) entropy -= p * Math.log2(p);
          }
        }
        const maxEntropy = realmDist.length > 0 ? Math.log2(realmDist.length) : 1;
        const explorationScore = maxEntropy > 0 ? Math.min(1, entropy / maxEntropy) : 0;

        // Build public realms — get distinct realm names from realms table
        const realmNamesResult = await d1Query(
          `SELECT DISTINCT r.realm_id, r.name FROM realms r
           WHERE r.user_id = ? AND r.name IS NOT NULL`,
          [userId],
        );
        let publicRealms = (realmNamesResult.results || []).map(r => r.name).filter(Boolean);
        if (!publicRealms.length) {
          // Fallback: collect unique realm names from territory data
          const realmMap = new Map();
          for (const r of (realmResult.results || [])) {
            if (r.realm_id != null && r.name && !realmMap.has(r.realm_id)) {
              realmMap.set(r.realm_id, r.name);
            }
          }
          publicRealms = [...realmMap.values()];
        }

        const profile = {
          depth_score: Math.round(depthScore * 100) / 100,
          breadth_score: Math.round(breadthScore * 100) / 100,
          coherence_score: Math.round(coherenceScore * 100) / 100,
          exploration_score: Math.round(explorationScore * 100) / 100,
          territory_count: counts.territory_count || 0,
          realm_count: counts.realm_count || 0,
          message_count: msgs.message_count || 0,
          member_since: msgs.member_since || null,
          public_realms_json: JSON.stringify(publicRealms),
        };

        await this.upsert(userId, profile);
        return profile;
      },

      async setTerritoryVisibility(userId, territoryId, visibility) {
        if (!['private', 'friends', 'public'].includes(visibility)) {
          throw new Error('Visibility must be private, friends, or public');
        }
        await d1Query(
          `UPDATE territory_profiles SET visibility = ? WHERE user_id = ? AND territory_id = ?`,
          [visibility, userId, territoryId],
        );
      },

      async getPublicTerritories(userId) {
        const result = await d1Query(
          `SELECT territory_id, name, essence, visibility, realm_id, message_count
           FROM territory_profiles WHERE user_id = ? AND visibility IN ('public', 'friends')
           ORDER BY message_count DESC`,
          [userId],
        );
        return result.results || [];
      },
    },

    // ── AI Providers (Claude, OpenAI, custom) ──────────────────────────────

    providers: {
      async list(userId) {
        const result = await d1Query(
          `SELECT id, user_id, provider, label, auth_type, config_dir,
                  model_preference, base_url, is_active, status, last_used_at,
                  created_at, updated_at
           FROM ai_providers WHERE user_id = ? ORDER BY provider, is_active DESC, created_at`,
          [userId],
        );
        return result.results || [];
      },

      async create(userId, { provider, label, authType, credentials, configDir, model, baseUrl }) {
        const result = await d1Query(
          `INSERT INTO ai_providers (user_id, provider, label, auth_type, credentials, config_dir, model_preference, base_url, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
          [userId, provider, label || null, authType, credentials || null, configDir || null, model || null, baseUrl || null],
        );
        return result.meta?.last_row_id;
      },

      async update(id, userId, fields) {
        const allowed = ['label', 'model_preference', 'base_url', 'status', 'credentials', 'config_dir', 'last_used_at'];
        const sets = [];
        const params = [];
        for (const [k, v] of Object.entries(fields)) {
          if (allowed.includes(k)) { sets.push(`${k} = ?`); params.push(v); }
        }
        if (!sets.length) return;
        sets.push("updated_at = datetime('now')");
        params.push(id, userId);
        await d1Query(
          `UPDATE ai_providers SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
          params,
        );
      },

      async remove(id, userId) {
        await d1Query(
          `DELETE FROM ai_providers WHERE id = ? AND user_id = ?`,
          [id, userId],
        );
      },

      async setActive(id, userId) {
        // Get provider type of the target
        const target = await d1Query(
          `SELECT provider FROM ai_providers WHERE id = ? AND user_id = ?`,
          [id, userId],
        );
        const row = target.results?.[0];
        if (!row) return;
        // Deactivate all of same provider type, then activate this one
        await d1Query(
          `UPDATE ai_providers SET is_active = 0, updated_at = datetime('now')
           WHERE user_id = ? AND provider = ?`,
          [userId, row.provider],
        );
        await d1Query(
          `UPDATE ai_providers SET is_active = 1, updated_at = datetime('now')
           WHERE id = ? AND user_id = ?`,
          [id, userId],
        );
      },

      async getActive(userId, providerType) {
        const result = await d1Query(
          `SELECT id, provider, label, auth_type, credentials, config_dir,
                  model_preference, base_url, status
           FROM ai_providers WHERE user_id = ? AND provider = ? AND is_active = 1`,
          [userId, providerType],
        );
        return result.results?.[0] || null;
      },
    },

    // ── Connections ────────────────────────────────────────────────────────

    connections: {
      _canonical(a, b) {
        return a < b ? { user_a: a, user_b: b } : { user_a: b, user_b: a };
      },

      async request(fromUserId, toHandle) {
        // Detect federated handle: @handle@domain
        const remoteMatch = toHandle.match(/^([a-z0-9][a-z0-9_]{2,29})@(.+)$/i);
        if (remoteMatch) {
          return this._requestRemote(fromUserId, remoteMatch[1].toLowerCase(), remoteMatch[2]);
        }

        // Local handle — look up target user
        const target = await d1Query(
          `SELECT user_id FROM user_profiles WHERE handle = ?`,
          [toHandle],
        );
        const toUserId = target.results?.[0]?.user_id;
        if (!toUserId) throw new Error('User not found');
        if (toUserId === fromUserId) throw new Error('Cannot connect to yourself');

        const { user_a, user_b } = this._canonical(fromUserId, toUserId);

        // Check existing
        const existing = await d1Query(
          `SELECT id, status FROM connections WHERE user_a = ? AND user_b = ?`,
          [user_a, user_b],
        );
        const row = existing.results?.[0];
        if (row) {
          if (row.status === 'accepted') throw new Error('Already connected');
          if (row.status === 'blocked') throw new Error('User not found'); // silent block
          if (row.status === 'pending') throw new Error('Request already pending');
          // If rejected, allow re-request by updating
          await d1Query(
            `UPDATE connections SET status = 'pending', initiated_by = ?, created_at = datetime('now') WHERE id = ?`,
            [fromUserId, row.id],
          );
          return row.id;
        }

        // Check pending limit (max 20)
        const pendingCount = await d1Query(
          `SELECT COUNT(*) as c FROM connections WHERE initiated_by = ? AND status = 'pending'`,
          [fromUserId],
        );
        if ((pendingCount.results?.[0]?.c || 0) >= 20) {
          throw new Error('Too many pending requests (max 20)');
        }

        const id = crypto.randomUUID();
        await d1Query(
          `INSERT INTO connections (id, user_a, user_b, initiated_by, status, created_at)
           VALUES (?, ?, ?, ?, 'pending', datetime('now'))`,
          [id, user_a, user_b, fromUserId],
        );
        return id;
      },

      // Send a federated connection request to a remote instance
      async _requestRemote(fromUserId, remoteHandle, remoteDomain) {
        // Resolve via WebFinger (HTTPS only, 5s timeout)
        if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(remoteDomain)) {
          throw new Error('Invalid domain');
        }
        const webfingerUrl = `https://${remoteDomain}/.well-known/webfinger?resource=acct:${remoteHandle}@${remoteDomain}`;
        let federationEndpoint;
        try {
          const wfRes = await fetch(webfingerUrl, {
            signal: AbortSignal.timeout(5000),
            redirect: 'manual', // Don't follow redirects (SSRF protection)
          });
          if (!wfRes.ok) throw new Error(`WebFinger failed: ${wfRes.status}`);
          const wf = await wfRes.json();
          const fedLink = wf.links?.find(l => l.rel?.includes('federation'));
          if (!fedLink?.href) throw new Error('No federation endpoint');
          federationEndpoint = fedLink.href;
        } catch (e) {
          throw new Error(`Instance not reachable: ${e.message}`);
        }

        // Get local profile for the request payload
        const fromProfile = await d1Query(
          `SELECT handle, signature, depth_score, breadth_score, public_realms_json FROM user_profiles WHERE user_id = ?`,
          [fromUserId],
        );
        const fp = fromProfile.results?.[0] || {};

        // Check pending limit
        const pendingCount = await d1Query(
          `SELECT COUNT(*) as c FROM connections WHERE initiated_by = ? AND status = 'pending'`,
          [fromUserId],
        );
        if ((pendingCount.results?.[0]?.c || 0) >= 20) {
          throw new Error('Too many pending requests (max 20)');
        }

        // Send the connection request to the remote instance
        // Note: JWT signing happens at the Worker level when proxying federation requests
        // For agent-server, we POST via the local Worker's federation proxy
        const workerUrl = process.env.MYA_WORKER_URL;
        const requestBody = {
          $type: 'social.mycelium.connect-request.v1',
          from_handle: fp.handle || fromUserId,
          from_instance: new URL(workerUrl).hostname,
          to_handle: remoteHandle,
          profile: {
            signature: fp.signature,
            stats: { depth_score: fp.depth_score, breadth_score: fp.breadth_score },
            realms: fp.public_realms_json ? JSON.parse(fp.public_realms_json) : [],
          },
        };

        // Store the outbound connection locally
        const id = crypto.randomUUID();
        await d1Query(
          `INSERT INTO connections (id, user_a, user_b, initiated_by, status, remote_instance, remote_user_handle, created_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, datetime('now'))`,
          [id, fromUserId, `${remoteHandle}@${remoteDomain}`, fromUserId, remoteDomain, remoteHandle],
        );

        // POST to remote federation endpoint (fire-and-forget, retry handled by reconciliation)
        try {
          const connectUrl = `${federationEndpoint.replace(/\/$/, '')}/connect`;
          await fetch(connectUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(10000),
          });
        } catch (e) {
          console.warn(`[federation] Remote connect POST failed (will retry): ${e.message}`);
        }

        return id;
      },

      async pending(userId) {
        const result = await d1Query(
          `SELECT c.*, up.handle, up.display_name, up.signature,
                  up.depth_score, up.breadth_score, up.coherence_score, up.exploration_score,
                  up.territory_count, up.realm_count, up.public_realms_json
           FROM connections c
           JOIN user_profiles up ON up.user_id = c.initiated_by
           WHERE (c.user_a = ? OR c.user_b = ?) AND c.status = 'pending' AND c.initiated_by != ?`,
          [userId, userId, userId],
        );
        return result.results || [];
      },

      async accept(userId, connectionId) {
        const conn = await d1Query(
          `SELECT * FROM connections WHERE id = ? AND status = 'pending'`,
          [connectionId],
        );
        const row = conn.results?.[0];
        if (!row) throw new Error('Connection not found');
        if (row.user_a !== userId && row.user_b !== userId) throw new Error('Not authorized');
        if (row.initiated_by === userId) throw new Error('Cannot accept your own request');

        await d1Query(
          `UPDATE connections SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?`,
          [connectionId],
        );
      },

      async reject(userId, connectionId) {
        const conn = await d1Query(
          `SELECT * FROM connections WHERE id = ? AND status = 'pending'`,
          [connectionId],
        );
        const row = conn.results?.[0];
        if (!row) throw new Error('Connection not found');
        if (row.user_a !== userId && row.user_b !== userId) throw new Error('Not authorized');

        await d1Query(
          `UPDATE connections SET status = 'rejected' WHERE id = ?`,
          [connectionId],
        );
      },

      async block(userId, connectionId) {
        const conn = await d1Query(
          `SELECT * FROM connections WHERE id = ?`,
          [connectionId],
        );
        const row = conn.results?.[0];
        if (!row) throw new Error('Connection not found');
        if (row.user_a !== userId && row.user_b !== userId) throw new Error('Not authorized');

        await d1Query(
          `UPDATE connections SET status = 'blocked' WHERE id = ?`,
          [connectionId],
        );
      },

      async disconnect(userId, connectionId) {
        const conn = await d1Query(
          `SELECT * FROM connections WHERE id = ? AND status = 'accepted'`,
          [connectionId],
        );
        const row = conn.results?.[0];
        if (!row) throw new Error('Connection not found');
        if (row.user_a !== userId && row.user_b !== userId) throw new Error('Not authorized');

        await d1Query(`DELETE FROM connections WHERE id = ?`, [connectionId]);
      },

      async list(userId) {
        const result = await d1Query(
          `SELECT c.*,
            CASE WHEN c.user_a = ? THEN ub.handle ELSE ua.handle END as other_handle,
            CASE WHEN c.user_a = ? THEN ub.display_name ELSE ua.display_name END as other_display_name,
            CASE WHEN c.user_a = ? THEN ub.signature ELSE ua.signature END as other_signature,
            CASE WHEN c.user_a = ? THEN ub.user_id ELSE ua.user_id END as other_user_id,
            CASE WHEN c.user_a = ? THEN ub.depth_score ELSE ua.depth_score END as other_depth,
            CASE WHEN c.user_a = ? THEN ub.breadth_score ELSE ua.breadth_score END as other_breadth,
            CASE WHEN c.user_a = ? THEN ub.territory_count ELSE ua.territory_count END as other_territory_count,
            CASE WHEN c.user_a = ? THEN ub.public_realms_json ELSE ua.public_realms_json END as other_realms_json
           FROM connections c
           LEFT JOIN user_profiles ua ON ua.user_id = c.user_a
           LEFT JOIN user_profiles ub ON ub.user_id = c.user_b
           WHERE (c.user_a = ? OR c.user_b = ?) AND c.status = 'accepted'
           ORDER BY c.accepted_at DESC`,
          [userId, userId, userId, userId, userId, userId, userId, userId, userId, userId],
        );
        return result.results || [];
      },

      async computeOverlap(userId, connectionId) {
        // Get the connection
        const conn = await d1Query(
          `SELECT * FROM connections WHERE id = ? AND status = 'accepted'`,
          [connectionId],
        );
        const row = conn.results?.[0];
        if (!row) throw new Error('Connection not found');
        if (row.user_a !== userId && row.user_b !== userId) throw new Error('Not authorized');

        const otherUserId = row.user_a === userId ? row.user_b : row.user_a;

        // Check cache (1 hour TTL)
        if (row.overlap_json && row.overlap_computed_at) {
          const age = Date.now() - new Date(row.overlap_computed_at).getTime();
          if (age < 3600000) return JSON.parse(row.overlap_json);
        }

        // Get both users' visible territories
        const myTerr = await d1Query(
          `SELECT territory_id, name, essence, realm_id, message_count, visibility
           FROM territory_profiles WHERE user_id = ? AND visibility IN ('public', 'friends') AND name IS NOT NULL`,
          [userId],
        );
        const theirTerr = await d1Query(
          `SELECT territory_id, name, essence, realm_id, message_count, visibility
           FROM territory_profiles WHERE user_id = ? AND visibility IN ('public', 'friends') AND name IS NOT NULL`,
          [otherUserId],
        );

        const myList = myTerr.results || [];
        const theirList = theirTerr.results || [];

        // Label matching (exact name match, case-insensitive)
        const myNames = new Map(myList.map(t => [t.name.toLowerCase(), t]));
        const theirNames = new Map(theirList.map(t => [t.name.toLowerCase(), t]));

        const shared = [];
        const myOnly = [];
        const theirOnly = [];

        for (const [name, t] of myNames) {
          if (theirNames.has(name)) {
            const other = theirNames.get(name);
            shared.push({
              name: t.name,
              my_depth: t.message_count || 0,
              their_depth: other.message_count || 0,
              my_essence: t.essence,
              their_essence: other.essence,
            });
          } else {
            myOnly.push({ name: t.name, essence: t.essence, message_count: t.message_count || 0 });
          }
        }
        for (const [name, t] of theirNames) {
          if (!myNames.has(name)) {
            theirOnly.push({ name: t.name, essence: t.essence, message_count: t.message_count || 0 });
          }
        }

        // Match score: min 3 shared to compute percentage
        const union = shared.length + myOnly.length + theirOnly.length;
        let matchScore = null;
        if (shared.length >= 3 && union > 0) {
          // Weight by territory size
          const sharedWeight = shared.reduce((s, t) => s + t.my_depth + t.their_depth, 0);
          const totalWeight = sharedWeight
            + myOnly.reduce((s, t) => s + t.message_count, 0)
            + theirOnly.reduce((s, t) => s + t.message_count, 0);
          matchScore = totalWeight > 0 ? Math.round(sharedWeight / totalWeight * 100) : 0;
        }

        // Shape classification
        let shape = 'early';
        if (shared.length >= 3) {
          const overlapRatio = shared.length / union;
          const depthBalance = shared.reduce((s, t) => {
            const max = Math.max(t.my_depth, t.their_depth, 1);
            return s + Math.min(t.my_depth, t.their_depth) / max;
          }, 0) / shared.length;

          if (overlapRatio > 0.6 && depthBalance > 0.5) shape = 'twin';
          else if (overlapRatio > 0.4 && depthBalance > 0.4) shape = 'deep-collaborators';
          else if (overlapRatio > 0.3) shape = 'broad-kindred';
          else if (myOnly.length > shared.length * 2 || theirOnly.length > shared.length * 2) shape = 'complementary';
          else shape = 'asymmetric';
        }

        const shapeLabels = {
          'twin': 'Twin Minds',
          'deep-collaborators': 'Deep Collaborators',
          'broad-kindred': 'Broad Kindred Spirits',
          'complementary': 'Complementary Thinkers',
          'asymmetric': 'Asymmetric',
          'early': 'Early Connection',
        };

        const overlap = {
          shared,
          myOnly: myOnly.slice(0, 10),
          theirOnly: theirOnly.slice(0, 10),
          matchScore,
          shape,
          shapeLabel: shapeLabels[shape] || shape,
          sharedCount: shared.length,
          myTotalVisible: myList.length,
          theirTotalVisible: theirList.length,
          computedAt: new Date().toISOString(),
        };

        // Cache
        await d1Query(
          `UPDATE connections SET overlap_json = ?, overlap_computed_at = datetime('now') WHERE id = ?`,
          [JSON.stringify(overlap), connectionId],
        );

        return overlap;
      },
    },

    // ── Sharing Contexts ──────────────────────────────────────────────────────

    contexts: {
      async list(userId) {
        const result = await d1Query(
          `SELECT sc.*, COUNT(ct.territory_id) as territory_count
           FROM sharing_contexts sc
           LEFT JOIN context_territories ct ON ct.context_id = sc.id
           WHERE sc.user_id = ?
           GROUP BY sc.id ORDER BY sc.is_default DESC, sc.created_at`,
          [userId],
        );
        return result.results || [];
      },

      async create(userId, { name, is_private = false }) {
        if (!name || name.length > 50) throw new Error('Name required (max 50 chars)');
        const id = crypto.randomUUID();
        await d1Query(
          `INSERT INTO sharing_contexts (id, user_id, name, is_private, created_at)
           VALUES (?, ?, ?, ?, datetime('now'))`,
          [id, userId, name, is_private ? 1 : 0],
        );
        return id;
      },

      async rename(userId, contextId, name) {
        if (!name || name.length > 50) throw new Error('Name required (max 50 chars)');
        await d1Query(
          `UPDATE sharing_contexts SET name = ? WHERE id = ? AND user_id = ? AND is_default = 0`,
          [name, contextId, userId],
        );
      },

      async remove(userId, contextId) {
        await d1Query(
          `DELETE FROM sharing_contexts WHERE id = ? AND user_id = ? AND is_default = 0`,
          [contextId, userId],
        );
      },

      async addTerritory(contextId, territoryId) {
        await d1Query(
          `INSERT OR IGNORE INTO context_territories (context_id, territory_id, added_at)
           VALUES (?, ?, datetime('now'))`,
          [contextId, territoryId],
        );
      },

      async removeTerritory(contextId, territoryId) {
        await d1Query(
          `DELETE FROM context_territories WHERE context_id = ? AND territory_id = ?`,
          [contextId, territoryId],
        );
      },

      async getTerritories(contextId) {
        const result = await d1Query(
          `SELECT ct.territory_id, tp.name, tp.essence, tp.realm_id
           FROM context_territories ct
           LEFT JOIN territory_profiles tp ON tp.territory_id = ct.territory_id
           WHERE ct.context_id = ?`,
          [contextId],
        );
        return result.results || [];
      },

      async grant(contextId, connectionId) {
        await d1Query(
          `INSERT OR IGNORE INTO context_grants (context_id, connection_id, granted_at)
           VALUES (?, ?, datetime('now'))`,
          [contextId, connectionId],
        );
      },

      async revoke(contextId, connectionId) {
        await d1Query(
          `DELETE FROM context_grants WHERE context_id = ? AND connection_id = ?`,
          [contextId, connectionId],
        );
      },

      async getGrants(contextId) {
        const result = await d1Query(
          `SELECT cg.connection_id, c.user_a, c.user_b, up.handle
           FROM context_grants cg
           JOIN connections c ON c.id = cg.connection_id
           LEFT JOIN user_profiles up ON up.user_id = c.user_a OR up.user_id = c.user_b
           WHERE cg.context_id = ?`,
          [contextId],
        );
        return result.results || [];
      },

      /** Ensure default contexts exist for a user */
      async ensureDefaults(userId) {
        const defaults = [
          { name: 'Work Self', is_private: false },
          { name: 'Social Self', is_private: false },
          { name: 'Creative Self', is_private: false },
          { name: 'Private Self', is_private: true },
        ];
        for (const ctx of defaults) {
          await d1Query(
            `INSERT OR IGNORE INTO sharing_contexts (id, user_id, name, is_private, is_default, created_at)
             VALUES (?, ?, ?, ?, 1, datetime('now'))`,
            [crypto.randomUUID(), userId, ctx.name, ctx.is_private ? 1 : 0],
          );
        }
      },

      /** Check if user B can see user A's territory via context grants */
      async canSeeTerritory(ownerUserId, viewerUserId, territoryId) {
        // Check if territory is in any context granted to a connection involving viewerUserId
        const result = await d1Query(
          `SELECT 1 FROM context_territories ct
           JOIN context_grants cg ON cg.context_id = ct.context_id
           JOIN connections c ON c.id = cg.connection_id AND c.status = 'accepted'
           JOIN sharing_contexts sc ON sc.id = ct.context_id AND sc.user_id = ? AND sc.is_private = 0
           WHERE ct.territory_id = ? AND (c.user_a = ? OR c.user_b = ?)
           LIMIT 1`,
          [ownerUserId, territoryId, viewerUserId, viewerUserId],
        );
        return (result.results?.length || 0) > 0;
      },
    },

    // ── Audit Logging ──
    audit: {
      /** Fire-and-forget audit log entry — never blocks the caller. */
      async log({ action, agentId, userId, ip, resourceType, resourceId, details }) {
        try {
          await d1QueryAdmin(
            `INSERT INTO audit_log (id, event_type, agent_id, user_id, ip_address, endpoint, method, details, success, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`,
            [crypto.randomUUID(), action, agentId || process.env.AGENT_ID, userId, ip,
             resourceType, resourceId, details ? JSON.stringify(details) : null],
          );
        } catch (e) {
          console.error('[audit] Write failed:', e.message);
        }
      },

      /** Query recent audit events. */
      async recent({ limit = 50, eventType, userId } = {}) {
        let sql = 'SELECT * FROM audit_log WHERE 1=1';
        const params = [];
        if (eventType) { sql += ' AND event_type = ?'; params.push(eventType); }
        if (userId) { sql += ' AND user_id = ?'; params.push(userId); }
        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);
        const result = await d1QueryAdmin(sql, params);
        return result.results || [];
      },
    },
  };

  // Wire scope violation audit callback — persists violations to audit_log.
  // crypto-local.js has no DB dependency, so we provide the callback here.
  setAuditCallback((action, details) => {
    db.audit.log({ action, agentId: process.env.AGENT_ID, details }).catch(() => {});
  });

  return db;
}

/**
 * Map a scale name to the cofire column. The territory_cofire table has four
 * timescale columns with different half-lives. Safe to interpolate into SQL
 * because the set of valid values is fixed.
 */
function cofireCol(scale) {
  return ({
    immediate: 'cofire_immediate',
    session: 'cofire_session',
    daily: 'cofire_daily',
    weekly: 'cofire_weekly',
  })[scale] || 'cofire_session';
}

/**
 * Safely parse JSON string, returning the original value if parsing fails.
 */
function parseJson(val) {
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch { return val; }
}
