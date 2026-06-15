# Handoff — Full-vault import + re-cluster incident + narration deep-dive (2026-06-15)

## TL;DR
The user's **full canonical vault (1 GB admin export) was imported into the live V1 vault — 0 failed** (~306,801 rows; 58,691 messages, 51,662 already searchable). Then a **"retry" on an error chip re-triggered Generate**; `cluster.py` re-clustered **mid-run** before it was killed. **Chronicle text is intact** (674, canonical models, zero local-model writes), but the **clustering structure is half-rewritten** (164 previously-active chronicled territories dissolved). **Decision pending: restore the imported mindscape (recommended) vs finish a full Generate.** The user's *next* goal is a **deep analysis of the narration logic** before deciding. **Do NOT run Generate/retry** until resolved.

## What shipped this session (all merged to main unless noted)
- Vault backup `.myvault` + restore + footgun fix (earlier PRs).
- `mycelium-vault-export` importer + reconciliation + content/blob dedup + Obsidian images + the **"Mycelium vault" Import tile** + **multi-GB upload** (offset assembly, 8GB limit, 4GB Node heap): PRs #143/#146/#147/#150/#152/#154/#156/#158.
- **`mycelium-full-export` importer — [PR #160](https://github.com/Curious-Life/mycelium.id/pull/160), gate `verify:full-export-import` 12/12 GO, NOT yet merged.** `src/ingest/full-export-import.js` + loopback route `POST /portal/import/full-export {dirPath}`; reuses `restoreTable` (now exported from `vault-import.js`); 768d→embedding_768 (+nlp_processed=1) & 256d→nomic re-encrypted; DENY-lists operational/FTS tables; **defers `foreign_keys` during restore** (else child-before-parent rows fail) and re-enables in finally.

## The import (done, verified)
- Source: `mycelium-full-export-2026-06-15.zip.enc` — the **admin** export (`scripts/export-everything.js`, format `mycelium-full-export`): per-table `db/<table>.ndjson` + `embeddings/*.ndjson` + `attachments/<id>/<file>` + `agents/`. Different from the inline-manifest `mycelium-vault-export`.
- **Decrypt recipe:** `openssl enc -d -aes-256-cbc -pbkdf2 -md sha256 -iter 600000 -in <.zip.enc> -pass file:<.pass>` (hardened iter — standard combos fail).
- Run via one-shot: `boot()` (keychain keys) + `importFullExport({db,userId,dirPath})` with `MYCELIUM_DATA_DIR` = real data dir. App was stopped first; DB snapshot taken (`.pre-fullimport-20260615-131149`, db+wal+shm).
- Result: 306,268 + 533 (after FK fix) rows, **0 failed**. Final: 58,691 msgs (51,662 searchable, ~7k embedding locally; 19 empty/never-embed), 2,490 people, 2,712 attachments, 61,704 clustering_points, 1,769 territories, 674 chronicles, 505 time-chronicles. Report doc: `imports/full-export-report-2026-06-15.json` (in-vault, encrypted).

## The incident (OPEN)
1. Post-import the app auto-Generated (and/or user clicked "retry" on the "Mapping hit a snag" chip → `phase:'error'` from the stopped job).
2. `cluster.py` ran **mid-way** before kill: re-versioned 61,444 points, **dissolved 164 active chronicled territories**, created 194 new active territories, wrote **4,513 `territory_lineage` old→new links** (`is_dominant`/`transfer_strength`). Active territories now **291**.
3. **Intact:** chronicle TEXT (674, models `haiku`/`claude-*`/null — NO `qwen`), 505 time_chronicles, current_arc, all messages/people/attachments/health/wealth.
4. **Not done:** chronicle **inheritance** (text → dominant successor via lineage) is the DESCRIBE stage's job and never ran; and `cluster.py` was killed mid-run → clustering is **partial/inconsistent**.
5. So the structure didn't "fail to fit" — the lineage remap was recorded; it was **interrupted** (both clustering and inheritance incomplete).

## Recovery options
**A — Restore the imported mindscape (RECOMMENDED).** Re-decrypt the export, restore ONLY the clustering tables to the pristine import state, overwriting the partial re-cluster. Tables: `territory_profiles, clustering_points, cluster_events, realms, semantic_themes, theme_cards, realm_neighbors, territory_cofire, territory_neighbors, territory_lineage, territory_pass_notes, territory_seen_points, territory_vitality`. Note `importFullExport` is `INSERT OR IGNORE` (won't overwrite) → must **DELETE those rows first, then re-import** (clean insert), re-encrypting 256d/768d. Deterministic, no LLM. Leaves messages/people/etc. untouched.
**B — Finish a full clean Generate.** Re-clusters the merged map + inherits chronicles to successors via lineage (designed flow) — but also **re-narrates** (hours on the local model) = the rewrite the user wants to avoid.

## Recovery assets / environment
- Encrypted export kept: `~/Desktop/Mycelium Backup/mycelium-full-export-2026-06-15.zip.enc` + `mycelium-export-2026-06-15.pass`. Plaintext copies (extracted/ + decrypted .zip) were deleted (security). `.pass` sits next to `.enc` (weak — recommend separating).
- DB snapshot `~/Library/Application Support/id.mycelium.app/mycelium.db.pre-fullimport-20260615-131149` — **PRE-import** (NOT a clean post-import state).
- App running via `cargo tauri dev` from the repo on `main`; embed service :8091 draining the backlog; local chat model = `qwen3.6-27b` via Ollama (`-np 1`, single-flight → Generate jobs starve the chat).
- `shouldAutoGenerate` only fires when `clustering_points == 0` (now 61k) → won't auto-run; the hazard is the **UI Generate/retry button**.

## Next task (the user's actual ask)
Deep-analyze the **narration logic** before any Generate: `pipeline/describe-clusters.js` + `pipeline/describe-chronicles.js` (authoritative source = canonical repo `/Users/altus/Documents/GitHub/mycelium/scripts/`). Verify: (1) **enough samples without trimming/cutting** inputs, (2) **incremental** — accounts for already-generated (input-hash skip-unchanged gate, see memory [describe-management]), (3) **naming accuracy**, (4) correct at **all levels** (clustering_point → territory → realm → time/arc). Sweep-first. Likely outcome: a chronicle-preserving describe (skip already-narrated, inherit on dissolution) so a future Generate never rewrites imported history.

## Pickup protocol
1. Read this + memory `vault-import-canonical.md` (has the incident + recipe).
2. Confirm nothing is running: `pgrep -fl "cluster.py|run-clustering|describe"` → none.
3. Do the narration sweep (next task) → then decide A vs B with the user.
4. If A: build the mindscape-restore (delete clustering tables + re-import from export), gate it, run it, relaunch app.
5. Merge PR #160 via `/auto-merge-on-green` once CI is green.
