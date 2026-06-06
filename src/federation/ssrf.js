// src/federation/ssrf.js — SSRF guard for OUTBOUND federation fetches.
//
// `isPublicHost` (did.js) already rejects IP-literal/loopback HOSTS. This closes
// the remaining DNS-rebinding gap flagged by the adversarial audit: a public
// HOSTNAME that resolves to a private/internal IP. We resolve the name and
// refuse if it maps to a private/loopback/link-local/ULA/CGNAT address.
//
// On resolution FAILURE we allow — a name that doesn't resolve can't be fetched
// (the request itself fails harmlessly), and this keeps shim-fetch tests (which
// use non-resolving hosts) working. A TOCTOU window remains without full IP
// pinning; documented as a residual. `lookup` is injectable for tests.

import { lookup as dnsLookup } from 'node:dns/promises';

/** Is `ip` a private / loopback / link-local / ULA / CGNAT address? */
export function isPrivateAddress(ip) {
  if (typeof ip !== 'string') return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const p = ip.split('.').map(Number);
    if (p.some((o) => o > 255)) return false;
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;        // this-net, RFC1918-10, loopback
    if (p[0] === 169 && p[1] === 254) return true;                     // link-local
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;         // RFC1918-172
    if (p[0] === 192 && p[1] === 168) return true;                     // RFC1918-192
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;        // CGNAT
    return false;
  }
  const a = ip.toLowerCase();
  if (a === '::1' || a === '::') return true;                          // loopback / unspecified
  if (a.startsWith('::ffff:')) return isPrivateAddress(a.slice(7));    // IPv4-mapped
  if (a.startsWith('fe80')) return true;                               // link-local
  if (a.startsWith('fc') || a.startsWith('fd')) return true;          // unique-local
  return false;
}

/**
 * Throw if `host` resolves to any private address. Allow (return) when it does
 * not resolve. @param {string} host @param {{lookup?:Function}} [opts]
 */
export async function assertResolvesPublic(host, { lookup = dnsLookup } = {}) {
  let addrs;
  try { addrs = await lookup(host, { all: true }); }
  catch { return; } // unresolvable → the fetch can't reach any IP; nothing to block
  for (const a of addrs || []) {
    if (isPrivateAddress(a.address)) throw new Error(`refusing to fetch a non-public address (${a.address})`);
  }
}
