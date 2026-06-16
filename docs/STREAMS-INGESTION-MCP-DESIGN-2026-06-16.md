# Data Streams — API Ingestion & MCP Placement (spec #10) — Design

**Date:** 2026-06-16
**Branch:** `claude/prelaunch-ux-v2` (worktree `mycelium-worktrees/prelaunch-ux`)
**Spec:** §10 "Data Streams — MCP & Middleware Ingestion" (P1)
**Protocol:** `/sweep-first-design` — 3 sweep cycles (6 Explore sweeps + author re-reads of every load-bearing claim).

---

## 0. The headline decision — is MCP the right thing here? No.

The spec asks to "add an MCP server connection as a **stream type**." **The sweep says that miscategorizes MCP, and the user's instinct ("shouldn't it just be an API?") is correct.** Evidence:

- **MCP's data-exposure side does not exist in the codebase and barely exists in the wild.** Mycelium's MCP server is **tools-only** — there is **no** `ListResources`/`ReadResource` handler anywhere ([sweep: MCP]; grep returns zero). The only sane "ingest from MCP" path is reading MCP *resources*, and most real-world MCP servers expose *tools* (actions to call), not *resources* (data to pull). Building "MCP as a stream" means building outbound resource-polling for a capability the ecosystem mostly doesn't offer.
- **MCP in this repo is an *agent-tool-access* direction, not an ingestion direction.** The existing MCP *client* lives in `packages/channel-daemon/agent/backends/*` and connects an agent to *vault tools at inference time* ([ollama.js:134-143], [openai-compat.js:21-30]). That is what MCP is *for* here: giving the agent tools to call, not bulk-loading data into the vault.
- **"Data streams" are an ingestion concept.** Every existing stream (Gmail, Linear) *pulls data in on a schedule and persists it*. The robust, scalable primitive for "connect an API" already exists — the **connector adapter framework** — and it has nothing to do with MCP.

**Therefore #10 splits into two cleanly-separated deliverables:**

| Need | Right home | This design |
|---|---|---|
| "Connect an API / middleware to ingest data" (poll an endpoint; receive a webhook) | The **connector framework** (Data Streams) | **Build** — generic `http-poll` + `webhook` connector kinds |
| "Let my agent use an external MCP server's tools" | **Settings → Integrations**, consumed at **chat/inference time** | **Reposition + design** — not a stream; full client build flagged as a scoped follow-up, with a Streams signpost so users aren't misled |

The spec's own task line already hints at this — it lists "middleware/pipeline connection (webhook URL, polling endpoint)" *separately* from "MCP server." We honor the real intent (API ingestion) and correct the mislabel (MCP).

---

## 1. Revision history

- **v1 (spec):** "MCP server as a stream type" + "middleware (webhook/polling)."
- **v2 (this doc):** **PIVOT** — MCP is not an ingestion source; it is an agent integration. Ingestion = generic HTTP poll-pull + webhook-push, built as connector kinds. MCP → Settings → Integrations (designed, build phased). Three structural sub-findings forced the connector-side shape (below).

---

## 2. Sweep findings (consolidated, load-bearing)

### The connector framework is the scalable ingestion backbone (reuse, don't rebuild)
- `connectors` table: plaintext op columns (status, cursor, last_sync_at/ok_at/error_at, idle_streak, items_*, budget_date, items_today) + **encrypted** `account_label`/`last_error`/`recent_runs`; tokens live in `secrets` — [migrations/0008_connectors.sql].
- Adapter contract — `{ id, label, provider, oauth|null, pull(ctx,{cursor})→{items,nextCursor}, resolveOAuthConfig?, ensureFreshToken?, revoke? }`; `ctx = {db,userId,tokens,store}` — [src/connectors/registry.js:1-32].
- Scheduler — `setInterval` 5 min, single-flight per id, idle-backoff to 16×, **daily item budget** (2000/day), per-pass cap 500, cursor watermark; all items → `captureMessage` — [src/connectors/scheduler.js:42-242].
- **Non-OAuth connect already works**: `if (!adapter.oauth)` stores a token + marks connected immediately — [src/connectors/scheduler.js:79-85].
- Router passes the request body through: `runner.connect(req.params.id, req.body || {})` — [src/portal-connectors.js:27-34].
- The one ingestion boundary — `captureMessage(db, {userId,content,role,messageType,source,conversationId,metadata,createdAt,id}, enqueueEnrichment)`: dedup on `id` PK + content-hash, `INSERT OR IGNORE`, enqueue `:8095` — [src/ingest/capture.js:88-179].
- UI already renders **consistent per-connector health** (status badge + last-sync + items + idle-backoff + daily budget + error/reconnect) from the `ConnectorStatus` shape — [ImportView.svelte:75-81,510-532]. "All stream types show health/status consistently" is already the pattern; new kinds just emit the same shape.

### Three structural facts the generic kinds must overcome
1. **Single-instance assumption.** `status()` iterates the *registry* (`listAdapters()`), and `runSync(id)`/`getAdapter(id)` key on the **adapter id** ⇒ today `id == adapter id == one instance` ([scheduler.js:47-72,130]). A user may add *many* APIs ⇒ need **instance ids** (`http-poll:<uuid>`) and adapter resolution by the row's `provider`.
2. **No per-instance config storage.** The store has `getTokens/setTokens/getState/patchState/listIds/remove` but **no** config method ([sweep: store]). A poller needs `{url, headers, itemsPath, fieldMap, schedule}` stored encrypted.
3. **OAuth-centric connect surfaces an `authUrl`.** Config-based kinds connect synchronously with a config body (the non-OAuth branch already exists — extend it to persist config).

### Security primitives that already exist (must be used)
- **SSRF guard** — `assertSafeBaseUrl(url)` + `assertSafeBaseUrlResolved(url,{lookup})` (blocks non-http(s), plaintext-http to non-loopback, private IPs, and **DNS-rebind** via resolution) — [src/inference/base-url.js:21,45]. A user polling URL **must** pass the *resolved* variant at save **and** at fetch.
- **Network gate** — host `127.0.0.1` default; non-loopback bind requires `MYCELIUM_ALLOW_NETWORK_REST=1` else `process.exit(2)` — [src/server-rest.js:551-571]. Inbound webhooks reachable externally only behind this gate + a reverse proxy; locally fully loopback-testable.
- **Loopback "always signed in" shim** — [src/server-rest.js:477-485]; vault-auth gates all `/api/*` — [server-rest.js:163].

---

## 3. Design

### 3.1 Generic HTTP polling connector — `http-poll` (Phase A, the backbone)

A new **multi-instance, non-OAuth** adapter. Reuses the entire scheduler/cursor/budget/health machinery.

**Connector model extension (instance ids):**
- Row `id = 'http-poll:' + uuid`, `provider = 'http-poll'`. Built-in OAuth connectors keep `id == adapter id` (backward compatible).
- `runSync` adapter resolution: `getAdapter(id) || getAdapter(state.provider)` — [scheduler.js:130] (1-line change; gmail row still resolves via `getAdapter('gmail')`).
- `status()` merges: registered single-instance adapters (as today) **+** one entry per instance row from `store.listIds()` whose provider is a generic kind, resolving label/provider from config — [scheduler.js:47-72].

**Config storage (new store methods):**
- `store.setConfig(id, cfg)` / `store.getConfig(id)` → `secrets` key `connector:<id>:config` (SYSTEM-key encrypted, exactly like tokens) — mirrors [store.js:17,76-77]. Config may carry an API key in `headers` ⇒ encryption is mandatory.
- `connect(id, body)` non-OAuth branch ([scheduler.js:79-85]) extends: if `provider === 'http-poll'`, validate `body` (URL via `assertSafeBaseUrlResolved`, mapping shape), `setConfig(id, body)`, mark connected.

**Config shape:**
```js
{ url, method='GET', headers={}, itemsPath='', // JSONPath-lite to the array (e.g. "data.items")
  map: { id, content, createdAt, title }, // dot-paths into each item → captureMessage fields
  cursor: { param, from='createdAt' }, // optional incremental: ?since=<lastMax>
  source } // label stamped on captured messages
```

**Adapter `pull(ctx,{cursor})`** ([new src/connectors/adapters/http-poll.js]):
1. `cfg = await ctx.store.getConfig(ctx.id)`.
2. `assertSafeBaseUrlResolved(cfg.url, { lookup })` **again at fetch time** (TOCTOU/rebind defense).
3. Build URL (+ incremental `cfg.cursor.param=<cursor>`), `fetch` with `cfg.headers`, **timeout + size cap** (reject > N MB), `cfg.method`.
4. Walk `cfg.itemsPath` to the array; for each item apply `cfg.map` (dot-path) → `{ id: <kind>:<mappedId|hash>, content, source: cfg.source, createdAt, metadata:{connector:id} }`.
5. `nextCursor` = max mapped `createdAt`. Returns `{items, nextCursor}` — the scheduler does the rest (budget, dedup, enrich).

**Robustness inherited for free:** single-flight, idle-backoff, daily budget, 500/pass cap, content-hash dedup, fail-closed token/key, error → status `error` + `lastError`. New code adds: SSRF guard, response size/time caps, mapping validation.

### 3.2 Generic inbound webhook connector — `webhook` (Phase B, security-gated)

For push-based middleware. A `webhook` connector does **not** poll (scheduler skips kinds without a `pull`).

- **Connect** generates a per-connector **signing secret** (`secrets: connector:<id>:hmac`) + returns the inbound URL `…/api/v1/webhooks/:connectorId` and the secret **once** (display-once, like an API key).
- **Receiver** — a **new public route** `POST /api/v1/webhooks/:id` mounted *outside* `/api/v1/portal` (external services POST to it):
  1. Look up connector; 404 if unknown/disconnected.
  2. **Verify `HMAC-SHA256(rawBody, secret)`** against an `X-Mycelium-Signature` header, **constant-time** compare — fail-closed 401. (No valid signature ⇒ never ingested; this is not an open port.)
  3. **Per-connector admission throttle** (fixed-window token bucket, mirrors [ratelimit.js]) — 429 when exceeded.
  4. Map body→`captureMessage` via the same `cfg.map`; idempotency via caller `id` or content-hash.
  5. Update `last_received_at` / counters so the **same health UI** applies (last-received replaces last-sync for this kind).
- **Reachability:** external only when `MYCELIUM_ALLOW_NETWORK_REST=1` + reverse proxy; **locally loopback-testable** (curl from 127.0.0.1). Ships safe-by-default.

### 3.3 MCP — repositioned as an Agent Integration (Phase C, designed; build phased)

Not a stream. **Place under Settings → Integrations**, consumed at chat time.
- **Plumbing reuse:** the channel-daemon already speaks MCP-client — `new Client` + `StreamableHTTPClientTransport(new URL(url), { bearer })` ([ollama.js:134-143]). The portal chat harness would gain an optional set of *external* MCP tool servers whose `listTools()` results are merged into the agent's tool surface (behind the existing default-deny tool filter).
- **Security (must, before any build):** server URL through `assertSafeBaseUrlResolved` (SSRF); per-server **explicit tool allow-list** (default-deny, mirroring [ollama.js:54-57]); bearer stored encrypted; egress through the existing audit/usage path; clear "this tool can act on your behalf" consent.
- **#10 deliverable for MCP:** the **placement decision + data model sketch + a Streams signpost** ("Looking for MCP tool servers? Connect them in Settings → Integrations"). The full external-MCP-client build is a **named follow-up** (`docs` open item) — it is a distinct, larger surface (transport lifecycle, tool security, OAuth-to-external) that should not be smuggled into a Streams card.

### 3.4 UI (Streams "Sources" facet — [ImportView.svelte])

- Two new "add" cards: **"Connect an API"** (`http-poll` config form: URL, method, headers, items path, field map, schedule) and **"Receive a webhook"** (`webhook`: creates the connector, shows the inbound URL + secret once).
- Instance connectors render with the **existing** `ConnectorStatus` card + health line (no new status UI — requirement "consistent health/status" satisfied by construction).
- One **signpost** card routing MCP seekers to Settings → Integrations.
- (Visual redesign of the page = spec #11, separate.)

---

## 4. Threat model

| Concern | Treatment |
|---|---|
| **SSRF** via user-supplied poll URL | `assertSafeBaseUrlResolved` at save **and** at every fetch (DNS-rebind covered); http→non-loopback rejected. |
| Webhook = open ingestion port | Fail-closed **HMAC-SHA256** constant-time verify; unknown/disconnected → 404; bad sig → 401. Reachable externally only behind the network gate. |
| Config secrets (API keys in headers, HMAC secret) | Stored in `secrets` (SYSTEM-key encrypted), same as OAuth tokens; never returned by `status()`; webhook secret shown once. |
| Ingestion flood / cost | Inherited daily budget + per-pass cap + idle-backoff (poll); per-connector admission throttle (webhook). |
| Response bomb (huge poll payload) | Size cap + timeout in the http-poll adapter before parse. |
| Duplicate ingestion | `captureMessage` content-hash + caller `id` idempotency (existing). |
| Plaintext leakage | All captured content flows through the encrypted-at-rest `captureMessage` path; config encrypted; no URL/secret in logs. |
| MCP external tool acting maliciously | Default-deny allow-list + SSRF on server URL + consent + audit — and **not shipped** until that surface is built deliberately. |
| New attack surface | Phase A: 1 adapter + 2 store methods + 3 small scheduler/connect edits + 1 config route — no new public port. Phase B: 1 new public route (gated, HMAC). |

---

## 5. Module shape + LOC budget (±20%)

| File | Change | LOC |
|---|---|---|
| `src/connectors/adapters/http-poll.js` | new adapter (pull + map + SSRF + caps) | ~150 |
| `src/connectors/store.js` | `getConfig`/`setConfig` | ~20 |
| `src/connectors/scheduler.js` | resolve-by-provider; status merges instance rows; connect persists config | ~55 |
| `src/connectors/registry.js` | register `http-poll` (+ `webhook` stub) | ~6 |
| `src/portal-connectors.js` | `POST /connectors` (create instance) + `PUT /connectors/:id/config` | ~40 |
| `src/webhooks.js` + mount | `POST /api/v1/webhooks/:id` (HMAC + throttle + capture) | ~120 |
| `src/connectors/adapters/webhook.js` | connect (gen secret) + no-pull marker | ~40 |
| `portal-app/.../ImportView.svelte` | 2 add-cards + config forms + MCP signpost | ~200 |
| `tests/*` + `verify:connector-ingestion` | mock-HTTP poll + HMAC webhook + SSRF-reject | ~180 |
| **Total (A+B)** | | **~811** |

Phase A alone (the backbone, no new public port) ≈ **~290 LOC + ~90 test**.

---

## 6. Edge cases — explicit decisions

- **Poll URL resolves to a private IP at fetch time (rebind):** `assertSafeBaseUrlResolved` throws → run recorded as `error`, no ingestion. ✓
- **Webhook with no/old signature:** 401, nothing captured. **No** unauthenticated ingestion path. ✓
- **Mapping points at a missing field:** item skipped (no content) — counted, not fatal; surfaced in `lastRun`.
- **Many instances:** each is its own row + single-flight; daily budget is per-connector, so N pollers can't be starved by one.
- **Webhook connector hit by the scheduler:** skipped — `cycle()` only runs adapters with a `pull`; `webhook` has none.
- **Secret rotation:** `PUT /connectors/:id/config` can regenerate the HMAC secret (shown once); old secret invalid immediately (fail-closed).
- **Config with an API key, then `status()`:** key lives in `secrets`, never in the connectors table or status payload.

---

## 7. Test strategy → `verify:connector-ingestion`

`tests/connector-ingestion.test.mjs` (Node, mock fetch + in-memory db):
1. **http-poll happy path** — mock HTTP returns 3 items; assert 3 `captureMessage` calls with mapped fields; cursor advances; second poll dedups.
2. **SSRF reject** — config URL `http://169.254.169.254/…` and a rebind-to-private case → `connect`/`pull` throw; nothing captured. *(security-critical)*
3. **config encryption** — read raw `secrets` row for `connector:<id>:config` → assert ciphertext (API key not plaintext).
4. **instance resolution** — two `http-poll` instances run independently; `status()` returns both with health.
5. **webhook HMAC** — valid signature → captured; tampered body/old secret → 401, not captured; over-rate → 429. *(security-critical)*
6. **response cap** — oversized poll payload rejected before parse.
7. svelte-check `--fail-on-warnings` on ImportView.

---

## 8. Implementation order (shippable increments)

1. **Store config + scheduler resolve-by-provider + connect persists config** → unit test instance resolution. (No UI yet.)
2. **`http-poll` adapter + SSRF + caps + `POST /connectors` + `PUT config`** → `curl` create + manual `/sync`; items land. `verify` steps 1-4,6 green.
3. **ImportView "Connect an API" form** → vite proxy; create a poller against a local mock; see items + health.
4. **Phase B: webhook adapter + `/api/v1/webhooks/:id` receiver (HMAC + throttle)** → loopback curl with signed body; `verify` step 5 green.
5. **ImportView "Receive a webhook" card + MCP signpost.**
6. **Gate `verify:connector-ingestion` GO + svelte-check clean; commit.**

MCP (Phase C) is designed here but built as a separate, approved follow-up.

---

## 9. Decision criteria to proceed

- `verify:connector-ingestion` EXIT 0 (incl. the two security cases) + svelte-check clean.
- Browser: an API poller created against a mock returns items with consistent health; a signed webhook ingests, an unsigned one is rejected.
- Raw-secret assertion proves config (API keys, HMAC secret) is ciphertext at rest.

---

## 10. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SSRF via poll/webhook URL | Med | High | `assertSafeBaseUrlResolved` at save+fetch; tests assert reject. |
| Instance-id change breaks existing OAuth connectors | Low | High | Resolution is `getAdapter(id) || getAdapter(provider)` — gmail/linear unchanged; test both. |
| Webhook mistaken for open port | Low | High | HMAC fail-closed + network gate off by default; documented. |
| Scope creep into full MCP client | Med | Med | MCP explicitly phased out of #10 build; only placement + signpost ship. |
| Mapping UX too fiddly for users | Med | Low | Sensible defaults (`itemsPath` blank = root array; map defaults to `content`/`id`); presets later. |

---

## 11. Open questions resolved during sweep

- *Is MCP the right thing?* **No** — tools-only server, no resources, MCP is agent-tool-access not ingestion. Generic API (poll + webhook) is the right primitive. (User's instinct confirmed by code.)
- *Rebuild ingestion?* No — extend the connector framework; it already has scheduler/cursor/budget/health/dedup.
- *Where does config live?* `secrets` (encrypted), new `getConfig/setConfig` — not the connectors table (auto-encrypt INSERT-paren caveat + secrets is the token convention).
- *Multi-instance?* Yes — instance ids + resolve-by-provider; backward-compatible with single-instance OAuth connectors.
- *Is there an SSRF guard to reuse?* Yes — `assertSafeBaseUrlResolved` ([base-url.js:45]).

## 12. Open questions deferred (named)

- **Full external-MCP-tool-server client** (Settings → Integrations, chat-time tool merge, allow-list, OAuth-to-external) — designed §3.3, built as a separate approved phase.
- Mapping-preset library for common APIs (RSS/JSON feeds, generic REST).
- Webhook replay-protection beyond idempotency (nonce/timestamp window) — add if abuse observed.
- Per-instance schedule override (today all share the 5-min base + idle-backoff).

---

## Verification table

| Assumption | Verified at (author-read) |
|---|---|
| Adapter contract `{id,pull,oauth?,…}`; `ctx={db,userId,tokens,store}` | [src/connectors/registry.js:1-32] |
| Scheduler: single-flight, idle-backoff, daily budget, cursor, →captureMessage | [src/connectors/scheduler.js:42-242] |
| Non-OAuth connect stores token + connects now | [src/connectors/scheduler.js:79-85] |
| `runSync`/`getAdapter` key on adapter id (single-instance today) | [src/connectors/scheduler.js:130] |
| `status()` iterates the registry, not table rows | [src/connectors/scheduler.js:47-72] |
| Router passes body to `runner.connect` | [src/portal-connectors.js:27-34] |
| Connectors table columns; tokens in `secrets`, PII encrypted | [migrations/0008_connectors.sql] |
| Store methods; **no** config storage exists | [src/connectors/store.js:69-159] (sweep) |
| `captureMessage` item fields + dedup + enqueue | [src/ingest/capture.js:88-179] |
| MCP server is tools-only; no Resource handlers | grep ListResources/ReadResource → none ([src/mcp.js:229-272]) |
| MCP client exists only agent→vault-tools (channel-daemon) | [packages/channel-daemon/agent/backends/ollama.js:134-143] |
| SSRF guard `assertSafeBaseUrl(Resolved)` | [src/inference/base-url.js:21,45] |
| Network gate: 127.0.0.1 default; non-loopback needs flag or exit(2) | [src/server-rest.js:551-571] |
| Loopback "always signed in" shim; `/api/*` vault-gated | [src/server-rest.js:477-485,163] |
| UI renders consistent ConnectorStatus health | [portal-app/src/lib/views/ImportView.svelte:75-81,510-532] |
