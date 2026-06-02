// src/remote/managed-claim.js — build the ed25519 handle claim the managed
// control-plane verifies (identity.verifyWithPublicKey). No password/account:
// only the holder of the vault master key can produce the signature, and the
// control-plane learns nothing but the public key. The signed message is
// domain-separated + versioned so a signature can't be replayed across protocols.
import { createIdentity, isValidHandle } from '../identity/identity.js';

export const CLAIM_VERSION = 'v1';

/** The exact bytes both sides sign/verify. Domain-separated + versioned. */
export function claimMessage(handle, nonce) {
  return `mycelium-handle-claim:${CLAIM_VERSION}:${handle}:${nonce}`;
}

/**
 * Build a signed handle claim from the vault master key.
 * @param {{ handle:string, nonce:string, masterHex:string }} args
 * @returns {{ v:string, handle:string, publicKey:string, nonce:string, signature:string }}
 */
export function buildClaim({ handle, nonce, masterHex }) {
  if (!isValidHandle(handle)) {
    throw new Error('invalid handle (2-32 chars, a-z 0-9 -, no leading/trailing dash)');
  }
  if (typeof nonce !== 'string' || nonce.length < 8) {
    throw new Error('nonce required (>=8 chars)');
  }
  const id = createIdentity({ masterHex, handle });
  return {
    v: CLAIM_VERSION,
    handle,
    publicKey: id.publicKeyB64,
    nonce,
    signature: id.sign(claimMessage(handle, nonce)),
  };
}
