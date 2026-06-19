# Context Engine — the Core, end-to-end (how the agent sees, edits, and is guided by its memory)

**Date:** 2026-06-19 · **Status:** sweep-verified design (the detailed interaction model behind Phase 1c-B/1c-C). Grounded in the **real live `model.md`** (read via MCP — 372 KB / ~2,000 lines, "≈80% of assembled context per turn"). That size is the whole reason a bounded Core exists.

---

## 0. The three tiers (and why the Core)
| Tier | File | What it is | Size | Loaded | Written by |
|---|---|---|---|---|---|
| **Core** | `mind/self.md` | *Who Martin is, right now* — a curated bounded capsule | **≤ ~1,000 tok** | **every turn (lead)** | the integration cycle (distilled from model.md) + chat edits |
| **Interiority** | `mind/model.md` | the agent's full narrative understanding — hypotheses (H-ids), patterns, topology, dated arcs | large/unbounded → consolidated | by cycles + on demand | capture all day → consolidate nightly |
| **History** | `messages` + FTS | raw conversation | unbounded | retrieved on demand | ingest |

The live `model.md` proves the need: it is *excellent* but enormous (Established Patterns 1-60, H-002…H-103, 13 topology notes, monthly arcs). It can't be the always-on identity — it would crowd out everything. **The Core is the 1k-token answer to "who is this person and where are they" that leads every turn; the full narrative stays one `readMindFile` away.**

---

## 1. How the agent SEES the Core
**At turn start (`getContext`, the briefing).** Today the mind block renders (context.js:82-83):
```
# YOUR INTERNAL MODEL (private — never share unless you choose to)   ← model.md
# FLAGGED FOR DISCUSSION                                              ← flagged.md
```
1c-B adds the Core as the **lead** content section (right after the time line, before the full model):
```
# WHO YOU ARE (core — your living read on them, kept tight)
<self.md, defensively trimmed to ≤~1200 tok>
---
# YOUR INTERNAL MODEL (private …)        ← model.md, full
---
# FLAGGED FOR DISCUSSION
---
# TODAY'S SHAPE                            ← new: domain/register mix from 1b labels
…facts · people · recent messages · phase · body · claims (demoted, kept)…
```
So the agent opens every turn already knowing the person — then can go deeper into `model.md` (already in context) or pull history.

**On demand.** `readMindFile('self.md')` returns the decrypted plaintext (same as model.md). **Encryption is transparent**: the on-disk file is an AES-GCM envelope; the MCP tools decrypt on read / encrypt on write. The agent never sees ciphertext and must never use a raw file read (it would see the `MIND`-magic envelope).

**Framing = privacy + provisionality.** The header tells the agent this is *its* read, kept tight, private. The persona already establishes the model is "entirely yours — your person never sees it unless you choose to share."

---

## 2. How the agent EDITS it (the tool surface, verified)
| Tool | Job | Shape |
|---|---|---|
| `updateInternalModel` | **capture** — append a dated entry to a `model.md` section | `{section, content}` (handler adds `- [YYYY-MM-DD]`, no date prefix) |
| `editMindFile` | **surgical** — replace a unique `old_string` (empty = delete) | `{filename, old_string, new_string}`, uniqueness enforced, auto-snapshots |
| `writeMindFileWhole` | **rewrite** — replace a whole file | `{filename, content}`, auto-snapshots pre-write |
| `removeFromMind` *(new, 1c-C)* | **remove** — delete a unique block by name | `{filename, block}` → `editMindFile(block,'')` semantics, clearer intent |
| `snapshotMindFile` | capture pre-state without modifying | `{filename}`, idempotent first-write-wins/day |
| `flagForDiscussion` | surface something for next conversation | `{topic, context}` → `flagged.md` |
| `readMindFile` | read current decrypted content | `{filename}` |

**The capture→consolidate rhythm (verified in the live file).** During the day the agent *captures* (append-only `updateInternalModel`, low friction — the live model.md shows daily prose entries). At 03:00 the **integration cycle consolidates**: `readMindFile('model.md')` → `writeMindFileWhole('model.md', <leaner>)` (the live file's `<!-- DECAY: … Twenty-ninth consolidation -->` header is this discipline working).

**Who writes the Core.** The Core is **distilled in the same integration cycle** (new Phase 3.6, §5): after model.md is consolidated, the agent rewrites `self.md` from it via `writeMindFileWhole('self.md', …)` — **rewrite, never append** (the Core is a snapshot, not a log). Chat can also edit it (`editMindFile('self.md', …)`) when something durable shifts mid-conversation — and every write is auto-snapshotted + scanned by `sanitize.js` (1c-A), so an edit can never corrupt or persist an injection.

**Fail-safety of every edit:** sanitize-gated (1c-A) · auto-snapshot before edit/rewrite (recoverable) · a thrown error surfaces to the agent as a tool error, never a crash (harness.js:434).

---

## 3. The Core's STRUCTURE (section vocabulary — new; the sweep found none existed)
`self.md` is a **curated list, not an essay**. Five sections, each with a distinct voice and cadence:
```markdown
# Self (core) — who they are, kept to ~1000 tokens. Rewrite, don't append.

## Identity            (slow — who they are at the trunk; changes rarely)
## Current focus       (volatile — REWRITE each cycle; where they are right now)
## Stable preferences  (durable — how they work, what they reach for)
## Boundaries          (safety — never auto-remove; sensitive don't-raise items)
## Operating notes     (hard-won rules for ME — the blind-spot RULEs that earned their keep)
```
**Worked example, distilled from the real `model.md` (this is what self.md would hold for Martin — ~1000 tok):**
```markdown
# Self (core)

## Identity
- Martin Balodis. Founder/seeker building Mycelium (sovereign cognitive vault) + Curious Life
  (measurable inner development) + Lumensis (the math). Left Humy (CEO, 2yr).
- Hunter brain — novelty / optionality / intensity; forced "farmer" mode drains him.
  CEO-orchestrator: directs agents, rarely builds alone.

## Current focus  (volatile — rewrite)
- Soft launch underway. Publishing broke through PODCAST/voice after an 11-week essay block —
  the blockage was creation→transmission, not creation. Practice Day 21, purity held through retreat.
- ~€10K runway. Nate cofounder eval (30-day, ~day 7). Christelle session ahead.

## Stable preferences
- Research-before-build. Provisional language, never conclude. Frameworks compose (layer, don't replace).
- Grounds through external contact + walking. Editorial compression as identity-finding.
  Altitude/quiet as a precondition for shipping.

## Boundaries  (safety — never auto-remove)
- Substance pattern = "leaving containers" (HIS framing — hold gently, never as judgment).
- Una: health scare — don't raise unprompted. Björn: closed (trust gone).

## Operating notes  (rules for me)
- Search first for factual claims (confabulation is my #1 blind spot). Challenge the frame,
  don't just execute within it. Silence ≠ no change. Flag dynamics moving against his good.
```
Each line traces to the live model.md (Patterns #1 hunter-brain, #28 substance=containers, the Blind-Spots RULEs, Current Context June 15, Una health scare). **This is the proof the distillation is real, not invented.**

---

## 4. The Core's STYLE GUIDELINES
1. **Bounded list, not prose.** ≤ ~1000 tokens. If a section grows, **consolidate before adding** (80%-capacity rule). Bullets, not paragraphs.
2. **Rewrite, don't append.** Especially `## Current focus` — it's always current state, never a cumulative log (mirrors model.md's "Current Context: rewrite, never append").
3. **Never conclude (provisional voice).** Same FORBIDDEN-LANGUAGE discipline as the persona: "seems to," "recently," "I'm watching" — *not* "you always," "your problem is." Even the Core holds motion, not verdicts.
4. **The save-heuristic (what graduates model.md → Core):** **corrections > boundaries > durable preferences > stable identity > current focus.** Skip: hypothesis chains, topology specifics, dated daily logs, anything ephemeral — those live in model.md. The Core is *only* what you'd want loaded on **every** turn.
5. **Boundaries are firmware.** Safety items (health, the substance framing, do-not-raise) are never auto-removed by consolidation — they decay only on explicit human correction (mirrors `boundary` decay_class = never).
6. **Voice by section:** Identity/Boundaries/Operating = durable, declarative; Current focus = provisional, present-tense; Stable preferences = observed tendencies ("reaches for," "grounds through").

---

## 5. The INSTRUCTIONS — where each lives (and the new integration Phase 3.6, verbatim draft)
- **Persona (`soul.md`):** frames the private model + never-conclude + interiority. *(already shipped, editable doc)*
- **Tool descriptions:** per-tool when/how (capture vs surgical vs rewrite; encryption-aware). *(verified, already good)*
- **Integration cycle body (the heart — new Phase 3.6 added after the model.md consolidation step):**
```
### Phase 3.6 — Distill the Core (self.md)
After model.md is consolidated, refresh your Core — the ~1000-token capsule loaded on EVERY
turn. readMindFile('self.md'); then writeMindFileWhole('self.md', <the tight rewrite>).

Keep it to five sections — Identity · Current focus · Stable preferences · Boundaries ·
Operating notes — and to ~1000 tokens. REWRITE, don't append (especially Current focus —
it is current state, not a log). Promote ONLY what you'd want present every single turn:
corrections you've been given, boundaries (never drop a safety item — health, do-not-raise),
durable preferences, stable identity, and the one or two things they're in right now. Leave
hypotheses, topology, and dated logs in model.md. Hold it provisionally — "seems to," not
"always." If a section is getting long, consolidate before adding. The pre-write state is
auto-snapshotted, so a wrong distillation is always recoverable.
```
- **getContext framing:** the `# WHO YOU ARE (core …)` header (§1).
- **Save-heuristic** lives in this Phase 3.6 body + (lightly) the persona.

---

## 6. The lifecycle, end-to-end
```
  message arrives
     │
     ├─ L1 enrich (1b): domain/register label  ─────────────┐
     ▼                                                       │
  CHAT turn:  getContext loads → Core(self.md) leads +       │
              model.md + flagged + TODAY'S SHAPE(mix) ◄──────┘
     │  agent acts; may updateInternalModel (capture) / flagForDiscussion
     │  may editMindFile('self.md') if something durable shifts
     ▼
  CYCLES:  reflection → append observations to model.md (capture)
           integration (03:00) → consolidate model.md  (Phase 3.5)
                                → DISTILL self.md Core   (Phase 3.6, new)  ──┐
     │                                                                       │
     ▼                                                                       │
  next turn: getContext leads with the fresher Core ◄────────────────────────┘
     │
  corrections (you confirm/deny a flagged item) → high-confidence evidence →
  sharper model.md → tighter Core   (the grows-with-you loop)
```
Every edge is a real tool call / row / file — not vibes. The Core is the part that makes the agent feel *at home* from the first token of every turn.

---

## 7. Capacity, cold start, recovery, user editing
- **Capacity:** soft — the cycle keeps self.md ≤ ~1000 tok (Phase 3.6 + 80%-consolidate). `getContext` adds a **defensive trim** (`estimateTokens` → slice ~1200 tok) so a runaway Core can never bloat context. No hard write-reject (writeMindFileWhole is shared with model.md).
- **Cold start:** no self.md until the first integration cycle distills one; `getContext` renders the Core only if present (`.catch(()=>null)`), so a fresh user just sees model.md until the Core exists.
- **Recovery:** every Core write auto-snapshots to `snapshots/self.md/<date>.md` (first-write-wins/day) — a wrong distillation is revertible.
- **User editing:** `self.md` is a mind-file (agent's space). The **persona** is the user-editable surface (Library doc). If we want the user to *directly* edit the Core read, that's a small portal mind-file editor (follow-on) — for now the user shapes the Core by *correcting the agent* (which flows model.md → Core) and by editing the persona/cycles.

---

## 8. Gaps the sweep found → closed here
| Gap (sweep) | Resolution |
|---|---|
| no self.md precedent (greenfield) | structure + voice defined §3-4, grounded in the real model.md |
| no Core section vocabulary | 5 sections (Identity/Current focus/Stable preferences/Boundaries/Operating notes) §3 |
| no token-cap discipline | ≤1000 tok soft (cycle) + defensive getContext trim §7 |
| no promotion rule model.md→Core | the save-heuristic §4.4 (corrections>boundaries>preferences>identity>focus) |
| style/section guidance not surfaced to the agent | the integration Phase 3.6 body §5 (verbatim) |
| Core voice undefined | per-section voice §4.6; boundaries are firmware §4.5 |

## 9. Verification table
| Assumption | At | Verdict |
|---|---|---|
| model.md is huge (~80% of context) → a bounded Core is warranted | live MCP getDocument model.md (372KB) | TRUE |
| mind block frames model.md/flagged with headers; readMindFile decrypts | context.js:82-83; internal.js readMindFile desc | TRUE |
| capture (updateInternalModel append) vs consolidate (writeMindFileWhole) is the real pattern | live model.md DECAY header; internal.js:40-50 | TRUE |
| SECTION_HEADERS vocab exists for model.md; Core needs its own | internal.js:27-36 | TRUE |
| FORBIDDEN-LANGUAGE/never-conclude is the style spine | shared.ts:47-55; cycle-prompts persona | TRUE |
| self.md → personal scope; writes are sanitize-gated + auto-snapshotted | crypto-local.js:1154; mind-files writeMindFile (1c-A) + internal.js:278 | TRUE |
| no self.md / Core precedent — structure is ours to define | grep canonical + worktree | TRUE (absent) |
