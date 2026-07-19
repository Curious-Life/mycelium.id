// src/federation/transport-chooser.js — decide how to deliver federation signaling to a
// peer (federation transport P3b capability chooser).
//
// A peer is RELAY-capable iff its DID document advertises BOTH:
//   - a #relay-inbox service (where a sender enqueues a sealed envelope), AND
//   - a keyAgreement X25519 key (what the envelope's CEK is sealed to).
// Missing either → fall back to the DIRECT box→box HTTP transport (works only when the
// peer is reachable right now). FAIL-CLOSED: any resolution error → 'direct' — never
// hang, and never fall through to a send that couldn't be sealed.
//
// Pure decision logic; the resolvers (DID-doc lookups) are injected so this stays
// transport-agnostic and unit-testable without a network.

/**
 * @param {string} peerDid  the peer's did (did:web today; did:key in P6)
 * @param {object} deps
 * @param {(did:string)=>Promise<string|null>} deps.resolveRelayInbox  → https relay base URL | null
 * @param {(did:string)=>Promise<string|null>} deps.resolveKeyAgreement  → base64url X25519 key | null
 * @returns {Promise<{kind:'relay', inbox:string, keyAgreementPubB64:string} | {kind:'direct'}>}
 */
export async function planDelivery(peerDid, { resolveRelayInbox, resolveKeyAgreement } = {}) {
  if (!peerDid || typeof resolveRelayInbox !== 'function' || typeof resolveKeyAgreement !== 'function') {
    return { kind: 'direct' };
  }
  let inbox;
  try { inbox = await resolveRelayInbox(peerDid); } catch { return { kind: 'direct' }; }
  // Defensive shape checks (belt-and-suspenders on the injected resolvers): only a real
  // https URL string is a usable inbox, only a string is a usable seal key — a non-string
  // or malformed value must degrade to direct, never yield a relay plan with garbage.
  if (typeof inbox !== 'string' || !/^https:\/\//.test(inbox)) return { kind: 'direct' };

  let keyAgreementPubB64;
  try { keyAgreementPubB64 = await resolveKeyAgreement(peerDid); } catch { return { kind: 'direct' }; }
  if (typeof keyAgreementPubB64 !== 'string' || !keyAgreementPubB64) return { kind: 'direct' }; // no/invalid seal key → can't seal

  return { kind: 'relay', inbox, keyAgreementPubB64 };
}
