// src/federation/did.js — did:web + WebFinger documents and resolution for the
// inter-instance federation protocol (Tier-0).
//
// The box's ed25519 identity (src/identity/identity.js) is published as a
// did:web document at  https://<host>/.well-known/did.json  for the instance
// host (e.g. did:web:alice.mycelium.id), with the public key encoded as a
// W3C `publicKeyMultibase` (z-base58btc, multicodec 0xed01 ed25519-pub) — the
// standard did:web/did:key form. WebFinger advertises the federation endpoint
// the dormant connections.js looks for (a link whose rel includes "federation").
//
// resolveDidKey() fetches a peer's did:web key for inbound verification, behind
// the same SSRF posture as src/db/connections.js (HTTPS-only, no redirects, host
// allowlist regex, abort timeout).
//
// Pure protocol — no storage. Network only via the injected/global fetch in
// resolveDidKey().

import { assertResolvesPublic } from './ssrf.js';

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/; // DNS host: no scheme, port, or underscore
const DID_WEB_RE = /^did:web:([a-z0-9]([a-z0-9.-]*[a-z0-9])?)$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const RESOLVE_TIMEOUT_MS = 5000;

/**
 * Is `host` a public registrable domain we'll make an outbound request to?
 * Rejects IPv4 literals and loopback/internal names so an attacker-controlled
 * did:web (the X-Myc-Did header) can't drive SSRF probes of internal addresses.
 * (Public-name → private-IP rebinding is out of scope; HTTPS-only + no-redirect
 * already bound the surface.)
 */
export function isPublicHost(host) {
  if (!host || !HOST_RE.test(host)) return false;
  if (IPV4_RE.test(host)) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  return true;
}

/** Extract the host of a `did:web:<host>` identifier, or null. */
export function didWebHost(did) {
  const m = DID_WEB_RE.exec(String(did || ''));
  return m ? m[1] : null;
}

// ── base58btc + multibase (multicodec ed25519-pub = 0xed 0x01) ───────────────
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ED25519_MULTICODEC = Buffer.from([0xed, 0x01]);

export function b58encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

export function b58decode(str) {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  const bytes = [0];
  for (let i = zeros; i < str.length; i++) {
    let carry = B58.indexOf(str[i]);
    if (carry < 0) throw new Error('invalid base58 character');
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const out = Buffer.alloc(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + bytes.length - 1 - i] = bytes[i];
  return out;
}

/** base64url ed25519 public key → W3C publicKeyMultibase (z-base58btc, 0xed01). */
export function toMultibase(publicKeyB64) {
  const raw = Buffer.from(publicKeyB64, 'base64url');
  return 'z' + b58encode(Buffer.concat([ED25519_MULTICODEC, raw]));
}

/** publicKeyMultibase → base64url ed25519 public key (inverse of toMultibase). */
export function fromMultibase(mb) {
  if (typeof mb !== 'string' || mb[0] !== 'z') throw new Error('only z-base58btc multibase is supported');
  const decoded = b58decode(mb.slice(1));
  if (decoded[0] !== 0xed || decoded[1] !== 0x01) throw new Error('not an ed25519 multikey');
  return Buffer.from(decoded.subarray(2)).toString('base64url');
}

// ── documents ────────────────────────────────────────────────────────────────

/**
 * Build the instance did:web document for `host`.
 * @param {string} host  the public host (e.g. "alice.mycelium.id")
 * @param {string} publicKeyB64  identity.publicKeyB64
 * @param {string} [matrixId]  the box's Matrix MXID (e.g. "@alice:hs") — when
 *   present, advertised as a `#matrix` service so peers can discover where to
 *   invite this box for Phase-B shared-space rooms.
 * @returns {object|null}  null when host is missing/invalid (fail closed)
 */
export function buildDidDocument(host, publicKeyB64, matrixId) {
  if (!host || !HOST_RE.test(host) || !publicKeyB64) return null;
  const did = `did:web:${host}`;
  const vm = `${did}#key-1`;
  const service = [{ id: `${did}#federation`, type: 'MyceliumFederation', serviceEndpoint: `https://${host}/federation` }];
  if (matrixId && /^@[^:\s]+:[^\s]+$/.test(matrixId)) {
    service.push({ id: `${did}#matrix`, type: 'MatrixHomeserver', serviceEndpoint: `matrix:u/${matrixId.slice(1)}` });
  }
  return {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: did,
    verificationMethod: [{ id: vm, type: 'Multikey', controller: did, publicKeyMultibase: toMultibase(publicKeyB64) }],
    authentication: [vm],
    assertionMethod: [vm],
    service,
  };
}

/**
 * Resolve a peer's Matrix MXID from their did:web document's `#matrix` service
 * (the Phase-B invite anchor). SSRF-guarded like resolveDidKey. Returns the MXID
 * (e.g. "@bob:hs") or null when the peer advertises none.
 * @param {string} did  a did:web identifier
 * @param {object} [opts] @returns {Promise<string|null>}
 */
export async function resolveMatrixService(did, { fetch = globalThis.fetch, timeoutMs = RESOLVE_TIMEOUT_MS, lookup } = {}) {
  const m = DID_WEB_RE.exec(String(did || ''));
  if (!m) return null;
  const host = m[1];
  if (!isPublicHost(host)) return null;
  await assertResolvesPublic(host, { lookup });
  const res = await fetch(`https://${host}/.well-known/did.json`, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return null;
  const doc = await res.json();
  if (doc.id !== did) return null; // no key confusion
  const svc = (doc.service || []).find((s) => s.id === `${did}#matrix` || s.type === 'MatrixHomeserver');
  const ep = svc?.serviceEndpoint;
  if (typeof ep !== 'string') return null;
  const mx = ep.replace(/^matrix:u\//, '@'); // "matrix:u/bob:hs" → "@bob:hs"
  return /^@[^:\s]+:[^\s]+$/.test(mx) ? mx : null;
}

/**
 * Build a WebFinger response for our own acct, or null for a foreign/invalid
 * resource (fail closed — we only describe ourselves).
 * @param {string} host    the public host
 * @param {string} handle  the local handle (acct local-part)
 * @param {string} resource  the ?resource= query value
 */
export function buildWebfinger(host, handle, resource) {
  if (!host || !HOST_RE.test(host) || !handle) return null;
  const subject = `acct:${handle}@${host}`;
  if (resource !== subject) return null;
  const did = `did:web:${host}`;
  return {
    subject,
    links: [
      { rel: 'self', type: 'application/did+json', href: `https://${host}/.well-known/did.json` },
      { rel: 'http://webfinger.net/rel/profile-page', href: `https://${host}/` },
      // The dormant connections.js matches a link whose rel INCLUDES "federation":
      { rel: 'https://mycelium.id/rel/federation', href: `https://${host}/federation` },
    ],
  };
}

/**
 * Resolve a peer's did:web ed25519 key (base64url) for inbound verification.
 * SSRF-guarded: HTTPS-only, host allowlist, no redirect following, abort timeout.
 * @param {string} did  a did:web identifier
 * @param {object} [opts]
 * @param {(url:string, init?:object)=>Promise<any>} [opts.fetch]
 * @returns {Promise<string>}  the base64url public key
 * @throws on unresolvable / malformed / unsafe input
 */
export async function resolveDidKey(did, { fetch = globalThis.fetch, timeoutMs = RESOLVE_TIMEOUT_MS, lookup } = {}) {
  const m = DID_WEB_RE.exec(String(did || ''));
  if (!m) throw new Error('unsupported or malformed did:web');
  const host = m[1];
  if (!isPublicHost(host)) throw new Error('did:web host is not a public domain'); // SSRF: no IP-literal / loopback
  await assertResolvesPublic(host, { lookup }); // SSRF: no DNS-rebinding to a private IP
  const res = await fetch(`https://${host}/.well-known/did.json`, {
    redirect: 'manual', // SSRF: never follow a peer's redirect to an internal address
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`did document fetch failed: ${res.status}`);
  const doc = await res.json();
  if (doc.id !== did) throw new Error('did document id mismatch');
  const mb = doc.verificationMethod?.[0]?.publicKeyMultibase;
  if (!mb) throw new Error('did document has no ed25519 verification method');
  return fromMultibase(mb);
}
