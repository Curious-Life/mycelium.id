// src/federation/pull-loop.js — the box's RECEIVE automation (federation transport P4).
//
// A background poller (server-rest completeBoot, sibling of the enrich drainer) that pulls
// THIS box's relay inbox, opens the sealed envelopes, DEDUPS durably, dispatches to the
// connection layer, and acks. A box needs NO inbound reachability — this loop is what makes
// an offline / NAT'd / mid-boot peer's connect (or DM) actually LAND: the sender dropped a
// sealed envelope in the queue; here we pull it whenever we're next online.
//
// Durability model (mailbox, delete-on-ack):
//   pull → for each envelope: open (poison → ack-drop) → classify against federation_seen
//   → dispatch (idempotent receiveRemote/receiveResponse/receiveMessage) → mark seen → ack.
//   A vault-write failure is TRANSIENT → the envelope is left un-acked (retried next cycle);
//   a relay-unreachable failure backs the whole loop off (cycle-counted, like the drainer).
//   The receive fns are idempotent AND (sender_did,nonce) dedup is durable, so a re-pull
//   after an ack failure or a crash never double-applies.

import { openEnvelope } from './envelope.js';
import { didWebHost } from './did.js';

const DEFAULT_INTERVAL_MS = 15000;
const MAX_SKIP_CYCLES = 40;
const RESOLVE_CONCURRENCY = 8; // bounded parallelism so a poison batch can't stall the loop serially

export function createFederationPullLoop({ db, userId, identity, selfDid, resolvePeerKey, client, outbox = null, intervalMs = DEFAULT_INTERVAL_MS, logger = () => {} }) {
  if (!db || !identity || !selfDid || typeof resolvePeerKey !== 'function' || !client) {
    throw new TypeError('createFederationPullLoop: db, identity, selfDid, resolvePeerKey, client required');
  }
  let timer = null;
  let fails = 0;       // consecutive relay-failure count → exponential skip
  let skip = 0;        // cycles remaining to skip
  let ticking = false; // reentrancy latch: a slow cycle/outbox flush can outlast intervalMs, and
                       // a second overlapping tick would re-pull + re-select the same failed rows

  // Has (sender_did, nonce) already been processed? Durable across restart (federation_seen
  // is in the vault). Replay protection is the NONCE — a replayed envelope reuses its nonce.
  // We deliberately do NOT gate on sender_seq: the send-side seq is in-memory today (P4
  // residual) and resets on a sender restart, so a "seq <= max-seen" drop would SILENTLY lose
  // every post-restart send — and it adds nothing over nonce dedup. seq is still recorded for
  // ordering/observability + a future durable-seq upgrade, just never used to reject.
  async function isSeen(senderDid, nonce) {
    const seen = await db.rawQuery('SELECT 1 FROM federation_seen WHERE sender_did = ? AND nonce = ? LIMIT 1', [senderDid, nonce]);
    return !!seen.results?.length;
  }
  async function markSeen(senderDid, nonce, senderSeq) {
    await db.rawQuery('INSERT OR IGNORE INTO federation_seen (sender_did, nonce, sender_seq) VALUES (?, ?, ?)', [senderDid, nonce, Number.isInteger(senderSeq) ? senderSeq : null]);
  }

  // Dispatch to the connection layer, mirroring src/federation/handlers.js. senderDid is the
  // sealed-then-verified sender from openEnvelope. Returns true if a known $type was handled.
  async function dispatch({ payload, senderDid }) {
    const verifiedHost = didWebHost(senderDid);
    switch (payload?.$type) {
      case 'social.mycelium.connect-request.v1':
        await db.connections.receiveRemote({ fromHandle: payload.from_handle, verifiedHost, fromDid: senderDid, profile: payload.profile || {}, toUserId: userId });
        return true;
      case 'social.mycelium.connect-response.v1':
        await db.connections.receiveResponse({ fromHandle: payload.from_handle, verifiedHost, fromDid: senderDid, profile: payload.profile || {}, action: payload.action, toUserId: userId });
        return true;
      case 'social.mycelium.message.v1':
        await db.connections.receiveMessage({ fromDid: senderDid, verifiedHost, content: payload.content, nonce: payload.nonce, toUserId: userId });
        return true;
      default:
        return false; // unknown $type → drop (ack, never reprocess)
    }
  }

  // One pull cycle. Throws only on a transport-level failure (→ backoff); per-envelope
  // failures are contained. Returns { pulled, processed, dropped }.
  async function cycle() {
    const pending = await client.pull(); // throws if the relay is unreachable
    const ackIds = [];
    let processed = 0, dropped = 0;

    // Per-cycle DID-key memo: openEnvelope resolves the sender's verify key over the network
    // (resolveDidKey, before the sig check). Enqueue is unauthenticated + our seal key is
    // public, so an attacker can craft envelopes that decrypt with an attacker-chosen
    // sender_did, forcing a fetch each. Memoise per cycle so repeats are free, and process the
    // batch with BOUNDED CONCURRENCY so a poison batch can't stall the loop serially (the
    // relay's per-recipient depth cap is the outer bound; recipient-DID blinding is deferred).
    const keyMemo = new Map();
    const resolveCached = (did) => { if (!keyMemo.has(did)) keyMemo.set(did, Promise.resolve().then(() => resolvePeerKey(did))); return keyMemo.get(did); };

    async function handleOne(item) {
      let opened;
      try { opened = await openEnvelope(JSON.parse(item.envelope), { identity, resolvePeerKey: resolveCached, expectedTo: selfDid }); }
      catch { ackIds.push(item.id); dropped++; return; } // poison / forged / not-for-us → drop (anti-DoS)
      try {
        if (await isSeen(opened.senderDid, opened.nonce)) { ackIds.push(item.id); dropped++; return; } // duplicate replay
        const handled = await dispatch(opened);          // idempotent
        await markSeen(opened.senderDid, opened.nonce, opened.senderSeq);
        if (handled) processed++; else dropped++;
        ackIds.push(item.id);
      } catch (e) {
        // TRANSIENT vault-write failure → do NOT ack; retry next cycle (dedup guards double-apply).
        logger(`[federation-pull] dispatch failed (retry next cycle): ${e.message}`);
      }
    }

    let idx = 0;
    const worker = async () => { while (idx < pending.length) await handleOne(pending[idx++]); };
    await Promise.all(Array.from({ length: Math.min(RESOLVE_CONCURRENCY, pending.length || 1) }, worker));

    if (ackIds.length) { try { await client.ack(ackIds); } catch { /* re-pull next cycle; dedup guards double-apply */ } }
    return { pulled: pending.length, processed, dropped };
  }

  async function tick() {
    if (ticking) return; // a previous tick is still in flight → skip this one (no overlapping runs)
    ticking = true;
    try {
      if (skip > 0) { skip--; return; }
      try { await cycle(); fails = 0; }
      catch (e) {
        fails += 1;
        skip = Math.min(2 ** fails, MAX_SKIP_CYCLES); // exponential skip while the relay is down
        logger(`[federation-pull] pull failed (skip ${skip} cycles): ${e.message}`);
        // NOTE: we deliberately do NOT return here any more. This used to bail out on the
        // reasoning that "the relay is unreachable, so a send would just fail too" — which
        // stopped being true when federationDeliver gained the relay→direct fallback: an
        // outbox send can now succeed over direct HTTP against a peer that is reachable even
        // while the relay is down. Returning early re-created the exact "relay down ⇒
        // everything down" assumption that took federation out for ~9 days, in the one place
        // whose whole job is recovering from that outage. RECEIVE still backs off (above);
        // only SEND continues.
      }
      // Flush the send-retry outboxes (failed DMs + owed accept-acks). Best-effort + bounded;
      // a failure here never affects RECEIVE.
      if (outbox) { try { await outbox(); } catch (e) { logger(`[federation-pull] outbox flush failed: ${e.message}`); } }
    } finally { ticking = false; }
  }

  return {
    start() { if (!timer) { timer = setInterval(tick, intervalMs); if (timer.unref) timer.unref(); } return this; },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    cycle, // exposed for tests + an explicit nudge (bypasses the skip counter)
    tick,
  };
}
