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

import { safeFetch } from './ssrf.js';

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
// X25519 keyAgreement (ENCRYPTION) public key — multicodec x25519-pub = 0xec 0x01.
// Kept SEPARATE from the Ed25519 SIGNING key: the box derives an independent X25519
// keypair (HKDF info "mycelium-keyagreement-v1") rather than the Ed25519↔X25519
// birational conversion the W3C did:key spec warns against (key separation). Used
// by the E2E shared-spaces "Space Key Lockbox" (docs/SHARED-SPACES-E2E-DESIGN-2026-06-30.md).
const X25519_MULTICODEC = Buffer.from([0xec, 0x01]);

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

export { ED25519_MULTICODEC, X25519_MULTICODEC };

/** base64url public key → W3C publicKeyMultibase (z-base58btc). Default codec is
 *  Ed25519 (0xed01) for backward-compat; pass X25519_MULTICODEC for keyAgreement keys. */
export function toMultibase(publicKeyB64, multicodec = ED25519_MULTICODEC) {
  const raw = Buffer.from(publicKeyB64, 'base64url');
  return 'z' + b58encode(Buffer.concat([multicodec, raw]));
}

/** publicKeyMultibase → base64url public key (inverse of toMultibase). Validates the
 *  multicodec matches `expected` (default Ed25519) and FAILS CLOSED on mismatch — so a
 *  keyAgreement (X25519) key can never be mistaken for a signing (Ed25519) key. */
export function fromMultibase(mb, expected = ED25519_MULTICODEC) {
  if (typeof mb !== 'string' || mb[0] !== 'z') throw new Error('only z-base58btc multibase is supported');
  const decoded = b58decode(mb.slice(1));
  if (decoded[0] !== expected[0] || decoded[1] !== expected[1]) {
    const hex = (b) => b.toString(16).padStart(2, '0');
    throw new Error(`multikey codec mismatch: expected 0x${hex(expected[0])}${hex(expected[1])}`);
  }
  // Both Ed25519 and X25519 raw public keys are exactly 32 bytes. Reject a
  // truncated/oversized payload BEFORE it reaches signature-verify or ECDH (defense
  // in depth; closes the latent gap on resolveKeyAgreementKey's X25519 path before
  // BU-KEY builds on it — BU-RESOLVE review LOW-1).
  if (decoded.length - 2 !== 32) throw new Error('multikey payload is not a 32-byte public key');
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
 * @param {string} [keyAgreementPublicKeyB64]  identity.keyAgreementPublicKeyB64 —
 *   the box's X25519 ENCRYPTION key. When present, published as #key-enc +
 *   keyAgreement so peers can seal the space CEK to this member (E2E spaces).
 * @returns {object|null}  null when host is missing/invalid (fail closed)
 */
export function buildDidDocument(host, publicKeyB64, matrixId, keyAgreementPublicKeyB64) {
  if (!host || !HOST_RE.test(host) || !publicKeyB64) return null;
  const did = `did:web:${host}`;
  const vm = `${did}#key-1`;
  const service = [{ id: `${did}#federation`, type: 'MyceliumFederation', serviceEndpoint: `https://${host}/federation` }];
  if (matrixId && /^@[^:\s]+:[^\s]+$/.test(matrixId)) {
    service.push({ id: `${did}#matrix`, type: 'MatrixHomeserver', serviceEndpoint: `matrix:u/${matrixId.slice(1)}` });
  }
  // verificationMethod[0] is ALWAYS the Ed25519 signing key (#key-1), so an
  // un-upgraded peer running the old index-[0] resolver still selects the SIGNING
  // key — no deploy-ordering footgun even before peers ship BU-RESOLVE.
  const verificationMethod = [{ id: vm, type: 'Multikey', controller: did, publicKeyMultibase: toMultibase(publicKeyB64) }];
  const doc = {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: did,
    verificationMethod,
    authentication: [vm],
    assertionMethod: [vm],
    service,
  };
  // Publish the X25519 keyAgreement (encryption) key for E2E shared spaces, when the
  // box advertises one. Appended AFTER #key-1, in its own keyAgreement relationship.
  if (keyAgreementPublicKeyB64) {
    const encVm = `${did}#key-enc`;
    verificationMethod.push({ id: encVm, type: 'Multikey', controller: did, publicKeyMultibase: toMultibase(keyAgreementPublicKeyB64, X25519_MULTICODEC) });
    doc.keyAgreement = [encVm];
  }
  return doc;
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
  const res = await safeFetch(`https://${host}/.well-known/did.json`, { lookup, fetch, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
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
/**
 * Select a verification method from a DID document by verification RELATIONSHIP
 * (e.g. 'assertionMethod'/'authentication' = signing, 'keyAgreement' = encryption),
 * NOT by array index. Returns the resolved VM object (with publicKeyMultibase) or
 * null (fail-closed). The relationship array may hold VM id strings OR embedded VMs.
 *
 * SECURITY: never select by `verificationMethod[0]`. Once a box publishes a second
 * key (the X25519 #key-enc), an index-based pick could hand the WRONG key to the
 * WRONG consumer — e.g. an X25519 key to Ed25519 signature verification (the
 * 2026-06-30 resolveDidKey bug). Relationship-based selection is the fix.
 */
export function selectVerificationMethod(doc, relationship) {
  const rel = doc?.[relationship];
  if (!Array.isArray(rel) || rel.length === 0) return null;
  const ref = rel[0];
  if (ref && typeof ref === 'object' && ref.publicKeyMultibase) return ref; // embedded VM
  const vms = Array.isArray(doc?.verificationMethod) ? doc.verificationMethod : [];
  return vms.find((vm) => vm && vm.id === ref && vm.publicKeyMultibase) || null;
}

/** Fetch + SSRF-validate a peer's did:web document (shared by the resolvers). */
async function fetchDidDocument(did, { fetch = globalThis.fetch, timeoutMs = RESOLVE_TIMEOUT_MS, lookup } = {}) {
  const m = DID_WEB_RE.exec(String(did || ''));
  if (!m) throw new Error('unsupported or malformed did:web');
  const host = m[1];
  if (!isPublicHost(host)) throw new Error('did:web host is not a public domain'); // SSRF: no IP-literal / loopback
  // safeFetch resolves once, validates every address (fail-closed), and PINS the
  // connection to the validated IP — no DNS-rebinding to a private/internal target.
  const res = await safeFetch(`https://${host}/.well-known/did.json`, {
    lookup, fetch,
    redirect: 'manual', // SSRF: never follow a peer's redirect to an internal address
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`did document fetch failed: ${res.status}`);
  const doc = await res.json();
  if (doc.id !== did) throw new Error('did document id mismatch');
  return doc;
}

/** Resolve a peer's Ed25519 SIGNING key (for federation signature verification).
 *  Selects by the assertionMethod/authentication relationship — never index [0] —
 *  and validates the Ed25519 multicodec, so a published X25519 key can never be
 *  returned here. Returns the base64url public key. */
export async function resolveDidKey(did, opts = {}) {
  const doc = await fetchDidDocument(did, opts);
  const vm = selectVerificationMethod(doc, 'assertionMethod') || selectVerificationMethod(doc, 'authentication');
  if (!vm?.publicKeyMultibase) throw new Error('did document has no ed25519 signing key');
  return fromMultibase(vm.publicKeyMultibase, ED25519_MULTICODEC);
}

/** Resolve a peer's X25519 keyAgreement (ENCRYPTION) key — for sealing the space
 *  Content Encryption Key to that member (E2E "Space Key Lockbox"). Selects by the
 *  keyAgreement relationship + validates the X25519 multicodec; FAILS CLOSED if the
 *  peer publishes no keyAgreement key (an un-upgraded peer → no E2E space with them). */
export async function resolveKeyAgreementKey(did, opts = {}) {
  const doc = await fetchDidDocument(did, opts);
  const vm = selectVerificationMethod(doc, 'keyAgreement');
  if (!vm?.publicKeyMultibase) throw new Error('did document has no X25519 keyAgreement key');
  return fromMultibase(vm.publicKeyMultibase, X25519_MULTICODEC);
}
