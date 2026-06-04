# Benchmark — Data Connections: Mycelium vs OpenHuman vs Odysseus

**Date:** 2026-06-04
**Author:** sweep-first review (4 parallel deep-dives, citation-backed)
**Companion to:** `docs/HANDOFF-import-connectors-2026-06-04.md` §10 (this fills in that benchmark plan)
**Subjects:**
- **Mycelium** (this repo, `origin/main` 04bdca1) — local-first encrypted single-user vault; in-app OAuth; in-process poll scheduler.
- **OpenHuman** — `github.com/tinyhumansai/openhuman` @ `87a91ae` (2026-06-04). Rust core + TS/React (Tauri-style desktop). Cloud broker (Composio) + real-time push.
- **Odysseus** — `github.com/pewdiepie-archdaemon/odysseus` @ `68eeb78` (2026-06-04). Python/Flask self-hosted workspace. Direct-protocol (IMAP/CalDAV).

> Method: cloned both repos, ran 4 scoped deep-dive agents (OpenHuman auth+secrets / OpenHuman sync+triggers / Odysseus email+secrets+scheduler / Odysseus calendar+webhooks+threat-model), each filling the §10 dimension table with `file:line` citations. Two cornerstone claims (OpenHuman content-hash upsert; webhook→Socket.IO push relay) were spot-verified by hand against source.

---

## 1. TL;DR — three philosophies

| | **Mycelium** | **OpenHuman** | **Odysseus** |
|---|---|---|---|
| **Stance** | On-device, local custody, fail-closed | **Cloud-brokered** custody + real-time | **Direct-protocol**, self-hosted admin console |
| **Connectors** | In-app JS adapters (`normalize`+`pull`) | Hosted **Composio** broker (118+ toolkits) | Hardcoded per-protocol (IMAP/SMTP, CalDAV) |
| **Auth** | In-app OAuth2+PKCE (no broker) | OAuth **hosted by Composio**; loopback for login; PKCE only for OpenRouter | **Username/password only** (no OAuth/XOAUTH2) |
| **Token storage** | AES-256-GCM encrypted secrets table | **OS keyring** (ChaCha20-Poly1305 file + master-key-in-keyring); integration tokens live in **Composio cloud**, not on device | **Fernet (AES-128)** key-file beside the DB |
| **Freshness** | Poll every 5 min | **Push** (backend-relayed webhook → socket) **+** 20-min poll | Poll **on calendar page-load** + cron email actions |
| **Two-way** | No | No (read-into-memory) | **Yes — CalDAV writeback** |
| **Multi-account** | 1 / provider | Effectively 1 / toolkit (entity hardcoded) | 1 CalDAV / user; multi-account email table |
| **Standout strength** | Simplicity, on-device custody, fail-closed crypto | Dedup/budget/audit rigor; push relay; config-driven extensibility | Scheduler robustness; CalDAV writeback; SSRF egress hardening |

**The single most important finding:** OpenHuman's "real-time" *depends on a cloud backend* to terminate + HMAC-verify provider webhooks and push them down an authenticated socket to the local app. A local-first app with no hosted relay (us) **cannot** replicate that model directly — see §6. This reframes our own "add webhooks" deferral: the realistic local-first path to freshness is *better polling*, which OpenHuman also does and does well.

---

## 2. Dimension matrix (§10, filled)

| Dimension | Mycelium (baseline) | OpenHuman | Odysseus |
|---|---|---|---|
| **Connector model** | JS adapter `{normalize(), pull(ctx,{cursor})}` in a registry | Hosted broker; a "toolkit" (slug) + "connected account" (Composio-side id). Native Rust providers pull into memory | No unified registry. Two unrelated things: `integrations.json` REST presets + **hardcoded** IMAP/CalDAV. Pattern-table MCP discovery (`CHECKIN_MCP_PATTERNS`) |
| **Auth** | OAuth2+PKCE(S256)/state for Gmail; confidential for Linear; redirect→`localhost:8787` | Composio runs the OAuth (app polls `listConnections` every 4 s, no local PKCE/redirect). Loopback listener (RFC 8252, server-minted state nonce, peer/method/path hardening) for *account login* + OpenRouter only | **None.** `imaplib`/`smtplib` `LOGIN` with user+password (app-passwords in practice). Inbound API tokens `ody_…` bcrypt-hashed |
| **Token/secret storage** | AES-256-GCM, `SYSTEM_KEY`, keys `connector:<id>:tokens/:state` | OS keyring (`keyring` v3); `SecretStore` = ChaCha20-Poly1305 on disk + **master key in keyring**, single-load via `OnceLock` (dodges macOS N-prompt). Per-integration tokens **never on device** (Composio cloud). Write-only "BYO key" (`api_key_set` bool readback) | **Fernet (AES-128-CBC+HMAC)**; key auto-generated at `data/.app_key` (chmod 600, **no KDF**, sits *next to the DB*). `enc:`-prefix idempotent migration |
| **Sync strategy** | Poll only | **Push + poll.** Webhook → cloud backend HMAC-verifies → `composio:trigger` over Socket.IO → `DomainEvent::ComposioTriggerReceived`. Poll is the fallback/complement | Poll only, **client-triggered** (CalDAV syncs once per page-load + manual button; email via cron actions). No server timer for CalDAV despite docstrings |
| **Scheduling** | `setInterval` 5 min, single-flight, gated `!injectedKeys` | In-process tokio loop, **20-min global tick** (`TICK_SECONDS=1200`); per-provider intervals 15–30 min; singleflight via `OnceLock` + shared `LAST_SYNC_AT` dueness map | In-process asyncio `TaskScheduler` + `croniter`; **hard `Semaphore(1)`** (one job at a time globally); adaptive sleep; env-gated for external worker. Separate 30 s outbound-email poller |
| **Incremental state** | Per-connector cursor in `connector:<id>:state` (secrets row) | Per-`(toolkit,connection)` cursor in encrypted KV; Gmail cursor→`after:` filter; `last_seen_id` head-unchanged early-stop; adaptive page-cap from persisted `last_sync_at_ms` | **CalDAV: none** (no CTag/ETag/sync-token — full 90 d-back/365 d-fwd re-scan every time). Email: no IMAP UID cursor; "seen" = a derivative-cache row exists by `Message-ID` |
| **Normalization** | `adapter.normalize()` → single `captureMessage()` choke-point (+ `saveDocument` for Obsidian) | **Two-stage:** per-provider reshape → `canonicalize/` adapters → `CanonicalisedSource{markdown, metadata}` → `mem_tree_chunks`. (`integrations_agent` is an *on-demand tool agent*, NOT sync.) Inbound triggers get an LLM **triage** gate (drop/ack/react/escalate) | `Message-ID`-keyed derivative caches only (**no message mirror**). `email_thread_parser.py` = talon-style reply splitting for *display*. CalDAV: `icalendar` → event rows |
| **Dedup** | Deterministic id + **`INSERT OR IGNORE`** (`capture.js:96` `insertIgnore`) → **first-write-wins** | **Two layers:** optimistic `synced_ids` set (stops pagination early, saves quota) + authoritative **`sha256(source_kind‖source_id‖seq‖content)[..32]` + `ON CONFLICT(id) DO UPDATE`**. Content-in-hash ⇒ edits flow in, re-deliveries collapse | `Message-ID` (+ synthetic-hash fallback) PK on caches. Multi-tenant lesson: PK `(message_id, owner)` because `Message-ID` is globally shared. CalDAV: upsert by VEVENT `UID` scoped per-calendar |
| **Storage schema** | **No** connectors table — state lives in encrypted secrets rows | `mem_tree_chunks` (content-addressed) + encrypted KV for sync state; no relational "connections" table either | **`EmailAccount`** table (real, encrypted, multi-account); `CalendarCal`/`CalendarEvent`; `webhooks`. CalDAV creds in `user_prefs.json` (not DB). Vestigial ORM `Integration` table |
| **Multi-account** | 1 / provider | Auth-profiles support `{provider}:{profile}` for *login*, but Composio `entity_id` is **hardcoded `"default"`** + UI keys by toolkit ⇒ **1 / toolkit** in practice | **1 CalDAV / user** (single dict; fans to many *calendars*). Email: **multi-account table** with `is_default` |
| **Errors / limits** | Status surface; `MAX_ITEMS_PER_SYNC=500` | Exp-backoff on connect-poll; **cursor not advanced on failure** (retry next tick); **daily request budget 500/connection**; `sync_audit.jsonl` (items/tokens/$/duration). Health = liveness only (per-provider errors deferred) | Crash-safe scheduler (zombie-run reaping, overdue-`next_run` advance, advance-on-failure); `TaskDeferred` quiet-window backoff. **No** IMAP/SMTP retry/backoff/rate-limit. Outbound webhook: **strong SSRF guard** |
| **Extensibility** | Register adapter (`normalize`+`pull`) | **Config/data-driven:** new toolkit often 0 frontend code; declarative `toolkitRequiredFields` (slug→fields, the field `key` *is* the wire param); 612 self-healing for unknown fields | Add a REST preset (dict entry) or hand-roll a protocol module. No shared interface across types |
| **Security posture** | Encrypted-at-rest, **fail-closed** (missing key → `REFUSE`); localhost-only no-auth accepted | Documented trust boundary w/ Composio cloud; keyring-unavailable **consent gate**; decrypt-failure isolation (drop one profile); error/secret redaction. Footgun: plaintext `dev-keychain.json` backend exists | **2FA (TOTP + backup codes)**; admin-only calendar/webhook; honest in-code threat model (stops file-exfil, not process compromise). **Fail-OPEN** decrypt (corrupt key → blanks creds); `http://` CalDAV allowed (TLS not enforced) |

---

## 3. Standout mechanisms worth studying (with citations)

### OpenHuman
1. **Backend-relayed webhook → Socket.IO push** — `socket/event_handlers.rs:137-161` deserializes `composio:trigger` (after the cloud backend HMAC-verifies the provider webhook) → `publish_global(DomainEvent::ComposioTriggerReceived{…})`. Doc: `gitbooks/features/integrations/triggers.md:68-69` — *"The webhook never reaches your machine raw."* The cleanest answer to "real-time on a desktop app without exposing localhost" — **but it requires a hosted relay** (see §6).
2. **Content-in-hash chunk id + UPSERT** — `memory_store/chunks/types.rs:249-282` `chunk_id = sha256(source_kind‖source_id‖seq‖content)[..32]`; `chunks/store.rs:396/429/467` `ON CONFLICT(id) DO UPDATE`. Identical re-deliveries collapse; **edited upstream items get a new id and flow in**. Strictly better than `INSERT OR IGNORE`.
3. **Two-tier dedup** — optimistic `synced_ids: HashSet` (hot-path quota saver; stops pagination early; committed only after durable write) + authoritative content-hash upsert (correctness). `providers/sync_state.rs:91-95`, `gmail/provider.rs:446-513`.
4. **Adaptive poll** — `last_seen_id` head-unchanged short-circuit + page-cap shrink when last sync was <5 min ago (`gmail/provider.rs:261-275, 391-412`). Makes a frequent poller nearly free on quiet sources.
5. **Two-axis budgeting** — per-connection **daily request count** (`DEFAULT_DAILY_REQUEST_LIMIT=500`, the real backstop) vs. per-sync token/cost (UI exists but **orphaned** — see §7). `providers/sync_state.rs:38`.
6. **Pull-based status** — sync status = `COUNT(mem_tree_chunks) GROUP BY source` at read time, replacing an earlier racy push-status store that "lied about downloading 0/0" (`sync_status/types.rs:3-9`).
7. **Secret hygiene** — single master-key load via `OnceLock` (`encrypted_file_backend.rs`); keyring-unavailable **consent gate** (no silent downgrade); decrypt-failure drops just that profile; write-only BYO key (`api_key_set` bool readback). `credentials/profiles.rs`, `tauriCommands/composio.ts:34-37`.
8. **Config-driven extensibility** — declarative `toolkitRequiredFields.ts:69-99` (one frozen-object entry per provider; field `key` forwarded verbatim as the OAuth `extra_params` key) + 612 self-healing recovery for unknown fields.
9. **LLM triage gate on inbound events** — drop/acknowledge/react/escalate on a cheap tier (`triggers.md:72-108`) — budget-shaping for noisy push sources.

### Odysseus
1. **Two-way CalDAV writeback with stable-UID round-trip** — local `uid` == VEVENT UID; push under that same UID (`caldav_writeback.py:104-121` `event_by_uid`→`save`); pull upserts by UID (`caldav_sync.py:121-124`). Write→pull-back is idempotent **with no "I-wrote-this" marker** — duplication is structurally impossible.
2. **Remote-URL-by-hash addressing** — local calendar id = `"caldav-"+sha256(remote_url)[:24]`; writeback re-discovers the remote by re-hashing discovered calendars (`caldav_sync.py:89-93`, `caldav_writeback.py:79-87`). The remote URL never needs storing, yet the mapping is stable.
3. **DNS-resolving SSRF egress guard, re-checked at delivery** — `webhook_manager.py:80-108` resolves all A/AAAA, rejects any private/loopback/link-local/metadata, unwraps IPv4-mapped-IPv6, disables redirects, **re-validates at send time** against DB tampering, and **sanitizes error strings** before persisting. Materially stronger than validate-once.
4. **Scheduler robustness** — `Semaphore(1)` hard single-flight; startup zombie-run reaping; overdue-`next_run` advance; advance-on-failure (a broken task can't busy-loop the tick). `task_scheduler.py:357-402, 884-928`. Cross-task single-flight TTL cache (`_cached`) shares one upstream fetch across jobs firing the same minute.
5. **IMAP-as-source-of-truth** — never mirrors mail; stores only AI-derived caches keyed by `Message-ID`. Zero sync-state to corrupt, no UIDVALIDITY headaches. A deliberate privacy/simplicity trade (also its biggest limitation — §7).
6. **Versioned parse cache** — `THREAD_PARSER_VERSION` wraps cached turns; bump to invalidate all caches on a parser change.
7. **2FA on a self-hosted tool** — TOTP + 8 single-use backup codes (`THREAT_MODEL.md:39`).

---

## 4. Where Mycelium is behind / ahead

**Behind:**
- **Edits don't propagate.** `INSERT OR IGNORE` on a stable id no-ops a re-sync, so an edited Gmail/Linear item never updates; a content-hash-id source (Obsidian memory) instead *duplicates* on edit. OpenHuman's content-in-hash + UPSERT fixes both.
- **No per-connection error/health surface.** We have a status object; neither a durable audit trail nor per-connector last-error/last-success. (OpenHuman has both — and even *it* punts per-provider error attribution, so this is genuinely hard.)
- **No connection-level governance** beyond `MAX_ITEMS_PER_SYNC` (a per-pass cap, not a daily budget).
- **No multi-account, no two-way, no push.**
- **Coarse cadence** — fixed 5-min poll for all connectors; no adaptive backoff on quiet sources.
- **State overloaded onto the secrets table** — no dedicated connections table to hang cursor/status/error/budget off.

**Ahead (keep these):**
- **On-device token custody** — strictly smaller trust set than OpenHuman's broker (no third-party or hosted backend holds your tokens). This is a core product value; do not trade it away.
- **Fail-closed crypto** — missing key → `REFUSE`. Odysseus is fail-*open* (silently blanks creds); OpenHuman has a plaintext dev backend footgun. Ours is the safest of the three.
- **AES-256-GCM** vs. Odysseus's AES-128 Fernet-key-beside-the-DB.
- **Single ingestion choke-point** (`captureMessage`) — simpler than OpenHuman's two-stage canonicalize pipeline while achieving the same "one shape into the store."
- **In-app OAuth** — we actually have local OAuth2+PKCE for integrations; OpenHuman only has it for OpenRouter (everything else is broker-hosted), Odysseus has none.

---

## 5. Prioritized adopt-list

Tagged by **value** (to our product) × **effort** (against current code) × fit with our **named deferrals**.

### Tier 1 — cheap, high-value, no new deps, no architecture change
1. **Content-aware upsert dedup** *(deferral-adjacent; ~½ day + sweep)*. Replace `INSERT OR IGNORE`-only with: keep the stable id, but on a content-hash mismatch **update** the row (and re-queue enrichment). Either OpenHuman's content-in-hash id, or an explicit `content_hash` column compared on upsert. Fixes "edits never propagate" for Gmail/Linear and "duplicate-on-edit" for Obsidian memories. *Files:* `src/ingest/capture.js`, `src/core/document-store.js` (already upserts on path — extend the pattern to memories).
2. **Cursor-not-advanced-on-failure + per-connection last_error/last_success** *(small)*. Already partly true; make it explicit and surface `last_error` so a 401'd connector is visibly broken, not silently "quiet." *Files:* `src/connectors/scheduler.js`, `store.js`.
3. **Per-connection sync audit log** *(small)*. Append items-fetched / created / deduped / duration / ok|err per run (OpenHuman's `sync_audit.jsonl` idea, but as rows). Foundation for a real health surface. Avoid OpenHuman's mistake of a *separate push-status store* — derive counts where possible.
4. **Adaptive poll** *(small)*. Head-unchanged early-stop (if the newest id since cursor is unchanged, skip) + widen interval on consecutive empty pulls. Cuts API load without touching the 5-min default.

### Tier 2 — moderate, directly realizes our named deferrals
5. **Dedicated `connections` table** *(our deferral; medium)*. One row per connection: `id, provider, account_label, status, cursor, last_sync_at, last_error, daily_count, created_at`. Moves state off the secrets table (secrets keeps *only* tokens). Unlocks 6–8 below. *Sweep-first-design required* (touches scheduler, store, ImportView).
6. **Multi-account** *(our deferral; medium)*. Key connections by `(provider, account)` not just `provider`. Trivial *after* (5). Mirror OpenHuman's `{provider}:{profile}` id scheme — and note OpenHuman itself never wired this for Composio, so we can leapfrog.
7. **Per-connection daily request/item budget** *(small, after 5)*. OpenHuman's `DEFAULT_DAILY_REQUEST_LIMIT=500` rolling per day — a real cost backstop during big backfills, beyond our per-pass `MAX_ITEMS_PER_SYNC`.
8. **Health surface in ImportView** *(small, after 3+5)*. Per-connection Active/Stale/Error from audit rows + `last_error`. (Do better than OpenHuman: actually attribute errors per provider — we have the connection row they lacked.)
9. **SSRF egress guard** *(small, but only when relevant)*. Adopt Odysseus's DNS-resolving guard **if/when** we add any outbound HTTP we don't fully control (webhooks-out, user-supplied endpoints, self-hosted CalDAV/IMAP). Not needed for fixed Gmail/Linear hosts today — but write it down so it's not forgotten when the surface appears.

### Tier 3 — larger / architectural (design before committing)
10. **Two-way writeback** *(large; only if we add editing of synced items)*. Odysseus's stable-UID round-trip is the reference design. Out of scope until there's a product reason to edit synced data.
11. **LLM triage gate** *(medium; only valuable once a source is high-volume + noisy, e.g. email)*. drop/ack/react/escalate before ingest. Premature for Gmail/Linear pulls today.
12. **Near-real-time freshness** *(see §6 — this is NOT "adopt webhooks")*.

### Explicitly **reject**
- **OAuth/connector broker (Composio model).** Contradicts local-first on-device custody — it would move every integration token into a third party + a hosted backend. Our biggest *advantage* over OpenHuman is precisely that we don't do this. Keep in-app OAuth.
- **Fail-open secrets** (Odysseus). We are correctly fail-closed; do not regress.
- **Key-beside-data / no-KDF** (Odysseus). We already do better.

---

## 6. The webhook reframe (important)

Our handoff lists "webhooks/push" as a deferral, implying it's a feature we can later "add." The benchmark shows that's mis-framed for a local-first app:

- **OpenHuman gets push only because it has a cloud backend** that (a) is the public webhook endpoint providers POST to, (b) HMAC-verifies, and (c) forwards over an authenticated socket to the desktop app. The laptop never exposes a port and never sees a raw webhook (`triggers.md:68-69`, `event_handlers.rs:137-161`). Switch OpenHuman to "direct mode" (user's own Composio key, no OpenHuman backend) and **real-time stops entirely** — only polling remains (`periodic.rs:18-25`).
- **Odysseus's "webhooks" are not connector ingress** — outbound notifications (`webhook_manager.py`) + inbound *task triggers* (token-in-URL). Its actual connectors (IMAP/CalDAV) are **poll-only**, and CalDAV doesn't even run on a timer (page-load triggered).

So for Mycelium (no hosted relay, no public ingress) the honest options for "fresher than 5 min" are:
1. **Tighter adaptive polling** *(recommended)* — what OpenHuman *also* does (its tick is 20 min!). Cheap, on-device, no new trust. This is the realistic near-term answer.
2. **Provider-native push that needs a public endpoint** (Gmail `watch`→Pub/Sub, etc.) — requires a cloud component or a tunnel. Breaks local-first.
3. **A hosted relay of our own** — same trust cost as the broker model we reject.

**Recommendation:** retire "add webhooks" as a connector goal for the local-first build; replace it with "adaptive polling + manual 'sync now'." Revisit push only if/when a hosted companion service is ever on the roadmap.

---

## 7. Anti-patterns observed (avoid)

- **Orphaned governance UI** (OpenHuman): `SyncConfirmDialog` + `max_cost_per_sync_usd` are unwired for Composio (`readers/composio.rs:93-95`; no importer). The app *looks* like it gates sync on cost but doesn't. → If we add a budget UI, wire it to a real enforcement site or don't ship it.
- **Action-side non-idempotency** (OpenHuman): re-delivered triggers re-run LLM triage/actions (the content-hash protects *memory*, not *actions*). → If we ever act on synced items, dedupe on the **action** side too.
- **Health = liveness, not failure** (OpenHuman): a connector 401'ing for hours shows "Stale," indistinguishable from "quiet" (`design.md:14-16`). → Track `last_error` explicitly.
- **Unbounded dedup set** (OpenHuman): `synced_ids` grows forever in one JSON blob. → If we adopt an optimistic set, bound/evict it (we may not need it — our cursor + upsert may suffice).
- **Docstrings that claim a scheduler that doesn't exist** (Odysseus CalDAV): three comments say "periodic loop"; the only caller is page-load (`calendar.js:194-196`). → Keep our docs honest about cadence.
- **Fail-open decryption** (Odysseus): corrupt/rotated key silently blanks every credential. → Stay fail-closed.
- **SSRF guard asymmetry** (Odysseus): webhooks get DNS-rebinding defense, CalDAV doesn't. → Apply egress hardening uniformly across *all* outbound paths.
- **Inbound token-in-URL + wrong CLI URL** (Odysseus): unauthenticated `…/webhook/<token>` with no signature, and the CLI prints the wrong path. → If we add inbound triggers, sign them and keep the token out of the URL/logs.

---

## 8. Recommended sequencing

1. **Now (Tier 1, one small PR each, sweep-first):**
   - (1) content-aware upsert dedup — highest correctness payoff, smallest blast radius.
   - (2)+(3) `last_error`/`last_success` + per-connection audit rows.
   - (4) adaptive poll (head-unchanged early-stop).
2. **Next (Tier 2, one design doc covering the cluster):**
   - (5) dedicated `connections` table → then (6) multi-account, (7) daily budget, (8) health surface fall out cheaply. *Run `/sweep-first-design` first* — this touches `scheduler.js`, `store.js`, `crypto-local.js` (new `ENCRYPTED_FIELDS`?), `ImportView.svelte`, and needs a `verify:connections` script.
3. **Document the reframe (no code):** update the handoff/design to retire "webhooks" → "adaptive polling + sync-now" for the local-first build (§6).
4. **Defer (Tier 3):** writeback, LLM triage, any push — revisit only on a concrete product trigger.

**Per-change discipline (unchanged):** `/sweep-first-design` → design doc with verification table → build → full `npm run verify` GO (capture real exit, no `| tail`) → isolated `:8796` preview → GitHub PR (no direct main push). Encryption stays AES-256-GCM + fail-closed; tokens stay in the encrypted secrets table; on-device custody is non-negotiable.

---

### Appendix — repos & how to re-read
- Clones used: `/tmp/openhuman` (`87a91ae`), `/tmp/odysseus` (`68eeb78`).
- OpenHuman entry points: `app/src/lib/composio/*`, `app/src-tauri/src/loopback_oauth.rs`, `src/openhuman/memory_sync/composio/{periodic,bus}.rs` + `providers/{sync_state,gmail}.rs`, `src/openhuman/memory_store/chunks/{types,store}.rs`, `src/openhuman/credentials/profiles.rs`, `gitbooks/features/integrations/triggers.md`.
- Odysseus entry points: `src/{secret_storage,task_scheduler,caldav_sync,caldav_writeback,webhook_manager,integrations}.py`, `routes/{email_pollers,email_helpers,calendar_routes,webhook_routes}.py`, `core/database.py`, `THREAT_MODEL.md`.
