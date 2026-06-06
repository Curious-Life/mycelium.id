# Design — Inter-Instance Communication (Federation): Matrix + lexicon records

**Date:** 2026-06-05
**Status:** Design (sweep-first: repo swept with file:line citations; **no code yet — build after this is accepted and the Tier-0/1 spikes return GO**). Federation is gated until V1 ships + validates (`CLAUDE.md`, `docs/V1-BUILD-SPEC.md`) — this doc is the plan we pick up *when that gate opens*, plus the spikes that de-risk it now.
**Scope:** how two or more Mycelium boxes talk to each other. Near-term drivers (set by the operator): **(1) real-time direct agent↔agent and human↔agent chat**, and **(2) shared context pools** (mutual-opt-in shared spaces). Resonance/discovery is **explicitly deferred** to a later tier.
**Companion to** `docs/legacy/SOCIAL-SHARING-SPEC-from-legacy.md` (the authoritative social *content* design, Phases 1–5), `docs/REDESIGN-LIVING-SPEC.md` §2.7 (federation surface inventory), and `docs/DESIGN-relay-and-gateway-2026-06-04.md` (the `<handle>.mycelium.id` reachability this rides on).

**Revision history:**
- **v1 (2026-06-05)** — initial tiered design from the repo sweep.
- **v2 (2026-06-05)** — after the **Tier-0 spike** (`spike/federation-tier0/`, **GO 10/10**) and four verification sweeps read back against live code. Two pivots: **(P1)** corrected the Caddy routing claim — the built Caddyfile is a single `reverse_proxy → :4711`, **no** `/{p,s}`→`:8788` path-split, so federation routes need no Caddy change (§2.2); **(P2)** the dormant `connections.js` connect-request is sent **UNSIGNED** (`connections.js:154-166` defers signing to a non-existent Worker tier) — Tier-0 must add the sign-and-verify-via-`did:web` layer, which the spike prototyped and proved (§2.5, A3.5). Added the verification table (§8).
- **v3 (2026-06-05)** — after the **Tier-1/A1 spike** (`spike/federation-tier1-matrix/`, **GO 9/9**). One pivot: **(P3) Conduwuit is archived (read-only since 2026-01-19)** → switch Tier-1 to its official community successor **Continuwuity** (Rust, lightweight, actively released). A1's crux is proven: the modern crypto helper (`@matrix-org/matrix-sdk-crypto-wasm`, vodozemac — **no libolm**) runs the full Megolm lifecycle headlessly in our Node runtime, decrypts on an unverified device, and recovers room keys across a restart. Residual Tier-1 risk narrowed to *homeserver integration* (sync loop + persistent store + S2S federation). Updated §3 Tier-1, §5 (A1/A2), §6, §8, §9.

---

## TL;DR

- **The federation *content* layer is already in the repo — dormant, not greenfield.** `src/db/connections.js` already federates: it parses `@handle@domain`, does a WebFinger lookup, and POSTs a **lexicon-typed** payload (`$type: 'social.mycelium.connect-request.v1'`, `connections.js:135`) to the remote's `federation` link, with real SSRF defenses (`connections.js:14-37, 102-169`). The spaces/rooms/knowledge "shared context pool" substrate exists too (`src/db/spaces.js`, `space-rooms.js`, `space-conversations.js`, `space-knowledge.js`). None of it is wired into the V1 tool surface yet (`src/db/index.js:5-9` says so explicitly). **So the question is not "build federation" — it's "pick the transport that carries these already-designed payloads, and add a real-time channel."**
- **Identity is the one true root, and it's federation-grade today.** Every box has one Ed25519 keypair derived from the master key, verifiable by anyone with just the public key (`src/identity/identity.js:28-89`); `publicIdentity()` already returns `{handle, publicKey, algo:'ed25519'}` "safe to publish / put in WebFinger/DID later" (`identity.js:74-77`). **Tier 0 is just *serving* this as `did:web` + WebFinger over the relay we already run.** It commits us to nothing above it and it un-blocks the dormant `connections.js` (which already *expects* a WebFinger `federation` rel that nothing currently serves).
- **The two-stack research framing ("Matrix for chat, AT-Proto PDS for data") is directionally right but over-weight.** Adopting both stacks wholesale fights Mycelium's thesis (*"the network coordinates; it doesn't store"* — `docs/VISION.md`) and introduces a second identity model. The reshape: **Matrix is the near-term real-time trunk** (don't reinvent Megolm), **AT-Proto contributes identity (`did:web`) + lexicon *schemas* only — not a running PDS** (the code already speaks `social.mycelium.*` lexicons), and the **lighter signed-HTTP coordination** path (already started in `connections.js`) carries non-real-time records and the deferred discovery tier.
- **Two hard guardrails, non-negotiable.** (a) **No raw cognitive signatures/embeddings ever leave the box in public form** — embedding inversion is real (`CLAUDE.md` §7); only coarse, consented, DP-noised signals federate, routed through the legacy LSH/DP/SMPC design. (b) **Every cross-instance send goes through an explicit egress chokepoint** (`/matrix/send`, mirroring the `/telegram/send` pattern — `CLAUDE.md` §11) and **every received artifact persists to the vault + notifies once** (`CLAUDE.md` §12).
- **Next action is two spikes, not a build:** Tier 0 (`did:web`/WebFinger from the existing identity over the relay + a signed `connect` round-trip between two local boxes) and Tier 1 (the **known-hard** part: an Ed25519/Olm-capable Matrix *bot* that can send/receive **E2EE** messages headlessly). Matrix appservices historically do **not** do E2EE without a crypto-helper — that is the single biggest unknown and must be proven before anything depends on it.

---

## 1. What the network actually needs (and what it must NOT become)

`docs/VISION.md` is explicit: *"Mastodon failed because federation is expensive — servers store everyone's posts. Mycelium solves this: each user hosts their own data. The network coordinates; it doesn't store."* That single sentence is the design constraint. It rules **out** any architecture where instances replicate each other's full state, and rules **in** an architecture of **sovereign boxes exchanging authenticated, signed messages** — request/response for coordination, an encrypted channel for live chat, and a durable local mirror for anything worth keeping.

The operator's two near-term drivers decompose cleanly:

| Driver | Shape | Natural transport |
|---|---|---|
| **Real-time agent↔agent / human↔agent chat** | synchronous, membership, forward-secrecy desirable | **Matrix** (Megolm group E2EE) |
| **Shared context pools** (shared spaces) | small membership, durable structured records, occasional real-time | **Matrix room *as the live surface* + lexicon records mirrored into each box's vault** |
| Resonance / discovery *(deferred)* | many-to-many, privacy-critical, mostly async | **signed-HTTP coordination + LSH/DP/SMPC** (the dormant `connections.js` path) |

The thing to resist: making Matrix *or* a full atproto relay the trunk for **discovery**. Both replicate (a Matrix room copies its event DAG to every participating server; an atproto firehose is a public replication bus). That is fine for small, consented memberships and exactly wrong for open many-to-many discovery — which is why discovery stays on the lighter signed-HTTP tier.

---

## 2. Current state — what's already built (with citations)

A sweep of `src/` shows the federation substrate is **much further along than `REDESIGN-LIVING-SPEC.md` §2.7 implies** (that inventory was taken against the `packages/worker` tree; the V1 Node tree has since absorbed a lot of it, dormant).

### 2.1 Identity (live, federation-grade)
- `src/identity/identity.js:28-89` — one Ed25519 keypair, HKDF-derived from `USER_MASTER` (`info = "mycelium-identity-v1"`), memory-only, reproducible. `sign()`/`verify()`/`verifyWithPublicKey()` and `publicIdentity() → {handle, publicKey, algo:'ed25519'}`.
- `src/remote/managed-claim.js` — already signs handle claims to the control-plane with this identity (proof-of-master-key without revealing it). The verification pattern is the same one federation peers would use.

### 2.2 Reachability (live) — *corrected in v2 (P1)*
- `src/remote/*` + `docs/DESIGN-relay-and-gateway-2026-06-04.md` — `<handle>.mycelium.id` resolves to the user's Mac via **SNI-passthrough relay → Caddy on the Mac** (TLS key born local, never on the relay). **Correction:** the *built* Caddyfile is a **single `reverse_proxy 127.0.0.1:4711`** (`renderCaddyfile`, `src/remote/runtime.js:97`) — there is **no** `/{p,s}`→`:8788` path-split (that was the relay-and-gateway design's *intended* split, not what ships). So **everything** already routes to `:4711`. **Adding `.well-known/did.json` + `.well-known/webfinger` + `/federation/*` is purely a route on the `:4711` Express app (`src/server-http.js`, after line 108) — no Caddy change, no new infra.** The existing `/.well-known` CORS middleware (`server-http.js:71-77`) covers the new well-knowns automatically, and `'well-known'` is already a reserved handle (`src/db/profiles.js:54`) so nothing can shadow it.

### 2.3 Federation content layer (ported, DORMANT — not wired to tools)
- `src/db/connections.js` — the social graph **with cross-instance connect already implemented**: `@handle@domain` → WebFinger at `https://<domain>/.well-known/webfinger?resource=acct:...` (`:106`) → POST a `social.mycelium.connect-request.v1` payload to the discovered `federation` link (`:135-163`). SSRF defenses are real and documented (`:21-29`: domain regex, HTTPS-only, `redirect:'manual'`, abort timeouts). `computeOverlap()` (`:334-445`) does territory-label matching + shape classification (Twin Minds / Deep Collaborators / …).
- `src/db/spaces.js`, `space-rooms.js`, `space-conversations.js`, `space-knowledge.js`, `space-access.js` — the **shared-context-pool** primitive: a space is a `users` row with `type='space'` (so messages address a space like a user — `spaces.js:1-13`); nested rooms with cover-doc "doors" (`space-rooms.js:1-17`); per-(space,user) conversation threads; shared knowledge entries with per-entry visibility (`space-knowledge.js:1-7`). Name/essence auto-encrypted via the vault (`space-rooms.js:14-16`).
- `src/db/identity-channels.js` — **the key reuse point for Matrix**: a single registry of `(channel_kind, channel_value) → owner_user_id` (`:1-16`), already the abstraction for telegram/discord/etc. **A Matrix MXID is just `channel_kind='matrix'`** — inbound routing, ownership, and per-channel `delivery_enabled`/`auth_enabled` flags already exist.
- `src/db/index.js:5-9` — confirms the above are **present but not assembled** into the live `db` object: *"auth/session/federation/space-rooms/etc. are present in src/db/ and ready to wire when their tools land."* `spaces`/`space-knowledge`/`public-presence` **are** wired; `connections`/`space-rooms`/`space-conversations` are not.

### 2.4 Lexicon naming already in use
The code already types its federation payloads as `social.mycelium.*` lexicons (`connections.js:135`). So "adopt AT-Proto custom lexicons" is **partially already the convention** — we formalize it, we don't invent it.

### 2.5 What's genuinely missing — *Tier-0 items spike-validated in v2*
1. **Serving** `.well-known/webfinger` + `.well-known/did.json` from the box (today only OAuth's `oauth-protected-resource` well-knowns are served — `src/server-http.js:71-108`). The dormant `connections.js` *consumes* a `federation` rel nothing yet *serves*. **Spike: proven (A3.1/A3.3) — did.json built from the real identity round-trips its ed25519 key through `publicKeyMultibase`, and a `rel`-includes-`federation` WebFinger link is exactly what `connections.js:115` finds.**
2. **The real-time channel** — there is no synchronous transport at all. Matrix fills this. *(Tier-1; NOT spiked yet — assumption A1 is the next, heavier spike.)*
3. **An inbound `/federation/connect` handler with signature verification.** **GAP confirmed by spike (P2):** the outbound `requestRemote` (`connections.js:154-166`) sends the connect-request **UNSIGNED** — its comment defers signing to "the Worker level," which does not exist in the single-user box. **Tier-0 must add a local sign-and-verify layer: the sender signs the canonical request with the box identity; the receiver resolves the sender's `did:web` and verifies.** The spike prototyped exactly this and it holds: valid→accept, **tampered body→401, forged sender (wrong key)→401** (A3.5/b/c, fail closed).
4. **Egress chokepoint + vault persistence** for the new channel (the `/matrix/send` analogue; received-message persistence + single notification). *(Tier-1.)*

> **Tier-0 spike: `spike/federation-tier0/` — VERDICT GO (10/10).** Exercises the **real** `src/identity/identity.js` + `src/db/connections.js requestRemote` (fake in-memory `d1Query`, loopback fetch-shim) across two `node:http` boxes. See `spike/federation-tier0/RESULT.md`.

---

## 3. The tiered design

Each tier is independently useful and commits us to nothing above it. **Tier 0 is the prerequisite for everything; Tiers 1–2 are the near-term build; Tier 3 is deferred.**

### Tier 0 — Identity bridge: `did:web` + WebFinger (prerequisite, cheap)
Serve the existing identity as discovery documents over the relay:
- `GET https://<handle>.mycelium.id/.well-known/did.json` → a DID document for `did:web:<handle>.mycelium.id` whose `verificationMethod` is the box's Ed25519 public key (`identity.publicIdentity().publicKey`), and whose `service` array advertises the box's federation endpoint and (Tier 1) Matrix endpoint.
- `GET /.well-known/webfinger?resource=acct:<handle>@<handle>.mycelium.id` → `links` including a `self`, the `did:web` link, and the `federation` rel that `connections.js:115` already looks for.
- Wire the dormant `connections.js` inbound side: `POST /federation/connect` verifies the sender's signature against their published DID key, then writes the pending connection.

**Why first:** it's ~90% present (identity + relay + the consuming code), it leaks nothing (a public key and a handle are already public by design), and it's the single primitive both Matrix and lexicon-records consume. **Decision D-FED-1 (locked): the box's sovereign Ed25519 identity is the root; `did:web` is its published form; everything else maps onto it.**

### Tier 1 — Real-time E2EE messaging via Matrix (near-term primary)
Run **Continuwuity** (Rust homeserver, lightweight single binary, SQLite/RocksDB — the official community successor to **Conduwuit, which was archived read-only 2026-01-19**; footprint to be confirmed in the A2 spike) as an **optional sidecar**, alongside the frpc/Caddy/embed/enrich sidecars the box already manages.

> **Tier-1/A1 spike: `spike/federation-tier1-matrix/` — VERDICT GO (9/9).** The crypto-lifecycle crux is proven: `@matrix-org/matrix-sdk-crypto-wasm` (vodozemac, **no libolm**) loads headless in Node v22 and runs the full Olm→Megolm round-trip between two bot devices with **no human verification**; it decrypts on an **unverified** device (verification is a trust *shield*, not a gate) and **recovers room keys across a restart** via key export/import. The crypto helper a headless bot needs **exists and works in our runtime.** Residual (next spike, before bundling): real homeserver sync loop + persistent store backend + S2S federation. See `RESULT.md`.

- **Addressing:** the box registers/controls one Matrix user; its MXID is stored as `identity_channels` `kind='matrix'` (`src/db/identity-channels.js`). The box's `did.json` advertises the MXID as a service endpoint, so a peer resolves `@handle@…` → DID → MXID.
- **Identity reconciliation (the impedance mismatch):** Matrix has its *own* identity (device keys, cross-signing) that is **not** the Mycelium root key. We do **not** try to make Matrix device keys *be* the sovereign identity. Instead: the Mycelium identity is bound to the MXID by a **signed claim published in `did.json`** ("`did:web:alice…` asserts control of `@alice:…`", signed by the box key). Peers trust the MXID because the DID vouches for it. Optionally, message *bodies* carry a detached Mycelium-key signature for belt-and-suspenders sovereign attribution on top of Matrix's per-event Ed25519.
- **Forward secrecy is a feature with a consequence:** Megolm means **history is deliberately not reconstructable from the master key** — opposite to the rest of Mycelium. That's correct for *transit*, so we **persist every received message into the vault on arrival** (re-encrypted under a `scope='matrix'` vault key via the existing scope guardian, `src/crypto/crypto-local.js`). **Matrix = transport; the vault = the durable, master-key-reconstructable store.**
- **Egress + persistence discipline:** agent→Matrix output goes through a single `/matrix/send` chokepoint (the `/telegram/send` pattern, `CLAUDE.md` §11); inbound messages persist once + notify once (`CLAUDE.md` §12).
- **What we do NOT do:** make Matrix mandatory, make it the identity root, or route discovery through Matrix rooms.

### Tier 2 — Shared context pools (near-term primary)
Make the existing `spaces`/`space-rooms`/`space-knowledge` substrate cross-instance. **Recommended shape: a shared space ⇄ a Matrix room** (reuse Tier 1's membership + E2EE + real-time), **with the durable structured payload mirrored as `social.mycelium.*` lexicon records into each member box's `space_knowledge`/`space_rooms` tables.**
- The Matrix room gives membership management, E2EE, and live updates for free.
- The lexicon-record mirror gives **sovereignty + portability + durability**: each box keeps its own decryptable copy of the shared knowledge, survives leaving the room, and stays queryable by the local topology/search engines. This is the "everyone hosts their own data" promise made concrete.
- **Lexicons** (formalize what `connections.js` already started): `social.mycelium.space.v1` (space metadata), `social.mycelium.room.v1`, `social.mycelium.knowledge.v1` (a shared knowledge entry), `social.mycelium.signature.v1` (cognitive fingerprint — **Tier 3 / privacy-gated, see §4**), `social.mycelium.connect-request.v1` (exists). These are **schemas/wire-contracts**, validated on ingest — **not** a running atproto PDS/firehose.

**Decision D-FED-2 (proposed, confirm in spike): shared spaces ride Matrix rooms for the live surface + lexicon-record mirror for durability — we do NOT stand up a second atproto PDS.** Alternative considered: pure signed-HTTP federation extending `connections.js`. Rejected for near-term because it would require us to build membership, presence, and real-time delta sync that Matrix already provides — but kept as the fallback if the Matrix-room-as-space spike surfaces blockers.

### Tier 3 — Resonance / discovery (DEFERRED, do not build now)
The privacy-preserving "find kindred instances" layer. Stays on the **lighter signed-HTTP coordination** path (`connections.js` already POSTs signed lexicon payloads peer-to-peer) and the legacy **LSH → DP-noised centroids → SMPC precise** pipeline (`docs/legacy/SOCIAL-SHARING-SPEC-from-legacy.md` Phase 4–5). **Not Matrix, not a public firehose.** Listed here only so Tiers 0–2 are built without foreclosing it.

---

## 4. Security guardrails (non-negotiable)

1. **No raw signatures/embeddings federate in public form.** `social.mycelium.signature.*` is a cognitive fingerprint; publishing it openly is a plaintext leak (embedding inversion — `CLAUDE.md` §7, and the SPARSE design in the legacy spec). Signatures only ever leave the box **coarsened/DP-noised/consented**, and only via Tier 3's privacy pipeline. The `connect-request` payload's `profile.signature` field (`connections.js:140`) must be reviewed against this before Tier 0 ships — **flag: confirm what `signature` contains and that it is safe to send.**
2. **Explicit-send only.** All agent→peer egress through `/matrix/send` (and the future `/federation/send`). No free-form agent output reaches a wire (`CLAUDE.md` §11).
3. **Persist + notify once.** Every inbound message/record persists to the vault and notifies exactly once (`CLAUDE.md` §12), re-encrypted under the scope guardian.
4. **Fail closed.** Unknown/unsigned peer → reject. Missing DID key → refuse. Bad signature → drop + audit. Never a permissive default (`CLAUDE.md` §3).
5. **SSRF stays closed.** Keep `connections.js`'s existing defenses (HTTPS-only, no-redirect, domain allowlist regex, timeouts) on every new outbound fetch.
6. **Scope isolation.** Federated data lives under dedicated scopes (`matrix`, `space:<id>`) so the existing crypto scope guardian (`src/crypto/crypto-local.js`) contains a federation bug to the federation scope.

### 4.1 Post-audit residuals (adversarial audit, 2026-06-06 — disposition)

The Tier-0/0b + Phase-A merge (#103) had a focused security review **and** a red-team/adversarial audit. No internet-reachable HIGH. Findings and disposition:

- **FIXED in #103:** connect-response forgery → bound to the verified `did:web` signer host (regression test); confused-deputy SSRF (unconstrained WebFinger `fedLink.href`) → https + host-must-match-domain; did:web IP-literal/loopback hosts rejected; `$type` validation + §7 vector tripwire on the connect-response path; `/spaces/:id/shares` requires an accepted connection.
- **3b — DNS-rebinding SSRF — FIXED (this branch):** `src/federation/ssrf.js` `assertResolvesPublic()` resolves the host and refuses private/loopback/link-local/ULA/CGNAT addresses before the outbound did.json/WebFinger fetch (wired in `resolveDidKey` + `resolveFederationEndpoint`). **Residual:** a TOCTOU window remains without full IP pinning (resolve→fetch re-resolves); acceptable for V1 (https-only + GET + no-redirect + 5s timeout + no body reflection bound it). Follow-up for a hardened build: pin the resolved IP for the fetch (custom `lookup`/agent).
- **1b — single-identity-per-host acceptance — NO V1 FIX (by design); V2 item.** Acceptance binds to a host's `did:web` key, which signs for *all* handles at that host. A host *operator* could therefore forge acceptances among handles **at their own host**. This is inherent to `did:web` (one key per host) and has **no V1 exposure** — V1 is one identity per box (one handle per host), so there are no sibling handles to confuse. The fix belongs in **V2 multi-tenant**: per-user signing keys (not host-level `did:web`), at which point acceptance must match the per-user key. Documented here so it is not silently assumed solved.

---

## 5. Verification gate — load-bearing assumptions to prove BEFORE building

Per `CLAUDE.md` ("hard evidence over paper reasoning"), nothing above gets built on until these are proven by a running spike, not argued on paper.

| # | Assumption | How to prove | Risk if false |
|---|---|---|---|
| **A1** | A headless Matrix **bot can send/receive E2EE (Megolm)** messages reliably. | ✅ **CRUX PROVEN — `spike/federation-tier1-matrix/` GO (9/9).** `matrix-sdk-crypto-wasm` (vodozemac, **no libolm**) runs the full Megolm lifecycle headlessly in Node v22; decrypts on an unverified device; recovers room keys across a restart via export/import. | Largely retired — the crypto helper exists and works in our runtime. **Residual → A1b.** |
| **A1b** *(new, v3)* | The proven crypto core works **end-to-end against a real homeserver** (sync loop, bot login, client-vs-appservice) and over **S2S federation** between two boxes. | ✅ **HOMESERVER HALF PROVEN — `spike/federation-a1b-matrix/` GO 7/7.** Two headless `matrix-js-sdk` rust-crypto bots over a real homeserver: register→login→sync→Megolm room→send→**decrypt**; server stored only ciphertext. (Used Synapse — Continuwuity unobtainable in-sandbox; result transfers, E2EE is client-side.) **Residual:** S2S federation between two servers + a persistent crypto store, untested. | Largely retired. The remaining S2S/store work is standard Matrix engineering. |
| **A2** | **Continuwuity's** real footprint + federation cost fit a bundled sidecar on a user's Mac. *(Conduwuit is archived — P3.)* | Spike: run Continuwuity, measure RAM/CPU idle + under a small room, confirm S2S federation works through the relay (`:8448`/`.well-known/matrix/server` delegation). | Medium. May need well-known delegation through Caddy. |
| **A3** | `did:web` + WebFinger serve cleanly, and the dormant `connections.js` connect flow completes box→box and verifies. | ✅ **PROVEN — `spike/federation-tier0/` GO (10/10).** Real `connections.js` did WebFinger discovery + POST to a second box; the prototyped sign/verify-via-`did:web` layer accepts valid and rejects tampered/forged (401). No Caddy change needed (P1). | Resolved. Residual: real-vault persistence is a build step, not a risk. |
| **A4** | The `connect-request.profile.signature` field is **safe to transmit** (not a raw invertible embedding). | ✅ **PROVEN.** Code-read: `src/db/profiles.js` never writes `signature` (grep: 0 matches; `computeFingerprint` sets only scores+realm names); it's user bio ≤500 chars (`src/portal-compat.js:188`). Spike A4: live payload has no `centroid_256`/`embedding_768`/vector field. | Resolved (recommend a post-launch one-sample audit). |
| **A5** | Matrix's per-event Ed25519 attribution + a DID-published MXID claim is enough sovereign attribution (or we need body-level Mycelium signatures). | Design review + spike: forge-attempt a message as another handle. | Medium — determines whether we add body-level signing. |

---

## 6. Decision log

| ID | Decision | Status |
|---|---|---|
| D-FED-1 | Sovereign Ed25519 identity is the root; `did:web:<handle>.mycelium.id` is its published form; Matrix/lexicons map onto it (never replace it). | **Locked** |
| D-FED-2 | Shared spaces = Matrix room (live surface) + lexicon-record mirror into each box's vault (durability/sovereignty). No second atproto PDS. | **Proposed** — confirm in A1/A2 spike |
| D-FED-3 | AT-Proto contributes identity (`did:web`) + lexicon *schemas* only; not a running PDS/firehose/MST. | **Proposed** |
| D-FED-4 | Matrix is optional, never the identity root, never the discovery transport. | **Locked** |
| D-FED-7 | Tier-1 homeserver = **Continuwuity** (Conduwuit archived 2026-01-19); crypto helper = `@matrix-org/matrix-sdk-crypto-wasm` (vodozemac, no libolm). Bot needs a persistent crypto store backend. | **Locked** (A1 spike + P3) |
| D-FED-5 | Discovery/resonance deferred; stays on signed-HTTP + LSH/DP/SMPC, not Matrix/firehose. | **Locked** |
| D-FED-6 | Every cross-instance send via an explicit egress chokepoint; every inbound artifact persists+notifies once. | **Locked** (inherits `CLAUDE.md` §11/§12) |

---

## 7. Next steps

1. **Spike A1 first** (headless Matrix bot E2EE round-trip) — it's the highest-risk unknown and gates Tier 1.
2. **Spike A3 + A4** in parallel (cheap, foundational) — serve `did:web`/WebFinger, complete one box→box `connect`, and classify the `signature` field for leak-safety.
3. If A1/A3/A4 return GO, write the **build plan** for Tier 0 + Tier 1 (wire `connections.js`, add the well-known routes + Caddy path, add the `matrix` channel kind + `/matrix/send` chokepoint + inbound persistence).
4. Keep this doc + `docs/REDESIGN-LIVING-SPEC.md` §2.7 in sync as the spikes land (update the "current state" inventory — §2.7's "Matrix: 0 / AT-Protocol: 0" is already stale given `connections.js`'s lexicon usage).

*Reminder: federation is gated until V1 ships + validates with real users. This is the plan and the de-risking spikes — not a green light to bundle a homeserver into the shipping app today.*

---

## 8. Verification table (sweep-first; each row read back against live code)

| Load-bearing assumption | Verified at (read myself) |
|---|---|
| Box identity is one ed25519 keypair from the master key, verifiable by public key alone; `publicIdentity()` is "safe to publish in WebFinger/DID" | `src/identity/identity.js:28-89` (esp. 74-77, 82-89) |
| The connect-request payload is `social.mycelium.*` lexicon-typed and built from `{handle, signature, depth/breadth, public_realms_json}` | `src/db/connections.js:122-144` |
| Outbound `requestRemote` does WebFinger lookup then POSTs to the `federation` rel's `href + /connect` — and sends it **UNSIGNED** (signing deferred to a non-existent Worker tier) | `src/db/connections.js:106-166` (gap: `:154-166`) |
| `connect-request.profile.signature` is **not** an embedding — `profiles.js` never writes it; it's user bio (≤500 chars) | `src/db/profiles.js` (grep `signature` → 0 matches; `computeFingerprint`/`upsert` set only scores); `src/portal-compat.js:188` |
| `user_profiles`, `connections`, `territory_profiles` tables exist in the V1 schema (the dormant code can run) | `migrations/0001_init.sql:540-551, 1376-1410, 1569-1584` |
| `territory_profiles.essence`/`.name` are LLM-generated plaintext descriptors, not vectors; embeddings live in separate columns not sent over the wire | `src/db/territory-docs.js:138-182`; `migrations/0001_init.sql:1402,1408` |
| New `.well-known` GET routes mount on the `:4711` Express app and inherit the existing CORS middleware (public, no auth gate) | `src/server-http.js:71-77` (middleware), `:80-108` (route pattern) |
| Caddy forwards **everything** to `:4711` (single `reverse_proxy`) — no path-split, no Caddy change for federation routes | `src/remote/runtime.js:97` (`reverse_proxy ${upstream}`, `upstream = 127.0.0.1:4711` at `:16`) |
| The handle/`publicHost` is `null` until remote is configured → DID/WebFinger must fail closed | `src/remote/config.js:62-79` (`publicHost` resolution); spike A3.2 |
| Master key is pinned to `process.env.ENCRYPTION_MASTER_KEY` at boot, available to any route handler | `src/index.js:73`; mirrored use at `src/remote/router.js:142`, `src/publish/public-server.js:82` |
| The dormant code imports only `node:crypto` (no DB/native dep needed to exercise it) | `src/db/connections.js:53`, `src/identity/identity.js:17` |
| End-to-end: did:web doc + WebFinger + signed connect verify; tamper/forge rejected | `spike/federation-tier0/probe.mjs` + `RESULT.md` (GO 10/10) |
| Headless Megolm E2EE works in our Node runtime (no libolm, no human verify, restart-recovers) | `spike/federation-tier1-matrix/probe.mjs` + `RESULT.md` (GO 9/9) |
| Conduwuit archived → Continuwuity is the live successor; `matrix-sdk-crypto-wasm@18` installs from npm | spike install log; WebSearch (continuwuity.org, github.com/continuwuity) |

## 9. Next steps (updated after Tier-0 + Tier-1/A1 spikes)

1. ✅ **Tier-0 spike — DONE, GO.** `spike/federation-tier0/`.
2. ✅ **Tier-1 / A1 spike — DONE, GO.** `spike/federation-tier1-matrix/` — headless Megolm E2EE crux proven.
3. **Decide the gate:** Tier-0 (did:web + WebFinger + signed `/federation/connect`, wiring the dormant `connections.js`) is the lowest-risk first *built* federation increment **once the ship-and-validate gate opens** — read-mostly, no homeserver, leaks nothing. Write its build plan (wire `connections` into `getDb`/a tool, add the three routes + the sign/verify layer, persist+notify on inbound).
4. **Spike A1b next (the remaining Tier-1 unknown):** stand up **Continuwuity** + `matrix-js-sdk` (rust-crypto) and reproduce the A1 round-trip **end-to-end over a real homeserver** (sync loop, bot login, persistent store), then **two federating homeservers** (S2S through the relay). Do **not** bundle a homeserver before A1b returns GO.
5. Keep `docs/REDESIGN-LIVING-SPEC.md` §2.7 in sync (its "Matrix: 0 / AT-Protocol: 0" line is stale) and note the **Conduwuit→Continuwuity** correction wherever Conduwuit is referenced.
