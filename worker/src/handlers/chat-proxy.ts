/**
 * Chat Proxy Handler
 *
 * Replaces the heavy message handler (Claude API + context assembly + tool loop)
 * with a thin proxy to the VPS agent-server.
 *
 * The VPS agent-server runs Claude Code CLI with MCP tools.
 * This handler just forwards the message and returns the response.
 *
 * Used by:
 *   - Portal web chat (POST /api/chat)
 *   - Telegram webhook (replaces handleMessage)
 */

import type { Env } from "../types/env";
import { SupabaseService } from "../services/supabase";
import { corsOrigin } from "../utils/cors";

const PROXY_TIMEOUT_MS = 180_000; // 3 minutes

interface ChatRequest {
  message: string;
  userId: string;
  channelId?: string;
  source?: "portal" | "telegram";
}

interface ChatResponse {
  response: string;
  sessionId?: string;
}

/**
 * Proxy a chat message to the VPS agent-server.
 *
 * @param message - User's message
 * @param userId - Supabase user UUID
 * @param channelId - Channel ID for session continuity
 * @param source - Message source (portal, telegram)
 * @param env - Worker env with MYA_AGENT_URL
 */
export async function proxyChat(
  message: string,
  userId: string,
  channelId: string,
  source: string,
  env: Env
): Promise<string> {
  const agentUrl = env.MYA_AGENT_URL;
  if (!agentUrl) {
    throw new Error("MYA_AGENT_URL not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const res = await fetch(`${agentUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Worker-Secret": env.MYA_WORKER_SECRET || "",
      },
      body: JSON.stringify({
        message,
        channelId,
        userId,
        source,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Agent returned ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as ChatResponse;
    return data.response || "No response from agent.";
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * HTTP handler for POST /api/chat
 * Portal web interface uses this endpoint.
 */
export async function handlePortalChat(
  request: Request,
  env: Env
): Promise<Response> {
  // CORS
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": corsOrigin(request),
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Session-Token",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  try {
    const body = (await request.json()) as {
      message: string;
      sessionToken?: string;
    };

    if (!body.message) {
      return Response.json({ error: "message required" }, { status: 400 });
    }

    // Authenticate via session token
    const sessionToken = body.sessionToken || request.headers.get("X-Session-Token");
    if (!sessionToken) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const supabase = new SupabaseService(env);
    const session = await supabase.verifySessionToken(sessionToken);
    if (!session) {
      return Response.json({ error: "Invalid session" }, { status: 401 });
    }

    const response = await proxyChat(
      body.message,
      session.user_id,
      `portal_${session.user_id}`,
      "portal",
      env
    );

    return Response.json(
      { response },
      {
        headers: {
          "Access-Control-Allow-Origin": corsOrigin(request),
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[ChatProxy] Error:", message);
    return Response.json(
      { error: message },
      {
        status: 502,
        headers: {
          "Access-Control-Allow-Origin": corsOrigin(request),
          "Content-Type": "application/json",
        },
      }
    );
  }
}
