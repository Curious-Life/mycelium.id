/**
 * Centralized Secrets API
 *
 * Agents call GET /api/secrets at startup with their AGENT_TOKEN
 * to fetch configuration. Secrets are stored encrypted in D1.
 *
 * SWISS VAULT: Worker is a ciphertext relay — no master key, no crypto.
 * VPS encrypts values before PUT, decrypts values after GET using crypto-local.js.
 *
 * - GET  /api/secrets        → agent reads its secrets (returns ciphertext)
 * - PUT  /api/secrets        → admin writes a secret (accepts pre-encrypted value)
 * - DELETE /api/secrets/:key → admin deletes a secret (admin only)
 */

import { requireAuth, type AgentIdentity } from "../middleware/agent-auth";
import { corsHeaders } from "../utils/cors";
import type { Env } from "../types/env";
import { getD1ForTenant, validateAndResolveTenantId } from "../services/tenant-d1";
import { TenantValidationError } from "../services/tenant-vectorize";

function tenantMismatchResponse(request: Request, err: unknown): Response {
  const msg = err instanceof TenantValidationError ? err.message : "tenant validation failed";
  return new Response(JSON.stringify({ error: msg }), {
    status: 403,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

export async function handleGetSecrets(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const identity = auth as AgentIdentity;

  // TENANT ROUTING: Each customer VPS has its own secrets in its own D1.
  // Operator-infra secrets are seeded per-tenant, encrypted with that
  // tenant's tmpfs-resident key (never visible to the Worker).
  //
  // Without this routing, customer agents would pull operator secrets from
  // the owner's DB encrypted with the owner's key — which they cannot decrypt.
  //
  // Use validateAndResolveTenantId so owner agents (AGENT_REGISTRY auth, no
  // token.tenant_id) get routed to env.DB even when they send
  // X-Tenant-ID=<OWNER_USER_ID> (legacy MYA_USER_ID). The raw extractTenantId
  // path would look for DB_TENANT_<OWNER_USER_ID>, find nothing, and 503.
  let tenantId: string | null;
  try {
    tenantId = validateAndResolveTenantId(request, identity, env);
  } catch (err) {
    return tenantMismatchResponse(request, err);
  }
  const db = getD1ForTenant(env, tenantId);
  if (!db) {
    return new Response(JSON.stringify({ error: "Database not available" }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  // Build scope placeholders
  const scopePlaceholders = identity.scopes.map(() => "?").join(",");
  const query = `
    SELECT key, value, scope, key_family FROM secrets
    WHERE scope IN (${scopePlaceholders})
      AND (agent IS NULL OR agent = ?)
    ORDER BY key
  `;

  const params = [...identity.scopes, identity.agent];
  const { results } = await db.prepare(query).bind(...params).all();

  // SWISS VAULT: return raw values — VPS decrypts locally with crypto-local.js.
  //
  // Backward-compatible response shape:
  //   - `secrets`: { KEY: "ciphertext" }   (old clients read this directly)
  //   - `key_families`: { KEY: "system"|"user" } (new clients use this hint)
  //
  // New VPS bootstrap-secrets.js can infer the key family from the envelope
  // version tag anyway (v3 carries `kf` internally), so key_families is purely
  // advisory. This keeps the migration rollout order-insensitive.
  const secrets: Record<string, string> = {};
  const keyFamilies: Record<string, string> = {};
  for (const row of results || []) {
    const k = row.key as string;
    secrets[k] = row.value as string;
    keyFamilies[k] = (row.key_family as string) || "system";
  }

  return new Response(JSON.stringify({
    secrets,
    key_families: keyFamilies,
    count: Object.keys(secrets).length,
    agent: identity.agent,
    scopes: identity.scopes,
  }), {
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

export async function handlePutSecret(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const identity = auth as AgentIdentity;
  if (identity.agent !== "admin" && identity.agent !== "portal") {
    return new Response(JSON.stringify({ error: "Admin access required" }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  // TENANT ROUTING: write to the caller's tenant D1. Operator seeding
  // scripts must send X-Tenant-ID to target a specific customer's D1.
  // validateAndResolveTenantId handles the owner-self-reference case.
  let tenantId: string | null;
  try {
    tenantId = validateAndResolveTenantId(request, identity, env);
  } catch (err) {
    return tenantMismatchResponse(request, err);
  }
  const db = getD1ForTenant(env, tenantId);
  if (!db) {
    return new Response(JSON.stringify({ error: "Database not available" }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  const body = await request.json() as {
    key: string;
    value: string;
    scope?: string;
    agent?: string | null;
    user_id?: string;
    description?: string;
    key_family?: "system" | "user";
  };

  if (!body.key || !body.value) {
    return new Response(JSON.stringify({ error: "key and value required" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  const scope = body.scope || "org";
  const userId = body.user_id || identity.user_id;
  const keyFamily = body.key_family === "user" ? "user" : "system";

  // SWISS VAULT: value is pre-encrypted by VPS — store as-is.
  // key_family tells the VPS which key decrypts it on GET.
  await db.prepare(`
    INSERT INTO secrets (key, value, scope, user_id, agent, version, description, key_family, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, datetime('now'))
    ON CONFLICT(key, user_id, agent) DO UPDATE SET
      value = excluded.value,
      scope = excluded.scope,
      version = secrets.version + 1,
      description = excluded.description,
      key_family = excluded.key_family,
      updated_at = datetime('now')
  `).bind(
    body.key,
    body.value,
    scope,
    userId,
    body.agent ?? null,
    body.description ?? null,
    keyFamily,
  ).run();

  return new Response(JSON.stringify({ ok: true, key: body.key }), {
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

export async function handleDeleteSecret(
  request: Request,
  env: Env,
  key: string,
): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const identity = auth as AgentIdentity;
  if (identity.agent !== "admin") {
    return new Response(JSON.stringify({ error: "Admin access required" }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  // TENANT ROUTING: delete from caller's tenant D1.
  // validateAndResolveTenantId handles the owner-self-reference case.
  let tenantId: string | null;
  try {
    tenantId = validateAndResolveTenantId(request, identity, env);
  } catch (err) {
    return tenantMismatchResponse(request, err);
  }
  const db = getD1ForTenant(env, tenantId);
  if (!db) {
    return new Response(JSON.stringify({ error: "Database not available" }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  const url = new URL(request.url);
  const agent = url.searchParams.get("agent") || null;
  const userId = url.searchParams.get("user_id") || "system";

  const result = await db.prepare(
    "DELETE FROM secrets WHERE key = ? AND user_id = ? AND (agent IS ? OR agent = ?)"
  ).bind(key, userId, agent, agent).run();

  return new Response(JSON.stringify({ ok: true, deleted: key, changes: result.meta.changes }), {
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}
