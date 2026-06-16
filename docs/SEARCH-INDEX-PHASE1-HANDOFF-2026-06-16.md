# Search-Index Scaling (Phase 1) — Handoff Doc
**Date:** 2026-06-16
**Companions:**
- Plan/direction: [docs/SEARCH-INDEX-ONDISK-PHASE1-DESIGN-2026-06-16.md](SEARCH-INDEX-ONDISK-PHASE1-DESIGN-2026-06-16.md)
- Phase 0 (shipped): [docs/PIPELINE-INTEGRITY-AND-SEARCH-SCALING-DESIGN-2026-06-16.md](PIPELINE-INTEGRITY-AND-SEARCH-SCALING-DESIGN-2026-06-16.md)
- Security thread this merges with: [docs/AT-REST-BLINDNESS-DESIGN-2026-06-11.md](AT-REST-BLINDNESS-DESIGN-2026-06-11.md)

**Audience:** the next Claude Code instance picking up Phase 1 (the on-disk search-index migration). **Compact before starting — Phase 1 is the highest-blast-radius change in the codebase (storage-engine migration on a 1.7 GB encrypted vault) and deserves a clean, focused 3-cycle sweep.**

---

## TL;DR — current state

| Phase | Commit (main) | Status |
|---|---|---|
| Phase 0 — pipeline integrity + cooperative build | `221ab0d` (PR #183, squash) | ✅ MERGED, CI green |
| Phase 1 — on-disk FTS5 + sqlite-vec (whole-file encryption) | — | ✅ SWEPT + SPIKED (gate GO, latency pivot found) → **awaiting operator decisions D-1..D-4**, then implement |

Phase 0 stopped the app from freezing (cooperative index build) and closed the null-content pipeline hole. **Phase 1 is the durable scaling fix** and has now been **sweep-verified + spiked** (see the 2026-06-16 PM update below). There is **no emergency pressure** — Phase 0 restored responsiveness, so Phase 1 should be designed right, not rushed.

---

## 2026-06-16 PM session — spike + sweep complete (start here)

The pickup protocol below was executed. **Outcome: the gate passed; one load-bearing assumption was refuted by measurement.**

- **GATE GO ✅** — `sqlite-vec` (v0.1.9) loads + runs inside an encrypted `better-sqlite3-multiple-ciphers` connection. Ciphertext-at-rest, wrong-key-fail-closed, FTS5/bm25 in the same build, WAL+cipher, vec0 insert/KNN/persist/delete all proven with running code. Spike: [../spike/sqlite-vec-encrypted/](../spike/sqlite-vec-encrypted/).
- **PIVOT ❌→🔀** — the v1 "brute-force fine < 100 k, no ANN" claim is **refuted at 768-d**: measured **1.2 s/query @ 58 k**. The design now requires **two-stage retrieve-then-rescore**. 256-d matryoshka top-200 → rescore 768 = **100 % recall@10 / 550 ms p95** (on adversarial synthetic data) and reuses the 256-d projection the codebase already computes. Binary quantization is ~18× faster but recall is unproven on synthetic data.
- **4 sweeps verified** (file:line) the encryption architecture, keystore/key-lifecycle, the full search-index caller list (deletion audit — no danglers; RRF reusable verbatim), and the native-build/migration surface.
- **Full design written** with a verification table + 4 operator decisions (D-1 candidate method, D-2 per-column fate, D-3 boot/unlock key ordering, D-4 migration cadence): [SEARCH-INDEX-ONDISK-PHASE1-DESIGN-2026-06-16.md](SEARCH-INDEX-ONDISK-PHASE1-DESIGN-2026-06-16.md) (now the authoritative design, upgraded from "direction").
- **Gotchas found:** vec0 rowid must be bound as `BigInt`; `bit[768]` column with no inline `distance_metric`; cipher pragma before any I/O; the Tauri bundle `rsync`s `node_modules` verbatim so native-module **bundle-load still needs verifying** (npm-install on this machine worked, prebuilt arm64).
- **The one remaining gate before code (D-1):** re-run [bench2.mjs](../spike/sqlite-vec-encrypted/bench2.mjs) against a **decrypted sample of the real vault's `embedding_768`** to choose 256-d vs binary (falsifiable: recall@10 ≥ 95 % at < 600 ms p95).

---

## 2026-06-16 session summary — start here when picking up

### What was diagnosed (the problem Phase 1 solves)
A user reported "very very slow / unresponsive app" (clicks, handle-change, chat all crawling) on a **58,711-message / 1.7 GB vault** (after the 1 GB import on 2026-06-15). Root cause, proven by 3 Explore sweeps + live `sample` profiling:
- The in-memory search index ([src/search/d1-loader.js](../src/search/d1-loader.js)) loads the **entire corpus** (decrypted content + every 768-d embedding) into the JS heap in a **58k-iteration per-row `await` loop on the main thread**. `await` over near-synchronous work yields only a *microtask* (which preempts I/O), so the loop **starves the HTTP event loop** for the whole build → the app freezes.

### The most important learning (a PIVOT — prior diagnosis was wrong)
**My first hypothesis was wrong and the sweep caught it.** I initially diagnosed a "V8 GC death spiral — heap maxed, raise `--max-old-space-size`." The sweep + live `sample` **refuted** it:
- The heap is **already 4 GB** ([src-tauri/src/main.rs:226](../src-tauri/src/main.rs) sets `NODE_OPTIONS=--max-old-space-size=4096`). It didn't show in `ps`/`top` because it's an **env var, not a CLI arg** — don't be fooled by that again.
- RSS was ~2 GB of 4 GB, and `sample` showed the hot leaf was `Builtins_StringEqual` (inverted-index token churn), **not** GC (`Scavenger` was minor).
- ⇒ The real cause is **event-loop starvation by synchronous CPU work**, NOT memory exhaustion. **Raising the heap is NOT the fix.** This is why Phase 0 fixed it with a cooperative *yield*, not more memory.

### What shipped this session (Phase 0 — PR #183, `221ab0d`)
| Change | File |
|---|---|
| Import content guard — skip no-content+no-attachment messages (mirrors captureMessage) | [src/ingest/vault-import.js](../src/ingest/vault-import.js) `restoreTable` |
| `db.messages.embedBacklog()` single-source counter (content-bearing only → `pending` reaches 0) + 4 call-site swaps | [src/db/messages.js](../src/db/messages.js), portal-activity/compat/mindscape, server-rest |
| Index excludes content-NULL rows | [src/search/d1-loader.js](../src/search/d1-loader.js) (SQL + cooperative yield) |
| **Cooperative build** — yield to the macrotask queue every 256 rows (the responsiveness fix) | [src/search/d1-loader.js](../src/search/d1-loader.js) |
| Dead-row cleanup (dry-run default, tombstone, guarded) | [scripts/cleanup-null-content-messages.mjs](../scripts/cleanup-null-content-messages.mjs) |
| Gate (7 assertions incl. deterministic event-loop-yield test) | [scripts/verify-pipeline-integrity.mjs](../scripts/verify-pipeline-integrity.mjs) |

### Operator's directional calls
- "If data null it should not enter the pipeline" → enforced fail-closed end-to-end (Phase 0).
- "Holistic, well-engineered, robust fix" → two-pillar design (integrity + scaling), Phase 0 ships now, Phase 1 designed separately.
- "Check how other repos do it — memory palace" → research done (§ below); on-disk FTS5+sqlite-vec is the consensus.
- "Continue to Phase 1" + "compact before sweeping / handoff" → this doc.

---

## Phase 1 — the target architecture (from the direction doc)
Move OFF the in-memory full-corpus index to **on-disk FTS5 (BM25) + sqlite-vec (vectors) + RRF** (Mycelium already does BM25+vector+RRF — just in RAM, rebuilt each boot). Brute-force vectors are fine < ~100k rows. This is the ecosystem standard (MemPalace = persistent ChromaDB+SQLite; sqlite-vec/FTS5 RAG guides).

**The Mycelium-specific constraint + the unlock:** the in-memory index exists *because* content+embeddings are encrypted **per-column** at rest, so FTS5/sqlite-vec can't index ciphertext. **Whole-file encryption** (`better-sqlite3-multiple-ciphers`, DB key HKDF from USER_MASTER) makes on-disk indexes encrypted-at-rest automatically → **one migration solves both the scaling problem AND the at-rest-blindness gap.** This is THE reason to do Phase 1 the SQLCipher way.

---

## Open decisions for the operator (Phase 1)
1. **Phase 1b (recommended) vs 1a fallback.** 1b = whole-file SQLCipher + FTS5 + sqlite-vec (the target; merges with at-rest-blindness). 1a = persist the built in-memory index as an encrypted blob (kills rebuild cost, stays ~2 GB resident — stopgap only). **Recommendation: 1b**, gated on the spike below.
2. **Per-column encryption fate** once whole-file encryption lands: keep for defense-in-depth, or simplify? (Security-critical — sweep must decide, don't assume.)
3. **Migration cadence** for the live 1.7 GB vault: in-place re-encrypt vs export/reimport; atomicity + rollback.

---

## Pickup protocol (execute in order — do NOT write code before step 4 passes)
1. **Read this handoff cold.** Then read [SEARCH-INDEX-ONDISK-PHASE1-DESIGN-2026-06-16.md](SEARCH-INDEX-ONDISK-PHASE1-DESIGN-2026-06-16.md) §3–§4 (target + the 6 load-bearing questions).
2. **Verify production state:** Phase 0 is on main — `git -C /Users/altus/Documents/GitHub/mycelium.id log origin/main --oneline | grep 221ab0d` (expect the #183 squash). The user still needs to **rebuild the app** for Phase 0 to take effect (installed bundle runs old source — see gotchas).
3. **Invoke `/sweep-first-design`.** Phase 1 is structural + crosses the encryption boundary → three sweep cycles minimum.
4. **RUN THE SPIKE FIRST (the gate):** does **`sqlite-vec` load + run inside a `better-sqlite3-multiple-ciphers` (encrypted) connection**? Extension loading on an encrypted DB is the one public unknown. Write a throwaway spike (`spike/sqlite-vec-encrypted/`) that: opens an encrypted DB with a key, loads sqlite-vec, creates a vec table, inserts + KNN-queries. **If it fails, Phase 1b is blocked → fall back to 1a or find another vector primitive.** Do not design further until this is answered with running code (this codebase's `oAuthProvider`-class lesson: spike, don't assume).
5. Then sweep the remaining §4 questions (live 1.7 GB migration; native-build for the Tauri sidecar on macOS arm64; per-column `ENCRYPTED_FIELDS` + scope-guardian interaction; DB-key lifecycle vs the keystore; WAL+cipher correctness/perf).
6. Write the full Phase 1 design doc with a verification table; only then implement.
7. `/deploy-and-verify` for any shippable step; `/pre-deletion-caller-audit` before deleting the in-memory index path (`loadFromDb` + the inverted index + vector Map have callers — search registry, jobs `refreshSearchIndex`, portal search).

---

## Gotchas + lessons (dated)
- **The app runs the BUNDLE, not the source (2026-06-16).** `/Applications/Mycelium.app/Contents/Resources/app/` is a built copy. Source changes (incl. Phase 0) require a **rebuild** to take effect. Diagnosing the running app = inspect the bundle/live DB, not the repo checkout. (Same lesson recurs across federation work.)
- **`--max-old-space-size` is set via NODE_OPTIONS env, invisible in `ps`/`top` (2026-06-16).** It's 4 GB. Don't re-diagnose "no heap flag" from a process listing.
- **Heap was a red herring; the cause was event-loop starvation (2026-06-16).** `sample <pid>` (macOS) is the ground-truth tool — it showed `StringEqual`, not GC. Use it before claiming GC.
- **The 19 "stuck remaining" rows = content-NULL imported by `restoreTable` (2026-06-16).** Drainer already skipped them ([messages.js selectPendingEnrichment](../src/db/messages.js)); the bug was the *counter* (`total−embedded`) including them. Phase 0 fixed both; cleanup script tombstones the rows.
- **`git stash pop` footgun (2026-06-16):** running `git stash`/`git stash pop` in the main repo accidentally popped a PRE-EXISTING stash (`stash@{0}` = `universal-memory-layer WIP`), bleeding parked work into the tree. Recovered cleanly (the stash is kept on conflicted pop). **Lesson: never `git stash pop` blind in this repo — there are 4 pre-existing stashes. Use a worktree or explicit branch, not stash, to move uncommitted files across a checkout.** The user's WIP is intact in `stash@{0}`.
- **Cleanup script needs the operator's keys** (resolveKeys → Keychain). The user runs it; agent shouldn't trigger Keychain prompts unprompted. Dry-run is read-only + structural-only (never decrypts content).

---

## Other work this session (context, not Phase 1)
- **PR #175 (`4aa507c`)** — model-aware text generation + token-usage accounting + native local `/api/chat` adapter. MERGED. (See [[textgen-abstraction-design]] memory.) Live-smoked + full E2E. Not related to the slowness (wasn't deployed on the affected build).
- Note: this session was driven from worktree `gracious-shamir-d1d1f4`; Phase 0/handoff work was done in the **main repo checkout** on branches off `origin/main`.

---

## Verification commands (re-confirm on pickup)
```
# Phase 0 on main:
git -C /Users/altus/Documents/GitHub/mycelium.id log origin/main --oneline | grep 221ab0d
# expect: 221ab0d Pipeline integrity (null content) + cooperative search build (#183)

# Phase 0 gate still green:
cd /Users/altus/Documents/GitHub/mycelium.id && npm run verify:pipeline-integrity   # VERDICT: GO

# Live vault size / dead-row count (read-only):
sqlite3 "file:$HOME/Library/Application Support/id.mycelium.app/mycelium.db?mode=ro" \
  "SELECT COUNT(*) total, SUM(content IS NULL OR content='') AS content_null FROM messages WHERE user_id='local-user';"
```
