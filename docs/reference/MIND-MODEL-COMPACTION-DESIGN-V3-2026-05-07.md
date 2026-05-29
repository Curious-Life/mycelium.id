# mind/model.md Compaction — Design v3 (2026-05-07 evening)

**Status:** Design after full `/sweep-first-design` re-sweep. v2 was insufficient (Phase 3/3.5 conflict, double-date bug, weekly-decay structurally broken). v3 expands scope. Architecture: **one tool per purpose, capture-then-consolidate workflow, weekly-decay merged into integration.** Operator directive: *"intuitive and reliable for the agent."*

Companion docs:
- [MIND-MODEL-COMPACTION-DISCOVERY-2026-05-07.md](./MIND-MODEL-COMPACTION-DISCOVERY-2026-05-07.md) — full discovery + v1/v2 history
- [MIND-MODEL-COMPACTION-BRIEF-FOR-MYA-2026-05-07.md](./MIND-MODEL-COMPACTION-BRIEF-FOR-MYA-2026-05-07.md) — Mya's structural input
- [AGENT-RELIABILITY-HANDOFF-2026-05-07.md](./AGENT-RELIABILITY-HANDOFF-2026-05-07.md) — broader reliability context

---

## 1. Why v2 was insufficient

| v2 assumption | What sweep revealed |
|---|---|
| Dedup discipline in Phase 3.5 prompt fixes the bloat | Phase 3 (older instruction) prescribes `updateInternalModel`, conflicts with Phase 3.5 dedup demand. **Tool prescription beats discipline** every time. |
| Edit is the right primitive for dedup | Edit's uniqueness constraint **catastrophically fails** on duplicate headers, pattern clusters, and identical lines. Write+snapshot wins for first-pass cleanup. |
| `updateInternalModel` is fine as-is | Auto-prefix bug → **153 double-dated entries** in Apr 26-29 window. Tool description gives no format guidance. Agent cargo-culted `[YYYY-MM-DD]` into content. |
| Integration cycle is the only relevant write path | **5 cycles per day** prescribe (or imply) append-only writes to model.md. Weekly-decay structurally broken (says "remove" but prescribes append-only tool). |

After today's manual /think fire (commit `2a13ecf` + `2b46f57` deployed), Mya:
- Used `snapshotMindFile` correctly for `topology-notes.md` and `flagged.md` (the discipline works where there's no conflicting Phase 3 instruction)
- Used `updateInternalModel` 4× for model.md (followed Phase 3's prescription, skipped Phase 3.5)
- Created **H-005 collision** (line 1217 — different content from existing line 1150)
- Did NOT shrink the file (still 376,946 bytes / 2,204 lines after cycle)

The architecture needs to be **structurally** correct, not just prompt-correct.

---

## 2. v3 architecture — one tool per purpose

| Operation | Tool | Cadence | Why |
|---|---|---|---|
| **Capture observation** (in conversation, in any cycle's Phase 3 update step) | `updateInternalModel` | any time | Append-only, low-friction. Works the same whether agent is in chat or cycle. The duplication that results gets reconciled at consolidation time. |
| **Consolidate model.md** (dedup + lifecycle in one pass) | `snapshotMindFile` + `Write` | integration cycle daily (03:00 UTC) | Heavy work concentrated in one place. One snapshot, one rewrite. Eliminates Edit-uniqueness brittleness. |
| **Surgical fix** | `Edit` | rare maintenance | When the agent knows exactly what to replace and that text is unique. |

The agent's mental model becomes: **capture freely all day; the cycle reconciles each night.** No conflicts, no conditional tool selection.

### 2.1 What changes

- **`updateInternalModel`** stays as the canonical "add an observation" tool. It auto-prefixes today's date (existing behavior); now it also strips a leading `[YYYY-MM-DD]` from `args.content` to prevent double-dating.
- **Phase 3.5 of integration cycle** is rewritten from "Dedup discipline" (Edit-based, conflicting) to **"Consolidation"** (snapshot + Write, unconditional, replaces weekly-decay's role too).
- **Weekly-decay cycle is deleted** — merged into integration. Lifecycle work (stale removal, hypothesis promotion, archival) happens in the daily Write, not a separate weekly cycle.
- **Other cycles** (morning, midday, evening, triage, weekly-review, daily-post) keep using `updateInternalModel` for their internal-model writes. They're capture-mode-only by design; integration handles consolidation.

### 2.2 What stays

- **`snapshotMindFile`** primitive (atomic copy, idempotent same-content same-day, generic across mind/ files) — already shipped in commit `2a13ecf`.
- **Atomic writeMindFile** with .tmp+rename + recursive parent dirs — already shipped.
- **Operating-instructions structural protection** (PR-G in v2 §0.4) — still planned, unchanged.

---

## 3. The four PRs

### PR-C — Tool-level date-strip + description clarity

**File changes:**
- [packages/tools/agent-tools/domains/internal.js](../packages/tools/agent-tools/domains/internal.js) — `updateInternalModel` handler strips leading `[YYYY-MM-DD]` (with optional `[YYYY-MM-DD]` repeats) before prefixing. Tool description gains: *"Do NOT include a date in `content` — the handler adds today's date automatically. Use the `section` parameter to categorize."*
- [packages/tools/agent-tools/domains/documents.js](../packages/tools/agent-tools/domains/documents.js) — `updateDocument` handler same fix.
- Tests: existing pass; add coverage for date-stripping (single, double, triple, no-date input).

**LOC budget:** ~30 (handler logic + 5 new tests).
**Independent:** ships standalone. Stops new double-dates immediately.

### PR-D — Cycle prompt restructure + weekly-decay merge

**File changes:**
- [packages/core/scheduler.js](../packages/core/scheduler.js) PROMPTS:
  - **`dream` (integration) cycle Phase 3.5:** rewritten from "Dedup discipline" (Edit-focused) to **"Consolidation"** (snapshot + Write the whole file, dedup + lifecycle in one pass). Daily cadence absorbs weekly-decay's role.
  - **`weeklyDecay` removed from PROMPTS** entirely.
  - **`DEFAULT_CYCLES` updated**: remove the weekly-decay entry (line 147).
  - Other cycle prompts unchanged (they continue to use `updateInternalModel` for capture, which is now safe due to PR-C's date-strip).

**Operational migration:**
- Admin's `wake-cycles.json` has a `weekly-decay` entry — needs to be removed via SSH-side edit (operator action, not committable). Same for customer fleet ([customer-handles]'s missing model is irrelevant).

**LOC budget:** ~80 lines of prompt text + ~20 LOC config delta.
**Depends on:** PR-C (so capture-mode tool stays safe).

### PR-E — Manual cycle fires until verified

**Action:** trigger /think with the new dream prompt repeatedly (every 30-60 min) until model.md stabilizes.

**Validation criteria per fire:**
- File size delta (target: 376 KB → 200 KB over 1-3 cycles)
- Snapshot directory has dated snapshots
- No double-dated lines in new content (`grep -c "^- \[20.*\] \[20" model.md` should not increase)
- `## undefined` section migrated/removed
- H-id collisions resolved (one entry per H-id)
- Daily-summary entries per date ≤ 5 (currently up to 38)

**Cease firing when:** size stable across 2 consecutive cycles AND no validation criterion regresses.

### PR-F — One-shot cleanup of 153 stale double-dated entries

**Action:** SSH to admin, snapshot, then sed-fix the 153 entries that date from Apr 26-29 burst (when the bug was active before PR-C).

**Why operational, not code:** these entries are data, not code. A sed transform is safer and more deterministic than relying on Mya's Write to fix them naturally during PR-E. Also fixes them before her consolidation pass — fewer artifacts for her to reason about.

**Procedure:**
```bash
# (on admin)
cp mind/model.md mind/snapshots/model.md/2026-05-07-pre-sed.md  # belt-and-suspenders snapshot
sed -i 's/^\(- \[[0-9-]\+\]\) \[[0-9-]\+\]/\1/g' mind/model.md
# verify count = 0
grep -cE '^- \[[0-9-]+\] \[[0-9-]+\]' mind/model.md
```

**Risk:** sed runs on a file Mya might have open via Read in an active session. Acceptable — Read tool reads at call time; doesn't hold the file. Worst case: session has a stale view. No corruption risk (single sed transform, deterministic).

---

## 4. Sequencing

| # | Step | Dependencies | Estimated cost |
|---|---|---|---|
| 1 | Write this design doc | — | done |
| 2 | Implement PR-C (tool fixes) + tests | — | 15 min |
| 3 | Implement PR-D (cycle restructure + weekly-decay delete) | PR-C | 20 min |
| 4 | Run all tests, commit, push | 2+3 | 5 min |
| 5 | Sign cert + admin pull + scheduler restart | 4 | 5 min |
| 6 | Operational: remove weekly-decay from admin's wake-cycles.json | 5 | 2 min |
| 7 | PR-F: SSH sed cleanup of 153 stale entries | 5 | 2 min |
| 8 | PR-E: manual /think fire | 6+7 | 30-60 min runtime per cycle |
| 9 | Repeat 8 until validation criteria met | 8 | 1-3 cycles |
| 10 | Customer fleet rollout (Mya cleared simultaneous) | criteria met | 5 min |

Total wall-clock to admin verification: ~1.5 hours (mostly cycle runtime).

---

## 5. Verification table

| # | Assumption | Verified at |
|---|---|---|
| 1 | `updateInternalModel` auto-prefixes `- [YYYY-MM-DD] ` | [internal.js:71-72](../packages/tools/agent-tools/domains/internal.js#L71-L72) |
| 2 | `updateDocument` auto-prefixes `[YYYY-MM-DD] [type] [confidence]` | [documents.js:472-474](../packages/tools/agent-tools/domains/documents.js#L472-L474) |
| 3 | `flagForDiscussion` uses suffix not prefix (lower bug risk) | [internal.js:112-113](../packages/tools/agent-tools/domains/internal.js#L112-L113) |
| 4 | Tool description for `updateInternalModel` gives no format guidance today | [internal.js:40-50](../packages/tools/agent-tools/domains/internal.js#L40-L50) |
| 5 | `snapshotMindFile` already exists and is idempotent | [internal.js (handler)](../packages/tools/agent-tools/domains/internal.js) |
| 6 | Atomic writeMindFile with recursive mkdir | [mind-files.js:47-65](../packages/tools/agent-tools/mind-files.js#L47-L65) |
| 7 | Phase 3 of integration cycle prescribes `updateInternalModel` | scheduler.js dream cycle, line ~792 |
| 8 | Phase 3.5 (current) demands Edit — conflicts with Phase 3 | scheduler.js dream cycle, line ~797-858 |
| 9 | weeklyDecay cycle prescribes removal but no removal tool | scheduler.js, line 962-983 |
| 10 | Triage cycle explicitly prescribes `updateInternalModel` | scheduler.js, line 898 |
| 11 | Morning, evening, midday, weekly-review cycles all default to `updateInternalModel` (vague "update internal model") | scheduler.js cycle prompts |
| 12 | Edit's uniqueness constraint fails on duplicate `## Where I Might Be Wrong` | sweep finding (no current duplicate, but pattern documented) |
| 13 | `replace_all: true` is unsafe when 4× duplicates have different surrounding context | sweep finding (Edit feasibility analysis) |
| 14 | 153 double-dated entries currently exist in admin model.md, all Apr 26-29 | SSH inventory 2026-05-07 12:30 UTC |
| 15 | Daily summary entries spike to 25-38 per date (top: 38× 2026-05-03, 2026-04-28) | SSH inventory |
| 16 | H-007 update chain has 13+ entries including verbatim duplicates at lines 1047/1054, 385/398 | SSH inventory |
| 17 | `## undefined` section exists at line 2175 | SSH inventory |
| 18 | No duplicate L2 section headers currently (Mya cited some earlier — quietly cleaned) | SSH inventory |
| 19 | wake-cycles.json on admin has `weekly-decay` entry, schedule `weekly:0:4`, last_run 2026-05-03 | SSH inspection |
| 20 | scheduler.js routes cycles via getPromptForCycle; null prompt = cycle skipped | scheduler.js, line ~480 |
| 21 | Manual snapshot was taken at 12:18 UTC, 376,946 bytes, MD5 ca8bba70... | filesystem inspection |
| 22 | Mya used snapshotMindFile correctly for topology-notes.md + flagged.md in this morning's cycle | session log e1562517 |
| 23 | Mya created H-005 collision (line 1150 = "Psi experiment", line 1217 = "Anchor Band Convergence Limit") | SSH grep |

---

## 6. Risks + mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| sed-cleanup of 153 entries (PR-F) catches a false positive (line that was legitimately double-bracketed) | Low | Pre-sed snapshot + post-sed grep verify count went from 153 → 0; spot-check 5 entries manually |
| Mya's Write during consolidation produces something worse than current state | Medium | snapshotMindFile is unconditional (PR-D maintains this rule); operator can review and restore from snapshot if regression |
| Weekly-decay merge loses lifecycle semantics that aren't part of compaction (e.g., "promote well-established hypotheses") | Medium | Phase 3.5 v3 prompt explicitly mentions both compaction AND lifecycle (stale removal, promotion, archival). Combined as "consolidation." |
| PR-E's manual cycles consume Claude API budget excessively (50 max-turns × N cycles) | Low | Cease firing once size stabilizes; budget cap is N=3 cycles unless something's clearly wrong |
| Customer fleet rollout exposes a bug we didn't catch on admin | Medium | Hold rollout until admin verified for ≥24h; staged: stage-rollout one host at a time |

---

## 7. Open questions resolved during sweep

- **Q: Is Mya following an explicit instruction to include `[YYYY-MM-DD]` in content?** A: No. No prompt or persona text instructs this. It's cargo-cult behavior, possibly mirroring `flagForDiscussion`'s output format. Tool description doesn't disambiguate.
- **Q: Are duplicate L2 section headers still present?** A: Not currently — must have been quietly merged. Risk class understood; rule 4 of Phase 3.5 still applies prophylactically.
- **Q: Can Edit actually solo a 30-40% dedup pass?** A: No. Uniqueness constraint fails on the most common patterns. Write+snapshot is the right tool.
- **Q: Should `updateInternalModel` reject H-id collisions?** A: No (deferred). Adds runtime check that surprises the agent. Let consolidation Write handle it.

## 8. Open questions deferred (post-shipping observation)

- **How does cross-fleet engagement affect cycle frequency / volume?** A small customer is at 69 KB; customer-fleet integration cycles will produce minimal Write payload. Validate with telemetry once fleet rolled.
- **Is the 200 KB target right?** Possible that consolidated model.md sits at 250-300 KB and that's fine. Decide after observing 7 days.
- **Operating-instructions extraction (PR-G in v2 §0.4)** — still planned but independent. Lands when convenient.

---

## 9. Definition of done

PR-C+D shipped admin AND verification ledger green:
- ✓ Tool tests pass (≥35/35)
- ✓ deploy-and-verify post-deploy ≥21 pass / 0 fail
- ✓ scheduler.js Phase 3.5 contains "snapshot first, Write to consolidate"
- ✓ scheduler.js no longer has `weeklyDecay` in PROMPTS
- ✓ admin wake-cycles.json no longer has weekly-decay entry
- ✓ admin model.md double-dated count = 0 (post PR-F)

PR-E definition of done: model.md size stable across 2 consecutive integration cycles AND <250 KB.
