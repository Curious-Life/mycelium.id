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

  // Build scope placeholders
  const scopePlaceholders = identity.scopes.map(() => "?").join(",");
  const query = `
    SELECT key, value, scope FROM secrets
    WHERE scope IN (${scopePlaceholders})
      AND (agent IS NULL OR agent = ?)
    ORDER BY key
  `;

  const params = [...identity.scopes, identity.agent];
  const { results } = await env.DB.prepare(query).bind(...params).all();

  // SWISS VAULT: return raw values — VPS decrypts locally with crypto-local.js
  const secrets: Record<string, string> = {};
  for (const row of results || []) {
    secrets[row.key as string] = row.value as string;
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

  const body = await request.json() as {
    key: string;
    value: string;
    scope?: string;
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

  // SWISS VAULT: value is pre-encrypted by VPS — store as-is
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
    body.value,
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
