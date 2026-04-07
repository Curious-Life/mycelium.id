# Mycelium Federation Protocol — v1.0

**Status**: Draft
**Date**: 2026-04-07

---

## Overview

The Mycelium federation protocol enables independent Mycelium instances to discover each other and form connections between users. It is purpose-built for sovereign intelligence — sharing what you think about, not what you say.

Each instance is a node in a peer-to-peer network. No central authority is required. An optional registry at mycelium.id provides discovery but is never a gateway.

### Design principles

1. **Sovereignty**: Each instance is authoritative for its own data. No instance can compel another.
2. **Privacy by default**: Only territory labels, cognitive stats, and essences cross instance boundaries. Never embeddings, content, encrypted fields, contacts, or chronicles.
3. **Identity portability**: DIDs survive instance death. Handles are human-readable aliases.
4. **Minimum viable federation**: ~200 lines of Worker code. Zero additional infrastructure for self-hosters.

---

## Identity

### Handles

Human-readable identifiers with optional domain qualifier.

| Context | Format | Example |
|---------|--------|---------|
| Local (same instance) | `@handle` | `@martin` |
| Federated (cross-instance) | `@handle@domain` | `@alice@alice.example.com` |

**Validation**: `^[a-z0-9][a-z0-9_]{2,29}$` (3-30 chars, lowercase alphanumeric + underscore).

**Reserved handles**: `admin`, `support`, `api`, `system`, `mycelium`, `vault`, `login`, `signup`, `profile`, `settings`, `help`, `about`, `discover`, `connections`.

### DIDs (Decentralized Identifiers)

Every user has a `did:web` identifier that survives instance death.

```
did:web:mycelium.id:martin
did:web:alice.example.com:alice
```

The DID document is published at `/.well-known/did.json` and contains:

```json
{
  "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/ed25519-2020/v1"],
  "id": "did:web:mycelium.id:martin",
  "verificationMethod": [{
    "id": "did:web:mycelium.id:martin#key-1",
    "type": "Ed25519VerificationKey2020",
    "controller": "did:web:mycelium.id:martin",
    "publicKeyMultibase": "z6Mkf5rG..."
  }],
  "service": [{
    "id": "did:web:mycelium.id:martin#mycelium",
    "type": "MyceliumInstance",
    "serviceEndpoint": "https://mycelium.id/federation"
  }]
}
```

**Recovery**: If an instance dies, the user spins up a new instance, publishes an updated DID document with the new `serviceEndpoint`, and peers re-federate by resolving the DID.

---

## Discovery: WebFinger

Instances implement [RFC 7033 WebFinger](https://tools.ietf.org/html/rfc7033) for handle resolution.

**Request:**
```
GET /.well-known/webfinger?resource=acct:martin@mycelium.id
```

**Response:**
```json
{
  "subject": "acct:martin@mycelium.id",
  "links": [
    {
      "rel": "self",
      "type": "application/json",
      "href": "https://mycelium.id/api/public/profile/martin"
    },
    {
      "rel": "https://mycelium.id/ns/federation",
      "href": "https://mycelium.id/federation"
    },
    {
      "rel": "https://mycelium.id/ns/did",
      "href": "did:web:mycelium.id:martin"
    }
  ]
}
```

---

## Endpoints

Every Mycelium instance exposes these federation endpoints.

### `GET /federation/instance-info`

Returns instance metadata and capabilities. No authentication required.

```json
{
  "$type": "social.mycelium.instance-info.v1",
  "name": "Martin's Mycelium",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "public_key": "MCowBQYDK2VwAyEA...",
  "key_id": "2026-04-07-sub1",
  "user_count": 1,
  "capabilities": ["connect", "overlap-labels"],
  "supported_overlap_methods": ["labels"],
  "federation_endpoint": "https://mycelium.id/federation"
}
```

**Capabilities** (negotiated between instances):
- `connect` — connection requests and acceptance
- `overlap-labels` — territory label exchange for overlap
- `psi` — Private Set Intersection (Phase 4+)
- `deep-match` — bilateral noised centroid exchange (Phase 5)

### `GET /federation/profile/:handle`

Returns the public profile for a user. No authentication required.

```json
{
  "$type": "social.mycelium.profile.v1",
  "handle": "martin",
  "did": "did:web:mycelium.id:martin",
  "signature": "Builds systems, thinks in networks",
  "stats": {
    "depth_score": 0.85,
    "breadth_score": 0.72,
    "coherence_score": 0.81,
    "exploration_score": 0.55,
    "territory_count": 47,
    "realm_count": 6,
    "message_count": 48231
  },
  "realms": ["Technology & Systems", "Intelligence & Strategy", "Inner Work"],
  "territories": [
    { "name": "Distributed Systems", "essence": "Fault tolerance and consensus", "visibility": "public" }
  ],
  "member_since": "2024-09-15T00:00:00Z"
}
```

### `POST /federation/connect`

Receive an inbound connection request from a remote instance. Requires a signed JWT.

**Request body:**
```json
{
  "$type": "social.mycelium.connect-request.v1",
  "from_handle": "martin",
  "from_instance": "mycelium.id",
  "from_did": "did:web:mycelium.id:martin",
  "to_handle": "alice",
  "profile": {
    "signature": "Builds systems, thinks in networks",
    "stats": { "depth_score": 0.85, "breadth_score": 0.72 },
    "realms": ["Technology & Systems"]
  }
}
```

**Response (201):**
```json
{
  "connection_id": "a1b2c3d4-...",
  "status": "pending"
}
```

### `POST /federation/connect/:id/accept`

Notify the requesting instance that the connection was accepted. Requires a signed JWT.

**Request body:**
```json
{
  "$type": "social.mycelium.connect-accept.v1",
  "connection_id": "a1b2c3d4-...",
  "accepted_by": "alice",
  "accepted_at": "2026-04-07T12:00:00Z"
}
```

### `POST /federation/connect/:id/cancel`

Withdraw a pending connection request before the other party acts on it.

**Request body:**
```json
{
  "$type": "social.mycelium.connect-cancel.v1",
  "connection_id": "a1b2c3d4-...",
  "cancelled_by": "martin"
}
```

### `POST /federation/overlap`

Exchange territory labels for overlap computation. The initiating instance sends its user's visible labels in the request body. The receiving instance responds with its user's visible labels. Both compute overlap locally.

**Request body:**
```json
{
  "$type": "social.mycelium.overlap-request.v1",
  "connection_id": "a1b2c3d4-...",
  "requester_handle": "martin",
  "territories": [
    { "name": "Distributed Systems", "essence": "Fault tolerance and consensus", "message_count": 423 },
    { "name": "ML Theory", "essence": "Statistical learning foundations", "message_count": 287 }
  ]
}
```

**Response:**
```json
{
  "$type": "social.mycelium.overlap-response.v1",
  "connection_id": "a1b2c3d4-...",
  "responder_handle": "alice",
  "territories": [
    { "name": "Distributed Systems", "essence": "Consensus algorithms and CAP theorem", "message_count": 312 },
    { "name": "Cryptography", "essence": "Post-quantum lattice constructions", "message_count": 189 }
  ]
}
```

Both instances independently compute the overlap using label matching (case-insensitive exact match in v1).

### `POST /federation/rotate-key`

Announce a key rotation. The new public key is signed by the old private key.

**Request body:**
```json
{
  "$type": "social.mycelium.rotate-key.v1",
  "instance": "mycelium.id",
  "new_public_key": "MCowBQYDK2VwAyEA...",
  "new_key_id": "2026-04-14-sub2",
  "old_key_valid_until": "2026-04-14T00:00:00Z"
}
```

Signed with the **old** key. Receiving instances verify the signature, then add the new key. The old key remains valid for verification until `old_key_valid_until` (7 days).

---

## Authentication

### Ed25519 JWT

All mutating federation requests (`POST /federation/connect`, `/accept`, `/cancel`, `/overlap`, `/rotate-key`) must include a signed JWT in the `Authorization` header.

```
Authorization: Bearer eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6IjIwMjYtMDQtMDctc3ViMSJ9...
```

**JWT header:**
```json
{
  "alg": "EdDSA",
  "typ": "JWT",
  "kid": "2026-04-07-sub1"
}
```

**JWT payload:**
```json
{
  "iss": "mycelium.id",
  "iat": 1712476800,
  "exp": 1712476860,
  "jti": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  "body_hash": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
}
```

| Claim | Description |
|-------|-------------|
| `iss` | Issuing instance domain |
| `iat` | Issued at (Unix timestamp) |
| `exp` | Expires at (max 60 seconds after `iat`) |
| `jti` | Unique request ID (128-bit random hex). Prevents replay. |
| `body_hash` | `sha256:` + hex-encoded SHA-256 of the raw request body. Prevents body tampering. |

### Replay protection

Receiving instances maintain a **seen-nonce set** in KV (TTL = 90 seconds, covering the 60s expiry window + 30s clock skew). Any `jti` already in the set is rejected with `401`.

Verification order:
1. Parse JWT header, extract `kid`
2. Look up public key for `iss` instance (from `federation_keys` cache or fetch from `/federation/instance-info`)
3. Verify Ed25519 signature
4. Check `exp` > now - 30s (clock skew tolerance)
5. Check `jti` not in seen-nonce set
6. Compute SHA-256 of request body, compare to `body_hash`
7. Add `jti` to seen-nonce set (TTL = 90s)
8. Parse and validate request body

### Key management

**Master/sub-key pattern:**
- Each instance has a long-lived **master key** (stored securely, rarely used)
- Master key signs short-lived **sub-keys** (7-day validity)
- Federation requests are signed with the active sub-key
- Compromise blast radius = 7 days maximum

**Key verification layers:**
1. **TOFU** (Trust On First Use): Accept the key from `/federation/instance-info` on first contact
2. **DNS TXT**: Publish public key at `_mycelium-key.domain.com` as a second verification channel
3. **Registry attestation**: If using the mycelium.id registry, key bindings are stored there
4. **Manual trust**: Instance operators can manually mark instances as trusted

**Trust levels** (stored in `federation_keys.trust_level`):

| Level | Name | Meaning |
|-------|------|---------|
| 0 | Unknown | Never contacted |
| 1 | TOFU | First contact key accepted |
| 2 | DNS verified | Key matches DNS TXT record |
| 3 | Registry attested | Key confirmed via mycelium.id registry |
| 4 | Manually trusted | Operator explicitly trusts this instance |

---

## SSRF Protection

When resolving handles via WebFinger, the Worker makes HTTP requests to arbitrary domains. Mitigations:

1. **Worker-side resolution only** — WebFinger fetches happen in the Cloudflare Worker, which cannot reach VPS internal networks
2. **HTTPS only** — reject HTTP URLs
3. **Private IP rejection** — reject resolved IPs in: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `127.0.0.0/8`
4. **No redirect following** (or re-validate redirect targets against the same rules)
5. **5-second timeout**
6. **Punycode normalization** for domain names (prevent homograph attacks)

---

## Input Validation

All federation response payloads must be validated before processing.

| Field | Max length | Validation |
|-------|-----------|------------|
| Handle | 30 chars | `^[a-z0-9][a-z0-9_]{2,29}$` |
| Domain | 253 chars | RFC 1035 |
| Territory name | 100 chars | Strip HTML/JS |
| Territory essence | 500 chars | Strip HTML/JS |
| Realm name | 100 chars | Strip HTML/JS |
| Signature | 120 chars | Strip HTML/JS |
| Scores | — | `[0.0, 1.0]` |
| Territory count | — | `[0, 10000]` |
| Total response | 1 MB | Reject oversized |

**Verify Ed25519 signature BEFORE parsing the response body.** This prevents parsing untrusted data.

---

## Connection Flow

### Full sequence

```
                  Instance A                    Instance B
                  (martin@mycelium.id)          (alice@alice.example.com)
                  ─────────────────             ─────────────────────────
  1. User enters @alice@alice.example.com
  2. Resolve WebFinger ──────────────────────►  /.well-known/webfinger
                                          ◄──  links: [profile, federation, did]
  3. POST /federation/connect ───────────────►  Verify JWT, store request
                                          ◄──  { connection_id, status: "pending" }
  4. Store connection locally (remote)
                                                5. Alice sees request in portal
                                                6. Alice clicks "Accept"
  7.                                    ◄──────  POST /federation/connect/:id/accept
     Verify JWT, mark accepted                   (with retry on failure)
  8. Connection active on both sides
```

### Error recovery

- If step 7 fails (network error), Alice's instance retries with exponential backoff (1min, 5min, 30min)
- A Worker cron trigger runs every 6 hours to reconcile: queries `connections WHERE status = 'pending' AND remote_instance IS NOT NULL AND created_at < datetime('now', '-1 hour')` and re-sends to remote instances
- If an instance is unreachable for 7 days, the connection is marked `stale`

### Cancellation

Before Alice acts on the request, Martin can cancel:
```
POST alice.example.com/federation/connect/:id/cancel
```

---

## Overlap Computation

### Phase 1-3: Label matching

Both instances exchange visible territory labels (names + essences). Each computes overlap locally using case-insensitive exact string matching.

Match score: `shared / union * 100`, weighted by territory size. Minimum 3 shared territories to compute a percentage.

Shape classification:
- **Twin Minds**: >60% overlap, balanced depth
- **Deep Collaborators**: >40% overlap, balanced depth
- **Broad Kindred Spirits**: >30% overlap
- **Complementary Thinkers**: low overlap, many unique territories
- **Asymmetric**: one person's interests are a subset

### Phase 4+: Private Set Intersection (PSI)

Upgrade path for zero-knowledge intersection. Both parties learn shared territories without revealing non-overlapping ones. Negotiated via `capabilities` in instance-info.

### Phase 5: Bilateral noised centroid exchange

With mutual consent, exchange DP-noised territory centroids (epsilon=5-10). Each side computes cosine similarity locally. No raw centroids exposed.

---

## Rate Limiting

| Endpoint | Limit | Key |
|----------|-------|-----|
| `/federation/*` (all) | 60 req/min | Per remote instance |
| `/federation/overlap` | 10 req/min | Per remote instance |
| `/api/public/profile/:handle` | 120 req/min | Per IP |

Graduated enforcement: `429 Too Many Requests` → temporary block (1 hour) → manual defederation.

---

## Instance Death Protocol

When an instance shuts down permanently:

1. **Goodbye broadcast**: Send a signed `social.mycelium.goodbye.v1` message to all known peers
2. Peers mark connections as "remote instance offline"
3. User exports encrypted backup (to S3/R2 or local download)
4. User spins up new instance, publishes updated DID document
5. Peers resolve DID, find new `serviceEndpoint`, re-establish connections

---

## Schema Versioning

All federation payloads include a `$type` field for forward/backward compatibility.

| Type | Version | Description |
|------|---------|-------------|
| `social.mycelium.instance-info` | v1 | Instance metadata + capabilities |
| `social.mycelium.profile` | v1 | Public profile |
| `social.mycelium.connect-request` | v1 | Connection request |
| `social.mycelium.connect-accept` | v1 | Connection acceptance |
| `social.mycelium.connect-cancel` | v1 | Connection cancellation |
| `social.mycelium.overlap-request` | v1 | Territory label exchange (request) |
| `social.mycelium.overlap-response` | v1 | Territory label exchange (response) |
| `social.mycelium.rotate-key` | v1 | Key rotation announcement |
| `social.mycelium.goodbye` | v1 | Instance shutdown notice |

**Rules:**
- New fields can be added without bumping the version (forward compatible)
- Old instances ignore unknown `$type` versions (backward compatible)
- Major version bumps for breaking changes (v2, v3...)
- Instances negotiate version via `protocol_version` in instance-info

---

## Federation Security Headers

All federation responses include:

```
X-Request-ID: <jti from incoming JWT>
X-Instance-Version: 1.0.0
X-Signature-KeyId: <kid of the signing key>
```

---

## Database Schema

```sql
-- Migration: 106_federation.sql (applied to each instance's D1)

ALTER TABLE user_profiles ADD COLUMN did TEXT;

ALTER TABLE connections ADD COLUMN remote_instance TEXT;
ALTER TABLE connections ADD COLUMN remote_user_handle TEXT;
ALTER TABLE connections ADD COLUMN remote_did TEXT;

CREATE TABLE IF NOT EXISTS federation_keys (
  instance_url TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  key_id TEXT,
  instance_name TEXT,
  protocol_version TEXT DEFAULT '1.0',
  capabilities_json TEXT,
  user_count INTEGER DEFAULT 0,
  last_seen TEXT,
  trust_level INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS federation_log (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  remote_instance TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT DEFAULT 'success',
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_fed_log_instance ON federation_log(remote_instance, created_at);
```

---

## Privacy Boundary (Invariant)

**NEVER crosses instance boundaries:**
- Raw embeddings (256D or 1024D)
- Individual atom vectors
- Unnoised territory centroids
- Message content
- Contact names or details
- Chronicle text
- Entity lists
- Any AES-256-GCM encrypted field

**Crosses boundaries per visibility settings:**
- Territory names + essences (Public or Friends)
- Cognitive fingerprint stats (always public)
- Handle, signature, realm names (always public)
- Overlap scores + shape (mutual connections only)
- DP-noised centroids (Phase 5, bilateral consent only)

---

## Self-Hoster Checklist

To enable federation on your Mycelium instance:

1. Run migration `106_federation.sql` against your D1
2. Generate instance keypair: `node scripts/generate-instance-keys.js`
3. Store keys as Worker secrets: `INSTANCE_PRIVATE_KEY`, `INSTANCE_PUBLIC_KEY`
4. Deploy updated Worker (includes federation endpoints)
5. Verify: `curl https://your-instance/.well-known/webfinger?resource=acct:yourhandle@your-domain`
6. Optional: publish Ed25519 public key as DNS TXT at `_mycelium-key.your-domain`
7. Optional: register with mycelium.id discovery registry
