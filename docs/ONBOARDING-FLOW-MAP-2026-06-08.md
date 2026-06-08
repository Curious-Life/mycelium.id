# Mycelium V1 — Complete New-User Onboarding Flow Map

**Date:** 2026-06-08 · **Method:** 6-domain parallel code sweep (file:line evidence) + live endpoint probes against the running app + a live fresh-install test.
**Scope:** Everything that happens from "double-click the app" to "talking to your vault" — wired and not-wired — with token limits, timeouts, retries, persistence, and activity logging per step.

> **Status legend:** ✅ **WIRED** (mounted + works) · 🟡 **PARTIAL** (works with caveats / degraded) · 🟦 **STUB** (mounted, intentionally returns a fixed/"not supported" response) · 🟥 **MISSING** (UI calls it; not mounted → 404) · 💳 **CODE-COMPLETE, NOT OPERATIONAL** (built + tested, needs live infra/keys).
> **Live-probe column** = HTTP status from the running V1 app (`:8787`) on 2026-06-08.

---

## 0. The shape of the system (context)

- **One Node process** (`src/server-rest.js`) on **:8787** serves the SvelteKit portal **and** the REST API. The Tauri shell (`src-tauri/src/main.rs`) spawns it and opens a webview at `http://127.0.0.1:8787`.
- **Two sidecar services**: embed-service (Nomic ONNX) on **:8091** (supervised in-process), enrichment/:8095 (optional).
- **Two "doors"** for external harnesses (post-onboarding): **North = memory/MCP** (`:4711/mcp`), **South = model gateway** (`:4711/v1`). Remote reachability needs the relay (see §6).
- **Single-user, local-first.** The vault is encrypted on-device. The only *paid* / *public-handle* path is the **managed relay** (§6), which is **code-complete but not operationally live**.
- **Master key:** one 64-char hex `USER_MASTER` (the recovery key); `SYSTEM_KEY` is HKDF-derived from it. Both cached in the macOS Keychain (`mycelium-user-master`, `mycelium-system-key`). First-run is gated on `kcv.json` existing in the data dir — **not** the keychain.

**The happy path (local, free):**
```
launch → setup-mode? → create vault (key ceremony, save recovery key)
       → land on Mindscape (Welcome) → connect AI (API key) → import data
       → embed (auto) → Generate Mycelium → explore 3D map
   (optional, later) → set handle (Profile) · connect Telegram/Discord · connect managed relay (paid)
```

---

## 1. App launch → server → webview  ✅

| What | Evidence | Notes |
|---|---|---|
| Tauri spawns `node src/server-rest.js` | `src-tauri/src/main.rs:225-255` | env: `MYCELIUM_REST_PORT=8787`, `MYCELIUM_KEY_SOURCE=keychain`, `MYCELIUM_DATA_DIR=<app-data>` |
| Wait for port (then open webview) | `main.rs:344-349` | **Timeout: 25s** polling :8787; webview → `http://127.0.0.1:8787` |
| Embed service adopted/owned by node | `src/embed/supervisor.js` | :8091 spawned/adopted in-process (see §9) |

**Persistence:** none here. **Data dir (macOS):** `~/Library/Application Support/id.mycelium.app/` (`mycelium.db`, `kcv.json`, `vault-lock.json`, `auth.db`, `remote.json`, `uploads/`). Resolution: `src/paths.js` (`MYCELIUM_DATA_DIR` → Tauri app-data → `./data` in dev).

---

## 2. First-run detection & routing  ✅

| What | Evidence | Live |
|---|---|---|
| `GET /api/v1/account/status` | `src/account/router.js:42-55` | 200 |
| Returns `{open, needsSetup, locked, passphraseEnabled, keychainAvailable, onePasswordAvailable}` | `router.js:46-54` | `needsSetup = !existsSync(kcvPath)` |
| Portal routes setup/unlock/app | `portal-app/src/routes/+layout.svelte:32-52` | `locked→/unlock`, `needsSetup→/setup`, else session check → `/login` or app |
| Loopback-only guard on control surfaces | `router.js:36-39` | rejects X-Forwarded-For with 403 |

**Rate limits/timeouts/logging:** none on status. **Persistence:** none (pure read).

---

## 3. Account ceremony — key generation, recovery, lock  ✅ (audit logging 🟦)

### 3a. Create vault — `POST /account/setup`  ✅
`src/account/router.js:57-72` · body limit **64 kb** (`express.json({limit:'64kb'})`).
1. `generateUserMaster()` → `crypto.randomBytes(32)` hex (`keystore.js:46`)
2. `deriveSystemKey()` → HKDF-SHA256, info `mycelium:system-key:v1` (deterministic) (`keystore.js:52-56`)
3. `writeKeychain()` → both keys to Keychain; **refuses different-value overwrite in default namespace without `force`**, auto-backs-up prior to `<svc>.bak.<ts>` (`keystore.js:135-156, 99-113`)
4. `completeBoot()` → `ensureVaultSchema` (migrations) + `boot()` + `setSessionKeys()` (`server-rest.js:215-285`)
5. Returns `{recoveryKey}` **once**.

**UI** (`routes/setup/+page.svelte`): reveal key (4-char groups) → **Save to Keychain / 1Password / download / copy** → if not saved to a manager, **must re-type the key** to prove possession (`:228-261`) → `enterVault()` → `/mindscape`.

> ⚠️ **Recovery key shown once.** Close the tab before saving → unrecoverable on a new machine (by design). The re-entry challenge only proves possession for *this* session.

### 3b. Restore — `POST /account/restore`  ✅
`router.js:74-99`. Paste 64-char key → if `kcv.json` exists, **KCV-verify before writing** (wrong key rejected, never stored) → `writeKeychain(...,{force:true})` (backs up prior) → `removeLock` → boot. Errors: `invalid_key` 400 / `wrong_key` 400 / `restore_failed` 500.

### 3c. Recovery-key re-view / save  ✅
`GET /account/recovery-key` (`:102-106`), `POST /account/recovery-key/save {target:'keychain'|'1password'}` (`:111-127`) — key handed to store server-side, never returned to client.

### 3d. Optional passphrase lock  ✅
- `POST /account/passphrase/enable` (`:167-190`): min **8 chars**; `sealKeys` (scrypt N=2¹⁶,r=8,p=1, ~64 MB/~100 ms + AES-256-GCM) → `vault-lock.json` (0600); **deletes keychain keys** (keys now only unsealed by passphrase). Round-trip-verified; lock removed on failure.
- `POST /account/unlock` (`:146-161`): **rate-limited 10 attempts / 60 s per IP** (`:132-140`); `unsealKeys` → boot (keys in memory only, not re-written to keychain).
- `POST /account/passphrase/disable` (`:194-212`): unseal → `writeKeychain(force)` → remove lock.

**Persistence:** Keychain items (`mycelium-user-master`, `mycelium-system-key`, `*.bak.*`), `mycelium.db`, `kcv.json`, `vault-lock.json`. **Activity logging:** 🟦 `audit_log` table + `db.audit` exist but the **account ceremony is not wired to log** setup/restore/unlock events.

---

## 4. First view + onboarding UX  🟡 (several stubs/missing)

**Landing:** setup → `window.location.assign('/mindscape')`; `/` → `/mindscape` (`routes/+page.svelte:6`). Tabbed workspace; "Mycelium" is the first nav item.

**Two overlays** mount in `(app)/+layout.svelte`:
- **WelcomeModal** ✅ — 3-step intro; `POST /portal/onboarding/welcome-seen` persists `welcome_shown_at` on `users` (`portal-compat.js:692-700`). Live: 200.
- **OnboardingGuide** 🟡 — bottom-right card; adaptive poll **3s/15s/60s** (pauses when tab hidden). Reads `GET /portal/onboarding/status` (live 200) — but that endpoint is a **stub**: `show:false` hardcoded, `enrichedCount:0`/`enrichmentPending:0` never updated; only `messageCount` is real (`portal-compat.js:675-687`).

**The 4 guide steps and their backends:**

| Step | UI calls | Live | Status |
|---|---|---|---|
| 1. Connect AI (Claude OAuth) | `POST /portal/auth/claude` | 400 | 🟦 refused ("add an Anthropic API key") |
| 1. Connect AI (OpenAI OAuth) | `GET /portal/auth/openai/status` · `…/poll/:id` | 200 / — | 🟦 `{authenticated:false}` · poll 🟥 missing |
| 1. Connect AI (API key) | `POST /portal/providers` | — | ✅ (the real path — see §7) |
| 2. Import data progress | `GET /portal/enrichment/status` · `POST …/trigger` · `GET …/progress/:id` | 404·404·404 | 🟥 **all missing** (guide spins forever) |
| 3. Messaging | `PUT /portal/settings/secret` (or `/portal/channels`) | 200 | ✅ (see §11) |
| 4. Generate | `POST /portal/mycelium/generate` · `…/status/:id` | — | ✅ (see §9) |
| Dismiss card | `POST /portal/onboarding/dismiss` | 404 | 🟥 missing (card can't be dismissed) |

**MindscapeView empty-state** (the screen you actually see) is separate and **correct** once data is detected — see §10.

**Net UX gaps (launch-blocking):** the guide's enrichment polling + dismiss + OpenAI poll are missing, and the OAuth buttons are stubs. The API-key path and Generate work; the guide just can't *narrate* import progress.

---

## 5. Handle  🟡 (local) / 💳 (public)

There are **two distinct "handles":**

- **Local profile handle** (e.g. shows in your profile) — `PUT /portal/profile {handle}` + `GET /portal/profile/handle/check` (live 200). Validated `^[a-z0-9][a-z0-9_]{2,29}$`, reserved-word list, UNIQUE on `user_profiles.handle` (`portal-compat.js:131-197`). **Optional, set in Profile — NOT part of first-run.** (The federated `handles.claim()`/`handle_reservations` Worker path exists in code but is **not wired** in the local single-user build.)
- **Public managed handle** `<handle>.mycelium.id` — claimed through the **paid managed-relay** flow (§6), gated by signature + payment. This is the only handle that gives a public address.

**Onboarding gap (B1c):** a new user is never guided to claim *either* handle.

---

## 6. Payment / managed relay / provisioning (the paid, public path)  💳 CODE-COMPLETE, NOT OPERATIONAL

Gives a user a public `<handle>.mycelium.id` MCP endpoint (~€1/mo) via an FRP reverse-tunnel + Caddy TLS, gated by a Cloudflare Turnstile bot-check and Stripe. **All code paths exist and are hermetically tested; nothing is live.**

**Flow (client `src/remote/router.js` ⇄ control plane `mycelium-managed/src/`):**
1. **Status + Turnstile widget** — `GET /remote/status` (live 200), `…/managed/turnstile` (sandboxed iframe, origin-checked).
2. **Handle availability** — debounced 400 ms `GET …/managed/available` → control plane `GET /v1/handle/:h` (reserved-set + registry + advisory DNS).
3. **Nonce** — `GET /v1/challenge?cf_turnstile=…` → 144-bit single-use nonce, **TTL 5 min** (`nonce.js`).
4. **Signed claim** — ed25519 identity derived from master key (HKDF `mycelium-identity-v1`); message `mycelium-handle-claim:v1:<action>:<handle>:<nonce>`, actions `{provision,release,billing}` (`managed-claim.js`).
5. **Provision** — `POST /v1/provision` (`server.js:171-253`): nonce-consume → signature-verify → **atomic registry.claim** → DNS availability (rollback on conflict) → **entitlement gate (reserve-then-pay)**: if billing on & not entitled → `registry.setHold` + Stripe checkout → **HTTP 402 `{checkoutUrl}`** (client validates `https://`). Daily cap **40 new handles/day**.
6. **Checkout** — Stripe subscription session, `client_reference_id=publicKey`, EU auto-tax (`billing.js:68-85`).
7. **Webhook** — `POST /v1/stripe/webhook` (raw-body HMAC, ±300 s tolerance, constant-time, fail-closed 400): `checkout.session.completed`→provisional 34 d, `invoice.paid`→real `paid_until`, `payment_failed`/`subscription.deleted`→`clearEntitlement` (`server.js:67-105`, `registry.js`).
8. **Materialize on-box** — relay token + acme-dns creds → `auth.db` (0600); `remote.json` (plaintext); `frpc.toml` + `Caddyfile` (0600) (`runtime.js`).
9. **Relay auth** — frps `Login`/`NewProxy`/`Ping`/`CloseProxy` hooks: token lookup, host ownership, **single-active-proxy** (TTL 5 min), entitlement gate, bandwidth clamp 2 MB (`relay-hook.js`).
10. **Billing portal** — `GET /managed/billing-portal` → separate billing-nonce store → Stripe customer portal (`server.js:276-301`).

**TTLs/limits:** nonce 5 min · hold `HOLD_TTL_MS` 30 min · grace `GRACE_MS` 3 d · provisional 34 d · single-active TTL 5 min · 40 handles/day · bandwidth 2 MB. **Persistence (control plane):** `handles`, `entitlements`, `nonces` (0600). **Fail-closed** at every gate.

**Operationally MISSING for a real paid launch:** live `MYC_STRIPE_SECRET` / webhook secret / price IDs + webhook URL registration; deployed relay host (`MYC_RELAY_ADDR`/`IP`) + DNS zone + acme-dns; Turnstile keys; a post-checkout return page; a "subscription lapsed" user message; (and a hold-sweeper start call appears absent). → checklist **B7/B8**.

---

## 7. AI connection  ✅ (OAuth 🟦)

**Add provider (the real path)** — `POST /portal/providers {provider, api_key, model_preference?, base_url?}` (`src/portal-providers.js:92-111`). Providers ∈ {openai, anthropic, claude, custom}. Credentials **encrypted** (`ai_providers.credentials` ∈ ENCRYPTED_FIELDS); responses never echo the key. Tables: `ai_providers`, `ai_provider_assignments`(+`_audit`). `getActive(userId)` = most-recently-used.

**OAuth** — `POST /portal/auth/claude` 🟦 400 (Claude subscription OAuth = ToS violation; BYOK only); `…/auth/openai/status` 🟦 `{authenticated:false}`; OpenAI device-code poll 🟥 missing.

**Inference router** (`src/inference/`): local-first policy — `LOCAL_TASKS=[summarize,classify,extract]` always on-box Ollama; `CLOUD_TASKS=[narrate,complex]` → cloud **iff** a BYOK key is set, else local. Jurisdiction-aware (`sensitive=true` drops all US providers; eu-zdr/local only). Cascade (opt-in `MYCELIUM_INFER_CASCADE`): EU-ZDR → US-frontier → local.
- **Models:** local default `llama3.1` (`local.js:14`); cloud defaults `claude-sonnet-4-6` / `gpt-4o` (`cloud.js:19-20`).
- **Token/limits:** default **maxTokens 1024** per call (no global cap); local `num_ctx` must be sized to prompt+output or Ollama truncates.
- **Timeouts:** **60 s** TTFB (guards time-to-first-byte, not whole stream) — local & cloud.
- **Retries:** cloud failure → local fallback (`cloudFallbackToLocal`, default on); cascade tries next provider on cloud error. No backoff.
- **Egress audit:** every cloud egress logs `inference-egress` to `audit_log` with **hash-only** (sha256) content + length, decision, jurisdiction — **never plaintext** (`src/inference/egress.js`).

---

## 8. Data import / upload  ✅ (LinkedIn 🟦; import_jobs 🟡)

**Endpoints** (`src/portal-uploads.js`): `POST /upload` (single, ≤**512 MB**), `/upload/chunk` (≤**64 MB**/chunk; ≤**100k** chunks; ≤**32** concurrent; 429/413 guards), `/upload/complete` (assemble→detect→parse), `/upload/file` (attachment, ≤**25 MB**, optional vision caption). Pending-upload in-memory **TTL 1 h** (sweep). Client driver `chunked-upload.ts`: ≤100 MB single else **50 MB** chunks, **3 retries** exp-backoff (base 2 s), **2 min**/chunk, **10 min** completion timeout, CSRF header. Large 90–500 MB ZIPs are re-packed client-side to strip media.

**Parsers** (`src/ingest/import-parsers.js`): detection by `conversations.json`/`.md`/CSV; decompression-bomb guard (**MAX_JSON_BYTES 400 MB**, two-layer); **MAX_MESSAGES 1,000,000**.
- **Claude** ✅ → messages (`claude-<uuid>` ids; preserves `created_at`).
- **ChatGPT** ✅ → messages (mapping-tree walk; `create_time`).
- **Obsidian** ✅ via `POST /portal/import/obsidian` (folder/`webkitdirectory`; ≤2 MB/file, ≤20k files) → documents + memories.
- **LinkedIn** 🟦 detected, "not supported yet". **Obsidian-as-ZIP** 🟡 detected but not parsed (use folder import).
- Response shape: `{importResult:{type,imported,skipped,stats:{messages,conversations,skipped_duplicates}}}` (live-confirmed import works: 132 msgs / 6 convs).

**Persistence + dedup** (`src/ingest/capture.js` → `src/db/messages.js`): `captureMessage` encrypts at rest (ENCRYPTED_FIELDS.messages = content, thinking, tags, entities, entity_summary, relations, metadata, nlp_error), dedups on **`content_hash` (sha256, plaintext column)** — new→INSERT, same-hash→no-op, diff-hash→UPDATE+null AI cols+re-enqueue. created_at normalized to ISO. Queues at `nlp_processed=0`. **Activity logging:** ✅ fire-and-forget `audit_log` `message_captured`/`message_updated`. `import_jobs`/`background_jobs` tables exist but import doesn't currently populate them (🟡).

---

## 9. Embedding + generation  ✅ (chronicles now async; Tier-2/3 host-dependent)

**Embed supervisor** (`src/embed/supervisor.js`) — owns :8091; health states `ok/loading/starting/error/deps_missing/down/unknown`; dep self-check (numpy/onnxruntime/…); exponential-backoff restart (max **30 s**, **5** crashes→down); adopts a healthy :8091; probe **2 s**, tick **3 s**.
**Drainer** (`src/enrich/drainer.js`) — health-gated batch embed; **batch 50** (chunked **12**), ≤**200** batches/cycle (≤10k msgs); timer **15 s**; self-heals service-failed rows. Embed client **30 s**/call, dim assert 768.
**Status** — `GET /portal/mycelium/processing-status` → `{embedded,total,pending,embedder{status,…}}` (live 200; this is the **correct** signal — the onboarding/status `enrichedCount` is stale).

**Generate** — `POST /portal/mycelium/generate` (preflight **MIN_EMBEDDED=5**; 409 if too few) → `startClusteringJob` (`src/jobs.js`): **single-flight**, keys re-resolved at spawn via allowlisted env (never args/logs), spawns `bash pipeline/run-clustering.sh`. **Timeouts:** MAX_MS **45 min** (SIGTERM→SIGKILL 5 s), STALL_MS **5 min** (flag-only watchdog, 15 s checks). Progress via stdout `Step N/16`; status `GET …/generate/status/:id`. `generate-stats.json` records last duration for ETA. **16 steps** (sync→cluster→describe→cofire→neighbors→harmonics→fisher→topology→vitality→complexity→frequency→coupling→criticality→coherence→behavioral→anchors). **Persistence:** `clustering_points, realms, territory_profiles, semantic_themes, theme_cards, cognitive_metrics_*, topology_audit_*, frequency_snapshots, …`.

**Chronicle narration — now ASYNC background** (refactored 2026-06-08, commit `bf5ad4b`): removed from the foreground (Step 3 gated behind `MYCELIUM_RUN_CHRONICLES=1` in `run-clustering.sh`); `startChronicleNarrationJob` (`jobs.js`) fires after a successful Generate with a **180 s** per-territory timeout, fail-soft. **Verified live, end-to-end:** foreground Generate **26 s** (was 9.5 min — ~20× faster); the background job fires and **all 9 territories were narrated** (real `story_arc` / `archetype_type` / `essence`, decrypted via `/portal/mindscape/territories`). Narration writes the `story_*` / `archetype_*` / `essence` / `description_version` columns (`db/territory-docs.js`) — **not** the vestigial `chronicle` column. Tier-3, fail-soft. ⚠️ **Provider note:** `narrate` is a *cloud* task; with a BYOK provider configured it routes there first. On this host a connected Regolo provider (`https://api.regolo.ai/v1`, model `qwen3.6-27b`) errored on `narrate` (`1 failed` on the cloud attempt) — the router's `cloudFallbackToLocal` (`router.js:158-166`) covered it via local `llama3.1` (1.4 s/call, valid JSON), so narration still completed. Worth hardening: a cloud TTFB timeout (~60 s) can eat the per-territory budget before fallback runs, and an invalid model id should surface in the UI. Local-only narration is fast and reliable.

**Tiers:** Tier-1 (crypto+metric math, in-process) always works; Tier-2 (python: faiss/sklearn/harmonics/…) needs the venv/deps; Tier-3 (embed-service + Ollama/cloud) is fail-soft.

---

## 10. Mindscape first view / data detection  ✅ (polling fixed 2026-06-08)

`MindscapeView.svelte` empty-state branches: generating → embedding → **"Your data is ready → Generate Mycelium"** (`hasImportedData`) → Welcome/ConnectionsChecklist. `hasImportedData` = `messageCount>0` from `/portal/onboarding/status`.
**Bug fixed (`bf5ad4b`):** `checkGenerationState()` ran only in `onMount`; in the tabbed workspace the view stayed mounted so post-import it never re-checked (user had to close+reopen). Now **polls every 5 s until data is detected** + **re-checks on app refocus** (also reloads territories so async chronicles appear). Imported conversations themselves render in **Timeline** (`/portal/messages`); **Library shows documents** (chat imports are messages, so Library looks empty — a UX gotcha, checklist B1b).

---

## 11. Telegram / Discord connection  🟡 (capture-wired; live two-way partial)

**Config** — `ChannelsSection.svelte` → `PUT /portal/channels` (live `GET` 200): saves `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_ID`, `DISCORD_BOT_TOKEN`, `OWNER_DISCORD_ID`, optional `ANTHROPIC_API_KEY`, routing knobs (router, model, coalesceMs, rateLimitMax/Window, sensitivePatterns) into `db.secrets` (encrypted). Per-channel access policy (`owner|allowlist|open`) → `channel_access`. Authorized rooms: `telegram_groups`, `identity_channels`. Daemon hydrates via loopback `/internal/channel-config`.
**Egress chokepoints** — `/telegram/send`, `/discord/send`, `/whatsapp/send`: requireWorkerSecret → kill-switch → assertDeliverable → envelope-dedup → channel-authority → `egress_audit`. **Explicit-send only** (agent free-form text is never delivered). The send-handler + bot transports live in `reference/` and the agent-server repo — **two-way live messaging is Phase-4/partial in V1 core**.

---

## 12. In-app chat (ChatFloat)  🟥 backend MISSING in V1 core

`ChatFloat.svelte` posts to **`POST /portal/chat/stream`** (SSE: `stream_start/text_delta/thinking_*/tool_*/usage/done`), with agent/space/doc scoping and an optional encrypted WebSocket channel. **Live probe: 404 — the route is not mounted in the V1 server.** The full chat backend (prompt assembly, lane queue, session resume, context-overflow compaction, explicit-send, split user/assistant persistence) exists only in `reference/server-routes/chat.js`. **So the floating chat UI has no working backend in V1.** (Token/timeout/retry behavior described there is reference-only until ported.) → onboarding gap.

---

## 13. Cross-cutting reference

### Token / size / count limits
| Limit | Value | Where |
|---|---|---|
| Inference maxTokens (default) | 1024 | `inference/router.js` |
| Chronicle narrate maxTokens | 700 | `describe-chronicles.js:136` |
| Account setup body | 64 kb | `account/router.js` |
| Obsidian import body | 64 kb | `portal-import.js` |
| Upload single / chunk | 512 MB / 64 MB | `portal-uploads.js:35-36` |
| Attachment | 25 MB | `portal-uploads.js:53` |
| Max chunks / concurrent uploads | 100,000 / 32 | `portal-uploads.js:39-40` |
| Import JSON / messages | 400 MB / 1,000,000 | `import-parsers.js:17-18` |
| Obsidian file / count | 2 MB / 20,000 | `obsidian-import.js:34-35` |
| Embed batch / chunk / cycle | 50 / 12 / 200×(≤10k) | `enrich/drainer.js` |
| Relay bandwidth / new-handles-day | 2 MB / 40 | `relay-hook.js` / `mycelium-managed/server.js` |
| MIN_EMBEDDED for Generate | 5 | `portal-mindscape.js:290` |

### Timeouts
| Timeout | Value | Where |
|---|---|---|
| Tauri wait-for-port | 25 s | `main.rs` |
| Inference TTFB (local+cloud) | 60 s | `inference/{local,cloud}.js` |
| Embed probe / call | 2 s / 30 s | `embed/{supervisor,client}.js` |
| Generate hard cap (MAX_MS) | 45 min | `jobs.js:20` |
| Generate stall flag (STALL_MS) | 5 min | `jobs.js:24` |
| Chronicle per-territory (async) | 180 s | `jobs.js` (was 60 s inline) |
| Upload chunk / complete (client) | 2 min / 10 min | `chunked-upload.ts` |
| Pending-upload TTL | 1 h | `portal-uploads.js:46` |
| Relay nonce / hold / grace / active-slot | 5 min / 30 min / 3 d / 5 min | `mycelium-managed/*` |
| scrypt unlock | ~100 ms | `passphrase-lock.js` |

### Retries / idempotency / single-flight
Upload chunks 3× exp-backoff + last-write-wins · message dedup by `content_hash` + INSERT OR IGNORE · embed self-heal on service recovery · Generate single-flight + resume-on-reload + 409 auto-retry (≤45×4 s) in OnboardingGuide · inference cloud→local fallback · relay single-active-proxy + compare-and-clear · nonce single-use.

### Rate limits
`/account/unlock` 10/60 s per IP · relay `/login` + `/sign-in/email` 5/60 s, passkey 10/60 s (`server-http.js`) · managed new-handles 40/day · channels rateLimitMax/Window stored (daemon-enforced).

### Persistence (tables touched during onboarding)
Keychain (`mycelium-user-master/-system-key/*.bak`) · `kcv.json` · `vault-lock.json` · `auth.db` (operator/better-auth + `mycelium_remote_secret`) · `remote.json` · `users` (welcome_shown_at) · `user_profiles` (handle) · `ai_providers`(+assignments/audit) · `secrets` (channel tokens) · `messages`/`attachments`/`documents`/`folders` · `clustering_points`/`realms`/`territory_profiles`/`semantic_themes`/`theme_cards`/`cognitive_metrics_*` · `audit_log` · `egress_audit` · control-plane `handles`/`entitlements`/`nonces`.

### Activity / audit logging
✅ `audit_log`: message capture/update, inference-egress (hash-only), **account ceremony success (`vault_setup`/`vault_restore`/`vault_unlock` — added PR-D)**. ✅ `egress_audit`: channel sends. 🟦 Still not logged: onboarding step completion (no analytics); ceremony *failures* (pre-boot, vault closed — not auditable by design). `background_jobs`/`import_jobs` schema present but underused.

---

## 14. Gaps rollup — what a new user actually hits

**Works end-to-end today (local, free):** launch → create vault + save recovery key → connect AI via **API key** → import Claude/ChatGPT/Obsidian → auto-embed → **Generate** (26 s) → explore 3D map → Timeline shows conversations → set handle in Profile → configure Telegram/Discord tokens.

**Fixed 2026-06-08 (branch `fix/async-chronicles-mindscape-polling`, PR-A/B/D):**
- ✅ **OnboardingGuide enrichment polling + dismiss mounted** (`/portal/enrichment/{status,trigger,progress}`, `/portal/onboarding/dismiss`); `/onboarding/status` now reports real embedded/pending. *(was B1)*
- ✅ **AI-connect leads with API key** (OnboardingGuide form + ConnectionsChecklist default), OAuth demoted; also fixed the API-key tab writing to the wrong store (`/portal/settings/secret` → `/portal/providers`). *(was B2)*
- ✅ **Post-import CTA always shows** ("Go to Mindscape" + "View in Timeline"). *(was B1b)*
- ✅ **Optional handle step** added to WelcomeModal. *(was B1c)*
- ✅ **TEMP debug logging removed** from `server-http.js`. *(was B3)*
- ✅ **Account-ceremony audit logging** (`vault_setup/restore/unlock`) via `completeBoot`. *(PR-D)*

**Still open:**
- 🚧 **In-app chat backend** (`/portal/chat/stream` 404) — **being built by a separate agent** (context-aware chat: getContext/searchMindscape + inference router). *(PR-C)*
- 💳 **Payment/public-handle path needs live infra** (Stripe keys + webhook + relay host + DNS + Turnstile). *(B7/B8)*
- 🟡 **Chronicle/provider robustness** — `narrate` routes to a BYOK provider first; a bad provider (e.g. Regolo `qwen3.6-27b`) errors and is covered by local fallback. Surfacing provider errors in the UI is deferred (PR-D2). OpenAI device-code poll still missing (API-key path supersedes it).

See `docs/LAUNCH-PREP-CHECKLIST-2026-06-08.md` for the prioritized fix list (P0/P1/P2) these map to.

---

*Built from a 6-domain parallel code sweep (each item file:line-cited) + live endpoint probes against the running V1 app + a live fresh-install test, 2026-06-08. Reference-repo bleed (e.g. tmpfs master key, multi-tenant `handle_reservations`, the reference chat/send-handler) has been filtered out — this map reflects the V1 self-hosted build as actually mounted.*
