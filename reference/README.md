# `reference/` — battle-tested code from canonical mycelium

This directory holds **~115k LOC of production-tested code copied from the canonical `Curious-Life/mycelium` private repo**, organized by V1 port category. It's *reference material* — not part of the V1 build artifact. The V1 dev agent reads from here to port modules into V1's actual source tree (which will live under `src/`, `pipeline/`, `packages/` once the build starts).

**License:** All copied code is the same author's work and inherits the repo's AGPL-3.0 license.

**PII status:** This directory has been scrubbed of customer handles, operator name, location, IPs, and incident-specific references. Generic placeholders substituted where needed (`'admin', 'alice', 'bob'` for handle examples, "owner" / "tenant" instead of operator name, "[customer]" for handle references, "operator-host" for `admin-vps`, "non-English" for "Latvian" timezone/validation labels). Schema, code, and test assertions otherwise unchanged. Two legitimate UI data files (`portal/.../intel/+page.svelte` and `settings/+page.svelte`) list Latvia/Riga among many countries/timezones — kept as normal app data, not PII.

---

## Layout (16 categories, ~115k LOC, ~335 files)

```
reference/
│
├── pipeline/         # Python algorithms — embeddings, clustering, harmonics, co-firing
├── encryption/       # crypto-local + bootstrap-secrets + kms-client
├── mind-files/       # MIND magic + envelope format for encrypted-at-rest mind/*.md
├── mind-search/      # In-process RAM index + scan-matchers over embedding_768 columns
├── federation/       # Worker handlers: publishing, federation, DID, handles, profile, share-links
├── mcp-tools/        # 14 MCP tool-domain implementations
├── egress/           # Egress chokepoints (explicit-send-only invariant)
├── schema/           # 111-table canonical schema (.sql)
├── bots/             # 10 bot transports
├── tests/            # Crypto + master-key + Noise NK + federation + mind-search tests
│
├── portal/           # ★ NEW — full SvelteKit portal source (~41k LOC, needs V1 adaptation)
│
├── core/             # ★ NEW — packages/core helpers: context-assembly, lanes, delegation,
│                       channel-id, scheduler-* support, guardians/, db-d1 client, etc.
├── noise-nk/         # ★ NEW — Noise NK server + browser + portal-channel WebSocket integration
├── scheduler/        # ★ NEW — scheduler.js + per-agent variants (wealth, intel, company)
│
├── server-routes/    # ★ NEW — portal-* endpoints, chat, channel-auth, health, internal-search
├── server-lib/       # ★ NEW — recovery.js
├── worker-handlers/  # ★ NEW — secrets-api, agent-tokens-api, db-proxy SQL guardian, alert-dispatch, self-service
│
└── README.md         # this file
```

```
docs/reference/       # ★ NEW DOCS
├── EGRESS-PROVENANCE-PHASE1-DESIGN.md     # explicit-send chokepoint design
├── EGRESS-PROVENANCE-PHASE2-DESIGN.md     # reply MCP tool + active-turn registry
├── EGRESS-PROVENANCE-PHASE3-DESIGN.md     # fallback deletion
├── MEASUREMENT-PLANE-PR0.1-DESIGN.md      # probe sampling baseline
├── MEASUREMENT-PLANE-PR0.2-DESIGN.md      # harmonics primitives (12 JSON features)
├── MEASUREMENT-PLANE-PR1.5-B3-DESIGN.md   # portal metrics endpoints
├── MIND-FILES-ENCRYPTION-DESIGN.md        # MIND magic + envelope format
├── MIND-MODEL-COMPACTION-DESIGN-V3.md     # mind-model compaction strategy
├── REPLY-DEFERRAL-DESIGN.md               # reply tool patterns + tool-count reduction
└── AGENT-WRITABLE-SECRETS-DESIGN.md       # agent-write-secrets exploration (3 architectural shapes)
```

---

## How V1 uses each section

| Section | V1 use |
|---|---|
| **pipeline/** | Port to V1's `pipeline/` directory. Architecture-neutral; embedding service + cluster.py + harmonics ports as-is. Adapt embed-service Ollama integration per V1 spec. |
| **encryption/** | Port `crypto-local.js` patterns (2-key family, scope guardians, envelope format) to V1's `src/crypto/`. V1 uses 12-word BIP-39 vs canonical's 24-word — re-derive but preserve envelope shape. `bootstrap-secrets.js` shows the 5-min refresh pattern (V1 may simplify since single-user). `kms-client.js` is for the Swiss split-jurisdiction KMS; V1 likely doesn't use unless operator chooses. |
| **mind-files/** | Port `mind-files.js` to V1's `src/` — V1 needs encrypted mind/*.md at rest. Three MCP tools (readMindFile, editMindFile, writeMindFileWhole) are in `mcp-tools/`. |
| **mind-search/** | Port the RAM index + scan-matcher pattern. V1 single-user means no per-user filtering, simplifying the index. |
| **federation/** | Already-shipped Phase 0. Port to V1 if shipping public publish path; otherwise defer. WebFinger + DID-instance are nice-to-have. |
| **mcp-tools/** | Port all 14 domains. Adapt the D1-fetch boundary to use V1's `D1Adapter`. Some scope-aware code needs adjustment for single-user mode. |
| **egress/** | Port `send-handler` and `agent-egress` patterns. CLAUDE.md §11 invariant ("explicit-send only") must hold in V1. V1 may not have egress chokepoints for bot platforms if not shipping bots; the architectural rigor still applies to any agent-text-out path. |
| **schema/** | Port the 111-table schema as-is per V1 spec. Use as authoritative reference. |
| **bots/** | Port if V1 ships Telegram/Discord/WhatsApp ingestion. Otherwise skip — V1 spec mentions REST API as alternative ingestion path. |
| **tests/** | Port the encryption + master-key + Noise NK test patterns to validate V1's crypto layer. The test assertions document expected behavior of the encryption chokepoint. |
| **portal/** | **NEEDS ADAPTATION**. SvelteKit app currently expects canonical's agent-server endpoints (`/portal/*`) + Noise NK WebSocket auth. For V1: (1) keep `chat`, `mindscape`, `library`, `timeline`, `activity`, `body`, `vitality`, `profile`, `settings` routes — strong fit; (2) `contexts`, `spaces`, `connections` need single-user collapse (no multi-tenant assumptions); (3) `agents`, `import`, `media`, `modules` are easy ports; (4) `wealth`, `intel`, `cycles` are agent-specific, keep if V1 ships those agents; (5) **skip `fleet`** — canonical operator-only UI. Auth via Noise NK secure-fetch → swap to better-auth session cookie + standard HTTPS. |
| **core/** | Port: `context-assembly` (chat preamble construction), `lanes` (request serialization), `channel-id` (identity hashing), `delegation` (agent-to-agent routing), `compaction` (mind-model summarization), `continuation` (mid-thought resume), `model-fallback` (when energy scarce), `guardians/` (validation chokepoints), `agent-config` (YAML→config). Adapt the multi-user assumptions to single-user. |
| **noise-nk/** | The encrypted portal channel (code-complete in canonical, gated off). V1 may use a simpler scheme (OAuth + HTTPS) per V1-BUILD-SPEC. Keep as reference if Noise NK is wanted. |
| **scheduler/** | Port `scheduler.js` for autonomous agent wake cycles. The per-agent variants (wealth, intel, company) show specialization patterns. V1's YAML agent templates can use this. |
| **server-routes/** | These are what `portal/` calls back to. Port the routes V1 needs (portal-library, portal-health, portal-profile, portal-mindscape-*, portal-pipeline, portal-export-import for imports, chat) and skip the ones tied to canonical-only surfaces (portal-fleet, portal-billing if not shipping billing in V1). |
| **server-lib/** | `recovery.js` — agent restart resume logic (lane discipline). Port if V1 has scheduled agents that can be interrupted. |
| **worker-handlers/** | `secrets-api.ts` shows the secret storage pattern; `agent-tokens-api.ts` shows token issuance; `db-proxy.ts` has the SQL safety guardian (user_id WHERE enforcement). V1 single-user can simplify but the patterns document the invariants V2 will need. `alert-dispatch.ts` is Discord webhook alerts (optional in V1). |
| **docs/reference/** | Design docs that capture work-in-progress thinking V1 inherits: egress-provenance (all 3 phases), measurement-plane PR0.1/0.2/1.5 (the analysis pipeline staging plan), mind-files encryption, mind-model compaction v3, reply-deferral, agent-writable-secrets exploration. Read before designing the V1 equivalents. |

---

## What's NOT here (intentionally)

| Skipped | LOC | Reason |
|---|---|---|
| `packages/server/` (agent-server.js, orchestrator.js, main lib/) | ~80k | Per-VPS PM2 multi-process architecture — V1 is single-process Express. Replaced by V1's `src/server.ts`. |
| `packages/worker/src/` (non-essential handlers) | ~7k | Cloudflare Worker tenant-routing model not applicable to V1's direct-better-sqlite3 access. Kept only the handlers V1 might emulate (secrets-api, agent-tokens-api, db-proxy SQL guardian, alert-dispatch, self-service). |
| Most `docs/*.md` (~50 docs) | ~200KB | High-PII content (customer handles, incident dates, fleet-specific). Couldn't be safely bulk-scrubbed. The redesign-living-spec captures the architectural reasoning. |
| Operational scripts (`update-customers.sh`, `verify-deploy.sh`, `sign-cert.sh`, fleet ops) | ~10k | Per-VPS deploy + SSH CA + fleet watchdog. V1 is `npm install && npm start`. |
| `ecosystem.config.cjs` | ~1k | PM2 per-agent config — V1 single process. |
| Migration history (190 files) | ~15k | The aggregated schema at `schema/d1-schema-generated.sql` is sufficient for V1. Individual migrations have ad-hoc fix patterns less useful as reference. |

---

## Provenance

Copied from `Curious-Life/mycelium@a32d787` (the commit that committed the redesign-living-spec). PII scrub applied 2026-05-29.

Refresh policy: when canonical evolves, re-run the copy + PII scrub. Don't symlink — canonical sometimes contains operator-specific work that shouldn't land in this repo's working tree.
