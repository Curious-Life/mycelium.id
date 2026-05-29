# Port Priority — `reference/` triage for V1

**Purpose:** A scan-once classification of every file in `reference/` so the V1 dev knows what to port vs. skim vs. skip — without re-deriving the categorization mid-build.

**Three buckets:**

| Tag | Meaning |
|---|---|
| 🟢 **PORT** | Actively port to V1's `src/`, `pipeline/`, `packages/`. Direct or adapter-swap. |
| 🟡 **SKIM** | Read for patterns / single-user adaptation needed / agent-specific (port only if V1 ships that agent). |
| 🔴 **SKIP** | V1 doesn't need this. Keep as informational reference for V2 / future. Don't waste build days on it. |

**Totals:**
- 🟢 PORT: ~62k LOC across ~155 files (54%)
- 🟡 SKIM: ~33k LOC across ~95 files (29%)
- 🔴 SKIP: ~20k LOC across ~85 files (17%)

---

## Quick-grab summaries

**If you have 1 hour to onboard**, read these:
- `docs/V1-BUILD-SPEC.md` (the plan)
- `reference/README.md` (the layout)
- This file (the triage)
- `docs/REDESIGN-LIVING-SPEC.md` Part 9 (what survives the architecture change)

**If you have 1 day to start porting**, layer 1 work:
- 🟢 `pipeline/embed-service.py` → adapt for Ollama call boundary
- 🟢 `encryption/crypto-local.js` → V1's `src/crypto/` (preserve envelope format, switch 24→12 word BIP-39)
- 🟢 `mind-files/mind-files.js` → V1's `src/mind-files/`
- 🟢 `schema/d1-schema-generated.sql` → V1's `migrations/` via D1 adapter

---

## Per-category triage

### `reference/pipeline/` — 🟢 ALL PORT (6 files, ~5k LOC)

Pure algorithm code, architecture-neutral. Direct ports.

| File | Tag | Notes |
|---|---|---|
| `embed-service.py` | 🟢 PORT | Wrap for Ollama integration per V1 spec |
| `cluster.py` | 🟢 PORT | FAISS + Leiden + Ward HAC ports as-is |
| `compute_information_harmonics.py` | 🟢 PORT | H0/β/γ/α/θ/δ harmonics; honesty flag stays |
| `compute-cofire.js` | 🟢 PORT | 4-timescale co-firing |
| `describe-clusters.js` | 🟢 PORT | LLM territory naming |
| `run-clustering.sh` | 🟢 PORT | Orchestrator script |

### `reference/encryption/` — 🟢 mostly PORT (3 files, ~3k LOC)

| File | Tag | Notes |
|---|---|---|
| `crypto-local.js` | 🟢 PORT | Preserve envelope format. V1 uses 12-word BIP-39; re-derive but keep AES-256-GCM envelope shape. Scope guardians simplify for single-user (drop org/wealth/moms unless those agents ship). |
| `bootstrap-secrets.js` | 🟡 SKIM | 5-min refresh pattern is over-engineered for single-user. Take the pattern; simplify to "read once at session unlock". |
| `kms-client.js` | 🔴 SKIP | Swiss split-jurisdiction KMS client. V1 doesn't need unless operator explicitly wants offsite KMS. Defer to V2. |

### `reference/mind-files/` — 🟢 PORT (1 file)

| File | Tag | Notes |
|---|---|---|
| `mind-files.js` | 🟢 PORT | MIND magic + envelope, per-host per-agent key. V1 single-user collapses to per-user key. |

### `reference/mind-search/` — 🟢 ALL PORT (19 files, ~6k LOC)

The RAM index + scan-matchers. Single-user means **drop the per-user filter wrapper** — index can be unconditional. Otherwise direct port.

### `reference/federation/` — 🟡 PHASE-DEPENDENT (6 files, ~3k LOC)

V1 spec Phase 1-4 does NOT include federation. Phase 5+ does. Either:
- 🟡 SKIM if Phase 1-3 only
- 🟢 PORT if shipping public profile / publish path

| File | Tag | Notes |
|---|---|---|
| `publishing.ts` | 🟡 / 🟢 | Publish path `<handle>.mycelium.id/p/<slug>` — useful even in V1 if shipping public publishing |
| `federation.ts` | 🟡 / 🟢 | WebFinger; minimal cost |
| `did-document.ts` | 🟡 / 🟢 | Instance-level DID; for SSO-like identity |
| `handles.ts` | 🟡 / 🟢 | Handle registration |
| `public-profile.ts` | 🟡 / 🟢 | Public-API endpoints with KV cache + rate limit |
| `share-links.ts` | 🟡 / 🟢 | Token-based share links |

**Recommendation:** Defer all 6 to Phase 5. Spec V1 doesn't promise federation.

### `reference/mcp-tools/` — 🟢 mostly PORT (14 files, ~11k LOC)

All ports need the D1-fetch boundary rewritten to use V1's `D1Adapter`.

| File | Tag | Notes |
|---|---|---|
| `documents.js` | 🟢 PORT | Core data access |
| `mindscape.js` | 🟢 PORT | Topology surface |
| `messages.js` | 🟢 PORT | Daily message retrieval |
| `topology-tools.js` | 🟢 PORT | Territory exploration |
| `metrics.js` | 🟢 PORT | Harmonics + cognitive metrics |
| `fisher-tools.js` | 🟢 PORT | Cognitive metrics (if shipping) |
| `reply.js` | 🟢 PORT | **Critical** — explicit-send tool |
| `internal.js` | 🟢 PORT | Mind-file tools live here (readMindFile, editMindFile, writeMindFileWhole) |
| `tasks.js` | 🟢 PORT | Task creation |
| `schedules.js` | 🟢 PORT | Scheduled events |
| `health.js` | 🟢 PORT | HealthKit data (if shipping body tracking) |
| `delegation.js` | 🟡 SKIM | Multi-agent delegation; V1 single-agent simplifies. Port if V1 ships >1 agent. |
| `services.js` | 🟡 SKIM | Service registry; review what's actually exposed |
| `spaces.js` | 🔴 SKIP | Multi-user shared spaces; V1 single-user has none. Defer to V2. |

### `reference/egress/` — 🟢 ALL PORT (4 files, ~3k LOC)

The "explicit-send only" invariant must hold in V1 even if V1 doesn't ship bots — any agent-text-out path needs a chokepoint.

| File | Tag | Notes |
|---|---|---|
| `send-handler.js` | 🟢 PORT | The factory; single-user removes scope/channel routing complexity |
| `agent-egress.js` | 🟢 PORT | System-authored egress primitive |
| `inbound-context.js` | 🟢 PORT | Active-turn registry for reply auto-targeting |
| `artifact-publish.js` | 🟢 PORT | The "every artifact persists + hooks fire + user notified once" invariant |

### `reference/schema/` — 🟢 PORT (1 file)

| File | Tag | Notes |
|---|---|---|
| `d1-schema-generated.sql` | 🟢 PORT | All 111 tables as-is per V1 spec. ~30 tables become inert in single-user (provisioning_jobs, handle_reservations, fleet_*, tenant routing); leave them empty for V2 forward-compat. |

### `reference/bots/` — 🟡 SHIP-DEPENDENT (10 files, ~3k LOC)

V1 spec mentions REST API as primary ingestion. Bots are optional.

| File | Tag | Notes |
|---|---|---|
| `telegram-bot.js` | 🟡 SKIM | PORT if V1 ships Telegram ingestion |
| `whatsapp-bot.js` | 🟡 SKIM | PORT if V1 ships WhatsApp |
| `owntracks-receiver.js` | 🟡 SKIM | Location ingestion; cheap if location matters |
| 6× discord bots (personal, ops, intel, commercial, research, publishing, wealth) | 🔴 SKIP | Canonical-architecture (per-agent-bot). V1 ships ONE consolidated Discord bot or none. The 6 are reference for command/routing patterns. |

**Recommendation:** Defer all 10. Ship REST API first, bots in a follow-up.

### `reference/tests/` — 🟢 mostly PORT (39 files, ~5k LOC)

The encryption + master-key + Noise NK tests document expected behavior. Port the test assertions even if rewriting the test runner.

| File | Tag | Notes |
|---|---|---|
| `crypto-security.test.js` | 🟢 PORT | Documents envelope format |
| `encryption-coverage.test.js` | 🟢 PORT | Validates 40+ tables encrypted |
| `master-key-pinning.test.js` | 🟢 PORT | Key-loading discipline |
| `master-key-rotation.test.js` | 🟢 PORT | Rotation pattern |
| `two-key-separation.test.js` | 🟢 PORT | USER_MASTER vs SYSTEM_KEY |
| `noise-nk.test.js`, `noise-nk-cross.test.js` | 🔴 SKIP | V1 uses OAuth not Noise NK |
| `did-document.test.js` | 🟡 SKIM | Federation Phase 5 |
| `channel-authority.test.js` | 🟢 PORT | Inbound-source-fabrication attack class |
| `cron-pipeline-encryption.test.js` | 🟢 PORT | Pipeline-encryption discipline |
| `store-attachment-auth.test.js` | 🟢 PORT | Attachment encryption |
| `agent-config.test.js` | 🟢 PORT | YAML config parsing |
| `smoke.test.js` | 🟢 PORT | Pattern reference |
| `mind-search/` subdirectory (25 files) | 🟢 PORT | Comprehensive mind-search test suite |

### `reference/portal/` — 🟡 / 🔴 HEAVY ADAPTATION (94 files, ~41k LOC)

The portal is the heaviest reference; treat it as a *starting point*, not a port target. Auth (Noise NK secure-fetch) must be replaced with OAuth + standard HTTPS.

**🟢 PORT (with adaptation) — V1 strong-fit routes:**

| Route | Notes |
|---|---|
| `chat/` | Core conversation UI |
| `mindscape/` (+ Mindscape3D.svelte + supporting components) | The 3D viz; high value |
| `library/` | Document vault |
| `timeline/` | Temporal view |
| `activity/` | Daily activity |
| `vitality/` (+ CognitiveShapeTab + harmonic cards) | Cognitive metrics UI |
| `profile/` | User profile |
| `settings/` | Config UI |
| `import/` | ChatGPT/Claude/Obsidian/Apple Notes ingestion |
| `media/` | File attachments |
| `agents/` | Agent management |
| `modules/` | Skill modules |
| `body/` | Health/biometric data |
| `login/` (+ `telegram-callback/`) | Auth entry; replace Noise NK with OAuth |

**🟡 SKIM — needs single-user collapse:**

| Route | Notes |
|---|---|
| `contexts/` | Domain contexts; collapse multi-tenant grants |
| `spaces/` | Shared spaces; single-user has none |
| `connections/` | Social graph; defer to federation phase |

**🔴 SKIP — V1 doesn't need:**

| Route | Reason |
|---|---|
| `fleet/` | Operator-only UI to manage canonical's customer fleet |
| `wealth/` | Agent-specific (Rob); skip unless shipping wealth agent |
| `intel/` | Agent-specific (Apollo); skip unless shipping intel agent |
| `cycles/` | Agent-specific; skip unless shipping cycles |

**Library files:**

| File | Tag | Notes |
|---|---|---|
| `lib/api.ts` | 🟢 PORT | Swap auth header from Noise NK to OAuth Bearer |
| `lib/secure-fetch.ts`, `lib/secure-channel.ts` | 🔴 SKIP | V1 uses standard HTTPS |
| `lib/noise-nk.ts` | 🔴 SKIP | V1 OAuth |
| `lib/passkey-prf.ts` (+ tests + callers) | 🟢 PORT | WebAuthn PRF for key storage per V1 spec |
| `lib/stores/*` | 🟢 PORT | Svelte stores |
| `lib/components/*` (matching ported routes) | 🟢 PORT | Cognitive metrics, chat, library, mindscape, shell |
| `lib/document-live.ts`, `lib/iframe-live.ts`, `lib/markdown-morph.ts` | 🟢 PORT | Live document editing |
| `hooks.server.ts` | 🟢 PORT | SvelteKit server hook |
| `vps-identity.ts` | 🔴 SKIP | VPS-specific identity caching |

### `reference/core/` — 🟢 mostly PORT (78 files, ~25k LOC)

The largest reference category. Mostly portable with single-user simplifications.

**🟢 PORT (essential):**

| File | Tag | Notes |
|---|---|---|
| `context-assembly.js` | 🟢 PORT | Chat preamble construction. Drop multi-agent scope assumptions; single-user one scope. |
| `lanes.js` | 🟢 PORT | Request serialization; still needed for V1 single-process |
| `channel-id.js` | 🟢 PORT | Identity hashing; single-user simplifies |
| `compaction.js` | 🟢 PORT | Mind-model compaction |
| `continuation.js` | 🟢 PORT | Mid-thought resume |
| `model-fallback.js` | 🟢 PORT | Energy-aware model selection |
| `energy.js`, `energy-state.js` | 🟢 PORT | The token-budget cost router primitives |
| `attachments.js` | 🟢 PORT | Attachment handling |
| `checkpoint.js` | 🟢 PORT | Resume state |
| `coalesce.js` | 🟢 PORT | Message coalescing |
| `cooldowns.js` | 🟢 PORT | Rate-limit primitive |
| `agent-config.js` | 🟢 PORT | YAML→config loader (V1 spec calls for this) |
| `document-store.js`, `document-limits.js` | 🟢 PORT | Document operations |
| `paths.js`, `env.js` | 🟢 PORT | Utilities |
| `error-classifier.js`, `log-redact.js` | 🟢 PORT | Hygiene |
| `message-sources.js` | 🟢 PORT | Source registry |
| `metric-budgets.js` | 🟢 PORT | Cost-router budgets |
| `guardians/` (5 files) | 🟢 PORT | Validation chokepoint pattern |
| `db-d1/` (40 files) | 🟢 PORT | Data-access layer — swap to D1Adapter; SQL stays |

**🟡 SKIM:**

| File | Tag | Notes |
|---|---|---|
| `delegation.js` | 🟡 SKIM | Multi-agent routing; V1 single-agent simplifies |
| `handle-client.js` | 🟡 SKIM | Single-user simplifies |
| `identity-telegram.js` | 🟡 SKIM | PORT only if shipping Telegram |

**🔴 SKIP:**

| File | Tag | Reason |
|---|---|---|
| `canonical-user-id.js` | 🔴 SKIP | Multi-user helper; V1 has one ID |
| `agent-id-aliases.js` | 🔴 SKIP | Multi-agent aliasing |
| `agent-secret-policy.js` | 🔴 SKIP | Multi-agent secret allowlist policy |
| `owner-name.js` | 🔴 SKIP | Canonical operator-name helper |
| `operator-commands.js` | 🔴 SKIP | Canonical operator commands |
| `collab.js` | 🔴 SKIP | Discord collab channel routing |

### `reference/noise-nk/` — 🔴 ALL SKIP (3 files, ~3k LOC)

V1 spec explicitly uses OAuth 2.1 + better-auth, not Noise NK. Keep as informational for V2.

| File | Tag |
|---|---|
| `noise-nk-server.js` | 🔴 SKIP |
| `noise-nk-browser.ts` | 🔴 SKIP |
| `portal-channel.js` | 🔴 SKIP |

### `reference/scheduler/` — 🟢 ONE PORT, 3 SKIP (4 files, ~3k LOC)

| File | Tag | Notes |
|---|---|---|
| `scheduler.js` | 🟢 PORT | Core scheduling engine |
| `scheduler-wealth.js` | 🔴 SKIP | Canonical wealth-agent-specific |
| `scheduler-intel.js` | 🔴 SKIP | Canonical intel-agent-specific |
| `scheduler-company.js` | 🔴 SKIP | Canonical company-agent-specific |

### `reference/server-routes/` — MIXED (46 files, ~30k LOC)

The largest count. About 25 are V1-relevant; 21 are canonical-specific.

**🟢 PORT — V1 needs:**

| File | Notes |
|---|---|
| `chat.js` | Core `/chat` endpoint |
| `channel-auth.js` | Simplify for single-user |
| `health.js` | Health endpoint |
| `internal-search.js` | mind-search loopback |
| `internal-metrics.js` | Loopback metrics |
| `portal-library.js` | Documents |
| `portal-mindscape-explore.js` | Topology exploration |
| `portal-mindscape-reads.js` | Read operations |
| `portal-mindscape-jobs.js` | Background jobs |
| `portal-pipeline.js` | Pipeline status |
| `portal-health.js` | Health endpoint for portal |
| `portal-profile.js` | Profile |
| `portal-settings.js` | Settings |
| `portal-export-import.js` | Imports (ChatGPT, Claude, etc.) |
| `portal-vitality.js` | Cognitive metrics |
| `portal-metrics.js` | Metrics endpoint |
| `portal-metric-freshness.js` | Metric freshness |
| `portal-trajectory.js` | Fisher trajectory |
| `portal-onboarding.js` | First-run flow |
| `portal-passkeys.js` | If using WebAuthn PRF |
| `portal-master-key.js` | Adapt to BIP-39 unlock UX |
| `portal-runtime.js` | Runtime config |
| `portal-stats.js` | Stats |
| `portal-activity.js` | Activity timeline |
| `portal-agents.js` | Agent management (single-agent simplifies) |
| `portal-uploads.js` | File uploads |
| `portal-tts.js` | Voice (if shipping voice) |
| `portal-providers.js` | BYOK provider config |

**🟡 SKIM — single-user collapse:**

| File | Notes |
|---|---|
| `portal-channels.js` | Single-user; multi-channel collapses |
| `portal-channel.js` | Noise NK only; SKIP if dropping Noise NK |
| `portal-connections.js` | Federation-dependent |
| `portal-spaces.js` | Single-user has no shared spaces |
| `portal-contexts.js` | Multi-user grants |
| `portal-energy.js` | Cost router UI; PORT if shipping cost router |

**🔴 SKIP — V1 doesn't need:**

| File | Reason |
|---|---|
| `portal-fleet.js` | Operator-only |
| `portal-billing.js` | No Stripe in V1 |
| `portal-audit.js` | Operator-only |
| `portal-cycles.js` | Agent-specific |
| `portal-describe.js` | Multi-tenant routing |
| `portal-enrichment.js` | Canonical-specific |
| `portal-integrations.js` | Possibly useful, review |
| `portal-intel.js` | Agent-specific |
| `portal-social.js` | Federation; defer |
| `portal-wealth.js` | Agent-specific |
| `portal-ws.js` | WebSocket for live updates; review if SSE alternative |
| `portal-auth-claude.js` | Canonical multi-tenant Claude OAuth |
| `portal-auth-openai.js` | Canonical multi-tenant OpenAI OAuth |

### `reference/server-lib/` — 🟢 PORT (1 file)

| File | Tag | Notes |
|---|---|---|
| `recovery.js` | 🟢 PORT | Agent restart resume; single-user simplifies |

### `reference/worker-handlers/` — 🔴 ALL SKIP for V1 (5 files, ~5k LOC)

V1 has no Cloudflare Worker. These document the patterns V2 will need but don't port anywhere in V1.

| File | Tag | Notes |
|---|---|---|
| `secrets-api.ts` | 🔴 SKIP | V1 stores via better-auth + envelope encryption |
| `agent-tokens-api.ts` | 🔴 SKIP | V1 uses OAuth Bearer tokens |
| `db-proxy.ts` | 🔴 SKIP | V1 has D1 adapter, no proxy layer; the **SQL safety guardian pattern** is useful documentation for V2 |
| `alert-dispatch.ts` | 🔴 SKIP | Discord webhook; optional Discord integration |
| `self-service.ts` | 🔴 SKIP | Multi-tenant signup flow |

### `docs/reference/` — 🟡 ALL SKIM (10 design docs)

Read before designing equivalents. Don't port — they're prose, not code.

| Doc | What to extract |
|---|---|
| `EGRESS-PROVENANCE-PHASE1/2/3-DESIGN.md` | The explicit-send chokepoint discipline; reply MCP tool + active-turn registry |
| `MEASUREMENT-PLANE-PR0.1/0.2/1.5-B3-DESIGN.md` | Analysis pipeline staging plan |
| `MIND-FILES-ENCRYPTION-DESIGN.md` | MIND magic + envelope format |
| `MIND-MODEL-COMPACTION-DESIGN-V3.md` | Capture-then-consolidate workflow |
| `REPLY-DEFERRAL-DESIGN.md` | Reply tool patterns + tool-count reduction |
| `AGENT-WRITABLE-SECRETS-DESIGN.md` | 3 architectural shapes for agent self-rotating secrets |

---

## Build-day mapping

| Day | What | Read from `reference/` |
|---|---|---|
| 1 | D1 adapter + schema | 🟢 `schema/d1-schema-generated.sql`, 🟢 `core/db-d1/*` |
| 2 | Ollama embedding | 🟢 `pipeline/embed-service.py` |
| 3 | MCP server + tool registration | 🟢 `mcp-tools/*.js` (PORT-tagged), 🟢 `core/agent-config.js` |
| 4 | REST API router | Same tool handlers, different transport |
| 5-6 | BIP-39 + scope keys + envelope | 🟢 `encryption/crypto-local.js`, 🟢 `tests/master-key-*.test.js`, 🟢 `tests/two-key-separation.test.js` |
| 7 | OAuth 2.1 (better-auth) | V1 spec; reference irrelevant |
| 8 | Cloudflare Tunnel + agent YAML | V1 spec; 🟢 `core/agent-config.js` for YAML loader |
| 9 | Setup scripts + inference router | V1 spec; 🟢 `core/model-fallback.js` |
| 10-11 | Integration tests | 🟢 `tests/*.test.js` (PORT-tagged); 🟢 `tests/mind-search/` |
| Later | Portal | 🟡 `portal/` (heavy adaptation) — start after MCP server proven |

---

## What to actively ignore

In order of "if you find yourself reading this, stop":

1. `reference/worker-handlers/` (5 files) — V1 has no Worker
2. `reference/noise-nk/` (3 files) — V1 uses OAuth
3. `reference/scheduler/scheduler-{wealth,intel,company}.js` (3 files) — agent-specific
4. `reference/portal/.../fleet/` — operator-only
5. `reference/server-routes/portal-{fleet,billing,audit,auth-claude,auth-openai,describe,enrichment,intel,wealth,cycles}.js` (10 files) — canonical-specific
6. `reference/bots/` 6 discord variants — canonical per-agent-bot architecture
7. `reference/core/{canonical-user-id,agent-id-aliases,agent-secret-policy,owner-name,operator-commands,collab}.js` (6 files) — multi-user / canonical operator helpers
8. `reference/encryption/kms-client.js` — Swiss KMS, optional

**Total ignore-list: ~20k LOC.** Knowing what to ignore saves more time than knowing what to port.
