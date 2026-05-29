/**
 * DID document endpoint — /.well-known/did.json
 *
 * Closes FEDERATION-SPEC v1.0 §Identity requirement: a did:web identifier
 * survives instance death, but only if the DID document is actually served.
 * Until now the column existed (user_profiles.did) and webfinger advertised
 * a `https://mycelium.id/ns/did` link, but the document the link pointed at
 * 404'd. This handler resolves that.
 *
 * Phase 0b scope: instance-level DID for `did:web:<host>`. Per-user DIDs
 * (`did:web:<host>:<handle>`) and per-agent DIDs (`did:web:<vps>:agent:<id>`,
 * for Matrix) are Phase 0d / Phase 1 follow-ons.
 *
 * Cache: KV with 1h TTL, key `did:instance:<host>`. Busted on key rotation
 * via the federation/rotate-key handler (`bustDidCache(env, host)`).
 *
 * HTTP signature (RFC 9421): NOT in this PR. The signing key lives on the
 * VPS, not in the Worker, so a signed response requires a VPS→KV publish
 * pipeline. Tracked as Phase 0c follow-on (MATRIX-SPEC §4.2). Until then,
 * TLS provides transport integrity.
 *
 * Multi-tenant note: env.INSTANCE_PUBLIC_KEY is currently a single Worker
 * env var, so every host that hits the Worker gets the same key in its DID
 * doc. Per-tenant federation keys are tracked separately (see memory:
 * mycelium_worker_rename); when that lands the handler will need a per-host
 * key lookup. For Phase 0b the single-key behaviour matches the rest of
 * federation.ts.
 */

import type { Env } from "../types/env";

// ── Constants ────────────────────────────────────────────────────────────────

const DID_CACHE_TTL_S = 3600;

const PUBLIC_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...PUBLIC_CORS },
  });
}

/**
 * Decode SPKI DER base64 → raw 32-byte Ed25519 public key.
 *
 * Ed25519 SPKI DER layout is fixed:
 *   SEQUENCE {
 *     SEQUENCE { OID 1.3.101.112 }     // 12-byte AlgorithmIdentifier
 *     BIT STRING (0x00 || raw_32)      // 35-byte BIT STRING
 *   }
 * Total 47 bytes. The raw 32-byte public key is always the last 32 bytes.
 *
 * Matches the existing decode pattern in federation.ts:221.
 */
function spkiDerToRawEd25519(spkiDerB64: string): Uint8Array {
  const der = Uint8Array.from(atob(spkiDerB64), c => c.charCodeAt(0));
  if (der.length < 32) throw new Error("SPKI DER too short for Ed25519");
  return der.slice(-32);
}

/**
 * Encode raw Ed25519 public key as multibase string per W3C Ed25519
 * Verification Key 2020 spec: `z` + base58btc(0xed01 || raw_32_bytes).
 *
 * 0xed01 is the unsigned-varint multicodec for ed25519-pub.
 */
function rawEd25519ToMultibase(raw: Uint8Array): string {
  const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01]);
  const prefixed = new Uint8Array(ED25519_MULTICODEC.length + raw.length);
  prefixed.set(ED25519_MULTICODEC, 0);
  prefixed.set(raw, ED25519_MULTICODEC.length);
  return "z" + base58btcEncode(prefixed);
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58btcEncode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "";
  for (let i = 0; i < zeros; i++) out += BASE58_ALPHABET[0];
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  return out;
}

// ── DID document builder ─────────────────────────────────────────────────────

interface DidDocument {
  "@context": string[];
  id: string;
  verificationMethod: Array<{
    id: string;
    type: string;
    controller: string;
    publicKeyMultibase: string;
  }>;
  authentication: string[];
  assertionMethod: string[];
  service: Array<{
    id: string;
    type: string;
    serviceEndpoint: string;
  }>;
}

function buildInstanceDid(
  host: string,
  publicKeyMultibase: string,
  keyId: string | null,
): DidDocument {
  const did = `did:web:${host}`;
  const keyRef = `${did}#${keyId || "key-1"}`;
  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/suites/ed25519-2020/v1",
    ],
    id: did,
    verificationMethod: [
      {
        id: keyRef,
        type: "Ed25519VerificationKey2020",
        controller: did,
        publicKeyMultibase,
      },
    ],
    authentication: [keyRef],
    assertionMethod: [keyRef],
    service: [
      {
        id: `${did}#mycelium-federation`,
        type: "MyceliumInstance",
        serviceEndpoint: `https://${host}/federation`,
      },
    ],
  };
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function handleDidDocument(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== "/.well-known/did.json") return null;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: PUBLIC_CORS });
  }
  if (request.method !== "GET") return null;

  const host = url.hostname;
  if (!host) return jsonError("host required", 400);

  const cacheKey = `did:instance:${host}`;

  if (env.KV) {
    const cached = await env.KV.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        status: 200,
        headers: {
          "Content-Type": "application/did+ld+json",
          "Cache-Control": `public, max-age=${DID_CACHE_TTL_S}`,
          "X-Cache": "HIT",
          ...PUBLIC_CORS,
        },
      });
    }
  }

  const publicKeyB64 = (env as any).INSTANCE_PUBLIC_KEY as string | undefined;
  const keyId = (env as any).INSTANCE_SUB_KEY_ID as string | undefined;

  if (!publicKeyB64) {
    return jsonError("Instance public key not configured", 503);
  }

  let publicKeyMultibase: string;
  try {
    const raw = spkiDerToRawEd25519(publicKeyB64);
    publicKeyMultibase = rawEd25519ToMultibase(raw);
  } catch (e: any) {
    return jsonError(`Public key decode failed: ${e.message}`, 500);
  }

  const did = buildInstanceDid(host, publicKeyMultibase, keyId || null);
  const body = JSON.stringify(did);

  if (env.KV) {
    try {
      await env.KV.put(cacheKey, body, { expirationTtl: DID_CACHE_TTL_S });
    } catch {
      // Cache write best-effort; serving the doc is the primary path
    }
  }

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/did+ld+json",
      "Cache-Control": `public, max-age=${DID_CACHE_TTL_S}`,
      "X-Cache": "MISS",
      ...PUBLIC_CORS,
    },
  });
}

/**
 * Bust the DID document cache for a given host. Called by the federation
 * rotate-key handler — when an instance announces a new key, the cached
 * document advertising the old key must be invalidated so peers fetch fresh.
 */
export async function bustDidCache(env: Env, host: string): Promise<void> {
  if (!env.KV) return;
  try {
    await env.KV.delete(`did:instance:${host}`);
  } catch {
    // Best-effort; next request will overwrite via the put path
  }
}

// Internal exports for testing
export const __test__ = {
  spkiDerToRawEd25519,
  rawEd25519ToMultibase,
  base58btcEncode,
  buildInstanceDid,
};
