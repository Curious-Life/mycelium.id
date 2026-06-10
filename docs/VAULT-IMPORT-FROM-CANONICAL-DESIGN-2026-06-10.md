# Import a canonical-Mycelium vault export — Design

**Date:** 2026-06-10
**Status:** Design locked (sweep-first: 2 Explore sweeps + self-verified reads), building now
**Goal:** the user exports their vault from the canonical production Mycelium
(Curious-Life/mycelium, the `POST /portal/export` ZIP) and imports it into this V1
self-hosted app, bringing their data home.

---

## 0. Headline

The canonical export is a ZIP containing one **plaintext** `manifest.json`
(`format: 'mycelium-vault-export'`, version 3/4 — `reference/server-routes/portal-export-import.js:810,997`)
with ~47 table families inline, plus `attachments/{id}/{file}` binaries and an
`agents/` filesystem tree. It is **not** a `.myvault` (which is a V1 ciphertext
SQLite snapshot) — so it cannot go through the pre-boot restore screen: **writing
imported data requires the open vault's encryption boundary** (the adapter
auto-encrypts on INSERT, `src/adapter/d1.js:44-48`). It therefore lands as a
**fourth detected format in the existing Import pipeline** (`src/portal-uploads.js`
`processArchive`), alongside Claude/ChatGPT — the user creates their V1 vault,
then drags the canonical export into Import. The onboarding restore screen gets a
cross-link so users coming from canonical aren't stranded.

## 1. Flow

1. **Canonical side (user action):** Portal → export (passkey/master-key gated,
   one-time token) → `mycelium-vault-export-*.zip`.
2. **V1 side:** create vault (or already open) → Import surface → drop the ZIP →
   `detectExportType` sees `manifest.json` w/ `format:'mycelium-vault-export'` →
   `importMyceliumVault()` ingests → enrichment drainer re-embeds everything
   locally → Generate evolves the mindscape natively.

## 2. What is imported, skipped, regenerated

| Family | Action | Why |
|---|---|---|
| `messages` | generic restore, ids+timestamps preserved, `nlp_processed=0`, enrichment cols nulled | V1 re-embeds locally (canonical export has **no** search vectors — Vectorize wasn't exported, reference:817); `INSERT OR IGNORE` on preserved id ⇒ idempotent re-import |
| `documents`, `folders`, `note_links`, `document_versions` | generic restore, ids preserved, `embedding_768` nulled | link integrity needs preserved ids (reference:1023-1027) |
| `attachments` + binaries | binary from ZIP → `putBlob()` (re-encrypted, `uploads/<userId>/<uuid>.enc`) → row w/ `local_path`, `r2_key` nulled, id preserved | messages link via `attachment_id`; blob store is the only honest at-rest home (`src/ingest/blob-store.js`) |
| `people`, `contact_territories` | generic restore | source-of-truth user data |
| `health_daily`, `activity_sessions`, `activity_daily` | generic restore | " |
| `wealth_*` (8 tables) | generic restore | " |
| `canvas_*` (4), `tasks`, `agent_tasks`, `reflections`, `cycle_metrics`, `scheduled_events` | generic restore | " |
| `user_profiles`, `user_identities`, users.timezone/settings | generic restore (user_id forced) | " |
| mindscape: `realms`, `semantic_themes`, `territory_profiles`, `theme_cards`, `clustering_points` (+nomic hex), `cluster_events`, `territory_cofire`, `territory_neighbors`, `realm_neighbors` | generic restore | territory narratives/names/lineage are **user-meaningful history that cannot be regenerated identically**; nomic 256D vectors are the same model family (Nomic v1.5); next Generate evolves rather than recreates. Hex vectors auto-encrypt on insert (ENCRYPTED_FIELDS) |
| `cognitive_metrics_*`, `topology_metrics` (v4) | generic restore | historical metrics; v3 bundles simply lack the key (no-op) |
| `agents/` filesystem | **skip** (counted + reported) | V1 is a pure tool server — no agent runtime FS (D5) |
| `passkeys`, `secrets` | **skip** | different auth system; secret *values* are excluded from the export anyway (reference:846) |
| `ai_providers` | **skip** (reported) | credentials don't ride along — user re-adds keys in Settings → AI |
| `connections` | **skip** (reported) | federation identity is per-instance; canonical DIDs aren't this box's |
| `internal_model_items` | **skip** | dead schema (persona-claims pivot) |

## 3. The generic restore (the engine)

`restoreTable(db, table, rows, { userId, overrides })`:
- `table` comes from a **fixed allowlist only** — never from the manifest (SQL-injection guard).
- Column set = `PRAGMA table_info(<table>)` ∩ row keys; `user_id` forced to the
  V1 user where the column exists; per-table overrides (e.g. messages enrichment reset).
- `INSERT OR IGNORE` through **`db.rawQuery`** (`src/db/index.js:62`) — the same
  auto-encrypting adapter path every namespace uses (`autoEncryptParams` matches
  `INSERT OR IGNORE`, `src/adapter/d1.js:19`), so plaintext export values land
  encrypted under the V1 key with zero crypto code in the importer.
- Fail-soft per row (count + continue); fail-closed per family is wrong here —
  a single malformed row must not abort a 50k-row import.

After all families: one drainer nudge (`enqueueEnrichment(firstMessageId)`) — the
drainer scans the whole `nlp_processed=0` backlog (`src/enrich/drainer.js:66-76`).

## 4. Security

- Plaintext manifest values are **only ever** written through the encrypting
  adapter or `putBlob` — never to disk raw (CLAUDE.md §1).
- ZIP entries are read by manifest reference; **nothing from the archive is ever
  written to an archive-controlled path** (no zip-slip surface; same posture as
  `import-parsers.js` header).
- Manifest read via the existing `readTextEntry` double-capped reader
  (declared-size reject + streaming abort, `src/ingest/import-parsers.js:32-52`).
- Attachment binaries per-file capped (100MB default, env-tunable).
- Import runs behind the vault-auth gate like all `/portal` routes; loopback desktop.

## 5. Limits (documented, not silent)

- Upload: existing 512MB single-shot / chunked path (`MYCELIUM_IMPORT_LIMIT_BYTES`).
  Canonical caps its own restore at 2GB; vaults near that need the env raised. Reported, not capped silently.
- `manifest.json` inflation cap: `MAX_JSON_BYTES` (400MB default, env-tunable).

## 6. Verification table

| # | Assumption | Verified at (read myself) |
|---|---|---|
| 1 | Export = ZIP{ manifest.json (plaintext, `format:'mycelium-vault-export'`, v3/v4), attachments/{id}/, agents/ } | `reference/server-routes/portal-export-import.js:807-856,956,997` |
| 2 | V1 has no importer for it | grep `mycelium-vault-export` in src/ → only this feature |
| 3 | `db.rawQuery` = auto-encrypting adapter passthrough | `src/db/index.js:62` |
| 4 | `INSERT OR IGNORE` is matched by autoEncryptParams' write regex | `src/adapter/d1.js:19` |
| 5 | V1 schema carries the canonical tables (messages…wealth_*…clustering_points…) | `migrations/0001_init.sql` CREATE TABLE list |
| 6 | Import pipeline hook = `processArchive` + `detectExportType` | `src/portal-uploads.js:92-112`, `src/ingest/import-parsers.js:62-80` |
| 7 | Blob store re-encrypts binaries; attachments row links via `local_path` | `src/ingest/blob-store.js`, `src/ingest/upload.js:40-48` |
| 8 | Export has no search embeddings; drainer re-embeds `nlp_processed=0` | reference:817; `src/enrich/drainer.js:66-76` |
| 9 | created_at back-dating is supported/normalized | `src/ingest/capture.js:27-44` + generic column copy |
| 10 | Import needs the OPEN vault (encrypt-on-write) ⇒ not the pre-boot restore screen | `src/adapter/d1.js:44-48`; account router is pre-boot, portal routes post-boot |

## 7. Test strategy — `scripts/verify-vault-import.mjs` (`verify:vault-import`)

Synthetic canonical export (manifest v4 + one attachment binary) → POST
`/api/v1/portal/upload` against an injected-key server:
V1 type detected · messages land with preserved id + back-dated created_at +
`nlp_processed=0` · plaintext marker ABSENT from raw db file (encrypted) +
decrypts back via the master key · attachment blob exists encrypted (`MYCB`) +
row linked · people/health/wealth/tasks/reflections/territory rows landed ·
re-import duplicates nothing · skipped families reported · garbage manifest
rejected without leakage.

## 8. Revision history

- v1 sketch: wire into the onboarding "vault restore" screen (user's framing).
  **Pivot:** the restore screen is pre-boot (no keys — can't encrypt writes);
  canonical import is a logical, plaintext-source import that must run inside the
  open vault. Landed in the Import pipeline instead; onboarding cross-links it.
- v2 sketch: skip the mindscape (regenerate everything). **Pivot:** territory
  narratives/names/lineage are unregenerable user history; reference import
  restores them and the nomic vectors are model-compatible. Restore mindscape,
  let Generate evolve it.
