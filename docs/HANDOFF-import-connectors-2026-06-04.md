# Handoff — Import + Connectors (shipped) → next: benchmark data-connections against openhuman & odysseus

**Date:** 2026-06-04 · **Status:** SHIPPED to `main` (`f50dcf9`). Security-reviewed CLEAN.
**Design doc:** [`docs/DESIGN-import-connectors-2026-06-04.md`](DESIGN-import-connectors-2026-06-04.md) (sweep-first protocol + verification table — read it for the *why*).
**This doc:** the *what's-on-`main`-now* + the architecture in enough detail to compare our data-connection model against two reference implementations (see §10).

---

## 1. TL;DR

Two import directions shipped, in 3 phases (3 merged PRs):

| PR | Phase | Summary |
|---|---|---|
| #67 | 1 — Obsidian folder import | Point at a local vault FOLDER → each `*.md` → a **document** (in a folder tree mirroring the vault) **and** a **memory** (mindscape). |
| #74 | 2 — Connectors framework | In-process OAuth pull-connector framework: registry · encrypted token store · OAuth/PKCE · sync scheduler · secrets API. (`#74` superseded the auto-closed `#69`.) |
| #70 | 3 — Gmail + Linear + UX | Two real adapters on the framework + the ImportView "Live connections" UI. |

Everything flows through the **one proven path to the mindscape**: `captureMessage` → `nlp_processed=0` → enrich drainer → `embedding_768` → `clustering_points` → `cluster.py`.

**Live status:** `origin/main` has it all; the live `~/mycelium.id` checkout is still on the old `main` (`b90fa2a`) — `git pull` to run. Gmail/Linear show "not configured yet" until operator OAuth creds are set (§7).

---

## 2. The connector model (this is what we'll compare in §10)

### Adapter interface (plain object — `src/connectors/registry.js`)
```
{
  id: 'gmail',                 // stable id; used in routes + secret keys
  label: 'Gmail',
  provider: 'google',
  oauth: <truthy marker> | null,                       // null = non-OAuth (mock/local)
  resolveOAuthConfig?(ctx) -> { authUrl, tokenUrl, clientId, clientSecret?, scopes, redirectUri, usePKCE, extraAuthParams },
  ensureFreshToken?(tokens, ctx) -> tokens,            // refresh near-expiry
  revoke?(tokens) -> void,                             // best-effort on disconnect
  async pull(ctx, { cursor }) -> { items, nextCursor }, // items = captureMessage args
}
// ctx = { db, userId, tokens, store, fetchImpl? }   (fetchImpl injectable for tests)
```
Add a new source = write one object + `registerAdapter()`. Everything else (OAuth, storage, scheduling, dedup, status, disconnect) is shared.

### Data flow (end to end)
```
connect ── OAuth (PKCE + state) ──▶ /connectors/:id/callback ── code→tokens ──┐
        └─ non-OAuth (mock/local) ── token stored directly ───────────────────┤
                                                                               ▼
                              tokens + state JSON ── encrypted (SYSTEM_KEY) ── secrets table
                                                                               │
        scheduler tick (setInterval, in-process, 5 min) ──────────────────────┤
        OR manual POST /connectors/:id/sync                                    │
                                                                               ▼
            ensureFreshToken → adapter.pull({tokens}, {cursor}) → items[] + nextCursor
                                                                               │
            for each item: captureMessage(db, {…item}, enqueueEnrichment)      │  ← deterministic id
                                                                               ▼
            INSERT OR IGNORE on id  →  enrich/embed  →  clustering  →  mindscape
            advance cursor + lastSyncAt; status='connected'
```

### Key properties
- **Auth:** generic OAuth 2.0 + PKCE (`src/connectors/oauth.js`). `state` (CSRF) enforced on callback; PKCE verifier bound to the request. Creds are config-pointable (env → encrypted-secrets override) per provider (`src/connectors/providers.js`).
- **Token storage:** `connector:<id>:tokens` + `connector:<id>:state` JSON, **encrypted at rest** with SYSTEM_KEY via the `secrets` namespace. PKCE verifier / OAuth state live only inside the encrypted blob; never surfaced by `status()`.
- **Scheduling:** in-process `setInterval` (5 min, jittered), modelled on the enrichment drainer; started in `completeBoot` **gated `!injectedKeys`** (never runs in verify scripts); single-flight per connector; bounded items/tick (500).
- **Incremental sync:** per-connector **cursor** in state. Gmail = `internalDate` epoch (`after:` query); Linear = max `updatedAt` (GraphQL `updatedAt > cursor`).
- **Dedup:** **deterministic ids** — `gmail:<msgId>`, `linear:<issueId>:<updatedAt>`, `obsidian:<sha256(body)>`, `mock:<extId>` — + `INSERT OR IGNORE`. Re-sync never double-saves; edited items append as new memories (append-only model).
- **Normalize → one choke-point:** every adapter emits `captureMessage` args (`content, source, id, createdAt, metadata`). No parallel ingestion path. (Connectors map to **messages**, not documents — emails/issues are stream/event data.)
- **Status/disconnect:** leak-safe `status()` (id/label/status/timestamps/error only); disconnect = best-effort revoke + delete the two secrets.

### Obsidian import model (different — documents, not messages)
`src/ingest/obsidian-import.js`: each note → `saveDocument` (upsert on `(user_id, path)`, `source:'import-obsidian'`, placed in a **folder tree** mirroring the vault via `db.folders` find-or-create) **and** `captureMessage` (`source:'obsidian'`, content-addressed id → mindscape). Reuses the canonical document pattern: create · folders · source · content · `content_hash` dedup. Two input modes: native folder path (Node walks) or browser `webkitdirectory` (`files[]` + `vaultName`).

---

## 3. File map (all on `main`)
```
src/connectors/
  registry.js          adapter registry (registerAdapter/getAdapter/listAdapters)
  store.js             tokens+state in encrypted secrets (connector:<id>:tokens|:state)
  oauth.js             OAuth2 + PKCE (createPkce/buildAuthUrl/exchangeCode/refreshAccessToken/isExpired)
  scheduler.js         createConnectorRunner (connect/callback/sync/disconnect/status) + startConnectorScheduler
  providers.js         per-provider OAuth config (endpoints+scopes const; creds from env/secrets)
  index.js             registerBuiltinAdapters (gmail+linear always; mock dev-gated) + re-exports
  adapters/{gmail,linear,mock}.js
src/db/secrets.js      encrypted secrets namespace (set/get/has/list/delete; select-all+filter on decrypted key)
src/portal-settings.js PUT/GET/DELETE /portal/settings/secret(s)
src/portal-connectors.js GET /connectors · connect · callback · disconnect · sync
src/ingest/{markdown.js, obsidian-import.js}   front-matter parser + vault import (doc+memory+folders)
src/portal-import.js   POST /portal/import/obsidian  ({folderPath} | {files,vaultName})
scripts/verify-{obsidian,secrets,connectors,adapters}.mjs   (wired into npm run verify)
```
Wiring lives in `src/server-rest.js` (`buildVaultSubApp` mounts the routers; `completeBoot` builds the runner always + starts the scheduler when `!injectedKeys`) and `src/db/index.js` (`db.secrets`). `crypto-local.js` `ENCRYPTED_FIELDS.secrets` now includes `value`.

---

## 4. Crucial gotchas (encoded in tests/comments; don't re-learn the hard way)
- **`secrets.value` / `folders.name` are ENCRYPTED ⇒ non-deterministic ⇒ you cannot `WHERE encrypted_col = ?`.** Both the secrets namespace and the Obsidian folder builder do **select-all + filter on the decrypted value in JS** (mirrors the Worker `secrets-api.ts`). `db.folders.ensureSubFolder` is a latent bug for this reason (duplicates on re-import) — we did NOT use it.
- **Portal routers mount at `/api/v1/portal`** → route strings are RELATIVE (`/connectors`, `/settings/secret`, `/import/obsidian`). Writing `/portal/...` double-prefixes → 404.
- **The mindscape clusters MESSAGES only** (sync + drainer are messages-only). Documents don't reach it → connectors + Obsidian-memories use `captureMessage`.
- **Scheduler gated `!injectedKeys`** so verify scripts never sync a test vault.
- **Stacked-PR merge:** `gh pr merge --delete-branch` on a base that another open PR stacks on auto-CLOSES the dependent PR; wait for `mergeable==MERGEABLE` (not DIRTY). (Cost us #69 → recreated as #74.)

---

## 5. Verification
`npm run verify` (full chain, GO) includes: `verify:obsidian` (8 — doc+folder tree+memory, encrypted, idempotent, edit-aware, traversal-safe), `verify:secrets` (7 — encrypted-at-rest key+value, round-trip, metadata-only list), `verify:connectors` (9 — OAuth helpers, connect/sync/disconnect, encrypted tokens, cursor, dedupe, scheduler), `verify:adapters` (6 — gmail+linear normalize+pull with fixtures). Isolated `:8796` throwaway-vault preview pattern verified the UI + endpoints.

---

## 6. Security review (done, CLEAN)
4 parallel adversarial audits (crypto/secrets · OAuth/SSRF/callback · file-ingestion/traversal/DoS · injection/validation) — no Critical/High/Medium. Verified: token `value` encrypted on INSERT *and* UPDATE + fail-closed; PKCE+state CSRF; callback HTML static (no reflected XSS); endpoints hardcoded (no SSRF); traversal guarded; all SQL parameterized; deterministic ids namespaced (no cross-source collision). INFO-only: localhost error verbosity + `folderPath` arbitrary-read (accepted under the localhost single-user trust model).

---

## 7. To operate (host-verified residual)
Real OAuth round-trips + live pulls need operator creds (the only piece not exercisable in CI):
- `MYCELIUM_GMAIL_CLIENT_ID` / `MYCELIUM_GMAIL_CLIENT_SECRET` (Google "Desktop app" client; PKCE)
- `MYCELIUM_LINEAR_CLIENT_ID` / `MYCELIUM_LINEAR_CLIENT_SECRET` (confidential client)
- …or via encrypted secrets `connector:<id>:client_id` / `connector:<id>:client_secret`.
Redirect URI: `http://127.0.0.1:8787/api/v1/portal/connectors/<id>/callback`. Until set, providers register but show "disconnected / not configured yet".

---

## 8. Deferred (named, with rationale)
- **document → embedding → `clustering_points` unification** — would let imported documents reach the mindscape directly (today Obsidian notes ride the *message* path for that). Biggest pipeline change.
- **Native path-based folder picker** (`tauri-plugin-dialog`) for large-vault re-sync + **Obsidian-as-a-live-folder-connector** (persisted path re-walked on a schedule). Today: `webkitdirectory` reads bytes into the browser.
- **Dedicated `connectors` table** (plaintext-queryable status) vs the secrets-namespaced V1.
- **Webhook / push connectors** (the old `docs/CONNECTORS.md` bridge model) for real-time sources.
- **Hosted OAuth broker + Google app verification** for true one-click shipped creds (currently operator-supplied).
- **Lingering-memory GC** for edited/deleted notes (append-only today).
- **Multi-account per provider** (one connector id == one account today).

---

## 9. How to extend (add a connector)
1. Write `src/connectors/adapters/<x>.js` exporting an adapter object (§2) — `normalize()` pure, `pull()` using `ctx.fetchImpl || fetch`.
2. Add its OAuth config to `src/connectors/providers.js` (endpoints/scopes const; creds from env/secrets).
3. `registerAdapter(<x>Adapter)` in `src/connectors/index.js`.
4. Add fixtures to `scripts/verify-adapters.mjs`. That's it — UI/scheduler/storage/dedup are automatic.

---

## 10. NEXT: benchmark our data-connection design against two reference repos

Goal: read how these two implement "data connections" and decide what (if anything) to adopt — especially for the deferred items in §8 (webhooks, broker, multi-account, sync strategy, schema).

- **openhuman** — https://github.com/tinyhumansai/openhuman
- **odysseus** — https://github.com/pewdiepie-archdaemon/odysseus

For EACH repo, answer (then compare to "ours" in §2):

| Dimension | Question | Ours (baseline) |
|---|---|---|
| Adapter model | How is a source defined/registered? Plugin/interface/config? How much is shared vs per-source? | Plain object + `registerAdapter`; OAuth/storage/sched/dedup shared |
| Auth | OAuth flow (PKCE? confidential? device?), who holds client creds (shipped/broker/BYO), token refresh | Generic OAuth2+PKCE; creds env/secrets; `ensureFreshToken` |
| Token storage | Where + encrypted how? At-rest guarantees? | Encrypted `secrets` (SYSTEM_KEY), fail-closed |
| Sync strategy | Poll vs **webhook/push** vs streaming? Realtime? | In-process poll (5 min) + manual sync; **no webhooks yet** |
| Scheduling | In-process timer? Job queue? External worker/cron? Backoff, rate-limits, concurrency | in-process setInterval, single-flight, bounded; no rate-limiter |
| Incremental state | Cursor / delta / history-id / watermark? Backfill vs forward sync? | per-connector cursor (date / updatedAt); forward-only |
| Normalization | Common internal schema? How do they map provider → internal? | everything → `captureMessage` args (one choke-point) |
| Dedup / idempotency | Key strategy; edit/update handling | deterministic id + INSERT OR IGNORE; append-on-edit |
| Schema | Dedicated connectors/integrations table? Status surface? | none (secrets-namespaced); leak-safe `status()` |
| Multi-account | Multiple accounts per provider? | no (1 id = 1 account) |
| Error handling | Retry, dead-letter, partial-failure, observability | per-tick lastError + backoff; no DLQ |
| Extensibility | Effort + surface to add a new source | 1 object + register + fixtures |
| Security | Secret handling, SSRF, scopes, least-privilege | hardcoded endpoints, PKCE+state, scoped reads |

**Deliverable of the comparison:** a short findings note (what they do better / differently) → a prioritized list of adoptable improvements mapped onto §8 deferrals (likely candidates: webhook/push support, a dedicated connectors table, multi-account, a rate-limiter, the OAuth broker pattern). Then sweep-first-design any change before building (CLAUDE.md discipline).

> Reading entry points when we start: in each repo look for `connectors/ | integrations/ | adapters/ | sources/ | sync/ | oauth/`, the token/secret store, the scheduler/worker, and the "add a source" docs.
