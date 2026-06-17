# Federation Sharing + People Notifications — Design

**Date:** 2026-06-17
**Branch:** `feat/prelaunch-remaining`
**Protocol:** `/sweep-first-design` — 2 sweep cycles (6 Explore sweeps) + author re-reads of every load-bearing claim. Security-sensitive (new federation surface that serves vault content to a peer).
**Status:** DESIGN LOCKED — not built. Build is phased; Phase 3 (content serve) needs the verification table green before it ships.

---

## 0. Problem (what the user hit)

1. The People **Shared tab is one-directional** — it shows only what *I* granted to a peer, never what *they* granted to me.
2. **Shared content is never served across instances** — granting a space/context writes a *local* row; the peer's instance gets no announcement and has no endpoint to read the documents inside. "Those don't seem to be served."
3. The People nav item has **no notification badge** for invites / unread messages / new shares.

## 1. Root cause (as-built, verified)

Two independent local sharing systems, **inert across instances**:

- **Contexts** — `sharing_contexts` → `context_grants(context_id, connection_id)` → `context_territories`. Grants a connection visibility into mindscape territories. [migrations/0001_init.sql], [src/db/contexts.js].
- **Spaces** — `users(type='space')` + `space_access(space_id, user_id, role)` + `space_knowledge` + `space_room_documents`. [src/db/spaces.js, space-access.js, space-room-documents.js].
- `/connections/:id/shared` ([src/portal-compat.js:355-381]) returns **only outbound** grants (`space_access.user_id = peerId`, `context_grants.connection_id = cid AND sc.user_id = userId`).
- **Federation surface is 5 endpoints** (`did.json`, `webfinger`, `connect`, `connect-response`, `message` — [src/federation/router.js]); **none serve content**. A grant for a remote peer writes `space_access.user_id = <peer synthetic id>` *locally on the granter*; the grantee's instance is never told and cannot fetch. Cross-instance content delivery was intended via Matrix/Megolm (built-but-dormant); no document-federation layer exists.
- No "new share" signal: `space_access`/`context_grants` carry only `granted_at`, no seen marker, no "incoming to me" query.

## 2. Design — a signed federation sharing layer

Three signed message types + one read endpoint, all reusing the **existing fail-closed `verify()` gate** ([src/federation/handlers.js:64-88]) and the **outbound `signedFederationPost` / `resolveFederationEndpoint` / `safeFetch`** primitives ([src/db/connections.js:138-177], [src/federation/ssrf.js]). Mirrors `connect`/`message` exactly.

### 2.1 New data model — `inbound_shares` (on the grantee, B)

```sql
-- migrations/00NN_inbound_shares.sql
CREATE TABLE IF NOT EXISTS inbound_shares (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,        -- local connection to the granter (A)
  peer_did      TEXT,                 -- A's verified did:web (source of truth for fetch)
  kind          TEXT NOT NULL,        -- 'space' | 'context'
  remote_ref    TEXT NOT NULL,        -- A's space_id / context_id (opaque handle on B)
  name          TEXT,                 -- ENCRYPTED: A's label ("Work") — a hint about A's life
  role          TEXT,                 -- space role: member|contributor
  granted_at    TEXT,                 -- A's grant timestamp (as announced)
  revoked       INTEGER DEFAULT 0,    -- A announced a revoke
  seen          INTEGER DEFAULT 0,    -- B has viewed it (drives the badge)
  created_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(connection_id, kind, remote_ref)
);
```
`name` → `ENCRYPTED_FIELDS.inbound_shares = ['name']` (a peer's space label can hint at their life-domain; encrypt at rest on B). Everything else is structural. Outbound side reuses existing `space_access`/`context_grants` on A — **no change to the granter's storage**.

### 2.2 Message 1 — Share announce  `social.mycelium.share.v1`  (A → B)

When A grants (or revokes) a space/context to connection B, A also fires a signed announce to B's `/federation/share`:
```js
{ $type: 'social.mycelium.share.v1', from_did, kind:'space'|'context',
  ref: <A's space_id/context_id>, name: <label>, role?: 'member'|'contributor',
  action: 'grant'|'revoke', nonce, ts }
```
B's handler: `verify()` → resolve connection by A's did → `upsert inbound_shares` (`seen=0` on grant; `revoked=1` on revoke). Fire-and-forget on A's side (failure leaves A's local grant intact; a re-grant re-announces). Audited.

### 2.3 Message 2 — Content fetch  `social.mycelium.shared-content.v1`  (B → A)

When B opens an inbound share, B's *portal* asks B's *server* to fetch from A. B sends a signed POST to A's `/federation/shared-content`:
```js
{ $type:'social.mycelium.shared-content.v1', from_did:<B>, kind, ref, nonce, ts }
```
A's handler (THE security-critical path):
1. `verify()` B (signature/nonce/ts/rate-limit/size-cap/did).
2. Resolve B's did → connection (`remote_did = B OR remote_instance = didWebHost(B)` AND `status='accepted'`) → derive B's synthetic peer id (`other_user_id`) + `connection.id`.
3. **Grant gate (fail-closed):**
   - space: `SELECT 1 FROM space_access WHERE space_id=ref AND user_id=<B peer id> AND revoked_at IS NULL`.
   - context: `SELECT 1 FROM context_grants WHERE context_id=ref AND connection_id=<connection.id>` AND the context is `is_private=0` (private contexts never expose).
   - No active grant → **403** (indistinguishable from unknown).
4. Build a **vector-free** payload via share-only accessors:
   - space → `{ name, knowledge:[{content,source_type,created_at}], documents:[{path,title,summary}] }` (NO `embedding_768`, NO `metadata` blob unless whitelisted).
   - context → `{ name, territories:[{territory_id,name,essence,realm_id}] }` (NO `centroid_256/centroid_3d/embedding_768`).
5. **`hasVectorKey(payload)` tripwire** ([src/db/connections.js:59-62]) before serialization → throw if any `centroid|embedding|vector` key slipped in.
6. **Size cap**: documents ≤ 200, knowledge ≤ 200, total serialized ≤ 1 MB → else truncate + flag.
7. **Sign the response**: return body with `X-Myc-Did: A`, `X-Myc-Sig: sign(canonicalize(body))`. B verifies against A's pinned did:web key ([resolveDidKey], [verifyDetached]) → no MITM/forgery.
8. **Audit** the serve (peer did, kind, ref, item counts — never content).

### 2.4 Message 3 — Document content fetch  `social.mycelium.shared-doc.v1`  (B → A, deeper)

To READ a shared document's body: B signs `{ kind:'space', ref, path, nonce, ts }`; A re-checks the grant AND that `path` is in that space (`space_room_documents`), reads the doc via a **new `documents.getForShare(userId, path)`** (explicit columns, **excludes `embedding_768`**), decrypts `content`, vector-tripwires, size-caps (≤ 1 MB), signs, audits. (Document content is encrypted at rest; sharing intentionally serves the decrypted plaintext over the signed channel — load-bearing assumption.)

### 2.5 The People badge (3 sources)

New `GET /portal/people/badge` → `{ invites, unread, newShares, total }`:
- `invites` = `db.connections.pending(userId).length`
- `unread` = `db.connections.unreadMessages(userId).total`
- `newShares` = `COUNT(inbound_shares WHERE seen=0 AND revoked=0)`
Sidebar replaces its `/connections/count` poll with this (15 s), renders `total` on the **People** item; `BottomTabBar` gets the same badge. Mark-seen: `POST /portal/inbound-shares/seen` (all) when B opens the Shared tab.

### 2.6 Bidirectional Shared tab

`/connections/:id/shared` gains an `inbound` block (query `inbound_shares` for this connection) alongside the existing `outbound`. UI: **"You shared"** + **"Shared with you"**; clicking an inbound item calls B's portal → `/portal/connections/:id/shared/:shareId/contents` → B's server does the signed content fetch from A → renders documents/knowledge **read-only**.

---

## 3. Threat model

| Threat | Mitigation |
|---|---|
| Unauthorized content read (peer not granted) | Grant gate is fail-closed (403); checked **live** each request, so revocation is immediate. Private contexts never serve. |
| Forged/spoofed peer identity | `verify()` resolves did:web key + ed25519 signature; connection matched on `verifiedHost`/`remote_did`, never payload claims. |
| MITM on fetched content (B trusts wrong content) | A **signs the response body**; B verifies against A's pinned did:web key. |
| Embedding/vector exfiltration (§7) | Share-only accessors exclude `embedding_768`/`centroid_*`; `hasVectorKey` tripwire on every payload before signing; new `documents.getForShare` never selects vectors. **Never call `documents.get()` (SELECT *) on the serve path.** |
| SSRF (B→A fetch, did resolution) | `safeFetch` (resolve-once, validate-every-address, pin, fail-closed) + `resolveFederationEndpoint` host-binding + no-redirect. |
| Replay / DoS | `verify()` nonce dedup + ±5 min ts + per-peer (30) + global (120) rate limit + 8 KB inbound cap. Outbound content response gets its own ≤1 MB + count caps (new — none exists today). |
| Plaintext leakage in logs (§1) | Audit logs counts/ids only, never content; content never logged. |
| Revoked share still readable | Live grant check on every serve + announce-revoke marks `inbound_shares.revoked=1`; B hides it. |
| Stale/abandoned announce delivery | Fire-and-forget; A's local grant is source of truth; re-grant re-announces; B can also pull-refresh (future). |

**New attack surface:** 2 new signed inbound endpoints on A (`/federation/share` receive on B; `/federation/shared-content` + `/federation/shared-doc` serve on A) — all signature-gated, fail-closed, grant-gated. No new unauthenticated surface. Federation stays 503 when no public host.

---

## 4. Module shape + LOC budget (±20%)

| File | Change | LOC |
|---|---|---|
| `migrations/00NN_inbound_shares.sql` | new table | ~16 |
| `src/crypto/crypto-local.js` | `inbound_shares:['name']` | ~2 |
| `src/db/inbound-shares.js` | namespace (upsert/list/listForConnection/markSeen/unseenCount/revoke) | ~70 |
| `src/db/documents.js` | `getForShare` (explicit cols, no vectors) | ~12 |
| `src/db/contexts.js` | `getForShare` (territories, vector-free — already safe) | ~6 |
| `src/db/spaces.js` / space-* | `contentForShare(spaceId)` (knowledge+docs, vector-free) | ~30 |
| `src/db/connections.js` | `announceShare` (sign+POST), `fetchSharedContent` (sign+POST+verify response), grant-resolve helpers | ~120 |
| `src/federation/handlers.js` | `share()` (receive announce), `sharedContent()` + `sharedDoc()` (serve, grant-gated, vector-tripwire, sign response, audit) | ~110 |
| `src/federation/router.js` | 3 routes | ~12 |
| `src/portal-compat.js` | badge endpoint; bidirectional `/shared`; inbound-share view + seen; wire announce into POST /spaces/:id/shares + /contexts/:id/grant (+ revoke) | ~90 |
| `portal-app` Sidebar/BottomTabBar | combined badge | ~30 |
| `portal-app` ConnectionsView | bidirectional Shared tab + read-only shared-content viewer | ~160 |
| `tests/*` + `verify:federation-sharing` | grant-gate, vector-strip, signed-response verify, revoke, dedup | ~200 |
| **Total** | | **~858** |

---

## 5. Implementation order (each independently shippable + verifiable)

- **Phase 1 — badge + bidirectional surface (local, no federation content).** `inbound_shares` table; `GET /portal/people/badge`; Sidebar/BottomTabBar badge; `/shared` gains an `inbound` block (empty until Phase 2 populates it); mark-seen. Gate: `verify:federation-sharing` (model + badge counts). *Visible win immediately; the part the user can see day one.*
- **Phase 2 — share announce (A→B).** `announceShare` wired into grant/revoke; `share()` receive handler populates `inbound_shares`; audit. Now "Shared with you" lists real entries + the badge lights on a new share. Two-instance smoke (hi↔lo).
- **Phase 3 — content serve + fetch (the security core).** `sharedContent()` serve (grant-gated, vector-stripped, signed response, size-capped, audited) + `fetchSharedContent` (B verifies A's signed response) + the read-only viewer. **Does not ship until the verification table is green**, including the raw vector-leak assertion + signed-response + revoke tests.
- **Phase 4 — per-document content read** (`sharedDoc` + `getForShare`). Read a shared document's body.

## 6. Test strategy → `verify:federation-sharing`

1. **grant gate** — peer with no `space_access`/`context_grant` → serve returns 403; private context never serves. *(security-critical)*
2. **revocation** — grant→serve OK; revoke→serve 403 on the next request (live check). *(security-critical)*
3. **vector strip** — serve a space whose document has `embedding_768` set; assert the served payload contains NO `embedding`/`centroid`/`vector` key (and `hasVectorKey` would throw if it did). *(security-critical, §7)*
4. **signed response** — B verifies A's response signature with A's key; a tampered body fails `verifyDetached`. *(security-critical)*
5. **identity** — content request signed by a non-connected DID → 403; wrong-did header → 401 (verify gate).
6. **dedup/idempotency** — re-announced share upserts (no dup row); replayed nonce rejected.
7. **size cap** — oversize space (300 docs) → response truncated + flagged, ≤1 MB.
8. **badge** — counts = invites + unread + unseen shares; mark-seen drops the count.
9. **encryption at rest** — `inbound_shares.name` is ciphertext in the raw DB.
10. svelte-check clean on the touched components.

## 7. Decision criteria to ship Phase 3
- `verify:federation-sharing` EXIT 0 incl. tests 1-4 + 9.
- Two-instance (hi↔lo) smoke: A shares a space → B's badge lights → B opens "Shared with you" → B reads the document list (and a doc body) → A revokes → B loses access on next open.
- Raw-DB assertion: no embedding/centroid value appears in any served payload capture.

## 8. Risks + mitigations
| Risk | L | I | Mitigation |
|---|---|---|---|
| Vector leak via a future SELECT * on the serve path | Med | High | Dedicated `getForShare` accessors + `hasVectorKey` tripwire + test #3; never `documents.get()` on serve. |
| Content served to a revoked/never-granted peer | Low | High | Live fail-closed grant check; tests #1/#2. |
| Unsigned/forged content trusted by B | Low | High | A signs response; B verifies; test #4. |
| Unbounded download DoS | Med | Med | ≤1 MB + count caps on serve. |
| Two-instance complexity hides a bug | Med | Med | Phases 1-2 are local-verifiable; Phase 3 gated on the hi↔lo smoke. |
| Scope creep into full Matrix room sync | Med | Med | This is an HTTP pull layer, explicitly NOT Matrix; Megolm stays out of scope. |

## 9. Open questions resolved during sweep
- *Is sharing bidirectional?* No — `/shared` is outbound-only; inbound requires the new `inbound_shares` + announce.
- *Is content served cross-instance?* No — zero endpoints; this design adds them.
- *Peer↔grant identity?* did → connection (`remote_did`/`verifiedHost`, accepted) → `other_user_id` (space_access) / `connection.id` (context_grants). Verified.
- *Vector exposure?* `documents.get()` is `SELECT *` → leaks `embedding_768`; `getTerritories()` is already vector-free. New `getForShare` + tripwire required.
- *Can B trust fetched content?* Only if A signs the response — `sign.js` supports it; design mandates it.
- *Audit?* Federation handlers don't audit today; this design adds audit on announce + serve.

## 10. Open questions deferred (named)
- Matrix/Megolm real-time room sync (the other cross-machine path) — out of scope.
- Pull-refresh of inbound shares (vs announce-push only) — add if announces are missed.
- Sharing a *single document* directly with a connection (vs via a space) — future.
- Per-share notification toasts / activity-feed entries — future.

---

## Verification table

| Assumption | Verified at (author-read) |
|---|---|
| `/connections/:id/shared` is outbound-only | [src/portal-compat.js:355-381] |
| Federation surface = 5 endpoints, none serve content | [src/federation/router.js] |
| `verify()` gate: nonce/ts/rate-limit/size-cap/did/sig, fail-closed | [src/federation/handlers.js:64-88] |
| did → connection match (`remote_did`/`verifiedHost`, accepted) | [src/db/connections.js:763-768] (receiveMessage, author-built) |
| `space_access.user_id` = connection `other_user_id` (synthetic peer id) | [src/db/connections.js:556], [src/portal-compat.js grants] |
| `context_grants.connection_id` = connection id | [src/db/contexts.js:109-115] |
| **`documents.get()` is `SELECT *` → leaks `embedding_768`** | [src/db/documents.js:86-92] |
| `getTerritories()` is vector-free (id,name,essence,realm_id) | [src/db/contexts.js:98-106] |
| `hasVectorKey` tripwire (recursive `centroid|embedding|vector`) | [src/db/connections.js:59-62] |
| `sign.js`: `canonicalize` + `verifyDetached` (sign/verify a body) | [src/federation/sign.js:25-43] |
| Outbound: `signedFederationPost` + `resolveFederationEndpoint` | [src/db/connections.js:138-177] |
| SSRF: `safeFetch` resolve-once/validate/pin/fail-closed | [src/federation/ssrf.js:143-165] |
| Audit namespace (counts/ids, never PII); handlers don't audit yet | [src/db/audit.js:93-144] |
| Federation router mount + reachable behind relay, 503 when unconfigured | [src/server-http.js:251-264] |
| Badge sources: pending() + unreadMessages(); no new-share signal exists | [src/portal-compat.js:282-285,335-338] |
| Sidebar badge poll pattern (15 s, component-local) | [portal-app Sidebar.svelte:18-27,230-232] |
