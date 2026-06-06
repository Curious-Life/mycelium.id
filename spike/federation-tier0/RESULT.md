# Spike RESULT — Federation Tier-0 (did:web + WebFinger + signed connect)

**Date:** 2026-06-05
**Verdict:** ✅ **GO** — 10/10 checks pass.
**De-risks:** `docs/DESIGN-federation-inter-instance-2026-06-05.md` assumptions **A3** (did:web/WebFinger serve cleanly + a box→box connect completes & verifies) and **A4** (the connect payload carries no embedding/invertible material — `CLAUDE.md` §7).
**Run:** `node spike/federation-tier0/probe.mjs` (zero install — `node:crypto` + `node:http` + the two real `src/` modules).

## What it actually exercises (not a mock)

- **Real `src/identity/identity.js`** — the box's ed25519 identity does the signing/verifying.
- **Real `src/db/connections.js` `requestRemote`** — driven with an in-memory fake `d1Query` (so no `better-sqlite3` needed) and a **fetch-shim** that maps `https://<handle>.mycelium.id/...` → `127.0.0.1:<port>`. So the actual dormant WebFinger-discovery + federation-POST code path runs.
- **Two boxes** (`alice`, `bob`) as `node:http` servers serving `/.well-known/did.json`, `/.well-known/webfinger`, `POST /federation/connect`, plus a third no-handle box for the fail-closed check.

## Ledger

| # | Check | Result |
|---|---|---|
| A3.1 | `did.json` shape; ed25519 key round-trips through `publicKeyMultibase` (z-base58btc, 0xed01 multicodec — the did:web/did:key standard form) and equals `identity.publicKeyB64` | PASS |
| A3.2 | No-handle box **fails closed** on `did.json` (404) — mirrors `server-http.js` posture when `publicHost` is unset | PASS |
| A3.3 | WebFinger exposes a link whose `rel` **includes `federation`** with an `href` — exactly what `connections.js:115` looks for | PASS |
| A3.3b | WebFinger **fails closed** for a foreign acct (404) | PASS |
| A3.4 | **Real `connections.js`** resolves WebFinger → POSTs the `social.mycelium.connect-request.v1` payload → it reaches bob | PASS |
| A4 | The live payload carries **no** `centroid_256`/`embedding_768`/vector field; `profile.signature` is `null`/≤500-char bio (security gate) | PASS |
| A3.4b | Local **pending** connection row is written before the federation POST (reconciliation-safe) | PASS |
| A3.5 | A **signed** connect verifies against the sender's **published did:web key** | PASS |
| A3.5b | **Tampered** body → rejected, 401 (fail closed) | PASS |
| A3.5c | **Forged sender** (valid signature from wrong key, but claims alice's did) → rejected, 401 | PASS |

## Load-bearing findings (consequence for the build)

1. **A4 PASS, confirmed live + by code-read.** `src/db/profiles.js` never writes `signature` (grep: 0 matches; `computeFingerprint` only sets scores + realm names). `signature` is user-authored bio (`src/portal-compat.js:188`, ≤500 chars). The wire payload is `{signature(bio|null), stats{depth,breadth}, realms[names]}` — no embeddings. **Tier-0 may send the existing payload as-is.** (Recommend a post-launch one-sample audit per CLAUDE.md §1.)

2. **GAP — the dormant `connections.js` sends the connect-request UNSIGNED.** `requestRemote` (`connections.js:154-166`) POSTs with no signature; its comment defers signing to "the Worker level," which **does not exist in the single-user box.** Tier-0 must add the signing layer this spike prototyped: **sender signs the canonical request with the box identity; receiver resolves the sender's `did:web` and verifies** (valid→accept, tamper/forge→401). That layer works (A3.5).

3. **Caddy correction.** The relay's generated Caddyfile (`src/remote/runtime.js:97`) has a **single `reverse_proxy 127.0.0.1:4711`** — everything routes to `:4711`, there is **no** `/{p,s}`→`:8788` path-split in what's built. did.json / webfinger / `/federation/*` need **no Caddy change**; they just mount on the `:4711` Express app after `server-http.js:108`, inheriting the existing `/.well-known` CORS middleware (`server-http.js:71-77`).

4. **Handle availability is the one runtime gate.** `identity.handle` derives from `readRemoteConfig().publicHost` (`src/remote/config.js:65`) and is `null` until remote is configured. DID/WebFinger endpoints must 404 when there's no public presence (proven: A3.2).

## Not covered (out of scope for Tier-0; deferred)

- No real `better-sqlite3` vault (fake `d1Query`) — the connect INSERT shape is asserted, not persisted to disk. Wiring `connections` into `getDb`/tools is the build step, not the spike.
- No real TLS/relay (loopback shim stands in). The relay path is already proven by `DESIGN-relay-and-gateway-2026-06-04.md`.
- **Tier-1 (Matrix E2EE, assumption A1)** is untouched — that is the next, heavier spike and must precede any homeserver work.
