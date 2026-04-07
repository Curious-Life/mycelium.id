# Encrypted Portal Channel — Implementation Plan

*Drafted Apr 7, 2026. Closes the "Cloudflare sees live portal traffic" gap documented in [ENCRYPTION.md](ENCRYPTION.md#live-portal-traffic-trust-boundary).*

---

## Goal

Make the live portal traffic between the user's browser and their VPS unreadable to Cloudflare while keeping the portal accessible through the standard CF-proxied subdomain (`handle.mycelium.id`). Cloudflare retains its role as edge DDoS / WAF / TLS terminator, but the meaningful payload inside HTTP request bodies is already ciphertext by the time CF sees it.

## Non-goals

- Fully end-to-end encrypted (browser → browser) chat — the agent on the VPS *must* read messages to respond, so the trust boundary collapses to "VPS = trusted endpoint" by definition.
- Hiding metadata that the network layer inevitably exposes (connection timing, frame counts, total bytes transferred per session).
- Defending against a fully compromised customer VPS — that's already out of scope per the existing threat model.
- Replacing Cloudflare's role as edge protection. We keep the proxy.

## Threat model deltas

| Threat | Today | After Phase 1 | After Phase 2 | After Phase 3 |
|---|---|---|---|---|
| Passive observer at CF edge reads chat content | Possible | **Blocked** | Blocked | Blocked |
| Passive observer reads search queries | Possible | **Blocked** | Blocked | Blocked |
| CF edge sees session cookies / passkey assertions in body | Possible | **Blocked** for app calls | Blocked | Blocked |
| Active MITM at CF substitutes ECDH keys | n/a | Possible (TOFU only) | **Blocked** by passkey-bound identity | Blocked |
| Traffic analysis (frame sizes reveal message length) | Possible | Possible | Possible | **Mitigated** by padding |
| Typing pattern analysis via timing | Possible | Possible | Possible | **Mitigated** by heartbeats + jitter |
| CF substitutes JS bundle with backdoored crypto | Possible | Possible | Possible (mitigated by IndexedDB pin TOFU) | Same |
| CF substitutes JS bundle on first-ever load | Possible | Possible | Possible | Same — only browser extension closes this |

The honest residual risk after all three phases is the **first-load JS delivery problem**: CF serves the JS bundle, so on the very first load CF could plant backdoored code. Detection-on-update via TOFU helps, but the only true fix is trusted code delivery (browser extension or native app), which is Phase 4+.

---

## Phase 1 — Encrypted WebSocket channel

### Protocol choice

Use the **Noise Protocol Framework** with the `Noise_NK_25519_ChaChaPoly_BLAKE2s` pattern:

- `NK` = responder (VPS) has a static identity key, initiator (browser) knows it in advance
- `25519` = X25519 ECDH (smaller, faster than P-256, well-supported)
- `ChaChaPoly` = ChaCha20-Poly1305 AEAD (constant-time on all platforms, no AES-NI dependency)
- `BLAKE2s` = hash function

Why Noise instead of rolling our own:
- Audited by academic crypto community, used by WireGuard, Signal, Wire
- Handles forward secrecy, replay protection, key rotation cleanly
- `NK` pattern is exactly our trust scenario (client knows server's static key)
- Reference implementations exist in JS (`noise-curve-25519`, `@stablelib/x25519`) and Node

Avoid: rolling our own AES-GCM scheme, hand-coded ECDH. The handshake is the place crypto bugs hide.

### VPS identity key

Each VPS gets a long-term **Ed25519 identity key pair** generated once at provision time:

- Private key: `/run/mycelium/vps-identity.key` on tmpfs (same protection as master key)
- Public key: written to `/etc/mycelium/vps-identity.pub` (world-readable, served via portal endpoint)
- Fingerprint: `BLAKE2s-128(public key)` for human verification

The Noise `NK` pattern uses an X25519 static key, but we want Ed25519 for identity (signing). Standard trick: derive an X25519 key from the Ed25519 key via the Curve25519 ↔ Ed25519 birational map (libsodium's `crypto_sign_ed25519_pk_to_curve25519`). One key, two uses.

### Handshake flow

```
Browser                                                       VPS

1. Open WebSocket: wss://handle.mycelium.id/ws/secure
                              ─────────────────────►

2. Generate ephemeral X25519 keypair (eC, EC)
3. Compute first Noise message:
   - eC (32 bytes)
   - encrypted payload: {clientNonce: random128bit, version: 1}
                              ─────────────────────►

4.                                              VPS reads eC, performs Noise NK
                                                handshake using its static key (sV)
                                                Derives session keys k_send, k_recv
                                                Sends second Noise message:
                                                - eS (32 bytes)
                                                - encrypted payload: {serverNonce, identityFingerprint}
                              ◄─────────────────────

5. Browser verifies the static key embedded in
   the handshake matches the pinned VPS identity
6. Both sides have session keys
                              ◄═════════════════════►
                          Encrypted application traffic
```

After the handshake, every message in either direction is a Noise transport message: nonce + ChaCha20-Poly1305 ciphertext + tag.

### Frame format

```
WebSocket binary frame:
┌─────────────────┬─────────────────┬─────────┐
│ 8-byte counter  │ ciphertext      │ 16-byte │
│ (big-endian)    │ (variable)      │ tag     │
└─────────────────┴─────────────────┴─────────┘

Plaintext payload (after decrypt):
{
  "id": "req_abc123",        // for request/response correlation
  "type": "chat" | "search" | "stream-chunk" | "ack" | "error",
  "data": { ... }            // endpoint-specific
}
```

The 8-byte counter is a monotonic per-direction nonce. Receiver rejects frames with non-monotonic counters (replay protection).

### Endpoint migration

Today's portal flow (HTTPS):
```
Browser ──POST /portal/chat──► CF edge ──► VPS ──► agent
        ◄──SSE stream─────────  decrypted bodies all the way
```

New flow (encrypted WS):
```
Browser ──WS handshake──► CF edge (passes WS through) ──► VPS
Browser ──encrypted frame {type:"chat"}──► VPS decrypts, calls agent
VPS ──encrypted frame {type:"stream-chunk"}──► Browser
VPS ──encrypted frame {type:"stream-end"}──► Browser
```

Endpoints to migrate to the encrypted channel (sorted by sensitivity):

| Endpoint | Migrate? | Why |
|---|---|---|
| `POST /portal/chat` | **Yes** | Live message bodies — primary leak |
| `POST /portal/search` | **Yes** | Search queries reveal interests |
| `GET /portal/messages` | **Yes** | Message history |
| `GET /portal/contacts` | **Yes** | Contact names + bodies |
| `GET /portal/wealth/*` | **Yes** | Financial data |
| `GET /portal/intel/*` | Yes (later) | War room briefs |
| `GET /portal/health` | No | Health check, no user data |
| `GET /static/*` | No | Bundles, fonts, images |
| `POST /api/login/passkey-*` | No (Phase 1), Yes (Phase 2) | Auth ceremony — handled separately |

Static assets stay on plain HTTPS (CF can cache them anyway, no benefit from encrypting bytes that have no user data).

### Files to create

**Browser side (SvelteKit):**

- `portal/src/lib/secure-channel.ts` — WS connection, handshake, frame encrypt/decrypt
- `portal/src/lib/noise-nk.ts` — Noise NK implementation (or thin wrapper around `@stablelib/x25519` + `@stablelib/chacha20poly1305` + `@stablelib/blake2s`)
- `portal/src/lib/secure-fetch.ts` — drop-in replacement for `fetch()` that routes through the channel
- `portal/src/lib/vps-identity.ts` — VPS identity key (built into bundle in Phase 1, fetched from passkey in Phase 2)

**VPS side:**

- `lib/portal-channel.js` — WebSocket server, handshake, frame router
- `lib/noise-nk-server.js` — Server-side Noise NK
- `lib/vps-identity.js` — Load identity key from tmpfs, sign/verify
- `scripts/generate-vps-identity.js` — One-time key generation
- `scripts/rotate-vps-identity.js` — Identity key rotation (graceful, with overlap window)

**Tests:**

- `tests/portal-channel.test.js` — Handshake correctness, replay rejection, key derivation, frame parsing
- `tests/noise-nk.test.js` — Cross-implementation test vectors (browser ↔ Node)

### Files to modify

- `agent-server.js` — Mount `/ws/secure` WS endpoint, route decrypted requests to the same handlers used by the existing HTTPS routes (extract request handlers into pure functions so they can be called from either path)
- `portal/src/routes/(app)/chat/+page.svelte` — Use `secureFetch` instead of `fetch`
- `portal/src/routes/(app)/search/+page.svelte` — Same
- `portal/src/routes/(app)/wealth/+page.svelte` — Same
- `portal/src/routes/(app)/contacts/+page.svelte` — Same
- `portal/src/lib/api.ts` (if it exists, otherwise create) — Centralize the secure-fetch routing
- `scripts/provision-customer.sh` — Generate VPS identity key after master key setup, write public key to nginx-served path
- `scripts/server-setup.sh` — Add `/etc/mycelium/` directory creation

### VPS identity in the JS bundle (Phase 1)

For Phase 1 we embed the VPS identity public key directly in the SvelteKit build via `import.meta.env.PUBLIC_VPS_IDENTITY_KEY`. The build command reads it from `/etc/mycelium/vps-identity.pub` at build time. This means each customer VPS produces its own bundle (which is already the case — the portal is built per-tenant on provision).

Trust assumption for Phase 1: **trust on first build**. CF can swap the bundle in transit, so the JS the browser executes might have a different pinned key. Phase 2 closes this gap via passkey binding.

### Channel lifecycle

- Open on portal page load
- Single channel per browser tab (singleton pattern)
- Auto-reconnect with exponential backoff if dropped (re-handshake on each reconnect — no session resumption in v1, keeps it simple)
- Idle timeout: 30 minutes of no traffic → close (PWA can re-open on user activity)
- Heartbeat: encrypted ping every 25 seconds to keep CF's WebSocket idle timer happy (~100s default)

### Key rotation

- Session keys rotate via Noise's built-in `rekey()` after every 1 GiB of data or 1 hour, whichever comes first
- Long-term VPS identity key rotates manually via `scripts/rotate-vps-identity.js` — generates new keypair, signs the new public key with the old one, publishes both for a 7-day overlap window, then retires the old one

### Testing strategy

1. **Unit tests** for Noise NK in both browser (`vitest`) and Node (`node --test`) — load shared test vectors from `tests/fixtures/noise-nk-vectors.json`
2. **Integration test**: spin up agent-server in test mode, open WS from a Node WS client, run handshake, send fake chat, verify response
3. **Browser test**: Playwright spec that loads the portal, opens dev tools, asserts chat traffic is binary frames not JSON
4. **CF compatibility test**: deploy to a test subdomain (`test-secure.mycelium.id`), verify WebSocket frames pass through CF proxy without modification (CF supports WS by default but worth confirming)
5. **Replay test**: capture a frame, replay it, assert rejection
6. **Downgrade test**: try to send a plaintext JSON frame after handshake, assert connection closed

### Performance targets

- Handshake latency: < 50ms additional over WS open (one round trip)
- Per-frame overhead: < 1ms encrypt + decrypt on a typical phone (ChaCha is fast, no AES-NI dependency)
- Bandwidth overhead: 24 bytes per frame (counter + tag) + ~10% from base64 if we ever fall back to text frames (we won't — binary frames)

---

## Phase 2 — Passkey-bound identity verification

### What this closes

Phase 1 leaves a hole: CF serves the JS bundle, so CF could swap the embedded VPS identity key with one CF controls, then MITM the Noise handshake. Phase 2 binds the VPS identity to something CF can't touch — the user's passkey.

### Approach

Use the WebAuthn **`prf` extension** to derive a stable per-passkey symmetric key, and store the trusted VPS identity fingerprint encrypted with that key.

WebAuthn PRF support (as of 2026):
- Chrome/Edge: yes (since 2023)
- Firefox: yes (since 2024)
- Safari (macOS/iOS): yes (since iOS 17.4 / Safari 17.4)
- Hardware keys: depends on FIDO2 spec compliance — most modern keys support it

For users on browsers without PRF: fall back to IndexedDB-only TOFU pinning (Phase 1's level of protection) and show a warning.

### Registration flow

```
1. User registers passkey (existing flow)
2. After registration, browser requests PRF assertion with salt = "mycelium-vps-identity-v1"
3. Browser receives 32-byte PRF output → derive symmetric key K_pin via HKDF
4. Browser fetches VPS identity public key from /api/vps-identity (server-side, HTTPS)
5. Browser computes fingerprint = BLAKE2s-128(identityPubKey)
6. Browser encrypts {fingerprint, registeredAt} with K_pin → ciphertext blob
7. Browser POSTs blob to /portal/identity-pin (stored in user record on VPS, encrypted at rest with the existing master key — double-wrapped)
8. Display fingerprint to user with "this is your VPS — verify it matches what you see on the server console"
```

### Login flow (every subsequent connection)

```
1. User authenticates with passkey
2. Browser requests PRF assertion with the same salt
3. Browser derives K_pin
4. Browser fetches the encrypted pin blob from VPS
5. Browser decrypts with K_pin → expected fingerprint
6. Browser computes actual fingerprint of the identity key currently embedded in the bundle
7. If mismatch: refuse to open the secure channel, show big red warning "Your VPS identity has changed since registration — this could mean the VPS was reprovisioned, OR Cloudflare is attempting to MITM your connection. Verify the new fingerprint out of band before continuing."
8. If match: proceed with Noise NK handshake using the verified identity
```

### CLI fingerprint verification

`scripts/show-vps-identity.sh` on the server prints the fingerprint in a format the user can compare:

```
$ ssh handle.mycelium.id sudo /usr/local/bin/show-vps-identity
VPS Identity Fingerprint:
  9f3a-b41e-2d88-c705-1e6b-8aa9-3f2c-47de
First registered: 2026-04-07T14:23:00Z
```

User verifies this matches what their browser shows on first registration. SSH is not CF-proxied, so this verification path bypasses CF entirely.

### Key rotation considerations

If the VPS identity key is rotated (e.g., after a security incident), the user's passkey-pinned fingerprint becomes stale. Recovery:

1. User connects, browser detects fingerprint mismatch
2. User SSH's to VPS, runs `show-vps-identity`, gets new fingerprint
3. User clicks "I've verified the new fingerprint" → re-runs registration flow → updates pin

Don't auto-update on mismatch — that would defeat the protection.

### Files to add

- `portal/src/lib/passkey-pin.ts` — PRF derivation, fingerprint encryption/decryption
- `portal/src/routes/(app)/security/+page.svelte` — UI for viewing and re-registering pins
- `agent-server.js` — `/portal/identity-pin` GET/PUT endpoints
- `lib/db-d1.js` — `identity_pins` table (per-user encrypted blob)
- `migrations/110_identity_pins.sql` — table schema
- `scripts/show-vps-identity.sh` — CLI fingerprint display

### Honest limitations of Phase 2

- **Doesn't protect first registration**: if CF has compromised the JS bundle on the very first registration, the registration flow itself could be backdoored. The user would pin a CF-controlled fingerprint and never know. The mitigation is: do first registration on a network you trust, or use the SSH out-of-band verification before completing registration.
- **Doesn't protect against the JS being modified to skip the verification**: CF could rewrite the verification function to always return success. **There is no defense against this within the browser-via-CF threat model.** The user must either trust CF to not modify the bundle, or move to a trusted code delivery channel (Phase 4).
- **TOFU window**: between bundle download and pin verification, there's a small window where a compromised bundle could exfiltrate the K_pin or PRF output. Mitigated by not transmitting K_pin off-device.

What Phase 2 *does* protect: ongoing session integrity. After the first successful pin, any future attempt by CF to swap the identity key will be detected (unless they also rewrite the verification logic at the same time, which is detectable via the IndexedDB hash pin).

### Defense-in-depth: bundle hash pinning

Combined with passkey pinning:

1. On first load, browser computes SHA-256 of the loaded JS bundle
2. Stores in IndexedDB
3. On every subsequent load, computes hash again, compares
4. If different: alert "the portal code has changed — this is normal if Mycelium was updated, but verify the change at github.com/mycelium-id/mycelium/releases"
5. User clicks "this update is expected" → new hash pinned

This catches passive bundle swapping. It does NOT catch a CF that swaps both the bundle AND the verification code consistently — but combined with the passkey-bound identity check (which uses crypto CF can't forge), the attack surface is significantly narrower.

---

## Phase 3 — Traffic analysis resistance

### What this closes

Phases 1+2 hide content but leave metadata observable: frame sizes, send timing, idle vs active periods. An observer at CF can infer:

- When the user is actively typing (frequent small frames)
- Approximate message length (frame size)
- When the user reads vs writes (asymmetric traffic)
- Active vs idle sessions (heartbeats vs nothing)

### Mitigations

**Frame padding**:

Round every encrypted frame up to the next bucket size:

| Bucket | Use case |
|---|---|
| 256 B | Small chat messages, acks |
| 1 KiB | Average chat message |
| 4 KiB | Long chat message, search query with results |
| 16 KiB | Document preview, contact list page |
| 64 KiB | Large response chunk |

Padding bytes are zeros inside the AEAD-protected payload, with a length field at the start. Server strips padding after decryption.

Cost: ~1.5x average bandwidth overhead. Acceptable for portal traffic (low volume).

**Heartbeat traffic**:

Every 5 seconds, the browser sends a "noise" frame in the smallest bucket (256 B) with type=`heartbeat`, regardless of user activity. The VPS responds with an equivalent frame. This:

- Masks when the user is actively typing
- Keeps the WS connection warm through CF's idle timeout
- Adds ~10 KB/min of cover traffic (negligible)

**Send-time jitter**:

User-initiated sends are delayed by a random 0–50ms interval before being sent. Combined with heartbeats, this defeats keystroke timing analysis on chat messages.

**Cover messages on page load**:

When the portal loads, browser sends 3–10 random-bucket-sized cover frames mixed with the real initial requests (history fetch, contacts, etc). Server responds with cover frames mixed in. Defeats "page X has signature Y" fingerprinting.

### When to enable

Phase 3 has real UX cost (10ms+ added latency, bandwidth, battery on mobile). I'd ship it as an **opt-in toggle** in Settings → Privacy:

- Default: off (Phase 1+2 protections only)
- "Enhanced privacy" toggle: on (Phase 3 mitigations active)
- "Maximum privacy" toggle: on + larger padding buckets + more heartbeats

Document the tradeoffs honestly so users can pick their threshold.

### Files to modify

- `portal/src/lib/secure-channel.ts` — Add padding logic, heartbeat scheduler, jitter
- `lib/portal-channel.js` — Strip padding after decryption, send heartbeat responses
- `portal/src/routes/(app)/settings/+page.svelte` — Privacy toggle UI

### Out of scope for Phase 3

- Defeating *global passive adversary* traffic analysis (requires Tor-like mixing, way too much overhead)
- Hiding the fact that you're using Mycelium at all (the SNI / DNS leak that, even with ECH)
- Disguising as other types of traffic (steganographic tunneling)

These belong to a hypothetical Phase 5 "Tor-mode" that I don't think is justified for the threat model.

---

## Phase 4 (future) — Trusted code delivery

### The problem Phase 4 solves

Phases 1–3 all share one residual risk: **CF serves the JavaScript that does the encryption**. If CF is malicious or compromised, they can serve a backdoored bundle that exfiltrates keys before the encryption ever happens. No amount of cleverness inside the browser fixes this — the browser is executing whatever code CF delivers.

### Options (in rough order of effort vs effectiveness)

**4a. Browser extension**

- User installs "Mycelium Vault Client" extension from Chrome / Firefox / Safari stores
- Extension contains the crypto code, signed by the vendor (us)
- Extension intercepts portal API calls and routes them through its own encrypted channel
- CF can no longer modify the crypto code because the browser validates the extension signature against the store's public key
- The portal page itself becomes a thin shell that delegates all crypto to the extension
- Extensions auto-update through the store, not through CF

Cost: ~2 weeks of work, plus ongoing store review pain. But this is the *real* answer to "trust CF with our code."

**4b. Native app**

- macOS / iOS / Android / Windows / Linux app
- Bundles all the crypto, talks to the VPS directly (not through a browser)
- Same trust model as the browser extension but with more polish
- Existing iOS app (`mycelium-ios/`) is already in the working directory list — extending it for full portal coverage is a natural fit

Cost: months. But aligns with the "vault" positioning and the existing iOS work.

**4c. Subresource Integrity + Signed Updates**

- Pin the JS bundle hash in a manifest signed by the VPS identity key
- Browser fetches the manifest first, verifies signature, then validates each resource against the manifest before executing
- The manifest itself has to come from somewhere trusted — back to chicken-and-egg unless we use a separate channel (e.g., the user's passkey storing the expected manifest hash)

Cost: ~1 week, but the user experience is awkward (verification failures need a clear recovery path).

**4d. Self-hosted bundle**

- User downloads a static portal bundle from GitHub releases (signed)
- User serves it themselves — file:// URL or local HTTP server
- Browser loads the trusted bundle, talks to the VPS directly via fetch/WS
- Cloudflare is bypassed entirely for the portal code, only used for VPS proxying

Cost: low effort to provide; high friction for users.

### My recommendation

Skip 4c and 4d. Aim for **4a (browser extension)** as the canonical "trusted code" path within ~6 months of Phase 1–3 landing, and continue investing in **4b (native iOS app)** for users who want a fully integrated experience.

In the marketing copy, position as a tiered trust model:

1. **Web portal (default)** — encrypted channel, CF can see metadata but not content. Good enough for most.
2. **Browser extension** — closes the JS-delivery hole. Recommended for sensitive use.
3. **Native app** — fully integrated, no browser at all. Best for daily driver.

---

## Rollout plan

### Phase 1 (target: 2–3 weeks of focused work)

- Week 1: Noise NK implementation + tests, VPS identity key generation, WS endpoint stub
- Week 2: Migrate `/portal/chat` and `/portal/search` to the channel, verify with sandbox VPS, end-to-end tests
- Week 3: Migrate remaining endpoints, stress test, document, deploy to owner VPS first, then 0mm customer VPS

Rollback path: feature flag in `agent-server.js` (`SECURE_CHANNEL_ENABLED`), defaults to off, flip on after smoke tests pass. If broken, flip off and the portal falls back to the existing HTTPS routes.

### Phase 2 (target: 1–2 weeks after Phase 1)

- PRF extension support detection, registration UI flow
- Server-side identity-pin storage and retrieval
- Fingerprint mismatch warnings + recovery flow
- SSH-based verification script

Phase 2 is opt-in: existing users keep working with TOFU pin only, opt in via Settings → Security → "Bind portal identity to my passkey".

### Phase 3 (target: opt-in toggle, ship whenever ready)

- Padding + heartbeats are independent of Phase 2, can ship after Phase 1
- Wire to Settings → Privacy toggle
- Document bandwidth/latency cost

### Phase 4 (target: TBD, after Phase 1–3 have soaked)

- Decide on extension vs native-first
- Probably native iOS first (existing repo), then Chrome extension

---

## Verification

After Phase 1, the marketing claim updates to:

> *When you use the Mycelium portal, your browser opens an encrypted channel directly to your VPS. Every chat message and search query is encrypted in your browser before it enters Cloudflare's network, using ephemeral keys negotiated via the Noise Protocol with your VPS's long-term identity key. Cloudflare sees that a connection exists and how much data flows through it. Cloudflare cannot read message contents, search queries, or any payload data — even during an active session.*

After Phase 2:

> *Your VPS's identity is bound to your passkey on first registration. If Cloudflare ever attempted to substitute a fake VPS identity, your browser would refuse to connect and alert you, because the substitute would not match the fingerprint your passkey holds.*

After Phase 3:

> *Optional traffic analysis resistance: enable Enhanced Privacy in Settings to pad messages to fixed bucket sizes and inject cover traffic, so Cloudflare cannot infer message length, typing patterns, or active session timing.*

After Phase 4 (extension):

> *For maximum privacy, install the Mycelium browser extension. The extension delivers the encryption code through your browser's signed extension store, eliminating Cloudflare's role in code delivery entirely.*

---

## Files / changes summary

| Phase | Files added | Files modified |
|---|---|---|
| 1 | `portal/src/lib/secure-channel.ts`, `portal/src/lib/noise-nk.ts`, `portal/src/lib/secure-fetch.ts`, `portal/src/lib/vps-identity.ts`, `lib/portal-channel.js`, `lib/noise-nk-server.js`, `lib/vps-identity.js`, `scripts/generate-vps-identity.js`, `scripts/rotate-vps-identity.js`, `tests/portal-channel.test.js`, `tests/noise-nk.test.js`, `tests/fixtures/noise-nk-vectors.json` | `agent-server.js`, `portal/src/routes/(app)/chat/+page.svelte`, `portal/src/routes/(app)/search/+page.svelte`, `portal/src/routes/(app)/wealth/+page.svelte`, `portal/src/routes/(app)/contacts/+page.svelte`, `scripts/provision-customer.sh`, `scripts/server-setup.sh` |
| 2 | `portal/src/lib/passkey-pin.ts`, `portal/src/routes/(app)/security/+page.svelte`, `migrations/110_identity_pins.sql`, `scripts/show-vps-identity.sh` | `agent-server.js` (add `/portal/identity-pin` endpoints), `lib/db-d1.js` (add `identityPins` namespace), `portal/src/lib/secure-channel.ts` (verify pin before handshake) |
| 3 | — | `portal/src/lib/secure-channel.ts` (padding + heartbeats + jitter), `lib/portal-channel.js` (strip padding), `portal/src/routes/(app)/settings/+page.svelte` (privacy toggle) |
| 4 | New repo: `mycelium-extension/` (Chrome/Firefox/Safari) OR extend `mycelium-ios/` | TBD |

## Dependencies to add

- `@stablelib/x25519` (browser + Node) — X25519 ECDH
- `@stablelib/chacha20poly1305` (browser + Node) — ChaCha20-Poly1305 AEAD
- `@stablelib/blake2s` (browser + Node) — BLAKE2s hash
- `ws` (Node) — already present, used for WebSocket server
- `noise-protocol` or hand-rolled minimal Noise NK implementation built on the above primitives

All dependencies are pure JS, ~30 KB combined, no native bindings.

## Open questions

1. **Per-tenant build vs runtime fetch of VPS identity key in JS bundle**: build is cleaner but means the bundle is per-VPS. Runtime fetch is more flexible but adds a TLS-protected fetch through CF for the public key (which CF could swap, but it's verified by the passkey pin in Phase 2 anyway). My lean: build, since the portal is already per-tenant.

2. **Document upload streaming**: WS frames are bounded. For multi-MB uploads, do we stream as multiple encrypted frames or fall back to encrypted-then-uploaded blob via HTTPS? Lean: stream as frames for simplicity, with a 4 MiB upload limit per file in v1.

3. **Service worker caching**: a service worker that caches the bundle and refuses to update without the passkey pin would close some of the Phase 2 gaps. Worth exploring in Phase 2.5.

4. **Audit budget**: Noise implementations have been audited extensively, but our specific frame format and the agent-server integration would benefit from a third-party security review before claiming "Cloudflare cannot read your messages" publicly. Budget for this in Phase 1 wrap-up.
