// src/remote/relay-client.js — the box's DIAL-OUT relay client (E2E reachability
// Phase 3). The box holds an outbound connection to the managed rendezvous relay so
// it is reachable with NO inbound ports, NO Tailscale, NO Cloudflare Tunnel:
//   1. GET  <relay>/v1/challenge          → a single-use nonce
//   2. POST <relay>/relay/connect         → an ed25519 handle claim → a session token
//   3. loop: GET <relay>/relay/recv       → { reqId, frame:{path, body} } (long-poll)
//            → forward {path, body} to the LOCAL /e2e/* endpoint (loopback)
//            → POST <relay>/relay/reply    { reqId, frame:{status, body} }
//
// The relay carries only the phone's /e2e/handshake + /e2e/rpc requests — both
// E2E-sealed — so it never sees plaintext or keys (only {handle, /e2e/*, sid, ct}).
// The box constrains forwarding to those two paths (defence in depth).

import { claimMessage } from './managed-claim.js';

const E2E_PATHS = new Set(['/e2e/handshake', '/e2e/rpc']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{ relayBase:string, handle:string, identity:{publicKeyB64:string,sign:(m:string)=>string},
 *           restPort:number, fetchImpl?:Function, log?:Function, signal?:AbortSignal,
 *           reconnectDelayMs?:number, minCycleMs?:number }} opts
 *   `identity` = the box identity (sign + public key) — we never pass the master key here.
 * @returns {{ start:()=>void, stop:()=>void, runOnce:()=>Promise<'served'|'idle'|'reauth'> }}
 */
export function createRelayClient(opts = {}) {
  const { relayBase, handle, identity, restPort } = opts;
  if (!relayBase || !handle || !identity?.sign || !identity?.publicKeyB64 || !restPort) throw new Error('createRelayClient: relayBase, handle, identity(sign+publicKeyB64), restPort required');
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const log = opts.log || (() => {});
  const reconnectDelayMs = opts.reconnectDelayMs ?? 3000;
  const minCycleMs = opts.minCycleMs ?? 10; // floor so a fast/hostile relay can't drive a busy loop (review D1)
  let token = null;
  let stopped = false;

  async function connect() {
    const ch = await doFetch(`${relayBase}/v1/challenge`);
    if (!ch.ok) throw new Error(`relay challenge ${ch.status}`);
    const { nonce } = await ch.json();
    // Build the claim from the box identity (no master key in this module).
    const claim = { handle, publicKey: identity.publicKeyB64, nonce, signature: identity.sign(claimMessage('relay-connect', handle, nonce)) };
    const r = await doFetch(`${relayBase}/relay/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(claim) });
    if (!r.ok) throw new Error(`relay connect ${r.status}`);
    token = (await r.json()).token;
    log(`relay: connected as ${handle}`);
  }

  /** Forward one relayed request to the local /e2e/* endpoint; returns {status, body}. */
  async function forward(frame) {
    const path = String(frame?.path || '');
    if (!E2E_PATHS.has(path)) return { status: 403, body: '{"error":"path not allowed"}' };
    try {
      const r = await doFetch(`http://127.0.0.1:${restPort}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: typeof frame.body === 'string' ? frame.body : JSON.stringify(frame.body ?? {}),
      });
      return { status: r.status, body: await r.text() };
    } catch { return { status: 502, body: '{"error":"upstream"}' }; }
  }

  /** One recv→forward→reply cycle. Returns what happened (used by the loop + the gate). */
  async function runOnce() {
    if (!token) await connect();
    const r = await doFetch(`${relayBase}/relay/recv`, { headers: { authorization: `Bearer ${token}` } });
    if (r.status === 204) return 'idle';                 // long-poll timed out → re-poll
    if (r.status === 401) { token = null; return 'reauth'; } // session expired → reconnect
    if (!r.ok) throw new Error(`relay recv ${r.status}`);
    const { reqId, frame } = await r.json();
    const respFrame = await forward(frame);
    await doFetch(`${relayBase}/relay/reply`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ reqId, frame: respFrame }) });
    return 'served';
  }

  async function loop() {
    while (!stopped && !opts.signal?.aborted) {
      try {
        const outcome = await runOnce();
        // Back off on a session loss (a hostile relay 401-ing every recv would otherwise
        // force endless challenge+sign — review D2); a small floor otherwise so a relay
        // that answers instantly can't spin the loop hot (review D1).
        await sleep(outcome === 'reauth' ? reconnectDelayMs : minCycleMs);
      } catch (e) {
        log(`relay: ${e.message}; retry in ${reconnectDelayMs}ms`); token = null; await sleep(reconnectDelayMs);
      }
    }
  }

  return { start: () => { loop(); }, stop: () => { stopped = true; }, runOnce, _forward: forward };
}
