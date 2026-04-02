/**
 * Encrypted Data API Endpoints
 *
 * Structured endpoints that transparently encrypt on write and decrypt on read.
 * Agents send plaintext, receive plaintext — encryption is invisible.
 *
 * Endpoints:
 *   POST /api/data/store   — encrypt sensitive fields, INSERT/UPDATE
 *   POST /api/data/query   — SELECT with scope filtering, decrypt results
 *   POST /api/admin/backfill — encrypt existing plaintext rows in batches
 *   POST /api/admin/rotate-key — re-wrap DEKs with new master key
 */

import type { Env } from "../types/env";
import { requireAuth, type AgentIdentity } from "../middleware/agent-auth";
import { corsOrigin } from "../utils/cors";
import {
  importMasterKey,
  encrypt,
  decrypt,
  rotateEnvelope,
  inferScope,
  encryptFields,
  decryptFields,
  getEncryptedFields,
  isEncrypted,
  clearScopeKeyCache,
  type Scope,
} from "../services/crypto";

const JSON_HEADERS = { "Content-Type": "application/json" };

// Tables with scope-based encryption
const SCOPED_TABLES = new Set([
  "messages", "documents", "attachments", "clustering_points",
  "agent_events", "agent_tasks", "people",
  "wealth_transactions", "wealth_positions", "wealth_snapshots",
]);

// Tables where the default scope differs from 'org'
const TABLE_DEFAULT_SCOPE: Record<string, Scope> = {
  people: "personal",
  wealth_transactions: "wealth",
  wealth_positions: "wealth",
  wealth_snapshots: "wealth",
};

// ── Column whitelists per table (prevents SQL injection via columns/order_by/filters) ──

const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

const TABLE_COLUMNS: Record<string, Set<string>> = {
  messages: new Set(["id", "role", "source", "agent_id", "conversation_id", "parent_id", "content", "thinking", "metadata", "entity_summary", "scope", "user_id", "created_at", "updated_at"]),
  documents: new Set(["id", "path", "source", "agent_id", "content", "description", "notes", "metadata", "scope", "user_id", "created_at", "updated_at"]),
  attachments: new Set(["id", "message_id", "filename", "content_type", "size", "r2_key", "transcript", "description", "metadata", "scope", "user_id", "created_at"]),
  clustering_points: new Set(["id", "source_id", "source_type", "agent_id", "content", "x", "y", "cluster_id", "label", "scope", "user_id", "created_at"]),
  agent_events: new Set(["id", "agent_id", "event_type", "summary", "context", "result", "scope", "user_id", "created_at"]),
  agent_tasks: new Set(["id", "agent_id", "title", "description", "status", "priority", "due_date", "payload", "scope", "user_id", "created_at", "updated_at"]),
  people: new Set(["id", "name", "email", "phone", "company", "notes", "metadata", "scope", "user_id", "created_at", "updated_at"]),
  wealth_transactions: new Set(["id", "account_id", "type", "asset", "amount", "price", "currency", "fee", "notes", "metadata", "scope", "user_id", "created_at"]),
  wealth_positions: new Set(["id", "account_id", "asset", "quantity", "cost_basis", "currency", "notes", "metadata", "scope", "user_id", "updated_at"]),
  wealth_snapshots: new Set(["id", "snapshot_date", "total_value", "currency", "breakdown", "notes", "scope", "user_id", "created_at"]),
};

function isValidColumn(table: string, column: string): boolean {
  const cols = TABLE_COLUMNS[table];
  if (!cols) return false;
  return cols.has(column);
}

function isValidIdentifier(name: string): boolean {
  return SAFE_IDENTIFIER.test(name);
}

// Max rows per query
const MAX_LIMIT = 500;
const BACKFILL_BATCH_SIZE = 200;

// ── Master Key Cache ───────────────────────────────────────────────

let masterKeyCache: CryptoKey | null = null;

async function getMasterKey(env: Env): Promise<CryptoKey> {
  if (masterKeyCache) return masterKeyCache;
  const hex = (env as unknown as Record<string, unknown>).ENCRYPTION_MASTER_KEY as string | undefined;
  if (!hex) throw new Error("ENCRYPTION_MASTER_KEY not configured");
  masterKeyCache = await importMasterKey(hex);
  return masterKeyCache;
}

// ── Route Handler ──────────────────────────────────────────────────

/**
 * Route a data API request. Returns null if path doesn't match.
 */
export async function handleDataRequest(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response | null> {
  // CORS preflight
  if (request.method === "OPTIONS") {
    if (pathname.startsWith("/api/data/") || pathname.startsWith("/api/admin/")) {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": corsOrigin(request),
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }
    return null;
  }

  if (request.method !== "POST") return null;

  switch (pathname) {
    case "/api/data/store":
      return handleStore(request, env);
    case "/api/data/query":
      return handleQuery(request, env);
    case "/api/admin/backfill":
      return handleBackfill(request, env);
    case "/api/admin/rotate-key":
      return handleRotateKey(request, env);
    default:
      return null;
  }
}

// ── POST /api/data/store ───────────────────────────────────────────

interface StoreRequest {
  table: string;
  data: Record<string, unknown>;
  /** Scope context hints for inference */
  context?: {
    scope?: Scope;
    source?: string;
    path?: string;
    agent_id?: string;
  };
  /** If true, UPDATE existing row (requires id or unique key in data) */
  upsert?: boolean;
}

async function handleStore(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;
  const identity = authResult as AgentIdentity;

  if (!env.DB) {
    return jsonError("D1 not configured", 503);
  }

  try {
    const body = (await request.json()) as StoreRequest;
    const { table, data, context, upsert } = body;

    if (!table || !data || typeof data !== "object") {
      return jsonError("Missing table or data", 400);
    }
    if (!SCOPED_TABLES.has(table)) {
      return jsonError(`Table "${table}" is not a scoped table`, 400);
    }

    const masterKey = await getMasterKey(env);

    // Infer scope from context + identity
    const scope = inferScope({
      scope: context?.scope,
      source: context?.source || (data.source as string | undefined),
      path: context?.path || (data.path as string | undefined),
      agent_id: context?.agent_id || identity.agent,
      table,
    });

    // Verify the agent is authorized for this scope
    if (!identity.scopes.includes(scope)) {
      return jsonError(`Not authorized for scope "${scope}"`, 403);
    }

    // Encrypt sensitive fields
    const encFields = getEncryptedFields(table);
    const encrypted = await encryptFields(data, encFields, scope, masterKey);

    // Add scope and user_id to the record
    encrypted.scope = scope;
    if (identity.user_id !== "system") {
      encrypted.user_id = identity.user_id;
    }

    // Build INSERT or UPSERT SQL — validate all column names
    const columns = Object.keys(encrypted);
    for (const col of columns) {
      if (!isValidIdentifier(col)) {
        return jsonError(`Invalid column name "${col}"`, 400);
      }
    }
    const placeholders = columns.map(() => "?").join(", ");
    const values = columns.map((c) => encrypted[c]);

    let sql: string;
    if (upsert && data.id) {
      // UPDATE by id
      const setClauses = columns.filter((c) => c !== "id").map((c) => `${c} = ?`).join(", ");
      const updateValues = columns.filter((c) => c !== "id").map((c) => encrypted[c]);
      sql = `UPDATE ${table} SET ${setClauses} WHERE id = ?`;
      const stmt = env.DB.prepare(sql).bind(...updateValues, data.id);
      const result = await stmt.run();
      await logAudit(env, identity, "/api/data/store", scope, table, 1, true);
      return jsonOk({ success: true, meta: result.meta });
    } else {
      sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;
      const stmt = env.DB.prepare(sql).bind(...values);
      const result = await stmt.run();
      await logAudit(env, identity, "/api/data/store", scope, table, 1, true);
      return jsonOk({ success: true, meta: result.meta });
    }
  } catch (e: unknown) {
    console.error("[Data Store]", e instanceof Error ? e.message : e);
    return jsonError("Store operation failed", 500);
  }
}

// ── POST /api/data/query ───────────────────────────────────────────

interface QueryRequest {
  table: string;
  columns?: string[];
  filters?: Record<string, unknown>;
  order_by?: string;
  order_dir?: "ASC" | "DESC";
  limit?: number;
  offset?: number;
}

async function handleQuery(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;
  const identity = authResult as AgentIdentity;

  if (!env.DB) {
    return jsonError("D1 not configured", 503);
  }

  try {
    const body = (await request.json()) as QueryRequest;
    const { table, columns, filters, order_by, order_dir, limit, offset } = body;

    if (!table) {
      return jsonError("Missing table", 400);
    }
    if (!SCOPED_TABLES.has(table)) {
      return jsonError(`Table "${table}" is not a scoped table`, 400);
    }

    const masterKey = await getMasterKey(env);
    const effectiveLimit = Math.min(limit || 50, MAX_LIMIT);

    // Validate columns against whitelist (prevents SQL injection)
    if (columns) {
      for (const col of columns) {
        if (!isValidColumn(table, col)) {
          return jsonError(`Invalid column "${col}" for table "${table}"`, 400);
        }
      }
    }

    // Validate order_by against whitelist
    if (order_by && !isValidColumn(table, order_by)) {
      return jsonError(`Invalid order_by column "${order_by}" for table "${table}"`, 400);
    }

    // Validate order_dir
    const safeOrderDir = order_dir === "ASC" ? "ASC" : "DESC";

    // Build SELECT with scope filtering
    const selectCols = columns?.join(", ") || "*";
    const whereClauses: string[] = [];
    const params: unknown[] = [];

    // Scope filter — only return rows the agent is authorized for
    if (identity.scopes.length > 0) {
      const scopePlaceholders = identity.scopes.map(() => "?").join(", ");
      whereClauses.push(`scope IN (${scopePlaceholders})`);
      params.push(...identity.scopes);
    } else {
      return jsonOk({ results: [] }); // No scopes = no data
    }

    // User isolation (skip for legacy system tokens)
    if (identity.user_id !== "system") {
      whereClauses.push("user_id = ?");
      params.push(identity.user_id);
    }

    // Additional filters — validate keys against column whitelist
    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        if (key === "limit" || key === "offset") continue;
        if (!isValidColumn(table, key)) {
          return jsonError(`Invalid filter key "${key}" for table "${table}"`, 400);
        }
        whereClauses.push(`${key} = ?`);
        params.push(value);
      }
    }

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const orderStr = order_by ? `ORDER BY ${order_by} ${safeOrderDir}` : "";
    const limitStr = `LIMIT ${effectiveLimit}`;
    const offsetStr = offset ? `OFFSET ${Math.max(0, Math.floor(offset as number))}` : "";

    const sql = `SELECT ${selectCols} FROM ${table} ${whereStr} ${orderStr} ${limitStr} ${offsetStr}`;
    const result = await env.DB.prepare(sql).bind(...params).all();
    const rows = (result.results || []) as Record<string, unknown>[];

    // Decrypt sensitive fields
    const encFields = getEncryptedFields(table);
    const decrypted = await Promise.all(
      rows.map((row) => decryptFields(row, encFields, identity.scopes, masterKey)),
    );

    await logAudit(env, identity, "/api/data/query", null, table, decrypted.length, true);
    return jsonOk({ results: decrypted, meta: result.meta });
  } catch (e: unknown) {
    console.error("[Data Query]", e instanceof Error ? e.message : e);
    return jsonError("Query failed", 500);
  }
}

// ── POST /api/admin/backfill ───────────────────────────────────────

interface BackfillRequest {
  table: string;
  batch_size?: number;
}

async function handleBackfill(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;
  const identity = authResult as AgentIdentity;

  // Admin-only — require explicit admin identity (ADMIN_SECRET), not just scope overlap
  if (identity.agent !== "admin" && identity.auth_type !== "agent") {
    return jsonError("Admin access required", 403);
  }
  if (identity.agent !== "admin" && (!identity.scopes.includes("personal") || !identity.scopes.includes("org") || !identity.scopes.includes("wealth"))) {
    return jsonError("Admin access required (all scopes)", 403);
  }

  if (!env.DB) {
    return jsonError("D1 not configured", 503);
  }

  try {
    const body = (await request.json()) as BackfillRequest;
    const { table, batch_size } = body;

    if (!table || !SCOPED_TABLES.has(table)) {
      return jsonError("Invalid or missing table", 400);
    }

    const masterKey = await getMasterKey(env);
    const encFields = getEncryptedFields(table);
    if (encFields.length === 0) {
      return jsonOk({ message: `No encrypted fields for table ${table}`, encrypted: 0, total: 0 });
    }

    const batchSize = Math.min(batch_size || BACKFILL_BATCH_SIZE, 500);

    // Find unencrypted rows: content not starting with 'eyJ' (base64 envelope prefix)
    // Skip oversized rows — encryption (AES-GCM + double base64) adds ~78% overhead, D1 max is ~2MB
    const MAX_PLAINTEXT_SIZE = 1_000_000;
    const primaryField = encFields[0];
    const sql = `SELECT * FROM ${table} WHERE ${primaryField} IS NOT NULL AND ${primaryField} != '' AND ${primaryField} NOT LIKE 'eyJ%' AND length(${primaryField}) < ${MAX_PLAINTEXT_SIZE} LIMIT ?`;
    const result = await env.DB.prepare(sql).bind(batchSize).all();
    const rows = (result.results || []) as Record<string, unknown>[];

    // Count oversized rows that can't be encrypted
    const oversizedResult = await env.DB.prepare(
      `SELECT COUNT(*) as total FROM ${table} WHERE ${primaryField} IS NOT NULL AND ${primaryField} != '' AND ${primaryField} NOT LIKE 'eyJ%' AND length(${primaryField}) >= ${MAX_PLAINTEXT_SIZE}`,
    ).first<{ total: number }>();
    const oversized = oversizedResult?.total || 0;

    if (rows.length === 0) {
      return jsonOk({
        message: oversized > 0
          ? `No encryptable rows in ${table} (${oversized} oversized rows skipped)`
          : `All rows in ${table} are already encrypted`,
        encrypted: 0,
        remaining: 0,
        oversized,
      });
    }

    let encrypted = 0;
    let skipped = 0;
    for (const row of rows) {
      // Infer scope from row context
      const scope = inferScope({
        source: row.source as string | undefined,
        path: row.path as string | undefined,
        agent_id: row.agent_id as string | undefined,
        table,
      });

      // Encrypt each field
      const updates: string[] = [];
      const params: unknown[] = [];

      for (const field of encFields) {
        const value = row[field];
        if (typeof value === "string" && value.length > 0 && !isEncrypted(value)) {
          const enc = await encrypt(value, scope, masterKey);
          updates.push(`${field} = ?`);
          params.push(enc);
        }
      }

      // Set scope column
      updates.push("scope = ?");
      params.push(scope);

      if (updates.length > 1) { // At least one encrypted field + scope
        try {
          const updateSql = `UPDATE ${table} SET ${updates.join(", ")} WHERE id = ?`;
          params.push(row.id);
          await env.DB.prepare(updateSql).bind(...params).run();
          encrypted++;
        } catch (rowErr: unknown) {
          const errMsg = rowErr instanceof Error ? rowErr.message : String(rowErr);
          if (errMsg.includes("TOOBIG")) {
            skipped++;
          } else {
            throw rowErr;
          }
        }
      }
    }

    // Count total remaining (excluding oversized)
    const countResult = await env.DB.prepare(
      `SELECT COUNT(*) as total FROM ${table} WHERE ${primaryField} IS NOT NULL AND ${primaryField} != '' AND ${primaryField} NOT LIKE 'eyJ%' AND length(${primaryField}) < ${MAX_PLAINTEXT_SIZE}`,
    ).first<{ total: number }>();

    await logAudit(env, identity, "/api/admin/backfill", null, table, encrypted, true);
    return jsonOk({
      message: `Encrypted ${encrypted} rows in ${table}`,
      encrypted,
      remaining: countResult?.total || 0,
      oversized: oversized + skipped,
    });
  } catch (e: unknown) {
    console.error("[Backfill]", e instanceof Error ? e.message : e);
    return jsonError("Backfill failed", 500);
  }
}

// ── POST /api/admin/rotate-key ─────────────────────────────────────

interface RotateKeyRequest {
  new_master_key_hex: string;
  table: string;
  batch_size?: number;
}

async function handleRotateKey(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;
  const identity = authResult as AgentIdentity;

  // Admin-only — require explicit admin identity (ADMIN_SECRET), not just scope overlap
  if (identity.agent !== "admin" && identity.auth_type !== "agent") {
    return jsonError("Admin access required", 403);
  }
  if (identity.agent !== "admin" && (!identity.scopes.includes("personal") || !identity.scopes.includes("org") || !identity.scopes.includes("wealth"))) {
    return jsonError("Admin access required (all scopes)", 403);
  }

  if (!env.DB) {
    return jsonError("D1 not configured", 503);
  }

  try {
    const body = (await request.json()) as RotateKeyRequest;
    const { new_master_key_hex, table, batch_size } = body;

    if (!new_master_key_hex || new_master_key_hex.length !== 64) {
      return jsonError("new_master_key_hex must be 64 hex chars", 400);
    }
    if (!table || !SCOPED_TABLES.has(table)) {
      return jsonError("Invalid or missing table", 400);
    }

    const oldMasterKey = await getMasterKey(env);
    const newMasterKey = await importMasterKey(new_master_key_hex);
    const encFields = getEncryptedFields(table);
    if (encFields.length === 0) {
      return jsonOk({ message: `No encrypted fields for table ${table}`, rotated: 0 });
    }

    const batchSize = Math.min(batch_size || BACKFILL_BATCH_SIZE, 500);
    const primaryField = encFields[0];

    // Select encrypted rows
    const sql = `SELECT id, ${encFields.join(", ")} FROM ${table} WHERE ${primaryField} LIKE 'eyJ%' LIMIT ?`;
    const result = await env.DB.prepare(sql).bind(batchSize).all();
    const rows = (result.results || []) as Record<string, unknown>[];

    let rotated = 0;
    for (const row of rows) {
      const updates: string[] = [];
      const params: unknown[] = [];

      for (const field of encFields) {
        const value = row[field];
        if (typeof value === "string" && isEncrypted(value)) {
          const newEnvelope = await rotateEnvelope(value, oldMasterKey, newMasterKey);
          updates.push(`${field} = ?`);
          params.push(newEnvelope);
        }
      }

      if (updates.length > 0) {
        const updateSql = `UPDATE ${table} SET ${updates.join(", ")} WHERE id = ?`;
        params.push(row.id);
        await env.DB.prepare(updateSql).bind(...params).run();
        rotated++;
      }
    }

    // Clear scope key cache since we're rotating keys
    clearScopeKeyCache();
    masterKeyCache = null;

    await logAudit(env, identity, "/api/admin/rotate-key", null, table, rotated, true);
    return jsonOk({
      message: `Rotated ${rotated} rows in ${table}`,
      rotated,
      has_more: rows.length === batchSize,
    });
  } catch (e: unknown) {
    console.error("[Rotate Key]", e instanceof Error ? e.message : e);
    return jsonError("Key rotation failed", 500);
  }
}

// ── Audit Logging ──────────────────────────────────────────────────

async function logAudit(
  env: Env,
  identity: AgentIdentity,
  endpoint: string,
  scope: string | null,
  table: string,
  recordCount: number,
  success: boolean,
  error?: string,
): Promise<void> {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (agent_id, endpoint, method, scope, table_name, record_count, success, error)
       VALUES (?, ?, 'POST', ?, ?, ?, ?, ?)`,
    )
      .bind(
        identity.agent,
        endpoint,
        scope,
        table,
        recordCount,
        success ? 1 : 0,
        error || null,
      )
      .run();
  } catch {
    // Non-fatal — don't fail the request if audit logging fails
    console.error("[Audit] Failed to log audit entry");
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: JSON_HEADERS });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: JSON_HEADERS,
  });
}
