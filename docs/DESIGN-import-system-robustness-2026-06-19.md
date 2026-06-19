# DESIGN — Robust, Unified Import System (timestamp-correct by construction)

**Date:** 2026-06-19
**Status:** Locked design (sweep-first), NOT yet built.
**Author trail:** sweep-first-design protocol, 5 Explore sweeps + 3 self-verification reads.
**Trigger:** Recovery of mis-stamped documents (Jun-16 incident) surfaced the question — *is our import system robust enough that no source ever produces wacky timestamps?* Answer today: **messages yes, documents no, detection fragmented.**

---

## 0. Headline

The vault has **one excellent pattern (messages)** and several **ad-hoc weak ones (documents, detection, per-source schema)**. The message path funnels every source through a single choke-point — `captureMessage()` → `normalizeCreatedAt()` — and is correct. The **document path has no equivalent**: timestamps are set raw, per-path, with two confirmed corruption mechanisms and a silent `now()` fallback that produces exactly the date "cliffs" we just spent a session repairing.

This design lifts the message pattern to a **universal import spine** and adds **timestamp provenance** so a fallback-to-now is *flagged and counted*, never silent.

---

## 1. How the system works today (as-built, verified)

### 1.1 Entry points — NOT one module

| Entry | File:line | Detection? | Routes to |
|---|---|---|---|
| ZIP upload (Claude/ChatGPT/Mycelium/Obsidian-zip) | `src/portal-uploads.js:104-138` | `detectExportType()` | per-type parser |
| `importMessages` MCP tool | `src/tools/ingest.js:98` | none (pre-structured) | `captureMessage` |
| HTTP `/ingest/message`,`/ingest/import` | `src/server-http.js:580,626` | none | `captureMessage`/`importMessages` |
| Native push `/ingest` (Apple) | `src/portal-ingest.js:31` | none | `captureMessage` |
| Connector backfill (Gmail/Linear) | `src/connectors/scheduler.js:167` | none | `captureMessage` |
| Obsidian folder import | `src/portal-import.js:25` → `obsidian-import.js` | none | `saveDocument` + `captureMessage` |
| Full-export restore (canonical migration) | `src/ingest/full-export-import.js` | none | `restoreTable` |
| Vault-export restore (zip+manifest) | `src/ingest/vault-import.js` | `detectExportType` | `restoreTable` |

**Detection (`detectExportType`, `import-parsers.js:82-117`) is ZIP-only**, returns: `mycelium | mycelium-oversized | chatgpt | claude | obsidian | linkedin | unknown`. `obsidian` and `linkedin` from the ZIP path are **stubbed "not supported yet"** (`portal-uploads.js:134-135`) even though a *separate, working* obsidian importer exists at `obsidian-import.js`.

### 1.2 Messages — the good pattern (KEEP, generalize)

Every message route ends at `captureMessage()` (`capture.js:106`), which calls `normalizeCreatedAt(msg.createdAt)` (`capture.js:150`):

```js
// capture.js:45-62 — verified
export function normalizeCreatedAt(v) {
  if (v == null) return null;
  // Date | epoch-sec | epoch-ms (magnitude split at 1e12) | numeric-string | ISO-8601
  ...
  return d.toISOString(); // UTC Z
}
```

Missing/invalid → `null` → column DEFAULT `now()` (`capture.js:150-151`). Dedup is `id`-keyed with a `content_hash` change-detector (`capture.js:159-189`). **No bypasses. This is correct.**

### 1.3 Documents — the weak pattern (FIX)

- **No normalization.** `saveDocument` passes `createdAt` straight through: `if (createdAt !== undefined) doc.created_at = createdAt;` (`core/document-store.js:388`). No `normalizeCreatedAt` analog for docs.
- **Bug A — upsert clobbers created_at.** `documents.upsert` builds the ON-CONFLICT `SET` from *all* non-key columns: `setClause = updateCols.map(c => `${c} = excluded.${c}`)` (`db/documents.js:116-117`). So a re-import with a *fresh* mtime overwrites the original creation date. **`created_at` is immutable by definition; it must never appear in an UPDATE.**
- **Bug B — restore silently defaults created_at.** `restoreTable` only inserts columns present on the row: `keys = Object.keys(r).filter(k => cols.has(k) && r[k] !== undefined)` (`vault-import.js:101`). A row lacking `created_at` → `INSERT` without it → schema DEFAULT `now()`. `restoreTable` is `INSERT OR IGNORE` (`vault-import.js:104`), so it does *not* clobber on re-run — but it *does* stamp import-time on first insert of any timestamp-less row.
- **The Jun-16 cause, from the code's own comment** (`full-export-import.js:219-228`): agent docs are rebuilt by walking the `agents/` directory and using file mtime — but *"the decrypted bundle's file mtimes are the export's own write times, not the file's true authored date."* So 754 agent docs got the export date (Jun-15). Regular docs from `documents.ndjson` survive **only if** that NDJSON carried `created_at`.

### 1.4 Per-source schema understanding (gaps)

| Source | Parser | Timestamp read | Correct? |
|---|---|---|---|
| Claude.ai export | `import-parsers.js:154` | `chat_messages[].created_at` (ISO) | ✅ |
| ChatGPT export | `import-parsers.js:199` | `create_time` (epoch-sec) | ✅ |
| Obsidian (folder) | `obsidian-import.js:344` | file **mtime** | ⚠️ mtime, not frontmatter `created`/filename date |
| LinkedIn | — | — | ❌ detected, **no parser** |
| Apple Health | `db/health.js:42` | daily row `updated_at = now()` | ⚠️ not measurement time |
| Generic file upload | `portal-uploads.js:248` | none → `now()` | ❌ ignores client `lastModified` |
| Legacy bulk (`import_chatgpt`,`claude_export`,`import_claude`) | **not in this repo** (`grep`: comments only, `document-store.js:247`) | — | imported by canonical migration |

---

## 2. Design — the unified import spine

### 2.1 Principles

1. **One timestamp authority for messages AND documents.** Lift `normalizeCreatedAt` into `src/ingest/timestamp.js`; both paths use it. UTC-normalized, format-tolerant.
2. **`created_at` is immutable.** It is set once, on first insert, and is *never* in any UPDATE/upsert SET clause. `updated_at` is the only mutable timestamp.
3. **Provenance, not silence.** Every imported record carries `metadata.ts_provenance ∈ {source-field, file-mtime, frontmatter, filename, inferred-now}`. A `now()` fallback is *recorded as `inferred-now`* and **counted in the import reconciliation report** — so a date cliff is loud at import time, not discovered months later.
4. **One source-adapter shape.** Each importable source is a small module implementing a common interface (detect/parse/timestamp). Adding a source = adding one adapter; the orchestrator and storage never change.
5. **Exporter is the source of truth for timestamps.** A restore can only preserve what the export carried. Export must serialize true `created_at` for every row and true authored mtime for every agent file.

### 2.2 Module shape

```
src/ingest/timestamp.js          (~40 LOC, lifted)
  normalizeTimestamp(v, {assumeTZ='UTC'}) -> ISO|null   // = current normalizeCreatedAt + tz rule
  deriveCreatedAt(record, sourceSpec)     -> { iso, provenance }

src/ingest/sources/                (one file per source, ~30-80 LOC each)
  index.js        -> SOURCE_ADAPTERS registry
  claude.js, chatgpt.js, obsidian.js, linkedin.js, mycelium-vault.js, generic-file.js
  // each: { id, detect(input)->bool, parse(input)->AsyncIterable<Record>, timestampOf(record)->{iso,provenance} }

src/ingest/run-import.js           (~120 LOC) — the ONE orchestrator
  runImport(input, {db,userId}) :
    pick adapter via detect()  → parse() → for each record:
      record.kind==='message' ? captureMessage(...) : saveDocument(...)
    accumulate {created, deduped, skipped, ts_provenance_histogram}
    return reconciliation report (incl. inferred-now count)
```

`Record` shape (uniform): `{ kind:'message'|'document', id?, content, role?, path?, title?, source, createdAt, tsProvenance, metadata }`.

### 2.3 The two bug fixes (highest value, smallest diff)

**Fix A — `db/documents.js:116-117`:** exclude `created_at` from the ON-CONFLICT SET. Keep earliest on legitimate re-import:
```js
const IMMUTABLE = new Set(['user_id','path','created_at']);
const updateCols = Object.keys(doc).filter(c => !IMMUTABLE.has(c));
// + always bump updated_at; preserve the existing created_at untouched.
// (If a future caller MUST lower created_at, do it via an explicit, audited repair tool — not the import path.)
```

**Fix B — `restoreTable` (`vault-import.js`):** when a restore row lacks `created_at`, do **not** silently accept `now()`. Set `created_at` explicitly to the best available (`overrides.created_at` the caller computed) and **count rows that fell back to import-time** in `out.inferredNow`, surfaced in the reconciliation report. Agent-file walk keeps passing mtime, but the report now flags "N docs stamped import-time."

### 2.4 Timezone rule (explicit)

`normalizeTimestamp` keeps the current magnitude-split (epoch-sec/ms) and ISO parsing. New rule for **naive datetime strings** (no offset, e.g. a bare `2026-02-04 00:00:00`): they are interpreted under `assumeTZ` (default `'UTC'`, never the *server's* local zone — JS `new Date('2026-02-04 00:00:00')` silently uses local, which shifts the calendar date). Sources that know their zone (zip mtime = exporter-local) pass `assumeTZ` explicitly. Date-only values (`YYYY-MM-DD`) → `T00:00:00.000Z`.

---

## 3. Verification table

| Assumption (load-bearing) | Verified at (read myself) |
|---|---|
| Messages funnel through one choke-point + normalize | `src/ingest/capture.js:45-62, 106, 150-151` |
| `normalizeCreatedAt` handles epoch-sec/ms/ISO; null→default | `src/ingest/capture.js:45-62` |
| Documents have NO normalization; raw passthrough | `src/core/document-store.js:388-389`, JSDoc :245 |
| `documents.upsert` puts created_at in ON-CONFLICT SET (Bug A) | `src/db/documents.js:116-117` |
| `restoreTable` omits created_at when row lacks it → DEFAULT now (Bug B) | `src/ingest/vault-import.js:101-106` |
| `restoreTable` is INSERT OR IGNORE (no clobber on re-run) | `src/ingest/vault-import.js:104` |
| Agent docs get export-write mtime, not authored date (Jun-16 cause) | `src/ingest/full-export-import.js:219-228` |
| `restoreTable` is the single shared restore fn | `src/ingest/full-export-import.js:29`, `vault-import.js:65` |
| Legacy source tags (`import_chatgpt`…) not produced by this repo | `grep`: only `src/core/document-store.js:247,363` (comments) |
| Detection is ZIP-only; obsidian/linkedin zip-path stubbed | `src/ingest/import-parsers.js:82-117`, `src/portal-uploads.js:134-135` |
| Working obsidian importer exists separately (reads mtime) | `src/ingest/obsidian-import.js:344`, `src/portal-import.js:25` |
| `importMessages` passes `createdAt ?? timestamp` | `src/tools/ingest.js` (sweep-cited; not personally opened) |
| Generic upload ignores file mtime → now() | `src/portal-uploads.js:248` (sweep-cited) |
| documents.created_at DEFAULT now() | confirmed via behavior comment `full-export-import.js:220`; schema `migrations/0001_init.sql` (sweep-cited 291-298) |

Rows marked *(sweep-cited)* are from Explore agents and should be opened before the code that depends on them is written.

---

## 4. Revision history

- **v1 (sketch):** "add a normalize call to the document path." — Rejected after sweep: the document corruption is *two* mechanisms (upsert clobber + restore default), and the deeper issue is architectural (no shared spine, silent fallback). A normalize call alone fixes neither Bug A nor the silent cliff.
- **v2 (this doc):** unified spine + immutable-created_at + provenance/fail-loud + exporter-side truth. Pivot driven by `documents.js:116-117` and `vault-import.js:101` reads.

---

## 5. Threat model / safety

- **No new plaintext surface.** `created_at`/`source`/`ts_provenance` are already plaintext (used for ordering/decay); provenance is a non-sensitive enum. Content stays enveloped.
- **Fail-closed preserved.** Missing timestamp still → `now()` (a document is never dropped for lacking a date), but is now *flagged*, not silent.
- **Idempotency preserved.** Message dedup (`id`+`content_hash`) and `INSERT OR IGNORE` restore are unchanged. The upsert fix makes re-import *more* stable (created_at stops moving).
- **Audit.** The reconciliation report (already written as an in-vault document) gains a provenance histogram → every bulk import is self-documenting.

---

## 6. Edge cases — explicit decisions

| Case | Decision |
|---|---|
| Source record has no timestamp | `inferred-now`, counted + reported. Never silently blended into real dates. |
| Re-import same doc with newer mtime | `created_at` preserved (earliest); `updated_at` bumped. |
| Naive local datetime string | Interpreted under explicit `assumeTZ` (default UTC), never server-local. |
| Date-only value | `T00:00:00.000Z`. |
| Future timestamp (clock skew / mis-parse) | Clamp-flag: if `> now + 48h`, treat as suspect → `inferred-now` + report. |
| Obsidian frontmatter has `created:` | Prefer frontmatter `created` > filename date > mtime (provenance records which). |
| LinkedIn | Either implement the CSV parser (with `"... UTC"` date parsing) **or** reject loudly — no silent "not supported yet" stub that looks like success. |
| Apple Health daily rows | Out of scope (aggregate table, not import-of-history); documented as deferred. |

---

## 7. Test strategy

| Test (file) | Asserts |
|---|---|
| `tests/ingest/timestamp.test.js` | epoch-sec/ms/ISO/naive/date-only/future-skew → exact ISO + provenance |
| `tests/ingest/documents-upsert-immutable.test.js` | re-upsert with newer created_at keeps the earliest; updated_at bumps |
| `tests/ingest/restore-inferred-now.test.js` | restore row w/o created_at → counted in `inferredNow`, reported |
| `tests/ingest/run-import-claude.test.js` | claude zip → messages w/ source-field provenance, dates preserved |
| `tests/ingest/run-import-collision.test.js` | a no-timestamp bulk batch produces a *flagged* count, not a silent cliff |
| `verify:import` gate | end-to-end: import fixture → assert 0 unexpected `inferred-now` for sources that carry dates |

---

## 8. Implementation order (each independently shippable)

1. **`timestamp.js`** — lift `normalizeCreatedAt` + add `assumeTZ`/`deriveCreatedAt`. Messages adopt it (no behavior change). Smoke: `node --test tests/ingest/timestamp.test.js`.
2. **Fix A** (immutable created_at in `documents.upsert`) — *highest value, ~5 LOC* + test. Smoke: re-import an obsidian note twice, assert created_at stable.
3. **saveDocument** — normalize via `timestamp.js`, set `metadata.ts_provenance`. Smoke: obsidian import → provenance `file-mtime`.
4. **Fix B** (restore: explicit created_at + `inferredNow` count in report). Smoke: restore a timestamp-less fixture row → report shows the count.
5. **Exporter-side truth** — `vault-export` writes real `created_at` per row + agent-file authored mtime into the bundle. Smoke: export→import round-trip preserves dates to the second.
6. **Source-adapter registry + `run-import.js`** — refactor the ZIP path onto the registry; merge the dual obsidian paths; implement-or-reject LinkedIn. Smoke: `verify:import`.
7. **Generic upload** — read client `lastModified` for file uploads. Smoke: upload a file, assert created_at = file date.

Steps 1-4 remove the corruption class. 5 prevents recurrence on the next migration. 6-7 are the robustness/coverage polish.

---

## 9. Decision criteria to call this "done"

- Importing each fixture (claude, chatgpt, obsidian, vault-export) yields **0 `inferred-now`** for records whose source carries a timestamp (queryable: provenance histogram in the report).
- Re-importing any source twice leaves `created_at` **bit-identical** (no drift).
- A deliberately timestamp-less batch shows a **non-zero, reported** `inferred-now` count — i.e. the cliff is loud.
- `verify:import` green; full `npm run verify` green.

---

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Making created_at immutable breaks a legitimate "lower the date" repair | Low | Med | Repairs go through an explicit audited tool (like this session's), not the import path — documented in Fix A. |
| Exporter change desyncs canonical↔V1 bundle format | Med | Med | Additive only (extra columns); restore tolerates missing fields (already does). |
| Registry refactor regresses the working message paths | Low | High | Steps 1-5 land first and independently; step 6 is pure orchestration refactor with `verify:import` as the gate. |
| Provenance enum sprawl | Low | Low | Closed enum; lint/test rejects unknown values. |

---

## 11. Deferred (named, out of scope)

- Apple Health per-measurement timestamps (aggregate-table redesign).
- Backfilling provenance onto the 60k already-imported rows (this design is forward-looking; the Jun-16 docs were repaired separately via the recovery manifest).
- The portal `uploads/*` historical mis-stamps still pending the user's pre-incident backup (separate recovery task, not this design).

---

## 12. Cycle-2 sweep — all hacky/unverified areas (consolidated)

A second 5-agent sweep audited the full robustness surface (not just timestamps). **Security floor PASSES**: scope forced `personal` (vault-import.js:86), `embedding_768` canonical-key nulled (:90), no plaintext in logs/reports, `foreign_keys` restored in `finally` (full-export-import.js:255-257), DENY allowlist + `assertSafeColumns` solid, zip-bomb/zip-slip hardened (PR #162). No HIGH/CRITICAL security findings.

Correctness/data-loss findings (verified file:line):

| # | Finding | Sev | file:line | Phase 1? |
|---|---|---|---|---|
| H1 | Claude/ChatGPT parsers `catch {}` with no failure counter — silent message loss | HIGH | import-parsers.js:158,203 | ✅ fixed |
| H2 | LinkedIn/Obsidian zip-path return success-shaped `{imported:0}` | HIGH | portal-uploads.js:134-135 | ✅ fixed |
| H3 | `documents.upsert` clobbers created_at on conflict | HIGH | documents.js:116-117 | ✅ fixed (Fix A) |
| H4 | `restoreTable` silently defaults created_at → now() | HIGH | vault-import.js:101 | ✅ fixed (Fix B, counted) |
| H5 | vault-import content-hash dedup drops distinct docs at different paths | HIGH | vault-import.js:182-202 | ⏸ Phase 2 (semantic change) |
| M1 | `importMessages` "Imported N" conflates failures | MED | tools/ingest.js:129 | ✅ fixed |
| M2 | Obsidian errors pushed to array, not aggregated | MED | obsidian-import.js:382 | ✅ fixed (`failed` count) |
| M3 | vault-import stores `entry.name` as doc path, no `..` guard | MED | vault-import.js:492 | ✅ fixed (traversal guard) |
| M4 | ChatGPT `flattenOpenAIMapping` silently drops non-text parts | MED | import-parsers.js:173 | ⏸ Phase 2 |
| M5 | full-export NDJSON skips malformed lines uncounted | MED | full-export-import.js:76 | ⏸ Phase 2 |
| L1 | Generic file upload ignores client `lastModified` → now() | LOW | portal-uploads.js:248 | ⏸ Phase 2 |

## 13. Phase 1 — BUILT & VERIFIED (2026-06-19, branch `fix/import-robustness-phase1`)

Surgical correctness core (each gate-tested, additive/low-risk):
1. `src/ingest/timestamp.js` — shared normalizer (UTC-safe naive strings, date-only, epoch) + `deriveCreatedAt` provenance (`TS_PROVENANCE` enum) + future-skew rejection. `capture.js` `normalizeCreatedAt` is now a thin re-export.
2. **Fix A** (H3) — `documents.upsert`: `created_at` immutable on conflict (empty-SET → `DO NOTHING` guard).
3. **Fix B** (H4) — `restoreTable`: counts `inferredNow` when an inserted row lacked created_at; surfaced in agent-file stats.
4. **H1/M1/M2** — Claude/ChatGPT parsers return `failed`; `importMessages` honest "Processed N: …, K FAILED"; Obsidian `summary.failed`.
5. **H2** — Obsidian/LinkedIn zip path returns a real error (not success-shaped); obsidian points at the folder importer.
6. **M3** — traversal guard rejects `..`/absolute/`//` agent entry names (`skippedUnsafe`).
7. `saveDocument` normalizes created_at/updated_at through the shared util (documents get the message-path UTC guarantee).

**Verification:** `verify:import-timestamps` extended to **T6–T10** (naive→UTC, date-only, provenance, future-skew, Fix A immutability, Fix B inferredNow, parser failed-count) — 15/15 PASS. Regression-clean across `verify:import`, `verify:vault-import`, `verify:full-export-import`, `verify:import-security`, `verify:ingest`, `verify:agent-capture`, `verify:no-destructive-truncation`, `verify:forget`, `verify:mcp`, `verify:related`, `verify:entities`, `verify:facts` — all GO. (`verify:import` test I5 updated to assert the new non-success-shaped stub contract.)

**Phase 2 (deferred, sequenced in §2/§8):** source-adapter registry + `run-import.js`, exporter-side created_at/mtime truth, H5 doc-dedup semantics, M4 ChatGPT non-text parts, M5 NDJSON line accounting, L1 generic-upload mtime.
