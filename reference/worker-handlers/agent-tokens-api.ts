/**
 * Agent Tokens Admin API
 *
 * Manages the D1 `agent_tokens` table — token-keyed registry of every
 * agent identity the Worker authenticates. Replaces direct
 * `wrangler secret put AGENT_REGISTRY` workflow with auditable per-entry
 * CRUD operations.
 *
 * Endpoints (all admin-auth gated; admin = ADMIN_SECRET-authenticated session):
 *   GET    /api/agent-tokens                   → list every entry (token_hash + metadata)
 *   POST   /api/agent-tokens                   → upsert an entry (raw token in body, hashed server-side)
 *   PATCH  /api/agent-tokens/:token_hash       → update agent/scopes/disabled by hash
 *   DELETE /api/agent-tokens/:token_hash       → delete by hash
 *   GET    /api/agent-tokens/registry-export   → TEMPORARY: dump raw env.AGENT_REGISTRY for migration. REMOVED IN COMMIT 4.
 *
 * Auth: identity.agent === "admin" (legacy ADMIN_SECRET path) OR identity.agent === "portal".
 * No customer agent should be able to manage owner tokens — that's the security boundary.
 *
 * Cache invalidation: every write busts the in-memory d1TokenCache via
 * invalidateD1TokenCache() so the change takes effect on the next request,
 * not after the 5-min TTL.
 */

import { requireAuth, type AgentIdentity, hashToken, invalidateD1TokenCache } from "../middleware/agent-auth";
import { corsHeaders } from "../utils/cors";
import type { Env } from "../types/env";

// ── Auth helper ───────────────────────────────────────────────────────────

async function requireAdmin(request: Request, env: Env): Promise<AgentIdentity | Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  const identity = auth as AgentIdentity;
  if (identity.agent !== "admin" && identity.agent !== "portal") {
    return new Response(JSON.stringify({ error: "Admin access required" }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }
  return identity;
}

// ── Validation helpers ────────────────────────────────────────────────────

const KNOWN_SCOPES = new Set(["personal", "org", "wealth", "moms", "ops"]);

function validateScopes(scopes: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (!Array.isArray(scopes)) return { ok: false, error: "scopes must be an array" };
  if (scopes.length === 0) return { ok: false, error: "scopes cannot be empty" };
  const cleaned: string[] = [];
  for (const s of scopes) {
    if (typeof s !== "string") return { ok: false, error: "scopes entries must be strings" };
    if (!KNOWN_SCOPES.has(s)) return { ok: false, error: `unknown scope: ${s}` };
    cleaned.push(s);
  }
  // Stored as JSON array text — agent-auth.ts:244 parses both JSON and comma-separated.
  return { ok: true, value: JSON.stringify(cleaned) };
}

function validateAgent(agent: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof agent !== "string" || agent.length === 0 || agent.length > 100) {
    return { ok: false, error: "agent must be a non-empty string ≤100 chars" };
  }
  // Mycelium agent IDs are lowercase, hyphenated. Reject anything weird.
  if (!/^[a-z][a-z0-9-]*$/.test(agent)) {
    return { ok: false, error: `invalid agent id: ${agent}` };
  }
  return { ok: true, value: agent };
}

function validateUserId(userId: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof userId !== "string" || userId.length === 0 || userId.length > 100) {
    return { ok: false, error: "user_id must be a non-empty string ≤100 chars" };
  }
  return { ok: true, value: userId };
}

// ── Handlers ──────────────────────────────────────────────────────────────

/**
 * GET /api/agent-tokens
 * Lists every agent_tokens row (admin only). Never returns raw tokens —
 * only token_hash + metadata. Customer-tenant entries (tenant_id IS NOT NULL)
 * are included so admin can audit them too.
 */
export async function handleListAgentTokens(request: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  if (!env.DB) {
    return new Response(JSON.stringify({ error: "DB unavailable" }), { status: 503 });
  }

  try {
    const result = await env.DB.prepare(
      `SELECT token_hash, agent, name, user_id, scopes, tenant_id, disabled,
              created_at, last_used_at, parent_token_hash, extension_name
       FROM agent_tokens
       ORDER BY agent, name`
    ).all();

    return new Response(
      JSON.stringify({ rows: result.results || [], count: (result.results || []).length }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(request) } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "list failed", detail: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(request) } }
    );
  }
}

/**
 * POST /api/agent-tokens
 * Body: { token: string, agent: string, name: string, user_id: string,
 *         scopes: string[], tenant_id?: string, disabled?: boolean }
 *
 * Hashes the raw token server-side and INSERTs into agent_tokens with
 * ON CONFLICT(token_hash) DO UPDATE so the operation is idempotent.
 *
 * Hash collision check: if the new token's hash matches an EXISTING
 * customer-tenant entry (tenant_id IS NOT NULL), refuse the write. This
 * prevents an owner-token migration from accidentally clobbering a
 * customer agent (SHA-256 collision is astronomical, but belt-and-suspenders).
 */
export async function handlePutAgentToken(request: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  if (!env.DB) {
    return new Response(JSON.stringify({ error: "DB unavailable" }), { status: 503 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  if (typeof body?.token !== "string" || body.token.length < 16) {
    return new Response(JSON.stringify({ error: "token must be a string ≥16 chars" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  const agent = validateAgent(body.agent);
  if (!agent.ok) return badRequest(request, agent.error);

  const userId = validateUserId(body.user_id);
  if (!userId.ok) return badRequest(request, userId.error);

  const scopes = validateScopes(body.scopes);
  if (!scopes.ok) return badRequest(request, scopes.error);

  const name = typeof body.name === "string" && body.name.length > 0 && body.name.length <= 100
    ? body.name
    : agent.value; // default to agent id

  const tenantId = typeof body.tenant_id === "string" && body.tenant_id.length > 0 ? body.tenant_id : null;
  const disabled = body.disabled ? 1 : 0;

  try {
    const hash = await hashToken(body.token);

    // Belt-and-suspenders: if hash collides with an existing customer-tenant
    // entry, refuse. (Real SHA-256 collision is impossible; this catches
    // a misuse where someone accidentally seeds an owner token with the
    // same value as a customer's.)
    const existing = await env.DB.prepare(
      "SELECT tenant_id FROM agent_tokens WHERE token_hash = ?"
    ).bind(hash).first<{ tenant_id: string | null }>();
    const incomingIsCustomer = tenantId !== null;
    const existingIsCustomer = existing && existing.tenant_id !== null;
    if (existing && existingIsCustomer !== incomingIsCustomer) {
      return new Response(
        JSON.stringify({
          error: "token_hash collides with an entry of different tenancy class — refusing to overwrite",
        }),
        { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders(request) } }
      );
    }

    await env.DB.prepare(
      `INSERT INTO agent_tokens (token_hash, agent, name, user_id, scopes, tenant_id, disabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(token_hash) DO UPDATE SET
         agent = excluded.agent,
         name = excluded.name,
         user_id = excluded.user_id,
         scopes = excluded.scopes,
         tenant_id = excluded.tenant_id,
         disabled = excluded.disabled`
    ).bind(hash, agent.value, name, userId.value, scopes.value, tenantId, disabled).run();

    invalidateD1TokenCache();

    return new Response(
      JSON.stringify({
        ok: true,
        token_hash: hash,
        agent: agent.value,
        name,
        user_id: userId.value,
        scopes: JSON.parse(scopes.value),
        tenant_id: tenantId,
        disabled: !!disabled,
        action: existing ? "updated" : "created",
      }),
      { status: existing ? 200 : 201, headers: { "Content-Type": "application/json", ...corsHeaders(request) } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "insert failed", detail: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(request) } }
    );
  }
}

/**
 * PATCH /api/agent-tokens/:token_hash
 * Body: { agent?, name?, user_id?, scopes?, tenant_id?, disabled? }
 *
 * Updates a single entry by its existing token_hash. The token itself is
 * never sent in the body (we don't have it server-side; the hash is the
 * stable identifier).
 */
export async function handlePatchAgentToken(request: Request, env: Env, hash: string): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  if (!env.DB) {
    return new Response(JSON.stringify({ error: "DB unavailable" }), { status: 503 });
  }
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    return badRequest(request, "token_hash must be 64 hex chars");
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return badRequest(request, "invalid JSON body");
  }

  // Verify the row exists first
  const existing = await env.DB.prepare(
    "SELECT token_hash FROM agent_tokens WHERE token_hash = ?"
  ).bind(hash).first();
  if (!existing) {
    return new Response(JSON.stringify({ error: "token_hash not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  // Build dynamic UPDATE — only patch fields actually provided.
  const updates: string[] = [];
  const params: unknown[] = [];

  if (body.agent !== undefined) {
    const v = validateAgent(body.agent);
    if (!v.ok) return badRequest(request, v.error);
    updates.push("agent = ?"); params.push(v.value);
  }
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.length === 0 || body.name.length > 100) {
      return badRequest(request, "name must be a non-empty string ≤100 chars");
    }
    updates.push("name = ?"); params.push(body.name);
  }
  if (body.user_id !== undefined) {
    const v = validateUserId(body.user_id);
    if (!v.ok) return badRequest(request, v.error);
    updates.push("user_id = ?"); params.push(v.value);
  }
  if (body.scopes !== undefined) {
    const v = validateScopes(body.scopes);
    if (!v.ok) return badRequest(request, v.error);
    updates.push("scopes = ?"); params.push(v.value);
  }
  if (body.tenant_id !== undefined) {
    if (body.tenant_id !== null && (typeof body.tenant_id !== "string" || body.tenant_id.length === 0)) {
      return badRequest(request, "tenant_id must be a non-empty string or null");
    }
    updates.push("tenant_id = ?"); params.push(body.tenant_id);
  }
  if (body.disabled !== undefined) {
    updates.push("disabled = ?"); params.push(body.disabled ? 1 : 0);
  }

  if (updates.length === 0) {
    return badRequest(request, "no fields to update");
  }
  params.push(hash);

  try {
    await env.DB.prepare(
      `UPDATE agent_tokens SET ${updates.join(", ")} WHERE token_hash = ?`
    ).bind(...params).run();

    invalidateD1TokenCache();

    // Return the post-update row for confirmation
    const row = await env.DB.prepare(
      `SELECT token_hash, agent, name, user_id, scopes, tenant_id, disabled, last_used_at
       FROM agent_tokens WHERE token_hash = ?`
    ).bind(hash).first();

    return new Response(JSON.stringify({ ok: true, row }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "update failed", detail: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(request) } }
    );
  }
}

/**
 * DELETE /api/agent-tokens/:token_hash
 * Hard-delete by hash. For soft-revoke, PATCH disabled=true instead.
 */
export async function handleDeleteAgentToken(request: Request, env: Env, hash: string): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  if (!env.DB) {
    return new Response(JSON.stringify({ error: "DB unavailable" }), { status: 503 });
  }
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    return badRequest(request, "token_hash must be 64 hex chars");
  }

  try {
    const result = await env.DB.prepare(
      "DELETE FROM agent_tokens WHERE token_hash = ?"
    ).bind(hash).run();

    invalidateD1TokenCache();

    return new Response(JSON.stringify({
      ok: true,
      deleted: (result as any).meta?.changes ?? 0,
    }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(request) } });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "delete failed", detail: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(request) } }
    );
  }
}

// NOTE: handleExportRegistry was a TEMPORARY endpoint (GET /api/agent-tokens/
// registry-export) used by scripts/seed-agent-tokens-from-registry.js to
// migrate AGENT_REGISTRY (Cloudflare Worker secret) to agent_tokens (D1).
// Removed 2026-05-07 after the migration ran successfully. The legacy
// AGENT_REGISTRY secret remains in place as a break-glass auth fallback;
// removing it from the Worker config is a future hardening pass once D1
// has been authoritative for ≥7 days.

// ── Internal helpers ──────────────────────────────────────────────────────

function badRequest(request: Request, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status: 400,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}
