// src/federation/ssrf.js — SSRF guard for OUTBOUND federation fetches.
//
// `isPublicHost` (did.js) already rejects IP-literal/loopback HOSTS. This closes
// the remaining DNS-rebinding gap: a public HOSTNAME that resolves to a
// private/internal IP. We resolve the name and refuse if it maps to a
// private/loopback/link-local/ULA/CGNAT/metadata address.
//
// IPv6 is parsed to bytes (H4, 2026-06-11) so EVERY internal form is caught —
// not just the dotted IPv4-mapped string the old prefix-matcher handled. We
// reject: loopback (::1), unspecified (::), link-local (fe80::/10), ULA
// (fc00::/7), multicast (ff00::/8), IPv4-mapped (::ffff:0:0/96, any grouping —
// incl. ::ffff:7f00:1), IPv4-compat (::/96), NAT64 (64:ff9b::/96), 6to4
// (2002::/16 → embedded v4), and Teredo (2001:0::/32). Each v4-bearing form is
// re-checked against the v4 private/metadata ranges.
//
// RESIDUALS (tracked as MEDIUM in docs/SECURITY-REVIEW-2026-06-11.md, not closed
// here): (1) on resolution FAILURE we allow — a non-resolving name can't be
// fetched, and this keeps the shim-fetch tests working; (2) a TOCTOU window
// remains without full IP pinning (fetch re-resolves). Both want the undici
// IP-pinning agent to fully close. `lookup` is injectable for tests.

import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';

/** v4 octet array → is it private / loopback / link-local / CGNAT / metadata? */
function isPrivateV4(p) {
  if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;          // this-net, RFC1918-10, loopback
  if (p[0] === 169 && p[1] === 254) return true;                      // link-local (incl. 169.254.169.254 metadata)
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;          // RFC1918-172
  if (p[0] === 192 && p[1] === 168) return true;                      // RFC1918-192
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;         // CGNAT
  if (p[0] >= 224) return true;                                       // multicast/reserved/broadcast
  return false;
}

/** Expand a (net-validated) IPv6 string to 16 bytes, or null if unparseable. */
function ipv6ToBytes(s) {
  // Move an embedded IPv4 tail (e.g. ::ffff:1.2.3.4) into two hextets first.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!net.isIPv4(tail)) return null;
    const v = tail.split('.').map(Number);
    s = s.slice(0, lastColon + 1)
      + ((v[0] << 8) | v[1]).toString(16) + ':' + ((v[2] << 8) | v[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tailParts = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups;
  if (tailParts === null) {
    groups = head;
  } else {
    const missing = 8 - head.length - tailParts.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tailParts];
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const v = parseInt(groups[i] || '0', 16);
    if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
    bytes[i * 2] = v >> 8;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}

function allZero(b, start, end) {
  for (let i = start; i < end; i++) if (b[i] !== 0) return false;
  return true;
}

function isPrivateV6Bytes(b) {
  if (allZero(b, 0, 16)) return true;                                 // ::      unspecified
  if (allZero(b, 0, 15) && b[15] === 1) return true;                  // ::1     loopback
  if (b[0] === 0xff) return true;                                     // ff00::/8 multicast
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;           // fe80::/10 link-local
  if ((b[0] & 0xfe) === 0xfc) return true;                            // fc00::/7 ULA
  if (allZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff)          // ::ffff:0:0/96 IPv4-mapped
    return isPrivateV4([b[12], b[13], b[14], b[15]]);
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(b, 4, 12)) // 64:ff9b::/96 NAT64
    return isPrivateV4([b[12], b[13], b[14], b[15]]);
  if (b[0] === 0x20 && b[1] === 0x02)                                 // 2002::/16 6to4 → embedded v4
    return isPrivateV4([b[2], b[3], b[4], b[5]]);
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // 2001:0::/32 Teredo — block
  if (allZero(b, 0, 12)) return isPrivateV4([b[12], b[13], b[14], b[15]]); // ::/96 IPv4-compat (deprecated)
  return false;
}

/** Is `ip` a private / loopback / link-local / ULA / CGNAT / metadata address? */
export function isPrivateAddress(ip) {
  if (typeof ip !== 'string') return false;
  let s = ip.trim().replace(/^\[|\]$/g, '');             // strip brackets
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);                   // strip zone id
  if (net.isIPv4(s)) return isPrivateV4(s.split('.').map(Number));
  if (net.isIPv6(s)) {
    const b = ipv6ToBytes(s);
    if (!b) return true;                                 // valid-but-unparseable → fail closed (block)
    return isPrivateV6Bytes(b);
  }
  return false;                                          // not an IP literal
}

/**
 * Resolve `host` and throw if it does not resolve to at least one usable PUBLIC
 * address. FAIL-CLOSED: an unresolvable host throws (an attacker who can make the
 * guard's resolver fail must not get a free pass — the fetch's own resolver may
 * still succeed to a private IP). Returns the validated public addresses.
 * @param {string} host @param {{lookup?:Function}} [opts]
 * @returns {Promise<Array<{address:string, family:number}>>}
 */
export async function assertResolvesPublic(host, { lookup = dnsLookup } = {}) {
  let addrs;
  try { addrs = await lookup(host, { all: true }); }
  catch { throw new Error('refusing to fetch an unresolvable host'); } // fail-closed
  if (!addrs || !addrs.length) throw new Error('refusing to fetch an unresolvable host');
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new Error(`refusing to fetch a non-public address (${a.address})`);
  }
  return addrs;
}

/**
 * SSRF-safe fetch for an attacker-influenced URL. Resolves the host ONCE,
 * validates EVERY address as public (fail-closed via assertResolvesPublic), then
 * PINS the connection to the validated address through an undici dispatcher whose
 * connect-hook lookup re-checks isPrivateAddress — so the fetch cannot re-resolve
 * to a different (private) IP between the check and the connect (TOCTOU / DNS
 * rebinding). TLS still validates the cert against the original hostname (SNI is
 * unchanged; only the address is pinned).
 *
 * Test seam: when a non-default `fetch` is injected (the verify shim), the
 * resolve+validate guard still runs, then the injected fetch performs the call —
 * the undici pin (a connection-level guarantee) is exercised only on the real path.
 *
 * @param {string} url
 * @param {{lookup?:Function, fetch?:Function} & RequestInit} [opts]
 */
export async function safeFetch(url, { lookup = dnsLookup, fetch: fetchImpl = globalThis.fetch, ...init } = {}) {
  const host = new URL(url).hostname;
  const addrs = await assertResolvesPublic(host, { lookup }); // fail-closed, all-addresses
  if (fetchImpl !== globalThis.fetch) return fetchImpl(url, init); // injected test seam
  const pinned = addrs[0];
  const agent = new Agent({
    connect: {
      lookup: (_hostname, _options, cb) => {
        // Re-validate at connect time — defeats a resolver that changed its answer.
        if (isPrivateAddress(pinned.address)) return cb(new Error('refusing to connect to a non-public address'));
        cb(null, [{ address: pinned.address, family: pinned.family === 6 ? 6 : 4 }]); // undici connect lookup: (err, [{address,family}])
      },
    },
  });
  try {
    // Use undici's OWN fetch (not Node's bundled global fetch) so the npm-undici
    // Agent/dispatcher interface matches — a cross-version dispatcher throws
    // "invalid onRequestStart method" against the global fetch.
    return await undiciFetch(url, { ...init, dispatcher: agent });
  } finally {
    agent.close().catch(() => {});
  }
}
