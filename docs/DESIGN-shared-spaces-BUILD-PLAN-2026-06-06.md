# Build Plan — Shared Spaces: default-private folders + fine-grained access (Phase A), Matrix-federated sharing (Phase B)

**Date:** 2026-06-06
**Status:** Design + build plan (operator decisions locked below). Phase A builds now; Phase B is gated on Tier-1 Matrix.
**Companion:** `docs/DESIGN-federation-inter-instance-2026-06-05.md` (Tier-2 shared pools, D-FED-2), `docs/legacy/SOCIAL-SHARING-SPEC-from-legacy.md` (Phase 3 context grants + Phase 5 shared spaces + the "NEVER shared" invariant).

## Operator decisions (locked)

| ID | Decision |
|---|---|
| **D-SPACE-1** | Federated shared spaces ride **Matrix rooms (Megolm per-recipient E2EE)** — owner-hosted-read and plaintext-between-boxes are rejected. So cross-node sharing **waits for Tier-1 Matrix** (A1b spike → Continuwuity → Megolm rooms). |
| **D-SPACE-2** | **Local first, then federate.** Phase A = local default-private folders + access-control foundation + live UI. Phase B = federate the grant over Matrix. |
| **D-SPACE-3** | v1 encryption bar = **per-recipient E2EE** (i.e. Megolm via Matrix). No plaintext-between-boxes federation ships. |

**Consequence (stated plainly):** the headline "share a space with a connection" is inherently cross-node (connections are remote) and is therefore **delivered in Phase B with Matrix**. Phase A delivers the *folder feature* + the *default-private access foundation* + a live UI — the owner-side model Phase B plugs into. The Matrix track (A1b spike) is the critical path for actual sharing.

## Current state (sweep-verified)

The spaces substrate exists and is a folder model, but is local, half-dormant, and hidden:
- Space = `users` row `type='space'`; roles creator/contributor/member; membership in `space_access` (grant/revoke/invite). `src/db/spaces.js` (**wired**), `space-access.js` (**dormant**), `migrations/0001_init.sql:1181-1195,1585-1592`.
- Folders: `space_rooms` (nested, cover-doc "doors") + `space_room_documents` (docs in folders) + `space_knowledge` (entries, `visibility` default `'all'`). `src/db/space-rooms.js`, `space-room-documents.js` (**dormant**), `space-knowledge.js` (**wired**). Schema at `0001_init.sql:1219-1264`.
- Granular per-connection model: `contexts` (`sharing_contexts`/`context_territories`/`context_grants`), default-private, `canSeeTerritory` fail-closed. `src/db/contexts.js` (**dormant**), `0001_init.sql:1172-1180,563-577`.
- UI fully built but **unreachable**: `portal-app/.../spaces/+page.svelte` (list) + `spaces/[id]/+page.svelte` (1116 lines: folders/knowledge/members/settings). Calls ~15 `/portal/spaces/*` endpoints that **don't exist** (all 404). Not a workspace view; 'Spaces' is a disabled "Coming later" chip; **no sharing/invite UI** (members read-only). `secure-fetch.ts` has no `/portal/spaces` entries.

## Access model (default-deny)

- **Default reveals nothing:** a space with no `space_access` grants (beyond the creator) is invisible. Grants are the only entry → fail-closed (CLAUDE.md §3). Every space read/write goes through `requireRole(spaceId, userId, minRole)`.
- **Roles:** `member` (read), `contributor` (add rooms/docs/knowledge), `creator` (manage + share + delete).
- **"Share a space" ≡ "create a shared space":** both are a space + `space_access` grants to chosen connections (a grant row keyed by the connection's peer id, the same DID-keyed id `connections` caches). One grants an existing space; the other creates then grants.
- **Privacy invariant:** only items explicitly placed in a space are visible to its members. Raw embeddings/centroids/vectors/message-content **NEVER** federate (CLAUDE.md §7; legacy "NEVER shared" table). Phase A is local, so nothing leaves the box yet.
- **Granularity:** v1 = **per-space** grant (a member sees everything in the space). Per-item visibility (`space_knowledge.visibility`, `context` gating) is a later refinement.

## Phase A — build steps (local; each independently shippable + tested)

1. **Wire dormant namespaces** in `getDb`: `spaceAccess`, `spaceRooms`, `spaceRoomDocuments`, `contexts` (+ `spaceConversations` if needed). (`src/db/index.js`)
2. **Spaces REST** (`src/portal-compat.js`, new section) — the ~15 endpoints the UI calls, each `requireRole`-gated: `GET/POST /spaces`, `GET/PUT/DELETE /spaces/:id`, `GET/POST/DELETE /spaces/:id/knowledge[/:entryId]`, `GET /spaces/:id/members`, `GET/POST/DELETE /spaces/:id/rooms[/:roomId]`, `GET /spaces/:id[/rooms/:roomId]/contents`, `POST .../seed-doc`, `DELETE .../contents/:docId`, `GET /spaces/territories`, `POST /spaces/:id/seed`.
3. **Sharing endpoints + access enforcement:** `GET /spaces/:id/shares` (granted connections), `POST /spaces/:id/shares {connectionId, role}` (grant), `DELETE /spaces/:id/shares/:granteeId` (revoke). Default-deny everywhere; non-members → 404 (indistinguishable from missing).
4. **Promote Spaces to a live workspace view:** de-route into `SpacesView.svelte` + `SpaceDetailView.svelte` (params: `{id}`), register in `registry.ts`, route pages become dispatchers, promote 'Spaces' to a live nav item.
5. **Sharing UI:** in the space detail Members tab, a "Share with a connection" control (pick from accepted connections → role) → grant; list shared-with + revoke. Phase A labels remote delivery as "activates when your real-time channel is set up" (Phase B/Matrix).
6. **secure-fetch:** add `/portal/spaces` sensitive prefix + static/parameterized route types.
7. **Verify:** `verify:spaces` gate (real boot + REST round-trip: create space → add room/doc/knowledge → grant → fail-closed for a non-member). Tests for the wired namespaces (mock d1Query) + access enforcement.

## Phase B — federate (deferred, gated on Tier-1 Matrix)

A shared space ⇄ a Matrix room (Megolm E2EE); `social.mycelium.space/room/knowledge.v1` lexicon records mirror into each member box's `space_*` tables (D-FED-2). Grant → invite the connection's MXID to the room. Build after the A1b spike + Continuwuity end-to-end (see the federation design doc §3 Tier-2 + §5 A1b).

## Verification table

| Assumption | Verified at |
|---|---|
| Space = users row type='space'; roles + space_access membership | `src/db/spaces.js:30-119`; `migrations/0001_init.sql:1181-1195,1585-1592` |
| Folders = space_rooms (nested) + space_room_documents | `src/db/space-rooms.js`; `migrations/0001_init.sql:1219-1264` |
| Default-private per-connection model exists (contexts), fail-closed | `src/db/contexts.js:159-170`; `migrations/0001_init.sql:1172-1180` |
| space-access/rooms/room-docs/contexts are dormant (not in getDb) | `src/db/index.js` (absent imports) |
| Spaces UI built but no REST + not a workspace view + hidden nav | `portal-app/.../spaces/*`; `registry.ts`; `Sidebar.svelte` comingLater |
| Federation transport for sharing = Matrix (E2EE), not built yet | `docs/DESIGN-federation-inter-instance-2026-06-05.md` D-FED-2, §5 A1b |
