// src/identity/identity.js — the box's cryptographic identity (the "tag" owner).
//
// Every Mycelium box has ONE signing identity: an ed25519 keypair derived
// deterministically from the USER_MASTER key (HKDF), so there is no extra
// secret to store, it is reproducible across reinstalls (as long as you keep
// your master key), and it is bound to the same root of trust as the vault.
//
// This identity is what makes publishing *yours*: only the holder of the master
// key can reproduce the private key, so only they can sign a publish action or
// mint an access link under their handle/tag. The public key is shareable — it
// lets anyone VERIFY a signature without being able to forge one. This is the
// shared foundation for BOTH the custom-domain and (future) <tag>.mycelium.id
// serving paths.
//
// Built entirely on Node's built-in crypto — no dependency.

import crypto from "node:crypto";

const HKDF_INFO = "mycelium-identity-v1";
// Independent X25519 keyAgreement (ENCRYPTION) key — a SEPARATE HKDF info from the
// signing key, so the box derives a fresh X25519 keypair rather than the
// Ed25519→X25519 birational conversion the W3C did:key spec warns against (key
// separation). Used to seal the per-space Content Encryption Key to this member
// (E2E "Space Key Lockbox", docs/SHARED-SPACES-E2E-DESIGN-2026-06-30.md).
const KEYAGREEMENT_HKDF_INFO = "mycelium-keyagreement-v1";
// PKCS8 DER prefix for an X25519 private key carrying a 32-byte seed (OID 1.3.101.110).
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
// SPKI DER prefix for an X25519 public key (to reconstruct a peer's key for ECDH).
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
// Standard PKCS8 DER prefix for an ed25519 private key carrying a 32-byte seed.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/; // 2-32 chars, no leading/trailing dash

export class IdentityError extends Error {
  constructor(message) { super(message); this.name = "IdentityError"; }
}

/** Derive the ed25519 keypair from a 64-char hex master key. */
function deriveKeyPair(masterHex) {
  if (typeof masterHex !== "string" || !/^[0-9a-f]{64}$/i.test(masterHex)) {
    throw new IdentityError("identity: a 64-char hex master key is required");
  }
  const seed = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(masterHex, "hex"), Buffer.alloc(0), Buffer.from(HKDF_INFO), 32));
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const publicKey = crypto.createPublicKey(privateKey);
  return { privateKey, publicKey };
}

/** Derive the X25519 keyAgreement keypair from the master key (independent HKDF info).
 *  X25519 private keys are 32 random scalar bytes (Node clamps internally), so the
 *  same seed→PKCS8→KeyObject pattern as the Ed25519 identity works. */
function deriveKeyAgreementKeyPair(masterHex) {
  if (typeof masterHex !== "string" || !/^[0-9a-f]{64}$/i.test(masterHex)) {
    throw new IdentityError("identity: a 64-char hex master key is required");
  }
  const seed = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(masterHex, "hex"), Buffer.alloc(0), Buffer.from(KEYAGREEMENT_HKDF_INFO), 32));
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const publicKey = crypto.createPublicKey(privateKey);
  return { privateKey, publicKey };
}

/** Validate a handle/tag (lowercase, 2-32 chars, alnum + internal dashes). */
export function isValidHandle(handle) {
  return typeof handle === "string" && HANDLE_RE.test(handle);
}

/**
 * Create the box identity.
 * @param {object} [opts]
 * @param {string} [opts.masterHex=process.env.ENCRYPTION_MASTER_KEY]
 * @param {string|null} [opts.handle]  the owner's chosen tag (validated)
 */
export function createIdentity({ masterHex = process.env.ENCRYPTION_MASTER_KEY, handle = null } = {}) {
  const { privateKey, publicKey } = deriveKeyPair(masterHex);
  const publicKeyRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const publicKeyB64 = Buffer.from(publicKeyRaw).toString("base64url");

  // The independent X25519 keyAgreement (encryption) keypair (E2E spaces).
  const ka = deriveKeyAgreementKeyPair(masterHex);
  const keyAgreementPublicKeyB64 = Buffer.from(ka.publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("base64url");

  if (handle !== null && !isValidHandle(handle)) {
    throw new IdentityError(`identity: invalid handle ${JSON.stringify(handle)} (2-32 chars, a-z 0-9 -, no leading/trailing dash)`);
  }

  return {
    handle,
    publicKeyB64,
    /** This box's X25519 keyAgreement public key (base64url) — published in did.json
     *  under #key-enc / keyAgreement; peers seal the space CEK to it. */
    keyAgreementPublicKeyB64,
    /** ECDH shared secret with a peer's X25519 keyAgreement public key (base64url) →
     *  32-byte Buffer. The X25519 private key stays encapsulated (never exposed), so
     *  the sealed-box (BU-SEAL) calls this rather than touching key material.
     *  ⚠️ This is the RAW X25519 ECDH output — it is NOT a uniform symmetric key.
     *  Callers MUST run it through a KDF (HKDF) with context before using it as an
     *  AES key (RFC 7748 §6 / NaCl box). BU-SEAL's HPKE does this internally. */
    keyAgreementSharedSecret(peerPublicKeyB64) {
      const spki = Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(String(peerPublicKeyB64), "base64url")]);
      const peerPub = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
      return crypto.diffieHellman({ privateKey: ka.privateKey, publicKey: peerPub });
    },
    /** Sign bytes/string → base64url signature. */
    sign(data) {
      const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      return crypto.sign(null, buf, privateKey).toString("base64url");
    },
    /** Verify a base64url signature against bytes/string. Never throws. */
    verify(data, sigB64) {
      try {
        const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
        return crypto.verify(null, buf, publicKey, Buffer.from(String(sigB64), "base64url"));
      } catch { return false; }
    },
    /** The shareable public identity (safe to publish / put in WebFinger/DID later). */
    publicIdentity() {
      return { handle, publicKey: publicKeyB64, algo: "ed25519" };
    },
  };
}

/** Verify a signature with only a base64url public key (no private key needed). */
export function verifyWithPublicKey(publicKeyB64, data, sigB64) {
  try {
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyB64, "base64url")]);
    const publicKey = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    return crypto.verify(null, buf, publicKey, Buffer.from(String(sigB64), "base64url"));
  } catch { return false; }
}

export default createIdentity;
