/**
 * Local AES-256-GCM encryption & decryption — Node.js port of worker/src/services/crypto.ts
 *
 * Uses Node.js WebCrypto (crypto.subtle) which is API-compatible with
 * the Cloudflare Workers crypto. Zero npm dependencies.
 *
 * This is the ONLY place the master key is used. The Cloudflare Worker
 * never has the master key — it stores and returns ciphertext only.
 */

import { webcrypto } from 'crypto';
import { openSync, readSync, closeSync, existsSync } from 'fs';
const { subtle } = webcrypto;

// sodium-native loaded lazily via dynamic import — only needed when reading
// from tmpfs. Keeps the module loadable in environments without sodium installed.
let _sodium = null;
let _sodiumPromise = null;
async function getSodium() {
  if (_sodium) return _sodium;
  if (_sodiumPromise) return _sodiumPromise;
  _sodiumPromise = (async () => {
    try {
      const mod = await import('sodium-native');
      _sodium = mod.default || mod;
    } catch {
      _sodium = null;
    }
    return _sodium;
  })();
  return _sodiumPromise;
}

const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;
const DEK_BITS = 256;
const TAG_LENGTH = 128;
const HKDF_HASH = 'SHA-256';
const HKDF_SALT = new Uint8Array(32);

// Tmpfs path for the master key. RAM-only, lost on reboot.
// Set up via /etc/fstab in scripts/server-setup.sh.
const TMPFS_KEY_PATH = '/run/mycelium/master.key';

const scopeKeyCache = new Map();

/** Custom error for scope access violations — distinguishes from crypto/corruption errors. */
class ScopeViolationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScopeViolationError';
  }
}

/** Audit callback — set by db-d1.js to persist scope violations to audit_log. */
let _auditCallback = null;
function setAuditCallback(fn) { _auditCallback = fn; }

// ── Encrypted fields per table (must match Worker's ENCRYPTED_FIELDS) ──

const ENCRYPTED_FIELDS = {
  messages: ['content', 'thinking'],
  documents: ['content', 'summary'],
  attachments: ['transcript'],
  clustering_points: ['content'],
  agent_events: ['payload'],
  agent_tasks: ['context', 'result'],
  people: ['name', 'aliases', 'description', 'metadata', 'email', 'phone', 'company', 'position', 'linkedin_url'],
  wealth_transactions: ['notes'],
  wealth_positions: ['total_cost', 'current_value', 'unrealized_pnl', 'avg_cost_basis'],
  wealth_snapshots: ['total_value', 'total_invested', 'total_pnl', 'day_change'],
  health_daily: ['sleep_duration_min', 'sleep_in_bed_min', 'sleep_efficiency', 'sleep_deep_min', 'sleep_rem_min', 'sleep_core_min', 'sleep_awake_min', 'sleep_start', 'sleep_end', 'hrv_avg', 'hrv_sleep_avg', 'resting_hr', 'steps', 'active_energy_kcal', 'workout_count', 'workout_minutes', 'workout_types', 'mindful_minutes'],
};

// ── Base64 helpers ──

function toBase64(buf) {
  return Buffer.from(buf).toString('base64');
}

function fromBase64(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// ── Detection ──

function isEncrypted(value) {
  if (typeof value !== 'string' || value.length < 20) return false;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const obj = JSON.parse(decoded);
    return !!(obj.v === 1 && obj.s && obj.iv && obj.ct && obj.dk);
  } catch { return false; }
}

function getEncryptedFields(table) {
  return ENCRYPTED_FIELDS[table] || [];
}

// ── Master Key Import ──

async function importMasterKey(hexKey) {
  if (!hexKey || hexKey.length !== 64) {
    throw new Error('ENCRYPTION_MASTER_KEY must be 64 hex chars (256 bits)');
  }
  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    keyBytes[i] = parseInt(hexKey.substring(i * 2, i * 2 + 2), 16);
  }
  return subtle.importKey('raw', keyBytes, 'HKDF', false, ['deriveBits', 'deriveKey']);
}

/**
 * Read master key hex from tmpfs (RAM-only filesystem at /run/mycelium/master.key).
 *
 * Falls back to process.env.ENCRYPTION_MASTER_KEY for backwards compat during
 * the transition. Logs a security warning when the fallback is used so we can
 * detect deployments that haven't migrated yet.
 *
 * @returns {string|null} 64-char hex string or null if not available
 */
function readMasterKeyHex() {
  // Try tmpfs first (preferred — never on disk)
  try {
    if (existsSync(TMPFS_KEY_PATH)) {
      const fd = openSync(TMPFS_KEY_PATH, 'r');
      try {
        const buf = Buffer.alloc(64);
        const bytesRead = readSync(fd, buf, 0, 64, 0);
        if (bytesRead === 64) {
          const hex = buf.toString('utf8');
          // Validate format
          if (/^[0-9a-fA-F]{64}$/.test(hex)) {
            // Zero the temp buffer
            buf.fill(0);
            return hex;
          }
          buf.fill(0);
        }
      } finally {
        closeSync(fd);
      }
    }
  } catch { /* fall through to env */ }

  // Fallback: process.env (insecure — log warning)
  const envKey = process.env.ENCRYPTION_MASTER_KEY;
  if (envKey) {
    if (!global._masterKeyFallbackWarned) {
      console.warn('⚠️  SECURITY: Reading master key from process.env (insecure). Migrate to tmpfs via scripts/migrate-key-to-tmpfs.sh');
      global._masterKeyFallbackWarned = true;
    }
    return envKey;
  }

  return null;
}

/**
 * Import master key directly from tmpfs into a CryptoKey, using sodium SecureBuffer
 * for the intermediate hex/key bytes. Avoids V8 string interning of key material.
 *
 * Falls back to plain importMasterKey() if sodium-native is unavailable.
 *
 * @returns {Promise<CryptoKey|null>} Imported key or null if no key available
 */
async function importMasterKeyFromTmpfs() {
  const sodium = await getSodium();

  // Fallback: no sodium-native installed → use regular importMasterKey
  if (!sodium) {
    const hex = readMasterKeyHex();
    if (!hex) return null;
    return importMasterKey(hex);
  }

  // No tmpfs file? Fall back to env-based import
  if (!existsSync(TMPFS_KEY_PATH)) {
    const hex = readMasterKeyHex();
    if (!hex) return null;
    return importMasterKey(hex);
  }

  // Allocate mlock'd, non-dumpable buffer for hex string (64 bytes)
  const hexBuf = sodium.sodium_malloc(64);

  // Read directly into the secure buffer
  let fd;
  try {
    fd = openSync(TMPFS_KEY_PATH, 'r');
    const bytesRead = readSync(fd, hexBuf, 0, 64, 0);
    if (bytesRead !== 64) {
      sodium.sodium_memzero(hexBuf);
      throw new Error(`Master key file: expected 64 bytes, got ${bytesRead}`);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  // Decode hex into a 32-byte secure buffer using pure arithmetic.
  // Avoids String.fromCharCode + parseInt which would create temporary
  // V8 strings (potentially interned) containing key material.
  const hexNibble = (b) => {
    if (b >= 0x30 && b <= 0x39) return b - 0x30;        // 0-9
    if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;   // A-F
    if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;   // a-f
    return -1;
  };

  const keyBuf = sodium.sodium_malloc(32);
  for (let i = 0; i < 32; i++) {
    const high = hexNibble(hexBuf[i * 2]);
    const low = hexNibble(hexBuf[i * 2 + 1]);
    if (high < 0 || low < 0) {
      sodium.sodium_memzero(hexBuf);
      sodium.sodium_memzero(keyBuf);
      throw new Error('Invalid hex character in master key');
    }
    keyBuf[i] = (high << 4) | low;
  }

  // Zero the hex buffer immediately — we have the raw bytes now
  sodium.sodium_memzero(hexBuf);

  // Import as CryptoKey (key bytes copied into opaque CryptoKey object)
  const cryptoKey = await subtle.importKey('raw', keyBuf, 'HKDF', false, ['deriveBits', 'deriveKey']);

  // Zero the raw key buffer — the CryptoKey object holds its own copy
  sodium.sodium_memzero(keyBuf);

  return cryptoKey;
}

// ── Scope Key Derivation ──

// ── Per-User Key Derivation (envelope v2) ──

const userKeyCache = new Map();

/**
 * Derive a per-user intermediate key from the master key.
 * This adds user-level isolation: even with the same master key,
 * different users produce different scope keys → different ciphertexts.
 *
 * Key hierarchy:
 *   masterKey → HKDF("mycelium:user:<userId>:v1") → userKey
 *            → HKDF("mycelium:scope:<scope>:v1") → scopeKey
 */
async function deriveUserKey(masterKey, userId) {
  if (userKeyCache.has(userId)) return userKeyCache.get(userId);
  const info = new TextEncoder().encode(`mycelium:user:${userId}:v1`);
  const derivedBits = await subtle.deriveBits(
    { name: 'HKDF', hash: HKDF_HASH, salt: HKDF_SALT, info },
    masterKey,
    DEK_BITS,
  );
  const userKey = await subtle.importKey('raw', derivedBits, 'HKDF', false, ['deriveBits', 'deriveKey']);
  userKeyCache.set(userId, userKey);
  return userKey;
}

// ── Scope Key Derivation ──

async function deriveScopeKey(baseKey, scope, usage = ['wrapKey', 'unwrapKey']) {
  const cacheKey = `${scope}:${usage.join(',')}`;
  const cached = scopeKeyCache.get(cacheKey);
  if (cached) return cached;

  const info = new TextEncoder().encode(`mycelium:scope:${scope}:v1`);
  const derivedBits = await subtle.deriveBits(
    { name: 'HKDF', hash: HKDF_HASH, salt: HKDF_SALT, info },
    baseKey,
    DEK_BITS,
  );
  const scopeKey = await subtle.importKey('raw', derivedBits, 'AES-KW', false, usage);
  scopeKeyCache.set(cacheKey, scopeKey);
  return scopeKey;
}

// ── Scope Inference ──

function inferScope(ctx) {
  if (ctx.scope) return ctx.scope;

  if (ctx.source === 'telegram' || ctx.source === 'whatsapp') {
    if (ctx.agent_id === 'moms-agent') return 'moms';
    return 'personal';
  }

  if (ctx.path) {
    const p = ctx.path.toLowerCase();
    if (p.startsWith('mind/') || p.startsWith('internal/') || p.startsWith('transcriptions/') || p.startsWith('states/')) {
      if (ctx.agent_id === 'moms-agent') return 'moms';
      return 'personal';
    }
    if (p.startsWith('wealth/')) return 'wealth';
  }

  if (ctx.table) {
    if (ctx.table === 'people') return 'personal';
    if (ctx.table === 'health_daily') return 'personal';
    if (ctx.table.startsWith('wealth_')) return 'wealth';
  }

  if (ctx.agent_id) {
    if (ctx.agent_id === 'wealth-agent') return 'wealth';
    if (ctx.agent_id === 'moms-agent') return 'moms';
    if (ctx.agent_id === 'personal-agent' || ctx.agent_id === 'mya-personal') return 'personal';
  }

  return 'org';
}

// ── Encrypt ──

async function encrypt(plaintext, scope, masterKey, userId = null) {
  // v2: derive per-user key first, then scope key from user key
  // v1: derive scope key directly from master key (backward compat)
  let baseKey = masterKey;
  let version = ENVELOPE_VERSION;
  if (userId) {
    baseKey = await deriveUserKey(masterKey, userId);
    version = 2;
  }
  const scopeKey = await deriveScopeKey(baseKey, scope, ['wrapKey']);

  // Generate random DEK
  const dek = await subtle.generateKey(
    { name: 'AES-GCM', length: DEK_BITS },
    true,
    ['encrypt', 'decrypt'],
  );

  // Generate random IV
  const iv = webcrypto.getRandomValues(new Uint8Array(IV_BYTES));

  // Encrypt content with DEK
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: TAG_LENGTH },
    dek,
    plaintextBytes,
  );

  // Wrap DEK with scope key
  const wrappedDek = await subtle.wrapKey('raw', dek, scopeKey, 'AES-KW');

  // Build envelope
  const envelope = {
    v: version,
    s: scope,
    iv: toBase64(iv),
    ct: toBase64(ciphertext),
    dk: toBase64(wrappedDek),
  };
  if (version === 2) envelope.u = userId;

  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

// ── Decrypt ──

async function decrypt(encoded, masterKey, allowedScopes = null) {
  const envelope = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (envelope.v !== 1 && envelope.v !== 2) throw new Error(`Unknown envelope version: ${envelope.v}`);

  if (allowedScopes && !allowedScopes.includes(envelope.s)) {
    throw new ScopeViolationError(`Scope denied: "${envelope.s}" not in [${allowedScopes}]`);
  }

  // v2: derive per-user key first, then scope key from it
  // v1: derive scope key directly from master key (backward compat)
  let baseKey = masterKey;
  if (envelope.v === 2 && envelope.u) {
    baseKey = await deriveUserKey(masterKey, envelope.u);
  }
  const scopeKey = await deriveScopeKey(baseKey, envelope.s, ['unwrapKey']);

  const wrappedDk = fromBase64(envelope.dk);
  const dek = await subtle.unwrapKey(
    'raw',
    wrappedDk.buffer.slice(wrappedDk.byteOffset, wrappedDk.byteOffset + wrappedDk.byteLength),
    scopeKey,
    'AES-KW',
    { name: 'AES-GCM', length: DEK_BITS },
    false,
    ['decrypt'],
  );

  const iv = fromBase64(envelope.iv);
  const ct = fromBase64(envelope.ct);
  const decrypted = await subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength), tagLength: TAG_LENGTH },
    dek,
    ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength),
  );

  return new TextDecoder().decode(decrypted);
}

// ── Batch field helpers ──

async function encryptFields(record, fields, scope, masterKey) {
  const result = { ...record };
  for (const field of fields) {
    const value = result[field];
    if (typeof value === 'string' && value.length > 0 && !isEncrypted(value)) {
      result[field] = await encrypt(value, scope, masterKey);
    }
  }
  return result;
}

async function decryptFields(record, masterKey, allowedScopes = null) {
  const result = { ...record };
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'string' && isEncrypted(value)) {
      try {
        result[key] = await decrypt(value, masterKey, allowedScopes);
      } catch (err) {
        if (err instanceof ScopeViolationError) {
          console.error(`[SCOPE VIOLATION] field="${key}" ${err.message}`);
          _auditCallback?.('scope.violation', { field: key, scope: err.message });
        } else {
          console.warn(`[DECRYPT ERROR] field="${key}": ${err.message}`);
          // Corrupted or incompatible data — leave as-is
        }
      }
    }
  }
  return result;
}

// ── SQL parsing (ported from Worker db-proxy.ts) ──

function parseWriteSQL(sql) {
  const trimmed = sql.trimStart().toUpperCase();

  if (trimmed.startsWith('INSERT')) {
    const match = sql.match(/INSERT\s+(?:OR\s+(?:REPLACE|IGNORE)\s+)?INTO\s+(\w+)\s*\(([^)]+)\)/i);
    if (!match) return null;
    const table = match[1];
    const columns = match[2].split(',').map(c => c.trim());
    const encrypted = getEncryptedFields(table);
    if (!encrypted.length) return null;
    const encryptedColumnIndices = [];
    for (let i = 0; i < columns.length; i++) {
      if (encrypted.includes(columns[i])) encryptedColumnIndices.push(i);
    }
    if (!encryptedColumnIndices.length) return null;
    return { type: 'insert', table, columns, encryptedColumnIndices };
  }

  if (trimmed.startsWith('UPDATE')) {
    const tableMatch = sql.match(/UPDATE\s+(\w+)\s+SET/i);
    if (!tableMatch) return null;
    const table = tableMatch[1];
    const encrypted = getEncryptedFields(table);
    if (!encrypted.length) return null;

    const setMatch = sql.match(/SET\s+(.+?)(?:\s+WHERE|\s+ORDER|\s+LIMIT|\s+RETURNING|;|$)/i);
    if (!setMatch) return null;
    const assignments = setMatch[1].split(',').map(s => s.trim());
    const encryptedParamIndices = [];
    let paramIndex = 0;
    for (const assign of assignments) {
      const colMatch = assign.match(/^(\w+)\s*=\s*(.+)/);
      if (!colMatch) continue;
      const col = colMatch[1];
      const value = colMatch[2].trim();
      const qCount = (value.match(/\?/g) || []).length;
      if (qCount === 1 && encrypted.includes(col)) {
        encryptedParamIndices.push(paramIndex);
      }
      paramIndex += qCount;
    }
    if (!encryptedParamIndices.length) return null;
    return { type: 'update', table, encryptedParamIndices };
  }

  return null;
}

function extractFirstValuesGroup(sql) {
  const match = sql.match(/VALUES\s*\((.+?)\)/i);
  return match ? match[1] : null;
}

function splitValueExprs(valuesContent) {
  const exprs = [];
  let depth = 0;
  let current = '';
  for (const ch of valuesContent) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      exprs.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) exprs.push(current.trim());
  return exprs;
}

/**
 * Auto-encrypt params in INSERT/UPDATE SQL statements.
 * Modifies params array in-place. Returns potentially modified SQL (scope injection).
 */
async function autoEncryptParams(sql, params, scope, masterKey, userId = null) {
  const parsed = parseWriteSQL(sql);
  if (!parsed) return sql;

  if (parsed.type === 'insert') {
    const { columns, encryptedColumnIndices } = parsed;
    const valuesContent = extractFirstValuesGroup(sql);
    if (!valuesContent) return sql;
    const valueExprs = splitValueExprs(valuesContent);

    const colToParamIdx = new Map();
    let pIdx = 0;
    for (let i = 0; i < valueExprs.length; i++) {
      if (valueExprs[i] === '?') {
        colToParamIdx.set(i, pIdx++);
      }
    }
    const paramsPerRow = pIdx;
    const numRows = paramsPerRow > 0 ? Math.floor(params.length / paramsPerRow) : 0;

    for (let row = 0; row < numRows; row++) {
      for (const colIdx of encryptedColumnIndices) {
        const paramPos = colToParamIdx.get(colIdx);
        if (paramPos === undefined) continue;
        const absIdx = row * paramsPerRow + paramPos;
        const value = params[absIdx];
        if (typeof value === 'string' && value.length > 0 && !isEncrypted(value)) {
          params[absIdx] = await encrypt(value, scope, masterKey, userId);
        }
      }
    }

    // Inject scope column if not present
    if (!columns.includes('scope')) {
      sql = sql.replace(
        /INSERT(\s+(?:OR\s+(?:REPLACE|IGNORE)\s+)?INTO\s+\w+\s*)\(([^)]+)\)/i,
        (_, prefix, cols) => `INSERT${prefix}(${cols}, scope)`,
      );
      const newValueExprs = [...valueExprs, '?'];
      const newRowTemplate = `(${newValueExprs.join(', ')})`;
      const allTemplates = new Array(numRows).fill(newRowTemplate).join(', ');
      sql = sql.replace(
        /VALUES\s+.+?(?=\s+ON\s+CONFLICT|\s+RETURNING|;|$)/is,
        `VALUES ${allTemplates}`,
      );
      const newParams = [];
      for (let row = 0; row < numRows; row++) {
        for (let i = 0; i < paramsPerRow; i++) {
          newParams.push(params[row * paramsPerRow + i]);
        }
        newParams.push(scope);
      }
      params.length = 0;
      params.push(...newParams);
    }
  } else if (parsed.type === 'update') {
    for (const paramIdx of parsed.encryptedParamIndices) {
      const value = params[paramIdx];
      if (typeof value === 'string' && value.length > 0 && !isEncrypted(value)) {
        params[paramIdx] = await encrypt(value, scope, masterKey, userId);
      }
    }
  }

  return sql;
}

/**
 * Auto-decrypt all encrypted values in query result rows.
 * @param {Array} rows — query results
 * @param {CryptoKey} masterKey
 * @param {string[]|null} allowedScopes — if set, only these scopes will be decrypted
 */
async function autoDecryptResults(rows, masterKey, allowedScopes = null) {
  if (!rows || !rows.length) return rows;

  const decrypted = [];
  for (const row of rows) {
    const newRow = { ...row };
    for (const [key, value] of Object.entries(newRow)) {
      if (typeof value === 'string' && isEncrypted(value)) {
        try {
          newRow[key] = await decrypt(value, masterKey, allowedScopes);
        } catch (err) {
          if (err instanceof ScopeViolationError) {
            console.error(`[SCOPE VIOLATION] field="${key}" ${err.message}`);
            _auditCallback?.('scope.violation', { field: key, scope: err.message });
          } else {
            console.warn(`[DECRYPT ERROR] field="${key}": ${err.message}`);
          }
          // Leave as ciphertext
        }
      }
    }
    decrypted.push(newRow);
  }
  return decrypted;
}

/**
 * Clear the master key hex string from process.env after scope keys are cached.
 * The CryptoKey objects are opaque (can't be extracted), but the hex string
 * in process.env is readable by any code in the process. Clearing it reduces
 * the exposure window — scope keys remain cached for actual crypto operations.
 */
function clearMasterKeyFromEnv() {
  if (process.env.ENCRYPTION_MASTER_KEY) {
    delete process.env.ENCRYPTION_MASTER_KEY;
    console.log('[crypto] Master key cleared from process.env (scope keys cached)');
  }
}

export {
  importMasterKey,
  importMasterKeyFromTmpfs,
  readMasterKeyHex,
  encrypt,
  decrypt,
  isEncrypted,
  inferScope,
  getEncryptedFields,
  encryptFields,
  decryptFields,
  autoEncryptParams,
  autoDecryptResults,
  clearMasterKeyFromEnv,
  setAuditCallback,
  ScopeViolationError,
  ENCRYPTED_FIELDS,
};
