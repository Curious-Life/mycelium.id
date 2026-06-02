# Mycelium V1 — Pre-Launch Readiness & Test Map

**Date:** 2026-06-01 · **Updated:** 2026-06-02

> **Update 2026-06-02 — Phase G + C landed (merged to `main`, #28).** The biggest
> product gap from §0/§4 (the in-app **generate-mindscape trigger**) is now built +
> Tier-1 verified (`src/jobs.js` + `POST /api/v1/portal/mycelium/generate`), as is
> **chronicle narration** (`pipeline/describe-chronicles.js`). The **real** clustering
> + narration still need the host's ML stack / a model (Tier-2). Verify suite is now
> **28** (added `verify:generate`, `verify:chronicles`). A 3-sweep bug-hunt (2026-06-02)
> validated the code: the two "CRITICAL" findings were false positives; fixed a bounded
> job map + the SPA-fallback regex; **one real gap remains — profile *editing*** (`PUT
> /portal/profile`) isn't served (degrades gracefully to "Failed to save"; needs a
> small profile store). The journey/matrix rows below are annotated where this changes
> their status (look for "*(G/C done)*").

**Purpose:** one systematic place that answers "where are we, what's left, and what
needs testing before we launch and publish." Organized by **user journey** (start to
finish), then a full **functionality × status** matrix, a **test-coverage map**, and
a **prioritized punchlist**.

**Legend.** Status: ✅ built+verified (Tier-1, proven by a `verify:*` here) ·
◑ built, partial/unverified · ⚠️ built but **Tier-2-gated** (needs the ML host) ·
⬜ designed, not built · ❓ unknown / needs investigation.
Test: **V**=automated verify · **M**=needs manual/Mac check · **T2**=needs the ML
host · **F**=needs a real-world fixture (e.g. a real export) · **—**=no test yet.

---

## 0. TL;DR readiness verdict

**The product core is solid and verified; the *launch* (distribution, remote
deploy, the generate-mindscape trigger, onboarding polish) is the gap.**

- The vault, transports (MCP stdio + HTTP/OAuth + REST), tools, ingestion, the
  portal build-out, search, and publishing are **built and Tier-1-verified** (26
  `verify:*` suites, green in CI).
- The **mindscape generation** (clustering) and **embeddings** are built but
  **Tier-2-gated** and only runnable **manually via CLI** — there is no in-app
  trigger (Phase G) and no CI coverage of the clustering run.
- **Distribution does not exist yet**: the npm package is `private:true` (roadmap),
  the Tauri app is a scaffold (not bundled/signed), and there is **no remote-deploy
  story** (Cloudflare Tunnel is doc-only).
- A handful of **launch hygiene** items (funding placeholders, auth-secret
  persistence, a real-export import test) are small but must land before publish.

**Not launch-blocking by design (deferred to Phase 6 / V2):** messaging
connectors (Telegram/Discord/WhatsApp), browser extension, autonomous loop +
scheduler (D5), multi-user/Postgres/RLS, federation.

---

## 1. User journeys — start to finish

Each journey lists every step, its status, its test coverage, and the gap.

### Journey A — Operator: zero → running vault
The setup path for the person who owns the vault.

| Step | Status | Test | Gap / note |
|---|---|---|---|
| Install Node 22 + native build toolchain | ◑ | M | Manual; `better-sqlite3` needs xcode-select / build-essential. **No one-click installer.** |
| `git clone` + `npm install` | ✅ | M | Standard. |
| `npm run init-db` (apply migrations) | ✅ | V (`foundation`) | — |
| Generate + store master keys (`npm run set-keys` → Keychain) | ✅ | V (`keysource`) | Works on macOS; Linux/Windows = manual env vars. **No guided wizard.** |
| Boot (`npm run portal` / `npm start`) — vault unlocks at boot, fail-closed | ✅ | V (`foundation`,`keysource`) | — |
| `npm run verify` (self-check) | ✅ | V (all 26) | — |
| Connect Claude Desktop (edit `claude_desktop_config.json` by hand) | ◑ | M | **Manual JSON edit, error-prone.** No GUI helper. |
| Native Mac app (`.dmg`) instead of CLI | ⬜ | M | Tauri scaffold only; **Phase K** key ceremony unbuilt; not bundled/signed. |

**Journey verdict:** works for a developer; **too much friction for a non-technical
user.** Biggest gaps: an `install.sh`, a guided key/Claude-config step, the Mac app.

### Journey B — AI client (MCP): context & recall
The everyday "Claude has my memory" loop.

| Step | Status | Test | Gap |
|---|---|---|---|
| Local client connects over **stdio** | ✅ | V (`mcp`) | — |
| Remote/mobile connects over **Streamable HTTP + OAuth 2.1/PKCE** | ✅ | V (`oauth`) | Needs a public origin + TLS to actually use (see Journey G). |
| `getContext` preamble (preloaded mind state + flagged items) | ✅ | V (`context`) | — |
| Core tools: capture/import, documents+mind-files, messages, tasks, health, metrics | ✅ | V (`mcp`,`mindfiles`,`metrics`) | — |
| Search recall: `searchMindscape` (BM25 + vector + RRF) | ✅ / ⚠️ | V (`search`) | BM25 verified; **real vector recall is Tier-2** (needs `:8091` embeddings). |
| Topology tools: `listTerritories`, `territoryDetail`, `exploreTerritory`, … | ✅ | V (`topology`) | Returns data only once a mindscape exists (Journey D). |
| Fisher/trajectory tools (4) | ◑ | — | **No direct verify** (only indirect via `mcp` boot). |
| Real Claude Desktop end-to-end (the success-criterion demo) | ❓ | M | Never run against a live client in this env — **needs a Mac smoke test.** |

### Journey C — Ingest: get data in
| Step | Status | Test | Gap |
|---|---|---|---|
| Single capture / bulk `importMessages` (MCP/REST) | ✅ | V (`ingest`) | — |
| Raw file upload `/api/v1/upload` → encrypted blob | ✅ | V (`blob`) | — |
| **Portal import**: Claude/ChatGPT `.zip` (single-shot + chunked) → parse → encrypted, deduped | ✅ | V (`import`) | Parsers written fresh — **need a REAL export to confirm fidelity (F).** |
| Drag-and-drop a file onto Import (vs. click-to-browse) | ✅ | V (`nav` N8) | Drop zone added 2026-06-01. |
| **Parser parity with canonical** | ◑ | — | **GAP:** the canonical `@mycelium/core/import-parsers.js` was never vendored into `reference/`. Our Claude/ChatGPT parsers extract **messages/conversations only** — NOT the projects/memories/artifacts (Claude) or feedback/media/shared (ChatGPT) the UI's result panel advertises, and **Obsidian/LinkedIn are detection-only stubs**. Full parity = port from the **sibling canonical repo** (`Curious-Life/mycelium`, not in this snapshot). |
| Import surface hardened (bomb/DoS/zip-slip/leakage) | ✅ | V (`import-security`) | — |
| Enrichment hand-off (embed + NLP state machine) | ✅ / ⚠️ | V (`enqueue`,`enrich`) | Hand-off verified; **real embedding is Tier-2** (`:8091`). |

### Journey D — Topology: generate & explore the mindscape
**The signature feature — and the least launch-ready path.**

| Step | Status | Test | Gap |
|---|---|---|---|
| Embeddings written (Nomic 768-d via `:8091`) | ⚠️ | T2 (`embed` attempts) | Needs `pipeline/setup.sh` + onnxruntime + the ~170MB model. |
| Clustering pipeline (sync → cluster → describe → cofire → harmonics) | ⚠️ | **— (T2)** | Built (`pipeline/*`) but **runnable only via `run-clustering.sh` (manual CLI)**; needs FAISS/Leiden/igraph/sklearn + (describe) a model. **No CI verify of clustering.** |
| **In-app "Generate mindscape" trigger** | ⬜ | — | **Phase G unbuilt** — no `/mindscape/generate` job endpoint; the portal button 404s (degrades gracefully). |
| Mindscape **read** (3D scene + realms/territories/points) | ✅ | V (`portal-mindscape`) | Renders real data **once clustering has run**. |
| Territory **chronicles** (narratives) | ⬜ | — | **Phase C unbuilt**; columns exist, unpopulated. |
| Explore the rendered mindscape in the portal | ✅ | V + M | Read path verified; visual check pending on Mac. |

**Journey verdict:** read is done; **generate is manual + Tier-2 + has no in-app
trigger.** This is the #1 product-completeness gap.

### Journey E — Portal: browse the vault
| Step | Status | Test | Gap |
|---|---|---|---|
| App opens, no login wall (auth-shim) | ✅ | V (`portal-data`) | — |
| First-run welcome on empty vault → guides to Import | ✅ | V (`portal-tps` O0/O1) | Wired (Phase O); modal shown when `messageCount===0`. |
| Tight nav (6 screens) + "Coming later" group | ✅ | V (`nav`) | — |
| Library (docs CRUD, pin/move/folders) | ✅ | V (`portal-data`) | — |
| Mindscape / Timeline / Profile / Settings render real data | ✅ | V (`portal-mindscape`,`portal-tps`) | Settings = timezone + theme (client-side); deeper settings deferred. |
| Canonical SPA served + API routed first | ✅ | V (`portal-serve`,`integration`) | Build-gated (SKIP without `portal:build`). |
| **Actual visual correctness on a Mac** | ❓ | M | No browser here — **operator must eyeball** `npm run portal:dev`. |

### Journey F — Publish: share a document
| Step | Status | Test | Gap |
|---|---|---|---|
| ed25519 box identity from master key | ✅ | V (`publish`) | — |
| Publish doc → public `/p/:slug`; unlisted `/s/:slug?t=` signed token + nonce | ✅ | V (`publish`) | Fail-closed; revocation via nonce epoch. |
| Public server serves only published/unlisted, 404s private | ✅ | V (`publish`) | Binds `127.0.0.1:8788`. |
| **Expose it to the world** (tunnel/domain) | ⬜ | — | **Doc-only** — no tunnel config/infra. |
| `<handle>.mycelium.id` handle infra | ⬜ | — | Central infra, planned. |
| Mint/revoke unlisted link as an MCP tool | ⬜ | — | Foundation-only; no tool yet (fail-closed: nothing mintable = nothing leaks). |

### Journey G — Remote / mobile access
| Step | Status | Test | Gap |
|---|---|---|---|
| OAuth 2.1 + PKCE on Streamable HTTP | ✅ | V (`oauth`) | — |
| Public origin config (`MYCELIUM_BASE_URL`) + TLS | ◑ | — | Works in dev; **no TLS/hardening guide.** |
| Stable `MYCELIUM_AUTH_SECRET` (else tokens rotate on restart) | ❓ | — | **Reported risk — verify**: persist the secret or require env. |
| Tunnel / VPS deploy walkthrough | ⬜ | — | **Doc-only.** No `fly.toml`/Tunnel template/guide. |

---

## 2. Functionality × status matrix (the full surface)

| Area | Code | Verified | Tier | Notes |
|---|---|---|---|---|
| Two-key vault: boot/unlock/KCV/fail-closed | ✅ | ✅ | 1 | `foundation`,`keysource` |
| AES-256-GCM encrypt-at-rest (adapter) | ✅ | ✅ | 1 | transparent ENCRYPTED_FIELDS |
| Key source: env / Keychain / 1Password | ✅ | ✅ | 1 | `set-keys` (Keychain); Linux=env |
| MCP stdio transport | ✅ | ✅ | 1 | `mcp` |
| Streamable HTTP + OAuth 2.1/PKCE | ✅ | ✅ | 1 | `oauth` |
| REST `/api/v1/*` + `/ingest/*` | ✅ | ✅ | 1 | `rest` |
| Tools: context/getContext | ✅ | ✅ | 1 | `context` |
| Tools: ingest (capture/import) | ✅ | ✅ | 1 | `ingest`,`import` |
| Tools: documents + mind-files | ✅ | ✅ | 1 | `mindfiles` |
| Tools: messages/tasks/health/metrics | ✅ | ✅ | 1 | `mcp`,`metrics` |
| Tools: mindscape search | ✅ | ◑ | 1/2 | BM25 V; vector T2 |
| Tools: topology (5) | ✅ | ✅ | 1 | `topology` |
| Tools: fisher/trajectory (4) | ✅ | ◑ | 1 | **no direct verify** |
| Tools: reply, services (deferred) | ◑ | — | — | stubs (D5/Phase 2) |
| Tools: delegation, schedules, spaces (unwired) | ◑ | — | — | present, not registered |
| Ingestion choke-point + encrypted blob store | ✅ | ✅ | 1 | `blob`,`enqueue` |
| **Import parsers (Claude/ChatGPT)** | ✅ | ✅ | 1 | `import` (+ `import-security`); **F: real export** |
| Enrichment service `:8095` (embed+NLP state machine) | ✅ | ✅ | 1 | `enrich` (hand-off); real embed T2 |
| Embed-service `:8091` (Nomic ONNX) | ✅ | ⚠️ | 2 | `embed` attempts; needs model |
| Clustering pipeline (5 stages) | ✅ | — | 2 | **manual CLI; no CI verify** |
| **Generate-mindscape trigger (Phase G)** | ⬜ | — | — | no `/generate` endpoint |
| **Chronicles narratives (Phase C)** | ⬜ | — | — | columns unpopulated |
| Search BM25+vector+RRF | ✅ | ✅ | 1/2 | `search`; vector T2 |
| Inference router (local Ollama + BYOK cloud) | ✅ | ✅ | 1/2 | `inference`; real models need Ollama/keys |
| Publishing (identity + signed links + public server) | ✅ | ✅ | 1 | `publish` |
| **Portal build-out (nav/mindscape/import/timeline/profile/settings/welcome)** | ✅ | ✅ | 1 | `nav`,`portal-*`,`integration` |
| Native Tauri shell | ◑ | — | — | scaffold; build on Mac |
| **Tauri key ceremony (Phase K)** | ⬜ | — | — | designed; Mac/Rust |
| npm package distribution | ⬜ | — | — | `private:true` (roadmap) |
| Remote deploy / tunnel | ⬜ | — | — | doc-only |
| Messaging connectors / browser ext | ⬜ | — | — | Phase 6 |
| Multi-user / federation | ⬜ | — | — | V2 (gated) |

---

## 3. Test-coverage map — what's tested, what isn't

**Automated (26 `verify:*`, CI-gated, Tier-1):** foundation, keysource, mcp,
mindfiles, metrics, rest, search, topology, context, ingest, blob, enqueue, enrich,
oauth, publish, inference, portal, portal-serve, portal-data, portal-mindscape,
import, import-security, portal-tps, integration, nav, embed (Tier-1 mock).

**Known test gaps (code exists, no/!sufficient test):**
1. **Clustering pipeline** — no `verify:clustering`; the whole generate path is
   unverified (Tier-2 host needed). **Highest test gap.**
2. **fisher-tools (4 tools)** — no direct verify.
3. **Import fidelity** — parsers tested against synthetic fixtures only; **needs a
   real Claude + real ChatGPT export (F).**
4. **End-to-end user journey** — no single test walks install → keys → import →
   generate → search; the `integration` verify covers the *server* journey, not the
   operator/setup journey.
5. **Real MCP client** — Claude Desktop stdio + mobile OAuth never exercised against
   a live client (M).
6. **Portal visual correctness** — no browser here; every screen needs a Mac eyeball.
7. **Embed-service + inference real paths** — only attempted at Tier-2.
8. **Auth-secret persistence** — unverified; reported to rotate on restart.

**Needs a host/environment we don't have here:** the ML stack (T2), a browser/Mac
(M), real third-party exports (F), a live MCP client (M).

---

## 4. Prioritized pre-launch punchlist

### P0 — launch blockers (must do before publish)
1. **Distribution decision + mechanism.** Pick npm CLI (`@mycelium/mcp`, flip
   `private`, publish CI) and/or the Tauri `.dmg` (bundle Node + project, sign +
   notarize, release CI). *Today there is no way for a user to install.*
2. **Generate-mindscape path is real + reachable.** Build **Phase G** (`/api/v1/
   portal/mindscape/generate` job + progress) so the signature feature works from
   the app, **and** add at least a dry-run `verify:generate` + a documented Tier-2
   "how to actually run clustering" guide.
3. **Remote-deploy story** (if remote/mobile is in scope for launch): a Cloudflare
   Tunnel / VPS guide + a stable `MYCELIUM_AUTH_SECRET` (persist on first boot) +
   a TLS note. If launch is **local-only**, say so explicitly and descope this.
4. **Funding placeholders** — set the GitHub Sponsors handle + Stripe link, uncomment
   `.github/FUNDING.yml` (`PRE-LAUNCH-CHECKLIST.md`).
5. **Real-export import test (F)** — run a real Claude + ChatGPT export through Import
   on the Mac; fix any parser drift. (Ship Claude/ChatGPT only; others stay "soon".)

### P1 — strongly recommended
6. **Onboarding friction** — an `install.sh` (Node/toolchain/deps/init-db/keys in one
   flow) + a guided key + Claude-Desktop-config step. (The **Tauri key ceremony,
   Phase K**, is the exquisite version — Mac-gated.)
7. **Real-client smoke test (M)** — connect Claude Desktop (stdio) + one mobile/HTTPS
   client; verify the tool round-trip + encryption end-to-end (the spec's success
   criteria #2 and #3).
8. **Portal visual pass (M)** — eyeball all 6 screens on a Mac (`npm run portal:dev`).
9. **fisher-tools verify** + **chronicles (Phase C)** if territory narratives are part
   of the launch story.

### P2 — polish / post-launch-ok
10. Obsidian/LinkedIn import; unlisted mint/revoke MCP tool; deeper Settings;
    `<handle>.mycelium.id` infra; the Phase-6 deferrals (connectors, browser ext).

---

## 5. Known unknowns (need investigation before trusting)
- Does `MYCELIUM_AUTH_SECRET` actually rotate on restart and invalidate tokens? (P0.5)
- Real-export format fidelity (Claude/ChatGPT schemas evolve) — only a real file tells.
- Tier-2 install success on a clean Mac (`pipeline/setup.sh` + onnxruntime + model).
- Clustering output quality on real data (the pipeline runs ≠ produces a good mindscape).
- Tauri bundling: does the `.app` correctly spawn Node + find the project on a user machine?

---

## 6. Scope reminder (explicitly NOT in V1 — don't treat as gaps)
Pure tool server, **no autonomous loop/scheduler** (D5); single-user (no multi-tenant/
RLS); messaging connectors, browser extension, publish-egress chokepoints, federation
→ **Phase 6 / V2** (`V1-BUILD-SPEC.md` §Phase 6, `REDESIGN-LIVING-SPEC.md`).

---

*Companion docs: [`HOW-IT-WORKS.md`](HOW-IT-WORKS.md) (mental model),
[`ARCHITECTURE.md`](ARCHITECTURE.md) (as-built), [`V1-BUILD-SPEC.md`](V1-BUILD-SPEC.md)
(plan), [`UX-COMPLETE-DESIGN-2026-06-01.md`](UX-COMPLETE-DESIGN-2026-06-01.md) (UX),
[`PRE-LAUNCH-CHECKLIST.md`](PRE-LAUNCH-CHECKLIST.md) (placeholders).*
