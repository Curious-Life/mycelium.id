/**
 * D1 Proxy Endpoints
 *
 * Allows the VPS (mycelium agents) to access D1 + small remnants of
 * Vectorize over HTTP. Authenticated via MYA_WORKER_SECRET or ADMIN_SECRET.
 *
 * Endpoints:
 *   POST /api/db/query       — execute a single SQL statement on D1
 *   POST /api/db/batch       — execute multiple SQL statements on D1
 *   POST /api/vectors/delete — delete vectors by id (tenant-scoped,
 *                              used by account-deletion). The only
 *                              Vectorize touchpoint left after Wave 4b.
 *   POST /api/search/hybrid  — keyword (FTS5) search; semantic side
 *                              now served by mind-search in-process
 *
 * Removed Wave 4b 2026-05-04: /api/vectors/upsert, /api/vectors/query,
 * /api/vectors/get — replaced by D1 embedding_768 + scan-matchers.
 */

import type { Env } from "../types/env";
import { getWorkerSecret } from "../middleware/agent-auth";
import { authenticateRequest } from "../middleware/agent-auth";
import { corsPreflight } from "../utils/cors";
import type { AgentIdentity } from "../middleware/agent-auth";
import { getD1ForTenant, extractTenantId, validateAndResolveTenantId, resolveTenantDb } from "../services/tenant-d1";
import {
  validateAndResolveNamespace,
  vectorBelongsToNamespace,
  TenantValidationError,
} from "../services/tenant-vectorize";
import { enforceSqlSafety } from "../services/sql-safety";

const JSON_HEADERS = { "Content-Type": "application/json" };

// SWISS VAULT: All encryption/decryption happens on VPS (crypto-local.js).
// Worker is a pure passthrough — stores and returns ciphertext as-is.
// No master key, no crypto operations in this file.

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
  const ws = getWorkerSecret(env);
  const matchesWorker = ws ? await timingSafeCompare(token, ws) : false;
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

    let response: Response | null = null;
    switch (pathname) {
      case "/api/db/query":
        response = await handleD1Query(request, env, identity);
        break;
      case "/api/db/batch":
        response = await handleD1Batch(request, env, identity);
        break;
      // All /api/vectors/* + /api/search/hybrid routes removed
      // Wave 4b 2026-05-04. Mind-search + scan-matchers serve
      // semantic recall over D1 embedding_768 columns in-process;
      // account deletion drops D1 rows directly. No Worker round-
      // trip for search.
      default:
        return null;
    }

    // Audit log — fire-and-forget, never blocks response.
    // Logs WHO accessed WHAT endpoint, never logs request/response bodies or PII.
    try {
      const db = env.DB as D1Database;
      if (db) {
        const ip = request.headers.get("CF-Connecting-IP") || "";
        db.prepare(
          `INSERT INTO audit_log (id, event_type, agent_id, user_id, ip_address, endpoint, method, scope, success, details, created_at)
           VALUES (?, 'api_access', ?, ?, ?, ?, 'POST', ?, ?, ?, datetime('now'))`
        ).bind(
          crypto.randomUUID(),
          identity.agent,
          identity.user_id || null,
          ip,
          pathname,
          identity.scopes?.join(",") || null,
          response.status < 400 ? 1 : 0,
          JSON.stringify({ status: response.status, auth_type: identity.auth_type }),
        ).run().catch(() => {}); // Swallow errors — audit must never break data access
      }
    } catch { /* audit failure must never block data access */ }

    return response;
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
  let tenantId: string | null;
  try {
    tenantId = validateAndResolveTenantId(request, identity, env);
  } catch (e: any) {
    if (e instanceof TenantValidationError) {
      return new Response(JSON.stringify({ error: e.message }), { status: 403, headers: JSON_HEADERS });
    }
    throw e;
  }
  const { db, ownerScope } = resolveTenantDb(env, tenantId);
  if (!db) {
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

    // SWISS VAULT: encryption/decryption happens on VPS, not here.
    // Worker is a passthrough — stores and returns ciphertext as-is.

    // Owner D1 safety: REJECT operations on user-data tables that lack
    // user_id/agent_id filter. Tenant D1s are fully isolated (separate
    // databases), so this only matters for owner D1. The `ownerScope` flag
    // covers two routing paths:
    //   1. No tenantId — owner agent talking to owner DB (historical path)
    //   2. tenantId set but no DB_TENANT_* binding — fallback onto owner DB
    //
    // Guardian now covers SELECT/INSERT/UPDATE/DELETE. Writes were a
    // historical blind spot — this is what allowed undetected INSERTs to land
    // in admin's D1 undetected. Guardian emits critical on any violation.
    const safetyBlock = await enforceSqlSafety({ sql, identity, ownerScope, request });
    if (safetyBlock) return safetyBlock;

    const stmt = db.prepare(sql).bind(...params);

    // Use .all() for SELECT, .run() for write operations
    const isRead = trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA") || trimmed.startsWith("EXPLAIN") || trimmed.startsWith("WITH");
    const result = isRead ? await stmt.all() : await stmt.run();

    const rawResults = ((result as any).results ?? []) as Record<string, unknown>[];

    return new Response(
      JSON.stringify({
        results: rawResults,
        meta: result.meta,
      }),
      { headers: JSON_HEADERS },
    );
  } catch (e: any) {
    console.error("[D1 Query]", e?.message || e, "| tenant:", tenantId || "owner");
    return new Response(
      JSON.stringify({ error: "D1 query failed", detail: e?.message?.slice(0, 200) }),
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
  let tenantId: string | null;
  try {
    tenantId = validateAndResolveTenantId(request, identity, env);
  } catch (e: any) {
    if (e instanceof TenantValidationError) {
      return new Response(JSON.stringify({ error: e.message }), { status: 403, headers: JSON_HEADERS });
    }
    throw e;
  }
  const { db, ownerScope } = resolveTenantDb(env, tenantId);
  if (!db) {
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

    // SWISS VAULT: no encryption/decryption in Worker — passthrough only
    for (const s of statements) {
      const t = s.sql.trimStart().toUpperCase();
      if (t.startsWith("DELETE") && !t.includes("WHERE")) {
        return new Response(JSON.stringify({ error: "Unrestricted DELETE not allowed" }), {
          status: 403, headers: JSON_HEADERS,
        });
      }
    }

    // Owner-scope safety on batch: mirror handleD1Query. Any statement
    // (SELECT, INSERT, UPDATE, DELETE) on a user-data table that would
    // run on owner D1 must carry a user_id/agent_id filter. Writes were
    // previously unchecked — this is how bulk INSERTs silently
    // landed on admin's D1 through the binding-fallback path.
    for (const s of statements) {
      const safetyBlock = await enforceSqlSafety({ sql: s.sql, identity, ownerScope, request });
      if (safetyBlock) return safetyBlock;
    }

    const stmts = statements.map((s) =>
      db.prepare(s.sql).bind(...(s.params || [])),
    );

    const results = await db.batch(stmts);

    // SWISS VAULT: no crypto — return ciphertext as-is
    const batch = results.map((r) => ({
      results: (r.results || []) as Record<string, unknown>[],
      meta: r.meta,
    }));

    return new Response(JSON.stringify(batch), { headers: JSON_HEADERS });
  } catch (e: any) {
    console.error("[D1 Batch]", e);
    return new Response(
      JSON.stringify({ error: "D1 batch failed" }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
}

// ── Vectorize Proxy Endpoints ───────────────────────────────────────────────
//
// All Vectorize proxy handlers removed Wave 4b 2026-05-04.
//   - search/cluster reads + writes:        replaced by D1 embedding_768
//                                           + mind-search/scan-matchers
//   - account-deletion vector cleanup:      no longer needed since data
//                                           lives in D1 user-tables which
//                                           are wiped in Step 4 of
//                                           portal-export-import deletion
//
// Legacy Vectorize indexes (mycelium-search, mycelium-cluster) on the
// operator's Cloudflare account can be purged via:
//   wrangler vectorize delete mycelium-search
//   wrangler vectorize delete mycelium-cluster

// ── Hybrid Search ───────────────────────────────────────────────────────────
//
// handleHybridSearch removed Wave 4b 2026-05-04. The legacy FTS5 +
// Vectorize fusion was broken on encrypted rows (FTS5 indexed
// ciphertext), Vectorize is gone, and Workers AI BGE-M3 is no longer
// used for embedding. Recall now lives entirely on each VPS via
// mind-search + scan-matchers over D1 embedding_768 columns.
