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
  return ALLOWED_ORIGINS.has(origin) ? origin : [...ALLOWED_ORIGINS][0];
}

export function corsHeaders(request: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": corsOrigin(request),
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Token",
    "Vary": "Origin",
  };
}

export function corsPreflight(request: Request): Response {
  return new Response(null, {
    headers: {
      ...corsHeaders(request),
      "Access-Control-Max-Age": "86400",
    },
  });
}
