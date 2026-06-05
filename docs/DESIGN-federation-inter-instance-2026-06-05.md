# Design — Inter-Instance Communication (Federation): Matrix + lexicon records

**Date:** 2026-06-05
**Status:** Design (sweep-first: repo swept with file:line citations; **no code yet — build after this is accepted and the Tier-0/1 spikes return GO**). Federation is gated until V1 ships + validates (`CLAUDE.md`, `docs/V1-BUILD-SPEC.md`) — this doc is the plan we pick up *when that gate opens*, plus the spikes that de-risk it now.
**Scope:** how two or more Mycelium boxes talk to each other. Near-term drivers (set by the operator): **(1) real-time direct agent↔agent and human↔agent chat**, and **(2) shared context pools** (mutual-opt-in shared spaces). Resonance/discovery is **explicitly deferred** to a later tier.
**Companion to** `docs/legacy/SOCIAL-SHARING-SPEC-from-legacy.md` (the authoritative social *content* design, Phases 1–5), `docs/REDESIGN-LIVING-SPEC.md` §2.7 (federation surface inventory), and `docs/DESIGN-relay-and-gateway-2026-06-04.md` (the `<handle>.mycelium.id` reachability this rides on).

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

### 2.2 Reachability (live)
- `src/remote/*` + `docs/DESIGN-relay-and-gateway-2026-06-04.md` — `<handle>.mycelium.id` resolves to the user's Mac via **SNI-passthrough relay → Caddy on the Mac** (TLS key born local, never on the relay). Caddy path-routes `/{mcp,v1,.well-known,api/auth}` → `:4711`, `/{p,s}` → `:8788` (`renderCaddyfile`, `src/remote/runtime.js:66-111`). **Adding a `.well-known/did.json` + `.well-known/webfinger` + `/federation/*` route is a route on `:4711` and a Caddy path entry — no new infra.**

### 2.3 Federation content layer (ported, DORMANT — not wired to tools)
- `src/db/connections.js` — the social graph **with cross-instance connect already implemented**: `@handle@domain` → WebFinger at `https://<domain>/.well-known/webfinger?resource=acct:...` (`:106`) → POST a `social.mycelium.connect-request.v1` payload to the discovered `federation` link (`:135-163`). SSRF defenses are real and documented (`:21-29`: domain regex, HTTPS-only, `redirect:'manual'`, abort timeouts). `computeOverlap()` (`:334-445`) does territory-label matching + shape classification (Twin Minds / Deep Collaborators / …).
- `src/db/spaces.js`, `space-rooms.js`, `space-conversations.js`, `space-knowledge.js`, `space-access.js` — the **shared-context-pool** primitive: a space is a `users` row with `type='space'` (so messages address a space like a user — `spaces.js:1-13`); nested rooms with cover-doc "doors" (`space-rooms.js:1-17`); per-(space,user) conversation threads; shared knowledge entries with per-entry visibility (`space-knowledge.js:1-7`). Name/essence auto-encrypted via the vault (`space-rooms.js:14-16`).
- `src/db/identity-channels.js` — **the key reuse point for Matrix**: a single registry of `(channel_kind, channel_value) → owner_user_id` (`:1-16`), already the abstraction for telegram/discord/etc. **A Matrix MXID is just `channel_kind='matrix'`** — inbound routing, ownership, and per-channel `delivery_enabled`/`auth_enabled` flags already exist.
- `src/db/index.js:5-9` — confirms the above are **present but not assembled** into the live `db` object: *"auth/session/federation/space-rooms/etc. are present in src/db/ and ready to wire when their tools land."* `spaces`/`space-knowledge`/`public-presence` **are** wired; `connections`/`space-rooms`/`space-conversations` are not.

### 2.4 Lexicon naming already in use
The code already types its federation payloads as `social.mycelium.*` lexicons (`connections.js:135`). So "adopt AT-Proto custom lexicons" is **partially already the convention** — we formalize it, we don't invent it.

### 2.5 What's genuinely missing
1. **Serving** `.well-known/webfinger` + `.well-known/did.json` from the box (today only OAuth's `oauth-protected-resource` well-knowns are served — `src/server-http.js:71-108`). The dormant `connections.js` *consumes* a `federation` rel nothing yet *serves*.
2. **The real-time channel** — there is no synchronous transport at all. Matrix fills this.
3. **An inbound `/federation/*` handler** to receive the `connect-request` the outbound side already sends, with **per-request Ed25519 signature verification** (the worker-tier comment at `connections.js:154-155` notes "JWT signing happens at the Worker level" — in the single-user box that signing/verifying has to live locally).
4. **Egress chokepoint + vault persistence** for the new channel (the `/matrix/send` analogue; received-message persistence + single notification).

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
Run **Conduwuit** (Rust homeserver, ~50–100 MB, single binary, SQLite — per the research input; to be verified in the spike) as an **optional sidecar**, alongside the frpc/Caddy/embed/enrich sidecars the box already manages.

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

---

## 5. Verification gate — load-bearing assumptions to prove BEFORE building

Per `CLAUDE.md` ("hard evidence over paper reasoning"), nothing above gets built on until these are proven by a running spike, not argued on paper.

| # | Assumption | How to prove | Risk if false |
|---|---|---|---|
| **A1** | A headless Matrix **bot can send/receive E2EE (Megolm)** messages reliably. | Spike: matrix-rust-sdk (or matrix-nio w/ store) bot, two boxes, encrypted DM round-trip + restart-and-still-decrypt. | **Highest.** Appservices historically do **not** do E2EE without a crypto helper; if bot E2EE is too brittle, Tier 1's whole premise wobbles. **Prove this first.** |
| **A2** | Conduwuit's real footprint + federation cost fit a bundled sidecar on a user's Mac. | Spike: run Conduwuit, measure RAM/CPU idle + under a small room, confirm S2S federation works through the relay (`:8448`/well-known delegation). | Medium. May need `.well-known/matrix/server` delegation through Caddy; may be heavier than 50–100 MB under load. |
| **A3** | `did:web` + WebFinger serve cleanly over the SNI-passthrough relay, and the dormant `connections.js` connect flow completes box→box. | Spike: serve both well-knowns on `:4711`, add the Caddy path, run `connect('@bob@bob.mycelium.id')` against a second local box, verify signature. | Low (mostly wiring) — but it's the foundation, so prove it explicitly. |
| **A4** | The `connect-request.profile.signature` field is **safe to transmit** (not a raw invertible embedding). | Read the producer of `user_profiles.signature`; classify per §4.1. | High if false — silent plaintext-fingerprint leak. **Block Tier 0 on this.** |
| **A5** | Matrix's per-event Ed25519 attribution + a DID-published MXID claim is enough sovereign attribution (or we need body-level Mycelium signatures). | Design review + spike: forge-attempt a message as another handle. | Medium — determines whether we add body-level signing. |

---

## 6. Decision log

| ID | Decision | Status |
|---|---|---|
| D-FED-1 | Sovereign Ed25519 identity is the root; `did:web:<handle>.mycelium.id` is its published form; Matrix/lexicons map onto it (never replace it). | **Locked** |
| D-FED-2 | Shared spaces = Matrix room (live surface) + lexicon-record mirror into each box's vault (durability/sovereignty). No second atproto PDS. | **Proposed** — confirm in A1/A2 spike |
| D-FED-3 | AT-Proto contributes identity (`did:web`) + lexicon *schemas* only; not a running PDS/firehose/MST. | **Proposed** |
| D-FED-4 | Matrix is optional, never the identity root, never the discovery transport. | **Locked** |
| D-FED-5 | Discovery/resonance deferred; stays on signed-HTTP + LSH/DP/SMPC, not Matrix/firehose. | **Locked** |
| D-FED-6 | Every cross-instance send via an explicit egress chokepoint; every inbound artifact persists+notifies once. | **Locked** (inherits `CLAUDE.md` §11/§12) |

---

## 7. Next steps

1. **Spike A1 first** (headless Matrix bot E2EE round-trip) — it's the highest-risk unknown and gates Tier 1.
2. **Spike A3 + A4** in parallel (cheap, foundational) — serve `did:web`/WebFinger, complete one box→box `connect`, and classify the `signature` field for leak-safety.
3. If A1/A3/A4 return GO, write the **build plan** for Tier 0 + Tier 1 (wire `connections.js`, add the well-known routes + Caddy path, add the `matrix` channel kind + `/matrix/send` chokepoint + inbound persistence).
4. Keep this doc + `docs/REDESIGN-LIVING-SPEC.md` §2.7 in sync as the spikes land (update the "current state" inventory — §2.7's "Matrix: 0 / AT-Protocol: 0" is already stale given `connections.js`'s lexicon usage).

*Reminder: federation is gated until V1 ships + validates with real users. This is the plan and the de-risking spikes — not a green light to bundle a homeserver into the shipping app today.*
