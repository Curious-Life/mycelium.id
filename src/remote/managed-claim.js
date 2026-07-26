// src/remote/managed-claim.js — build the ed25519 handle claim the managed
// control-plane verifies (identity.verifyWithPublicKey). No password/account:
// only the holder of the vault master key can produce the signature, and the
// control-plane learns nothing but the public key. The signed message is
// domain-separated, versioned, AND **action-bound** (provision vs release) so a
// captured claim for one operation can't be replayed as the other.
import { createIdentity, isValidHandle } from '../identity/identity.js';

export const CLAIM_VERSION = 'v1';
// Action-bound: a claim signed for one action can't be replayed as another
// (provision/release touch DNS+certs; billing opens the Stripe portal — O7; the
// queue-* actions authenticate a box PULLING/ACKing its own store-and-forward mail
// — federation transport P2, the federation-transport redesign;
// relay-connect authenticates a box opening its E2E dial-out relay session — E2E
// reachability Phase 3, the E2E-reachability design).
// NOTE: enqueue is deliberately NOT a claim action — a sender never authenticates to
// the relay, preserving sealed-sender (the relay never learns who queued the mail).
export const CLAIM_ACTIONS = new Set(['provision', 'release', 'billing', 'queue-pull', 'queue-ack', 'relay-connect']);

/** The exact bytes both sides sign/verify. Domain-separated + versioned + action-bound. */
export function claimMessage(action, handle, nonce) {
  return `mycelium-handle-claim:${CLAIM_VERSION}:${action}:${handle}:${nonce}`;
}

/**
 * Build a signed handle claim from the vault master key.
 * @param {{ action?:'provision'|'release', handle:string, nonce:string, masterHex:string }} args
 * @returns {{ v:string, action:string, handle:string, publicKey:string, nonce:string, signature:string }}
 */
export function buildClaim({ action = 'provision', handle, nonce, masterHex }) {
  if (!CLAIM_ACTIONS.has(action)) throw new Error(`invalid action: ${action}`);
  if (!isValidHandle(handle)) {
    throw new Error('invalid handle (2-32 chars, a-z 0-9 -, no leading/trailing dash)');
  }
  if (typeof nonce !== 'string' || nonce.length < 8) {
    throw new Error('nonce required (>=8 chars)');
  }
  const id = createIdentity({ masterHex, handle });
  return {
    v: CLAIM_VERSION,
    action,
    handle,
    publicKey: id.publicKeyB64,
    nonce,
    signature: id.sign(claimMessage(action, handle, nonce)),
  };
}
