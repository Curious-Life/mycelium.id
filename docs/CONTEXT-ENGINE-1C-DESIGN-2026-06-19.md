# Context Engine — Phase 1c Design (three-tier memory) · sweep-verified

**Date:** 2026-06-19 · **Status:** buildable design (4 parallel Explore sweeps + direct reads). Companion to `CONTEXT-ENGINE-IMPLEMENTATION-PLAN-2026-06-19.md` §3 Phase 1c. **Not built yet — this is the plan.**

## 0. What 1c builds
The third foundation: a **bounded Core** (`mind/self.md`, always loaded, distilled from the narrative), a **scan-on-write gate** (`sanitize.js`) that hardens every persistent write — *the blocker for the reflection engine going live* — the missing **`removeFromMind`** op, and a **`getContext` recompose** that leads with the Core and adds today's domain/register mix (leveraging 1b's labels).

## 1. Load-bearing assumption ledger (R = I read it · S = sweep-cited)
| # | Assumption | Verdict | At | By |
|---|---|---|---|---|
| A1 | `mind-files.js writeMindFile` is the SINGLE write chokepoint — all tool writes, doc-mirrors, and snapshots funnel through it | ✅ | every caller via `mcp.js:110/116`; `internal.js:151,153,164,166,258,282,308`; `documents.js:401,445` | R |
| A2 | A `sanitize()` call inside `writeMindFile` (before `encrypt`) gates ALL writes, fail-closed (it can throw) | ✅ | `mind-files.js:106-131` (throws at :108 already) | R |
| A3 | `mind/self.md` resolves to a valid scope (`personal`) so encrypt/decrypt works | ✅ | `crypto-local.js:1154-1157` | R |
| A4 | `self.md` is referenced nowhere today (greenfield Core) | ✅ (absent) | grep src/ — no `self.md`/`states/self` | S |
| A5 | `getContext` order: time → mind(model+flagged) → facts → people → messages → phase → health → claims; `want(include,…)` gates sections | ✅ | `context.js:57,65-171` | S |
| A6 | The "polluted" raw-claims block to demote/replace is the `WHAT YOU'VE LEARNED ABOUT THEM` section | ✅ | `context.js:158-171` (listActive, renderClaimsBlock, 600-tok) | S |
| A7 | `domain`/`register` columns exist + are GROUP-BY-able; `listDataSources` is the aggregate pattern to mirror | ✅ | `0031_message_categories.sql`; `db/messages.js:776-792` | S |
| A8 | `estimateTokens` (pure) reusable for the Core cap; `content_hash` SHA-256 reusable for dedup | ✅ | `token-budget.js:24`; `document-store.js:12` | S |
| A9 | Credential-pattern sources to reuse exist (`SECRET_PATTERNS`) | ✅ | `crypto/guardians/scrubbers.js`, `ingest/capture.js:78-85` | S |
| A10 | `removeFromMind` does NOT exist; `editMindFile(old,'')` is the current delete | ✅ (absent) | `internal.js:103` (empty new_string deletes) | S |
| A11 | The integration cycle body consolidates model.md but has NO self.md/Core step yet | ✅ | `cycle-prompts.js` integration body (Phase 3) | S |
| A12 | `getContext` does NOT token-budget itself; run-turn budgets the whole system; model.md/flagged.md load WHOLE (no per-file cap) | ✅ | `context.js:78-84`; `run-turn.js:91` | S |
| A13 | No TTL cache around V1 getContext (the reference has one; V1 doesn't) | ✅ (absent) | `context.js` (none); ref `context-assembly.js:31-38` | S |

## 2. Decisions the sweep forced
**D1 — One scan site: inside `writeMindFile`, SKIP snapshots.** Snapshots (`snapshots/…`) are internal copies of already-scanned content; re-scanning them is redundant and could block a rollback anchor. `sanitize` early-returns ok for `filename.startsWith('snapshots/')`. (Live content is the risk; it's scanned on its own write.)

**D2 — `sanitize` blocks INJECTION + live CREDENTIALS, not broad hex.** The broad `/[0-9a-f]{32,}/` (scrubbers) false-positives on SHA-256/UUIDs, and the **agent never has the master key in its context** (it's process-memory only) — so master-key-in-mindfile is low-risk. The real risks: (a) **invisible/bidi Unicode** (zero-width, RTL-override — a pure injection vector, never legitimate in prose) → BLOCK; (b) **high-confidence live credential tokens** (`sk-ant-`, `sk-`, `ghp_`/`gh[pousr]_`, `AKIA…`, `xox[baprs]-`, JWT `eyJ…`, `Bearer …`) the agent might echo from a message → BLOCK; (c) a **size ceiling** (`estimateTokens > 16k` → BLOCK, runaway guard). Abstract discussion of patterns (literal `AKIA[0-9A-Z]{16}`) does NOT match the real regex, so legitimate security notes pass. CODE-only logging (`[sanitize] <code> in <filename>`, never content — `mind-files.js:96` discipline).

**D3 — Keep the claims block in 1c (demoted below the Core), don't delete it.** Removing it now leaves a "what I know about you" gap until Phase 2. Instead, 1c **leads with the clean Core** (`self.md`) as the authoritative identity; the raw-claims block stays *below* it (still 600-tok budgeted) until Phase 2 swaps in the bi-temporal `asOf` version. No gap, and the Core already fixes the "pollution leads" problem.

**D4 — Capacity is soft (cycle-driven) + a defensive getContext trim; no hard write-reject.** The integration cycle keeps `self.md` ≤ ~1000 tok (prompt discipline + 80%-consolidate rule). `getContext` additionally trims a runaway Core (`estimateTokens` → slice to ~1200 tok) so it can never bloat context. `writeMindFileWhole` stays general (no Core-specific reject — it's used for model.md too).

**D5 — Cold start is graceful.** No `self.md` until the first integration cycle distills one from `model.md`. `getContext` renders the Core only if present (`.catch(()=>null)`, like model.md). Until then, model.md carries identity. GOTCHA: editing the integration cycle CONSTANT (`cycle-prompts.js`) does NOT update an already-seeded `scheduled_tasks.prompt` (seed is idempotent-by-name) — fine for a fresh install; an existing deployment updates the cycle via `updateCycle` or a forced re-seed (note for later).

## 3. Buildable units
### 1c-A — `sanitize.js` scan-on-write (the security gate; blocks 1a go-live) · ~120 LOC
- **New** `src/mindfiles/sanitize.js`: `sanitize(content, filename) → {ok:true} | {ok:false, code}`. Checks (D2): invisible/bidi Unicode class, the credential regex set (reused/narrowed from `capture.js`), size ceiling. Skips `snapshots/` (D1). Pure, no I/O, no content logging.
- **Edit** `src/mindfiles/mind-files.js writeMindFile`: before `encrypt` (~:116), `const v = sanitize(String(content), filename); if (!v.ok) throw new Error('mindfile-blocked:' + v.code);`. Fail-closed.
- **Gate** `verify:mindfile-sanitize`: invisible-Unicode payload → blocked; a live `sk-ant-…`/`ghp_…` token → blocked; legitimate prose (incl. abstract pattern text + a 64-hex SHA that isn't a key context) → passes; oversized → blocked; a `snapshots/…` write → passes (skip); writeMindFile throws on block (no partial write).

### 1c-B — bounded Core + getContext recompose · ~180 LOC
- **New** `db.messages.domainMix(userId, {sinceIso})` (mirror `listDataSources:776-792`): `SELECT domain, register, COUNT(*) … WHERE created_at >= ? GROUP BY domain, register`. Plaintext cols → plain SQL.
- **New** a small renderer `renderDomainMix(rows)` → a compact "Today you've been in: Work & Creativity (12) · Self & Inner Life (5) …" block.
- **Edit** `src/tools/context.js`: add include key `core` → load `self.md` (defensive `estimateTokens` trim to ~1200 tok, D4) as the LEAD content section (header `# WHO YOU ARE (core)`), before facts. Add include key `domains` → today's mix (in the "right now" group, after recent messages). KEEP the claims block, demoted below the Core (D3). Update the `include` enum.
- **Gate** `verify:core-context` (or extend): self.md leads when present; missing self.md → no crash (cold start); domain-mix renders from labelled rows; claims block still present but after the Core; a giant self.md is trimmed.

### 1c-C — Core distillation in the integration cycle + `removeFromMind` · ~90 LOC
- **Edit** `cycle-prompts.js` integration body: add **Phase 3.6 — distill the Core**: from the freshly-consolidated `model.md`, `writeMindFileWhole('self.md', …)` a bounded Core (`## Identity · ## Current focus (volatile—rewrite) · ## Stable preferences · ## Boundaries`), ≤ ~1000 tok, with the **save-heuristic** (corrections > preferences > durable facts; skip ephemera/already-in-context) + the **80%-capacity consolidate-before-add** rule. (`self.md` is in the integration cycle's `enabledTools` via `writeMindFileWhole`, already granted.)
- **New** `removeFromMind` tool in `internal.js` (thin: remove a unique block, = `editMindFile(old,'')` with a clearer name + the "only-if-unique" guard) → add to the `mindfiles` tool-domain.
- **Gate**: extend `verify:reflection-cycles` (integration body references `self.md` + the heuristic; the persona/cycle gate already exists) + a `removeFromMind` unit test.

**~390 LOC, 0 migrations** (self.md is a mind-file; domain cols already landed in 0031). Order: **1c-A first** (it gates 1a go-live), then 1c-B, then 1c-C.

## 4. Threat model (CLAUDE.md §1-13)
| Risk | Mitigation (at) |
|---|---|
| Injection via written state (the reflection engine writes persistent state from message content) | `sanitize.js` at the single `writeMindFile` chokepoint, fail-closed (1c-A) — this is the named 1a-go-live blocker |
| Plaintext leakage in logs | CODE-only sanitize logging (`[sanitize] <code> in <filename>`), never content |
| Secret persistence | block live credential tokens before encrypt-write (D2) |
| Context bloat / cost | Core hard-trim in getContext + soft cap in the cycle (D4) |
| Doc-mirror bypass | NOTE: `documents.js:401/445` mirror writes are `try/catch` non-fatal — a sanitize-block there silently skips the *mirror* (the doc itself still saves; documents are a separate surface, gating them is a follow-on) |

## 5. Risks
| Risk | L | I | Mitigation |
|---|---|---|---|
| sanitize false-positive blocks a legitimate write | Med | Med | narrow patterns (D2); skip snapshots; gate proves legit prose passes |
| editing the integration constant doesn't update seeded tasks | Med | Low | fresh installs fine; existing → `updateCycle`/re-seed (D5 gotcha) |
| removing claims would gap until Phase 2 | — | — | resolved: keep+demote (D3) |
| Core distillation quality (agent-authored) | Med | Med | never-conclude discipline + snapshots + the heuristic; not deterministic by design |

## 6. Verification ledger (this design)
[✓] keystone (single write chokepoint) read directly · [✓] 13 assumptions tabled w/ file:line + R/S · [✓] 5 decisions w/ rationale · [✓] 3 units w/ files/signatures/gates/LOC · [✓] threat model mapped to enforcement · [✓] risks concrete · [✓] order (1c-A gates 1a go-live).
