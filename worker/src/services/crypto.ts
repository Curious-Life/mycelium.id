/**
 * Mycelium Encryption Service
 *
 * Envelope encryption with per-record DEKs wrapped by scope keys.
 * All crypto via Cloudflare Workers Web Crypto API — zero npm deps.
 *
 * Key hierarchy:
 *   ENCRYPTION_MASTER_KEY (256-bit hex, env secret)
 *     → HKDF-SHA256 → scope key ("personal" | "org" | "wealth")
 *       → AES-KW → per-record DEK (256-bit random)
 *         → AES-256-GCM → ciphertext
 */

// ── Types ──────────────────────────────────────────────────────────

export type Scope = "personal" | "org" | "wealth" | "moms";

/** Encrypted envelope stored as base64 JSON in D1 fields */
export interface EncryptedEnvelope {
  v: 1;
  s: Scope;
  iv: string;  // 12 bytes, base64
  ct: string;  // ciphertext + GCM auth tag, base64
  dk: string;  // DEK wrapped with scope key via AES-KW, base64
}

/** Context used to infer scope at write time */
export interface ScopeContext {
  scope?: Scope;        // Explicit override (highest priority)
  source?: string;      // "telegram", "whatsapp", "discord", etc.
  path?: string;        // Document path like "mind/dreams"
  agent_id?: string;    // "personal-agent", "wealth-agent", etc.
  table?: string;       // "people", "wealth_transactions", etc.
}

// ── Constants ──────────────────────────────────────────────────────

const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;
const DEK_BITS = 256;
const TAG_LENGTH = 128;

const HKDF_HASH = "SHA-256";
const HKDF_SALT = new Uint8Array(32); // Zero salt — scope key uniqueness from info string

// ── Scope Key Cache ────────────────────────────────────────────────

// Cache derived scope keys to avoid re-running HKDF per record in batch ops.
// Keyed by `${masterKeyFingerprint}:${scope}` to invalidate on key rotation.
const scopeKeyCache = new Map<string, CryptoKey>();

// ── Base64 helpers ─────────────────────────────────────────────────

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// ── Master Key Import ──────────────────────────────────────────────

/**
 * Import a hex-encoded 256-bit master key as a CryptoKey for HKDF derivation.
 */
export async function importMasterKey(hexKey: string): Promise<CryptoKey> {
  if (hexKey.length !== 64) {
    throw new Error("ENCRYPTION_MASTER_KEY must be 64 hex chars (256 bits)");
  }
  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    keyBytes[i] = parseInt(hexKey.substring(i * 2, i * 2 + 2), 16);
  }
  return crypto.subtle.importKey("raw", keyBytes, "HKDF", false, ["deriveBits", "deriveKey"]);
}

// ── Scope Key Derivation ───────────────────────────────────────────

/**
 * Derive a scope-specific AES key from the master key via HKDF-SHA256.
 *
 * Info string: "mycelium:scope:{scope}:v1"
 * This is deterministic — same master key + scope always yields the same key.
 */
export async function deriveScopeKey(
  masterKey: CryptoKey,
  scope: Scope,
): Promise<CryptoKey> {
  // Check cache first
  // Use a simple fingerprint: we can't extract the master key, so use scope alone.
  // Cache is cleared on rotation by calling clearScopeKeyCache().
  const cacheKey = scope;
  const cached = scopeKeyCache.get(cacheKey);
  if (cached) return cached;

  const info = new TextEncoder().encode(`mycelium:scope:${scope}:v1`);

  // Derive a key usable for both AES-KW (wrapping DEKs) and AES-GCM (not used directly)
  // We derive as raw bits, then import for AES-KW
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: HKDF_HASH, salt: HKDF_SALT, info },
    masterKey,
    DEK_BITS,
  );

  // Import as AES-KW key (for wrapping/unwrapping DEKs)
  const scopeKey = await crypto.subtle.importKey(
    "raw",
    derivedBits,
    "AES-KW",
    false,
    ["wrapKey", "unwrapKey"],
  );

  scopeKeyCache.set(cacheKey, scopeKey);
  return scopeKey;
}

/** Clear the scope key cache (call during key rotation). */
export function clearScopeKeyCache(): void {
  scopeKeyCache.clear();
}

// ── Encrypt ────────────────────────────────────────────────────────

/**
 * Encrypt plaintext content using envelope encryption.
 *
 * 1. Generate random 256-bit DEK
 * 2. Generate random 12-byte IV
 * 3. Encrypt content with DEK via AES-256-GCM
 * 4. Wrap DEK with scope key via AES-KW
 * 5. Return base64-encoded JSON envelope
 */
export async function encrypt(
  plaintext: string,
  scope: Scope,
  masterKey: CryptoKey,
): Promise<string> {
  const scopeKey = await deriveScopeKey(masterKey, scope);

  // 1. Generate random DEK
  const dek = (await crypto.subtle.generateKey(
    { name: "AES-GCM", length: DEK_BITS },
    true, // extractable — needed for AES-KW wrapping
    ["encrypt", "decrypt"],
  )) as CryptoKey;

  // 2. Generate random IV
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  // 3. Encrypt content with DEK
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: TAG_LENGTH },
    dek,
    plaintextBytes,
  );

  // 4. Wrap DEK with scope key
  const wrappedDek = await crypto.subtle.wrapKey("raw", dek, scopeKey, "AES-KW");

  // 5. Build envelope
  const envelope: EncryptedEnvelope = {
    v: ENVELOPE_VERSION,
    s: scope,
    iv: toBase64(iv.buffer),
    ct: toBase64(ciphertext),
    dk: toBase64(wrappedDek),
  };

  return btoa(JSON.stringify(envelope));
}

// ── Decrypt ────────────────────────────────────────────────────────

/**
 * Decrypt an encrypted envelope back to plaintext.
 *
 * @param encoded - Base64-encoded JSON envelope string
 * @param allowedScopes - Scopes the caller is authorized for
 * @param masterKey - The master CryptoKey
 * @returns Decrypted plaintext string
 * @throws If scope is not in allowedScopes, or crypto fails
 */
export async function decrypt(
  encoded: string,
  allowedScopes: Scope[],
  masterKey: CryptoKey,
): Promise<string> {
  const envelope = parseEnvelope(encoded);

  // Scope check
  if (!allowedScopes.includes(envelope.s)) {
    throw new Error(`Access denied: scope "${envelope.s}" not in allowed scopes`);
  }

  const scopeKey = await deriveScopeKey(masterKey, envelope.s);

  // Unwrap DEK
  const wrappedDk = fromBase64(envelope.dk);
  const dek = await crypto.subtle.unwrapKey(
    "raw",
    wrappedDk.buffer as ArrayBuffer,
    scopeKey,
    "AES-KW",
    { name: "AES-GCM", length: DEK_BITS },
    false,
    ["decrypt"],
  );

  // Decrypt content
  const iv = fromBase64(envelope.iv);
  const ct = fromBase64(envelope.ct);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer, tagLength: TAG_LENGTH },
    dek,
    ct.buffer as ArrayBuffer,
  );

  return new TextDecoder().decode(decrypted);
}

// ── Key Rotation ───────────────────────────────────────────────────

/**
 * Re-wrap the DEK in an envelope with a new master key.
 * Content is NEVER decrypted — only the 32-byte DEK is re-wrapped.
 *
 * @returns New base64-encoded envelope with the same iv/ct but new dk
 */
export async function rotateEnvelope(
  encoded: string,
  oldMasterKey: CryptoKey,
  newMasterKey: CryptoKey,
): Promise<string> {
  const envelope = parseEnvelope(encoded);

  // Derive old and new scope keys
  const oldScopeKey = await deriveScopeKey(oldMasterKey, envelope.s);

  // We need to derive the new scope key without cache (different master key)
  const newInfo = new TextEncoder().encode(`mycelium:scope:${envelope.s}:v1`);
  const newDerivedBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: HKDF_HASH, salt: HKDF_SALT, info: newInfo },
    newMasterKey,
    DEK_BITS,
  );
  const newScopeKey = await crypto.subtle.importKey(
    "raw",
    newDerivedBits,
    "AES-KW",
    false,
    ["wrapKey"],
  );

  // Unwrap DEK with old scope key
  const oldWrappedDk = fromBase64(envelope.dk);
  const dek = await crypto.subtle.unwrapKey(
    "raw",
    oldWrappedDk.buffer as ArrayBuffer,
    oldScopeKey,
    "AES-KW",
    { name: "AES-GCM", length: DEK_BITS },
    true, // extractable — need to re-wrap
    ["encrypt", "decrypt"],
  );

  // Re-wrap DEK with new scope key
  const newWrappedDek = await crypto.subtle.wrapKey("raw", dek, newScopeKey, "AES-KW");

  // Return updated envelope — iv and ct are unchanged
  const newEnvelope: EncryptedEnvelope = {
    v: ENVELOPE_VERSION,
    s: envelope.s,
    iv: envelope.iv,
    ct: envelope.ct,
    dk: toBase64(newWrappedDek),
  };

  return btoa(JSON.stringify(newEnvelope));
}

// ── Scope Inference ────────────────────────────────────────────────

/**
 * Determine the encryption scope from context.
 * Priority order (first match wins):
 *
 * 1. Explicit scope parameter
 * 2. source = "telegram" | "whatsapp" → personal
 * 3. path starts with "mind/" | "internal/" | "transcriptions/" | "states/" → personal
 * 4. path starts with "wealth/" → wealth
 * 5. table = "people" → personal
 * 6. table starts with "wealth_" → wealth
 * 7. agent_id = "wealth-agent" → wealth
 * 8. agent_id = "moms-agent" → moms
 * 9. agent_id = "personal-agent" | "mya-personal" → personal
 * 10. Default → org
 */
export function inferScope(ctx: ScopeContext): Scope {
  // 1. Explicit
  if (ctx.scope) return ctx.scope;

  // 2. Personal sources (only for personal-agent, not moms-agent)
  if (ctx.source === "telegram" || ctx.source === "whatsapp") {
    // Moms-agent Telegram messages should be scoped to moms, not personal
    if (ctx.agent_id === "moms-agent") return "moms";
    return "personal";
  }

  // 3. Path-based
  if (ctx.path) {
    const p = ctx.path.toLowerCase();
    if (
      p.startsWith("mind/") ||
      p.startsWith("internal/") ||
      p.startsWith("transcriptions/") ||
      p.startsWith("states/")
    ) {
      // Moms-agent mind files stay in moms scope
      if (ctx.agent_id === "moms-agent") return "moms";
      return "personal";
    }
    if (p.startsWith("wealth/")) return "wealth";
  }

  // 4-5. Table-based
  if (ctx.table) {
    if (ctx.table === "people") return "personal";
    if (ctx.table.startsWith("wealth_")) return "wealth";
  }

  // 6-8. Agent-based
  if (ctx.agent_id) {
    if (ctx.agent_id === "wealth-agent") return "wealth";
    if (ctx.agent_id === "moms-agent") return "moms";
    if (ctx.agent_id === "personal-agent" || ctx.agent_id === "mya-personal") return "personal";
  }

  // 9. Default
  return "org";
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Parse and validate a base64-encoded envelope string.
 */
export function parseEnvelope(encoded: string): EncryptedEnvelope {
  let json: string;
  try {
    json = atob(encoded);
  } catch {
    throw new Error("Invalid envelope: not valid base64");
  }

  let envelope: EncryptedEnvelope;
  try {
    envelope = JSON.parse(json);
  } catch {
    throw new Error("Invalid envelope: not valid JSON");
  }

  if (envelope.v !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported envelope version: ${envelope.v}`);
  }
  if (!["personal", "org", "wealth", "moms"].includes(envelope.s)) {
    throw new Error(`Invalid scope in envelope: ${envelope.s}`);
  }
  if (!envelope.iv || !envelope.ct || !envelope.dk) {
    throw new Error("Invalid envelope: missing iv, ct, or dk");
  }

  return envelope;
}

/**
 * Check if a string value looks like an encrypted envelope.
 * Uses the `eyJ` heuristic — base64 of `{"v":1,...}` always starts with `eyJ`.
 */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith("eyJ");
}

/**
 * Batch-encrypt multiple fields in an object.
 * Only encrypts string values for the specified field names.
 *
 * @param record - The data record
 * @param fields - Field names to encrypt
 * @param scope - Encryption scope
 * @param masterKey - Master CryptoKey
 * @returns New object with specified fields encrypted
 */
export async function encryptFields(
  record: Record<string, unknown>,
  fields: string[],
  scope: Scope,
  masterKey: CryptoKey,
): Promise<Record<string, unknown>> {
  const result = { ...record };
  for (const field of fields) {
    const value = result[field];
    if (typeof value === "string" && value.length > 0 && !isEncrypted(value)) {
      result[field] = await encrypt(value, scope, masterKey);
    }
  }
  return result;
}

/**
 * Batch-decrypt multiple fields in an object.
 * Only decrypts values that look like encrypted envelopes.
 *
 * @param record - The data record
 * @param fields - Field names to decrypt
 * @param allowedScopes - Scopes the caller is authorized for
 * @param masterKey - Master CryptoKey
 * @returns New object with specified fields decrypted
 */
export async function decryptFields(
  record: Record<string, unknown>,
  fields: string[],
  allowedScopes: Scope[],
  masterKey: CryptoKey,
): Promise<Record<string, unknown>> {
  const result = { ...record };
  for (const field of fields) {
    const value = result[field];
    if (typeof value === "string" && isEncrypted(value)) {
      try {
        result[field] = await decrypt(value, allowedScopes, masterKey);
      } catch {
        // If decryption fails (wrong scope, corrupted), replace with marker
        result[field] = "[DECRYPTION_FAILED]";
      }
    }
  }
  return result;
}

/** Map of table → fields that get encrypted */
export const ENCRYPTED_FIELDS: Record<string, string[]> = {
  messages: ["content", "thinking"],
  documents: ["content", "summary"],
  attachments: ["transcript"],
  clustering_points: ["content"],
  agent_events: ["payload"],
  agent_tasks: ["context", "result"],
  people: ["name", "aliases", "description", "metadata", "email", "phone", "company", "position", "linkedin_url"],
  wealth_transactions: ["notes"],
  wealth_positions: ["total_cost", "current_value", "unrealized_pnl", "avg_cost_basis"],
  wealth_snapshots: ["total_value", "total_invested", "total_pnl", "day_change"],
  health_daily: [
    "sleep_duration_min", "sleep_in_bed_min", "sleep_efficiency",
    "sleep_deep_min", "sleep_rem_min", "sleep_core_min", "sleep_awake_min",
    "sleep_start", "sleep_end",
    "hrv_avg", "hrv_sleep_avg", "resting_hr",
    "steps", "active_energy_kcal", "workout_count", "workout_minutes", "workout_types",
    "mindful_minutes",
  ],
};

/**
 * Get the list of encrypted fields for a given table.
 * Returns empty array if the table has no encrypted fields.
 */
export function getEncryptedFields(table: string): string[] {
  return ENCRYPTED_FIELDS[table] || [];
}
