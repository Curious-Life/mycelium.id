// src/federation/relay-queue-client.js — the box's HTTP client for the zero-knowledge
// relay queue (mycelium-managed /v1/queue/*). Federation transport P3b.
//
// enqueue is UNAUTHENTICATED (sealed-sender — the relay never learns who sent); pull/ack
// are ed25519-claim-authed as the handle owner, using the SAME action-bound claim the
// control-plane verifies (src/remote/managed-claim.js). Every call goes through safeFetch
// (SSRF-guarded, IP-pinned, no-redirect, abort timeout) — the relay is a public host, but
// a hijacked DNS answer must never redirect our egress to an internal target.

import { safeFetch } from './ssrf.js';
import { claimMessage, CLAIM_VERSION } from '../remote/managed-claim.js';

const NONCE_TIMEOUT_MS = 5000;
const OP_TIMEOUT_MS = 10000;

/**
 * @param {object} o
 * @param {string} o.relayBaseUrl  e.g. https://connect.mycelium.id:8443 (the queue host)
 * @param {string} o.handle        our handle (the queue routes/authenticates on it)
 * @param {string} o.publicKeyB64  our ed25519 public key (must match the registry row)
 * @param {(bytes:string)=>string} o.sign  identity.sign — signs the claim message
 * @param {Function} [o.fetch]   injectable fetch (tests shim https→loopback)
 * @param {Function} [o.lookup]  injectable DNS resolver threaded into safeFetch
 */
export function createRelayQueueClient({ relayBaseUrl, handle, publicKeyB64, sign, fetch: fetchImpl = globalThis.fetch, lookup }) {
  if (!relayBaseUrl) throw new TypeError('relay-queue-client: relayBaseUrl required');
  if (!handle || !publicKeyB64 || typeof sign !== 'function') throw new TypeError('relay-queue-client: handle, publicKeyB64, sign required');
  const base = String(relayBaseUrl).replace(/\/$/, '');

  async function post(path, body, timeoutMs = OP_TIMEOUT_MS) {
    return safeFetch(`${base}${path}`, {
      lookup, fetch: fetchImpl, method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function nonce() {
    const res = await safeFetch(`${base}/v1/queue/nonce`, { lookup, fetch: fetchImpl, redirect: 'manual', signal: AbortSignal.timeout(NONCE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`queue nonce ${res.status}`);
    const n = (await res.json())?.nonce;
    if (typeof n !== 'string' || !n) throw new Error('queue nonce missing');
    return n;
  }

  // The action-bound claim the control-plane verifies (publicKey must equal the
  // registry row's public_key; signature over claimMessage; single-use nonce).
  function claim(action, n) {
    return { v: CLAIM_VERSION, action, handle, publicKey: publicKeyB64, nonce: n, signature: sign(claimMessage(action, handle, n)) };
  }

  return {
    /** Drop an opaque envelope into a recipient handle's inbox. Unauthenticated. */
    async enqueue(recipientHandle, envelope, ttlMs) {
      const res = await post('/v1/queue/enqueue', { recipient: recipientHandle, envelope, ...(ttlMs ? { ttlMs } : {}) });
      if (!res.ok) throw new Error(`enqueue ${res.status}`);
      return res.json();
    },
    /** Pull our own pending envelopes (claim-authed). Returns [{id, envelope, enqueued_at}]. */
    async pull() {
      const res = await post('/v1/queue/pull', claim('queue-pull', await nonce()));
      if (!res.ok) throw new Error(`pull ${res.status}`);
      const envelopes = (await res.json())?.envelopes;
      return Array.isArray(envelopes) ? envelopes : [];
    },
    /** Ack (delete) pulled envelopes by id (claim-authed; scoped to our own mail). */
    async ack(ids) {
      if (!Array.isArray(ids) || ids.length === 0) return { acked: 0 };
      const res = await post('/v1/queue/ack', { ...claim('queue-ack', await nonce()), ids });
      if (!res.ok) throw new Error(`ack ${res.status}`);
      return res.json();
    },
  };
}
