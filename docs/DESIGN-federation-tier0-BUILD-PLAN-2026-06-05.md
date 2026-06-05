# Build Plan — Federation Tier-0 (did:web + WebFinger + signed connect)

**Date:** 2026-06-05
**Status:** Build plan (sweep-verified; gate confirmed OPEN by operator). Converts `docs/DESIGN-federation-inter-instance-2026-06-05.md` Tier-0 (design, **spike GO 10/10**) into shippable steps. **Code follows this; this doc has no code.**
**Companion:** the design doc (architecture + threat model + verification table) and `spike/federation-tier0/` (the proven prototype this productionizes).
**Verify gate:** a new `verify:federation` (`scripts/verify-federation.mjs`) must print `VERDICT: GO` / exit 0 before "done"; then smoke the `:4711` surface in a real browser path per `deploy-and-verify` (remote MCP recipe).

---

## 1. Scope & non-goals

**In scope (Tier-0 only):**
- Serve the box's identity as `GET /.well-known/did.json` (`did:web:<handle>.mycelium.id`) and `GET /.well-known/webfinger`.
- Inbound `POST /federation/connect` — verify the sender's signature against their published `did:web` key, write a **pending** connection, surface it to the user.
- Outbound: a tool to request a connection to `@handle@domain` — **signed** (the gap the spike found: `connections.js` POSTs unsigned today).
- Wire the dormant `src/db/connections.js` into the live single-user `db`, adapted (no Worker deps), plus a small `receiveRemote()` inbound method.

**Non-goals (explicitly deferred):**
- Tier-1 (Matrix/Continuwuity real-time) and Tier-2 (shared pools). Separate plans.
- `profiles` namespace / handle-registry / cross-tenant resolve (dead in single-user; `user_profiles` is already populated by `src/portal-compat.js:159`).
- Discovery/resonance, overlap *transmission*, SMPC (Tier-3).
- Durable replay-nonce store (Tier-0 uses an in-memory LRU; durable table is a fast-follow).

---

## 2. Architecture

A new **`src/federation/`** module owns the *protocol* (did:web docs, WebFinger, canonicalization, sign/verify, did resolution, the inbound handler + abuse controls). The existing **`src/db/connections.js`** stays the *data* layer (the social graph), wired into `db` and given (a) a `sign` dep for outbound and (b) a new `receiveRemote()` for inbound. **`src/identity/identity.js`** is unchanged — it's the root the whole module consumes.

```
 outbound: tool requestConnection(@bob@bob.myc.id)
   → db.connections.request(userId, "bob@domain")           [src/db/connections.js, +sign]
   → WebFinger lookup → resolve federation endpoint
   → POST /federation/connect  (X-Myc-Did + X-Myc-Sig over canonical body)

 inbound:  POST /federation/connect                          [src/federation/router.js]
   → rate-limit (in-mem) → parse → resolve sender did:web key [src/federation/did.js]
   → verify signature over raw body                          [src/federation/sign.js]
   → replay/nonce + freshness check (in-mem LRU)
   → db.connections.receiveRemote({...})  → pending row      [src/db/connections.js, +method]
   → surfaced via db.connections.pending()  (existing read)
```

**Identity in the HTTP process:** created once in `createHttpApp` from `readRemoteConfig().publicHost` (`src/remote/config.js:65`), mirroring `src/publish/public-server.js:82`. Master key is already pinned at `process.env.ENCRYPTION_MASTER_KEY` (`src/index.js:73`). **Fail closed:** if `publicHost` is unset → DID/WebFinger 404, `/federation/connect` 503 (no public identity to verify *against*).

---

## 3. Module shape (exact, with LOC budget)

### New files

**`src/federation/sign.js`** (~40 LOC)
```js
export function canonicalize(obj)            // stable-key-order JSON.stringify of the signed envelope
export function signEnvelope(identity, body) // → { body: canonical, did, sig }   (identity.sign)
export function verifyEnvelope(pubKeyB64, rawBody, sigB64) // → bool (identity.verifyWithPublicKey)
```
The canonical form + the exact header names (`X-Myc-Did`, `X-Myc-Sig`) match the spike (`spike/federation-tier0/probe.mjs`).

**`src/federation/did.js`** (~70 LOC)
```js
export function buildDidDocument(handle, identity)   // did:web:<handle>.myc.id, Multikey (publicKeyMultibase, 0xed01)
export function buildWebfinger(handle, resource)     // self + did + rel-includes-'federation' link; null if foreign acct
export async function resolveDidKey(did, { fetch })  // did:web → fetch .well-known/did.json → pubKeyB64 (SSRF-guarded)
```
Reuses the spike's base58btc multibase helpers (move them here, ~25 of the 70 LOC).

**`src/federation/router.js`** (~120 LOC) — an Express `Router` factory:
```js
export function createFederationRouter({ db, identity, getHandle, fetch = globalThis.fetch }) // → express.Router()
//   GET  /.well-known/did.json        → buildDidDocument | 404 if no handle
//   GET  /.well-known/webfinger       → buildWebfinger    | 404
//   POST /federation/connect          → verify + receiveRemote | 202/401/429/503
// includes: in-memory per-IP rate limiter (reuse the account/router.js:128-145 Map pattern)
//           in-memory nonce LRU + ts freshness window (±5 min) for replay defense
//           body size cap (8 KiB), SSRF-guarded did resolution
```

**`src/tools/federation.js`** (~90 LOC) — MCP tool domain `createFederationDomain({ db, identity })` → `{tools, handlers}`:
- `requestConnection({ handle })` — `@handle@domain` → `db.connections.request(userId, handle)` (signed). Returns a status string.
- `listConnectionRequests({})` — `db.connections.pending(userId)` formatted.
- `respondToConnectionRequest({ id, action })` — `db.connections.accept|reject|block`.
Handlers are `async (args) => string`, closing over `db`/`identity` (matches `src/tools/messages.js`).

**`scripts/verify-federation.mjs`** (~80 LOC) — the gate: boots an in-process app on an ephemeral port, drives the spike's two-box flow against the *real* router (not a fake), asserts did.json/webfinger/connect + sign/verify + fail-closed, prints `VERDICT: GO`/exit code.

### Modified files

**`src/db/connections.js`** (~+30 LOC, −0):
- Add optional deps `sign` (`(canonical)=>sigB64`), `did` (`()=>string`), `selfInstance` (`()=>host`). Replace `workerUrl`/`workerAuth` *requirement* with these (the cross-tenant resolve path is dead in single-user — guard it: if no `workerAuth`, skip the `/api/resolve-handle` fetch and go straight to "User not found").
- In `requestRemote`: when `sign` present, set `from`/`nonce`/`ts`, canonicalize, and add `X-Myc-Did` + `X-Myc-Sig` headers to the federation POST (the spike's signed shape).
- **New method** `receiveRemote({ fromHandle, fromInstance, fromDid, profile, toUserId })` (~18 LOC) — insert a `pending` row with `remote_instance/remote_user_handle/remote_did` (columns already exist, `migrations/0001_init.sql:540-551`); reuse the `PENDING_LIMIT` guard inversely (cap inbound per-peer). Idempotent on `(remote_instance, remote_user_handle, toUserId)`.

**`src/db/index.js`** (~+4 LOC): wire `connections: createConnectionsNamespace({ d1Query, sign: deps.sign, did: deps.did, selfInstance })`. `getDb` gains optional `sign`/`did` params (defaulted undefined → namespace still loads, outbound just unsigned-disabled).

**`src/server-http.js`** (~+8 LOC): after `boot()`, create `identity = createIdentity({ masterHex: process.env.ENCRYPTION_MASTER_KEY, handle: readRemoteConfig().publicHost?.split('.')[0] ?? null })`; `app.use(createFederationRouter({ db: ingest.db, identity, getHandle }))` — mounted after `express.json()` (line 189). The `/.well-known` CORS middleware (line 71-77) already covers the GETs.

**`src/mcp.js`** (~+2 LOC): import + add `createFederationDomain({ db, identity })` to the domains list in `collectTools` assembly (`:52-116`).

**`package.json`** (~+1 line): `"verify:federation": "node scripts/verify-federation.mjs"`, and append it to the `verify` chain.

**Migration:** **none required** for Tier-0 (all columns exist). If durable replay defense is pulled forward, add `migrations/0011_federation_nonces.sql` (next free number; `0010_embedding_anchors.sql` is latest) — but Tier-0 ships with in-memory LRU.

**LOC budget total: ~+430 new, ~+44 modified (±20%).** No deletions.

---

## 4. Security / threat model (inherits design §4)

| Control | Where | Note |
|---|---|---|
| Sign outbound / verify inbound via `did:web` | `sign.js` + `did.js` | proven in spike A3.5; tamper/forge → 401 |
| Fail closed: no handle → 404/503; bad sig → 401; missing key → refuse | `router.js` | CLAUDE.md §3 |
| No embedding leaves the box | payload is `{signature(bio), stats, realms}` only | A4 PASS; add a guard that **rejects** any `profile` field matching `/centroid|embedding|vector/` before send |
| SSRF | reuse `connections.js:21-29` (HTTPS-only, `redirect:'manual'`, domain regex, timeouts) in `did.js` resolver too | |
| Replay / freshness | in-mem nonce LRU + `ts` within ±5 min | durable table = fast-follow |
| Abuse / DoS | per-IP in-mem rate limit (account/router.js:128-145 pattern), 8 KiB body cap, inbound per-peer pending cap | |
| Scope isolation | inbound writes only `connections` (no vault scope crossed) | no new crypto scope needed for Tier-0 |
| Audit | log connect accept/reject via existing `db.audit` (no PII: handle+instance only) | CLAUDE.md §8 |

New external attack surface: **one public POST**. Mitigated by signature-gate + rate-limit + size cap + fail-closed. No unauthenticated state mutation without a valid signature over a fresh nonce.

---

## 5. Edge cases — explicit decisions

| Case | Decision |
|---|---|
| `publicHost` unset (no remote configured) | did.json/webfinger → 404; `/federation/connect` → 503. Outbound tool → friendly "set up remote access first." |
| Remote WebFinger has no `federation` rel | outbound fails with "instance not reachable" (existing `connections.js:116`). |
| Duplicate inbound connect (same peer) | `receiveRemote` idempotent → 202, no duplicate row. |
| Inbound `ts` stale / nonce replayed | 401 + audit; do not write. |
| `profile.signature` contains a vector (future regression) | outbound guard rejects before send (defense-in-depth on A4). |
| Self-connect (`@me@myhost`) | reject "cannot connect to yourself". |
| Sender did:web unresolvable / key mismatch | 401, no write. |

---

## 6. Test strategy (by file, `node:test` + `makeDeps()` mock per repo convention)

- `tests/federation-sign.test.js` — canonicalize stability; sign→verify round-trip; tamper→false; wrong-key→false.
- `tests/federation-did.test.js` — did.json shape + multibase key round-trips to `identity.publicKeyB64`; webfinger has `rel`-includes-`federation`; foreign acct → null; resolver SSRF (rejects non-HTTPS / IP / redirect).
- `tests/federation-router.test.js` — supertest-style against the Router: 404 no-handle; 202 valid signed; 401 tamper/forge; 429 over rate limit; 401 stale ts/replayed nonce; 503 when identity has no handle.
- `tests/db-connections-receive.test.js` — `receiveRemote` writes a pending row (mock `d1Query`); idempotent; pending() surfaces it; per-peer cap.
- `tests/tools-federation.test.js` — the three handlers return strings; `requestConnection` routes `@h@d` to `request`, plain handle → "not found".
- `scripts/verify-federation.mjs` — end-to-end GO gate (the productionized spike).

---

## 7. Implementation order (each step independently shippable + smoke command)

1. **`src/federation/sign.js` + `did.js`** (pure, no wiring) → `node --test tests/federation-sign.test.js tests/federation-did.test.js`.
2. **`connections.js` `receiveRemote` + signed-outbound + single-user dep guard** → `node --test tests/db-connections-receive.test.js`.
3. **`src/federation/router.js`** (mount + abuse controls) → `node --test tests/federation-router.test.js`.
4. **Wire**: `db/index.js` (connections), `server-http.js` (identity + router), `mcp.js` (tool domain), `tools/federation.js` → boot `node src/index.js`, `curl -s localhost:4711/.well-known/did.json | jq`.
5. **`scripts/verify-federation.mjs` + `package.json`** → `npm run verify:federation` (expect `VERDICT: GO`), then `npm run verify` (full chain stays green).
6. **Browser smoke** (per `deploy-and-verify` remote recipe): confirm did.json/webfinger reachable through the relay path; one real box→box connect against a second local instance.

---

## 8. Verification table (assumptions → verified at)

| Assumption | Verified at |
|---|---|
| Tool domain = factory returning `{tools, handlers}`; handler `async(args)=>string` closing over `db` | `src/mcp.js:166-190`, `:52-116`; `src/tools/messages.js:49-100` |
| `createHttpApp` has `ingest.db`/`ingest.userId`; routes mount after `express.json()` | `src/server-http.js:46-55, 189`; boot return `src/index.js:87` |
| `.well-known` GETs inherit CORS, public, no auth gate | `src/server-http.js:71-77` |
| Identity reachable from master key + `publicHost`; fail-closed when null | `src/identity/identity.js:50`, `src/remote/config.js:65`, `src/index.js:73` |
| `connections.js` outbound is unsigned; `workerUrl/workerAuth` only feed `from_instance` + dead resolve | `src/db/connections.js:64-74, 133, 154-166, 182-204` |
| `connections`/`user_profiles`/remote_* columns exist; `user_profiles` populated outside profiles.js | `migrations/0001_init.sql:540-551, 1569-1584`; `src/portal-compat.js:159` |
| No rate-limit lib; in-mem Map pattern to reuse | `src/account/router.js:128-145` |
| Tests = `node:test` + `makeDeps()`; `verify:*` gate convention; next migration `0011_` | `reference/tests/mind-search/match-messages-routing.test.js:9-29`; `package.json` scripts; `migrations/0010_embedding_anchors.sql` |
| End-to-end did:web + signed connect works | `spike/federation-tier0/` (GO 10/10) |

---

## 9. Decision criteria & risks

**Done when:** `verify:federation` GO + full `verify` green + a real box→box connect lands a pending row + did.json/webfinger reachable in a browser via the relay. **Tier-0 is "validated"** when one real external peer completes a connect against a live vault.

| Risk | L | I | Mitigation |
|---|---|---|---|
| Public POST abuse | M | M | signature-gate + rate-limit + size cap + fail-closed (§4) |
| In-mem nonce lost on restart → replay window | L | L | ±5-min ts window bounds it; durable table fast-follow |
| `connections.js` single-user dep guard misses a multi-tenant path | L | M | step-2 test exercises both `request` branches; cross-tenant resolve guarded off |
| Handle null in dev (no remote) | M | L | fail-closed 404/503 + clear tool message (proven A3.2) |

**Open (deferred):** durable replay store; RFC 9421 full envelope (iat/exp/jti/body_hash); per-user DID vs instance DID (Tier-0 ships instance-level, matching the design); accept-side outbound callback to the peer (Tier-0 is request+local-pending; the bilateral accept handshake is Tier-0b).
