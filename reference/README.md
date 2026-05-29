# `reference/` — battle-tested code from canonical mycelium

This directory holds **~32k LOC of production-tested code copied from the canonical `Curious-Life/mycelium` private repo**, organized by V1 port category. It's *reference material* — not part of the V1 build artifact. The V1 dev agent reads from here to port modules into V1's actual source tree (which will live under `src/`, `pipeline/`, `packages/` once the build starts).

**License:** All copied code is the same author's work and inherits the repo's AGPL-3.0 license.

**PII status:** This directory has been scrubbed of customer handles, operator name, location, IPs, and incident-specific row counts. Generic placeholders substituted where needed (`'admin', 'alice', 'bob'` for handle examples, "owner" / "tenant" instead of operator name, "inbound-source-fabrication" instead of incident name). The schema, tests, and code itself are otherwise intact.

---

## Layout

```
reference/
├── pipeline/         # Python: Nomic embeddings + clustering + harmonics + co-firing
├── encryption/       # crypto-local.js — 2-key family + scope guardians + envelopes
├── mind-files/       # mind-files.js — MIND magic + envelope format for encrypted-at-rest mind/*.md
├── mind-search/      # In-process RAM index + scan-matchers over embedding_768 columns
├── federation/       # Worker handlers: publishing, federation, did-document, handles, public-profile, share-links
├── mcp-tools/        # 14 MCP tool-domain implementations (subset; mind-files lives in mind-files/)
├── egress/           # send-handler, agent-egress, inbound-context, artifact-publish chokepoints
├── schema/           # d1-schema-generated.sql — full 111-table canonical schema as one readable file
├── bots/             # 10 bot transports: telegram, whatsapp, owntracks, 6× discord
└── tests/            # 14 unit + crypto + federation tests
```

---

## How V1 should use this

Per `docs/V1-BUILD-SPEC.md`, the build sequence is:

| Day | Build task | Read from `reference/` |
|---|---|---|
| 1 | D1 adapter + schema migration | `schema/d1-schema-generated.sql` (use as truth for 111-table layout); adapt or fork |
| 2 | Ollama embedding integration | `pipeline/embed-service.py` (port to Ollama call boundary; reuse 768D shape + task prefixes) |
| 3 | MCP server + tool registration | `mcp-tools/*.js` (port the 14 domains; rewrite the D1-fetch boundary to use V1's D1Adapter) |
| 4 | REST API router | `mcp-tools/*.js` (same handlers, different transport) |
| 5–6 | BIP-39 + scope keys + AES-256-GCM | `encryption/crypto-local.js` (port the scope guardian + envelope shape; V1 spec uses 12-word vs canonical's 24, so re-derive keys but preserve envelope format for compatibility) |
| 7 | OAuth 2.1 (better-auth) | n/a — V1 spec is the source |
| 8 | Cloudflare Tunnel + agent YAML | n/a |
| 9 | Setup scripts + inference router | n/a |
| 10–11 | Integration tests | `tests/*.test.js` (port the crypto + master-key + Noise NK tests; their assertions document expected encryption behavior) |

---

## What's NOT here (and why)

| Canonical surface | LOC | Why skipped |
|---|---|---|
| `packages/server/` (agent-server.js, orchestrator.js) | ~80k | Per-VPS PM2 multi-process architecture; V1 is single-process Express |
| `packages/worker/src/` minus federation handlers | ~13k | Cloudflare Worker tenant-routing model; V1 has no Worker |
| `packages/portal/` | ~41k | SvelteKit portal; V1 doesn't ship a portal (MCP-server-first) |
| `scripts/update-customers.sh`, fleet ops, `sign-cert.sh` | ~10k | Per-VPS deploy + SSH CA + fleet watchdog; V1 is `npm install && npm start` |
| `ecosystem.config.cjs` | ~1k | PM2 per-agent process config; V1 single process |
| Most of `docs/*.md` | ~250 KB | Architecture-clean ones referenced customer handles / incidents / dates and couldn't be safely PII-scrubbed at scale; only `EGRESS-PROVENANCE-PHASE3-DESIGN` was zero-hit and lives in `docs/reference/` |

The redesign-living-spec captures the architectural reasoning that the skipped docs contain; if a specific design doc is needed, ask the operator and we can selectively scrub-and-import.

---

## Provenance

Copied from `Curious-Life/mycelium@a32d787` (the commit that committed the redesign-living-spec). PII scrub run 2026-05-29.

Refresh policy: when canonical evolves, re-run the copy + PII scrub. Don't symlink — canonical sometimes contains operator-specific work that shouldn't land in this repo's working tree.

---

## Module index (quick lookup)

| Module | Path here | Canonical source |
|---|---|---|
| Embedding service (Nomic v1.5 ONNX, 768D) | `pipeline/embed-service.py` | `scripts/embed-service.py` |
| Clustering (FAISS + Leiden + Ward HAC) | `pipeline/cluster.py` | `scripts/cluster.py` |
| Harmonic analysis (H0, β, γ, α, θ, δ) | `pipeline/compute_information_harmonics.py` | `scripts/compute_information_harmonics.py` |
| Co-firing (4 timescales) | `pipeline/compute-cofire.js` | `scripts/compute-cofire.js` |
| Territory naming (LLM) | `pipeline/describe-clusters.js` | `scripts/describe-clusters.js` |
| Clustering orchestration | `pipeline/run-clustering.sh` | `scripts/run-clustering.sh` |
| 2-key family + scope guardians + AES-256-GCM | `encryption/crypto-local.js` | `packages/core/crypto-local.js` |
| Encrypted-at-rest mind/*.md (MIND magic + envelope) | `mind-files/mind-files.js` | `packages/core/mind-files.js` |
| RAM index over embedding_768 | `mind-search/server.js` + supporting modules | `packages/core/mind-search/*` |
| Publishing path (`<handle>.mycelium.id/p/<slug>`) | `federation/publishing.ts` | `packages/worker/src/handlers/publishing.ts` |
| WebFinger | `federation/federation.ts` | `packages/worker/src/handlers/federation.ts` |
| DID document (instance-level) | `federation/did-document.ts` | `packages/worker/src/handlers/did-document.ts` |
| Handle registration | `federation/handles.ts` | `packages/worker/src/handlers/handles.ts` |
| Public profile API | `federation/public-profile.ts` | `packages/worker/src/handlers/public-profile.ts` |
| Share links | `federation/share-links.ts` | `packages/worker/src/handlers/share-links.ts` |
| MCP tools (14 domains) | `mcp-tools/*.js` | `packages/tools/agent-tools/domains/*.js` |
| Egress chokepoints | `egress/send-handler.js`, `agent-egress.js`, `inbound-context.js`, `artifact-publish.js` | `packages/server/lib/*` |
| 111-table schema | `schema/d1-schema-generated.sql` | `migrations/d1-schema-generated.sql` |
| Telegram + Discord + WhatsApp + OwnTracks | `bots/*.js` | `packages/bots/*.js` |
| Crypto, master-key, Noise NK, federation, smoke tests | `tests/*.test.js` + `tests/mind-search/` | `tests/*.test.js` + `tests/mind-search/` |
