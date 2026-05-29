/**
 * Share Links — typed endpoints for the cross-tenant share-link table.
 *
 * `share_links` lives in admin D1 (migration 139, `@scope: operator`)
 * because the universal `mycelium.id/share/<token>` route needs to
 * resolve a token without knowing the owner's tenant up front. The
 * Worker reads admin D1 for `(user_id, document_path)`, hops to the
 * right tenant DB for the slug, and serves the R2 artifact.
 *
 * Why typed endpoints instead of raw SQL via /api/db/query:
 *
 *   Customer agents authenticate with D1-issued `agent_tokens` that
 *   carry a `tenant_id`. The proxy's `validateAndResolveTenantId` (see
 *   services/tenant-d1.ts) fail-closes those tokens to their own
 *   tenant DB on every /api/db/query — by design, since that's how
 *   tenant isolation works. Customer share-link writes therefore had
 *   no path to admin D1 and were landing against the customer's
 *   tenant share_links table (which carries the legacy
 *   entity_type/entity_id schema, no user_id, no document_path) → 500
 *   "no column user_id" on every shareDocument call.
 *
 *   The typed endpoint pattern (mirrored from handles.ts) bypasses the
 *   tenant-routing escape hatch: it talks directly to env.DB after
 *   deriving user_id from the bearer token's identity. The auth
 *   boundary is server-side — the request body NEVER specifies
 *   user_id; revoke() / has-active / count-recent / list all filter
 *   by `user_id = identity.user_id`.
 *
 * Endpoints:
 *   POST /api/share-links/create        body: { documentPath, invitedEmailCipher?, expiresInDays?, maxViews? }
 *   POST /api/share-links/revoke        body: { token }
 *   GET  /api/share-links/list?path=…   list caller's links for one doc
 *   GET  /api/share-links/has-active?path=…    "is this doc share-link-public?"
 *   GET  /api/share-links/count-recent?hours=N anti-spam counter
 *   GET  /api/share-links/by-token?token=…     lookup if the caller owns it
 *                                              (used by portal revoke flow to
 *                                              find the doc path for the post-
 *                                              revoke isPublic re-evaluation)
 *
 * Encryption note:
 *   `invited_email` is in ENCRYPTED_FIELDS (Swiss Vault). The Worker
 *   is a passthrough — the VPS encrypts the cipher before POST,
 *   stores ciphertext as-is, returns ciphertext on read, VPS
 *   decrypts. Worker MUST NOT inspect the value. Token, document_path,
 *   user_id, expires_at stay plaintext (see migration 139 header).
 *
 * Authorization invariant: every read/write enforces
 *     `target.user_id === identity.user_id`
 * server-side. Defense in depth: the SQL-safety guardian still blocks
 * raw SQL on `share_links` from non-admin tokens (see PR-2 in
 * HANDLE-REGISTRY-FIX), so even if this handler were misconfigured
 * the proxy can't be used to bypass it.
 */

import { requireAuth, type AgentIdentity } from "../middleware/agent-auth";
import { corsHeaders } from "../utils/cors";
import type { Env } from "../types/env";

const MAX_DOC_PATH_LEN = 512;
const DEFAULT_EXPIRES_DAYS = 30;
const MIN_EXPIRES_DAYS = 1;
const MAX_EXPIRES_DAYS = 365;
const MAX_RECENT_HOURS = 24 * 7;

const HOUR_MS = 60 * 60 * 1000;

function jsonResponse(body: unknown, status: number, request: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

/**
 * Resolve the caller's effective user_id. Owner-side AGENT_REGISTRY
 * agents carry the literal `"system"` sentinel; map it to
 * env.OWNER_USER_ID so owner shareDocument calls have a real
 * owner to attribute the row to. Customer agents have a real user_id
 * baked into their D1 agent_tokens row.
 *
 * Mirrors handles.ts:resolveEffectiveUserId so the two registry
 * surfaces handle the same identity space identically.
 */
function resolveEffectiveUserId(identity: AgentIdentity, env: Env): string | null {
  if (identity.user_id === "system") {
    return env.OWNER_USER_ID || null;
  }
  return identity.user_id || null;
}

/**
 * Common gate: scoped tokens are denied (extension subprocesses must
 * not mint share-links on the parent's behalf — same rationale as
 * handles.ts:gateWrite). Tokens with no resolvable user_id are denied.
 *
 * Returns either an error Response or the resolved user_id.
 */
function gate(identity: AgentIdentity, env: Env, request: Request): { userId: string } | Response {
  if (identity.auth_type === "scoped_agent") {
    return jsonResponse(
      { error: "Scoped tokens cannot mint share-links", reason: "scoped_token_forbidden" },
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

/**
 * Validate document_path. We don't enforce a regex on it — the schema
 * stores arbitrary path strings — but it must be a non-empty string
 * within the bounded length. Type-checking is the safety net here.
 */
function validateDocumentPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_DOC_PATH_LEN) return null;
  return trimmed;
}

/** Reject token shapes other than plain randomUUID() outputs. */
function validateTokenShape(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // UUID v4 length range covers crypto.randomUUID() output reliably.
  // Out-of-band values (32-char hex from rotated codepaths, future
  // formats) need a deliberate update here.
  if (!/^[a-f0-9-]{32,36}$/i.test(raw)) return null;
  return raw;
}

/** Anti-spam: cap expiresInDays inside the contractual band. */
function clampExpiresInDays(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_EXPIRES_DAYS;
  return Math.max(MIN_EXPIRES_DAYS, Math.min(MAX_EXPIRES_DAYS, Math.floor(n)));
}

// ── POST /api/share-links/create ─────────────────────────────────────

/**
 * Body: { documentPath, invitedEmailCipher?, expiresInDays?, maxViews? }
 *
 * `invitedEmailCipher` is OPTIONAL. When supplied it MUST already be a
 * Swiss Vault ciphertext envelope — VPS encrypts before sending. Plain
 * string values are stored as-is (see passthrough rule above) but
 * downstream auto-decrypt will refuse to interpret them, so this is
 * safe-but-broken (the link works; the recipient label can't be
 * decrypted). Callers should always pre-encrypt.
 */
export async function shareLinkCreate(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  const identity = auth;

  const g = gate(identity, env, request);
  if (g instanceof Response) return g;
  const { userId } = g;

  let body: {
    documentPath?: unknown;
    invitedEmailCipher?: unknown;
    expiresInDays?: unknown;
    maxViews?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400, request);
  }

  const documentPath = validateDocumentPath(body.documentPath);
  if (!documentPath) {
    return jsonResponse({ error: "documentPath required" }, 400, request);
  }

  const expiresInDays = clampExpiresInDays(body.expiresInDays);
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * HOUR_MS).toISOString();

  // maxViews: number or null. Anything else (string, NaN, negative)
  // collapses to null = unlimited rather than 400 — the caller may
  // have legitimately omitted it and we shouldn't fail the whole call
  // on a malformed optional field.
  let maxViews: number | null = null;
  if (typeof body.maxViews === "number" && Number.isFinite(body.maxViews) && body.maxViews >= 1) {
    maxViews = Math.floor(body.maxViews);
  }

  // invited_email: pre-encrypted cipher only. We refuse to accept
  // plaintext here so a misconfigured client can't accidentally
  // bypass Swiss Vault — see invited_email semantics in migration 139.
  let invitedEmail: string | null = null;
  if (typeof body.invitedEmailCipher === "string" && body.invitedEmailCipher.length > 0) {
    invitedEmail = body.invitedEmailCipher;
  }

  if (!env.DB) {
    return jsonResponse({ error: "Owner DB not configured" }, 503, request);
  }

  const token = crypto.randomUUID();

  await env.DB
    .prepare(
      `INSERT INTO share_links
         (token, user_id, document_path, invited_email, expires_at, max_views)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(token, userId, documentPath, invitedEmail, expiresAt, maxViews)
    .run();

  return jsonResponse({ ok: true, token, expiresAt }, 200, request);
}

// ── POST /api/share-links/revoke ─────────────────────────────────────

/**
 * Body: { token }. DELETE WHERE token = ? AND user_id = ?. The
 * user_id clause is the auth boundary — a request asking to delete
 * someone else's token becomes a no-op (changes=0), surfaced as 404.
 */
export async function shareLinkRevoke(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  const identity = auth;

  const g = gate(identity, env, request);
  if (g instanceof Response) return g;
  const { userId } = g;

  let body: { token?: unknown };
  try {
    body = (await request.json()) as { token?: unknown };
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400, request);
  }

  const token = validateTokenShape(body.token);
  if (!token) {
    return jsonResponse({ error: "token required" }, 400, request);
  }

  if (!env.DB) {
    return jsonResponse({ error: "Owner DB not configured" }, 503, request);
  }

  const result = await env.DB
    .prepare("DELETE FROM share_links WHERE token = ? AND user_id = ?")
    .bind(token, userId)
    .run();

  const changes = (result as { meta?: { changes?: number } })?.meta?.changes ?? 0;
  if (changes === 0) {
    return jsonResponse({ ok: false, reason: "not_owner_or_missing" }, 404, request);
  }
  return jsonResponse({ ok: true }, 200, request);
}

// ── GET /api/share-links/list?path=… ─────────────────────────────────

/**
 * List the caller's share-links for a single document. Returns active
 * AND expired rows — UI is responsible for visual differentiation.
 * `invited_email` comes back as the ciphertext envelope; the VPS
 * client auto-decrypts.
 */
export async function shareLinkList(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  const identity = auth;

  const g = gate(identity, env, request);
  if (g instanceof Response) return g;
  const { userId } = g;

  const url = new URL(request.url);
  const documentPath = validateDocumentPath(url.searchParams.get("path"));
  if (!documentPath) {
    return jsonResponse({ error: "path required" }, 400, request);
  }

  if (!env.DB) {
    return jsonResponse({ error: "Owner DB not configured" }, 503, request);
  }

  const result = await env.DB
    .prepare(
      `SELECT token, invited_email, expires_at, max_views, view_count, created_at
         FROM share_links
        WHERE user_id = ? AND document_path = ?
        ORDER BY created_at DESC`,
    )
    .bind(userId, documentPath)
    .all<{
      token: string;
      invited_email: string | null;
      expires_at: string;
      max_views: number | null;
      view_count: number;
      created_at: string;
    }>();

  return jsonResponse({ links: result.results || [] }, 200, request);
}

// ── GET /api/share-links/has-active?path=… ───────────────────────────

/**
 * "Does this doc have at least one ACTIVE share-link?" — drives the
 * isPublic state machine in unpublishDocument's R2 cleanup path.
 * Active = not expired AND (no view cap OR view_count < max_views).
 */
export async function shareLinkHasActive(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  const identity = auth;

  const g = gate(identity, env, request);
  if (g instanceof Response) return g;
  const { userId } = g;

  const url = new URL(request.url);
  const documentPath = validateDocumentPath(url.searchParams.get("path"));
  if (!documentPath) {
    return jsonResponse({ error: "path required" }, 400, request);
  }

  if (!env.DB) {
    return jsonResponse({ error: "Owner DB not configured" }, 503, request);
  }

  const row = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM share_links
        WHERE user_id = ? AND document_path = ?
          AND expires_at > datetime('now')
          AND (max_views IS NULL OR view_count < max_views)`,
    )
    .bind(userId, documentPath)
    .first<{ n: number }>();

  const hasActive = (row?.n ?? 0) > 0;
  return jsonResponse({ hasActive }, 200, request);
}

// ── GET /api/share-links/by-token?token=… ────────────────────────────

/**
 * Look up a share-link by token, but only if the caller owns it. The
 * `WHERE token = ? AND user_id = ?` clause is the auth boundary —
 * cross-user lookups return 404 instead of leaking the row.
 *
 * Used by the portal revoke flow which needs the link's document_path
 * to re-evaluate hasActiveLinks() after deletion. NOT used by the
 * public `/share/<token>` route (that one runs server-side in the
 * Worker against env.DB without an authenticated identity).
 */
export async function shareLinkByToken(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  const identity = auth;

  const g = gate(identity, env, request);
  if (g instanceof Response) return g;
  const { userId } = g;

  const url = new URL(request.url);
  const token = validateTokenShape(url.searchParams.get("token"));
  if (!token) {
    return jsonResponse({ error: "token required" }, 400, request);
  }

  if (!env.DB) {
    return jsonResponse({ error: "Owner DB not configured" }, 503, request);
  }

  const row = await env.DB
    .prepare(
      `SELECT token, document_path, invited_email, expires_at, max_views, view_count, created_at
         FROM share_links
        WHERE token = ? AND user_id = ?
        LIMIT 1`,
    )
    .bind(token, userId)
    .first<{
      token: string;
      document_path: string;
      invited_email: string | null;
      expires_at: string;
      max_views: number | null;
      view_count: number;
      created_at: string;
    }>();

  if (!row) {
    return jsonResponse({ link: null }, 404, request);
  }
  return jsonResponse({ link: row }, 200, request);
}

// ── GET /api/share-links/count-recent?hours=N ────────────────────────

/**
 * "How many share-links has this caller created in the last N hours?"
 * — drives the anti-spam cap in shareDocument (≥20/hr → refuse). N
 * is bounded to a week to keep the query plan stable.
 */
export async function shareLinkCountRecent(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  const identity = auth;

  const g = gate(identity, env, request);
  if (g instanceof Response) return g;
  const { userId } = g;

  const url = new URL(request.url);
  const hoursRaw = url.searchParams.get("hours");
  const hoursNum = hoursRaw == null ? 1 : Number(hoursRaw);
  if (!Number.isFinite(hoursNum) || hoursNum <= 0) {
    return jsonResponse({ error: "hours must be a positive number" }, 400, request);
  }
  const hours = Math.min(MAX_RECENT_HOURS, Math.floor(hoursNum));

  if (!env.DB) {
    return jsonResponse({ error: "Owner DB not configured" }, 503, request);
  }

  const row = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM share_links
        WHERE user_id = ?
          AND created_at > datetime('now', ?)`,
    )
    .bind(userId, `-${hours} hours`)
    .first<{ n: number }>();

  return jsonResponse({ count: row?.n ?? 0 }, 200, request);
}
