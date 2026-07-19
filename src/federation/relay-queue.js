// src/federation/relay-queue.js — the RelayQueue TRANSPORT (federation P3b).
//
// The store-and-forward counterpart to the direct-HTTP transport (transport.js). It
// seals a signaling payload into an envelope (envelope.js) and drops it in the peer's
// relay inbox; and it pulls, verifies, opens, and acks envelopes addressed to us. A box
// therefore needs NO inbound reachability — only outbound access to the relay — which is
// what makes an offline / NAT'd / mid-boot peer's connect land (the 502 failure class).
//
// SEPARATION OF CONCERNS: this owns seal/open + enqueue/pull/ack orchestration only.
//   - DURABLE replay defense (dedup on (sender_did, nonce) + monotonic sender_seq) and
//     ts-freshness are the CALLER's job — enforced in the pull loop (P4). receive()
//     returns the signed nonce/ts/senderSeq so the caller can dedup; it does NOT itself.
//   - WHICH transport to use per peer (relay vs direct) is the capability chooser (P5).

import { randomUUID } from 'node:crypto';
import { sealEnvelope, openEnvelope } from './envelope.js';

/**
 * @param {object} o
 * @param {string} o.selfDid    our did (recipients verify it; we reject envelopes not to us)
 * @param {object} o.identity   our createIdentity() — the X25519 unseal
 * @param {(bytes:string)=>string} o.sign  identity.sign — Ed25519 over the envelope
 * @param {(did:string)=>Promise<string>|string} o.resolvePeerKey  sender did → their verify key
 * @param {{enqueue:Function, pull:Function, ack:Function}} o.client  relay-queue-client
 * @param {(peerDid:string)=>number} [o.nextSeq]  monotonic per-peer send seq (P4 makes it durable)
 */
export function createRelayQueueTransport({ selfDid, identity, sign, resolvePeerKey, client, nextSeq }) {
  if (!selfDid || !identity || typeof sign !== 'function' || typeof resolvePeerKey !== 'function' || !client) {
    throw new TypeError('createRelayQueueTransport: selfDid, identity, sign, resolvePeerKey, client required');
  }
  // In-memory per-peer send sequence (default). P4 injects a durable counter keyed on
  // (self, peer) in the vault so seq survives restart — required for the recipient's
  // monotonic replay check to be meaningful across process boundaries.
  const seqs = new Map();
  const seqFor = nextSeq || ((peerDid) => { const n = (seqs.get(peerDid) || 0) + 1; seqs.set(peerDid, n); return n; });

  return {
    /**
     * Seal `payload` to `peer` and enqueue it in the peer's relay inbox (fire-and-forget
     * at the transport level; the caller keeps a durable pending row and retries — P4).
     * @param {{handle:string, did:string, keyAgreementPubB64:string}} peer  resolved from the DID doc
     */
    async deliver(peer, payload) {
      if (!peer || !peer.handle || !peer.did || !peer.keyAgreementPubB64) {
        throw new Error('deliver: peer {handle, did, keyAgreementPubB64} required');
      }
      const env = sealEnvelope(payload, {
        recipientKeyAgreementPubB64: peer.keyAgreementPubB64, recipientDid: peer.did,
        senderDid: selfDid, sign, nonce: randomUUID(), ts: Date.now(), senderSeq: seqFor(peer.did),
      });
      await client.enqueue(peer.handle, JSON.stringify(env));
    },

    /**
     * Pull, verify+open, and ACK every pulled envelope — opened or failed. Returns
     * [{ payload, senderDid, nonce, ts, senderSeq, queueId }] for the caller to dedup +
     * dispatch.
     *
     * ANTI-DoS (this is load-bearing): a pulled envelope that fails to open (malformed /
     * forged / not-addressed-to-us / unresolvable sender) is DROPPED (acked), never left
     * queued. Enqueue is unauthenticated, so if failures were left un-acked they'd sit at
     * the oldest end of the pull window (pullQueue is ORDER BY enqueued_at ASC LIMIT 100)
     * and an attacker flooding poison would permanently block the head — legit mail at
     * position 101+ would never be pulled. Acking everything guarantees the head always
     * drains. Recovery for a *legitimately* undeliverable envelope (e.g. a transient
     * sender-DID resolution blip) is the SENDER's job: its durable outbox re-delivers
     * (P4) — consistent with store-and-forward, where the sender owns durability. P4 may
     * add attempt-bounded transient retry on top; it must NOT reintroduce indefinite
     * un-acked retention keyed on attacker-controlled fields.
     */
    async receive() {
      const pending = await client.pull();
      const opened = [];
      const ackIds = [];
      for (const item of pending) {
        ackIds.push(item.id); // always ack what we pulled — poison must not accumulate
        let env;
        try { env = JSON.parse(item.envelope); } catch { continue; } // dropped
        try {
          opened.push({ ...await openEnvelope(env, { identity, resolvePeerKey, expectedTo: selfDid }), queueId: item.id });
        } catch { /* forged / not-for-us / unresolvable → dropped (acked above); sender re-delivers */ }
      }
      if (ackIds.length) { try { await client.ack(ackIds); } catch { /* ack idempotent; re-pull next cycle, dedup by P4 */ } }
      return opened;
    },
  };
}
