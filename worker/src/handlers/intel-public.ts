/**
 * Public Intel API — unauthenticated endpoints for the public intel dashboard
 *
 * Serves:
 *   - Situation report from KV (pushed unencrypted by agent-server)
 *   - Polymarket data (cached in KV, pushed by agent-server)
 *   - War room state (cached in KV, pushed by agent-server)
 *   - OpenSky aircraft (proxied from public API)
 *
 * NO access to encrypted data, messages, documents, secrets, or any other D1 tables.
 * This is a read-only public intelligence feed. All data comes from KV only.
 */

import type { Env } from "../types/env";
import { authenticateRequest } from "../middleware/agent-auth";

// ── Allowed KV keys (whitelist for snapshot ingest) ──────────────────────

const ALLOWED_KV_KEYS = new Set([
  "report", "recommendations", "signals", "entities", "insiders",
  "warroom-state", "bases", "infrastructure", "cii", "events-feed",
  "trending", "convergence", "oref", "ais", "gpsjam", "markets-geo",
]);

// ── CORS ─────────────────────────────────────────────────────────────────

const INTEL_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// Restrictive CORS for authenticated endpoints (snapshot ingest)
const SNAPSHOT_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "",  // No browser origin allowed
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...INTEL_CORS },
  });
}

function errorResponse(msg: string, status = 500): Response {
  return jsonResponse({ error: msg }, status);
}

// ── Timing-safe comparison ──────────────────────────────────────────────

async function timingSafeCompare(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) {
    // Compare against self to burn same time, then return false
    await crypto.subtle.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

// ── KV snapshot helpers ─────────────────────────────────────────────────

async function getKVSnapshot(env: Env, key: string): Promise<unknown | null> {
  if (!env.KV) return null;
  const data = await env.KV.get(`intel:${key}`, "json");
  return data;
}

// ── Route handler ───────────────────────────────────────────────────────

export async function handleIntelRequest(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response | null> {
  // Only handle /api/intel/* routes
  if (!pathname.startsWith("/api/intel/")) return null;

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: INTEL_CORS });
  }

  // Only GET for public endpoints
  if (request.method !== "GET") {
    return errorResponse("Method not allowed", 405);
  }

  const route = pathname.slice("/api/intel/".length);
  const url = new URL(request.url);

  try {
    switch (route) {
      // ── Situation Report (from KV only — never falls back to D1) ──
      case "report": {
        const kvReport = await getKVSnapshot(env, "report") as { report: string; lastUpdated: string | null } | null;
        if (kvReport && kvReport.report) {
          let report = kvReport.report;
          if (report.startsWith("# Situation Report\n\n")) {
            report = report.slice("# Situation Report\n\n".length);
          }
          return jsonResponse({ report, lastUpdated: kvReport.lastUpdated });
        }
        // KV empty — return null rather than querying D1 (which may contain encrypted data)
        return jsonResponse({ report: null, lastUpdated: null });
      }

      // ── Polymarket endpoints (served from KV cache) ──────────────
      case "recommendations": {
        const data = await getKVSnapshot(env, "recommendations");
        return jsonResponse({ recommendations: data || [] });
      }

      case "signals": {
        const data = await getKVSnapshot(env, "signals");
        return jsonResponse({ signals: data || [] });
      }

      case "entities": {
        const data = await getKVSnapshot(env, "entities");
        return jsonResponse({ entities: data || [] });
      }

      case "insiders": {
        const data = await getKVSnapshot(env, "insiders");
        return jsonResponse({ insiders: data || [] });
      }

      case "markets/search": {
        return jsonResponse({ markets: [] });
      }

      // ── War room state (from KV cache) ────────────────────────────
      case "warroom-state": {
        const data = await getKVSnapshot(env, "warroom-state");
        if (!data) return jsonResponse({ theaters: [], actors: [], all_actors: [], actor_links: [], blocs: [], threads: [], events: [] });
        return jsonResponse(data);
      }

      case "bases": {
        const data = await getKVSnapshot(env, "bases");
        return jsonResponse(data || { bases: [] });
      }

      case "infrastructure": {
        const data = await getKVSnapshot(env, "infrastructure");
        return jsonResponse(data || { infrastructure: [] });
      }

      case "cii": {
        const data = await getKVSnapshot(env, "cii");
        return jsonResponse(data || {});
      }

      case "events-feed": {
        const data = await getKVSnapshot(env, "events-feed");
        return jsonResponse(data || { events: [] });
      }

      case "trending": {
        const data = await getKVSnapshot(env, "trending");
        return jsonResponse(data || { trending: [] });
      }

      case "convergence": {
        const data = await getKVSnapshot(env, "convergence");
        return jsonResponse(data || { convergences: [] });
      }

      case "oref": {
        const data = await getKVSnapshot(env, "oref");
        return jsonResponse(data || { alerts: [] });
      }

      case "ais": {
        const data = await getKVSnapshot(env, "ais");
        return jsonResponse(data || { vessels: [] });
      }

      case "gpsjam": {
        const data = await getKVSnapshot(env, "gpsjam");
        return jsonResponse(data || { events: [] });
      }

      case "markets-geo": {
        const data = await getKVSnapshot(env, "markets-geo");
        return jsonResponse(data || { markets: [] });
      }

      // ── OpenSky (direct proxy to public API — no credentials) ─────
      case "opensky": {
        const callsigns = [
          "RCH", "FORTE", "HOMER", "JAKE", "DUKE", "NCHO",
          "EVIL", "VIPER", "TOPCT", "NATO", "LAGR", "REDEYE",
          "DIXIE", "COBRA", "HAWK", "BRAVO",
        ];
        try {
          const resp = await fetch(
            "https://opensky-network.org/api/states/all",
            { signal: AbortSignal.timeout(10_000) },
          );
          if (!resp.ok) return jsonResponse({ aircraft: [] });
          const data = await resp.json() as { states?: unknown[][] };
          if (!data.states) return jsonResponse({ aircraft: [] });

          const aircraft = data.states
            .filter((s: unknown[]) => {
              const cs = (s[1] as string || "").trim().toUpperCase();
              return callsigns.some((prefix) => cs.startsWith(prefix));
            })
            .map((s: unknown[]) => ({
              icao24: s[0],
              callsign: (s[1] as string || "").trim(),
              origin: s[2],
              lat: s[6],
              lng: s[5],
              altitude: s[13] || s[7],
              velocity: s[9],
              heading: s[10],
              on_ground: s[8],
            }));

          return jsonResponse({ aircraft });
        } catch {
          return jsonResponse({ aircraft: [] });
        }
      }

      default:
        // Market detail — validate conditionId strictly to prevent SSRF
        if (route.startsWith("market/")) {
          const conditionId = route.slice("market/".length);
          if (!conditionId || !/^[a-zA-Z0-9_-]+$/.test(conditionId)) {
            return errorResponse("Invalid conditionId", 400);
          }
          // Serve from KV cache only — no live proxy to Polymarket
          const cached = await getKVSnapshot(env, `market:${conditionId}`);
          if (cached) return jsonResponse(cached);
          return errorResponse("Market not cached", 404);
        }
        return null;
    }
  } catch (e: any) {
    // Don't leak route names or internal details in error messages
    console.error(`[intel-public] request failed:`, e.message);
    return errorResponse("Service unavailable", 503);
  }
}

// ── Snapshot ingest (authenticated — called by agent-server) ────────────

export async function handleIntelSnapshot(
  request: Request,
  env: Env,
): Promise<Response> {
  // No CORS preflight for server-to-server endpoint
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: SNAPSHOT_CORS });
  }

  if (request.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  // Owner-only endpoint: authenticated via the standard agent token chain.
  // Only the owner's VPS pushes intel snapshots (it's the one running warroom).
  // We gate on identity.user_id matching env.OWNER_USER_ID — set as a Worker
  // var so the check is not bound to any particular agent name.
  const auth = await authenticateRequest(request, env);
  const ownerId = (env as unknown as Record<string, string>).OWNER_USER_ID;
  if (!auth || !ownerId || auth.user_id !== ownerId) {
    return errorResponse("Unauthorized", 401);
  }

  if (!env.KV) return errorResponse("KV not available");

  try {
    const body = await request.json() as Record<string, unknown>;
    const ttl = 3600; // 1 hour TTL — agent-server refreshes every 15 min

    const promises: Promise<void>[] = [];
    let accepted = 0;
    let rejected = 0;
    for (const [key, value] of Object.entries(body)) {
      if (value === null || value === undefined) continue;
      // Only allow whitelisted keys
      if (!ALLOWED_KV_KEYS.has(key)) {
        rejected++;
        continue;
      }
      accepted++;
      promises.push(
        env.KV.put(`intel:${key}`, JSON.stringify(value), { expirationTtl: ttl }),
      );
    }

    await Promise.all(promises);
    return new Response(JSON.stringify({ ok: true, accepted, rejected }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[intel-public] snapshot ingest failed:", e.message);
    return errorResponse("Snapshot ingest failed");
  }
}
