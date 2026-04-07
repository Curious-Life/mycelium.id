/**
 * Public Profile API — unauthenticated endpoint for public profile cards.
 *
 * Serves: GET /api/public/profile/:handle
 *   - Reads user_profiles + territory_profiles (visibility='public') from D1
 *   - Caches in KV (5-minute TTL)
 *   - Wildcard CORS (data is intentionally public)
 *   - Rate limited: 120/min per IP
 *
 * NO access to encrypted data, private territories, messages, or embeddings.
 */

import type { Env } from "../types/env";
import { getD1ForTenant } from "../services/tenant-d1";

const PUBLIC_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const KV_TTL = 300; // 5 minutes

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...PUBLIC_CORS },
  });
}

/**
 * Handle public profile requests.
 * Returns null if the path doesn't match (so caller can fall through).
 */
export async function handlePublicProfile(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response | null> {
  // OPTIONS preflight
  if (request.method === "OPTIONS" && pathname.startsWith("/api/public/profile/")) {
    return new Response(null, { status: 204, headers: PUBLIC_CORS });
  }

  // Match GET /api/public/profile/:handle
  if (request.method !== "GET") return null;
  const match = pathname.match(/^\/api\/public\/profile\/([a-z0-9][a-z0-9_]{2,29})$/);
  if (!match) return null;

  const handle = match[1];

  // Rate limit: 120/min per IP
  if (env.KV) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const rlKey = `rl:pub-profile:${ip}`;
    const count = parseInt(await env.KV.get(rlKey) || "0");
    if (count >= 120) {
      return json({ error: "Rate limit exceeded" }, 429);
    }
    await env.KV.put(rlKey, String(count + 1), { expirationTtl: 60 });
  }

  // Check KV cache
  if (env.KV) {
    const cached = await env.KV.get(`profile:${handle}`, "text");
    if (cached) {
      return new Response(cached, {
        headers: { "Content-Type": "application/json", ...PUBLIC_CORS },
      });
    }
  }

  // Look up handle in owner D1 (handle_reservations)
  const db = env.DB;
  if (!db) return json({ error: "Service unavailable" }, 503);

  // First try: find profile directly in owner D1
  let profile = await queryProfile(db, handle);

  // If not found in owner D1, check handle_reservations for tenant routing
  if (!profile) {
    try {
      const reservation = await db
        .prepare("SELECT user_id FROM handle_reservations WHERE handle = ?")
        .bind(handle)
        .first<{ user_id: string }>();

      if (reservation) {
        // Try to find which tenant has this user's data
        const job = await db
          .prepare("SELECT tenant_id FROM provisioning_jobs WHERE user_id = ? AND status = 'ready' LIMIT 1")
          .bind(reservation.user_id)
          .first<{ tenant_id: string }>();

        if (job?.tenant_id) {
          const tenantDb = getD1ForTenant(env, job.tenant_id);
          if (tenantDb) {
            profile = await queryProfile(tenantDb, handle);
          }
        }
      }
    } catch {
      // Fall through — handle not found
    }
  }

  if (!profile) {
    return json({ error: "Profile not found" }, 404);
  }

  // Fetch public territories
  const targetDb = profile._db || db;
  let territories: Array<{ name: string; essence: string | null; realm_id: number | null; message_count: number }> = [];
  try {
    const terrResult = await targetDb
      .prepare(
        `SELECT name, essence, realm_id, message_count
         FROM territory_profiles
         WHERE user_id = ? AND visibility = 'public' AND name IS NOT NULL
         ORDER BY message_count DESC`,
      )
      .bind(profile.user_id)
      .all();
    territories = (terrResult.results || []).map((t: any) => ({
      name: t.name,
      essence: t.essence,
      realm_id: t.realm_id,
      message_count: t.message_count || 0,
    }));
  } catch {}

  // Build public response
  const publicRealms = profile.public_realms_json
    ? JSON.parse(profile.public_realms_json)
    : [];

  const result = {
    handle: profile.handle,
    display_name: profile.display_name,
    signature: profile.signature,
    depth_score: profile.depth_score || 0,
    breadth_score: profile.breadth_score || 0,
    coherence_score: profile.coherence_score || 0,
    exploration_score: profile.exploration_score || 0,
    territory_count: profile.territory_count || 0,
    realm_count: profile.realm_count || 0,
    message_count: profile.message_count || 0,
    member_since: profile.member_since,
    realms: publicRealms,
    territories,
  };

  const body = JSON.stringify(result);

  // Cache in KV
  if (env.KV) {
    await env.KV.put(`profile:${handle}`, body, { expirationTtl: KV_TTL });
  }

  return new Response(body, {
    headers: { "Content-Type": "application/json", ...PUBLIC_CORS },
  });
}

// Query user_profiles by handle in a given D1 database
async function queryProfile(db: D1Database, handle: string) {
  try {
    const row = await db
      .prepare(
        `SELECT user_id, handle, display_name, signature,
                depth_score, breadth_score, coherence_score, exploration_score,
                territory_count, realm_count, message_count, member_since,
                public_realms_json
         FROM user_profiles WHERE handle = ?`,
      )
      .bind(handle)
      .first<any>();

    if (row) {
      row._db = db; // Carry the DB ref for territory lookup
      return row;
    }
  } catch {}
  return null;
}
