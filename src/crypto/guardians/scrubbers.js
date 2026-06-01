/**
 * Privacy-safe context scrubbers for guardian deny events.
 *
 * Every field that lands in the ring buffer passes through a scrubber.
 * Scrubbers ONLY return values that are safe to log, to ship to the
 * fleet control plane, and to display in the operator dashboard.
 *
 * Rules:
 *   - Never return raw IPs. IPv4 → /24, IPv6 → /48.
 *   - Never return tokens, session IDs, cookies, Authorization headers.
 *   - Never return user IDs, email addresses, or display names.
 *   - Never return request bodies.
 *   - Path is allowed (it's in logs anyway).
 *   - Method is allowed.
 *   - Header NAMES are allowed (e.g., whether Authorization is present),
 *     values are not.
 */

/** IPv4 → /24 prefix, IPv6 → /48 prefix, anything else → 'redacted'. */
export function ipPrefix(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const trimmed = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const v4 = trimmed.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (trimmed.includes(':')) {
    const groups = trimmed.split(':').filter(Boolean).slice(0, 3);
    if (groups.length >= 2) return `${groups.join(':')}::/48`;
  }
  return 'redacted';
}

/** Which well-known headers were present (names only, no values). */
export function headerNames(req) {
  if (!req?.headers) return [];
  const interesting = [
    'authorization', 'x-tenant-id', 'x-fleet-vps', 'x-fleet-signature',
    'x-csrf-token', 'x-worker-secret', 'x-agent-id', 'origin', 'referer',
  ];
  return interesting.filter(h => req.headers[h]);
}

/** Principal kind only (never the ID — IDs can leak). */
export function principalKind(principal) {
  if (!principal || typeof principal !== 'object') return 'anonymous';
  return principal.kind || 'unknown';
}

/** Default scrubber — works for most guardian kinds. */
export function defaultScrub(ctx) {
  const out = {};
  if (ctx?.ip) out.ip = ipPrefix(ctx.ip);
  if (ctx?.method) out.method = String(ctx.method).slice(0, 8);
  if (ctx?.path) out.path = String(ctx.path).slice(0, 200);
  if (ctx?.principal_kind) out.principal_kind = String(ctx.principal_kind).slice(0, 32);
  if (ctx?.headers_present) out.headers_present = ctx.headers_present;
  return out;
}

/** Perimeter guardians also track header presence. */
export function perimeterScrub(ctx) {
  const out = defaultScrub(ctx);
  if (ctx?.request) out.headers_present = headerNames(ctx.request);
  return out;
}

/** Tenant guardians — expose which tenant boundary was crossed (IDs replaced with short hashes). */
export function tenantScrub(ctx) {
  const out = defaultScrub(ctx);
  // Never log real tenant IDs. Hash to a short stable fingerprint (first 6 hex chars).
  if (ctx?.expected_tenant) out.expected_tenant = shortHash(ctx.expected_tenant);
  if (ctx?.actual_tenant) out.actual_tenant = shortHash(ctx.actual_tenant);
  return out;
}

/** Scope guardians — scopes themselves are non-secret strings, safe to log. */
export function scopeScrub(ctx) {
  const out = defaultScrub(ctx);
  if (Array.isArray(ctx?.allowed_scopes)) out.allowed_scopes = ctx.allowed_scopes;
  if (ctx?.envelope_scope) out.envelope_scope = String(ctx.envelope_scope).slice(0, 32);
  return out;
}

/** Protocol guardians — mostly about HTTP shape, default scrub is enough. */
export const protocolScrub = defaultScrub;

/** Sanitization guardians — they run on outbound responses, no inbound ctx to scrub. */
export function sanitizationScrub(ctx) {
  const out = {};
  if (ctx?.path) out.path = String(ctx.path).slice(0, 200);
  if (ctx?.stripped_fields) out.stripped_fields = Array.isArray(ctx.stripped_fields) ? ctx.stripped_fields.slice(0, 10) : [];
  return out;
}

/** Dispatch by kind. */
export function scrubByKind(kind, ctx) {
  switch (kind) {
    case 'perimeter': return perimeterScrub(ctx);
    case 'tenant': return tenantScrub(ctx);
    case 'scope': return scopeScrub(ctx);
    case 'protocol': return protocolScrub(ctx);
    case 'sanitization': return sanitizationScrub(ctx);
    default: return defaultScrub(ctx);
  }
}

/** Stable 6-char hex fingerprint of a string. Not cryptographic — just a label. */
function shortHash(s) {
  const str = String(s);
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}
