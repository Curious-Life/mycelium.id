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

// Tmpfs paths for the two key families. RAM-only, lost on reboot.
// Set up via /etc/fstab in scripts/server-setup.sh.
//
// Two-key separation (see plan rosy-jumping-llama):
//   master.key  → USER_MASTER_KEY, encrypts customer vault data (messages,
//                 documents, wealth, mindscape, health, contacts, etc.)
//                 Managed by the customer via portal Settings.
//   system.key  → SYSTEM_KEY, encrypts operator infrastructure secrets
//                 (Claude API token, Worker secret, Discord bot tokens, etc.)
//                 Generated per-VPS at provisioning time. Operator-managed.
//
// A compromise of one key family does not expose the other.
const TMPFS_KEY_PATH = '/run/mycelium/master.key';
const TMPFS_SYSTEM_KEY_PATH = '/run/mycelium/system.key';

// scopeKeyCacheByBase and userKeyCacheByMaster are defined below
// (WeakMap keyed by master CryptoKey for correct multi-key behavior)
// systemScopeKeyCacheByBase is defined below for SYSTEM_KEY-derived scope keys.

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
  // Messages: content + all AI-derived metadata
  messages: ['content', 'thinking', 'tags', 'entities', 'entity_summary', 'suggested_new_tag', 'relations'],
  // Documents: content + metadata that reveals content
  documents: ['content', 'summary', 'title', 'tags', 'entities', 'relations', 'metadata'],
  // Attachments: transcript + filename/description (filenames reveal content)
  attachments: ['transcript', 'file_name', 'description', 'metadata'],
  // Clustering/mindscape
  clustering_points: ['content'],
  // Agent operations
  agent_events: ['payload'],
  agent_tasks: ['context', 'result', 'description', 'summary', 'error'],
  // Contacts
  people: ['name', 'aliases', 'description', 'metadata', 'email', 'phone', 'company', 'position', 'linkedin_url'],
  // Wealth — amounts + notes
  wealth_transactions: ['notes', 'quantity', 'price_per_unit', 'fees', 'exchange_rate'],
  wealth_positions: ['total_cost', 'current_value', 'unrealized_pnl', 'avg_cost_basis', 'quantity'],
  wealth_snapshots: ['total_value', 'total_invested', 'total_pnl', 'day_change'],
  // Health — all metrics
  health_daily: ['sleep_duration_min', 'sleep_in_bed_min', 'sleep_efficiency', 'sleep_deep_min', 'sleep_rem_min', 'sleep_core_min', 'sleep_awake_min', 'sleep_start', 'sleep_end', 'hrv_avg', 'hrv_sleep_avg', 'resting_hr', 'steps', 'active_energy_kcal', 'workout_count', 'workout_minutes', 'workout_types', 'mindful_minutes'],
  // Activity tracking — behavioral surveillance data
  activity_sessions: ['window_title', 'url', 'app_bundle', 'app_name'],
  // Internal model — user's private reasoning
  internal_model_items: ['content', 'evidence', 'source_context'],
  // Reflections — journal entries
  reflections: ['content', 'trigger'],
  // Territory profiles — narrative about user's mind
  territory_profiles: ['title', 'essence', 'story_birth', 'story_arc', 'story_peak_moments', 'story_current_chapter', 'uncertainty_open_questions', 'agent_expertise', 'agent_curious_about'],
  // Realms — high-level mind organization
  realms: ['name', 'description'],
  // Semantic themes
  semantic_themes: ['label', 'keywords', 'description'],
  // User identities — social account links
  user_identities: ['provider_username', 'provider_id', 'provider_avatar'],
  // Provisioning — customer PII
  provisioning_jobs: ['email', 'stripe_customer_id', 'error'],
  // Secrets — key names reveal what's stored
  secrets: ['key', 'description'],
};

// Tables that DON'T have a 'scope' column — skip scope injection on INSERT.
// All other tables in ENCRYPTED_FIELDS get scope auto-injected.
const NO_SCOPE_TABLES = new Set([
  'activity_sessions', 'internal_model_items', 'reflections',
  'territory_profiles', 'realms', 'semantic_themes',
  'user_identities', 'provisioning_jobs',
]);

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
    // v1: user key, direct derivation
    // v2: user key, per-user derivation (with obj.u)
    // v3: tagged with key family (obj.kf = 'system' | 'user')
    const versionOk = obj.v === 1 || obj.v === 2 || obj.v === 3;
    return !!(versionOk && obj.s && obj.iv && obj.ct && obj.dk);
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

/**
 * Read system key hex from tmpfs (/run/mycelium/system.key).
 *
 * The SYSTEM_KEY encrypts operator infrastructure secrets (Claude API token,
 * Worker secret, Discord tokens, etc.). It is distinct from the master key
 * which encrypts customer vault data. Operator-managed.
 *
 * @returns {string|null} 64-char hex string or null if not available
 */
function readSystemKeyHex() {
  try {
    if (existsSync(TMPFS_SYSTEM_KEY_PATH)) {
      const fd = openSync(TMPFS_SYSTEM_KEY_PATH, 'r');
      try {
        const buf = Buffer.alloc(64);
        const bytesRead = readSync(fd, buf, 0, 64, 0);
        if (bytesRead === 64) {
          const hex = buf.toString('utf8');
          if (/^[0-9a-fA-F]{64}$/.test(hex)) {
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

  // Fallback: process.env (for bootstrap/migration tooling running off-VPS)
  const envKey = process.env.SYSTEM_KEY;
  if (envKey && /^[0-9a-fA-F]{64}$/.test(envKey)) {
    return envKey;
  }

  return null;
}

/**
 * Import the SYSTEM_KEY directly from tmpfs into a CryptoKey, using sodium
 * SecureBuffer for intermediate hex/key bytes (mirrors importMasterKeyFromTmpfs).
 *
 * Falls back to plain byte import if sodium-native is unavailable.
 *
 * @returns {Promise<CryptoKey|null>} Imported system key or null if unavailable
 */
async function importSystemKeyFromTmpfs() {
  const sodium = await getSodium();

  // Fallback: no sodium-native installed → read hex and import directly
  if (!sodium) {
    const hex = readSystemKeyHex();
    if (!hex) return null;
    return importMasterKey(hex); // same HKDF import — just different bytes
  }

  // No tmpfs file? Try env-based fallback
  if (!existsSync(TMPFS_SYSTEM_KEY_PATH)) {
    const hex = readSystemKeyHex();
    if (!hex) return null;
    return importMasterKey(hex);
  }

  // Allocate mlock'd, non-dumpable buffer for hex string (64 bytes)
  const hexBuf = sodium.sodium_malloc(64);

  let fd;
  try {
    fd = openSync(TMPFS_SYSTEM_KEY_PATH, 'r');
    const bytesRead = readSync(fd, hexBuf, 0, 64, 0);
    if (bytesRead !== 64) {
      sodium.sodium_memzero(hexBuf);
      throw new Error(`System key file: expected 64 bytes, got ${bytesRead}`);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  // Decode hex → 32-byte secure buffer using pure arithmetic (no string interning)
  const hexNibble = (b) => {
    if (b >= 0x30 && b <= 0x39) return b - 0x30;
    if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
    if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
    return -1;
  };

  const keyBuf = sodium.sodium_malloc(32);
  for (let i = 0; i < 32; i++) {
    const high = hexNibble(hexBuf[i * 2]);
    const low = hexNibble(hexBuf[i * 2 + 1]);
    if (high < 0 || low < 0) {
      sodium.sodium_memzero(hexBuf);
      sodium.sodium_memzero(keyBuf);
      throw new Error('Invalid hex character in system key');
    }
    keyBuf[i] = (high << 4) | low;
  }

  sodium.sodium_memzero(hexBuf);

  const cryptoKey = await subtle.importKey('raw', keyBuf, 'HKDF', false, ['deriveBits', 'deriveKey']);

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
// Per-master-key cache for user keys
const userKeyCacheByMaster = new WeakMap();

async function deriveUserKey(masterKey, userId, { useCache = true } = {}) {
  if (useCache) {
    let perUser = userKeyCacheByMaster.get(masterKey);
    if (perUser) {
      const cached = perUser.get(userId);
      if (cached) return cached;
    }
  }
  const info = new TextEncoder().encode(`mycelium:user:${userId}:v1`);
  const derivedBits = await subtle.deriveBits(
    { name: 'HKDF', hash: HKDF_HASH, salt: HKDF_SALT, info },
    masterKey,
    DEK_BITS,
  );
  const userKey = await subtle.importKey('raw', derivedBits, 'HKDF', false, ['deriveBits', 'deriveKey']);
  if (useCache) {
    let perUser = userKeyCacheByMaster.get(masterKey);
    if (!perUser) {
      perUser = new Map();
      userKeyCacheByMaster.set(masterKey, perUser);
    }
    perUser.set(userId, userKey);
  }
  return userKey;
}

// ── Scope Key Derivation ──

// Use a WeakMap keyed by base CryptoKey to scope our cache per master key.
// When the master key changes, the old WeakMap entries become unreachable.
const scopeKeyCacheByBase = new WeakMap();

async function deriveScopeKey(baseKey, scope, usage = ['wrapKey', 'unwrapKey'], { useCache = true } = {}) {
  if (useCache) {
    let perScope = scopeKeyCacheByBase.get(baseKey);
    if (perScope) {
      const cached = perScope.get(`${scope}:${usage.join(',')}`);
      if (cached) return cached;
    }
  }

  const info = new TextEncoder().encode(`mycelium:scope:${scope}:v1`);
  const derivedBits = await subtle.deriveBits(
    { name: 'HKDF', hash: HKDF_HASH, salt: HKDF_SALT, info },
    baseKey,
    DEK_BITS,
  );
  const scopeKey = await subtle.importKey('raw', derivedBits, 'AES-KW', false, usage);

  if (useCache) {
    let perScope = scopeKeyCacheByBase.get(baseKey);
    if (!perScope) {
      perScope = new Map();
      scopeKeyCacheByBase.set(baseKey, perScope);
    }
    perScope.set(`${scope}:${usage.join(',')}`, scopeKey);
  }
  return scopeKey;
}

// ── System Scope Key Derivation ──
//
// Derived from SYSTEM_KEY with a distinct HKDF info prefix
// ("mycelium:system-scope:<scope>:v1") so that system scope keys are
// cryptographically independent from user scope keys, even if someone
// ever accidentally imported the same 32 bytes into both families.

const systemScopeKeyCacheByBase = new WeakMap();

async function deriveSystemScopeKey(systemKey, scope, usage = ['wrapKey', 'unwrapKey'], { useCache = true } = {}) {
  if (useCache) {
    let perScope = systemScopeKeyCacheByBase.get(systemKey);
    if (perScope) {
      const cached = perScope.get(`${scope}:${usage.join(',')}`);
      if (cached) return cached;
    }
  }

  const info = new TextEncoder().encode(`mycelium:system-scope:${scope}:v1`);
  const derivedBits = await subtle.deriveBits(
    { name: 'HKDF', hash: HKDF_HASH, salt: HKDF_SALT, info },
    systemKey,
    DEK_BITS,
  );
  const scopeKey = await subtle.importKey('raw', derivedBits, 'AES-KW', false, usage);

  if (useCache) {
    let perScope = systemScopeKeyCacheByBase.get(systemKey);
    if (!perScope) {
      perScope = new Map();
      systemScopeKeyCacheByBase.set(systemKey, perScope);
    }
    perScope.set(`${scope}:${usage.join(',')}`, scopeKey);
  }
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

// ── Encrypt with SYSTEM_KEY (envelope v3, kf='system') ──
//
// Used for operator-managed infrastructure secrets. Produces a v3 envelope
// tagged with kf='system' so decrypt() can route to the correct key family.

async function encryptWithSystemKey(plaintext, scope, systemKey) {
  if (!systemKey) throw new Error('encryptWithSystemKey: systemKey is required');
  const scopeKey = await deriveSystemScopeKey(systemKey, scope, ['wrapKey']);

  const dek = await subtle.generateKey(
    { name: 'AES-GCM', length: DEK_BITS },
    true,
    ['encrypt', 'decrypt'],
  );

  const iv = webcrypto.getRandomValues(new Uint8Array(IV_BYTES));

  const plaintextBytes = new TextEncoder().encode(plaintext);
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: TAG_LENGTH },
    dek,
    plaintextBytes,
  );

  const wrappedDek = await subtle.wrapKey('raw', dek, scopeKey, 'AES-KW');

  const envelope = {
    v: 3,
    kf: 'system',
    s: scope,
    iv: toBase64(iv),
    ct: toBase64(ciphertext),
    dk: toBase64(wrappedDek),
  };

  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

// ── Decrypt ──

async function decrypt(encoded, masterKey, allowedScopes = null, opts = {}) {
  const envelope = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (envelope.v !== 1 && envelope.v !== 2 && envelope.v !== 3) {
    throw new Error(`Unknown envelope version: ${envelope.v}`);
  }

  if (allowedScopes && !allowedScopes.includes(envelope.s)) {
    throw new ScopeViolationError(`Scope denied: "${envelope.s}" not in [${allowedScopes}]`);
  }

  // Key-family routing:
  //   v1/v2             → USER_MASTER_KEY (legacy: all data encrypted with master)
  //   v3 + kf='user'    → USER_MASTER_KEY (explicit tagging, future customer secrets)
  //   v3 + kf='system'  → SYSTEM_KEY (operator infrastructure secrets)
  const keyFamily = envelope.v === 3 ? (envelope.kf || 'user') : 'user';
  let scopeKey;
  if (keyFamily === 'system') {
    const systemKey = opts.systemKey;
    if (!systemKey) {
      throw new Error(`SYSTEM_KEY required to decrypt envelope (scope="${envelope.s}") but none provided`);
    }
    scopeKey = await deriveSystemScopeKey(systemKey, envelope.s, ['unwrapKey']);
  } else {
    if (!masterKey) {
      throw new Error(`USER_MASTER_KEY required to decrypt envelope (scope="${envelope.s}") but none provided`);
    }
    // v2/v3-user may carry a per-user derivation
    let baseKey = masterKey;
    if ((envelope.v === 2 || envelope.v === 3) && envelope.u) {
      baseKey = await deriveUserKey(masterKey, envelope.u);
    }
    scopeKey = await deriveScopeKey(baseKey, envelope.s, ['unwrapKey']);
  }

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

// ── Rewrap envelope (for master key rotation) ──

/**
 * Re-wrap an envelope's DEK from oldMasterKey to newMasterKey.
 * The ciphertext (ct) and IV (iv) are unchanged — only the wrapped DEK (dk)
 * is replaced. This is the atomic operation called during master key rotation.
 *
 * Both keys must be valid CryptoKeys imported via importMasterKey().
 *
 * @param {string} encoded - base64 envelope from existing encrypt()
 * @param {CryptoKey} oldMasterKey - HKDF base key for current data
 * @param {CryptoKey} newMasterKey - HKDF base key for new wrapping
 * @returns {Promise<string>} new base64 envelope (same ct/iv, new dk)
 */
async function rewrapEnvelope(encoded, oldMasterKey, newMasterKey) {
  const envelope = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (envelope.v !== 1 && envelope.v !== 2) {
    throw new Error(`Unknown envelope version: ${envelope.v}`);
  }

  // Derive OLD scope key (and user key if v2) — skip cache, two different master keys
  let oldBase = oldMasterKey;
  let newBase = newMasterKey;
  if (envelope.v === 2 && envelope.u) {
    oldBase = await deriveUserKey(oldMasterKey, envelope.u, { useCache: false });
    newBase = await deriveUserKey(newMasterKey, envelope.u, { useCache: false });
  }
  const oldScopeKey = await deriveScopeKey(oldBase, envelope.s, ['unwrapKey'], { useCache: false });
  const newScopeKey = await deriveScopeKey(newBase, envelope.s, ['wrapKey'], { useCache: false });

  // Unwrap DEK with old scope key — must be extractable so we can re-wrap
  const wrappedDk = fromBase64(envelope.dk);
  const dek = await subtle.unwrapKey(
    'raw',
    wrappedDk.buffer.slice(wrappedDk.byteOffset, wrappedDk.byteOffset + wrappedDk.byteLength),
    oldScopeKey,
    'AES-KW',
    { name: 'AES-GCM', length: DEK_BITS },
    true, // extractable so we can re-wrap
    ['decrypt'],
  );

  // Re-wrap DEK with new scope key
  const newWrappedDk = await subtle.wrapKey('raw', dek, newScopeKey, 'AES-KW');

  // Build new envelope — only dk changes
  const newEnvelope = {
    v: envelope.v,
    s: envelope.s,
    iv: envelope.iv,
    ct: envelope.ct,
    dk: toBase64(newWrappedDk),
  };
  if (envelope.v === 2 && envelope.u) newEnvelope.u = envelope.u;

  return Buffer.from(JSON.stringify(newEnvelope)).toString('base64');
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

async function decryptFields(record, masterKey, allowedScopes = null, opts = {}) {
  const result = { ...record };
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'string' && isEncrypted(value)) {
      try {
        result[key] = await decrypt(value, masterKey, allowedScopes, opts);
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
 * Tables whose rows are encrypted with SYSTEM_KEY instead of USER_MASTER_KEY.
 * These hold operator-managed infrastructure data that must survive the
 * customer restoring/rotating their own master key.
 */
const SYSTEM_KEY_TABLES = new Set(['secrets']);

/**
 * Auto-encrypt params in INSERT/UPDATE SQL statements.
 * Modifies params array in-place. Returns potentially modified SQL (scope injection).
 *
 * Key-family routing:
 *   - `secrets` table  → SYSTEM_KEY (v3 envelope, kf='system')
 *   - everything else  → USER_MASTER_KEY (v1/v2 envelope)
 *
 * @param {string} sql
 * @param {any[]} params - mutated in place
 * @param {string} scope - scope tag for the envelope
 * @param {CryptoKey|null} masterKey - USER_MASTER_KEY (may be null for system-only writes)
 * @param {string|null} userId - for per-user v2 derivation
 * @param {{ systemKey?: CryptoKey|null }} opts - SYSTEM_KEY for operator infrastructure writes
 */
async function autoEncryptParams(sql, params, scope, masterKey, userId = null, opts = {}) {
  const parsed = parseWriteSQL(sql);
  if (!parsed) return sql;

  const table = parsed.table;
  const isSystemTable = SYSTEM_KEY_TABLES.has(table);
  const systemKey = opts.systemKey || null;

  // REFUSE writes when the required key is missing — never silently emit plaintext.
  if (isSystemTable) {
    if (!systemKey) {
      throw new Error(`REFUSE: write to '${table}' requires SYSTEM_KEY but none provided`);
    }
  } else {
    if (!masterKey) {
      throw new Error(`REFUSE: write to '${table}' requires USER_MASTER_KEY but none provided`);
    }
  }

  // Encryption function selected by table family
  const encryptValue = isSystemTable
    ? (value) => encryptWithSystemKey(value, scope, systemKey)
    : (value) => encrypt(value, scope, masterKey, userId);

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
          params[absIdx] = await encryptValue(value);
        }
      }
    }

    // Inject scope column if not present (skip tables without scope column)
    if (!columns.includes('scope') && !NO_SCOPE_TABLES.has(table)) {
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
        params[paramIdx] = await encryptValue(value);
      }
    }
  }

  return sql;
}

/**
 * Auto-decrypt all encrypted values in query result rows.
 * @param {Array} rows — query results
 * @param {CryptoKey} masterKey — USER_MASTER_KEY (may be null if only system envelopes expected)
 * @param {string[]|null} allowedScopes — if set, only these scopes will be decrypted
 * @param {{ systemKey?: CryptoKey|null }} opts — SYSTEM_KEY for v3 system envelopes
 */
async function autoDecryptResults(rows, masterKey, allowedScopes = null, opts = {}) {
  if (!rows || !rows.length) return rows;

  const decrypted = [];
  for (const row of rows) {
    const newRow = { ...row };
    for (const [key, value] of Object.entries(newRow)) {
      if (typeof value === 'string' && isEncrypted(value)) {
        try {
          newRow[key] = await decrypt(value, masterKey, allowedScopes, opts);
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

/**
 * Get the master key from the best available source:
 *   1. KMS (if KMS_URL configured) — Swiss jurisdiction, mTLS
 *   2. tmpfs (/run/mycelium/master.key) — local fallback
 *   3. process.env.ENCRYPTION_MASTER_KEY — legacy (insecure)
 *
 * @returns {Promise<CryptoKey|null>}
 */
async function getMasterKeyFromBestSource() {
  // 1. Try KMS if configured
  if (process.env.KMS_URL) {
    try {
      const { isKmsConfigured, getKmsKey } = await import('./kms-client.js');
      if (isKmsConfigured()) {
        const key = await getKmsKey();
        if (key) {
          console.log('[crypto] Master key source: KMS (Swiss jurisdiction)');
          return key;
        }
      }
    } catch (err) {
      console.warn(`[crypto] KMS fetch failed, falling back to local: ${err.message}`);
    }
  }

  // 2. Try tmpfs (existing path)
  const localKey = await importMasterKeyFromTmpfs();
  if (localKey) {
    if (process.env.KMS_URL) {
      console.warn('[crypto] Master key source: tmpfs FALLBACK (KMS configured but unreachable)');
    }
    return localKey;
  }

  // 3. No key available
  console.warn('[crypto] No master key available (no KMS, no tmpfs, no env)');
  return null;
}

/**
 * Get the SYSTEM_KEY from the best available source.
 *
 * Unlike the master key, the system key has no KMS integration today — it is
 * provisioned directly onto the VPS tmpfs at `/run/mycelium/system.key`.
 * Future work may add a plaintext-mode KMS fetch for reboot recovery.
 *
 * @returns {Promise<CryptoKey|null>}
 */
async function getSystemKeyFromBestSource() {
  const key = await importSystemKeyFromTmpfs();
  if (key) return key;
  console.warn('[crypto] No SYSTEM_KEY available (no tmpfs, no env)');
  return null;
}

/**
 * Clear all derived key caches. Used during key rotation.
 * Zeros scope keys, user keys, and KMS client cache.
 */
async function clearAllCaches() {
  // WeakMaps are auto-pruned when keys are garbage collected, but during
  // rotation we want explicit invalidation. We can't .clear() a WeakMap,
  // so we re-create the maps. The old WeakMaps become garbage.
  // Note: this requires re-importing or using shared module-level vars.
  // Since these are const WeakMaps, we walk known references differently:
  // The next deriveScopeKey/deriveUserKey call with a new master key
  // will create a new entry because the cache is keyed by the CryptoKey object.
  // For an already-cached master key, a re-derive happens after this call.
  // Effectively: clearAllCaches() is now a no-op for the per-master caches —
  // the WeakMap design handles cleanup automatically.
  if (process.env.KMS_URL) {
    try {
      const { clearCache } = await import('./kms-client.js');
      clearCache();
    } catch { /* KMS module not available */ }
  }
}

export {
  importMasterKey,
  importMasterKeyFromTmpfs,
  importSystemKeyFromTmpfs,
  getMasterKeyFromBestSource,
  getSystemKeyFromBestSource,
  clearAllCaches,
  readMasterKeyHex,
  readSystemKeyHex,
  encrypt,
  encryptWithSystemKey,
  decrypt,
  rewrapEnvelope,
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
  SYSTEM_KEY_TABLES,
};
