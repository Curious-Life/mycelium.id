# Mycelium Launch Readiness Audit

**Date:** 2026-04-07
**Scope:** Full codebase review — every handler, migration, script, portal page, worker endpoint, security surface
**Method:** 7 parallel deep-dive agents covering structure, onboarding, mindscape, social, modules, security, and worker API

---

## Executive Summary

Mycelium is a sophisticated, production-grade multi-agent framework with strong security fundamentals (Swiss Vault encryption, tmpfs master key, per-agent scope enforcement, CSRF/CSP/CORS hardening, AppArmor). The codebase is large (~434KB agent-server.js, 130 migrations, 55+ worker endpoints, 11 agents) and mostly well-architected.

**Launch blockers:** 6 issues that will cause a broken first-run experience or security exposure
**High priority:** 14 issues that degrade UX or leave security gaps
**Medium priority:** 12 issues for post-launch polish
**Low priority:** 8 backlog items

---

## 1. ONBOARDING FLOW

**What exists:** `ConnectionsChecklist` component on the mindscape page (shown when empty). 4 steps: Connect AI, Import Data, Connect Telegram, Connect Discord. Full provisioning pipeline via `provision-customer.sh` (17 steps: DNS, SSL, nginx, master key, agent tokens, portal build, PM2, passkey URL). Provisioning daemon polls D1 for pending jobs.

**What's missing:**

| # | Gap | Severity | Details |
|---|-----|----------|---------|
| 1.1 | **No guided first-run experience** | LAUNCH BLOCKER | After passkey login, user lands on empty mindscape with a checklist. No welcome tour, no explanation of what Mycelium is or does. The "Welcome to your vault" text is on the login page only. |
| 1.2 | **No post-import feedback loop** | LAUNCH BLOCKER | User imports data, but nothing tells them "your mindscape is being generated" or how long to wait. They see "Activate your mindscape" indefinitely until the 2am clustering cron runs. |
| 1.3 | **Import checklist lists unsupported formats** | HIGH | The checklist shows WhatsApp, Email (MBOX), Telegram JSON, PDFs — but the actual import page only supports Claude, ChatGPT, Obsidian, LinkedIn. Misleading. |
| 1.4 | **No onboarding completion tracking** | MEDIUM | No server-side tracking of which steps the user completed. Checklist state is `localStorage` — resets on new device/browser. |
| 1.5 | **Claude OAuth requires manual code paste** | LOW | OAuth flow opens browser, user copies code, pastes back. Works but feels unpolished vs redirect callback. |
| 1.6 | **No email verification** | MEDIUM | Passkey registration doesn't require email verification. No way to recover access if passkey is lost (no email-based reset). |

---

## 2. DATA UPLOADS & IMPORT

**What exists:** Portal import page with drag-and-drop. 4 working sources: Claude (MYA logs), ChatGPT (conversations.json), Obsidian (vault ZIP), LinkedIn (archive ZIP with messages.csv + Connections.csv). Client-side pre-processing strips media from large files (>90MB). LinkedIn import includes contact dedup (pre-loaded name index to work around encryption breaking SQL ON CONFLICT), noise filtering, engagement tier classification.

**What's missing:**

| # | Gap | Severity | Details |
|---|-----|----------|---------|
| 2.1 | **No upload progress indicator** | HIGH | Large files upload with no visible progress. Multer has 50MB limit but no streaming progress to client. |
| 2.2 | **No import status/history page** | MEDIUM | No way to see what was previously imported, when, or if it succeeded. Risk of duplicate imports. |
| 2.3 | **WhatsApp, Telegram, Email, PDF imports not implemented** | HIGH | Listed in onboarding checklist but no parser exists. Only 4 sources work. |
| 2.4 | **Google Drive import not wired** | MEDIUM | `lib/services/drive-plugin.js` exists with list/read/create methods but isn't connected to the portal import flow. |
| 2.5 | **Post-import enrichment is invisible** | HIGH | After import, enrichment daemon runs in background. No UI shows "Embedding your data... 342/1200 messages processed." The enrichment status endpoint exists but isn't exposed in the portal. |
| 2.6 | **No import dedup across runs** | MEDIUM | No tracking of previously imported source files. Re-uploading the same LinkedIn ZIP creates duplicates (dedup only works within a single import run via name index). |

---

## 3. MINDSCAPE GENERATION & PROGRESS

**What exists:** Sophisticated pipeline: sync-clustering-points -> Nomic 256D ONNX embeddings -> FAISS k-NN graph -> multi-resolution Leiden (atoms/territories/themes/realms) -> noise detection (liminal territories) -> UMAP 3D -> Jaccard stabilization -> dynamics (energy/vitality/velocity) -> growth events -> territory chronicles (incremental via cursor). Runs daily at 2am via PM2 cron.

Portal has 3 views: 3D Map (Three.js), Territories (realm/territory cards with sparklines, badges, chronicles), Growth Timeline (cluster events with icons).

**What's missing:**

| # | Gap | Severity | Details |
|---|-----|----------|---------|
| 3.1 | **No manual trigger from portal** | LAUNCH BLOCKER | Users can't generate their mindscape on demand. After importing data, they must wait until 2am. First impression is a blank page. |
| 3.2 | **No progress tracking during generation** | LAUNCH BLOCKER | Pipeline takes 5-30 minutes (10 stages). No WebSocket/SSE/polling to show progress. User sees blank page. |
| 3.3 | **No "generating" state in UI** | HIGH | Mindscape page shows either data or onboarding prompt. No intermediate "Your mindscape is being generated..." state with progress bar. |
| 3.4 | **Growth timeline not user-friendly** | LOW | Shows raw data (cluster IDs, Jaccard scores). Non-technical users won't understand "Jaccard: 0.73". |
| 3.5 | **No single-territory chronicle regeneration** | MEDIUM | Chronicles only regenerate as part of full clustering pipeline. Can't fix a bad chronicle for one territory without running the whole thing. |

**Recommendation:** Add `POST /portal/mindscape/generate` that triggers `run-clustering.sh` via child_process, creates a job ID. Add `GET /portal/mindscape/generate/status/:jobId` that reads progress (each pipeline stage writes to a progress file). Portal polls this endpoint. Show a progress stepper in the UI.

---

## 4. TERRITORY CHRONICLES

**What exists:** Two scripts: `describe-territories.js` (batch, identifies which territories need description based on growth events) and `describe-chronicles.js` (per-territory, incremental via `chronicle_cursor`, evolves previous chronicles). Both use Claude via Mya's `/think` endpoint. Haiku by default for cost efficiency. Step 3 of `run-clustering.sh`.

**What's missing:**

| # | Gap | Severity | Details |
|---|-----|----------|---------|
| 4.1 | **No manual trigger** | HIGH | Chronicles only run as part of clustering pipeline. |
| 4.2 | **No progress visibility** | HIGH | Chronicle generation makes ~300 Claude calls. No progress UI. |
| 4.3 | **Chronicle display verification needed** | MEDIUM | Territory detail panel shows `chronicle` field but need to verify `/portal/mindscape/territories` endpoint returns chronicles consistently and they render correctly. |

---

## 5. SOCIAL CONNECTIONS & SHARING

**What exists:** Full connection system: request/accept/reject/block flow. Connection overlap computation (shared territories, match shape). 4 sharing contexts (Work Self, Social Self, Creative Self, Private Self). Federation via WebFinger + Noise KK mutual auth. Contact import from LinkedIn with 5 engagement tiers (inner/engaged/acknowledged/connected/noise). Territory linking via Nomic 256D cosine similarity to centroids.

Portal: Connections page with connection list, pending requests, search by handle. ConnectionsChecklist guides setup.

**What's missing:**

| # | Gap | Severity | Details |
|---|-----|----------|---------|
| 5.1 | **No invitation system** | HIGH | Users can only connect by handle. No way to invite someone who isn't on Mycelium (no email invite link, no shareable profile URL). |
| 5.2 | **No shareable public profile page** | MEDIUM | `/api/public-profile/:handle` endpoint exists but no portal page showing your public profile or "share my profile" button. Discovery endpoints exist but aren't surfaced. |
| 5.3 | **Sharing contexts UI incomplete** | MEDIUM | The contexts page exists at `/contexts` but the connections page doesn't show which contexts are shared with which connection. |
| 5.4 | **No real-time notifications for requests** | MEDIUM | Pending requests only visible when visiting `/connections`. No bell icon, badge, or push notification. |
| 5.5 | **Federation untested at scale** | LOW | WebFinger + remote connection flow built but likely fragile (unreachable domains, timeouts, error handling). |
| 5.6 | **Connection overlap requires both users to have mindscapes** | MEDIUM | If either user hasn't run clustering yet, overlap computation fails silently. |

---

## 6. MODULES SYSTEM

**What exists:** Portal modules page with toggle cards. Categories: Core (Chat, Search, Library — always on), Intelligence (Mindscape, Activity, Timeline, Intel), Social (Connections, Import), Financial (Wealth), Integration (Agents, Telegram, Discord). Toggles are client-side `localStorage` only — show/hide sidebar items.

**What's missing:**

| # | Gap | Severity | Details |
|---|-----|----------|---------|
| 6.1 | **Module toggles are client-side only** | MEDIUM | No server-side enforcement. Toggling Wealth off hides the sidebar link but all 10 `/portal/wealth/*` endpoints remain active and accessible. |
| 6.2 | **No per-tenant module configuration** | MEDIUM | All tenants get all modules. No DB table for `tenant_modules`. Can't restrict modules by subscription tier. |
| 6.3 | **Health module is "coming soon"** | HIGH | Apple Health data already flows via body state (sleep, HRV, RHR, steps, trends) and context assembly reads it. No dedicated portal page to visualize it. |
| 6.4 | **No inner development module** | HIGH | `compute-cognitive-fingerprint.js` exists (depth/breadth/coherence/exploration scores), `cycle_metrics` service in worker, `vessel-practice.md` mind file — but no portal page. Rich data with no UI. |
| 6.5 | **No screen time module** | MEDIUM | Not implemented. Activity page tracks message volume and agent interactions, not screen time or app usage. Would need data source (Apple Screen Time API or manual). |
| 6.6 | **Wealth module needs portfolio setup wizard** | MEDIUM | New user landing on wealth page with no portfolios gets no guidance. |
| 6.7 | **Publishing module stub** | LOW | Listed as "coming soon" with Noa agent already running. No portal page. |

---

## 7. INTEGRATIONS

| Integration | Status | Details |
|-------------|--------|---------|
| Claude OAuth | **Working** | Code-paste flow, subscription type check |
| Anthropic API key | **Working** | Encrypted secret storage |
| OpenAI import | **Working** | ChatGPT export parser (import only, no live API) |
| Telegram bot | **Working** | Grammy framework, voice transcription, file handling |
| Discord bot | **Working** | Per-agent bots, orchestrator routing, multi-server |
| Stripe billing | **Working** | Checkout, subscriptions, billing portal |
| CoinGate crypto | **Working** | Bitcoin/crypto payments |
| Google Drive | **Partial** | `drive-plugin.js` exists, not wired to portal UI |
| Google Calendar | **Partial** | `calendar-plugin.js` exists, not wired to portal UI |
| Gmail | **Partial** | `gmail-plugin.js` exists, not wired to portal UI |
| Cloudflare Stream | **Working** | Video upload/playback |
| OwnTracks location | **Working** | GPS receiver, used in context assembly |
| Linear | **Working** | MCP tools for issue management |
| Polymarket | **Working** | 6 proxy endpoints for prediction markets |

**What's missing:**

| # | Gap | Severity | Details |
|---|-----|----------|---------|
| 7.1 | **Google integrations not in portal** | HIGH | Drive/Calendar/Gmail plugins exist in `lib/services/` but no OAuth flow exposed to portal users. No configuration UI. `google-auth-setup.js` is CLI-only. |
| 7.2 | **No "test connection" buttons** | MEDIUM | After saving Telegram/Discord tokens, no way to verify the token works without checking PM2 logs. |
| 7.3 | **No integration management page** | MEDIUM | Integrations scattered across ConnectionsChecklist and Settings. Need dedicated page showing all services, status, disconnect option. |
| 7.4 | **Telegram is single-user** | LOW | `TELEGRAM_CHAT_ID` whitelists one chat. No multi-user Telegram support. |
| 7.5 | **Discord bots are 11 separate processes** | LOW | Resource-heavy on small VPS. Could consolidate into single bot with agent routing. |

---

## 8. SECURITY AUDIT

### 8.1 Authentication & Authorization

**Passkey auth (WebAuthn):** Solid implementation via `@simplewebauthn/server`. Registration + authentication flows. Session tokens in HTTP-only, Secure, SameSite=Strict cookies. 24h expiry.

**Agent tokens:** Per-agent Ed25519 tokens validated against `AGENT_REGISTRY` Wrangler secret. Each agent gets unique token preventing impersonation.

**CORS:** Strict origin allowlist in both worker and agent-server. No wildcards. Fail-closed.

**CSRF:** Double-submit cookie pattern on all POST/PUT/DELETE. Applied globally via middleware.

**CSP:** Full Content-Security-Policy on portal (no external script-src). CDN deps bundled locally.

| # | Finding | Severity | Details |
|---|---------|----------|---------|
| S1 | **Session tokens not hashed in D1** | HIGH | Plaintext tokens in `sessions` table. D1 breach = all active sessions compromised. Store SHA-256(token), compare hashes. |
| S2 | **No session cleanup cron** | MEDIUM | Expired sessions accumulate in D1. No `DELETE FROM sessions WHERE expires_at < NOW()` job. |
| S3 | **No concurrent session limit** | MEDIUM | Unlimited active sessions per user. No "log out all devices" feature. |
| S4 | **Timing-safe comparison for ADMIN_SECRET** | FIXED | `safeCompare()` function exists at agent-server.js:104 using `crypto.timingSafeEqual()`. Already addressed. |

### 8.2 Encryption

**Master key:** AES-256-GCM via Node.js webcrypto. Key in tmpfs (`/run/mycelium/master.key`), never on disk, never transmitted. `clearMasterKeyFromEnv()` clears env after import.

**Scope enforcement:** `AGENT_SCOPES` env var per agent. `ScopeViolationError` thrown at crypto layer. `decrypt()` has `allowedScopes` parameter that's checked before decryption.

**Per-user keys:** Envelope v2 with `userId` field. HKDF derivation per scope+user.

| # | Finding | Severity | Details |
|---|---------|----------|---------|
| S5 | **FTS5 broken for encrypted content** | HIGH | FTS5 triggers re-index ciphertext. Full-text search returns nothing for encrypted rows. Semantic search (Vectorize) works. Users need to know text search is semantic-only. |
| S6 | **Tags/entities stored unencrypted** | MEDIUM | `tags` and `entities` columns in messages are plaintext JSON. NLP metadata reveals content topics even without decrypting message body. |
| S7 | **Enrichment sends plaintext to Workers AI** | MEDIUM | Enrichment daemon decrypts locally then sends plaintext to CF Workers AI for tagging/embedding. CF sees content during enrichment. Local Qwen2.5 + BGE-M3 (planned) would close this. |
| S8 | **No automated key rotation** | HIGH | Master key, agent tokens, and session signing keys have no automated rotation. Manual rotation requires full re-encryption. No rotation schedule documented. |

### 8.3 API Security

**Rate limiting:** Per-IP, sliding window, D1-backed. Auth: 10/min, Default: 100/min, Search: 60/min, AI: 3000/hr, Upload: 30/min, DB proxy: 300/min.

**SQL safety:** All queries parameterized. Worker rejects unfiltered queries on user-data tables (403).

**Input validation:** Inconsistent — some endpoints use Zod schemas, others do manual checks, some rely on D1 error handling.

| # | Finding | Severity | Details |
|---|---------|----------|---------|
| S9 | **Error responses leak internal details** | HIGH | ~100+ instances of `err.message` returned directly to clients in agent-server.js. Stack traces, internal paths, DB errors could be exposed. Replace with generic "Internal server error" messages; log full errors server-side. |
| S10 | **No WebSocket message size limit** | MEDIUM | Agent-server WS handler doesn't enforce max message size. Large frames could exhaust server memory. Cap at 1MB. |
| S11 | **Decrypted content in PM2 logs** | HIGH | Enrichment daemon and agent-server log decrypted message content during processing. PM2 captures to `/var/log/mycelium/`. Plaintext on disk defeats encryption purpose. |
| S12 | **Rate limit counters in D1** | MEDIUM | D1 queries for every rate limit check adds latency. Under burst traffic, D1 itself becomes bottleneck. KV would be faster. |
| S13 | **Health endpoint at `/routes/health.js`** | MEDIUM | The separate health router returns full operational details (model, features, timeouts, agent card) without authentication. The main `/health` in agent-server.js correctly gates detailed info behind auth, but the router-mounted one doesn't. |

### 8.4 Secret Management

**Bootstrap flow:** Agent starts -> fetches encrypted secrets from D1 -> decrypts locally with master key -> populates `process.env`. 5-min refresh. Worker never sees plaintext.

**Wrangler secrets:** Properly managed via `wrangler secret put`. No secrets in `wrangler.toml`.

| # | Finding | Severity | Details |
|---|---------|----------|---------|
| S14 | **No key material zeroing after import** | LOW | Raw key bytes from file read are garbage collected, not explicitly zeroed. CryptoKey objects persist for process lifetime. |
| S15 | **Agent token rotation requires manual multi-step** | MEDIUM | Rotation requires: update AGENT_REGISTRY secret + update all .env files + PM2 delete + restart (not just restart due to env caching). No automated script. |

### 8.5 Infrastructure

- Processes run as `deploy` user (not root)
- AppArmor profiles for agent + orchestrator
- SSH on non-standard port
- Only 80/443 open externally
- Agent ports bound to localhost
- Sentry: `sendDefaultPii: false`, auth headers stripped

---

## 9. WORKER API COMPLETENESS

**55+ endpoints** across health, auth, DB proxy, messages, documents, search, embeddings, AI, secrets, uploads, video, imports, federation, links, commands, payments, provisioning, scheduled tasks.

**Auth coverage:** All sensitive endpoints require auth (agent token, admin, or session).

**Key gaps:**

| # | Gap | Severity | Details |
|---|-----|----------|---------|
| W1 | **DB proxy accepts arbitrary SQL** | MEDIUM | Mitigated by user filter enforcement, but proxy accepts any SQL string. A compromised agent could craft queries the filter rules don't catch. Consider query allowlisting for sensitive tables. |
| W2 | **Inconsistent input validation** | MEDIUM | Some handlers use Zod, others manual checks, some none. Standardize on Zod for all endpoints. |
| W3 | **No request body size limit at Worker level** | LOW | Relies on CF defaults (100MB). Should set explicit limits per endpoint. |
| W4 | **Import handlers trust file content** | LOW | After basic type checking, import parsers process file content without sandboxing. Malicious ZIP/CSV could exploit parser bugs. |

---

## 10. PORTAL COMPLETENESS

| Page | Status | Notes |
|------|--------|-------|
| `/login` | **Complete** | Passkey auth, clean UI |
| `/chat` | **Complete** | Chat with any agent, streaming, context |
| `/search` | **Complete** | Hybrid search (semantic + FTS) |
| `/library` | **Complete** | Document management |
| `/mindscape` | **Mostly complete** | 3 views working. Missing: generate trigger, progress. |
| `/activity` | **Complete** | Message volume, agent interactions |
| `/timeline` | **Complete** | Chronological view |
| `/intel` | **Complete** | 6 tabs, Leaflet map, Polymarket proxy |
| `/connections` | **Mostly complete** | Missing: invitations, notifications |
| `/import` | **Mostly complete** | 4 sources working. Missing: progress, history |
| `/wealth` | **Complete** | Full portfolio UI |
| `/modules` | **Complete** | Toggle cards (client-side only) |
| `/settings` | **Mostly complete** | Missing: Google OAuth UI |
| `/profile` | **Basic** | Needs work for public-facing profile |
| `/contexts` | **Basic** | Sharing contexts defined but not fully wired to connections |
| `/agents` | **Complete** | Agent dashboard |
| `/media` | **Basic** | Gallery view for uploaded media |

---

## PRIORITIZED ACTION PLAN

### Phase 0 — Launch Blockers (This Week)

| # | Action | Files | Effort |
|---|--------|-------|--------|
| **P0-1** | **Add "Generate Mindscape" button** — `POST /portal/mindscape/generate` triggers `run-clustering.sh` via child_process, creates job ID. `GET /portal/mindscape/generate/status/:jobId` reads progress. Portal shows progress stepper. | `agent-server.js`, `portal/src/routes/(app)/mindscape/+page.svelte` | 1 day |
| **P0-2** | **Add enrichment progress UI** — Wire existing enrichment stats into mindscape page as "Preparing your data... X/Y messages enriched." Show between import and mindscape generation. | `agent-server.js` (add endpoint), `portal/src/routes/(app)/mindscape/+page.svelte` | 0.5 day |
| **P0-3** | **Fix import checklist** — Remove WhatsApp/Email/Telegram/PDF from checklist. Only show what works (Claude, ChatGPT, Obsidian, LinkedIn). | `portal/src/lib/components/ConnectionsChecklist.svelte` | 0.5 day |
| **P0-4** | **Add "generating" state to mindscape UI** — Intermediate state between empty/onboarding and data display. Show progress during generation. | `portal/src/routes/(app)/mindscape/+page.svelte` | 0.5 day |
| **P0-5** | **Sanitize error responses** — Replace all `err.message` / `error.message` in HTTP responses with generic messages. Log full errors server-side only. | `agent-server.js` | 1 day |
| **P0-6** | **Fix health endpoint auth** — Ensure the router-mounted `/health` also gates detailed info behind auth (match the pattern in the main `/health` handler). | `routes/health.js` | 0.5 day |

### Phase 1 — Polish (Week 2-3)

| # | Action | Effort |
|---|--------|--------|
| **P1-1** | **Welcome tour / first-run experience** — 3-step guided tour after first login explaining Mycelium's concept, what to expect, what to do first. | 2 days |
| **P1-2** | **Upload progress indicator** — Stream upload progress or show determinate bar. | 1 day |
| **P1-3** | **Hash session tokens in D1** — Store SHA-256(token), compare hashes on auth. | 0.5 day |
| **P1-4** | **Redact decrypted content from PM2 logs** — Add log sanitization in enrichment daemon and agent-server. | 1 day |
| **P1-5** | **Connection invitation by email/link** — Generate invite links for non-Mycelium users. | 2 days |
| **P1-6** | **Integration test connection buttons** — Verify Telegram/Discord tokens work from Settings. | 1 day |
| **P1-7** | **Bundle any remaining external CDN scripts** — Verify all deps are local. | 0.5 day |
| **P1-8** | **Wire audit logging** — Insert events for auth, secret access, data export into `audit_log` table. | 1 day |
| **P1-9** | **Session cleanup cron** — Add to ecosystem.config.cjs: delete expired sessions daily. | 0.5 day |
| **P1-10** | **WebSocket message size limit** — Cap at 1MB per frame. | 0.5 day |
| **P1-11** | **Document FTS5 limitation** — Add clear note in portal that search is semantic. Or rebuild FTS5 pipeline to index decrypted content (security tradeoff — document the decision). | 0.5 day |

### Phase 2 — Feature Completeness (Week 3-4)

| # | Action | Effort |
|---|--------|--------|
| **P2-1** | **Health module portal page** — Apple Health data already flowing. Build page with sleep, HRV, activity charts, trends. | 3 days |
| **P2-2** | **Inner Development module** — Portal page for cognitive fingerprint (4 scores), cycle metrics, vessel practice log. Rich data already exists. | 2 days |
| **P2-3** | **Google Drive/Calendar integration in portal** — OAuth flow + configuration UI in Settings. | 3 days |
| **P2-4** | **Public profile page** — Shareable link showing public territories/signature/cognitive fingerprint. | 2 days |
| **P2-5** | **Import history page** — Show past imports with dates, counts, sources, dedup tracking. | 1 day |
| **P2-6** | **Chronicle manual trigger** — Regenerate a single territory's chronicle from portal. | 1 day |
| **P2-7** | **Per-tenant module configuration** — DB table for enabled modules per tenant/subscription tier. | 2 days |
| **P2-8** | **Standardize input validation** — Zod schemas for all worker endpoints. | 2 days |

### Phase 3 — Hardening (Ongoing)

| # | Action | Effort |
|---|--------|--------|
| **P3-1** | Execute first key rotation (agent tokens + document procedure) | 1 day |
| **P3-2** | Encrypt tags/entities columns (or document as accepted risk) | 1 day |
| **P3-3** | Deploy local enrichment (Qwen2.5 + BGE-M3) to eliminate Workers AI plaintext exposure | 3 days |
| **P3-4** | Migrate rate limiting from D1 to KV | 1 day |
| **P3-5** | Federation stress testing | 2 days |
| **P3-6** | External penetration test | External |
| **P3-7** | WhatsApp/Email/Telegram import parsers | 3 days |
| **P3-8** | Screen time module (needs data source decision) | TBD |

---

## Appendix A: Port Map

| Agent | Server Port | Discord Bot Port |
|-------|-------------|------------------|
| Orchestrator | 3000/3001 | — |
| Company (Com) | 3002 | 3001 |
| Personal (Mya) | 3004 | 5009 |
| Telegram | 3003 | — |
| Research (Ada) | 5002 | 5003 |
| Commercial Intel (Rex) | 5004 | 5005 |
| Publishing (Noa) | 5006 | 5007 |
| QA | 5008 | — |
| Wealth (Rob) | 5010 | 5011 |
| Portal | 5173 | — |
| Enrichment service | 8095 | — |
| Llama server | 8090 | — |
| BGE-M3 embed | 8091 | — |
| War Room dashboard | 8050 | — |

## Appendix B: Worker Endpoint Count

- **Public (no auth):** 7 endpoints (health, public profile, discovery, auth)
- **Agent token auth:** ~35 endpoints (messages, documents, search, embed, enrich, secrets, upload, import, federation, links, commands)
- **Admin auth:** 5 endpoints (provisioning, table listing, bulk ops)
- **Session auth:** 3 endpoints (Stripe checkout/portal)
- **External signature:** 2 endpoints (Stripe/CoinGate webhooks)
- **Total:** ~55 endpoints

## Appendix C: Migration Count

130 migrations (001-111), covering: schema, security, clustering, analytics, features, encryption, social, wealth, federation, payments, audit.
