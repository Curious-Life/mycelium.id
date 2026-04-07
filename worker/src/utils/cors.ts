// Configure with your portal domain(s) via ALLOWED_ORIGINS env var (comma-separated)
// Falls back to localhost for development
let _allowedOrigins: Set<string> | null = null;

function getAllowedOrigins(env?: any): Set<string> {
  if (_allowedOrigins) return _allowedOrigins;
  const defaults = ["http://localhost:5173", "http://localhost:4173"];
  const extra = (env?.ALLOWED_ORIGINS || "").split(",").map((s: string) => s.trim()).filter(Boolean);
  _allowedOrigins = new Set([...defaults, ...extra]);
  return _allowedOrigins;
}

// For backward compat — pre-initialize without env
const ALLOWED_ORIGINS = getAllowedOrigins();

export function corsOrigin(request: Request): string {
  const origin = request.headers.get("Origin") || "";
  // Only reflect origin if it's in the allow-list. Never fall back to a default.
  return ALLOWED_ORIGINS.has(origin) ? origin : "";
}

/** Standard security headers applied to every response. */
export function securityHeaders(): Record<string, string> {
  return {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}

export function corsHeaders(request: Request): Record<string, string> {
  const origin = corsOrigin(request);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Token",
    "Vary": "Origin",
    ...securityHeaders(),
  };
  // Only set Allow-Origin if origin is in the whitelist
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export function corsPreflight(request: Request): Response {
  return new Response(null, {
    headers: {
      ...corsHeaders(request),
      "Access-Control-Max-Age": "86400",
    },
  });
}
