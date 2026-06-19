# Library — document-count index + right-direction folder counts (migration 0037)

**Date:** 2026-06-19 · **Branch:** `perf/library-folder-counts` (off `origin/main` 591fbb4)
**Status:** built + gated GREEN, not yet merged. Not security-sensitive (plaintext
aggregate index + plaintext count) → auto-merge-on-green eligible once CI passes.

## TL;DR

Opening a Library folder/category felt slow even though the document *list* is fast.
Cause: `db.documents.count` (the `/documents` `total` + per-folder counts) ran a
`forgotten_at IS NULL` COUNT with **no covering index** → a full table-page decrypt
scan (~287 ms on 20k docs). Its own comment claimed "no decrypt" — wrong.

Fix: migration **0037** adds a partial covering index so the count is index-only
(~287 ms → ~1 ms), and `db.folders.list` now derives per-folder counts **the right
direction** — ONE `GROUP BY folder_id` (index-only) instead of the never-maintained
`document_count` column.

## Evidence (measured, born-encrypted 20k-doc vault)

| Query | baseline | + 0037 |
|---|---|---|
| `documents.count` (All-Docs total) | **287 ms** | **1 ms** |
| `documents.count` (per folder) | 287 ms | 0 ms |
| `GROUP BY folder_id` (all folder counts) | 290 ms | 1 ms |
| `documents.list` (page of 50) | **0 ms** (already fast) | 0 ms |

The list was already fast (LIMIT 50 + the updated_at index) — matching "items load
faster." The lingering cost was the **count**, which the `/documents` handler awaits
before responding, so clicking into a folder waited on the scan.

## What changed

- `migrations/0037_documents_library_covering_index.sql` — partial covering index
  `(user_id, is_internal, folder_id, updated_at) WHERE forgotten_at IS NULL`:
  - COUNT All-Docs → prefix `(user_id, is_internal)` → index-only
  - COUNT a folder → prefix `(…, folder_id)` → index-only
  - `GROUP BY folder_id` → group on the 3rd column, index-ordered → index-only
  - list `ORDER BY updated_at DESC` within a folder → index supplies the order
  Plaintext structural columns → zero added decrypt surface (§7). `is_pinned`
  (Starred) and `path LIKE` (category) intentionally NOT covered — minor/rare, keeps
  the index narrow on the write-hot documents table.
- `src/db/folders.js` — `list()` drops the stale `document_count` column and computes
  live counts via one grouped query; exposes both `document_count` and `doc_count`
  (the field `LibraryNav` reads). Folders never had working counts before (the column
  was always 0 AND the nav read a differently-named field) — now they show, correctly.

## Why it's safe

- The index is additive + idempotent (`IF NOT EXISTS`); applies born-encrypted
  (verify:at-rest-migration GO).
- `folders.list` counts honour redaction (`forgotten_at IS NULL`) and exclude
  internal docs (`is_internal = 0`) — gated (P2/P3) so they can't over/under-count.
- One extra grouped query per `/portal/folders` call (~1 ms with the index) — not N+1.

## Verification

```
verify:library-folder-counts  GO  (NEW: P1 index-only plan · P2 count correctness+redaction · P3 folder counts via one query · P4 §7)
verify:at-rest-migration      GO  (0037 born-encrypted, race-safe)
verify:portal-data · library-perf · obsidian   GO  (no regression)
```

## NOT done / follow-ups

- Live WKWebView smoke after app rebuild (folder counts now render — confirm).
- Starred-view total (`is_pinned`) + category (`path LIKE`) counts still scan — minor;
  add to the index only if they become a felt cost.
- The dead `folders.document_count` column could be dropped in a later cleanup
  (now unused by the reader) — left in place to avoid a schema change here.

## ASCII

```
  /documents?folder_id=X
     ├─ list (LIMIT 50, idx_documents_user_updated)  → ~0ms  (already fast)
     └─ count COUNT(*) WHERE is_internal=? AND forgotten_at IS NULL [AND folder_id=?]
            BEFORE 0037: no covering index → decrypt every page   → ~287ms  ◄── the wait
            AFTER  0037: (user_id,is_internal,folder_id,updated_at) WHERE forgotten_at IS NULL
                         → index-only                              → ~1ms

  folder counts:  stale document_count column (always 0)   →   ONE GROUP BY folder_id (~1ms)
                  ───────────── wrong direction ─────────       ──────── right direction ───────
```
