# DESIGN — Connection Presence Indicator (online/offline)

**Date:** 2026-06-18
**Status:** Designed, sweep-verified (3 cycles), **decisions locked**. Not built.
**Surface:** Federation Tier-0 — `src/federation/*` (:4711), `src/db/connections.js`, a new `src/db/peer-presence.js`, `src/portal-compat.js` + `src/server-rest.js` (:8787), one migration, `portal-app/.../ConnectionsView.svelte`.
**Principle anchors:** CLAUDE.md §1 (no plaintext leakage), §3 (fail closed), §7 (no vectors — N/A), §8 (audit, no PII), and the "local-primary single-user" deployment note.

---

## 0. Goal & visual contract

Show, in the Connections UI, which connections are online — three visually distinct states:

| Render | Meaning |
|---|---|
| 🟢 **green dot** | shared with me **and** online (their Mycelium client is active) |
| ⚪ **grey dot** | shared with me **and** offline |
| **no dot** | not shared with me (never / revoked / paused) or never reached |

## 1. Privacy model (reconciled)

- **World / non-connections:** never see presence. (`/.well-known/did.json` already reveals the box answers HTTP; presence adds nothing.)
- **Connections:** presence is **shared by default the moment a connection is formed**, **revocable per connection**, with an optional global "appear offline to everyone" pause.

Hidden from everyone except your connections; on by default *for* connections; you can turn it off per connection (or globally).

## 2. Revision history

- **v1** — Global opt-in (`presence.enabled`, default OFF); binary online/hidden; in-memory `lastActiveAt`; no at-rest state.
- **v2** — Operator pivot: *share-by-default-with-connections, revocable*; added the third (grey) state; per-connection `presence_share`.
- **v3 (this doc, post-sweep)** — Two structural pivots forced by live code:
  - **P1 (process boundary).** v1/v2 put `lastActiveAt` "in memory." Sweep proved federation runs on **:4711** (`server-http.js`, `app.listen` [server-http.js:611]) and portal + the auth chokepoint run on **:8787** (`server-rest.js:738`, `app.listen`) — **separate Node processes, separate heaps** ([server-rest.js:435](src/server-rest.js:435) `await boot(opts)` is a second independent boot). An in-memory variable is invisible across them, and there is **no `/run/mycelium` tmpfs** in this repo. → Activity is a **throttled write to the shared SQLCipher DB** (sanctioned cross-process pattern), read by the :4711 responder.
  - **P2 (naming collision).** `db.publicPresence` / `public_presence` already exist for *anonymous "reading-now" counts on published documents* ([public-presence.js](src/db/public-presence.js), [0001_init.sql:1029](migrations/0001_init.sql:1029)) — unrelated. → New namespace named **`db.peerPresence`**; new wire type `social.mycelium.presence-query.v1`.
  - **P3 (hardening, sweep-driven).** The signed response now **echoes the request nonce** so a MITM cannot replay a stale "online". And `queryPresence` **caches the resolved federation endpoint** so a many-connection user doesn't re-WebFinger every poll.

## 3. Architecture (as it must be, given the process split)

```
:8787  server-rest.js  (portal + vault auth)          :4711  server-http.js (federation)
┌───────────────────────────────────────┐            ┌──────────────────────────────────┐
│ vault-auth chokepoint (/api)           │            │ POST /federation/presence          │
│   → peerPresence.touch(userId)         │  shared    │   verify() gate (sig+nonce+ts+rl)  │
│     (throttled ≥60s, fire-and-forget)  │  SQLCipher │   findAcceptedByPeer → presence_share│
│                                        │  ───────►  │   peerPresence.lastActiveAt(read)  │
│ GET /portal/connections/presence       │   DB       │   remote.json presence.paused      │
│   → connections.queryPresence(userId)  │            │   → signed {state, nonce, ts}      │
│     signs+POSTs to each peer's :4711 ◄─┼── HTTP ───►│                                    │
│     verifies signed reply, caches      │            └──────────────────────────────────┘
└───────────────────────────────────────┘
```

Three cross-process channels, all sanctioned: **shared DB** (`users.last_active_at`, `connections.presence_share`), **remote.json** (`presence.paused`, re-read per call — [config.js](src/remote/config.js) `readRemoteConfig` is uncached), and **signed federation HTTP** (querier→peer).

## 4. Locked decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Mechanism | **Pull-on-demand** | Reachability ≈ liveness; no background fan-out. |
| D2 | Visual states | **green / grey / no-dot** | Distinguish shared-but-offline from not-shared (operator request). |
| D3 | Reciprocity | **Independent** | Each side controls its own visibility. |
| D4 | Default | **`presence_share` defaults to 1** at the column level | "Share by default on forming a connection" — and `ADD COLUMN … DEFAULT 1` backfills existing connections to shared too. |
| D5 | Activity store | **`users.last_active_at`**, throttled write (≥60s) from the :8787 auth chokepoint | Cross-process via shared DB; ~1 write/min is negligible (WAL on; background_jobs already heartbeats every 10s). |
| D6 | "Online" semantic | **A Mycelium client has been active within `activeWindowMin` (default 5)** | The app polls /portal every 5–15s while open, so `last_active_at` tracks "client open," not "box up" — correct for always-on remote boxes. |
| D7 | Response auth | **Sign the reply AND echo the request nonce** | No "online" forgery; no stale-reply replay. |
| D8 | Global pause | **`remote.json: presence.paused`** (default false) | Cheap panic-button "appear offline to everyone." |

## 5. Module shape (signatures + LOC budget)

**Migration `migrations/0023_connection_presence.sql`** (~3 SQL lines; idempotent per [migrate.js:33-43](src/db/migrate.js) ADD COLUMN guard):
```sql
ALTER TABLE connections ADD COLUMN presence_share INTEGER DEFAULT 1;  -- per-peer outbound share grant
ALTER TABLE users ADD COLUMN last_active_at TEXT;                     -- owner activity heartbeat (single-user → 1 row)
```

**`src/db/peer-presence.js`** — new namespace, wired in [db/index.js](src/db/index.js) next to `connections` (~30 LOC):
```js
createPeerPresenceNamespace({ d1Query })  →  {
  async touch(userId),                 // UPDATE users SET last_active_at = datetime('now') WHERE id = ?
  async lastActiveAt(userId),          // SELECT last_active_at → string|null
}
```
Throttling lives in the *caller* (module-level timestamp on :8787), not here, so the method stays a pure write.

**`src/db/connections.js`** — add to the returned object (~70 LOC):
```js
async presenceShareForPeer({ fromDid, verifiedHost, toUserId }), // → { connId, share:boolean } | null  (accepted + presence_share)
async setPresenceShare(userId, connectionId, share),             // assertMember; UPDATE presence_share
async queryPresence(userId),                                     // fan-out to accepted REMOTE peers; returns { [id]: 'online'|'offline'|'none' }
```
`queryPresence` reuses the **exact** [fetchSharedContent](src/db/connections.js:915) sign-request / safeFetch / verify-response pattern; adds an in-memory endpoint cache (TTL 1h) + last-known-shared cache + concurrency cap (e.g. 6) + ~3s per-peer timeout. Result memoized ~45s.

**`src/federation/handlers.js`** — new `presence()` handler (~25 LOC) + two new deps (`getPresenceConfig`, `getLastActiveAt`):
```js
async presence({ payload, headers, ip }) {
  const v = await verify({ payload, headers, ip });            // reuse — sig+nonce+ts+rate-limit
  if (!v.ok) return { status: v.status, body: v.body };
  if (payload.$type !== 'social.mycelium.presence-query.v1') return { status: 400, body: { error: 'unexpected $type' } };
  const peer = await db.connections.presenceShareForPeer({ fromDid: v.did, verifiedHost: didWebHost(v.did), toUserId: userId });
  const paused = !!getPresenceConfig()?.paused;
  let state = 'hidden';
  if (peer && peer.share && !paused) {
    const last = await getLastActiveAt();                       // users.last_active_at
    const active = last && (now() - Date.parse(last)) < (getPresenceConfig()?.activeWindowMin ?? 5) * 60000;
    state = active ? 'online' : 'offline';
  }
  const body = { state, nonce: payload.nonce, ts: now() };      // echo nonce (D7)
  const canon = canonicalize(body);
  db.audit?.log?.({ action: 'presence_served', userId, ip, details: { peer: didWebHost(v.did), state } })?.catch?.(()=>{}); // host+state only
  return { status: 200, signedBody: canon, sig: identity.sign(canon), did: `did:web:${getHost()}` };
}
```
`hidden` is returned identically for not-a-connection, revoked, and paused → **no oracle** separating them.

**`src/federation/router.js`** — `POST /federation/presence` mirroring the shared-content signed-emit (~8 LOC).

**`src/server-http.js`** (:4711 call site, ~6 LOC) — thread `getPresenceConfig: () => readRemoteConfig().presence || {}` and `getLastActiveAt: () => ingest.db.peerPresence.lastActiveAt(ingest.userId)` into `createFederationRouter({…})`.

**`src/server-rest.js`** (:8787, ~25 LOC):
- After `v.use('/api', vaultAuth)` ([server-rest.js:235](src/server-rest.js:235)): a tiny throttled middleware → `db.peerPresence.touch(req.requester.id)` (fire-and-forget, module-level ≥60s gate, never awaited, never throws).
- `GET /portal/connections/presence` → `db.connections.queryPresence(userId)` (in portal-compat.js).
- `PUT /portal/connections/:id/presence { share:boolean }` → `db.connections.setPresenceShare(...)`.

**`src/remote/config.js`** (~4 LOC) — accept/validate `patch.presence = { paused:boolean, activeWindowMin?:number }` in `writeRemoteConfig`; surface `presence` in `readRemoteConfig`.

**`portal-app/src/lib/views/ConnectionsView.svelte`** (~50 LOC) — add `presence_share?: number` to the `Connection` interface (mapConn already spreads `...c` → the column flows through, [portal-compat.js:268](src/portal-compat.js:268)); add a `presence` map + ~30s poll of `/portal/connections/presence`; render the avatar dot (green/grey/none); add a "Share my online status" toggle to the existing `⋯` menu calling the PUT endpoint.

**Total ≈ 380 LOC (±20%).**

## 6. Threat model

- **Adversary 1 — a stranger probing `/federation/presence`.** Caught by `verify()` (unsigned → 401) and `presenceShareForPeer` (not accepted → `hidden`). Learns only "the box answers HTTP," already public via did.json.
- **Adversary 2 — a connection trying to detect activity after you revoked.** Revoked → `hidden` → no dot. They *can* tell you revoked (dot disappears) — **intended** per D2; documented so it's not a surprise.
- **Adversary 3 — MITM on the tunnel.** Can drop (→ shows offline/grey, fail-safe) but cannot forge "online": reply is signed by the peer's did:web key and bound to the fresh request nonce (D7). A replayed old reply fails the nonce/freshness check.
- **Adversary 4 — DoS via presence floods.** Shares the existing per-peer (30/min) + global (120/min) inbound rate buckets and the 8KB body cap. New surface adds no unbounded work (one indexed SELECT + one tiny read).
- **New attack surface added:** one signed read-only endpoint; one throttled single-column write; one outbound fan-out (capped, cached). No new secret handling, no plaintext egress, no vectors.

## 7. Edge cases — explicit decisions

| Case | Decision |
|---|---|
| Remote access OFF (no publicHost) | `sign/did` undefined ([db/index.js:108](src/db/index.js)), did.json 404, `/federation/presence` 503 → queriers see unreachable → no dots. Local-only connections can't federate anyway. Consistent. |
| Existing connections (pre-migration) | `ADD COLUMN … DEFAULT 1` backfills them to *shared* — matches "share by default." |
| Box up but client closed | Portal stops polling → `last_active_at` goes stale → `offline` (grey). Correct (D6). |
| Box down entirely | Query times out → if last-known-shared → grey, else no dot. |
| Revoke + go offline simultaneously | Grey persists (can't re-query) until peer returns and answers `hidden`. Minor staleness, accepted. |
| Blocked connection | `status='blocked'` ≠ accepted → `presenceShareForPeer` returns null → `hidden`. |
| Many connections (e.g. 50) | Endpoint cache (skip WebFinger) + concurrency cap + 45s result cache → ~1 POST/peer/45s. |
| At-rest write cost | 1 write/min single column, WAL on ([d1.js:46](src/adapter/d1.js)); background_jobs already heartbeats every 10s — negligible. |

## 8. Test strategy — `verify:presence` (new gate)

By assertion (handler-level, with a stub db + injected `now`/`fetch`, matching existing federation tests):
- **V1** default-on: fresh accepted connection (`presence_share=1`) + recent `last_active_at` → signed `online`; reply signature verifies; echoed nonce matches.
- **V2** connections-only: signed but non-accepted peer → `hidden` (byte-identical to V5/V8 — no oracle).
- **V3** staleness: `last_active_at` older than window → `offline`.
- **V4** revoke: `presence_share=0` → `hidden`; re-grant → restores; `setPresenceShare` rejects a non-member (`assertMember`).
- **V5** paused: `presence.paused=true` → all queriers `hidden`.
- **V6** spoof/replay: tampered body, wrong-signer DID, or mismatched/echoed-stale nonce → querier discards (→ falls back to last-known).
- **V7** unreachable mapping: timeout + last-known-shared → grey; + none → no dot.
- **V8** rate/replay share: presence query reuses nonce+rate buckets (a replayed query nonce → 401).
- **V9** migration idempotency: run `applyMigrations` twice → no duplicate-column throw; `presence_share` present, existing rows = 1.
- **V10** no-leak: audit payload asserts only `{peer: host, state}` — no DID body, no `last_active_at` value, no content.

Live smoke (two-box hi ↔ lo over the real tunnel): form connection → green when a client is active, grey when idle; revoke on one box → dot vanishes on the other; re-grant → returns; quit the app → grey then (per §7) stays grey while unreachable.

## 9. Implementation order (each independently shippable)

1. **Migration + `peer-presence.js` + db wiring.** Smoke: `node -e` apply twice, assert columns (V9).
2. **Activity touch** (server-rest middleware). Smoke: hit any `/portal` route, assert `users.last_active_at` advances ≤1/min.
3. **Responder** (`presence()` + route + :4711 deps). Smoke: signed curl from a test identity for accepted/non-accepted/revoked → online/hidden; run `verify:presence` V1–V6,V10.
4. **Querier** (`queryPresence` + `/portal/connections/presence`). Smoke: GET returns a state map; V7.
5. **Revoke control** (`setPresenceShare` + PUT). Smoke: toggle, re-query → flips.
6. **UI** (dot + toggle + poll). Smoke: portal-ui live-verify (vite :5174 → live :8787); resize/dark.
7. **Global pause** (remote.json field + optional Settings toggle).
8. Full `npm run verify` green + two-box live smoke (§8).

## 10. Decision criteria to proceed past v1

- Two-box live smoke passes all four transitions (green/grey/revoke/quit).
- `verify:presence` + full `npm run verify` green (no subset merge — see no-hotfix discipline).
- Audit shows `presence_served` rows carry host+state only over a day of real use.

## 11. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| WebFinger storm for many connections | Med | Med (latency) | Endpoint cache (1h) + concurrency cap + 45s result cache (§5/§7). |
| Activity write contention with at-rest WAL | Low | Low | ≥60s throttle, single column, fire-and-forget; precedent = background_jobs 10s heartbeat. |
| Presence reply replay (fake online) | Low | Low | Echoed nonce + freshness + signer-DID match (D7). |
| Revocation detectable by peer | Certain | Accepted | Intended per D2; documented (§6). |
| Process-split regression (dev assumes one process) | Low | High | This doc + §3 diagram; verify table row pins the boundary. |

## 12. Open questions — resolved during sweep

- *Can the responder read an in-memory activity flag?* **No** — separate processes (P1). Use shared DB.
- *Is `presence` a free name?* **No** — `db.publicPresence` exists for doc visitors (P2). Use `peerPresence`.
- *Does :8787's `db.connections` have `sign`/`did` for outbound?* **Yes** — both processes `boot()` and `getDb` wires `federationDeps` ([db/index.js:109-114](src/db/index.js)).
- *Is `ADD COLUMN` safe under re-exec-every-boot?* **Yes** — per-statement PRAGMA guard ([migrate.js:33-43](src/db/migrate.js)).
- *Does `mapConn` drop the new column?* **No** — it spreads `...c` ([portal-compat.js:268](src/portal-compat.js:268)).

## 13. Open questions — deferred

- **Idle state** (online/idle/offline) — wire already carries `state`; add `idle` later, no wire change.
- **Push/notify "a friend came online"** — needs heartbeat + at-rest `last_seen`; out of scope (D1).
- **Global rate-bucket pressure for >120 querying peers/min** — exempt presence into a softer bucket if it ever bites; noted, not built.
- **Durable nonce store (inherited F1)** — federation-wide follow-up; a replayed presence query is read-only (negligible).

---

## Verification table

Every load-bearing assumption, verified at a file:line I read myself.

| # | Assumption | Verdict | Verified at |
|---|---|---|---|
| 1 | Federation routes run on :4711, a distinct express app | ✅ | [server-http.js:268](src/server-http.js:268) mount; `app.listen` server-http.js:611 |
| 2 | Portal `/portal/*` + vault auth run on :8787, a *separate* process | ✅ | [server-rest.js:235](src/server-rest.js:235) `/api` auth, :241 portal mount, :738 listen, :801 port 8787 |
| 3 | The two processes share no heap; coordinate via shared DB | ✅ | independent `await boot(opts)` [server-rest.js:435](src/server-rest.js:435) vs server-http boot |
| 4 | `boot()` wires `sign/did/selfInstance` into `db.connections` (both processes) | ✅ | [index.js:104-122](src/index.js:104), [db/index.js:109-114](src/db/index.js) |
| 5 | `ADD COLUMN` is idempotent under re-exec-every-boot | ✅ | [migrate.js:29-51](src/db/migrate.js) (PRAGMA `columnSet` guard) |
| 6 | `connections` columns are plaintext (no field-encrypt) | ✅ | [connections.js](src/db/connections.js) raw SQL; cf. encrypted `peer_messages.content` [0015:5] |
| 7 | Single vault-auth chokepoint on every `/portal` request | ✅ | [require-vault-auth.js:199](src/http/require-vault-auth.js:199) `req.requester = who` |
| 8 | `verify()` reusable for a new `$type`; deps threadable | ✅ | [handlers.js:72](src/federation/handlers.js:72), :45 destructure, [router.js:18](src/federation/router.js:18) |
| 9 | Signed-response emit pattern reusable | ✅ | [handlers.js:259](src/federation/handlers.js:259) + [router.js:65-74](src/federation/router.js:65) |
| 10 | Outbound sign+verify-reply pattern reusable | ✅ | [connections.js:915-945](src/db/connections.js:915) `fetchSharedContent` |
| 11 | `findAcceptedByPeer` → connId; row has `presence_share`/`remote_did` | ✅ | [connections.js:827](src/db/connections.js:827), `list()` `SELECT c.*` :555 |
| 12 | `mapConn` carries new column (spreads `...c`) | ✅ | [portal-compat.js:268](src/portal-compat.js:268) |
| 13 | `remote.json` writable/re-read for a `presence` block | ✅ | [config.js readRemoteConfig (uncached) + writeRemoteConfig](src/remote/config.js) |
| 14 | `db.publicPresence` is unrelated (doc visitors) → name `peerPresence` | ✅ | [public-presence.js](src/db/public-presence.js), [0001_init.sql:1029](migrations/0001_init.sql:1029) |
| 15 | 1/min single-row write is safe (WAL on; precedent exists) | ✅ | [d1.js:46](src/adapter/d1.js:46) WAL; background_jobs heartbeat 10s |
| 16 | Portal polls keep `last_active_at` fresh while app open | ✅ | ConnectionsView 10s/5s intervals; Sidebar badge 15s |
