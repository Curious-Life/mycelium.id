/**
 * Publishing handlers — the public surface under `/p/*` on each
 * handle's portal subdomain, plus the universal share-link route.
 *
 * Architecture: Worker reads R2 directly (no decrypt — Swiss Vault
 * invariant). The agent server owns the publish + render path; the
 * Worker is a static-content gateway with auth checks.
 *
 * Routes handled here:
 *   <handle>.mycelium.id/p/<slug>         published doc (R2 lookup)
 *   <handle>.mycelium.id/p/_heartbeat     presence ping
 *   <handle>.mycelium.id/p/robots.txt     auto-generated
 *   <handle>.mycelium.id/p/llms.txt       auto-generated
 *   <handle>.mycelium.id/p/sitemap.xml    auto-generated
 *   mycelium.id/share/<token>             share-link resolution
 *
 * URL design note: publishing lives under the `/p/` path prefix on
 * the existing per-handle subdomain. The portal at
 * `<handle>.mycelium.id/library`, `/auth/*` etc continues to be
 * served by Caddy on the customer VPS — Cloudflare's Worker route
 * `*.mycelium.id/p/*` only intercepts the publishing namespace.
 *
 * The path prefix exists because Cloudflare Universal SSL only covers
 * one level of wildcard subdomain (`*.mycelium.id`); a deeper wildcard
 * like `*.pub.mycelium.id` would need paid Advanced Certificate Manager.
 * `/p/` keeps publishing in the same TLS envelope as the portal.
 *
 * See "Routing decision (Phase 7)" in docs/PUBLISHING-PLAN.md for the
 * full reasoning.
 */

import { resolveTenantDb } from "../services/tenant-d1";
import type { Env } from "../types/env";

// Reserved subdomains — never resolvable as user handles. Mirrors
// the handle-claim blocklist for defense in depth.
const RESERVED_HANDLES = new Set([
  "www", "cdn", "api", "admin", "app", "mycelium", "status", "docs",
  "share", "mail", "static", "public", "auth", "id", "well-known",
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const TOKEN_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// Public response security headers.
//
// Note: we deliberately do NOT use the CSP `sandbox` directive on the
// outer shell. That directive would put the page itself in a null
// origin, which breaks the heartbeat fetch (cross-origin to its own
// host with credentials). The agent-authored content is constrained
// by the iframe's `sandbox` HTML attribute (no allow-same-origin); the
// outer shell is server-controlled (only doc.title is interpolated, and
// it's HTML-escaped) so it doesn't need additional sandboxing.
//
// `default-src 'none'` is fail-closed; each subresource type is then
// allowed only as needed: frame-src for the iframe, img-src for HTTPS
// images the agent's HTML may embed, style-src for inline styles in
// the shell, script-src for the heartbeat snippet, connect-src for the
// heartbeat fetch back to the same origin.
const PUBLIC_HEADERS_BASE = {
  "Content-Security-Policy":
    "default-src 'none'; " +
    "frame-src 'self' data:; img-src 'self' data: https:; " +
    "style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
};

/**
 * Try to handle a request as a publishing route. Returns Response if
 * matched, null if the caller should fall through to the next handler.
 *
 * Matching logic:
 *   - If host is `mycelium.id` and pathname starts with `/share/`:
 *     handle share-link route (universal across operators).
 *   - If host is `<handle>.mycelium.id` AND pathname starts with `/p/`:
 *     handle publishing routes. Strip the `/p/` prefix and route the
 *     remainder. The path prefix exists because Cloudflare Universal
 *     SSL only covers one level of wildcard — staying under the
 *     existing `*.mycelium.id` cert avoids paid Advanced Cert Manager.
 *   - Otherwise null — request falls through (portal traffic on
 *     `<handle>.mycelium.id/*` outside `/p/` belongs to Caddy on the
 *     customer's VPS).
 *
 * CF route attachments needed for production (one-time):
 *   - Worker route:        *.mycelium.id/p/*    → mya
 *   - Worker route:        mycelium.id/share/*  → mya
 *   - Existing portals at  *.mycelium.id/...    → untouched (Caddy)
 *
 * No new DNS entries needed — `*.mycelium.id` already resolves through
 * Cloudflare for portal hosting.
 */
export async function handlePublishing(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();

  // Skip entirely if the publishing infra isn't configured. Lets
  // the rest of the Worker continue to function.
  if (!env.DB || !env.PUBLIC_BUCKET) return null;

  // ── Universal share-link route on apex ──
  if (host === "mycelium.id" && url.pathname.startsWith("/share/")) {
    return handleShareLink(request, env, ctx, url);
  }

  // ── Subdomain matching: <handle>.mycelium.id with /p/ prefix ──
  const handleMatch = host.match(/^([a-z0-9-]+)\.mycelium\.id$/);
  if (!handleMatch) return null;
  const handle = handleMatch[1];

  // The `/p/` prefix is structural: only paths under it belong to
  // publishing. Anything else on this hostname stays with the portal
  // (Caddy on the customer VPS). This guard is defensive — the CF
  // Worker route `*.mycelium.id/p/*` should already prevent non-/p/
  // requests from reaching us.
  if (!url.pathname.startsWith("/p/")) return null;
  // Strip the `/p` prefix; sub-routes match against the remaining path.
  // "/p/foo" → "/foo", "/p/" → "/", "/p" → "" (treat as not-found).
  const subpath = url.pathname.slice(2) || "";

  // Reject reserved handles (defense in depth — handle_reservations
  // also rejects them at claim time).
  if (RESERVED_HANDLES.has(handle) || !HANDLE_RE.test(handle)) {
    return notFound();
  }

  // Resolve handle → user_id via the owner D1's handle_reservations
  // table (the canonical mapping; users.handle exists in the schema
  // but isn't populated by the claim flow). System-reserved sentinel
  // rows (user_id='00000000000000000000000000000000') are filtered
  // out so reserved subdomain names that match a user's claim shape
  // don't accidentally resolve to the sentinel.
  const userRow = await env.DB!.prepare(
    `SELECT user_id FROM handle_reservations
     WHERE handle = ? AND user_id <> '00000000000000000000000000000000'
     LIMIT 1`,
  ).bind(handle).first<{ user_id: string }>();
  if (!userRow) return notFound();
  const userId = userRow.user_id;

  // Phase 4: 410 Gone for tombstoned handles during the grace window.
  // After account-deletion completes (deletion_records.status =
  // 'deleted_tombstone'), the handle is reserved for 90 days
  // (handle_release_at) before becoming re-registerable. During this
  // window, served URLs return 410 (instead of 404) so caches, clients,
  // and federation tooling can distinguish "intentionally gone" from
  // "never existed" / "moved" (RFC 7231 §6.5.9).
  try {
    const deletion = await env.DB!.prepare(
      `SELECT status, handle_release_at FROM deletion_records
       WHERE user_id = ? AND status = 'deleted_tombstone'
       ORDER BY completed_at DESC LIMIT 1`,
    ).bind(userId).first<{ status: string; handle_release_at: string | null }>();
    if (deletion) {
      const releaseTs = deletion.handle_release_at ? Date.parse(deletion.handle_release_at) : 0;
      if (!deletion.handle_release_at || releaseTs > Date.now()) {
        return new Response(
          `<!doctype html><meta charset=utf-8><title>410 Gone</title>` +
          `<h1>410 Gone</h1><p>The handle <code>${handle}</code> has been deleted by its owner.</p>`,
          { status: 410, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } },
        );
      }
    }
  } catch { /* table missing pre-migration; fall through to normal flow */ }

  // Route by stripped subpath.
  if (subpath === "/_heartbeat") {
    return handleHeartbeat(request, env, ctx, userId);
  }
  if (subpath === "/robots.txt") {
    return handleRobotsTxt(handle);
  }
  if (subpath === "/llms.txt") {
    return handleLlmsTxt(env, handle, userId);
  }
  if (subpath === "/sitemap.xml") {
    return handleSitemapXml(env, handle, userId);
  }
  if (subpath === "/" || subpath === "") {
    // /p/ index — v1: 404. v2 could render an auto-generated list of
    // the operator's published docs.
    return notFound();
  }

  // Treat the rest as a slug lookup. Pass the slug-only segment
  // (without the leading slash).
  return handlePublicSlug(request, env, ctx, handle, userId, subpath);
}

/**
 * Resolve the right D1 binding for a user_id. Customer operators
 * have a DB_TENANT_<userId> binding (their docs live there); admin
 * (owner) has no such binding — admin's docs live in env.DB. Try
 * tenant first, fall back to admin. Returns null only when neither
 * exists, which is a misconfiguration.
 */
function dbForUser(env: Env, userId: string): D1Database | null {
  const { db: tenantDb } = resolveTenantDb(env, userId);
  if (tenantDb) return tenantDb;
  return env.DB || null;
}

// ── Public slug route ──────────────────────────────────────────────
async function handlePublicSlug(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  handle: string,
  userId: string,
  pathname: string,
): Promise<Response> {
  const slug = pathname.slice(1);  // strip leading /
  if (!SLUG_RE.test(slug)) return notFound();

  // Per-IP rate limit. The existing rate-limit util checks an IP
  // counter in KV; deny silently (429) on exceeded.
  if (!await rateLimitOk(env, request, "public-page")) return rateLimited();

  // Verify the doc is published in the right tenant.
  const tenantDb = dbForUser(env, userId);
  if (!tenantDb) return notFound();
  const doc = await tenantDb.prepare(
    `SELECT path FROM documents
     WHERE user_id = ? AND public_slug = ? AND published = 1
     LIMIT 1`,
  ).bind(userId, slug).first<{ path: string }>();
  if (!doc) return notFound();

  // Read R2 artifact. If missing, the agent server hasn't pushed it
  // yet (or there's a state drift — not our problem to recover here).
  const r2Key = `published/${userId}/${slug}.html`;
  const obj = await env.PUBLIC_BUCKET!.get(r2Key);
  if (!obj) return notFound();

  // Visit-count + presence cookie. Fire-and-forget so the response
  // ships immediately.
  ctx.waitUntil(
    tenantDb.prepare(
      "UPDATE documents SET public_visit_count = public_visit_count + 1 WHERE user_id = ? AND path = ?",
    ).bind(userId, doc.path).run(),
  );

  const sessionId = getOrSetSessionCookie(request);
  const setCookie = `myc_session=${sessionId}; Max-Age=31536000; Secure; SameSite=Lax; Path=/; HttpOnly`;

  return new Response(obj.body, {
    status: 200,
    headers: {
      ...PUBLIC_HEADERS_BASE,
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": setCookie,
      "Cache-Control": "public, max-age=60, s-maxage=60",
    },
  });
}

// ── Share-link route (universal mycelium.id/share/<token>) ────────
async function handleShareLink(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  const token = url.pathname.slice("/share/".length);
  if (!TOKEN_RE.test(token)) return notFound();
  if (!env.DB || !env.PUBLIC_BUCKET) return notFound();
  if (!await rateLimitOk(env, request, "share-link")) return rateLimited();

  // Token lookup in admin D1. Returns the encrypted invited_email
  // by default; we don't need it here so don't include it in SELECT
  // (avoid the auto-decrypt round-trip).
  const link = await env.DB.prepare(
    `SELECT user_id, document_path, expires_at, max_views, view_count
     FROM share_links WHERE token = ? LIMIT 1`,
  ).bind(token).first<{
    user_id: string;
    document_path: string;
    expires_at: string;
    max_views: number | null;
    view_count: number;
  }>();
  if (!link) return notFound();

  // Validate gates.
  if (Date.parse(link.expires_at) < Date.now()) {
    return new Response("Share link expired", { status: 410 });
  }
  if (link.max_views !== null && link.view_count >= link.max_views) {
    return new Response("Share link exhausted", { status: 410 });
  }

  // Resolve user → tenant DB → slug.
  const tenantDb = dbForUser(env, link.user_id);
  if (!tenantDb) return notFound();
  const doc = await tenantDb.prepare(
    "SELECT public_slug FROM documents WHERE user_id = ? AND path = ? LIMIT 1",
  ).bind(link.user_id, link.document_path).first<{ public_slug: string | null }>();
  if (!doc?.public_slug) return notFound();

  const obj = await env.PUBLIC_BUCKET!.get(`published/${link.user_id}/${doc.public_slug}.html`);
  if (!obj) return notFound();

  // Fire-and-forget view increment.
  ctx.waitUntil(
    env.DB!.prepare(
      "UPDATE share_links SET view_count = view_count + 1 WHERE token = ?",
    ).bind(token).run(),
  );

  // Note: we DON'T set the myc_session cookie here. Heartbeats fire
  // from the published page itself, scoped to the handle subdomain;
  // share recipients see the rendered HTML but don't appear in the
  // owner's "reading now" count. This is intentional — share-link
  // analytics use share_links.view_count instead.

  return new Response(obj.body, {
    status: 200,
    headers: {
      ...PUBLIC_HEADERS_BASE,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, max-age=0, no-store", // never cached — token-bound
    },
  });
}

// ── Heartbeat route (subdomain-scoped) ────────────────────────────
//
// Anti-inflation: three independent gates.
//   1. Per-IP rate limit (60 req/min, same as the public-page route).
//      Caps how fast a single attacker can pump heartbeats.
//   2. Cookie required. We do NOT mint a session_id here — only honor
//      an existing myc_session cookie. Real visitors always have one
//      because the slug-page response set it. A script hitting
//      /_heartbeat directly without first loading the page gets a
//      silent 204 and writes nothing. Without this, every cookieless
//      request would create a fresh presence row and inflate
//      "reading now" arbitrarily.
//   3. Slug must reference an actually-published doc. Otherwise
//      someone with a stale cookie can't pump arbitrary strings.
//
// All gates degrade silently (204 on miss) — the heartbeat path is
// fire-and-forget from the browser's perspective; status codes don't
// reach the user.
async function handleHeartbeat(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  userId: string,
): Promise<Response> {
  // Gate 1: rate limit.
  if (!await rateLimitOk(env, request, "heartbeat")) {
    return new Response(null, { status: 204 });
  }

  // Gate 2: require existing session cookie.
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const sessionId = cookies.myc_session;
  if (!sessionId || !TOKEN_RE.test(sessionId)) {
    return new Response(null, { status: 204 });
  }

  // Gate 3: slug must reference a published doc.
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");
  if (!slug || !SLUG_RE.test(slug)) {
    return new Response(null, { status: 204 });
  }
  const tenantDb = dbForUser(env, userId);
  if (!tenantDb) return notFound();
  const valid = await tenantDb.prepare(
    "SELECT 1 FROM documents WHERE user_id = ? AND public_slug = ? AND published = 1 LIMIT 1",
  ).bind(userId, slug).first();
  if (!valid) {
    return new Response(null, { status: 204 });
  }

  ctx.waitUntil(
    tenantDb.prepare(
      `INSERT INTO public_presence (session_id, user_id, public_slug, last_beat_at, first_seen_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(session_id) DO UPDATE SET
         last_beat_at = datetime('now'),
         user_id = excluded.user_id,
         public_slug = excluded.public_slug`,
    ).bind(sessionId, userId, slug).run(),
  );

  return new Response(null, { status: 204 });
}

// ── Discovery files ──────────────────────────────────────────────

function handleRobotsTxt(handle: string): Response {
  // robots.txt is served at <handle>.mycelium.id/p/robots.txt but the
  // sitemap directive must reference the full URL crawlers will fetch.
  // Disallow path is relative to the host root (not /p/-relative) per
  // the robots.txt spec.
  const body = `User-agent: *
Allow: /p/
Disallow: /p/_heartbeat

Sitemap: https://${handle}.mycelium.id/p/sitemap.xml
`;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}

async function handleLlmsTxt(env: Env, handle: string, userId: string): Promise<Response> {
  const tenantDb = dbForUser(env, userId);
  if (!tenantDb) return notFound();
  const docs = await tenantDb.prepare(
    `SELECT title, summary, public_slug FROM documents
     WHERE user_id = ? AND published = 1 AND public_slug IS NOT NULL
     ORDER BY updated_at DESC`,
  ).bind(userId).all<{ title: string | null; summary: string | null; public_slug: string }>();

  const lines = [
    `# ${handle}`,
    "",
    `> Personal published content from ${handle}.mycelium.id/p/`,
    "",
    "## Pages",
  ];
  for (const d of docs.results || []) {
    const url = `https://${handle}.mycelium.id/p/${d.public_slug}`;
    const title = (d.title || d.public_slug).replace(/[\r\n]+/g, " ").slice(0, 120);
    if (d.summary) {
      const summary = d.summary.replace(/[\r\n]+/g, " ").slice(0, 200);
      lines.push(`- [${title}](${url}): ${summary}`);
    } else {
      lines.push(`- [${title}](${url})`);
    }
  }
  lines.push("");

  return new Response(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}

async function handleSitemapXml(env: Env, handle: string, userId: string): Promise<Response> {
  const tenantDb = dbForUser(env, userId);
  if (!tenantDb) return notFound();
  const docs = await tenantDb.prepare(
    `SELECT public_slug, updated_at FROM documents
     WHERE user_id = ? AND published = 1 AND public_slug IS NOT NULL
     ORDER BY updated_at DESC`,
  ).bind(userId).all<{ public_slug: string; updated_at: string }>();

  const urlEntries = (docs.results || []).map((d) => {
    const loc = `https://${handle}.mycelium.id/p/${escapeXml(d.public_slug)}`;
    const lastmod = (d.updated_at || "").slice(0, 10); // YYYY-MM-DD
    return `  <url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}<changefreq>weekly</changefreq></url>`;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries.join("\n")}
</urlset>
`;
  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────────

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
}

function rateLimited(): Response {
  return new Response("Rate limited", { status: 429, headers: { "Content-Type": "text/plain" } });
}

/**
 * Read myc_session cookie if present, else mint a new UUID. Caller
 * is responsible for setting the Set-Cookie response header.
 */
function getOrSetSessionCookie(request: Request): string {
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  return cookies.myc_session || crypto.randomUUID();
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Public-route rate limit: per-IP bucket via KV with a short TTL.
 * Bucket key = `pub-rl:<ip>:<scope>`. Returns true if the request
 * is allowed, false if it exceeded the cap.
 *
 * v1 thresholds:
 *   public-page: 60 req/min per IP per scope (generous — CDN handles
 *                bursts; the limit is for pathological clients)
 *   share-link:  60 req/min per IP per scope
 */
async function rateLimitOk(env: Env, request: Request, scope: string): Promise<boolean> {
  if (!env.KV) return true; // no KV in this env — allow
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const bucket = Math.floor(Date.now() / 60_000); // minute-aligned
  const key = `pub-rl:${scope}:${ip}:${bucket}`;

  // Read-modify-write — KV doesn't have atomic increment, so this
  // is best-effort under burst. Cloudflare's edge-cache layer
  // absorbs most of the load before it hits us anyway.
  const current = parseInt((await env.KV.get(key)) || "0", 10);
  if (current >= 60) return false;
  // 90s TTL covers the minute window plus skew between edges.
  await env.KV.put(key, String(current + 1), { expirationTtl: 90 });
  return true;
}
