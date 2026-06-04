# Design — Connector content-aware upsert (Tier 1)

**Date:** 2026-06-04
**Source:** `docs/BENCHMARK-data-connections-2026-06-04.md` Tier 1 (adopt-list #1–#4)
**Branch:** `feat/connector-content-upsert` off `origin/main` 04bdca1
**Scope:** make upstream **edits propagate** into the vault + mindscape, with a light per-connector run/error surface and idle-backoff polling. On-device custody, AES-256-GCM, and fail-closed behavior are **unchanged**.

---

## 1. Problem (verified in code)

`captureMessage` dedups by **`INSERT OR IGNORE` on the message id PK** (`src/ingest/capture.js:96`, `src/db/messages.js:298`). Consequence — **edits never propagate**:

- **Stable-id sources (Gmail/Linear):** id = `gmail:<msgId>` / `linear:<issueId>` (`src/connectors/adapters/gmail.js:41`). An edited item re-pulls under the *same id* → `INSERT OR IGNORE` no-ops → the vault keeps the **stale** version.
- **Content-addressed source (Obsidian memory):** id = `obsidian:<sha256(text)>` (`src/ingest/obsidian-import.js:199`). An edited note gets a **new id** → a **duplicate** memory, and the old one is **orphaned in the mindscape forever**.

Neither updates the embedding/cluster, so the map drifts from reality.

## 2. Decisions locked

1. **Mirror the documents pattern.** `documents` already solves this: a **plaintext** `content_hash` column (`src/crypto/crypto-local.js:220-224`) computed as SHA-256 of plaintext at the boundary (`src/core/document-store.js:216,325,380`). Add the same column to `messages`.
2. **Three-way capture** (read-then-write, extends the existing `getExistingIds`→`insertIgnore` shape): **new → insert**; **seen + same hash → no-op** (free); **seen + different hash → UPDATE in place + re-enrich** (reset `nlp_processed=0`, null `embedding_768` + AI-derived cols, `DELETE` its `clustering_points`) so the change re-flows to the mindscape — the exact mechanism `redact()` already uses (`src/db/messages.js:240-254`).
3. **Obsidian memory id → path-stable** `obsidian:<vault>/<relpath>` (matches the *document* side, which already upserts on path). Edits now update the same memory instead of orphaning.
4. **Forgotten rows are never resurrected.** The update is gated `WHERE … forgotten_at IS NULL`, and capture short-circuits on a forgotten row.

### Encryption-safety proof (the load-bearing check)
The new path issues `UPDATE messages SET content=?, content_hash=?, metadata=?, …resets… WHERE id=? AND user_id=? AND forgotten_at IS NULL`.
- Writes run through `autoEncryptParams` for `INSERT|UPDATE|DELETE` (`src/adapter/d1.js:19,43`).
- `parseWriteSQL` UPDATE branch maps SET `?` → param indices by counting `?` per assignment (NULL/literal assignments contribute 0; WHERE params are after SET and never selected) and encrypts **only** columns in `ENCRYPTED_FIELDS` (`src/crypto/crypto-local.js:1275-1292,1424-1429`).
- With params ordered `[content, content_hash, metadata, id, userId]`: `content`@0 + `metadata`@2 → **encrypted**; `content_hash`@1 → **plaintext** (not listed); `id`/`userId` (WHERE) → untouched. ✅
- The SET clause is multi-line; `parseWriteSQL` uses the `/s` dotall flag (a missing match would *skip* the statement → plaintext leak — guarded by that flag, and re-asserted by the verify’s at-rest check).

## 3. Change list

| File | Change |
|---|---|
| `migrations/0007_messages_content_hash.sql` | **new** — `ALTER TABLE messages ADD COLUMN content_hash TEXT;` (plaintext, nullable; dedup is by `id` PK so no index needed) |
| `src/crypto/crypto-local.js` | comment only — note `messages.content_hash` is intentionally plaintext (mirrors documents); **not** added to `ENCRYPTED_FIELDS` |
| `src/db/messages.js` | + `getContentMeta(userId, id)` (SELECT `content_hash, content, forgotten_at`); + `updateContent(userId, id, {content, contentHash, metadata})` (re-enrich UPDATE + `DELETE clustering_points`, `d1Batch`, returns `{changed}`) |
| `src/ingest/capture.js` | compute `content_hash`; three-way branch; return `{id, deduped, updated}`; guard empty-content (attachment-only) to existence-only behavior; skip forgotten |
| `src/ingest/obsidian-import.js` | memory id → `obsidian:<vault>/<cleanRel>` (path-stable); summary gains `memoriesUpdated` |
| `src/connectors/scheduler.js` | tally `updated`; record `lastRun`/`recentRuns` (cap 10) + `lastOkAt`/`lastError`; **idle-backoff** — quiet connectors (consecutive empty pulls) widen their effective interval up to ~16× before next cycle |
| `src/connectors/store.js` | (no schema change — `recentRuns`/`idleStreak` ride in the existing encrypted `:state` JSON) |
| `scripts/verify-connector-upsert.mjs` | **new** — proves created / no-op / **updated+re-enrich** / encrypted-at-rest / plaintext hash / Obsidian path-stable edit, + idle-backoff math |
| `package.json` | wire `verify:connector-upsert` into `verify` |
| `scripts/verify-obsidian.mjs` | update edited-reimport assertion: edit → `memoriesUpdated` (was a new `memoriesCreated`) |

## 4. Verification table

| Claim | Evidence (file:line) |
|---|---|
| Dedup is `INSERT OR IGNORE` on id (edits dropped) | `src/db/messages.js:282-298`, `src/ingest/capture.js:96-104` |
| Obsidian memory id is content-addressed (dups on edit) | `src/ingest/obsidian-import.js:19-21,199` |
| Documents already do plaintext content_hash + upsert | `src/core/document-store.js:216,325,345,380`; `src/crypto/crypto-local.js:220-224` |
| `messages.content` is encrypted | `src/crypto/crypto-local.js:214-218` |
| UPDATE auto-encrypts only listed cols; plaintext col safe | `src/adapter/d1.js:19,43`; `src/crypto/crypto-local.js:1275-1292,1424-1429` |
| Re-enrich mechanism (reset nlp + drop clusters) exists | `src/db/messages.js:240-254` (redact); `src/enrich/drainer.js:47-48` |
| `messages` has no content_hash today (migration needed) | `migrations/0001_init.sql:950` |
| Forgotten rows are immutable | `src/db/messages.js:266-278` (`forgotten_at IS NULL`) |

## 5. Test plan
- `scripts/verify-connector-upsert.mjs` (injected random keys, port 0, mock adapter + direct `captureMessage`/`importObsidianVault` calls): created → re-capture same → `deduped` (no re-enrich) → re-capture changed → `updated` with `nlp_processed=0`, `embedding_768 IS NULL`, 0 clustering_points; **content + new content encrypted at rest**, **content_hash present & plaintext**; Obsidian edited re-import → `memoriesUpdated:1, memoriesCreated:0` and only **one** memory for that path; idle-backoff: empty pull → `idleStreak` grows → next-due pushed out.
- Full `npm run verify` GO (capture real exit code; **no `| tail`**).
- Isolated `:8796` preview (random injected keys, never the Keychain): connect mock, sync, mutate fixture, re-sync → updated.

## 6. Rollout / safety
- `ALTER TABLE ADD COLUMN` is additive; existing rows get `content_hash = NULL`. Capture treats NULL as "derive from decrypted content" → a pre-existing row updates **only if content truly differs**; identical content silently backfills the hash with **no** re-enrich (avoids churn on legacy rows). Current vault is throwaway, so transitional cost is moot regardless.
- No change to encryption keys, token storage, OAuth, or the localhost trust model.

## 7. Deferred (Tier 2, separate design)
Dedicated `connectors` table (NB: `connections` is the social graph — do not reuse), multi-account, per-connection daily budget, richer health UI. Webhooks/push remain out (see benchmark §6 — needs a hosted relay; not local-first).
