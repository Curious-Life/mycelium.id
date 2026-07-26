// src/federation/transport.js — the federation TRANSPORT seam.
//
// P1 of the federation redesign (the federation-transport redesign):
// extract the ONE place that resolves a peer's endpoint + frames and sends a SIGNED
// federation envelope, so a second transport (relay store-and-forward, P3) can slot in
// behind the same interface. This is a BEHAVIOR-NEUTRAL extraction of the two closures
// that used to live inline in src/db/connections.js (resolveFederationEndpoint +
// signedFederationPost) plus the shared signed-POST body of the request/response paths
// (presence, shared-content). Response verification stays with the caller — the transport
// only owns the wire (resolve → frame → POST), never the trust decision on the reply.
//
// SECURITY (unchanged from the inline version — this is the egress chokepoint):
//  - Every fetch goes through safeFetch (SSRF: resolve-once, validate-every-address
//    fail-closed, pin the connection — no DNS-rebinding a peer host to a private IP).
//  - resolveEndpoint binds the returned endpoint to the WebFinger domain (confused-deputy
//    guard: a peer cannot point our SIGNED POST at an unrelated host), https-only.
//  - frame() signs EXACTLY the canonical bytes it sends (the sign.js wire contract); the
//    peer verifies the raw bytes. Unsigned only when sign+did are absent (remote off) —
//    the request/response callers guard on sign+did before ever calling request().

import { canonicalize } from './sign.js';
import { safeFetch } from './ssrf.js';

const WEBFINGER_TIMEOUT_MS = 5000;
const FEDERATION_POST_TIMEOUT_MS = 10000;
// A federation domain label: lowercase host, no scheme, no path (WebFinger authority).
const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * Build the direct-HTTP federation transport. Deps mirror what the two inline closures
 * closed over in connections.js, so wiring is unchanged.
 * @param {object} deps
 * @param {() => string} [deps.sign]  sign(canonicalBytes) → base64url Ed25519 sig (absent = remote off)
 * @param {() => string} [deps.did]   () → this box's did (absent = remote off)
 * @param {Function} [deps.lookup]    injectable DNS resolver threaded into safeFetch (tests stub it)
 * @param {Function} [deps.fetch]     injectable fetch (tests shim https→loopback)
 */
export function createDirectHttpTransport({ sign, did, lookup, fetch: fetchImpl = globalThis.fetch } = {}) {
  // Resolve a remote instance's federation endpoint via WebFinger (SSRF-guarded:
  // HTTPS-only, no redirect, abort timeout). Shared by request + response + presence.
  async function resolveEndpoint(remoteDomain, remoteHandle) {
    if (!DOMAIN_RE.test(remoteDomain)) throw new Error('Invalid domain');
    const webfingerUrl = `https://${remoteDomain}/.well-known/webfinger?resource=acct:${remoteHandle}@${remoteDomain}`;
    // safeFetch resolves once, validates every address (fail-closed), and pins the
    // connection — no DNS-rebinding the WebFinger host to a private IP.
    const wfRes = await safeFetch(webfingerUrl, { lookup, fetch: fetchImpl, signal: AbortSignal.timeout(WEBFINGER_TIMEOUT_MS), redirect: 'manual' });
    if (!wfRes.ok) throw new Error(`WebFinger failed: ${wfRes.status}`);
    const wf = await wfRes.json();
    const fedLink = wf.links?.find((l) => l.rel?.includes('federation'));
    if (!fedLink?.href) throw new Error('No federation endpoint');
    // Bind the endpoint to the WebFinger domain: a peer must not be able to point
    // our SIGNED POST at an unrelated host (confused-deputy SSRF). https-only,
    // host must equal the domain or be a subdomain of it.
    let u;
    try { u = new URL(fedLink.href); } catch { throw new Error('Invalid federation endpoint'); }
    if (u.protocol !== 'https:') throw new Error('federation endpoint must be https');
    if (u.hostname !== remoteDomain && !u.hostname.endsWith(`.${remoteDomain}`)) {
      throw new Error('federation endpoint host does not match the instance domain');
    }
    return fedLink.href;
  }

  // Frame an envelope for the wire: the ONE place the X-Myc-Did/X-Myc-Sig contract is
  // built. Signs the canonical bytes when sign+did are wired; unsigned JSON otherwise
  // (remote off — only the fire-and-forget send() path reaches here unsigned).
  function frame(body) {
    if (sign && did) {
      const bodyStr = canonicalize(body);
      return { bodyStr, headers: { 'Content-Type': 'application/json', 'X-Myc-Did': did(), 'X-Myc-Sig': sign(bodyStr) } };
    }
    return { bodyStr: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } };
  }

  // Fire-and-forget signed POST to <endpoint>/<subpath>. (= old signedFederationPost)
  // safeFetch re-resolves + validates + pins the endpoint host (the SIGNED POST must
  // never reach an internal target even if the resolve above passed a public host).
  async function send(endpoint, subpath, body) {
    const url = `${endpoint.replace(/\/$/, '')}/${subpath}`;
    const { bodyStr, headers } = frame(body);
    await safeFetch(url, { lookup, fetch: fetchImpl, method: 'POST', headers, body: bodyStr, redirect: 'manual', signal: AbortSignal.timeout(FEDERATION_POST_TIMEOUT_MS) });
  }

  // Signed POST that RETURNS the raw Response, so the caller can verify the SIGNED reply
  // (presence / shared-content read + verify x-myc-did/x-myc-sig over res.text()). The
  // caller builds the full URL (it already has the resolved endpoint) and may set a
  // shorter timeout (presence uses a tight per-peer budget). The transport does NOT
  // read or trust the response — that stays with the caller.
  //
  // CONTRACT: `url` MUST be derived from a resolveEndpoint() result (which binds the host
  // to the WebFinger domain). safeFetch re-pins the host regardless, but callers must not
  // pass an attacker-influenced URL here — keep this invariant when adding P3 callers.
  async function request(url, body, { timeoutMs = FEDERATION_POST_TIMEOUT_MS } = {}) {
    const { bodyStr, headers } = frame(body);
    return safeFetch(url, { lookup, fetch: fetchImpl, method: 'POST', headers, body: bodyStr, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  }

  // `frame` is intentionally NOT exported: framing must only ever happen on a path that
  // then goes through safeFetch (send/request). Keeping it private stops a future
  // transport (P3/relay) from growing a frame-without-SSRF egress.
  return { resolveEndpoint, send, request };
}
