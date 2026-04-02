/**
 * D1 + Vectorize Proxy Endpoints
 *
 * Allows the VPS (mycelium agents) to access D1/Vectorize over HTTP.
 * Authenticated via MYA_WORKER_SECRET or ADMIN_SECRET.
 *
 * Endpoints:
 *   POST /api/db/query   — execute a single SQL statement on D1
 *   POST /api/db/batch   — execute multiple SQL statements on D1
 *   POST /api/vectors/upsert — upsert vectors to a Vectorize index
 *   POST /api/vectors/query  — similarity search on a Vectorize index
 *   POST /api/search/hybrid  — keyword (FTS5) + semantic (Vectorize) search
 */

import type { Env } from "../types/env";
import { authenticateRequest } from "../middleware/agent-auth";
import { corsPreflight } from "../utils/cors";
import {
  importMasterKey,
  decrypt,
  encrypt,
  isEncrypted,
  inferScope,
  getEncryptedFields,
  type Scope,
} from "../services/crypto";
import type { AgentIdentity } from "../middleware/agent-auth";

const JSON_HEADERS = { "Content-Type": "application/json" };

// ── Auto-decrypt support ────────────────────────────────────────────────────

let masterKeyCache: CryptoKey | null = null;

async function getMasterKey(env: Env): Promise<CryptoKey | null> {
  if (masterKeyCache) return masterKeyCache;
  const hex = (env as unknown as Record<string, unknown>).ENCRYPTION_MASTER_KEY as string | undefined;
  if (!hex) return null;
  masterKeyCache = await importMasterKey(hex);
  return masterKeyCache;
}

/**
 * Transparently decrypt encrypted fields in query results.
 * Plaintext values pass through unchanged — safe during the mixed transition period.
 * Uses the caller's identity scopes to control access.
 */
async function autoDecryptResults(
  rows: Record<string, unknown>[],
  allowedScopes: Scope[],
  env: Env,
): Promise<Record<string, unknown>[]> {
  if (!rows.length) return rows;

  // Fast check: skip if no encrypted values in any row
  const hasEncrypted = rows.some((row) =>
    Object.values(row).some((v) => typeof v === "string" && isEncrypted(v)),
  );
  if (!hasEncrypted) return rows;

  const masterKey = await getMasterKey(env);
  if (!masterKey) {
    console.error("[db-proxy] ENCRYPTION_MASTER_KEY not available — cannot decrypt");
    return rows;
  }

  return Promise.all(
    rows.map(async (row) => {
      const result = { ...row };
      for (const [key, value] of Object.entries(result)) {
        if (typeof value === "string" && isEncrypted(value)) {
          try {
            result[key] = await decrypt(value, allowedScopes, masterKey);
          } catch (err) {
            // Log decryption failures so we can diagnose scope mismatches
            const preview = typeof value === "string" ? value.slice(0, 40) : "?";
            const rowId = result.id || result.path || "unknown";
            console.error(
              `[db-proxy] decrypt failed: key=${key} row=${rowId} scopes=[${allowedScopes}] err=${(err as Error).message} preview=${preview}...`,
            );
          }
        }
      }
      return result;
    }),
  );
}

// ── Auto-encrypt on writes ──────────────────────────────────────────────────

interface ParsedInsert {
  type: "insert";
  table: string;
  columns: string[];
  encryptedColumnIndices: number[]; // which columns have encrypted fields
}

interface ParsedUpdate {
  type: "update";
  table: string;
  encryptedParamIndices: number[]; // indices into SET params (not total params)
}

/**
 * Split a VALUES group content by commas, respecting nested parens.
 * e.g. "?, ?, datetime(\"now\")" → ["?", "?", "datetime(\"now\")"]
 */
function splitValueExprs(content: string): string[] {
  const exprs: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of content) {
    if (ch === "(") { depth++; current += ch; }
    else if (ch === ")") { depth--; current += ch; }
    else if (ch === "," && depth === 0) { exprs.push(current.trim()); current = ""; }
    else { current += ch; }
  }
  if (current.trim()) exprs.push(current.trim());
  return exprs;
}

/**
 * Extract the content of the first VALUES group, handling nested parens.
 * Returns the content inside (...) after VALUES, or null.
 */
function extractFirstValuesGroup(sql: string): string | null {
  const valuesIdx = sql.search(/VALUES\s*\(/i);
  if (valuesIdx === -1) return null;
  const start = sql.indexOf("(", valuesIdx);
  if (start === -1) return null;
  let depth = 1;
  let pos = start + 1;
  while (pos < sql.length && depth > 0) {
    if (sql[pos] === "(") depth++;
    else if (sql[pos] === ")") depth--;
    pos++;
  }
  if (depth !== 0) return null;
  return sql.slice(start + 1, pos - 1);
}

/**
 * Parse INSERT or UPDATE SQL to find which columns/params map to encrypted fields.
 * Returns null if the statement has no encrypted fields.
 */
function parseWriteSQL(sql: string): ParsedInsert | ParsedUpdate | null {
  const trimmed = sql.trimStart().toUpperCase();

  // INSERT INTO tablename (col1, col2) VALUES (?, ?, expr) ...
  if (trimmed.startsWith("INSERT")) {
    const match = sql.match(/INSERT\s+(?:OR\s+(?:REPLACE|IGNORE)\s+)?INTO\s+(\w+)\s*\(([^)]+)\)/i);
    if (!match) return null;
    const table = match[1];
    const columns = match[2].split(",").map((c) => c.trim());
    const encrypted = getEncryptedFields(table);
    if (!encrypted.length) return null;
    const encryptedColumnIndices: number[] = [];
    for (let i = 0; i < columns.length; i++) {
      if (encrypted.includes(columns[i])) encryptedColumnIndices.push(i);
    }
    if (!encryptedColumnIndices.length) return null;
    return { type: "insert", table, columns, encryptedColumnIndices };
  }

  // UPDATE tablename SET col = ?, col2 = ? WHERE ...
  if (trimmed.startsWith("UPDATE")) {
    const tableMatch = sql.match(/UPDATE\s+(\w+)\s+SET/i);
    if (!tableMatch) return null;
    const table = tableMatch[1];
    const encrypted = getEncryptedFields(table);
    if (!encrypted.length) return null;

    // Extract SET clause
    const setMatch = sql.match(/SET\s+(.+?)(?:\s+WHERE|\s+ORDER|\s+LIMIT|\s+RETURNING|;|$)/i);
    if (!setMatch) return null;
    const setClause = setMatch[1];

    // Parse SET assignments, tracking param index
    const assignments = setClause.split(",").map((s) => s.trim());
    const encryptedParamIndices: number[] = [];
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
    return { type: "update", table, encryptedParamIndices };
  }

  return null;
}

/**
 * Auto-encrypt sensitive params in INSERT/UPDATE statements.
 * Modifies params in-place. Also injects `scope` column for INSERTs if missing.
 * Handles SQL expressions in VALUES (e.g. datetime("now")) correctly.
 * Returns potentially modified sql (if scope column was injected).
 */
async function autoEncryptParams(
  sql: string,
  params: unknown[],
  identity: AgentIdentity,
  env: Env,
): Promise<string> {
  const parsed = parseWriteSQL(sql);
  if (!parsed) return sql;

  const masterKey = await getMasterKey(env);
  if (!masterKey) return sql;

  const scope = inferScope({ table: parsed.table, agent_id: identity.agent });

  if (parsed.type === "insert") {
    const { columns, encryptedColumnIndices } = parsed;

    // Parse VALUES group to map columns → param positions (handles SQL expressions)
    const valuesContent = extractFirstValuesGroup(sql);
    if (!valuesContent) return sql;
    const valueExprs = splitValueExprs(valuesContent);

    // Build column → param index mapping (null for SQL expressions, not ?)
    const colToParamIdx = new Map<number, number>();
    let pIdx = 0;
    for (let i = 0; i < valueExprs.length; i++) {
      if (valueExprs[i] === "?") {
        colToParamIdx.set(i, pIdx++);
      }
    }
    const paramsPerRow = pIdx;
    const numRows = paramsPerRow > 0 ? Math.floor(params.length / paramsPerRow) : 0;

    // Encrypt each matching param across all rows
    for (let row = 0; row < numRows; row++) {
      for (const colIdx of encryptedColumnIndices) {
        const paramPos = colToParamIdx.get(colIdx);
        if (paramPos === undefined) continue; // SQL expression, not a param
        const absIdx = row * paramsPerRow + paramPos;
        const value = params[absIdx];
        if (typeof value === "string" && value.length > 0 && !isEncrypted(value)) {
          params[absIdx] = await encrypt(value, scope, masterKey);
        }
      }
    }

    // Inject scope column if not already present
    if (!columns.includes("scope")) {
      // Add ", scope" to column list
      sql = sql.replace(
        /INSERT(\s+(?:OR\s+(?:REPLACE|IGNORE)\s+)?INTO\s+\w+\s*)\(([^)]+)\)/i,
        (_, prefix, cols) => `INSERT${prefix}(${cols}, scope)`,
      );

      // Rebuild VALUES with original expressions preserved + appended scope ?
      const newValueExprs = [...valueExprs, "?"];
      const newRowTemplate = `(${newValueExprs.join(", ")})`;
      const allTemplates = new Array(numRows).fill(newRowTemplate).join(", ");
      sql = sql.replace(
        /VALUES\s+.+?(?=\s+ON\s+CONFLICT|\s+RETURNING|;|$)/is,
        `VALUES ${allTemplates}`,
      );

      // Rebuild params: original row params + scope after each row
      const newParams: unknown[] = [];
      for (let row = 0; row < numRows; row++) {
        for (let i = 0; i < paramsPerRow; i++) {
          newParams.push(params[row * paramsPerRow + i]);
        }
        newParams.push(scope);
      }
      params.length = 0;
      params.push(...newParams);
    }
  } else if (parsed.type === "update") {
    for (const paramIdx of parsed.encryptedParamIndices) {
      const value = params[paramIdx];
      if (typeof value === "string" && value.length > 0 && !isEncrypted(value)) {
        params[paramIdx] = await encrypt(value, scope, masterKey);
      }
    }
  }

  return sql;
}

// CORS headers are centralized in utils/cors.ts

// Limits
const MAX_SQL_LENGTH = 50_000;
const MAX_PARAMS = 500;
const MAX_BATCH_STATEMENTS = 100;
const MAX_VECTOR_BATCH = 1000;
const MAX_TOPK = 100;
const MAX_LIMIT = 100;

// DDL statements that must never be executed via proxy
const DDL_PATTERN = /^\s*(DROP|ALTER|CREATE|ATTACH|DETACH|REINDEX|VACUUM)\s/i;

// Sensitive columns redacted from raw /api/db/query results.
// Forces agents to use /api/data/query for decrypted content.
const REDACTED_COLUMNS = new Set([
  "content", "thinking", "transcript", "description",
  "notes", "metadata", "context", "result", "payload",
  "summary", "diff",
]);

/**
 * Redact sensitive columns from raw query results.
 * Gated by ENABLE_CONTENT_REDACTION env var — safe to deploy before agents
 * are migrated to /api/data/query. Activate in Phase 3.
 */
function redactResults(rows: Record<string, unknown>[], env: Env): Record<string, unknown>[] {
  const enabled = (env as unknown as Record<string, unknown>).ENABLE_CONTENT_REDACTION;
  if (!enabled) return rows; // Pass-through until Phase 3
  return rows.map((row) => {
    const clean = { ...row };
    for (const col of REDACTED_COLUMNS) {
      if (col in clean) clean[col] = "[ENCRYPTED]";
    }
    return clean;
  });
}

/**
 * Timing-safe comparison of two strings.
 * Prevents timing attacks on token validation.
 */
async function timingSafeCompare(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) {
    // Compare against self to burn constant time, then return false
    await crypto.subtle.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.subtle.timingSafeEqual(aBuf, bBuf);
}

/**
 * Verify the request is authenticated with the worker secret.
 */
async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (!token) return false;
  const matchesWorker = env.MYA_WORKER_SECRET
    ? await timingSafeCompare(token, env.MYA_WORKER_SECRET)
    : false;
  const matchesAdmin = env.ADMIN_SECRET
    ? await timingSafeCompare(token, env.ADMIN_SECRET)
    : false;
  return matchesWorker || matchesAdmin;
}

/**
 * Handle CORS preflight for all /api/db/* and /api/vectors/* and /api/search/* routes.
 */
export function handleProxyCORS(request: Request): Response {
  return corsPreflight(request);
}

/**
 * Route a proxy request to the appropriate handler.
 * Returns null if the path doesn't match a proxy endpoint.
 */
export async function handleProxyRequest(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response | null> {
  // CORS preflight
  if (request.method === "OPTIONS") {
    if (
      pathname.startsWith("/api/db/") ||
      pathname.startsWith("/api/vectors/") ||
      pathname.startsWith("/api/search/")
    ) {
      return handleProxyCORS(request);
    }
    return null;
  }

  if (request.method !== "POST") return null;

  // Auth check for all proxy endpoints — supports agent tokens, session tokens, and legacy secrets
  if (
    pathname.startsWith("/api/db/") ||
    pathname.startsWith("/api/vectors/") ||
    pathname.startsWith("/api/search/")
  ) {
    const identity = await authenticateRequest(request, env);
    if (!identity) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: JSON_HEADERS,
      });
    }

    switch (pathname) {
      case "/api/db/query":
        return handleD1Query(request, env, identity);
      case "/api/db/batch":
        return handleD1Batch(request, env, identity);
      case "/api/vectors/upsert":
        return handleVectorUpsert(request, env);
      case "/api/vectors/query":
        return handleVectorQuery(request, env);
      case "/api/vectors/get":
        return handleVectorGetByIds(request, env);
      case "/api/search/hybrid":
        return handleHybridSearch(request, env, identity.scopes);
      default:
        return null;
    }
  }

  return null;
}

// ── D1 Proxy Endpoints ──────────────────────────────────────────────────────

/**
 * POST /api/db/query
 * Body: { sql: string, params?: any[] }
 * Returns: { results: any[], meta: { changes, duration, ... } }
 */
async function handleD1Query(request: Request, env: Env, identity: AgentIdentity): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: "D1 not configured" }), {
      status: 503,
      headers: JSON_HEADERS,
    });
  }

  try {
    let { sql, params = [] } = (await request.json()) as {
      sql: string;
      params?: unknown[];
    };

    if (!sql || typeof sql !== "string") {
      return new Response(JSON.stringify({ error: "Missing sql" }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    if (sql.length > MAX_SQL_LENGTH) {
      return new Response(JSON.stringify({ error: "SQL too long" }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    if (params.length > MAX_PARAMS) {
      return new Response(JSON.stringify({ error: "Too many params" }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    if (DDL_PATTERN.test(sql)) {
      return new Response(JSON.stringify({ error: "DDL not allowed via proxy" }), {
        status: 403,
        headers: JSON_HEADERS,
      });
    }

    // Block unrestricted DELETE (require WHERE clause)
    const trimmed = sql.trimStart().toUpperCase();
    if (trimmed.startsWith("DELETE") && !trimmed.includes("WHERE")) {
      return new Response(JSON.stringify({ error: "Unrestricted DELETE not allowed — add a WHERE clause" }), {
        status: 403,
        headers: JSON_HEADERS,
      });
    }

    // Auto-encrypt sensitive fields in INSERT/UPDATE statements
    const isWrite = trimmed.startsWith("INSERT") || trimmed.startsWith("UPDATE") || trimmed.startsWith("REPLACE");
    if (isWrite) {
      sql = await autoEncryptParams(sql, params, identity, env);
    }

    const stmt = env.DB.prepare(sql).bind(...params);

    // Use .all() for SELECT, .run() for write operations
    const isRead = trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA") || trimmed.startsWith("EXPLAIN") || trimmed.startsWith("WITH");
    const result = isRead ? await stmt.all() : await stmt.run();

    const rawResults = ((result as any).results ?? []) as Record<string, unknown>[];
    const decrypted = await autoDecryptResults(rawResults, identity.scopes, env);

    return new Response(
      JSON.stringify({
        results: redactResults(decrypted, env),
        meta: result.meta,
      }),
      { headers: JSON_HEADERS },
    );
  } catch (e: any) {
    console.error("[D1 Query]", e);
    return new Response(
      JSON.stringify({ error: "D1 query failed" }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
}

/**
 * POST /api/db/batch
 * Body: { statements: Array<{ sql: string, params?: any[] }> }
 * Returns: Array<{ results: any[], meta: object }>
 */
async function handleD1Batch(request: Request, env: Env, identity: AgentIdentity): Promise<Response> {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: "D1 not configured" }), {
      status: 503,
      headers: JSON_HEADERS,
    });
  }

  try {
    const { statements } = (await request.json()) as {
      statements: Array<{ sql: string; params?: unknown[] }>;
    };

    if (!statements?.length) {
      return new Response(JSON.stringify({ error: "Missing statements" }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    if (statements.length > MAX_BATCH_STATEMENTS) {
      return new Response(
        JSON.stringify({ error: `Batch too large (max ${MAX_BATCH_STATEMENTS})` }),
        { status: 400, headers: JSON_HEADERS },
      );
    }
    // Validate each statement
    for (const s of statements) {
      if (!s.sql || typeof s.sql !== "string") {
        return new Response(JSON.stringify({ error: "Invalid statement: missing sql" }), {
          status: 400, headers: JSON_HEADERS,
        });
      }
      if (s.sql.length > MAX_SQL_LENGTH) {
        return new Response(JSON.stringify({ error: "Statement SQL too long" }), {
          status: 400, headers: JSON_HEADERS,
        });
      }
      if ((s.params?.length || 0) > MAX_PARAMS) {
        return new Response(JSON.stringify({ error: "Statement has too many params" }), {
          status: 400, headers: JSON_HEADERS,
        });
      }
      if (DDL_PATTERN.test(s.sql)) {
        return new Response(JSON.stringify({ error: "DDL not allowed via proxy" }), {
          status: 403, headers: JSON_HEADERS,
        });
      }
    }

    // Validate and encrypt each statement
    for (const s of statements) {
      const t = s.sql.trimStart().toUpperCase();
      if (t.startsWith("DELETE") && !t.includes("WHERE")) {
        return new Response(JSON.stringify({ error: "Unrestricted DELETE not allowed" }), {
          status: 403, headers: JSON_HEADERS,
        });
      }
      if (t.startsWith("INSERT") || t.startsWith("UPDATE") || t.startsWith("REPLACE")) {
        const p = s.params || [];
        s.sql = await autoEncryptParams(s.sql, p, identity, env);
        s.params = p;
      }
    }

    const stmts = statements.map((s) =>
      env.DB!.prepare(s.sql).bind(...(s.params || [])),
    );

    const results = await env.DB.batch(stmts);

    const decryptedBatch = await Promise.all(
      results.map(async (r) => ({
        results: redactResults(
          await autoDecryptResults((r.results || []) as Record<string, unknown>[], identity.scopes, env),
          env,
        ),
        meta: r.meta,
      })),
    );

    return new Response(JSON.stringify(decryptedBatch), { headers: JSON_HEADERS });
  } catch (e: any) {
    console.error("[D1 Batch]", e);
    return new Response(
      JSON.stringify({ error: "D1 batch failed" }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
}

// ── Vectorize Proxy Endpoints ───────────────────────────────────────────────

/**
 * Resolve index binding name to the actual Vectorize binding.
 */
function getVectorIndex(
  env: Env,
  indexName: string,
): VectorizeIndex | null {
  if (indexName === "search" || indexName === "1024") return env.VECTORS_1024 || null;
  if (indexName === "cluster" || indexName === "256") return env.VECTORS_256 || null;
  return null;
}

/**
 * POST /api/vectors/upsert
 * Body: { index: 'search'|'cluster', vectors: Array<{ id, values, metadata? }> }
 */
async function handleVectorUpsert(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const { index: indexName, vectors } = (await request.json()) as {
      index: string;
      vectors: Array<{ id: string; values: number[]; metadata?: Record<string, string> }>;
    };

    const idx = getVectorIndex(env, indexName);
    if (!idx) {
      return new Response(
        JSON.stringify({ error: `Unknown index: ${indexName}` }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    if (!vectors?.length) {
      return new Response(JSON.stringify({ error: "Missing vectors" }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    if (vectors.length > MAX_VECTOR_BATCH) {
      return new Response(
        JSON.stringify({ error: `Too many vectors (max ${MAX_VECTOR_BATCH})` }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    // Vectorize accepts up to 1000 vectors per upsert
    const BATCH_SIZE = 1000;
    let upsertedCount = 0;

    for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
      const batch = vectors.slice(i, i + BATCH_SIZE);
      await idx.upsert(batch);
      upsertedCount += batch.length;
    }

    return new Response(
      JSON.stringify({ upserted: upsertedCount }),
      { headers: JSON_HEADERS },
    );
  } catch (e: any) {
    console.error("[Vectorize Upsert]", e);
    return new Response(
      JSON.stringify({ error: "Vectorize upsert failed" }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
}

/**
 * POST /api/vectors/query
 * Body: { index: 'search'|'cluster', vector: number[], topK?: number, filter?: object }
 * Returns: { matches: Array<{ id, score, metadata }> }
 */
async function handleVectorQuery(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const { index: indexName, vector, topK = 5, filter } = (await request.json()) as {
      index: string;
      vector: number[];
      topK?: number;
      filter?: VectorizeVectorMetadataFilter;
    };

    const idx = getVectorIndex(env, indexName);
    if (!idx) {
      return new Response(
        JSON.stringify({ error: `Unknown index: ${indexName}` }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    if (!vector?.length) {
      return new Response(JSON.stringify({ error: "Missing vector" }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }

    const clampedTopK = Math.min(Math.max(1, topK), MAX_TOPK);

    const queryOpts: VectorizeQueryOptions = {
      topK: clampedTopK,
      returnMetadata: "all",
    };
    if (filter) {
      queryOpts.filter = filter;
    }

    const result = await idx.query(vector, queryOpts);

    return new Response(
      JSON.stringify({
        matches: result.matches.map((m) => ({
          id: m.id,
          score: m.score,
          metadata: m.metadata,
        })),
      }),
      { headers: JSON_HEADERS },
    );
  } catch (e: any) {
    console.error("[Vectorize Query]", e);
    return new Response(
      JSON.stringify({ error: "Vectorize query failed" }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
}

/**
 * POST /api/vectors/get
 * Body: { index: 'search'|'cluster', ids: string[] }
 * Returns: { vectors: Array<{ id, values, metadata }> }
 * Max 100 IDs per request.
 */
async function handleVectorGetByIds(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const { index: indexName, ids } = (await request.json()) as {
      index: string;
      ids: string[];
    };

    const idx = getVectorIndex(env, indexName);
    if (!idx) {
      return new Response(
        JSON.stringify({ error: `Unknown index: ${indexName}` }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    if (!ids?.length) {
      return new Response(JSON.stringify({ error: "Missing ids" }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }

    if (ids.length > 200) {
      return new Response(
        JSON.stringify({ error: "Too many ids (max 200)" }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    // Vectorize getByIds has a limit of ~20 IDs per call, so we chunk
    const CHUNK = 20;
    const allResults: Array<{ id: string; values?: number[] | Float32Array | Float64Array; metadata?: Record<string, string> }> = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const chunkResult = await idx.getByIds(chunk);
      allResults.push(...chunkResult);
    }
    const result = allResults;

    return new Response(
      JSON.stringify({
        vectors: result.map((v) => ({
          id: v.id,
          values: v.values,
          metadata: v.metadata,
        })),
      }),
      { headers: JSON_HEADERS },
    );
  } catch (e: any) {
    console.error("[Vectorize GetByIds]", e);
    return new Response(
      JSON.stringify({ error: "Vectorize getByIds failed" }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
}

// ── Hybrid Search ───────────────────────────────────────────────────────────

/**
 * POST /api/search/hybrid
 * Body: { agentId, query, embedding, after?, before?, limit? }
 *
 * Combines D1 FTS5 keyword search with Vectorize semantic search.
 * Merges results using Reciprocal Rank Fusion (RRF).
 */
async function handleHybridSearch(
  request: Request,
  env: Env,
  scopes: Scope[],
): Promise<Response> {
  if (!env.DB || !env.VECTORS_1024) {
    return new Response(
      JSON.stringify({ error: "D1 or Vectorize not configured" }),
      { status: 503, headers: JSON_HEADERS },
    );
  }

  try {
    const {
      agentId,
      query,
      embedding,
      after,
      before,
      limit = 10,
    } = (await request.json()) as {
      agentId?: string;
      query: string;
      embedding: number[];
      after?: string;
      before?: string;
      limit?: number;
    };

    const clampedLimit = Math.min(Math.max(1, limit), MAX_LIMIT);

    // Generate embedding if not provided (caller sent query text only)
    let searchEmbedding = embedding;
    if (!searchEmbedding?.length && query) {
      const model = "@cf/baai/bge-m3";
      const aiResult = await (env as any).AI.run(model, { text: [query] });
      searchEmbedding = aiResult?.data?.[0];
    }

    if (!searchEmbedding?.length) {
      return new Response(
        JSON.stringify({ error: "No embedding or query provided" }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    // 1. FTS5 keyword search
    const ftsParams: unknown[] = [query];
    let ftsSql = `
      SELECT m.id, m.content, m.role, m.source, m.agent_id, m.created_at, m.entity_summary,
             rank as fts_rank
      FROM messages_fts fts
      JOIN messages m ON m.rowid = fts.rowid
      WHERE messages_fts MATCH ?`;

    if (agentId) {
      ftsSql += ` AND m.agent_id = ?`;
      ftsParams.push(agentId);
    }
    if (after) {
      ftsSql += ` AND m.created_at >= ?`;
      ftsParams.push(after);
    }
    if (before) {
      ftsSql += ` AND m.created_at <= ?`;
      ftsParams.push(before);
    }
    ftsSql += ` ORDER BY rank LIMIT ?`;
    ftsParams.push(clampedLimit * 2); // Fetch more for merging

    // FTS may fail on encrypted content — treat as non-fatal
    let ftsRows: any[] = [];
    try {
      const ftsResult = await env.DB.prepare(ftsSql).bind(...ftsParams).all();
      ftsRows = ftsResult.results || [];
    } catch (ftsErr) {
      console.warn("[Hybrid Search] FTS failed (encrypted content?), continuing with vector-only:", ftsErr);
    }

    // 2. Vectorize semantic search
    // Note: metadata filtering on Vectorize requires create-metadata-index
    // which was just set up — skip filtering until indexes propagate.
    // The D1 row-fetch step handles agentId filtering via SQL WHERE.
    const vectorResult = await env.VECTORS_1024.query(searchEmbedding, {
      topK: clampedLimit * 2,
      returnMetadata: "all",
    });
    const vectorMatches = vectorResult.matches || [];

    // Fetch full rows for vector matches
    let vectorRows: any[] = [];
    if (vectorMatches.length > 0) {
      // Validate IDs are safe strings (hex UUIDs) before using in query
      const idPattern = /^[a-f0-9-]{1,64}$/i;
      const ids = vectorMatches.map((m) => m.id).filter((id) => typeof id === "string" && idPattern.test(id));
      if (ids.length === 0) {
        // No valid IDs from Vectorize, skip row fetch
      } else {
      const placeholders = ids.map(() => "?").join(", ");
      let sql = `SELECT id, content, role, source, agent_id, created_at, entity_summary FROM messages WHERE id IN (${placeholders})`;
      const params: unknown[] = [...ids];

      if (after) {
        sql += ` AND created_at >= ?`;
        params.push(after);
      }
      if (before) {
        sql += ` AND created_at <= ?`;
        params.push(before);
      }

      const rowResult = await env.DB.prepare(sql).bind(...params).all();
      vectorRows = rowResult.results || [];
      } // end ids.length > 0
    }

    // 3. Reciprocal Rank Fusion (k=60)
    const k = 60;
    const scoreMap = new Map<string, { score: number; row: any }>();

    // FTS scores
    ftsRows.forEach((row: any, i: number) => {
      const rrf = 1 / (k + i + 1);
      const existing = scoreMap.get(row.id);
      if (existing) {
        existing.score += rrf;
      } else {
        scoreMap.set(row.id, { score: rrf, row });
      }
    });

    // Vector scores
    const vectorScoreMap = new Map(vectorMatches.map((m) => [m.id, m.score]));
    // Sort vector rows by their vector score to get proper rank
    vectorRows.sort((a: any, b: any) => {
      return (vectorScoreMap.get(b.id) || 0) - (vectorScoreMap.get(a.id) || 0);
    });

    vectorRows.forEach((row: any, i: number) => {
      const rrf = 1 / (k + i + 1);
      const existing = scoreMap.get(row.id);
      if (existing) {
        existing.score += rrf;
      } else {
        scoreMap.set(row.id, { score: rrf, row });
      }
    });

    // Sort by combined RRF score and take top N
    const results = Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, clampedLimit)
      .map((entry) => ({
        ...entry.row,
        hybrid_score: entry.score,
        similarity: vectorScoreMap.get(entry.row.id) || null,
      }));

    const decryptedResults = await autoDecryptResults(results, scopes, env);

    return new Response(
      JSON.stringify({ results: decryptedResults }),
      { headers: JSON_HEADERS },
    );
  } catch (e: any) {
    console.error("[Hybrid Search]", e?.message || e);
    return new Response(
      JSON.stringify({ error: "Hybrid search failed", detail: e?.message }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
}
