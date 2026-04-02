/**
 * Centralized Secrets API
 *
 * Agents call GET /api/secrets at startup with their AGENT_TOKEN
 * to fetch configuration. Secrets are stored encrypted in D1.
 *
 * - GET  /api/secrets        → agent reads its secrets (any auth)
 * - PUT  /api/secrets        → admin writes a secret (admin only)
 * - DELETE /api/secrets/:key → admin deletes a secret (admin only)
 */

import { requireAuth, type AgentIdentity } from "../middleware/agent-auth";
import { encrypt, decrypt, isEncrypted, type Scope } from "../services/crypto";
import { importMasterKey } from "../services/crypto";
import { corsHeaders } from "../utils/cors";
import type { Env } from "../types/env";

export async function handleGetSecrets(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const identity = auth as AgentIdentity;

  if (!env.DB) {
    return new Response(JSON.stringify({ error: "Database not available" }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  const masterKeyHex = (env as unknown as Record<string, string>).ENCRYPTION_MASTER_KEY;
  if (!masterKeyHex) {
    return new Response(JSON.stringify({ error: "Encryption not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  const masterKey = await importMasterKey(masterKeyHex);

  // Build scope placeholders
  const scopePlaceholders = identity.scopes.map(() => "?").join(",");
  // Match secrets for this user's scopes. For multi-tenant (moms-agent has a
  // different user_id), also include secrets owned by ANY user_id — the scope
  // filter is the real access control, not user_id.
  const query = `
    SELECT key, value, scope FROM secrets
    WHERE scope IN (${scopePlaceholders})
      AND (agent IS NULL OR agent = ?)
    ORDER BY key
  `;

  const params = [...identity.scopes, identity.agent];
  const { results } = await env.DB.prepare(query).bind(...params).all();

  // Decrypt all values
  const secrets: Record<string, string> = {};
  for (const row of results || []) {
    const val = row.value as string;
    try {
      secrets[row.key as string] = isEncrypted(val)
        ? await decrypt(val, identity.scopes, masterKey)
        : val;
    } catch {
      // Skip secrets we can't decrypt (scope mismatch shouldn't happen
      // given the WHERE clause, but defensive)
    }
  }

  return new Response(JSON.stringify({
    secrets,
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

  if (!env.DB) {
    return new Response(JSON.stringify({ error: "Database not available" }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  const masterKeyHex = (env as unknown as Record<string, string>).ENCRYPTION_MASTER_KEY;
  if (!masterKeyHex) {
    return new Response(JSON.stringify({ error: "Encryption not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  const body = await request.json() as {
    key: string;
    value: string;
    scope?: Scope;
    agent?: string | null;
    user_id?: string;
    description?: string;
  };

  if (!body.key || !body.value) {
    return new Response(JSON.stringify({ error: "key and value required" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  const scope = body.scope || "org";
  const userId = body.user_id || identity.user_id;
  const masterKey = await importMasterKey(masterKeyHex);
  const encryptedValue = await encrypt(body.value, scope, masterKey);

  await env.DB.prepare(`
    INSERT INTO secrets (key, value, scope, user_id, agent, version, description, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'))
    ON CONFLICT(key, user_id, agent) DO UPDATE SET
      value = excluded.value,
      scope = excluded.scope,
      version = secrets.version + 1,
      description = excluded.description,
      updated_at = datetime('now')
  `).bind(
    body.key,
    encryptedValue,
    scope,
    userId,
    body.agent ?? null,
    body.description ?? null,
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
  // Admin-only — compromised agents must not delete their own config
  if (identity.agent !== "admin") {
    return new Response(JSON.stringify({ error: "Admin access required" }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  if (!env.DB) {
    return new Response(JSON.stringify({ error: "Database not available" }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  const url = new URL(request.url);
  const agent = url.searchParams.get("agent") || null;
  const userId = url.searchParams.get("user_id") || "system";

  const result = await env.DB.prepare(
    "DELETE FROM secrets WHERE key = ? AND user_id = ? AND (agent IS ? OR agent = ?)"
  ).bind(key, userId, agent, agent).run();

  return new Response(JSON.stringify({ ok: true, deleted: key, changes: result.meta.changes }), {
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}
