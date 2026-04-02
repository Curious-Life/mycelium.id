/**
 * Agent Authentication Middleware
 *
 * Resolves a Bearer token to an agent identity with scopes.
 * Two auth paths:
 *   1. Agent tokens → static AGENT_REGISTRY secret (per-agent tokens)
 *   2. Session tokens → D1 sessions table lookup (portal users)
 *   3. Legacy fallback → MYA_WORKER_SECRET (transition period)
 */

import type { Env } from "../types/env";
import type { Scope } from "../services/crypto";

// ── Types ──────────────────────────────────────────────────────────

export interface AgentIdentity {
  agent: string;       // e.g. "personal-agent"
  name: string;        // e.g. "Mya"
  user_id: string;     // Owner user ID
  scopes: Scope[];     // Allowed encryption scopes
  auth_type: "agent" | "session" | "legacy";
}

interface AgentRegistryEntry {
  agent: string;
  name: string;
  user_id: string;
  scopes: Scope[];
}

// ── Token Extraction ───────────────────────────────────────────────

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7);
}

// ── Timing-Safe Compare ────────────────────────────────────────────

async function timingSafeCompare(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) {
    // Burn constant time, then return false
    await crypto.subtle.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.subtle.timingSafeEqual(aBuf, bBuf);
}

// ── Registry Lookup ────────────────────────────────────────────────

let registryCache: Record<string, AgentRegistryEntry> | null = null;

function parseRegistry(env: Env): Record<string, AgentRegistryEntry> | null {
  if (registryCache) return registryCache;
  const raw = (env as unknown as Record<string, unknown>).AGENT_REGISTRY as string | undefined;
  if (!raw) return null;
  try {
    registryCache = JSON.parse(raw);
    return registryCache;
  } catch {
    return null;
  }
}

/**
 * Look up a token in the agent registry with timing-safe comparison.
 * Iterates all registry entries to prevent timing leaks on which token matched.
 */
async function lookupAgentToken(
  token: string,
  env: Env,
): Promise<AgentRegistryEntry | null> {
  const registry = parseRegistry(env);
  if (!registry) return null;

  let match: AgentRegistryEntry | null = null;
  for (const [registeredToken, entry] of Object.entries(registry)) {
    const isMatch = await timingSafeCompare(token, registeredToken);
    if (isMatch) match = entry;
    // Don't break early — iterate all tokens for constant-time behavior
  }
  return match;
}

// ── Session Lookup ─────────────────────────────────────────────────

/**
 * Look up a session token in D1 sessions table.
 * Returns user identity with full scopes (portal users own their data).
 */
async function lookupSessionToken(
  token: string,
  env: Env,
): Promise<AgentIdentity | null> {
  if (!env.DB) return null;

  try {
    const row = await env.DB.prepare(
      "SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')",
    )
      .bind(token)
      .first<{ user_id: string }>();

    if (!row) return null;

    return {
      agent: "portal",
      name: "Portal",
      user_id: row.user_id,
      scopes: ["personal", "org", "wealth", "moms"], // Portal = full access
      auth_type: "session",
    };
  } catch {
    return null;
  }
}

// ── Legacy Fallback ────────────────────────────────────────────────

/**
 * Check against the legacy shared MYA_WORKER_SECRET.
 * During transition, this grants org-level access with an X-Agent-ID hint.
 */
async function checkLegacyToken(
  token: string,
  request: Request,
  env: Env,
): Promise<AgentIdentity | null> {
  if (!env.MYA_WORKER_SECRET) return null;
  const matches = await timingSafeCompare(token, env.MYA_WORKER_SECRET);
  if (!matches) {
    // Also check ADMIN_SECRET
    if (env.ADMIN_SECRET) {
      const matchesAdmin = await timingSafeCompare(token, env.ADMIN_SECRET);
      if (!matchesAdmin) return null;
      // Admin gets full scopes
      return {
        agent: "admin",
        name: "Admin",
        user_id: "system",
        scopes: ["personal", "org", "wealth", "moms"],
        auth_type: "legacy",
      };
    }
    return null;
  }

  // Legacy shared secret gets minimal org-only scope.
  // X-Agent-ID header is NOT trusted for scope assignment — agents
  // should migrate to per-agent tokens in AGENT_REGISTRY.
  const agentHint = request.headers.get("X-Agent-ID") || "unknown";

  return {
    agent: `legacy:${agentHint}`,
    name: agentHint,
    user_id: "system",
    scopes: ["org"] as Scope[],  // Minimal scope — no personal/wealth access
    auth_type: "legacy",
  };
}

// ── Main Auth Function ─────────────────────────────────────────────

/**
 * Authenticate a request and return the caller's identity + scopes.
 *
 * Auth chain (first success wins):
 *   1. AGENT_REGISTRY lookup (per-agent tokens)
 *   2. D1 sessions table lookup (portal session tokens)
 *   3. Legacy MYA_WORKER_SECRET / ADMIN_SECRET (transition fallback)
 *
 * Returns null if authentication fails.
 */
export async function authenticateRequest(
  request: Request,
  env: Env,
): Promise<AgentIdentity | null> {
  const token = extractBearerToken(request);
  if (!token) return null;

  // 1. Agent registry (new per-agent tokens)
  const agentEntry = await lookupAgentToken(token, env);
  if (agentEntry) {
    return {
      ...agentEntry,
      auth_type: "agent",
    };
  }

  // 2. Session token (portal users)
  const session = await lookupSessionToken(token, env);
  if (session) return session;

  // 3. Legacy shared secret (transition period)
  return checkLegacyToken(token, request, env);
}

/**
 * Convenience: authenticate or return a 401 Response.
 */
export async function requireAuth(
  request: Request,
  env: Env,
): Promise<AgentIdentity | Response> {
  const identity = await authenticateRequest(request, env);
  if (!identity) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return identity;
}

/** Reset the cached registry (for tests or secret rotation). */
export function clearRegistryCache(): void {
  registryCache = null;
}
