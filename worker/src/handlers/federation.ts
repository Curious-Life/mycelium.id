/**
 * Federation endpoints for cross-instance Mycelium connections.
 *
 * Implements:
 *   GET  /.well-known/webfinger        — RFC 7033 handle resolution
 *   GET  /federation/instance-info     — instance metadata + public key
 *   GET  /federation/profile/:handle   — public profile (delegates to public-profile handler)
 *   POST /federation/connect           — receive connection request
 *   POST /federation/connect/:id/accept — receive acceptance
 *   POST /federation/connect/:id/cancel — withdraw request
 *   POST /federation/overlap           — mutual territory label exchange
 *   POST /federation/rotate-key        — key rotation announcement
 *
 * Security: Ed25519 JWT with replay protection (iat/exp/jti/body_hash).
 * See docs/FEDERATION-SPEC.md for full protocol.
 */

import type { Env } from "../types/env";

// ── CORS (public for GET, restricted for POST) ──────────────────────────────

const PUBLIC_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...PUBLIC_CORS, ...headers },
  });
}

// ── WebFinger ────────────────────────────────────────────────────────────────

async function handleWebFinger(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname !== "/.well-known/webfinger") return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PUBLIC_CORS });
  if (request.method !== "GET") return null;

  const resource = url.searchParams.get("resource");
  if (!resource) return json({ error: "resource parameter required" }, 400);

  // Parse acct:handle@domain
  const match = resource.match(/^acct:([a-z0-9][a-z0-9_]{2,29})@(.+)$/i);
  if (!match) return json({ error: "Invalid resource format" }, 400);

  const handle = match[1].toLowerCase();
  const domain = match[2];

  // Verify this handle exists in our DB
  const db = env.DB;
  if (!db) return json({ error: "Service unavailable" }, 503);

  const profile = await db
    .prepare("SELECT user_id, did FROM user_profiles WHERE handle = ?")
    .bind(handle)
    .first<{ user_id: string; did: string | null }>();

  if (!profile) return json({ error: "Not found" }, 404);

  const baseUrl = `https://${domain}`;

  return json({
    subject: resource,
    links: [
      {
        rel: "self",
        type: "application/json",
        href: `${baseUrl}/api/public/profile/${handle}`,
      },
      {
        rel: "https://mycelium.id/ns/federation",
        href: `${baseUrl}/federation`,
      },
      ...(profile.did
        ? [{ rel: "https://mycelium.id/ns/did", href: profile.did }]
        : []),
    ],
  });
}

// ── Instance Info ────────────────────────────────────────────────────────────

async function handleInstanceInfo(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PUBLIC_CORS });

  const publicKey = (env as any).INSTANCE_PUBLIC_KEY || null;
  const keyId = (env as any).INSTANCE_SUB_KEY_ID || null;

  // Count users (cached in KV for 1 hour)
  let userCount = 0;
  if (env.KV) {
    const cached = await env.KV.get("fed:user-count");
    if (cached) {
      userCount = parseInt(cached);
    } else if (env.DB) {
      try {
        const row = await env.DB
          .prepare("SELECT COUNT(*) as c FROM user_profiles")
          .first<{ c: number }>();
        userCount = row?.c || 0;
        await env.KV.put("fed:user-count", String(userCount), { expirationTtl: 3600 });
      } catch {}
    }
  }

  return json({
    $type: "social.mycelium.instance-info.v1",
    name: "Mycelium",
    version: "1.0.0",
    protocol_version: "1.0",
    public_key: publicKey,
    key_id: keyId,
    user_count: userCount,
    capabilities: ["connect", "overlap-labels"],
    supported_overlap_methods: ["labels"],
  });
}

// ── JWT Verification ─────────────────────────────────────────────────────────

interface JWTPayload {
  iss: string;
  iat: number;
  exp: number;
  jti: string;
  body_hash: string;
}

async function verifyFederationJWT(
  request: Request,
  env: Env,
  body: string,
): Promise<{ payload: JWTPayload; error?: never } | { payload?: never; error: string }> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: "Missing Authorization header" };
  }

  const token = authHeader.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3) return { error: "Malformed JWT" };

  try {
    // Decode header and payload
    const header = JSON.parse(atob(parts[0]));
    const payload: JWTPayload = JSON.parse(atob(parts[1]));

    if (header.alg !== "EdDSA") return { error: "Unsupported algorithm" };

    // Check expiry (with 30s clock skew tolerance)
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now - 30) return { error: "JWT expired" };
    if (payload.iat > now + 30) return { error: "JWT issued in the future" };

    // Check nonce (replay protection)
    if (!payload.jti) return { error: "Missing jti" };
    if (env.KV) {
      const nonceKey = `fed:nonce:${payload.jti}`;
      const seen = await env.KV.get(nonceKey);
      if (seen) return { error: "Replayed request" };
      await env.KV.put(nonceKey, "1", { expirationTtl: 90 });
    }

    // Verify body hash
    if (payload.body_hash) {
      const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
      const hashHex = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, "0")).join("");
      if (payload.body_hash !== `sha256:${hashHex}`) {
        return { error: "Body hash mismatch" };
      }
    }

    // Look up the issuing instance's public key
    const db = env.DB;
    if (!db) return { error: "Database unavailable" };

    let publicKeyB64: string | null = null;

    // Check federation_keys cache
    try {
      const cached = await db
        .prepare("SELECT public_key FROM federation_keys WHERE instance_url = ?")
        .bind(payload.iss)
        .first<{ public_key: string }>();
      if (cached) publicKeyB64 = cached.public_key;
    } catch {}

    // If not cached, fetch from remote instance
    if (!publicKeyB64) {
      try {
        const infoRes = await fetch(`https://${payload.iss}/federation/instance-info`, {
          signal: AbortSignal.timeout(5000),
        });
        if (infoRes.ok) {
          const info = await infoRes.json() as { public_key?: string; key_id?: string };
          if (info.public_key) {
            publicKeyB64 = info.public_key;
            // Cache it
            await db
              .prepare(
                `INSERT INTO federation_keys (instance_url, public_key, key_id, last_seen, trust_level)
                 VALUES (?, ?, ?, datetime('now'), 1)
                 ON CONFLICT (instance_url) DO UPDATE SET
                   public_key = excluded.public_key, key_id = excluded.key_id,
                   last_seen = datetime('now')`,
              )
              .bind(payload.iss, info.public_key, info.key_id || null)
              .run();
          }
        }
      } catch {}
    }

    if (!publicKeyB64) return { error: "Cannot verify: unknown instance" };

    // Import the public key and verify
    const publicKeyDer = Uint8Array.from(atob(publicKeyB64), c => c.charCodeAt(0));
    const publicKey = await crypto.subtle.importKey(
      "spki",
      publicKeyDer,
      { name: "Ed25519" },
      false,
      ["verify"],
    );

    const signatureBytes = Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const valid = await crypto.subtle.verify("Ed25519", publicKey, signatureBytes, signedData);

    if (!valid) return { error: "Invalid signature" };

    return { payload };
  } catch (e: any) {
    return { error: `JWT verification failed: ${e.message}` };
  }
}

// ── Connection Request ───────────────────────────────────────────────────────

async function handleConnect(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PUBLIC_CORS });

  const body = await request.text();

  // Verify JWT
  const auth = await verifyFederationJWT(request, env, body);
  if (auth.error) return json({ error: auth.error }, 401);

  // Parse request
  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // Validate fields
  const { from_handle, from_instance, from_did, to_handle } = data;
  if (!from_handle || !from_instance || !to_handle) {
    return json({ error: "Missing required fields" }, 400);
  }
  if (from_handle.length > 30 || to_handle.length > 30 || from_instance.length > 253) {
    return json({ error: "Field too long" }, 400);
  }

  const db = env.DB;
  if (!db) return json({ error: "Service unavailable" }, 503);

  // Find the target user
  const target = await db
    .prepare("SELECT user_id FROM user_profiles WHERE handle = ?")
    .bind(to_handle)
    .first<{ user_id: string }>();

  if (!target) return json({ error: "User not found" }, 404);

  // Create connection record
  const connId = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO connections (id, user_a, user_b, initiated_by, status, remote_instance, remote_user_handle, remote_did, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, datetime('now'))`,
      )
      .bind(
        connId,
        target.user_id, // user_a = local user
        `${from_handle}@${from_instance}`, // user_b = remote identifier
        `${from_handle}@${from_instance}`, // initiated_by
        from_instance,
        from_handle,
        from_did || null,
      )
      .run();
  } catch (e: any) {
    if (e.message?.includes("UNIQUE")) {
      return json({ error: "Connection already exists" }, 409);
    }
    throw e;
  }

  // Log
  await logFederation(db, "inbound", from_instance, "connect", "success", `${from_handle} → ${to_handle}`);

  return json({ connection_id: connId, status: "pending" }, 201);
}

// ── Connection Accept ────────────────────────────────────────────────────────

async function handleAccept(request: Request, env: Env, connectionId: string): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PUBLIC_CORS });

  const body = await request.text();
  const auth = await verifyFederationJWT(request, env, body);
  if (auth.error) return json({ error: auth.error }, 401);

  const db = env.DB;
  if (!db) return json({ error: "Service unavailable" }, 503);

  // Find and update the connection
  const conn = await db
    .prepare("SELECT id, status FROM connections WHERE id = ? AND status = 'pending'")
    .bind(connectionId)
    .first<{ id: string; status: string }>();

  if (!conn) return json({ error: "Connection not found or not pending" }, 404);

  await db
    .prepare("UPDATE connections SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?")
    .bind(connectionId)
    .run();

  await logFederation(db, "inbound", auth.payload!.iss, "accept", "success", connectionId);

  return json({ ok: true });
}

// ── Connection Cancel ────────────────────────────────────────────────────────

async function handleCancel(request: Request, env: Env, connectionId: string): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PUBLIC_CORS });

  const body = await request.text();
  const auth = await verifyFederationJWT(request, env, body);
  if (auth.error) return json({ error: auth.error }, 401);

  const db = env.DB;
  if (!db) return json({ error: "Service unavailable" }, 503);

  await db
    .prepare("DELETE FROM connections WHERE id = ? AND status = 'pending' AND remote_instance IS NOT NULL")
    .bind(connectionId)
    .run();

  await logFederation(db, "inbound", auth.payload!.iss, "cancel", "success", connectionId);

  return json({ ok: true });
}

// ── Overlap Exchange ─────────────────────────────────────────────────────────

async function handleOverlap(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PUBLIC_CORS });

  const body = await request.text();
  const auth = await verifyFederationJWT(request, env, body);
  if (auth.error) return json({ error: auth.error }, 401);

  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { connection_id, requester_handle } = data;
  if (!connection_id) return json({ error: "connection_id required" }, 400);

  const db = env.DB;
  if (!db) return json({ error: "Service unavailable" }, 503);

  // Find the connection and the local user
  const conn = await db
    .prepare("SELECT user_a, user_b, status FROM connections WHERE id = ? AND status = 'accepted'")
    .bind(connection_id)
    .first<{ user_a: string; user_b: string; status: string }>();

  if (!conn) return json({ error: "Connection not found or not accepted" }, 404);

  // Determine local user_id (the one that's not the remote handle)
  const localUserId = conn.user_a.includes("@") ? conn.user_b : conn.user_a;

  // Fetch local user's visible territories
  const territories = await db
    .prepare(
      `SELECT name, essence, message_count FROM territory_profiles
       WHERE user_id = ? AND visibility IN ('public', 'friends') AND name IS NOT NULL
       ORDER BY message_count DESC`,
    )
    .bind(localUserId)
    .all();

  const localTerritories = (territories.results || []).map((t: any) => ({
    name: t.name,
    essence: t.essence,
    message_count: t.message_count || 0,
  }));

  // Validate incoming territories (max 100 chars per name, max 1000 territories)
  const incomingTerritories = (data.territories || []).slice(0, 1000).map((t: any) => ({
    name: String(t.name || "").slice(0, 100),
    essence: String(t.essence || "").slice(0, 500),
    message_count: Math.min(Math.max(0, Number(t.message_count) || 0), 1000000),
  }));

  await logFederation(db, "inbound", auth.payload!.iss, "overlap", "success",
    `${requester_handle}: ${incomingTerritories.length} labels`);

  return json({
    $type: "social.mycelium.overlap-response.v1",
    connection_id,
    responder_handle: localUserId,
    territories: localTerritories,
  });
}

// ── Key Rotation ─────────────────────────────────────────────────────────────

async function handleRotateKey(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PUBLIC_CORS });

  const body = await request.text();
  const auth = await verifyFederationJWT(request, env, body);
  if (auth.error) return json({ error: auth.error }, 401);

  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { instance, new_public_key, new_key_id, old_key_valid_until } = data;
  if (!new_public_key || !new_key_id) return json({ error: "Missing key data" }, 400);

  const db = env.DB;
  if (!db) return json({ error: "Service unavailable" }, 503);

  // Update the cached key for this instance
  await db
    .prepare(
      `UPDATE federation_keys SET public_key = ?, key_id = ?, last_seen = datetime('now')
       WHERE instance_url = ?`,
    )
    .bind(new_public_key, new_key_id, auth.payload!.iss)
    .run();

  await logFederation(db, "inbound", auth.payload!.iss, "rotate-key", "success", `new kid: ${new_key_id}`);

  return json({ ok: true });
}

// ── Logging ──────────────────────────────────────────────────────────────────

async function logFederation(
  db: D1Database,
  direction: string,
  remoteInstance: string,
  action: string,
  status: string,
  details: string,
) {
  try {
    await db
      .prepare(
        `INSERT INTO federation_log (id, direction, remote_instance, action, status, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .bind(crypto.randomUUID(), direction, remoteInstance, action, status, details)
      .run();
  } catch {}
}

// ── Rate Limiting ────────────────────────────────────────────────────────────

async function checkFederationRateLimit(
  env: Env,
  remoteInstance: string,
  action: string,
): Promise<boolean> {
  if (!env.KV) return true; // No KV = no rate limiting (fail open)

  const key = action === "overlap"
    ? `rl:fed-overlap:${remoteInstance}`
    : `rl:fed:${remoteInstance}`;
  const limit = action === "overlap" ? 10 : 60; // per minute

  const count = parseInt(await env.KV.get(key) || "0");
  if (count >= limit) return false;
  await env.KV.put(key, String(count + 1), { expirationTtl: 60 });
  return true;
}

// ── Main Router ──────────────────────────────────────────────────────────────

export async function handleFederationRequest(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  const { pathname } = url;

  // WebFinger
  if (pathname === "/.well-known/webfinger") {
    return handleWebFinger(request, env, url);
  }

  // Instance info
  if (pathname === "/federation/instance-info" && (request.method === "GET" || request.method === "OPTIONS")) {
    return handleInstanceInfo(request, env);
  }

  // All other federation endpoints require POST
  if (!pathname.startsWith("/federation/")) return null;

  // Rate limit by remote instance (from JWT issuer, but check before parsing)
  // For POST endpoints, extract issuer from JWT without full verification first
  if (request.method === "POST") {
    const authHeader = request.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const parts = authHeader.slice(7).split(".");
        const payload = JSON.parse(atob(parts[1]));
        if (payload.iss) {
          const allowed = await checkFederationRateLimit(env, payload.iss, pathname.includes("overlap") ? "overlap" : "general");
          if (!allowed) {
            return json({ error: "Rate limit exceeded" }, 429);
          }
        }
      } catch {}
    }
  }

  // Route POST endpoints
  if (pathname === "/federation/connect" && request.method === "POST") {
    return handleConnect(request, env);
  }

  const connectMatch = pathname.match(/^\/federation\/connect\/([a-f0-9-]+)\/(accept|cancel)$/);
  if (connectMatch && request.method === "POST") {
    const [, connId, action] = connectMatch;
    return action === "accept"
      ? handleAccept(request, env, connId)
      : handleCancel(request, env, connId);
  }

  if (pathname === "/federation/overlap" && request.method === "POST") {
    return handleOverlap(request, env);
  }

  if (pathname === "/federation/rotate-key" && request.method === "POST") {
    return handleRotateKey(request, env);
  }

  // OPTIONS for any federation path
  if (request.method === "OPTIONS" && pathname.startsWith("/federation/")) {
    return new Response(null, { status: 204, headers: PUBLIC_CORS });
  }

  return null;
}
