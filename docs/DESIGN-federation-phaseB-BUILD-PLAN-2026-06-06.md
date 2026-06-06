# Build Plan — Phase B: Spaces ⇄ Megolm rooms (live cross-node E2EE delivery)

**Date:** 2026-06-06
**Status:** Design (sweep-verified, file:line). Turns the recorded local grants (space_access shares, context_grants, cluster cards) into LIVE E2EE delivery over Matrix.
**Rests on:** #103 (Tier-0/0b + Phase A, merged) · `spike/federation-a1b-matrix/` (A1b PROVEN: headless matrix-js-sdk rust-crypto E2EE over a real homeserver, 7/7) · D-SPACE-1/2/3 (Matrix/Megolm E2EE, local-first) · D-FED decisions.

## ✅ AS-BUILT (2026-06-06) — sandbox core B1–B10 mock-complete

The entire Phase B data model + orchestration is **built and unit-green behind the `MockMatrixClient` seam**. Only **B11** (live homeserver / S2S / persistent crypto store / Continuwuity) remains — it needs a real host and is captured in `docs/DEPLOY-federation-phaseB-B11-HANDOFF-2026-06-06.md`.

| Step | As-built | Lands in |
|---|---|---|
| B1 client seam + `MockMatrixClient` | `src/federation/matrix-client.js` | #113→#114 |
| B2 lexicon validators (+ §7 tripwire) | `src/federation/lexicon.js` | #113 |
| B3 MXID binding wired | `src/db/index.js` (`identityChannels`) | #113 |
| B4 space⇄room model | `migrations/0011_space_matrix_rooms.sql` + `src/db/space-matrix-rooms.js` | #113 |
| B5 did:web `#matrix` advertise/resolve | `src/federation/did.js` (`buildDidDocument` + `resolveMatrixService`) | #113 |
| B6 membership sync (grant→invite/revoke→kick, lazy room, per-space lock) | `src/federation/space-sync.js` | #114 |
| B7 egress chokepoint (allowlist + encryption gates, sha256-only audit) | `src/federation/matrix-egress.js` | #117 |
| B8 mirror knowledge → room (via egress) | `space-sync.mirrorKnowledge` | #116→#117 |
| B9 inbound validate→map→persist-once (durable dedup, self-echo filter) | `space-sync.handleInbound` | #116 |
| B10 encrypted-at-rest | already in `crypto-local.js:425` (`space_knowledge: ['content','domain_tags']`) — no migration needed | — |

**Verification (every PR):** federation test suite (79 tests as of #117) · `verify:spaces` GO 32/32 · `verify:federation` GO 9/9 · `verify:mcp` GO. A dedicated bug-hunt over the inbound path (#116) fixed an echo loop, unsafe/non-durable dedup, and a room-create race before they could bite live.

**Note on B10 scope column:** the per-connection scope column was NOT added — inbound content persists at `visibility='all'` (the existing model) and is encrypted at rest via the existing `space_knowledge` field map. Per-connection scoping is a future refinement, not a Phase B blocker.



## Substrate state (sweep)

| Piece | State | Evidence |
|---|---|---|
| `identity_channels` registry (MXID binding, `kind='matrix'`) | present, **unwired** in getDb | `src/db/identity-channels.js:32-121`; `migrations/0001_init.sql:879-908`; absent from `src/db/index.js` |
| Egress chokepoint (`/telegram/send` pattern, **Matrix anticipated** w/ encryption+allowlist gates) | in `reference/`, **not ported to `src/`** | `reference/egress/send-handler.js:88-301` (Matrix gates :288-301); `MATRIX-SEND-DESIGN.md` absent |
| `space_access.grant/revoke` (member-sync hook); share REST gates to accepted connections | live | `src/db/space-access.js:38-52`; `src/portal-compat.js:477-499` |
| Remote grantee id carries the peer **DID** (MXID discovery anchor) | live | `connections.js:314,336-338,419-423` |
| DID doc advertises only federation (no Matrix service) | live | `src/federation/did.js:100-112` |
| SSRF-guarded peer-doc fetch (reusable for MXID resolution) | live | `did.js:146-162`; `src/federation/ssrf.js` |
| Lexicon validators `social.mycelium.{space,room,knowledge}.v1` | **absent** | grep → only in design docs |
| `matrix-js-sdk` as a runtime dep | **absent** (only in spike) | grep package.json |
| Scope guardian + scope-column gotcha (`space_knowledge` has no scope col) | live | `crypto-local.js:86-160, 608-625`; `0001_init.sql:1219-1234` |

## Mapping model — 1 space ⇄ 1 Megolm room

- **Binding:** new `space_matrix_rooms(space_id PK, room_id, created_by, created_at)` + a thin `src/db/space-matrix-rooms.js` namespace (mirrors `space-access.js`). Rejected reusing `space_rooms` — that's the nested-folder model, orthogonal.
- **Member sync = the grant chokepoint.** Hook **after** `spaceAccess.grant` (`portal-compat.js:490`): resolve grantee DID → MXID → `matrixClient.invite(roomId, mxid)`. On `revoke` (`:497`): `kick`. First grant lazily creates the room (encrypted-on-create, the A1b invariant) + writes the binding. Reuses the accepted-connection guard (`:488-489`) → fail-closed, a non-connection can never be invited.
- **Key-sharing gotcha (A1b):** before first send, wait for peer `join` + `getCrypto().getUserDeviceInfo([peer], true)` (or accept first-message UTD + retry). Lives in `matrix-client.js`.

## MXID binding + discovery
- **Advertise:** add a `#matrix` service entry to `buildDidDocument` (`did.js:100-112`), sourced from `identity_channels` kind=`matrix`. Bind the box's own MXID via `identityChannels.upsert/bindToUser`.
- **Resolve a peer:** new `resolveMatrixService(did)` in `did.js`, reusing the SSRF-guarded fetch (`did.js:146-162` + `ssrf.js`) → fetch peer `did.json` → read `#matrix` service.

## Egress + inbound (CLAUDE.md §11/§12/§6)
- **Egress:** port `reference/egress/send-handler.js` into `src/`, register a `matrix` route with `encryptionGate` (refuse a room without `m.room.encryption`) + `allowlistGate`. All space→peer output flows through it; orchestration never calls the raw client.
- **Inbound (persist+notify once):** `matrix-client.js` `onTimelineEvent` → decrypt → `lexicon.validate($type)` → persist once (idempotent on event-id) via `spaceKnowledge.add`/`spaceRooms.create` (`source_type` = remote, `source_user_id` = sender synthetic id) → notify once.
- **Scope isolation:** persist under scope `space:<id>`/`matrix`. ⚠️ `space_knowledge` has **no scope column** — adding one requires a migration **and** registering it in `crypto-local.js:608-625`'s scope-table list together, or INSERTs break (the documented `tasks` gotcha).

## Build steps (dependency order) — sandbox-buildable vs deferred

| # | Step | Sandbox (unit-verifiable) | Deferred → real host |
|---|---|---|---|
| B1 | `src/federation/matrix-client.js` — injectable interface + `MockMatrixClient` (+ add `matrix-js-sdk` when wiring real) | interface + mock | real login/sync/Megolm |
| B2 | `src/federation/lexicon.js` — validators for space/room/knowledge.v1 (+ §7 vector tripwire) | ✅ | — |
| B3 | wire `identityChannels` into getDb; MXID bind/list | ✅ | — |
| B4 | `space_matrix_rooms` migration + namespace, wired | ✅ | — |
| B5 | DID doc `#matrix` advertise + `resolveMatrixService` | advertise/parse ✅ | cross-box resolve (S2S) |
| B6 | orchestration: grant→invite, revoke→kick, ensureRoom-on-first-grant (mock client dep) | ✅ (mock) | real invite |
| B7 | port egress send-handler into `src/`, register `matrix` route + gates | gate-chain logic ✅ | real send |
| B8 | mirror: `space_knowledge.add`/`space_rooms.create` → emit lexicon via egress | ✅ (mock captures) | — |
| B9 | inbound: onTimelineEvent → validate → persist-once → notify-once, scoped | logic ✅ | real decrypt (spike-proven) |
| B10 | scope column on `space_knowledge` + register in `crypto-local.js` table list | ✅ | — |
| B11 | two boxes · two homeservers · S2S · persistent crypto store · Continuwuity binary | — | ✅ DEFERRED (Docker down, Continuwuity unobtainable in-sandbox; needs a real host) |

**Sandbox-verifiable core:** B1-mock, B2, B3, B4, B5-advertise, B6, B7-logic, B8, B9-logic, B10 — the entire data model + lexicon validation + egress gate chain + client orchestration, unit-testable against `MockMatrixClient` + mock `d1Query` (the injected-seam pattern every namespace already uses, `connections.js:85-87`).

**Deferred to a real host:** live homeserver login/sync (proven in the A1b spike), S2S federation between two boxes, persistent crypto store, the Continuwuity binary/footprint (A2). None block building+verifying B1-B10.

## Critical files
- `src/db/index.js` (wire identityChannels + space-matrix-rooms; inject matrixClient)
- `src/portal-compat.js:477-499` (grant/revoke → invite/kick hooks)
- `src/federation/did.js:100-162` (advertise `#matrix` + `resolveMatrixService`)
- `reference/egress/send-handler.js` (port into `src/`, register `matrix` route)
- `src/db/identity-channels.js` (MXID binding; currently unwired)
- new: `src/federation/{matrix-client,lexicon}.js`, `src/db/space-matrix-rooms.js`, a `space_matrix_rooms` migration

## Recommended sequencing note
The sandbox core (B1-B10) is **mock-verifiable only** — its real value (live delivery) is proven against a homeserver (B11), which this sandbox can't run. Highest-confidence path: build the pure foundation (B2 lexicon, B3 identity_channels, B4 model, B5-advertise) now; build the orchestration/egress/inbound (B6-B9) **alongside provisioning a real homeserver** so they're end-to-end-proven, not just mock-green.
