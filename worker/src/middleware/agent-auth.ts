/**
 * Agent Authentication Middleware
 *
 * Resolves a Bearer token to an agent identity with scopes.
 * Auth chain (first success wins):
 *   1. AGENT_REGISTRY secret → owner's agents (static, in Cloudflare KMS)
 *   2. D1 agent_tokens table → managed customer agents (dynamic, API-managed)
 *   3. Session tokens → D1 sessions table (portal users)
 *   4. Legacy fallback → MYA_WORKER_SECRET (transition period)
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

// Agent ID short codes → full IDs (for compact registry format)
const AGENT_SHORT: Record<string, string> = {
  p: 'personal-agent', c: 'company-agent', r: 'research-agent',
  x: 'commercial-intelligence-agent', n: 'publishing-agent',
  w: 'wealth-agent', i: 'intel-agent', o: 'ops-agent',
  q: 'qa-agent', e: 'enrichment-daemon', O: 'orchestrator', m: 'mom',
};

function parseRegistry(env: Env): Record<string, AgentRegistryEntry> | null {
  if (registryCache) return registryCache;
  const raw = (env as unknown as Record<string, unknown>).AGENT_REGISTRY as string | undefined;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    // Detect compact format: values are strings like "p:userId" instead of objects
    const firstVal = Object.values(parsed)[0];
    if (typeof firstVal === 'string') {
      // Compact format: "agentShort:userId"
      const expanded: Record<string, AgentRegistryEntry> = {};
      for (const [token, val] of Object.entries(parsed)) {
        const str = val as string;
        const [shortAgent, uid] = str.split(':');
        const fullAgent = AGENT_SHORT[shortAgent] || shortAgent;
        const fullUserId = uid === 's' ? 'system' : uid;
        expanded[token] = {
          agent: fullAgent,
          name: fullAgent,
          user_id: fullUserId,
          scopes: ['personal', 'org', 'wealth'] as Scope[],
        };
      }
      registryCache = expanded;
    } else {
      registryCache = parsed;
    }
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

// ── D1 Agent Tokens Lookup (managed customers) ────────────────────

/** SHA-256 hash a token for D1 lookup (tokens stored as hashes, never raw). */
async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// In-memory cache for D1 tokens (refreshed every 5 min)
let d1TokenCache: Map<string, AgentRegistryEntry> | null = null;
let d1TokenCacheTime = 0;
const D1_TOKEN_CACHE_TTL = 5 * 60 * 1000; // 5 min

/**
 * Look up a token in the D1 agent_tokens table.
 * Used for managed hosting customer agents. Tokens stored as SHA-256 hashes.
 * Cached in memory for 5 min to avoid D1 queries on every request.
 */
async function lookupD1AgentToken(
  token: string,
  env: Env,
): Promise<AgentRegistryEntry | null> {
  if (!env.DB) return null;

  try {
    const hash = await hashToken(token);

    // Check cache first
    if (d1TokenCache && Date.now() - d1TokenCacheTime < D1_TOKEN_CACHE_TTL) {
      const cached = d1TokenCache.get(hash);
      if (cached) return cached;
      // Cache miss doesn't mean absent — might be a new token added after cache load
    }

    // Query D1
    const row = await env.DB.prepare(
      "SELECT agent_id as agent, label as name, user_id, scopes FROM agent_tokens WHERE token_hash = ? AND is_active = 1"
    ).bind(hash).first<{ agent: string; name: string; user_id: string; scopes: string }>();

    if (!row) return null;

    const entry: AgentRegistryEntry = {
      agent: row.agent,
      name: row.name,
      user_id: row.user_id,
      scopes: (row.scopes.startsWith('[') ? JSON.parse(row.scopes) : row.scopes.split(",").map((s: string) => s.trim())) as Scope[],
    };

    // Update last_used_at (fire-and-forget, non-blocking)
    env.DB.prepare("UPDATE agent_tokens SET last_used_at = datetime('now') WHERE token_hash = ?")
      .bind(hash).run().catch(() => {});

    return entry;
  } catch {
    return null;
  }
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

  // 1. AGENT_REGISTRY secret (owner's agents — static, in Cloudflare KMS)
  const agentEntry = await lookupAgentToken(token, env);
  if (agentEntry) {
    return {
      ...agentEntry,
      auth_type: "agent",
    };
  }

  // 2. D1 agent_tokens table (managed customer agents — dynamic)
  const d1Entry = await lookupD1AgentToken(token, env);
  if (d1Entry) {
    return {
      ...d1Entry,
      auth_type: "agent",
    };
  }

  // 3. Session token (portal users)
  const session = await lookupSessionToken(token, env);
  if (session) return session;

  // 4. Legacy shared secret (transition period)
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
