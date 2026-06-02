# Mycelium (mycelium.id v2) — Claude Code Notes

## Read this first

This repo holds two specs:

1. **[`docs/V1-BUILD-SPEC.md`](docs/V1-BUILD-SPEC.md)** — **THIS is what we build first.** Self-hosted single-user MCP server, ~18-24 days (ironed-out v1.1 estimate), better-sqlite3 + D1 adapter, **hex master key + AES-256-GCM (ported `crypto-local.js` wrapped-DEK envelope; no BIP-39)**, OAuth 2.1, Cloudflare Tunnel, **Nomic v1.5 ONNX embeddings (`embed-service.py`, not bare Ollama)**, **~34 single-user tools + a `getContext` preamble (pure tool server, no autonomous loop — D5)**, a single recovery key (USER_MASTER; SYSTEM_KEY HKDF-derived — D6 as amended by #36), a build-new :8095 enrichment service (D7), **AnalysisEngine boundary shipping the open topology pipeline as default**. **Open the spec before touching code** — it carries a Verification table + 7 locked decisions (D1-D7) reconciled against `reference/` code.

2. **[`docs/REDESIGN-LIVING-SPEC.md`](docs/REDESIGN-LIVING-SPEC.md)** — architecture-rationale doc for the *eventual* managed-light multi-tenant Postgres tier (V1 spec calls this "Phase 5: Extensions"). 12-agent sweep evidence, RLS threat-model pressure test, 18 operator decisions. Read **Part 0 (Headline)** + **Part 11 (Operator pickup list)** before doing any V2 work. Do NOT start V2 architecture decisions until V1 has shipped and validated with real users.

The **current production code** for existing customers lives in the sibling private repo `Curious-Life/mycelium` (canonical, single-tenant per-VPS, dedicated-tier). It continues to serve those customers. V1 here is the new self-hosted product; V2 (when/if it comes) is the new managed-hosted product.

## V1 vs V2 — quick reconciliation

| Aspect | V1 (build now) | V2 (future, if needed) |
|---|---|---|
| Deployment | Single-user self-hosted | Multi-tenant managed-hosted |
| Storage | SQLite (better-sqlite3 + D1 adapter) | Postgres + pgvector |
| Isolation | One user per process | RLS + per-user key wrap + connection middleware |
| Master key | **Single recovery key: USER_MASTER (64-char hex); SYSTEM_KEY HKDF-derived from it** (`src/account/keystore.js`), copy-paste, no BIP-39 — **as-built #36, amends D4+D6's "two independent keys."** Per-key KCV still guards typos; both keys land in the Keychain so boot is unchanged; a lost key is still unrecoverable by design | 24-word BIP-39 / WebAuthn PRF per redesign spec — reconcile when V2 starts |
| Key storage | Session memory after hex-key unlock | WebAuthn PRF in-browser + tier-specific fallbacks |
| Auth | OAuth 2.1 + PKCE (better-auth) | API gateway + JWT |
| Transport | MCP stdio + Streamable HTTP + REST | + HTTPS+JWT external MCP, federation surfaces |
| Embedding | Nomic v1.5 ONNX 768D via `embed-service.py` (task prefixes) — decision D2; Ollama is inference-only | Same model, server-side per redesign spec |
| Inference | Local Ollama 80% + BYOK cloud 20% | Cost router (port the legacy energy-system design) |
| Schema | All 111 D1 tables ported intact | 75-80 tables after cleanup |
| Topology | AnalysisEngine plugin interface (Lumen plugs in) | Same boundary, multi-tenant adaptations |
| Federation | Deferred (V1 ships sovereignty, no social layer) | `docs/legacy/SOCIAL-SHARING-SPEC-from-legacy.md` |

## ⚠️ Security first — non-negotiable

Mycelium stores the most intimate data a human produces: thoughts, reflections, relationships, finances, meaning-making. Every line is written as if an attacker is reading it. This is not a web app — it is a cognitive vault.

Principles (copied verbatim from the canonical repo's CLAUDE.md so they apply here too):

1. **Zero plaintext leakage** — encrypted data must NEVER appear in logs, error messages, HTTP responses, or unencrypted storage. If in doubt, don't log it.
2. **Defense in depth** — every security boundary has at least two independent enforcement layers.
3. **Fail closed** — missing auth → reject. Missing encryption key → refuse to write. Unknown tenant → deny access. Never fall back to a permissive default.
4. **Master key discipline** — never in HTTP headers, never in env, never in DB, never in logs. VPS-only, memory-only.
5. **Tenant isolation is total** — RLS policies + per-user key wrap + connection-pool middleware OWNS `SET LOCAL`. Cryptographic isolation as the floor, not the ceiling.
6. **No security shortcuts** — never `--no-verify`, `--force`, or skip hooks to bypass a security check.
7. **Embedding vectors are sensitive** — Nomic v1.5 embeddings (768D search, 256D matryoshka clustering) are semantic fingerprints of plaintext. Treat with the same paranoia as plaintext. Embedding inversion attacks are real.
8. **Audit everything** — every cross-boundary call traceable. Never log PII.
9. **Flag vulnerabilities proactively** — if you notice a potential vulnerability while working on something else, stop and flag it.
10. **Validate every operation** — every infrastructure operation verifies its own success. Never log a warning and continue.
11. **Explicit-send only** — agent free-form output is never delivered. All agent → channel paths go through one of three egress chokepoints (`/telegram/send`, `/discord/send`, `/whatsapp/send`).
12. **Every artifact persists + hooks fire + user notified exactly once.** See `docs/architecture/MESSAGE-PERSISTENCE.md` (to be ported).
13. **No ad-hoc network servers.** Agents must never bind a port. Use the publish pipeline (`POST /portal/documents/:path/publish` → `<handle>.mycelium.id/<slug>`).

## Operational disciplines (inherited + V1-local)

Same as the canonical repo, plus skills local to this repo. When applicable, invoke the skill before writing structural code or design docs:

- `/sweep-first-design` — for any structural change. Three sweep cycles min, file:line citations, pivot when code contradicts plan.
- `/deploy-and-verify` — for any change you're about to ship. V1 self-hosted: run the `verify:*` gate(s) to `VERDICT: GO` / EXIT 0, smoke the changed surface (stdio MCP · REST+portal :8787 · publish :8788), update the living docs, emit a [✓]/[—] ledger. No fleet/SSH/wrangler — distribution (npm/Tauri) + remote (Tunnel) are unshipped.
- `/pre-deletion-caller-audit` — before any delete/replace/rename. Inventory every caller, prove migration, falsifiable criteria.
- `/handoff-discipline` — at end of any session that produced commits or decisions. `docs/<TOPIC>-HANDOFF-<YYYY-MM-DD>.md` with TL;DR + commit hashes + pickup protocol.
- `/living-docs` — after any change that alters what the system *is* or what the plan *says*. Keep the three living docs current (plan = `docs/V1-BUILD-SPEC.md`, architecture = `docs/ARCHITECTURE.md`, build log = `docs/V1-BUILD-HANDOFF-*.md`), as-built with file-path evidence. Docs land in the same commit as the code.
- `/auto-merge-on-green` — fail-closed PR merge gate: merge only when all checks pass **and** reviews pass (no changes requested, required approvals met) and the PR is mergeable + non-draft. Security-sensitive diffs always need a human approval. The autonomous routine (`docs/AUTONOMOUS-ROUTINE.md`) merges only through this gate.

## Working style — run tasks to completion

Keep going until the task is actually complete; don't stop and hand back early. This applies especially to multi-sweep work: when there are more sweeps still to run, launch/await them and fold their findings in rather than pausing to "hold for the next sweep." Only end the turn when the deliverable (e.g. spec + plan updated, committed, pushed) is done — or when genuinely blocked on a user decision.

## Design rigor — verify before building (non-negotiable)

The system must be built on the **best possible decisions and designs at every step** — so stress-test, verify, and (where possible) improve each step *before* anything is built on top of it. Prefer **hard evidence over paper reasoning**: a spike that runs real code, or an adversarial read against live `reference/` code, beats a confident assumption. This is the pattern that has already caught real, build-breaking bugs here — the non-existent `oAuthProvider()` API and the per-request `StreamableHTTPServerTransport`, both found by *running/reading*, not planning.

For each load-bearing decision or component, run a **verification gate** before building on it:
1. **Enumerate** the load-bearing assumptions (what must be true for this to work).
2. **Prove or refute** each — spike it, read the real code (file:line), or write a test. Never carry an unverified assumption into a layer that depends on it.
3. **Red-team** it — actively look for the next hidden `oAuthProvider`-class error; consider alternatives; ask whether a better design exists.
4. **Record** the verdict (verification table / spike RESULT.md / decision log) with evidence, then build.

Optimize for the best decision at each step, not the fastest path to code. A spike that surfaces a flaw early is a success, not a detour.

## Where things will live (eventually)

This is the planned monorepo structure. **Empty for now** — packages get added when porting begins (post-operator decisions).

```
mycelium.id/
├── LICENSE                              # AGPL-3.0 (preserved)
├── README.md                            # public-facing intro
├── CLAUDE.md                            # this file
├── package.json                         # npm workspaces (to be added)
├── assets/
│   └── mushroom.svg                     # brand icon (favicon + Tauri app icon)
├── docs/
│   ├── REDESIGN-LIVING-SPEC.md          # the design source of truth
│   └── legacy/                          # harvested from legacy-* tags
│       ├── ARCHITECTURE-from-legacy.md
│       ├── ENERGY-from-legacy.md
│       ├── SOCIAL-SHARING-SPEC-from-legacy.md
│       ├── MINDSCAPE_DESIGN-from-legacy.md
│       └── SPORES-FRAMEWORK-from-legacy.md
├── packages/                            # to be created during port
│   ├── core/                            # crypto, storage adapters, primitives
│   ├── server/                          # multi-tenant agent orchestrator
│   ├── portal/                          # SvelteKit
│   ├── tools/                           # MCP tool servers
│   ├── bots/                            # transport
│   └── worker/                          # (optional — reconsider for Tier B)
├── pipeline/                            # Python: embed-service, cluster, harmonics
├── migrations/                          # Postgres migrations (clean slate)
└── tests/
```

## How to start working here

1. **Read** `docs/REDESIGN-LIVING-SPEC.md` Part 11 (Operator pickup list). The 18 decisions are the gate to Phase 1.
2. **Don't port code yet** if operator decisions in Part 11 are still open. The structural choices (agent runtime B1/B2/B3, per-user key wrap shape, migration framework, etc.) cascade into how the code lands.
3. When porting begins, the order is:
   - Layer 1 (no storage dependencies): `crypto-local.js`, `embed-service.py`, `cluster.py`, `compute_information_harmonics.py`, `mind-files.js` + 3 MCP tools, `mind-search` core
   - Layer 2 (depends on Layer 1, not on new storage): MCP tools surface, bot transports
   - Layer 3 (the new isolation primitives): Postgres schema + RLS, connection-pool middleware, per-user key wrap, scope guardian flipped to per-request
   - Layer 4 (glue): agent-server adaptation, context-assembly multi-tenant rewrite, portal multi-user surfaces
   - Layer 5 (new public-facing): BIP-39 ceremony, WebAuthn PRF storage, trusted-session lifecycle, cost router (harvested from `docs/legacy/ENERGY-from-legacy.md`)

## Note on the cost router

The `lib/energy.js` + `lib/energy-state.js` design from the `legacy-energy-spores-2026-04` tag is the **basis for Tier B's cost router** (token budget → 4-state classification → automatic conservation in scheduler/spawner/delegation/model-fallback). When that work lands, harvest from `docs/legacy/ENERGY-from-legacy.md`. Adapt: per-user budget instead of system-wide.

## Note on federation

`docs/legacy/SOCIAL-SHARING-SPEC-from-legacy.md` is the **authoritative federation design** (Phase 1–5: cognitive fingerprint, connection mindscape, discovery, SMPC matching, shared spaces, SPARSE concept-aware privacy). The Phase 0 surface (publishing, WebFinger, DID-instance) is already shipped in the canonical repo; this spec is the unbuilt Phase 1+.

## Note on the biological model

`docs/legacy/ARCHITECTURE-from-legacy.md` is the **conceptual framing** (mycelium / forest / spores / strain). Carries the project's identity. Some sections are unfilled stubs from the original author; fill in v2 with current rationale.
