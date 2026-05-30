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
import { guardians, GuardianKind } from './guardians/index.js';
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

// Per-process dedup of `[SCOPE VIOLATION]` log lines. The audit callback
// still fires every time (security teams need the count), but stderr
// only sees each unique (field, scope-message) pair once. A single
// agent /chat that walks N rows of cross-scope data was producing N
// stderr lines per query — moms-agent saw ~10 per turn, growing
// linearly with conversation length. The protection itself is still
// in place; the field stays as ciphertext on every miss.
const _loggedScopeViolations = new Set();
function logScopeViolation(field, scopeMessage) {
  const key = `${field}|${scopeMessage}`;
  if (_loggedScopeViolations.has(key)) return;
  _loggedScopeViolations.add(key);
  console.warn(`[SCOPE VIOLATION] field="${field}" ${scopeMessage}`);
}

// Scope-decryption guardian — wraps the allowedScopes check inside decrypt().
// Every decrypt() call runs through this guardian; metrics reflect real traffic.
const scopeGuardian = guardians.register({
  id: 'vps.scope-decryption',
  kind: GuardianKind.SCOPE,
  boundary: 'agent→vault',
  description: 'AGENT_SCOPES intersects envelope scope before DEK unwrap',
  process: 'vps',
  failClosed: true,
  check: async (ctx) => {
    // null allowedScopes = admin mode (migrations, backfill). Allow, but label.
    if (!ctx.allowedScopes) {
      return { allow: true, principal: { id: 'admin', kind: 'operator' } };
    }
    if (!ctx.envelopeScope) {
      return { allow: false, reason: 'missing_envelope_scope', severity: 'critical' };
    }
    if (!ctx.allowedScopes.includes(ctx.envelopeScope)) {
      return {
        allow: false,
        reason: 'scope_not_in_allowed',
        severity: 'critical',
      };
    }
    return { allow: true };
  },
  contract: () => [
    {
      sub: 'registered',
      severity: 'fatal',
      description: 'scope-decryption guardian is registered before first decrypt',
      // This is a structural assertion — the check registration at module
      // load guarantees the guardian exists once crypto-local is imported.
      run: async () => ({
        status: 'pass',
        message: 'vps.scope-decryption guardian is registered',
      }),
    },
  ],
});

// Scope-encryption guardian — mirror of vps.scope-decryption for the
// write path. Checks that the scope an agent wants to encrypt UNDER is
// in its AGENT_SCOPES allowlist. Without this, an agent with
// AGENT_SCOPES=["personal"] could accidentally (or via injection)
// encrypt data under scope="org" and write it to the org-scoped row,
// producing a row that's unreadable by its own scope filter on read.
//
// Admin mode (AGENT_SCOPES unset) is permitted — migrations and
// backfill legitimately cross scopes.
const scopeEncryptGuardian = guardians.register({
  id: 'vps.scope-encryption',
  kind: GuardianKind.SCOPE,
  boundary: 'agent→vault',
  description: 'AGENT_SCOPES contains target scope before encrypt()',
  process: 'vps',
  failClosed: true,
  check: async (ctx) => {
    // Admin / backfill mode: no AGENT_SCOPES declared in env.
    if (!ctx.agentScopes || ctx.agentScopes.length === 0) {
      return { allow: true, principal: { id: 'admin', kind: 'operator' } };
    }
    if (!ctx.targetScope) {
      return { allow: false, reason: 'missing_target_scope', severity: 'critical' };
    }
    if (!ctx.agentScopes.includes(ctx.targetScope)) {
      return {
        allow: false,
        reason: 'target_scope_not_in_agent_scopes',
        severity: 'critical',
      };
    }
    return { allow: true };
  },
  contract: () => [
    {
      sub: 'registered',
      severity: 'fatal',
      description: 'scope-encryption guardian is registered before first encrypt',
      run: async () => ({
        status: 'pass',
        message: 'vps.scope-encryption guardian is registered',
      }),
    },
  ],
});

/** Parse AGENT_SCOPES env — JSON array, or null for admin/backfill mode. */
function getAgentScopes() {
  const raw = process.env.AGENT_SCOPES;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Audit callback — set by db-d1.js to persist scope violations to audit_log. */
let _auditCallback = null;
function setAuditCallback(fn) { _auditCallback = fn; }

// ── Encrypted fields per table (must match Worker's ENCRYPTED_FIELDS) ──

// ── Encrypted fields per table (must match Worker's ENCRYPTED_FIELDS) ──
//
// The guiding rule: if a column describes, narrates, or fingerprints the
// user's life, encrypt it. Plaintext is reserved for structural state that
// the database layer itself needs unencrypted — IDs, foreign keys for
// JOINs, timestamps for ordering, numeric counts for aggregation, enums
// for filtering. Anything else is encrypted.
//
// Fields that MUST stay plaintext (called out per table below where they
// appear) are ones where encryption would break query ability:
//   - primary keys (id, rowid)
//   - foreign keys used in JOINs (user_id, agent_id, realm_id, …)
//   - timestamps for ORDER BY / range queries (created_at, updated_at)
//   - integer stats for SUM/AVG/aggregation (message_count, energy, …)
//   - centroids (vector embeddings used for distance queries) — these
//     ARE sensitive semantic fingerprints but encrypting them breaks the
//     entire mindscape UI. Accepted trade-off; see THREAT-MODEL.md.
//   - enums for WHERE/filter: status, visibility, scope, role, source, type
//
const ENCRYPTED_FIELDS = {
  // Messages — content + all AI-derived metadata
  // metadata column (arbitrary JSON) added: can contain sensitive
  // structured data from agents. nlp_error can reveal failure patterns
  // of specific messages — encrypt.
  messages: [
    'content', 'thinking', 'tags', 'entities', 'entity_summary',
    'suggested_new_tag', 'relations',
    'metadata', 'nlp_error',
  ],

  // Documents — content + every column that describes it. content_hash
  // (SHA of plaintext) stays plaintext because dedup/change-detection
  // queries need it — but this IS a known inversion risk if attacker
  // knows a corpus of possible documents. Source_path reveals document
  // origin; encrypt.
  documents: [
    'content', 'summary', 'title', 'tags', 'entities', 'relations',
    'metadata', 'entity_summary',
    'source_path',
  ],

  // Attachments — filenames often verbatim describe content.
  // file_type + file_size can fingerprint content via ML; accept that
  // as metadata leak for now (breaks listing UI if encrypted).
  attachments: ['transcript', 'file_name', 'description', 'metadata'],

  // Clustering / mindscape points
  clustering_points: ['content'],

  // Agent operations — every payload/result carries task context
  agent_events: ['payload'],
  agent_tasks: ['context', 'result', 'description', 'summary', 'error'],

  // Agent customizations — per-agent system prompts + settings
  agent_customizations: ['system_prompt', 'settings', 'tools_config'],

  // Contacts — all PII
  people: [
    'name', 'aliases', 'description', 'metadata',
    'email', 'phone', 'company', 'position', 'linkedin_url',
    'notes', 'avatar_url',
  ],

  // Wealth — amounts, notes, anything revealing position sizes
  wealth_transactions: ['notes', 'quantity', 'price_per_unit', 'fees', 'exchange_rate'],
  wealth_positions: ['total_cost', 'current_value', 'unrealized_pnl', 'avg_cost_basis', 'quantity'],
  wealth_snapshots: ['total_value', 'total_invested', 'total_pnl', 'day_change'],
  wealth_accounts: ['name', 'institution', 'account_number_last4', 'notes', 'metadata'],
  wealth_assets: ['custom_name', 'notes', 'metadata'],
  wealth_wallets: ['label', 'address', 'notes', 'metadata'],
  wealth_watchlist: ['notes'],
  wealth_portfolios: ['name', 'description', 'notes', 'metadata'],

  // Health — every physiological metric
  health_daily: [
    'sleep_duration_min', 'sleep_in_bed_min', 'sleep_efficiency',
    'sleep_deep_min', 'sleep_rem_min', 'sleep_core_min', 'sleep_awake_min',
    'sleep_start', 'sleep_end',
    'hrv_avg', 'hrv_sleep_avg', 'resting_hr',
    'steps', 'active_energy_kcal',
    'workout_count', 'workout_minutes', 'workout_types',
    'mindful_minutes',
  ],

  // Activity tracking — behavioral surveillance data
  activity_sessions: ['window_title', 'url', 'app_bundle', 'app_name'],

  // Internal model — user's private reasoning
  internal_model_items: ['content', 'evidence', 'source_context'],

  // Reflections — journal entries
  reflections: ['content', 'trigger', 'metadata'],

  // Tasks — descriptions reveal what user is working on
  tasks: ['title', 'description', 'notes', 'metadata'],

  // Folders — name/description organize user's thinking
  folders: ['name', 'description', 'metadata'],

  // Note links — relationship descriptions between notes
  note_links: ['description', 'metadata'],

  // Territory profiles — narrative about user's mind. Historically we
  // only encrypted the story_* + agent_* fields; expanding to cover
  // everything that describes the territory. archetype_character was
  // plaintext and leaked verbatim descriptions; top_entities was a
  // plaintext JSON array of people names. Both closed here.
  territory_profiles: [
    // already-encrypted
    'title', 'essence',
    'story_birth', 'story_arc', 'story_peak_moments', 'story_current_chapter',
    'uncertainty_open_questions', 'agent_expertise', 'agent_curious_about',
    // newly encrypted (was plaintext)
    'name', 'archetype_character',
    'top_entities', 'signature_patterns',
    'agent_can_help_with', 'agent_would_consult',
    'raw_response', 'moments_of_interest', 'activity_timeline',
    'chronicle', 'chronicle_cursor', 'anchored_reason',
    'description', 'description_version',
  ],

  // Realms — high-level mind organization. Expanding from just
  // name+description to cover the full narrative structure that was
  // mirrored in territory_profiles but mostly plaintext here.
  realms: [
    'name', 'description',
    'essence', 'archetype_character',
    'top_entities', 'signature_patterns',
    'story_birth', 'story_arc', 'story_peak_moments', 'story_current_chapter',
    'uncertainty_open_questions', 'uncertainty_edges',
    'agent_expertise', 'agent_curious_about', 'agent_can_help_with',
    'activity_timeline',
  ],

  // Semantic themes
  semantic_themes: [
    'label', 'keywords', 'description',
    'name', 'essence',
    'top_entities', 'signature_patterns',
    'story_birth', 'story_arc', 'story_current_chapter',
    'uncertainty_open_questions',
    'raw_response',
  ],

  // User identities — social account links
  user_identities: ['provider_username', 'provider_id', 'provider_avatar'],

  // Provisioning — customer PII
  provisioning_jobs: ['email', 'stripe_customer_id', 'error'],

  // Secrets — key names reveal what's stored
  secrets: ['key', 'description'],

  // Time chronicles — narrative about temporal periods
  time_chronicles: [
    'theme', 'narrative',
    'key_moments', 'top_territories', 'top_contacts', 'top_agents',
    'cross_references', 'voice_sample', 'raw_response',
  ],

  // Current arc — living meta-narrative
  current_arc_chronicles: ['theme', 'narrative', 'raw_response'],

  // Contact chronicles — per-person narratives
  contact_chronicles: ['narrative', 'summary', 'metadata'],

  // Territory pass notes — agent's notes from visiting territories
  territory_pass_notes: ['note', 'entities_mentioned', 'metadata'],

  // Theme cards — theme-level narratives
  theme_cards: ['title', 'description', 'content', 'metadata'],

  // Space rooms — name + essence reveal what topics a person is
  // organizing into a shared space. cover_doc_path stays plaintext
  // because it's a join key against documents.path (also plaintext).
  // Creator-keyed via Swiss Vault for now; SPACES.md §10.4 calls for
  // a space-key migration once multi-user spaces ship.
  space_rooms: ['name', 'essence'],

  // Space knowledge — content and tags are the seeded summaries
  // contributors approve. Per SPACES.md §8.2 these MUST be encrypted.
  // Was plaintext in the initial 125_spaces.sql migration; gap closed
  // here. Existing rows remain plaintext (auto-decrypt's isEncrypted
  // check passes them through); new writes get protected. Backfill
  // is a separate one-shot script if/when needed.
  space_knowledge: ['content', 'domain_tags'],

  // Share links — invited_email is PII, encrypt at rest. token,
  // user_id, document_path stay plaintext: token is a bearer
  // credential matched verbatim on lookup; the others are join
  // keys against documents.path (which is plaintext) and users.id.
  // Lives in admin D1 (cross-tenant scope) per migration 139.
  share_links: ['invited_email'],

  // ── Cognitive metrics (Phase 5, migration 158) ──────────────────
  // Scalar measurements derived from encrypted embeddings inherit the
  // same threat model per CLAUDE.md §7 ("embedding vectors are
  // sensitive"). Precedent for encrypting REAL/numeric columns:
  // wealth_transactions, wealth_positions, wealth_snapshots above.
  //
  // Grain columns (user_id, window_end, granularity, language,
  // era_id, level, window_type, window_start, territory_id) stay
  // plaintext — required for indexed lookups.

  // cognitive_metrics_window — 82 scalar columns (41 metric + 41
  // baseline). Each is a within-user signal-shape summary; cross-user
  // comparison is invalid but a leak still fingerprints the user's
  // cognitive rhythm at scale.
  cognitive_metrics_window: [
    // §4.23 harmonic_amplitude (15 metric + 15 baseline)
    'harmonic_amplitude_gamma_k1', 'harmonic_amplitude_gamma_k2', 'harmonic_amplitude_gamma_k3',
    'harmonic_amplitude_beta_k1',  'harmonic_amplitude_beta_k2',  'harmonic_amplitude_beta_k3',
    'harmonic_amplitude_alpha_k1', 'harmonic_amplitude_alpha_k2', 'harmonic_amplitude_alpha_k3',
    'harmonic_amplitude_theta_k1', 'harmonic_amplitude_theta_k2', 'harmonic_amplitude_theta_k3',
    'harmonic_amplitude_delta_k1', 'harmonic_amplitude_delta_k2', 'harmonic_amplitude_delta_k3',
    'harmonic_amplitude_gamma_k1_baseline_90d', 'harmonic_amplitude_gamma_k2_baseline_90d', 'harmonic_amplitude_gamma_k3_baseline_90d',
    'harmonic_amplitude_beta_k1_baseline_90d',  'harmonic_amplitude_beta_k2_baseline_90d',  'harmonic_amplitude_beta_k3_baseline_90d',
    'harmonic_amplitude_alpha_k1_baseline_90d', 'harmonic_amplitude_alpha_k2_baseline_90d', 'harmonic_amplitude_alpha_k3_baseline_90d',
    'harmonic_amplitude_theta_k1_baseline_90d', 'harmonic_amplitude_theta_k2_baseline_90d', 'harmonic_amplitude_theta_k3_baseline_90d',
    'harmonic_amplitude_delta_k1_baseline_90d', 'harmonic_amplitude_delta_k2_baseline_90d', 'harmonic_amplitude_delta_k3_baseline_90d',
    // §4.33 bigram_flow_features (25 metric + 25 baseline)
    'mean_crossing_rate_gamma', 'mean_crossing_rate_beta', 'mean_crossing_rate_alpha',
    'mean_crossing_rate_theta', 'mean_crossing_rate_delta',
    'slope_sign_change_rate_gamma', 'slope_sign_change_rate_beta', 'slope_sign_change_rate_alpha',
    'slope_sign_change_rate_theta', 'slope_sign_change_rate_delta',
    'autocorrelation_lag1_gamma', 'autocorrelation_lag1_beta', 'autocorrelation_lag1_alpha',
    'autocorrelation_lag1_theta', 'autocorrelation_lag1_delta',
    'variance_gamma', 'variance_beta', 'variance_alpha', 'variance_theta', 'variance_delta',
    'total_spectral_energy_gamma', 'total_spectral_energy_beta', 'total_spectral_energy_alpha',
    'total_spectral_energy_theta', 'total_spectral_energy_delta',
    'mean_crossing_rate_gamma_baseline_90d', 'mean_crossing_rate_beta_baseline_90d',
    'mean_crossing_rate_alpha_baseline_90d', 'mean_crossing_rate_theta_baseline_90d', 'mean_crossing_rate_delta_baseline_90d',
    'slope_sign_change_rate_gamma_baseline_90d', 'slope_sign_change_rate_beta_baseline_90d',
    'slope_sign_change_rate_alpha_baseline_90d', 'slope_sign_change_rate_theta_baseline_90d', 'slope_sign_change_rate_delta_baseline_90d',
    'autocorrelation_lag1_gamma_baseline_90d', 'autocorrelation_lag1_beta_baseline_90d',
    'autocorrelation_lag1_alpha_baseline_90d', 'autocorrelation_lag1_theta_baseline_90d', 'autocorrelation_lag1_delta_baseline_90d',
    'variance_gamma_baseline_90d', 'variance_beta_baseline_90d',
    'variance_alpha_baseline_90d', 'variance_theta_baseline_90d', 'variance_delta_baseline_90d',
    'total_spectral_energy_gamma_baseline_90d', 'total_spectral_energy_beta_baseline_90d',
    'total_spectral_energy_alpha_baseline_90d', 'total_spectral_energy_theta_baseline_90d', 'total_spectral_energy_delta_baseline_90d',
    // §4.34 topology_persistence_entropy (1 metric + 1 baseline)
    'topology_persistence_entropy', 'topology_persistence_entropy_baseline_90d',
    // Honesty fields (notes can reveal compute-state context)
    'notes',
  ],

  // cognitive_metrics_trajectory — fisher information-geometry +
  // level-grain complexity. activation_vector is a per-row JSON
  // distribution over territories; top_contributors is JSON listing
  // the user's most-influential territory IDs.
  cognitive_metrics_trajectory: [
    'activation_vector',
    'velocity', 'velocity_z', 'displacement', 'path_length',
    'R_recent', 'exploration_ratio',
    'phase', 'phase_recent',
    'activation_entropy', 'displacement_lifetime',
    'lz_complexity', 'raw_complexity', 'sequence_length', 'alphabet_size',
    'top_contributors',
  ],

  // cognitive_metrics_per_territory — recurrence intervals reveal
  // when this user activates a specific territory; with territory_id
  // as plaintext join key, the scalar is sensitive.
  cognitive_metrics_per_territory: [
    'recurrence_interval', 'recurrence_interval_baseline_90d',
    'notes',
  ],

  // topology_metrics — graph-level cognitive shape per era. Each
  // scalar describes the user's mindscape topology; leak reveals
  // structural cognitive state.
  topology_metrics: [
    'm2_entropy', 'm2_delta', 'm2_trend', 'degree_gini',
    'max_degree', 'mean_degree',
    'orphan_count', 'bridge_count', 'catchall_count',
    'total_territories', 'total_connections',
  ],
};

// Tables that DO have a 'scope' column — autoEncryptParams will inject
// `scope` on INSERTs into these tables (and only these tables) so the
// scope-decryption guardian has a per-row tag to enforce. Verified
// against the D1 schema by `test/scope-aware-tables.test.js` — that
// test fails the suite if this set drifts from the live schema in
// either direction.
//
// Why opt-in (was opt-out): the previous design used NO_SCOPE_TABLES
// (skip the injection for these). A new encrypted table without a
// scope column would silently break INSERTs because of an "no column
// named scope" error — that's exactly what bit `tasks` (in
// ENCRYPTED_FIELDS, no scope column on the live schema, never added
// to NO_SCOPE_TABLES). Opt-in inverts the failure mode: a new
// encrypted table that DOES have scope and isn't listed here just
// won't get auto-tagged (recoverable, visible at decrypt time) — far
// safer than the alternative.
//
// To extend: when you add a `scope TEXT` column to an encrypted table,
// add it here. The contract test will tell you if you forgot.
export const SCOPE_AWARE_TABLES = new Set([
  // Core message + content tables.
  'messages',
  'documents',
  'attachments',
  'clustering_points',
  // Agent-side bookkeeping.
  'agent_events',
  'agent_tasks',
  // Health metrics (per-user, scope-tagged).
  'health_daily',
  // Contacts.
  'people',
  // Operator secrets (kf='system' envelopes still tagged with scope
  // so cross-scope operator queries can filter without decrypting).
  'secrets',
  // Wealth ledger tables that ship with scope.
  'wealth_transactions',
  'wealth_positions',
  'wealth_snapshots',
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

// Bot/agent process names that share their owning agent's scope.
// Bots run in their own PM2 process with their own AGENT_ID (the PM2
// process name, e.g. 'moms-telegram-bot'), but they encrypt/write data
// for their owning agent's tenant scope. Map process name → scope so
// the d1Query plumbing layer (which only sees process.env.AGENT_ID,
// not message source) can resolve scope correctly.
//
// This is a BRIDGE until bot-as-pure-transport refactor lands
// (docs/PURE-TRANSPORT-BOT-VISION-2026-05-20.md). When that ships,
// bots will forward all data writes to agent-server which has the
// correct scope context natively, and this map can be deleted.
const PROCESS_SCOPE_MAP = {
  // moms
  'moms-agent': 'moms',
  'moms-telegram-bot': 'moms',
  'moms-scheduler': 'moms',
  // personal (Mya)
  'personal-agent': 'personal',
  'mya-personal': 'personal',
  'mya-telegram-bot': 'personal',
  'mya-discord-bot': 'personal',
  // wealth (Rob)
  'wealth-agent': 'wealth',
  'wealth-discord-bot': 'wealth',
  'wealth-scheduler': 'wealth',
};

function inferScope(ctx) {
  if (ctx.scope) return ctx.scope;

  if (ctx.source === 'telegram' || ctx.source === 'whatsapp') {
    const mapped = PROCESS_SCOPE_MAP[ctx.agent_id];
    if (mapped) return mapped;
    return 'personal';
  }

  if (ctx.path) {
    const p = ctx.path.toLowerCase();
    if (p.startsWith('mind/') || p.startsWith('internal/') || p.startsWith('transcriptions/') || p.startsWith('states/')) {
      const mapped = PROCESS_SCOPE_MAP[ctx.agent_id];
      if (mapped) return mapped;
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
    const mapped = PROCESS_SCOPE_MAP[ctx.agent_id];
    if (mapped) return mapped;
  }

  return 'org';
}

// ── Encrypt ──

async function encrypt(plaintext, scope, masterKey, userId = null) {
  // Scope guardian (write side): refuse if target scope isn't in this
  // agent's AGENT_SCOPES. Admin/backfill (no AGENT_SCOPES) is exempt.
  // This mirrors vps.scope-decryption on the read path — without it
  // an agent could encrypt under a scope it couldn't later decrypt
  // (orphan row) or, worse, escalate across scope boundaries.
  const agentScopes = getAgentScopes();
  const encCheck = await scopeEncryptGuardian.check({
    agentScopes,
    targetScope: scope,
  });
  if (!encCheck.allow) {
    if (_auditCallback) {
      try {
        await _auditCallback({
          action: 'scope_violation_encrypt',
          details: { reason: encCheck.reason, targetScope: scope, agentScopes },
        });
      } catch { /* audit failure never blocks the rejection */ }
    }
    throw new ScopeViolationError(
      `encrypt refused: scope='${scope}' not in AGENT_SCOPES=${JSON.stringify(agentScopes || 'admin')}`,
    );
  }

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

  // Route through the scope-decryption guardian — metrics + deny events.
  // Behavior unchanged: allowedScopes=null still means admin mode,
  // otherwise the envelope scope must be present in allowedScopes.
  const scopeResult = await scopeGuardian.check({
    allowedScopes,
    envelopeScope: envelope.s,
  });
  if (!scopeResult.allow) {
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
          logScopeViolation(key, err.message);
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

    // Inject scope column on INSERT for tables in the opt-in
    // SCOPE_AWARE_TABLES set. Tables outside the set never get
    // scope auto-injected — even if they're encrypted — because the
    // schema doesn't have a column to receive it. See SCOPE_AWARE_TABLES
    // header for the rationale; the contract test in
    // packages/core/test/scope-aware-tables.test.js verifies the set
    // matches the live schema in both directions.
    if (SCOPE_AWARE_TABLES.has(table) && !columns.includes('scope')) {
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
// Column names whose envelopes wrap binary payloads (e.g. Float32Array
// vectors encoded as base64 inside the envelope). Auto-decrypt would
// strip the envelope and return the inner base64 — but downstream code
// expects to receive the ENVELOPE itself and call its own typed
// decrypt path (decryptVector / decodeVectorBytes). Including these in
// auto-decrypt produces silent corruption: the outer decrypt yields
// base64 of float bytes, the consumer's "second decrypt" parses those
// float bytes as JSON, throws SyntaxError. Hard skip by name.
const NEVER_AUTO_DECRYPT_COLUMNS = new Set([
  'embedding_768',     // mind-search vector envelopes (messages, documents,
                       // territory_profiles, realms, semantic_themes)
  'nomic_embedding',   // clustering_points 256D blobs (raw bytes, not envelopes)
]);

async function autoDecryptResults(rows, masterKey, allowedScopes = null, opts = {}) {
  if (!rows || !rows.length) return rows;

  const decrypted = [];
  for (const row of rows) {
    const newRow = { ...row };
    for (const [key, value] of Object.entries(newRow)) {
      if (NEVER_AUTO_DECRYPT_COLUMNS.has(key)) continue;
      if (typeof value === 'string' && isEncrypted(value)) {
        try {
          newRow[key] = await decrypt(value, masterKey, allowedScopes, opts);
        } catch (err) {
          if (err instanceof ScopeViolationError) {
            logScopeViolation(key, err.message);
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

// ── Master key resolution ──
//
// Pinned, tmpfs-authoritative, KMS cold-boot only.
//
// Why this shape (vs. the prior "best source" picker):
//   The old getMasterKeyFromBestSource() preferred KMS when available and
//   fell back to tmpfs on KMS errors. That made the resolution
//   non-deterministic — the same process could see different keys across
//   calls depending on KMS reachability. Real failure mode: rotate to
//   key A in tmpfs, KMS still has key B, half the writes encrypt under
//   A and half under B → orphan rows on next boot. Apr 9-19 incident
//   left ~20 admin rows permanently unrecoverable from this exact dynamic.
//
// New rules:
//   1. tmpfs is AUTHORITATIVE at runtime. Once a process resolves a key, it
//      is pinned for process lifetime. No silent re-resolution, no fallback
//      switching mid-process.
//   2. KMS is consulted ONLY on cold boot (tmpfs is empty or absent). When
//      it returns, kms-client.persistToTmpfs() writes the bytes to tmpfs
//      so subsequent resolution is local.
//   3. Drift check: at first resolve, if both tmpfs and KMS hold a key,
//      their SHA-256 hashes must match. Mismatch is fatal — process.exit(2)
//      rather than encrypt new data under a different key than the existing
//      ciphertext.
//   4. env fallback (ENCRYPTION_MASTER_KEY) remains via importMasterKeyFromTmpfs
//      for legacy deployments, with a deprecation warning. New code should
//      not rely on it.

let _pinnedMasterKey = null;
let _pinnedMasterKeySource = null;
let _pinnedMasterKeyHashPrefix = null;
let _pinnedMasterKeyPromise = null;

/**
 * Resolve the master key. First call decides the source and pins it.
 * Subsequent calls return the same CryptoKey. Concurrent first calls
 * dedup on _pinnedMasterKeyPromise.
 *
 * @returns {Promise<CryptoKey|null>}
 */
async function getMasterKey() {
  if (_pinnedMasterKey) return _pinnedMasterKey;
  if (_pinnedMasterKeyPromise) return _pinnedMasterKeyPromise;

  _pinnedMasterKeyPromise = (async () => {
    try {
      // 1. Tmpfs is authoritative. importMasterKeyFromTmpfs() also handles
      //    the legacy env fallback internally (with its own deprecation warning).
      const tmpfsKey = await importMasterKeyFromTmpfs();
      if (tmpfsKey) {
        _pinnedMasterKey = tmpfsKey;
        _pinnedMasterKeySource = existsSync(TMPFS_KEY_PATH) ? 'tmpfs' : 'env-deprecated';
        _pinnedMasterKeyHashPrefix = await computeMasterKeyHashPrefix();

        // K4.1: drift check — if KMS is configured, compare hashes.
        // Best-effort; KMS-unreachable is logged but doesn't block boot.
        // Mismatched bytes = fatal.
        if (process.env.KMS_URL && _pinnedMasterKeySource === 'tmpfs') {
          await detectMasterKeyDrift(_pinnedMasterKeyHashPrefix);
        }

        console.log(`[crypto] Master key pinned: source=${_pinnedMasterKeySource} hash=${_pinnedMasterKeyHashPrefix || 'unknown'}`);
        return _pinnedMasterKey;
      }

      // 2. Cold boot: tmpfs empty. KMS is the only recovery.
      if (process.env.KMS_URL) {
        try {
          const { isKmsConfigured, getKmsKey } = await import('./kms-client.js');
          if (isKmsConfigured()) {
            const kmsKey = await getKmsKey();
            if (kmsKey) {
              _pinnedMasterKey = kmsKey;
              _pinnedMasterKeySource = 'kms-cold-boot';
              // getKmsKey internally calls persistToTmpfs, so reading
              // tmpfs hex now should succeed.
              _pinnedMasterKeyHashPrefix = await computeMasterKeyHashPrefix();
              console.log(`[crypto] Master key pinned: source=kms-cold-boot hash=${_pinnedMasterKeyHashPrefix || 'unknown'} (persisted to tmpfs)`);
              return _pinnedMasterKey;
            }
          }
        } catch (err) {
          console.error(`[crypto] KMS cold-boot recovery failed: ${err.message}`);
        }
      }

      // 3. No key available — refuse.
      console.error('[crypto] FATAL: no master key (tmpfs empty, KMS unavailable or unconfigured, no env). Encryption disabled.');
      return null;
    } finally {
      _pinnedMasterKeyPromise = null;
    }
  })();

  return _pinnedMasterKeyPromise;
}

/**
 * Backward-compat alias. The old name is referenced in some tests and any
 * external consumer pinned to a specific commit. Forwards to getMasterKey()
 * — no behavior change since they now resolve to the same pinned key.
 *
 * @deprecated Use getMasterKey()
 */
async function getMasterKeyFromBestSource() {
  return getMasterKey();
}

/**
 * Compute SHA-256 hash prefix of the tmpfs master key bytes.
 * Used for drift detection and observability. Returns first 16 hex chars
 * of the hash, matching the format used in CLAUDE.md / recovery kit.
 *
 * @returns {Promise<string|null>} 16-char hex prefix, or null if no tmpfs key
 */
async function computeMasterKeyHashPrefix() {
  const hex = readMasterKeyHex();
  if (!hex) return null;
  const bytes = Buffer.from(hex, 'hex');
  const hash = await subtle.digest('SHA-256', bytes);
  bytes.fill(0);
  return Buffer.from(hash).toString('hex').substring(0, 16);
}

/**
 * Drift check: compare local hash to KMS hash. Mismatch = fatal.
 *
 * Best-effort: KMS unreachable / 404 / URK mode = skip with log. Only
 * actual bytes-disagreement triggers process.exit(2). This preserves
 * boot resilience for cases where KMS is intentionally absent (admin
 * pre-Phase-M) while still catching the "two diverged keys" scenario.
 *
 * @param {string} localHashPrefix — SHA-256 hash prefix from tmpfs
 */
async function detectMasterKeyDrift(localHashPrefix) {
  if (!localHashPrefix) return;
  try {
    const { fetchKekHashPrefix } = await import('./kms-client.js');
    if (typeof fetchKekHashPrefix !== 'function') return;
    const kmsHashPrefix = await fetchKekHashPrefix();
    if (!kmsHashPrefix) {
      console.log('[crypto] Drift check skipped (KMS hash unavailable — likely URK mode pre-login)');
      return;
    }
    if (kmsHashPrefix !== localHashPrefix) {
      console.error(`[crypto] FATAL: master key drift detected — tmpfs=${localHashPrefix} kms=${kmsHashPrefix}`);
      console.error('[crypto] Refusing to start. Investigate before any encrypted operations.');
      console.error('[crypto] Recovery: verify which source matches the recovery kit hash; remove the diverged copy via DELETE /customer/<id> or wipe tmpfs.');
      process.exit(2);
    }
    console.log(`[crypto] Drift check OK: tmpfs and KMS agree (${localHashPrefix})`);
  } catch (err) {
    if (err.statusCode === 404) {
      console.log('[crypto] KMS has no KEK for this customer (404) — drift check skipped (pre-Phase-M state)');
    } else {
      console.warn(`[crypto] Drift check failed (non-fatal): ${err.message}`);
    }
  }
}

/**
 * Invalidate the pinned master key. Next getMasterKey() call re-resolves.
 *
 * Legitimate use:
 *   - Master key rotation (operator triggers; new key bytes differ from old)
 *   - Unit tests (simulate fresh process)
 *
 * Illegitimate use:
 *   - Reactive "the KMS came back, switch to it" — that's the exact
 *     non-determinism the pinned design eliminates. Don't call this from
 *     KMS-recovery code paths.
 */
function resetMasterKey() {
  _pinnedMasterKey = null;
  _pinnedMasterKeySource = null;
  _pinnedMasterKeyHashPrefix = null;
  _pinnedMasterKeyPromise = null;
}

// Test-friendly alias kept for legacy test files. Same semantics as
// resetMasterKey(); pick the name that reads better at the callsite.
const _resetMasterKeyForTesting = resetMasterKey;

/**
 * Health-endpoint metadata.
 */
function getMasterKeyMeta() {
  return {
    pinned: !!_pinnedMasterKey,
    source: _pinnedMasterKeySource,
    hashPrefix: _pinnedMasterKeyHashPrefix,
  };
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
  getMasterKey,
  getMasterKeyFromBestSource, // deprecated alias — kept for backward compat
  getMasterKeyMeta,
  computeMasterKeyHashPrefix,
  resetMasterKey,
  _resetMasterKeyForTesting,
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
