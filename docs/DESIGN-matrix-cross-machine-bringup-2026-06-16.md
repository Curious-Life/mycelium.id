# Design — Cross-machine Matrix (Tier-1) bring-up: hi ↔ lo

**Date:** 2026-06-16
**Author:** sweep-first-design pass over the live code + the existing Tier-1 docs
**Goal:** Get two real Mycelium boxes (`hi.example.com` ↔ `lo.example.com`) exchanging end-to-end-encrypted (Megolm) messages over Matrix, on top of the now-working Tier-0 connection handshake.

This is **not greenfield.** Phase B (B1–B10) is built, merged, and unit-green behind an injectable `MatrixClient` seam; the A1/A1b spikes proved the real client + Megolm + S2S work on a live server. The remaining work is **wiring + a homeserver**, captured by [DEPLOY-federation-phaseB-B11-HANDOFF-2026-06-06.md](DEPLOY-federation-phaseB-B11-HANDOFF-2026-06-06.md). This doc verifies that handoff against today's code, makes the one decision it leaves open (cross-machine homeserver topology), and adds the verification table + threat model.

---

## 0. Headline

- **Built & merged (library code):** lexicon, MXID-bind schema, space⇄room binding, `#matrix` DID advertise + peer resolution, membership sync (grant→invite / revoke→kick), outbound mirror through a §11 egress chokepoint, inbound persist-once, and an in-memory `MockMatrixClient`. All unit-green.
- **NOT wired (the gap):** there is **no homeserver, no real Matrix client, no boot instantiation, no box MXID in `did.json`, and no `/matrix/send`-style runtime path.** `matrixClient` is `null` in production, so every Matrix op is a documented no-op.
- **The one open decision:** who runs the homeserver for *cross-machine* delivery. The locked D-FED-7 ("one sidecar per box") implies Matrix **S2S federation** (deferred/unproven). **This design pivots the bring-up to a shared homeserver (both boxes as clients) — no S2S — and defers per-box+S2S.**

---

## 1. Load-bearing assumptions (Step 1) → verdicts

| # | Assumption the plan rests on | Verdict |
|---|---|---|
| A1 | The orchestration (grant/revoke/mirror/inbound) is real and client-agnostic | ✅ verified — `space-sync.js` read in full |
| A2 | A §11 egress chokepoint already gates Matrix content | ✅ verified — `matrix-egress.js` read (2 gates + hash-only audit) |
| A3 | The real Matrix client does **not** exist; only the mock + interface | ✅ verified — `matrix-client.js` read (only `createMockMatrixClient`) |
| A4 | Nothing wires Matrix at boot today | ✅ verified — grep of index/server-http/runtime/channel-daemon: no caller |
| A5 | The box MXID is **not** advertised in `did.json` today | ✅ verified — no caller passes `matrixId` to `buildDidDocument` |
| A6 | Inbound persists exactly once (dedup) into an encrypted store | ✅ verified — `space-sync.handleInbound` dedups on `matrix:<eventId>` |
| A7 | Cross-machine, one-per-box homeserver requires Matrix S2S federation | ⚠️ true and **deferred/unproven** (A2 spike) → **pivot** (see §3) |
| A8 | A shared homeserver still gives E2EE between boxes | ✅ Megolm is client-to-client; the homeserver never holds room keys |

---

## 2. Sweep findings (consolidated, file:line)

**Orchestration — LIVE, client-agnostic, unwired.**
- `src/federation/space-sync.js:54` `syncGrant` → `ensureRoom` (Megolm, lazy, per-space lock at :35) + `matrixClient.invite`.
- `:66` `syncRevoke` → `kick`. `:83` `mirrorKnowledge` (B8) validates lexicon then sends **only** through the egress chokepoint (`:97`). `:108` `handleInbound` (B9): lexicon-validate → map room→space → **persist-once** (`existsBySourceRef('matrix:<eventId>')`, `:119–121`) → `db.spaceKnowledge.add(..., 'remote', 'all', ..., sourceRef)` (`:125`). Self-echo filter on `selfMxid` (`:111`). `enabled: !!matrixClient` (`:51`) → **no-op when null**.

**Egress chokepoint — LIVE (§11).**
- `src/federation/matrix-egress.js:42` gate 1 = bound-room only (`spaceMatrixRooms.getByRoom`); `:44` gate 2 = `isRoomEncrypted` required; `:25–34` audit = sha256 + length only, never plaintext, for allowed **and** denied. Membership ops are deliberately *not* content egress and stay on the client (`:12`).

**Client seam — interface + mock only.**
- `src/federation/matrix-client.js:11–20` defines the contract; `:27` `createMockMatrixClient` (in-memory). The real `createMatrixClient` (matrix-js-sdk + rust-crypto) exists **only in the header comment** (`:6–9`) and the spike. The A1b key-sharing rule (await peer join + `getUserDeviceInfo` before first send) is noted at `:8–9`.

**Identity advertise — capable, unwired.**
- `did.js` advertises a `#matrix` service **iff** an MXID is passed to `buildDidDocument`; `resolveMatrixService(did)` resolves a peer's MXID (SSRF-guarded). **No caller passes an MXID** (grep), and `identity_channels` is used only for Discord today (`src/internal-router.js:215`).

**Homeserver — absent.** No `MYCELIUM_MATRIX_*`, no homeserver URL, no `matrix-js-sdk` in runtime `package.json` (spike only).

**Persistence/scope/cross-process (existing patterns to reuse).**
- Inbound lands in `space_knowledge` (encrypted store) via `db.spaceKnowledge.add` — not the `messages` table. Scope-key derivation + scope guardian exist in `src/crypto/crypto-local.js` (sweep-cited; not on this design's change path). Cross-process honest patterns: tmpfs `/run/mycelium`, loopback HTTP (:4711 server-http, :8787 portal/channel-daemon), D1 ciphertext.

---

## 3. The decision: homeserver topology for cross-machine (revision v1→v2)

**v1 (from D-FED-7, the locked decision):** one Continuwuity sidecar **per box**. `hi` runs its own homeserver, `lo` runs its own, and the two **federate via Matrix S2S** so `@hi:hi.example.com` can talk to `@lo:lo.example.com`.

**Why v1 is wrong for the bring-up (the pivot):** S2S federation is its own large surface — each homeserver must expose a federation endpoint (`:8448` or `.well-known/matrix/server` delegation), implement server-keys exchange, and be publicly reachable for S2S — and the design **explicitly defers** Continuwuity footprint + S2S cost to the unbuilt A2 spike. Putting an unproven, heavyweight dependency on the critical path of the *first* cross-machine test is exactly the structural mistake this protocol exists to catch. The B11 handoff itself says "a homeserver reachable from the box" (singular), not one-per-box — i.e. it already leans client-of-a-homeserver.

**v2 (this design — bring-up):** **both boxes are clients of ONE shared homeserver** (e.g. a Continuwuity on the existing relay host, or any reachable Continuwuity/Synapse). `hi` logs in as `@hi:<hs>`, `lo` as `@lo:<hs>`. They share a Megolm room; **the homeserver never holds room keys**, so message *content* is E2EE between the boxes regardless of who runs the server. No S2S. This proves cross-machine Megolm messaging end-to-end with the least new surface.

**Deferred to a sovereignty-hardening phase:** per-box Continuwuity + S2S (v1), once the A2 footprint/S2S spike lands. The seam doesn't change — only *which* homeserver `createMatrixClient` logs into and whether two homeservers federate.

**Trust trade (made explicit in §6):** a shared homeserver sees **metadata** (who is in which room, timing, message sizes) but never plaintext. This matches the existing relay's trust model (it already forwards ciphertext only). Per-box+S2S distributes that metadata; full sovereignty is the v1 end-state, not a bring-up requirement.

---

## 3a. Revision v2→v3 (2026-06-16 PM) — wiring split across the two server processes, not `index.js`

§4 step 3 said "boot wiring in `src/index.js` where `getDb` + routers assemble." A fresh read of the assembly contradicts that: **`src/index.js`'s `boot()` only builds the MCP tool surface** (db + handlers) and returns it. The *routers* assemble in two separate server processes that each call `boot()`:

- **`src/server-http.js` (:4711)** mounts `createFederationRouter` ([server-http.js:251](../src/server-http.js)) — this is the federation host, so the **did.json `#matrix` advertise** lives here (thread `getMatrixId` into the handler, read per-request from config like `getHost`/`getHandle`).
- **`src/server-rest.js` (:8787)** mounts `portalCompatRouter` ([server-rest.js:120](../src/server-rest.js)) — grant/revoke/mirror/inbound all fire here, so the **live Matrix client + `spaceSync` + `onTimelineEvent` live here**. (Discovery: `portalCompatRouter` *already* accepts `spaceSync` and already calls `syncGrant`/`syncRevoke`/`mirrorKnowledge` — [portal-compat.js:29,434,494,528,538](../src/portal-compat.js). The consumer side was pre-wired; only the producer/instantiation was missing.)

The two processes share the MXID + homeserver via **`remote.json`** (non-secret: `matrixHomeserver`, `matrixUserId`) and the access token via **`auth.db`** (`setRemoteSecret('matrix_access_token')`, 0600) — both already-existing config stores. A single `matrixConfig()` helper in `remote/config.js` returns `{homeserver,userId,accessToken}` or `null` ("is Matrix configured" — the one source of truth driving every null-check).

**Scope landed this session (verifiable, inert behind the null-check):** config plumbing · did.json advertise · server-rest boot-instantiate `spaceSync` + `resolveMxid` + MXID-bind + thread into `portalCompatRouter`. **Deferred to the deploy session (cannot be validated without a live homeserver):** the real `createMatrixClient` (matrix-js-sdk + rust-crypto) — shipped this session as a clearly-marked NOT-IMPLEMENTED stub the boot path catches → stays `null` → inert; and the homeserver standup (§8 step 1). This split honors "hard evidence over paper reasoning": no untested heavy crypto dependency enters the vault tree until it's validated against the real server.

## 4. Module shape — the wiring (LOC budget: ~180–240 LOC + deps)

No new orchestration. Five concrete additions, all against the existing seam:

1. **`createMatrixClient(opts)`** in `src/federation/matrix-client.js` (~120–160 LOC) — implements the documented contract with `matrix-js-sdk` + `@matrix-org/matrix-sdk-crypto-wasm` (rust-crypto), a **persistent** crypto store (device keys must survive restart — in-memory → UTD), login from config, `startClient`, and the A1b first-send key-sharing rule. Add `matrix-js-sdk` to runtime `package.json`.
   - Config (new, `remote.json`/env, non-secret host + a secret access token): `matrixHomeserver`, `matrixUserId`, plus the access token in the keystore (never `remote.json`).
2. **Bind the box MXID** (~10 LOC, boot): `db.identityChannels.upsert({ channel_kind:'matrix', channel_value:'@hi:<hs>', owner_user_id })`. This value is both `selfMxid` (echo filter) and the `#matrix` advertise.
3. **Boot wiring** (~30 LOC, `src/index.js` where `getDb` + routers assemble):
   ```
   const matrixClient = matrixConfigured ? await createMatrixClient(cfg) : null;
   const matrixEgress = matrixClient ? createMatrixEgress({ matrixClient, db }) : null;
   const spaceSync = createSpaceSync({ db, matrixClient, matrixEgress, resolveMxid, selfMxid });
   matrixClient?.onTimelineEvent((e) => spaceSync.handleInbound(e));
   // pass spaceSync into portalCompatRouter({ db, userId, spaceSync })  (hooks already inert-until-non-null)
   ```
   `resolveMxid(peerUserId)` = peer DID (from `connections`/`user_profiles`) → `resolveMatrixService(did)` (`did.js`, SSRF-guarded).
4. **Advertise** (~5 LOC): pass the bound MXID into `buildDidDocument` so `GET /.well-known/did.json` includes the `#matrix` service. (Fail-closed: omit if unset — current behaviour.)
5. **`resolveMxid` + MXID↔peer map** (~20 LOC): store peer MXIDs (from `connect`/`connect-response` profile or DID resolution) so `handleInbound` can normalize `senderMxid` → `handle@host` for attribution (B11 follow-up #1).

**Everything else is already built** and flips from no-op to live the moment `matrixClient` is non-null.

---

## 5. Edge cases — explicit decisions

- **First-send UTD (A1b):** before the first `send`, await the peer `join` + `getUserDeviceInfo([peer], true)`, or accept a first-message UTD + retry. Lives inside `createMatrixClient.send`. Chosen because it's proven in the spike; alternatives (blind send) lose to undecryptable-first-message.
- **Restart:** crypto store MUST be persistent (RocksDB/sqlite via rust-crypto), else device keys are lost → all history UTD. Non-negotiable for B11.
- **Self-echo:** `handleInbound` drops events from `selfMxid` (`space-sync.js:111`) — we already persisted our own outbound locally.
- **Dedup race:** persist-once uses `existsBySourceRef('matrix:<eventId>')` (durable). A check-then-insert race remains under true concurrency → harden with `UNIQUE(space_id, source_ref)` + `INSERT … ON CONFLICT DO NOTHING` (B11 follow-up #2). Bring-up accepts the small window; one inbound consumer per box makes it near-zero.
- **Peer has no `#matrix`:** `syncGrant` returns `{skipped:'peer-has-no-matrix'}` — the grant is still recorded locally; delivery activates once the peer advertises. No error surfaced to the user beyond "not delivered yet."
- **Matrix not configured:** all ops no-op (`enabled:false`); Tier-0 connections + the portal are unaffected. Fail-safe by construction.

---

## 6. Threat model

- **New surface:** a Matrix client in-process (server-http :4711) pulling a large dependency tree (matrix-js-sdk + wasm crypto), plus a homeserver the box logs into.
- **Plaintext boundary:** content is Megolm E2EE; the homeserver (shared or per-box) **never** holds room keys, so it cannot read messages. Inbound persists under the existing encrypted `space_knowledge` path; federation data stays scoped (the design's `scope='matrix'/'space:<id>'` isolation goal — the vault scope guardian contains a federation bug to the federation scope).
- **Metadata (shared homeserver):** sees room membership, timing, message sizes. **Accepted for bring-up** (same trust class as the relay, which already forwards ciphertext). Mitigation/end-state: per-box + S2S (deferred).
- **Egress:** all content leaves only through `matrix-egress` (bound-room + encryption-required + hash-only audit). Membership ops can't carry content. Preserves §11.
- **Identity/attribution (A5, OPEN):** is Matrix per-event Ed25519 + the DID-published MXID claim sufficient attribution, or do message bodies need a detached Mycelium-key signature? Unresolved — needs a forge-attempt spike before relying on attribution for trust decisions. Bring-up does not depend on it (membership is gated by the space grant, which is Tier-0-authenticated).
- **§7 tripwire:** `mirrorKnowledge` validates through the lexicon (incl. the embedding/vector tripwire) before anything leaves the box — preserved.
- **SSRF:** `resolveMatrixService` + DID resolution are HTTPS-only, no-redirect, host-allowlisted (existing guards).

---

## 7. Test strategy

- **Existing (keep green):** `tests/federation-space-sync.test.js`, `tests/federation-matrix-egress.test.js`, `tests/federation-did.test.js` — exercise the real orchestration/egress/advertise against the mock. `verify:federation` (GO 9/9), `verify:spaces` (GO 32/32).
- **New unit:** `createMatrixClient` adapter conformance — a thin test that the real client satisfies the seam contract (can run against a local Continuwuity in CI-with-docker only; otherwise a manual spike like A1b).
- **The real proof — two-box E2E (manual, this design's point):** with `hi` + `lo` both wired to the shared homeserver and mutually connected (Tier-0, done): on `hi` share a space → grant `lo` → add a knowledge entry → assert on `lo` it **decrypts + persists once** (`source_type='remote'`), then revoke → assert `lo` is kicked. This is exactly B11 step 6; it cannot run in the sandbox.

---

## 8. Implementation order (each step independently shippable)

1. **Stand up the shared homeserver** (Continuwuity) + register `@hi` / `@lo`; record homeserver URL + per-box access token. *Smoke:* both boxes can log in via a throwaway script (the spike harness).
2. **`createMatrixClient`** against the seam + persistent crypto store; add `matrix-js-sdk`. *Smoke:* adapter conformance test + a 2-client local send/receive (spike-style).
3. **Bind MXID + advertise** (`identity_channels` + `buildDidDocument`). *Smoke:* `curl https://hi.example.com/.well-known/did.json` shows the `#matrix` service.
4. **Boot wiring** (`matrixClient`/`matrixEgress`/`spaceSync` + `onTimelineEvent` + `portalCompatRouter`). *Smoke:* `spaceSync.enabled === true`; grant on a 1-box space creates a room (check `space_matrix_rooms`).
5. **`resolveMxid` + MXID↔peer map.** *Smoke:* grant to a connected peer returns `{invited:true}` not `{skipped:'peer-has-no-matrix'}`.
6. **Two-box E2E** (§7). *Smoke:* the share→decrypt→persist-once→revoke→kick run.

Steps 1–5 ship on a branch behind the null-check (inert until configured), so they're safe to merge before the homeserver exists. Step 6 is the GO criterion.

---

## 9. Decision criteria for "Tier-1 cross-machine works"

Falsifiable: **on `lo`, a knowledge entry added on `hi` in a shared space appears exactly once with `source_type='remote'` and decrypts** (query `space_knowledge` for `source_ref='matrix:<eventId>'`), **and** a revoke removes `lo` from the room (`roomMembers` no longer lists `@lo`). Until that row exists on `lo`, Tier-1 is not done regardless of unit-green.

---

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| matrix-js-sdk + wasm-crypto dependency/footprint bloat in a security-critical vault | Med | Med | Isolate behind the seam; in-process but scoped; revisit sidecar isolation if footprint warrants (A2) |
| Persistent crypto store misconfig → UTD after restart | Med | High | Mandatory persistent store (RocksDB/sqlite); restart smoke before declaring done |
| Shared-homeserver metadata exposure | High (by design) | Low (no plaintext) | Accepted for bring-up; per-box+S2S is the end-state |
| S2S complexity if we attempt v1 now | — | High | **Avoided** by the v2 pivot |
| Attribution (A5) relied on prematurely | Low | Med | Bring-up gates membership via Tier-0 grant, not Matrix attribution; A5 spike before any trust decision uses it |
| Dedup check-then-insert race | Low | Low | UNIQUE(space_id, source_ref) hardening (follow-up) |

---

## 11. Open questions — resolved during sweep

- *"Is any of this built?"* — Yes: B1–B10 merged, unit-green, behind the seam. The work is wiring + a homeserver, not logic.
- *"Does cross-machine require S2S?"* — Only under v1 (per-box). v2 (shared homeserver clients) does not, and gives the same E2EE. **Pivoted.**
- *"Where does inbound land?"* — `space_knowledge` (encrypted), persist-once on `matrix:<eventId>`, not the `messages` table.

## 12. Open questions — deferred (named so they don't ambush a later phase)

- **Per-box Continuwuity + S2S federation** (v1 sovereignty end-state) — needs the A2 footprint/cost spike.
- **A5 attribution** — forge-attempt spike: is per-event Ed25519 + DID MXID claim enough, or are body-level Mycelium signatures required?
- **`senderMxid` → peer-id normalization** + **UNIQUE(space_id, source_ref)** dedup hardening (B11 follow-ups).
- **1:1 DM rooms** (vs shared-space group rooms) — Tier-1 locks shared spaces; DMs are out of scope here.
- **Where the Matrix client process lives** (in server-http vs a sidecar) if footprint forces isolation.

---

## Verification table

| Assumption | Verified at (read myself unless noted) |
|---|---|
| Orchestration is real + client-agnostic (grant/revoke/mirror/inbound) | `src/federation/space-sync.js:35,54,66,83,108` |
| Inbound persists once, dedup on event id, encrypted store | `src/federation/space-sync.js:119–127` |
| §11 egress chokepoint exists (bound-room + encryption + hash-only audit) | `src/federation/matrix-egress.js:42,44,25–34` |
| Real Matrix client does NOT exist (mock + interface only) | `src/federation/matrix-client.js:6–9,27` |
| Matrix is unwired at boot (no instantiation) | grep: no `createMatrixClient/createSpaceSync/createMatrixEgress/matrixClient` in `src/index.js`, `src/server-http.js`, `src/remote/runtime.js`, `packages/channel-daemon/index.js` |
| Box MXID not advertised in did.json (no `matrixId` caller) | grep: no caller passes `matrixId` to `buildDidDocument`; `identity_channels` used only for `discord` (`src/internal-router.js:215`) |
| `did.js` can advertise `#matrix` + resolve peer MXID (SSRF-guarded) | sweep-cited `src/federation/did.js:103–119,128–143` (not re-read this pass) |
| Homeserver topology / S2S deferred; D-FED-7 = per-box | `docs/DEPLOY-federation-phaseB-B11-HANDOFF-2026-06-06.md:1–11,36–49`; design-doc-cited D-FED-7 |
| Bring-up wiring steps (client, MXID bind, boot, advertise, resolveMxid) | `docs/DEPLOY-federation-phaseB-B11-HANDOFF-2026-06-06.md:36–49` |
| Tier-0 connection (the substrate this builds on) works hi↔lo | live-verified this session (handshake completed + #181) |
