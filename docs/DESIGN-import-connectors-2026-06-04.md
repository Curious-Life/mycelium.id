# Import + Connectors — Design (Obsidian folder import · live OAuth connectors)

**Date:** 2026-06-04 · **Status:** DESIGN (sweep-first protocol applied; no code written yet).
**Companions:** [`docs/INGESTION-UPLOADS-DESIGN-2026-05-31.md`](INGESTION-UPLOADS-DESIGN-2026-05-31.md) (the built ingestion surface), [`docs/CONNECTORS.md`](CONNECTORS.md) (the prior messaging-bridge spec — superseded here for OAuth pull-connectors), [`docs/DESIGN-desktop-ux-image-ingest-2026-06-03.md`](DESIGN-desktop-ux-image-ingest-2026-06-03.md) (the `/upload/file` path).
**Operator intent (verbatim):** *"importing … quick + easy, in two directions: (1) Obsidian by opening the vault folder directly … (2) live connectors — ongoing OAuth integrations that continuously sync data INTO the vault: Gmail, Linear, extensible."*

**Operator decisions (2026-06-04, before design lock):**
1. Obsidian notes ingest as **BOTH a document (editable, clean re-sync) AND a memory (mindscape)**.
2. Connectors authenticate via **shipped one-click Mycelium OAuth creds** (framework config-pointable; the hosted broker + Google verification are host-verified infra, parallel to the remote-connect "managed" stack).
3. **Framework first, then Gmail + Linear together.**

---

## Goal

Two new import directions on the local-first, single-user, localhost-only vault, both flowing through the **one proven path to the mindscape** (`captureMessage` → enrichment drain → `embedding_768` → `clustering_points` → `cluster.py`):

1. **Obsidian folder import** — point the app at a local vault FOLDER (native picker → absolute path; browser `<input webkitdirectory>` fallback). Node walks `*.md`, parses front-matter, and ingests each note as a **document** (upsert on path) **and** a **memory** (`captureMessage`, source `obsidian`). Idempotent re-import.
2. **Live connectors** — an in-process connector framework: connect (OAuth) → encrypted token storage → periodic sync scheduler → per-provider adapter pull → normalize → `captureMessage` → dedupe → embed → mindscape, with live status + disconnect. First adapters: Gmail, Linear. Extensible via an adapter registry.

Both must be **fail-closed** (no key ⇒ no write), **idempotent** (re-sync never double-saves), **zero plaintext at rest** (CLAUDE.md §1 — including OAuth tokens), and must reuse the existing ingestion choke-point rather than inventing a parallel one.

---

## Load-bearing assumptions (Step 1) → all verified (table at end)

1. `captureMessage(db, msg, enqueueEnrichment)` is the single ingestion choke-point; idempotent on a caller-supplied `msg.id`; writes `nlp_processed=0`; reaches the mindscape via the drainer.
2. The mindscape clusters **messages only** today — documents have an `embedding_768` column and `cluster.py` supports `source_type='document'`, but **nothing embeds documents and nothing syncs documents into `clustering_points`**.
3. `saveDocument({db}, input)` upserts on `(user_id, path)`; `'import-obsidian'` is already a `VALID_SOURCES` member with a `PATH_STRATEGIES` entry → clean re-sync of edited notes.
4. The upload routers mount at `/api/v1/portal` inside `buildVaultSubApp`; no per-request auth (localhost-only, vault-init guarded).
5. The Tauri shell has **no fs/dialog/shell plugins**, sets `disable_drag_drop_handler()`, and exposes `window.__TAURI__` (`withGlobalTauri:true`). The Node server is a local process with full fs access.
6. The encrypted `secrets` table exists with `key_family` + SYSTEM_KEY routing, but `ENCRYPTED_FIELDS.secrets = ['key','description']` — **`value` is NOT encrypted at rest**, and the local `src/` server has **no `/portal/settings/secret` endpoint** (only `reference/` does).
7. A background (non-HTTP) task gets `db` + keys the way the enrichment drainer does: injected `db` at `completeBoot`, master key via `process.env.ENCRYPTION_MASTER_KEY` / `getMasterKey()`, system key pinned via `setSessionKeys`.
8. The enrichment drainer is the supervision template: in-process `setInterval` started in `completeBoot`, gated `!injectedKeys` (real app only, never in verify scripts).
9. Portal views register via `registry.ts` (`{title,icon,singleton,load}`) + a route `+page.svelte` calling `workspace.openFromRoute(id)`; the API client is `api()/apiPost/apiPut` in `api.ts` (rewrites `/portal/*` → `/api/v1/portal/*`).
10. Real OAuth round-trips + native folder picker **cannot** be exercised in the throwaway `:8796` preview or CI — they are host-verified (like the remote-connect managed stack). The Node-side walk/ingest, the `webkitdirectory` fallback, secrets encryption, the scheduler with a mock adapter, and adapter normalization with fixtures **are** CI-verifiable.

---

## Sweep findings (consolidated, Step 2–3 — cited)

**Ingestion choke-point.** [`src/ingest/capture.js:61-107`](../src/ingest/capture.js) — `captureMessage(db, {userId, content, source, id?, metadata?, conversationId?, createdAt?, role?}, enqueueEnrichment)`. `const id = msg.id || crypto.randomUUID()` (`:71`); dedup via `getExistingIds` + `insertIgnore` (`:95-98`); `nlp_processed:0` (`:80`); `metadata` JSON-encoded + encrypted at rest; `created_at` preserved (`:91`). Returns `{id, deduped}`. **This is the only path that reaches the mindscape.** The Claude/ChatGPT ZIP import already funnels through it ([`src/ingest/import-parsers.js:98+`](../src/ingest/import-parsers.js)).

**Mindscape pipeline is messages-only (the decisive constraint).** [`pipeline/sync-clustering-points.js:87-92`](../pipeline/sync-clustering-points.js) selects `FROM messages m WHERE m.embedding_768 IS NOT NULL … source_type='message'` — there is **no documents branch**. The drainer embeds messages only ([`src/enrich/drainer.js:24`](../src/enrich/drainer.js) → `createEnrichmentService({ messages: db.messages, … })`). `pipeline/cluster.py:181,510,521` *can* read `documents` by `source_type='document'`, but nothing populates `documents.embedding_768` or inserts document rows into `clustering_points`. **⇒ documents are a mindscape dead-end today.**

**Documents layer is Obsidian-ready and edit-clean.** [`src/core/document-store.js:264-407`](../src/core/document-store.js) — `saveDocument({db}, input)` looks up `(userId, path)` and `db.documents.upsert(doc)` (ON CONFLICT `(user_id, path)` DO UPDATE, [`src/db/documents.js:5,93`](../src/db/documents.js)). `'import-obsidian'` ∈ `VALID_SOURCES` (`:74`); `PATH_STRATEGIES['import-obsidian'] = ({name}) => 'import/obsidian/'+name` (`:113`). Provenance (`scope`,`created_by`,`source_type`) is INSERT-only (`:359-368`) — re-import preserves it. `delete(userId, path)` + `get(userId, path)` exist (`:85,206`).

**Upload surface.** [`src/portal-uploads.js`](../src/portal-uploads.js) mounts at `/api/v1/portal` ([`src/server-rest.js:91`](../src/server-rest.js)). Routes `/upload` (ZIP, 512MB, JSZip → `detectExportType`), `/upload/chunk`+`/complete`, `/upload/file` (25MB → `uploadAttachment` → `captureMessage`). No per-request auth; localhost-only + vault-init 503 guard. **Obsidian/LinkedIn ZIPs are *detected* but deferred** ([`import-parsers.js:77-81`](../src/ingest/import-parsers.js) — `.md` presence ⇒ `type:'obsidian'`).

**Secrets + OAuth.** `secrets` table at [`migrations/0001_init.sql:1117`](../migrations/0001_init.sql) (`key,value,scope,user_id,agent,version,description,key_family`). [`src/crypto/crypto-local.js:352`](../src/crypto/crypto-local.js) `ENCRYPTED_FIELDS.secrets = ['key','description']`; `SYSTEM_KEY_TABLES = new Set(['secrets'])` (`:1320`); `autoEncryptParams` encrypts only columns in `ENCRYPTED_FIELDS` (`:546,1248,1378`). **`value` is therefore plaintext at rest.** No `setSecret/getSecret`, no `/portal/settings/secret` handler in `src/` — the full implementation lives in `reference/server-routes/portal-settings.js` + `portal-integrations.js` (`putEncryptedSecret`) and is **not ported to the local server**. The frontend (`ConnectionsChecklist.svelte:103`, `OnboardingGuide`, `_AgentRow`) already calls it → those "Connect" buttons are no-ops locally today. **No outbound OAuth client exists** (the inbound MCP-server OAuth in `server-http.js` is the app-as-provider; unrelated).

**Tauri shell.** `src-tauri/Cargo.toml` = `tauri` + `window-vibrancy` only (no plugins). `tauri.conf.json` has no `plugins` block, `withGlobalTauri:true`. `src-tauri/capabilities/default.json` grants only `core:default` + `core:window:allow-start-dragging` for the remote `127.0.0.1:8787` origin. `main.rs:157` `.disable_drag_drop_handler()` → the webview gets browser `File` objects, not paths ([`ImportDropZone.svelte:64-88`](../portal-app/src/lib/components/shell/ImportDropZone.svelte)). `@tauri-apps/api` is **not** a portal-app dependency. **⇒ folder picking needs new native wiring OR a browser-only fallback.**

**Background context + scheduler template.** [`src/server-rest.js:149-193`](../src/server-rest.js) `completeBoot()` injects `db`+`userId`, pins keys via `setSessionKeys` (`:166`), and — gated `!injectedKeys` (`:176`) — starts `startEmbedSupervisor` + `startEnrichDrainer` (`:180-181`) with teardown wired into `closeHandle`. The drainer is `setInterval(cycle, 15000)` ([`drainer.js`](../src/enrich/drainer.js)); the embed supervisor is tick+restart+backoff ([`supervisor.js`](../src/embed/supervisor.js)). Non-HTTP key access: `process.env.ENCRYPTION_MASTER_KEY` (hex, pinned [`src/index.js:73`](../src/index.js)) or `getMasterKey()`.

---

## Revision history

- **v1 (sketch, pre-sweep):** "import Obsidian notes as documents; build connectors per `docs/CONNECTORS.md` (standalone bridge processes); store OAuth tokens in the `secrets` table."
- **v2 (this doc) — three pivots forced by the sweep:**
  - **PIVOT A — documents alone don't reach the mindscape.** `sync-clustering-points.js:87` + the drainer are messages-only. Operator wants imports in the mindscape. → Obsidian notes ingest as **both** a document (clean re-sync via upsert-on-path) **and** a memory (`captureMessage`, the only mindscape path). Connectors normalize to **messages**.
  - **PIVOT B — connectors are in-process, not external bridges.** `docs/CONNECTORS.md` modeled Telegram/Discord push-bridges as standalone processes. App-managed OAuth *pull* connectors (Gmail/Linear) with token refresh + status/disconnect fit an **in-process scheduler** (the drainer pattern) + encrypted secrets. The bridge model is retained only for future push platforms (out of scope).
  - **PIVOT C — `secrets.value` is not encrypted, and the local server has no secrets endpoint.** → add `'value'` to `ENCRYPTED_FIELDS.secrets` (SYSTEM_KEY routing already exists) + a `secrets` db namespace + a ported `/portal/settings/secret(s)` router on the local server. This also un-breaks the existing frontend Connect buttons.
  - **PIVOT D (simplification) — folder import needs a *path*, not bytes.** The Node server reads files directly; the native layer only supplies an absolute folder path via `tauri-plugin-dialog`. No `tauri-plugin-fs` needed. Browser `<input webkitdirectory>` is the non-Tauri/preview fallback (reads `File` objects in JS, POSTs note bodies).

---

## Design

### Phase 1 — Obsidian vault folder import

**`src/ingest/markdown.js`** (~50 LOC) — `parseMarkdownNote(raw, relPath) → { title, body, frontmatter, tags }`. YAML front-matter (`---` fenced) parsed minimally (no new dep — small hand-roll or reuse an existing yaml dep if present); title = front-matter `title` ?? first `# H1` ?? filename stem; tags = front-matter `tags` ∪ inline `#tags` (best-effort).

**`src/ingest/obsidian-import.js`** (~140 LOC) —
```
importObsidianVault(db, { userId, folderPath, files?, enqueueEnrichment }) -> { scanned, documentsUpserted, memoriesCreated, memoriesDeduped, skipped, errors }
```
- Two input modes: `folderPath` (Node walks the dir, native path mode) **or** `files: [{relPath, content, mtime}]` (browser `webkitdirectory` mode — bytes already in the request). Exactly one is required.
- Walk: recursive readdir, filter `*.md`, skip `.obsidian/`, `.trash/`, hidden dirs, symlinks-out-of-root, and files > a cap (e.g. 2MB). Bound total count (log if capped — no silent truncation).
- Per note, for each `{relPath, content, mtime}`:
  - **Document:** `saveDocument({db}, { userId, source:'import-obsidian', sourceType:'import_obsidian', createdBy:'import', scope:'personal', pathArgs:{name: relPath}, content: body, title, metadata:{ tags, vault, frontmatter, relPath }, createdAt: mtime, updatedAt: mtime })` → upsert on path (clean edit re-sync).
  - **Memory:** `captureMessage(db, { userId, content: title ? `# ${title}\n\n${body}` : body, source:'obsidian', id: `obsidian:${sha256(content)}`, messageType:'note', metadata:{ relPath, title, tags }, createdAt: mtime }, enqueueEnrichment)`.
  - **Dedup semantics (explicit):** the memory id is **content-addressed** (`sha256` of the note body). Unchanged note re-import ⇒ same id ⇒ `insertIgnore` no-op (idempotent). Edited note ⇒ new id ⇒ a new memory whose updated content reaches the mindscape; the prior memory **lingers** (append-only memory model). The *document* row stays canonical/current via upsert. Lingering-memory GC is a named follow-on (§Open questions deferred).
- Fail-closed: a missing key makes `captureMessage`/`saveDocument` throw (the auto-encrypt REFUSE path) — surfaced, never written plaintext. Per-note errors are collected and counted, not fatal to the batch.

**Route — `src/portal-import.js`** (~60 LOC), mounted at `/api/v1/portal` in `buildVaultSubApp`:
- `POST /portal/import/obsidian` — JSON `{ folderPath }` (Tauri) **or** JSON `{ files:[{relPath,content,mtime}] }` (browser). Calls `importObsidianVault`. Returns the summary object. Size/count caps enforced; `folderPath` validated to be an existing directory (no traversal beyond it).

**Native (Tauri) — minimal:**
- `src-tauri/Cargo.toml`: add `tauri-plugin-dialog = "2"`.
- `src-tauri/src/main.rs`: `.plugin(tauri_plugin_dialog::init())`.
- `src-tauri/capabilities/default.json`: add `"dialog:allow-open"` (folder picker only; no fs/shell).
- `portal-app/package.json`: add `@tauri-apps/plugin-dialog` (+ `@tauri-apps/api` if needed).

**UX — `ImportView.svelte`:** the existing Obsidian source card gains an **"Open vault folder"** action:
- In Tauri (`window.__TAURI__`): `open({ directory:true })` → absolute path → `apiPost('/portal/import/obsidian', { folderPath })`.
- In browser/preview: `<input type="file" webkitdirectory multiple>` → read `.md` files via `file.text()` (filter by `webkitRelativePath`) → `apiPost('/portal/import/obsidian', { files })`.
- Progress + a result summary ("N notes imported, M memories, K updated"). Reuses the existing upload progress styling.

**LOC budget Phase 1: ~510** (±20%).

### Phase 2 — connectors framework + sync scheduler + secrets API

**Secrets at rest (Pivot C):**
- `src/crypto/crypto-local.js`: `ENCRYPTED_FIELDS.secrets = ['key','value','description']` (add `'value'`, with a comment; the SYSTEM_KEY routing already encrypts these columns). Backward-safe: `autoDecryptResults` only decrypts envelope-shaped values (`isEncrypted` guard) and there are no existing local rows. Note for Worker parity: mirror in `worker-handlers/secrets-api.ts`'s ENCRYPTED_FIELDS if/when the Worker handles secrets (local-first V1 does not).
- `src/db/secrets.js` (~90 LOC) + wire into `getDb()`: `setSecret(userId,{key,value,scope,description})`, `getSecret(userId,key)`, `listSecrets(userId)` (keys/metadata only, never values), `deleteSecret(userId,key)`. Writes route through the SYSTEM_KEY auto-encrypt path.
- `src/portal-settings.js` (~120 LOC) ported from `reference/server-routes/portal-settings.js`: `PUT /portal/settings/secret`, `GET /portal/settings/secrets` (metadata only), `DELETE /portal/settings/secret`. Un-breaks the existing frontend Connect buttons as a bonus.

**Connector framework:**
- **State storage (no migration in V1):** connector tokens + state live in encrypted `secrets`, namespaced `connector:<provider>:tokens` (JSON: access/refresh/expiry) and `connector:<provider>:state` (JSON: status, cursor, lastSyncAt, lastError, scopes). Everything encrypted via the value-encryption fix. A dedicated `connectors` table is a documented later optimization (plaintext-queryable status).
- `src/connectors/registry.js` (~80 LOC) — adapter registry. An adapter is a pure object:
  ```
  { id, label, provider, oauth: {authUrl, tokenUrl, scopes, usePKCE, redirectPath},
    pull(ctx, {cursor}) -> { items:[NormalizedItem], nextCursor },   // NormalizedItem → captureMessage args
    normalize(raw) -> { content, source, id, createdAt, metadata } }  // deterministic id for dedupe
  ```
- `src/connectors/oauth.js` (~150 LOC) — authorization-code + PKCE; `buildAuthUrl`, `exchangeCode`, `refreshToken`. Config-pointable per provider (`src/connectors/providers.js`): shipped Mycelium `clientId` (+ `clientSecret` where the provider requires a confidential client) with per-key override from `secrets`. Loopback redirect to `http://127.0.0.1:8787/api/v1/portal/connectors/:id/callback`.
- `src/connectors/scheduler.js` (~140 LOC) — drainer-pattern `setInterval` (default 5 min, jittered), started in `completeBoot` gated `!injectedKeys`, teardown in `closeHandle`. Each tick, for each connected provider: load state+tokens (decrypt) → refresh token if near expiry → `adapter.pull({cursor})` → for each item `captureMessage(db, normalize(item), enqueueEnrichment)` (deterministic id ⇒ dedupe) → advance `cursor` + `lastSyncAt` → persist state. Single-flight per provider; bounded items per tick; error → `state.lastError`, exponential backoff, never throws out of the tick.
- `src/portal-connectors.js` (~150 LOC) — routes: `GET /portal/connectors` (list + live status), `POST /portal/connectors/:id/connect` (→ auth URL / opens flow), `GET /portal/connectors/:id/callback` (code → tokens → store → status connected), `POST /portal/connectors/:id/disconnect` (revoke best-effort + delete secrets), `POST /portal/connectors/:id/sync` (manual tick).
- **Mock adapter** (`src/connectors/adapters/mock.js`) + `scripts/verify-connectors.mjs` — full framework path with **no network**: store-token (assert ciphertext at rest) → scheduler tick → `captureMessage` → re-tick → dedupe → status. CI-verifiable.

**LOC budget Phase 2: ~1300** (±20%).

### Phase 3 — Gmail + Linear adapters + ImportView connectors UX

- `src/connectors/adapters/gmail.js` (~180 LOC) — Google OAuth (Desktop/PKCE, loopback redirect; installed-app `client_secret` is non-confidential per Google). `pull`: `users.messages.list` with an incremental `q`/`historyId` cursor → `messages.get` → normalize (from/subject/snippet/body) → `captureMessage(source:'gmail', id:`gmail:${msgId}`)`.
- `src/connectors/adapters/linear.js` (~150 LOC) — Linear OAuth2 (confidential client → shipped secret embedded for one-click, with user-override + a broker noted as the hardened option). `pull`: GraphQL `issues(filter:{updatedAt:{gt:cursor}})` + comments → normalize → `captureMessage(source:'linear', id:`linear:${issueId}:${updatedAt}`)`.
- `src/connectors/providers.js` (~40 LOC) — shipped creds + scopes per provider; override from secrets.
- **UX:** ImportView (or a new `ConnectorsView` registered in `registry.ts`) gains a **sources grid**: "Open Obsidian vault" + "Connect Gmail" + "Connect Linear" cards, each showing live status (disconnected / connecting / connected · last sync · syncing / error) + a Disconnect button + manual Sync. Reuses `ConnectionsChecklist` styling and `api()/apiPost`.
- **Verify:** adapter `normalize` unit-tested against fixture payloads (no network). Real OAuth connect + live pull are **host-verified** by the operator (runbook), parallel to remote-connect.

**LOC budget Phase 3: ~770** (±20%).

---

## Threat model

- **OAuth tokens at rest.** Highest-value new secret. Stored only in `secrets.value`, encrypted with SYSTEM_KEY after the `ENCRYPTED_FIELDS` fix (verified by a ciphertext-at-rest assertion). Fail-closed: no key ⇒ write REFUSED. Tokens never logged; redacted from status responses.
- **New network surface.** The connector OAuth callback + adapter HTTP egress. Callback is on the localhost-only REST server (no new public surface). Adapter egress is outbound HTTPS to Google/Linear only. The localhost REST surface stays localhost-bound (`server-rest.js:100-101`); connectors do NOT require exposing it.
- **Folder read scope.** Node reads a user-chosen folder (single-user machine, explicit native picker). Validate the path is a directory; refuse traversal outside it; skip symlinks leaving the root; size/count caps prevent disk/CPU exhaustion. No arbitrary path is read without the user picking it (or, in browser mode, the bytes are user-supplied).
- **Plaintext-at-rest invariant.** Note bodies → `documents.content` (encrypted) + `messages.content` (encrypted). `documents.source_path`/`metadata` encrypted; `content_hash`, `file_size` stay plaintext (existing accepted metadata leak). Connector items → `messages.content`+`metadata` (encrypted).
- **Idempotency / abuse.** Content-addressed (Obsidian) + provider-id (connectors) message ids + `insertIgnore` prevent re-sync duplication. Scheduler single-flight + bounded items per tick prevent runaway syncs.
- **Audit.** `captureMessage` already writes an `audit` row (`capture.js:100`); connector connect/disconnect/sync write audit rows too.
- **Shipped OAuth creds.** Embedding a Linear confidential `client_secret` in a desktop binary is not truly secret (documented limitation; mitigated by PKCE where supported, user-override, and a broker as the hardened path — parallel to remote-connect managed).

---

## Edge cases — explicit decisions

- **Edited Obsidian note re-imported:** document upserts (clean); a NEW content-addressed memory is created (new content reaches the mindscape); the prior memory lingers (append-only). GC deferred.
- **Deleted Obsidian note on re-walk:** V1 does **not** delete the document/memory (add-and-update only). Deletion-sync is deferred (needs a diff against a stored manifest).
- **Non-markdown vault files (images, PDFs, canvas):** Phase 1 ingests `*.md` only. Attachments are a follow-on (could route through `/upload/file`).
- **Huge vault:** size cap per file + total count cap; capped counts are `log()`'d (no silent truncation).
- **Token expired / refresh fails:** state → `error`, surfaced in status; backoff; user can reconnect. No partial-credential writes.
- **Provider returns nothing new:** cursor unchanged, `lastSyncAt` bumped, status stays `connected`.
- **Scheduler vs verify scripts:** gated `!injectedKeys` so it never runs in `npm run verify`; the verify script calls the tick directly with the mock adapter.
- **Two notes with identical content:** dedupe to one memory (content-addressed) — accepted (identical content is the same memory); both documents still exist (distinct paths).
- **`/portal/settings/secret` already used by frontend:** porting it un-breaks existing Connect buttons; behavior matches the reference (per-key, metadata-only GET).

---

## Test strategy (by file)

- `scripts/verify-obsidian.mjs` — (O1) `files`-mode import creates a document (encrypted `content` at rest) + a memory at `nlp_processed=0`; (O2) re-import unchanged ⇒ 0 new memories, document `updated`; (O3) edited note ⇒ document updated + 1 new memory; (O4) `folderPath`-mode walks a temp dir of `.md`; (O5) fail-closed with a wrong key; (O6) traversal/size caps enforced.
- `scripts/verify-secrets.mjs` — (S1) `setSecret` then raw-`SELECT value` is ciphertext (NOT the plaintext token); (S2) `getSecret` round-trips; (S3) `listSecrets` never returns values; (S4) wrong key ⇒ REFUSE.
- `scripts/verify-connectors.mjs` — (C1) connect (mock) stores encrypted tokens; (C2) scheduler tick pulls + `captureMessage`; (C3) re-tick dedupes (cursor advance); (C4) disconnect deletes secrets + revokes; (C5) status shape; (C6) token-refresh path.
- `scripts/verify-adapters.mjs` (Phase 3) — Gmail + Linear `normalize` against fixtures → correct `captureMessage` args + deterministic ids.
- All wired into `npm run verify`. **Capture the real exit code** (`npm run verify > log 2>&1; echo $?`) — a `| tail` masks failures (the Phase-B lesson).

---

## Implementation order (each independently shippable + smoke-tested → its own PR)

**Phase 1 (PR #1) — Obsidian folder import.** Build `markdown.js` + `obsidian-import.js` + `portal-import.js` route; ImportView "Open vault folder" with the `webkitdirectory` fallback; Tauri `dialog` plugin wiring. Smoke: `node scripts/verify-obsidian.mjs`; `:8796` preview imports a temp vault via the browser fallback; native picker host-verified.

**Phase 2 (PR #2) — framework + scheduler + secrets API.** `ENCRYPTED_FIELDS` fix + `secrets.js` + `portal-settings.js`; `registry.js`+`oauth.js`+`scheduler.js`+`providers.js`+`portal-connectors.js` + mock adapter. Smoke: `node scripts/verify-secrets.mjs && node scripts/verify-connectors.mjs`; `:8796` preview shows connectors list + mock connect/sync/disconnect.

**Phase 3 (PR #3) — Gmail + Linear + UX.** Two adapters + providers config + the connectors UX. Smoke: `node scripts/verify-adapters.mjs`; `:8796` preview UX; real OAuth host-verified (runbook).

---

## Decision criteria to proceed past this design — RESOLVED (operator, 2026-06-04)

- **Obsidian model:** ✅ BOTH document + memory.
- **OAuth creds:** ✅ shipped Mycelium one-click (framework config-pointable; broker/verification host-verified).
- **First adapter:** ✅ framework first, then Gmail + Linear.

---

## Risks + mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Lingering memories on note edits grow unbounded | Med | Low | Content-addressed dedupe; document is canonical; GC follow-on documented |
| 2 | `secrets.value` change drifts from Worker ENCRYPTED_FIELDS | Low | Med | Local-first V1 doesn't run the Worker; comment + note to mirror if Worker adopts secrets |
| 3 | Shipped Linear `client_secret` not truly secret in a desktop binary | Certain (accepted) | Med | PKCE where supported; user-override; broker as hardened path (parallel to remote-connect) |
| 4 | Native picker unverifiable in preview/CI | Certain | Low | `webkitdirectory` fallback + direct Node-endpoint tests are CI-verifiable; native host-verified |
| 5 | Real OAuth/live pull unverifiable in CI | Certain | Low | Mock adapter + fixture normalization in CI; live host-verified via runbook |
| 6 | Scheduler runs in a verify script and mutates a test vault | Low | Med | Gated `!injectedKeys` exactly like the drainer; verify calls tick directly |
| 7 | Adding `tauri-plugin-dialog` perturbs the packaged build | Low | Med | Minimal (dialog only, no fs/shell); rebuild `.app` host-verified before merge |

## Open questions resolved during sweep

- *Does the mindscape cluster documents?* No — messages-only sync + messages-only drainer (the reason for the "both" model).
- *Is there a secrets endpoint to reuse?* No (local) — it's in `reference/` only; build it (and fix value encryption).
- *Do we need `tauri-plugin-fs`?* No — Node reads the folder; only `tauri-plugin-dialog` (picker) is needed.
- *Where do connector tokens live?* Encrypted `secrets` (value-encryption fix), namespaced per provider; no new table in V1.

## Open questions deferred (named so a later phase isn't ambushed)

- Document → embedding → `clustering_points` unification (would let documents reach the mindscape directly; large pipeline change).
- Lingering-memory GC for edited/deleted notes (diff against a stored vault manifest).
- Non-markdown Obsidian assets (images/PDF/canvas) ingestion.
- A dedicated `connectors` table (plaintext-queryable status) vs the secrets-namespaced V1.
- A hosted OAuth broker + Google app verification (live-infra; parallel to the remote-connect managed stack).
- Webhook/push connectors (the original `docs/CONNECTORS.md` bridge model) for Telegram/Discord/WhatsApp.

---

## Verification table (every load-bearing assumption, read myself)

| # | Assumption | Verified at |
|---|---|---|
| 1 | `captureMessage` choke-point; idempotent on caller `id`; `nlp_processed=0`; `{id,deduped}` | `src/ingest/capture.js:61-107` (read: `id=msg.id||randomUUID` :71; `getExistingIds`+`insertIgnore` :95-98; `nlp_processed:0` :80) |
| 2 | Mindscape sync is messages-only | `pipeline/sync-clustering-points.js:87-92` (read: `FROM messages … source_type='message'`, no documents branch) |
| 3 | Drainer embeds messages only | `src/enrich/drainer.js:24` (read: `createEnrichmentService({ messages: db.messages, … })`) |
| 4 | `cluster.py` supports documents but nothing feeds them | `pipeline/cluster.py:181,510,521` (read via sweep grep: `source_type='document'` join/select) |
| 5 | `saveDocument` upserts on `(user_id,path)`; provenance INSERT-only; `import-obsidian` valid | `src/core/document-store.js:74,113,264-407` (read: VALID_SOURCES `:74`, PATH_STRATEGIES `:113`, upsert flow `:327-391`) |
| 6 | `documents.upsert` ON CONFLICT (user_id,path); `get`/`delete` exist | `src/db/documents.js:5,85,93,206` (read: signatures) |
| 7 | Upload routers mount `/api/v1/portal` in `buildVaultSubApp`; no per-request auth | `src/server-rest.js:86-93,100-101` (read) |
| 8 | `ENCRYPTED_FIELDS.secrets=['key','description']`; `autoEncryptParams` encrypts only those cols ⇒ `value` plaintext | `src/crypto/crypto-local.js:352,546,1248,1320,1378` (read) |
| 9 | No local secrets endpoint/helpers; only `reference/` has them | grep src (only `crypto-local`/`jobs`/`keystore` mention "secrets"); `reference/server-routes/portal-settings.js:8-10` |
| 10 | Tauri has no fs/dialog plugins; `disable_drag_drop_handler`; `withGlobalTauri` | `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json:11`, `src-tauri/capabilities/default.json`, `src-tauri/src/main.rs:157` (read via sweep, quoted) |
| 11 | ImportDropZone gets browser `File` objects, not paths | `portal-app/src/lib/components/shell/ImportDropZone.svelte:64-88` (read via sweep, quoted) |
| 12 | Background task gets `db`+keys; scheduler slot is `completeBoot` gated `!injectedKeys` | `src/server-rest.js:149-189` (read: db inject, `setSessionKeys` :166, drainer start :176-181); `src/index.js:73` (key pin) |
| 13 | Message ops: `insertIgnore`/`getExistingIds` yes; no in-place content update (only `redact`/`updateEnrichment`) | `src/db/messages.js:230,282,324` (read: signatures) |
| 14 | Portal view registry shape + route intent + api client | `portal-app/src/lib/workspace/registry.ts`, `src/routes/(app)/import/+page.svelte`, `portal-app/src/lib/api.ts` (read via sweep, quoted) |
