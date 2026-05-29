/**
 * Handle Registry — typed endpoints for the global handle namespace.
 *
 * Replaces the raw-SQL access pattern that lets any authenticated
 * tenant read/write `handle_reservations` on owner D1 (any token with
 * `ownerHeaders()` → `/api/db/query` could rewrite the global handle
 * map). Each endpoint here derives `user_id` from the authenticated
 * bearer token's identity — the request body NEVER specifies user_id.
 *
 * Endpoints:
 *   POST /api/handles/claim     body: { handle }, claim for caller
 *   POST /api/handles/release   body: { handle }, only if caller owns
 *   GET  /api/handles/mine      caller's current handle
 *   GET  /api/handles/check     KV-rate-limited availability check
 *
 * The existing GET /api/resolve-handle (worker/index.ts:950) handles
 * the generic handle→user_id case; this file does not duplicate it.
 *
 * Authorization invariant: every write enforces
 *   `target.user_id === identity.user_id`
 * server-side. The SQL-safety guardian (PR 2) will additionally block
 * raw SQL access to handle_reservations from non-admin tokens —
 * defense in depth, but the typed endpoint is the chokepoint.
 *
 * See docs/architecture/HANDLE-REGISTRY-FIX.md for full design.
 */

import { requireAuth, type AgentIdentity } from "../middleware/agent-auth";
import { corsHeaders } from "../utils/cors";
import type { Env } from "../types/env";
import { ensureHandleARecord } from "./dns";

// Reserved subdomains — never claimable as user handles. Mirrors the
// blocklist in publishing.ts (subdomain-conflicting set) plus the
// portal-route-conflicting set from profiles.js. PR 7 consolidates
// these three lists (here, publishing.ts, migration 141 sentinel rows)
// into a single source-of-truth constant.
export const RESERVED_HANDLES = new Set([
  // Subdomain-conflicting (mirror publishing.ts)
  "www", "cdn", "api", "admin", "app", "mycelium", "status", "docs",
  "share", "mail", "static", "public", "auth", "id", "well-known",
  // Portal-route-conflicting (mirror profiles.js RESERVED)
  "support", "system", "vault", "login", "signup", "profile",
  "settings", "help", "about", "discover", "connections",
]);

// DNS-compatible canonical handle format. Matches publishing.ts:43
// (the public-routing layer's regex), which is the binding constraint
// — handles become subdomains `<handle>.mycelium.id`, and DNS labels
// permit lowercase letters/digits/hyphens (RFC 1035), not underscores.
//
// profiles.js currently uses a more permissive regex that allows
// underscores; PR 7 reconciles by adopting this canonical form.
export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const CHECK_RATE_LIMIT_WINDOW_S = 60;
const CHECK_RATE_LIMIT_PER_WINDOW = 30;

interface ValidationOk { ok: true; handle: string; }
interface ValidationErr { ok: false; status: number; reason: string; }

function normalizeHandle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.replace(/^@/, "").trim().toLowerCase();
  return trimmed || null;
}

function validateHandle(raw: unknown): ValidationOk | ValidationErr {
  const handle = normalizeHandle(raw);
  if (!handle) return { ok: false, status: 400, reason: "missing" };
  if (!HANDLE_RE.test(handle)) return { ok: false, status: 400, reason: "invalid_format" };
  if (RESERVED_HANDLES.has(handle)) return { ok: false, status: 400, reason: "reserved" };
  return { ok: true, handle };
}

function jsonResponse(body: unknown, status: number, request: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

/**
 * Resolve the caller's effective user_id.
 *
 * Owner-side agents carry `user_id = "system"` in AGENT_REGISTRY (it's
 * a deliberate sentinel — the owner runs N agents on the same VPS,
 * all acting on behalf of the same human operator). For those, fall
 * back to `env.OWNER_USER_ID` which the Worker has configured to
 * the owner's UUID. Tenant agents have a real user_id baked into
 * their D1 `agent_tokens` row and don't need the fallback.
 *
 * Mirrors the pattern in self-service.ts:386-388 ("senderUserId").
 *
 * Returns null if no usable id can be resolved (malformed token, or
 * system identity in an environment without OWNER_USER_ID).
 */
function resolveEffectiveUserId(identity: AgentIdentity, env: Env): string | null {
  if (identity.user_id === "system") {
    return env.OWNER_USER_ID || null;
  }
  return identity.user_id || null;
}

/**
 * Auth gate for write paths. Returns either an error Response or the
 * resolved effective user_id.
 *
 * Disqualifies:
 *   - scoped_agent tokens (extension subprocesses): a scoped token
 *     mutating its parent's reservation row would be an escalation.
 *     Mine() is allowed because reading the parent's handle is
 *     harmless and the publish hook depends on it.
 *   - tokens with no resolvable user_id (system identity in an env
 *     without OWNER_USER_ID, malformed token).
 */
function gateWrite(identity: AgentIdentity, env: Env, request: Request): { userId: string } | Response {
  if (identity.auth_type === "scoped_agent") {
    return jsonResponse(
      { error: "Scoped tokens cannot mutate handles", reason: "scoped_token_forbidden" },
      403,
      request,
    );
  }
  const userId = resolveEffectiveUserId(identity, env);
  if (!userId) {
    return jsonResponse(
      { error: "Token has no usable user_id", reason: "no_user_id" },
      403,
      request,
    );
  }
  return { userId };
}

// ── POST /api/handles/claim ──────────────────────────────────────────

/**
 * Body: { handle: string }. Reserves `handle` for the caller's
 * `identity.user_id`. Idempotent on re-claim by the same user; 409 on
 * cross-user collision.
 *
 * Race-safe via INSERT OR IGNORE + SELECT-to-confirm. SQLite's
 * PRIMARY KEY constraint on `handle_reservations.handle` makes the
 * INSERT atomic; the follow-up SELECT observes whichever writer's row
 * landed first.
 */
export async function handleClaim(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  const identity = auth;

  const gate = gateWrite(identity, env, request);
  if (gate instanceof Response) return gate;
  const { userId } = gate;

  let body: { handle?: unknown };
  try {
    body = (await request.json()) as { handle?: unknown };
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400, request);
  }

  const validation = validateHandle(body.handle);
  if (!validation.ok) {
    return jsonResponse({ error: "Invalid handle", reason: validation.reason }, validation.status, request);
  }
  const { handle } = validation;

  if (!env.DB) {
    return jsonResponse({ error: "Owner DB not configured" }, 503, request);
  }

  // Race-safe claim:
  //   1. INSERT OR IGNORE — atomic on PRIMARY KEY(handle).
  //   2. SELECT — confirm the row's user_id is ours.
  // Cross-user collision: INSERT no-ops, SELECT returns their
  // user_id, we surface 409. Same-user re-claim: SELECT confirms
  // ownership, we return 200.
  await env.DB
    .prepare("INSERT OR IGNORE INTO handle_reservations (handle, user_id) VALUES (?, ?)")
    .bind(handle, userId)
    .run();

  const row = await env.DB
    .prepare("SELECT user_id FROM handle_reservations WHERE handle = ?")
    .bind(handle)
    .first<{ user_id: string }>();

  if (!row) {
    // Should be unreachable given the INSERT above. Treat as
    // transient D1 failure rather than success.
    return jsonResponse({ error: "Claim failed", reason: "no_row_after_insert" }, 500, request);
  }
  if (row.user_id !== userId) {
    return jsonResponse({ error: "Handle already claimed", reason: "already_claimed" }, 409, request);
  }

  // Auto-create DNS for owner handles. Customer signups already create
  // <handle>.mycelium.id via scripts/provision-customer.sh before
  // landing the reservation row; owner-side claims (admin operator
  // claiming their own handle via the portal or CLI) used to skip
  // that hop, leaving handles like `mbc.mycelium.id` with NO DNS at
  // all — Cloudflare returns error 1034 to the user's browser even
  // though the published doc is reachable from a CF edge IP.
  //
  // Gated on OWNER_VPS_IP being set: an operator that hasn't opted in
  // yet just keeps the previous behaviour. Failure here does NOT undo
  // the claim — the reservation row is the source of truth. A failed
  // DNS create is logged and surfaced in the response so the operator
  // can retry via /api/admin/create-dns. The next claim (or portal
  // refresh) will idempotently re-attempt.
  let dnsAction: string | undefined;
  let dnsError: string | undefined;
  if (env.OWNER_USER_ID && userId === env.OWNER_USER_ID && env.OWNER_VPS_IP) {
    const dnsResult = await ensureHandleARecord(env, handle, env.OWNER_VPS_IP);
    if (dnsResult.ok) {
      dnsAction = dnsResult.action;
    } else {
      dnsError = dnsResult.error;
    }
  }

  return jsonResponse({ ok: true, handle, dnsAction, dnsError }, 200, request);
}

// ── POST /api/handles/release ────────────────────────────────────────

/**
 * Body: { handle: string }. Removes the caller's reservation. The
 * `user_id = ?` clause is the auth boundary — a request asking to
 * delete someone else's handle becomes a no-op (changes=0).
 */
export async function handleRelease(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  const identity = auth;

  const gate = gateWrite(identity, env, request);
  if (gate instanceof Response) return gate;
  const { userId } = gate;

  let body: { handle?: unknown };
  try {
    body = (await request.json()) as { handle?: unknown };
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400, request);
  }

  const handle = normalizeHandle(body.handle);
  if (!handle) {
    return jsonResponse({ error: "handle required" }, 400, request);
  }

  if (!env.DB) {
    return jsonResponse({ error: "Owner DB not configured" }, 503, request);
  }

  const result = await env.DB
    .prepare("DELETE FROM handle_reservations WHERE handle = ? AND user_id = ?")
    .bind(handle, userId)
    .run();

  const changes = (result as { meta?: { changes?: number } })?.meta?.changes ?? 0;
  if (changes === 0) {
    return jsonResponse({ ok: false, reason: "not_owner" }, 404, request);
  }
  return jsonResponse({ ok: true }, 200, request);
}

// ── GET /api/handles/mine ────────────────────────────────────────────

/**
 * Returns the caller's earliest reservation, or null if unclaimed.
 * Scoped tokens are allowed here — a read of the parent's handle is
 * harmless and the publishing pipeline relies on it.
 *
 * Earliest-reservation wins matches the lookup pattern in
 * agent-server.js (publish hook) and portal-library.js (share/publish
 * routes); keep them aligned so the URL stays stable across surfaces.
 */
export async function handleMine(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  const identity = auth;

  // mine() allows scoped tokens (a scoped extension reading the
  // parent agent's handle is harmless and the publish hook depends
  // on it). Owner-side `system` identity falls back to OWNER_USER_ID.
  const userId = resolveEffectiveUserId(identity, env);
  if (!userId) {
    return jsonResponse({ error: "Token has no usable user_id", reason: "no_user_id" }, 403, request);
  }

  if (!env.DB) {
    return jsonResponse({ error: "Owner DB not configured" }, 503, request);
  }

  const row = await env.DB
    .prepare("SELECT handle FROM handle_reservations WHERE user_id = ? ORDER BY reserved_at ASC LIMIT 1")
    .bind(userId)
    .first<{ handle: string }>();

  return jsonResponse({ handle: row?.handle ?? null }, 200, request);
}

// ── GET /api/handles/check ───────────────────────────────────────────

/**
 * Availability check. KV-rate-limited per IP (30/min) to discourage
 * handle enumeration via this endpoint.
 *
 * Reserved-name handling: returns `{ available: false, reason: "reserved" }`
 * with 200 status (not 400). Reserved IS a meaningful answer to "is
 * this available?" — the portal UI surfaces it differently from
 * format-rejection but doesn't need the request to fail.
 */
export async function handleCheck(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  const identity = auth;

  const url = new URL(request.url);
  const validation = validateHandle(url.searchParams.get("handle"));
  if (!validation.ok) {
    if (validation.reason === "reserved") {
      return jsonResponse({ available: false, reason: "reserved" }, 200, request);
    }
    return jsonResponse({ available: false, reason: validation.reason }, validation.status, request);
  }
  const { handle } = validation;

  // Per-IP rate limit on /check. Falls back to identity.user_id when
  // CF-Connecting-IP is absent (local dev, edge cases).
  if (env.KV) {
    const ip = request.headers.get("CF-Connecting-IP") || identity.user_id || "anon";
    const rlKey = `handles-check-rl:${ip}`;
    const count = parseInt((await env.KV.get(rlKey)) || "0", 10);
    if (count >= CHECK_RATE_LIMIT_PER_WINDOW) {
      return jsonResponse({ error: "Rate limited", reason: "rate_limited" }, 429, request);
    }
    await env.KV.put(rlKey, String(count + 1), { expirationTtl: CHECK_RATE_LIMIT_WINDOW_S });
  }

  if (!env.DB) {
    return jsonResponse({ error: "Owner DB not configured" }, 503, request);
  }

  const row = await env.DB
    .prepare("SELECT 1 AS taken FROM handle_reservations WHERE handle = ? LIMIT 1")
    .bind(handle)
    .first<{ taken: number }>();

  return jsonResponse({ available: !row }, 200, request);
}
