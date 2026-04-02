/**
 * KV-based rate limiter for AI and expensive endpoints.
 * Uses sliding window counters with KV TTL for automatic expiry.
 */

interface RateLimitConfig {
  /** Max requests allowed in the window */
  limit: number;
  /** Window size in seconds */
  windowSeconds: number;
}

/** Preset rate limit configs */
export const RATE_LIMITS = {
  /** AI inference endpoints (transcribe, tts, describe-image, embed, enrich) */
  ai: { limit: 10000, windowSeconds: 3600 } as RateLimitConfig,    // 10000/hour
  /** Text generation (Llama) */
  generate: { limit: 60, windowSeconds: 3600 } as RateLimitConfig,  // 60/hour
  /** DB query proxy */
  dbQuery: { limit: 600, windowSeconds: 3600 } as RateLimitConfig,  // 600/hour
  /** Admin/backfill operations */
  admin: { limit: 10, windowSeconds: 3600 } as RateLimitConfig,     // 10/hour
};

/**
 * Check and increment rate limit counter.
 * Returns { allowed, remaining, resetAt } or throws if KV unavailable.
 */
export async function checkRateLimit(
  kv: KVNamespace | undefined,
  identifier: string,
  endpoint: string,
  config: RateLimitConfig
): Promise<{ allowed: boolean; remaining: number }> {
  if (!kv) {
    // If KV is not available, allow the request (fail open)
    return { allowed: true, remaining: config.limit };
  }

  const windowKey = Math.floor(Date.now() / 1000 / config.windowSeconds);
  const key = `rl:${endpoint}:${identifier}:${windowKey}`;

  const current = parseInt((await kv.get(key)) || "0");

  if (current >= config.limit) {
    return { allowed: false, remaining: 0 };
  }

  // Increment counter with TTL matching the window
  await kv.put(key, String(current + 1), { expirationTtl: config.windowSeconds });

  return { allowed: true, remaining: config.limit - current - 1 };
}

/**
 * Helper to return a 429 response with rate limit headers.
 */
export function rateLimitResponse(corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
    status: 429,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Retry-After": "60",
    },
  });
}
