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

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/; // DNS host: no scheme, port, IP-literal, or underscore
const DID_WEB_RE = /^did:web:([a-z0-9]([a-z0-9.-]*[a-z0-9])?)$/;
const RESOLVE_TIMEOUT_MS = 5000;

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
 * @returns {object|null}  null when host is missing/invalid (fail closed)
 */
export function buildDidDocument(host, publicKeyB64) {
  if (!host || !HOST_RE.test(host) || !publicKeyB64) return null;
  const did = `did:web:${host}`;
  const vm = `${did}#key-1`;
  return {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: did,
    verificationMethod: [{ id: vm, type: 'Multikey', controller: did, publicKeyMultibase: toMultibase(publicKeyB64) }],
    authentication: [vm],
    assertionMethod: [vm],
    service: [{ id: `${did}#federation`, type: 'MyceliumFederation', serviceEndpoint: `https://${host}/federation` }],
  };
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
export async function resolveDidKey(did, { fetch = globalThis.fetch, timeoutMs = RESOLVE_TIMEOUT_MS } = {}) {
  const m = DID_WEB_RE.exec(String(did || ''));
  if (!m) throw new Error('unsupported or malformed did:web');
  const host = m[1];
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
