# Deploy Handoff — Phase B B11: live homeserver + S2S federation

**Date:** 2026-06-06
**Session:** continued from the Phase B sandbox build (#112 → #117, all merged to `main`)
**Status:** Phase B sandbox core **B1–B10 mock-complete + merged**. B11 is the only remaining work and **needs a real host** — it cannot be built or verified in the web sandbox (no Docker, no homeserver).

---

## TL;DR

Everything except live delivery is done and on `main`. The orchestration (membership sync, mirror, inbound, egress gate chain) is built behind an injectable `MatrixClient` seam and is unit-green. To go live, a deploy session must: (1) provision a homeserver, (2) implement the real `MatrixClient` against the existing seam contract, (3) wire it into boot, (4) run the flow between two real boxes. **No new orchestration logic is needed** — the A1b spike already proved the live client works (7/7).

## Merged this session (all to `main`)

| PR | Merge SHA | What |
|---|---|---|
| #112 | `f0a4932` | connections management hub + DNS-rebinding SSRF guard |
| #113 | `67fdd65` | Phase B foundation (B2 lexicon, B3 MXID bind, B4 space⇄room, B5 did `#matrix`) |
| #114 | `fc9979a` | B6 membership sync (grant→invite / revoke→kick) |
| #116 | `6a1820f` | B8 mirror + B9 inbound persist + bug-hunt fixes |
| #117 | `0fe9af6` | B7 egress chokepoint (gated send + sha256-only audit) |

## The seam contract (what the real client must implement)

`src/federation/matrix-client.js` defines the `MatrixClient` interface + an in-memory `MockMatrixClient`. The deploy session adds `createMatrixClient()` (matrix-js-sdk + rust-crypto) implementing the **same** methods:

- `ensureEncryptedRoom({ name }) → roomId` — create a Megolm room (encrypted-on-create, the A1b invariant)
- `invite(roomId, mxid)` / `kick(roomId, mxid)`
- `roomMembers(roomId) → string[]`
- `isRoomEncrypted(roomId) → boolean` — used by the egress encryption gate
- `send(roomId, eventType, content) → eventId`
- `onTimelineEvent(handler)` — handler receives `{ roomId, eventType, content, senderMxid, eventId }`

**A1b key-sharing gotcha (carry into `send`/first-send):** before the first send, await the peer `join` + `getCrypto().getUserDeviceInfo([peer], true)` (or accept first-message UTD + retry). Proven in `spike/federation-a1b-matrix/`.

## Pickup checklist (deploy session)

1. **Provision a homeserver** — Continuwuity (or Synapse/Dendrite) reachable from the box. Add `matrix-js-sdk` to `package.json` (currently absent from runtime deps — only in the spike).
2. **Implement `createMatrixClient()`** in `src/federation/matrix-client.js` against the seam contract above, porting the A1b login/sync/crypto-store setup. Use a **persistent** crypto store (not in-memory) so device keys survive restart.
3. **Bind the box's MXID** — `db.identityChannels.upsert({ channel_kind:'matrix', channel_value:'@you:hs', owner_user_id })` + `bindToUser`. This MXID is both `selfMxid` (echo filter) and what `buildDidDocument` advertises as `#matrix`.
4. **Wire at boot** (`src/index.js` / wherever `getDb` + the REST router are assembled):
   - `const matrixClient = await createMatrixClient(...)`
   - `const matrixEgress = createMatrixEgress({ matrixClient, db })`
   - `const spaceSync = createSpaceSync({ db, matrixClient, matrixEgress, resolveMxid, selfMxid })`
     - `resolveMxid(granteeUserId)` = look up the peer's DID (`connections`/`user_profiles`) → `resolveMatrixService(did)` (`src/federation/did.js`, SSRF-guarded).
   - pass `spaceSync` into `portalCompatRouter({ db, userId, spaceSync })` — the grant/revoke/knowledge hooks are already there, inert until `spaceSync` is non-null.
   - register `matrixClient.onTimelineEvent((e) => spaceSync.handleInbound(e))`.
5. **Advertise** — confirm `GET /.well-known/did.json` now includes the `#matrix` service (pass the MXID to `buildDidDocument`).
6. **Two-box E2E** — provision a second box, accept a mutual connection, share a space, add knowledge on box A, assert it decrypts + persists once on box B (`source_type='remote'`), revoke, assert kick. This is the real proof B11 exists to provide.

## Known follow-ups (documented, not blockers)

- **`senderMxid` → peer-id normalization** (`space-sync.handleInbound`): inbound currently stores the raw MXID in `source_user_id`; the rest of the code uses `handle@host` synthetic ids. Add an MXID↔peer map (from `identity_channels` / connections) at deploy so attribution is consistent.
- **Durable dedup vs UNIQUE index:** inbound dedup uses `existsBySourceRef('matrix:<eventId>')` (durable, survives restart). A check-then-insert race remains under true concurrency; the hardening is a `UNIQUE(space_id, source_ref)` index + `INSERT … ON CONFLICT DO NOTHING` (NULLs stay distinct, so non-matrix rows are unaffected).
- **Persistent crypto store** is mandatory for B11 (in-memory loses device keys on restart → UTD).

## Verify before declaring B11 done

`npm run verify:federation` (GO 9/9) · `verify:spaces` (GO 32/32) · `verify:mcp` (GO) · the federation test suite (79+) — then the **two-box E2E** above, which the sandbox suite cannot cover.
