# DESIGN — RT2-H1: overwrite recoverability (2026-06-19)

**Status:** sweep-verified, building. The last deferred item from the harness red-team
(PR #326, `docs/SESSION-HANDOFF-2026-06-19-native-harness.md` §6). It is the **gate before
`MYCELIUM_CHANNEL_OWNER_WRITE=1` is safe to enable**: a channel turn that writes the vault must
leave the overwritten value recoverable in-vault.

## The threat (RT2-H1)

`remember` (`facts.upsert`, ON CONFLICT DO UPDATE) and `saveDocument` (`documents.upsert`,
ON CONFLICT DO UPDATE) **overwrite in place with no prior-value row**. An injection-poisoned write
driven by forwarded channel content is therefore **unrecoverable** — the prior truth is gone.
Mitigated today only by tool-trim (no wipers in the channel set) + hash-only write-audit +
default-off flag. RT2-H1 closes it: capture the prior value, encrypted, before every overwrite,
and make it restorable.

## Sweep findings (file:line evidence)

1. **`documents.upsert`** (`src/db/documents.js:111`) builds `INSERT … ON CONFLICT (user_id, path)
   DO UPDATE`. **No prior-row capture.** `afterUpsertHooks` fire *after* with the NEW row — too late.
2. **`facts.upsert`** (`src/db/facts.js:48`) already SELECTs `prior` (id, forgotten_at) before the
   upsert — but **not `value`**. Easy extension point.
3. **`document_versions` table EXISTS** (`migrations/0001_init.sql:631`): `id, document_id, diff,
   changed_by, change_summary, created_at`. Only ever written by the bulk importers
   (`src/ingest/vault-import.js:209`, `full-export-import.js`) via generic table loaders, **never by
   a native write path.** No `fact_versions` table exists.
4. **`document_versions` is NOT in `ENCRYPTED_FIELDS`** (`src/crypto/crypto-local.js:209-288`).
   ⇒ writing prior document content into it as-is would persist **plaintext at rest** — a
   zero-leakage violation (CLAUDE.md §1). The snapshot column MUST be registered encrypted.
5. **Encryption is fail-closed + simple.** The adapter encrypts params for `ENCRYPTED_FIELDS[table]`
   columns in the first `VALUES` group and refuses a write it can't structurally model
   (`crypto-local.js:1530`, `encryptablePlaintext` 1488). ⇒ use a plain `INSERT … VALUES (?…)`
   shape (exactly what facts/documents use). Scope is the **uniform constant `'personal'`** set at
   db creation (`src/adapter/d1.js:32,70`), NOT derived per-row ⇒ a version's content encrypts and
   decrypts under the same scope as `documents.content`/`facts.value` with no `user_id` plumbing.
6. **Bulk importers bypass the DAL** (raw `run('documents', …)`), so DAL-level capture causes **no
   import regression** and no double-versioning. Only `saveDocument`/loose-doc/chat/channel/portal go
   through `db.documents.upsert`.
7. **No existing restore/version read surface** (`grep` clean). Clean slate.
8. **`column-guard`** (`src/db/column-guard.js`) is an identifier-regex only — new columns pass.

## Locked design

### Storage (migration `0032_overwrite_versions.sql`)
- **Extend `document_versions`** (ALTER ADD COLUMN, NULL-safe on existing rows): `user_id TEXT`,
  `path TEXT`, `title TEXT`, `summary TEXT`, `content TEXT`, `trigger TEXT`, `reason TEXT`.
  Index `(user_id, path, created_at DESC)`. Legacy `diff/changed_by/change_summary` left untouched.
- **New `fact_versions`**: `id, user_id, fact_id, category, key, value, confidence, trigger, reason,
  created_at`. Index `(user_id, category, key, created_at DESC)`.

### Encryption (`ENCRYPTED_FIELDS`, crypto-local.js)
- `document_versions: ['title', 'summary', 'content']`
- `fact_versions: ['value']`

### Capture — in the DAL (single chokepoint, covers every caller)
- `documents.upsert(doc, opts = {})`: SELECT prior (id, path, title, summary, content, forgotten_at).
  If prior exists **and** not forgotten **and** content|title|summary changed ⇒ INSERT a
  `document_versions` snapshot of the **prior** values (encrypted), `trigger = opts.trigger ||
  'overwrite'`. Then the existing upsert. **Non-fatal + isolated** (try/catch, structured log, no
  plaintext) — mirrors the existing `afterUpsertHooks` discipline; a versioning hiccup never denies
  an owner-authorized write. Create (no prior) and identical re-write (no diff) capture nothing.
- `facts.upsert({…, trigger, reason})`: extend the existing prior-read to include `value`; if prior
  exists, not forgotten, and value changed ⇒ INSERT a `fact_versions` snapshot of the prior value.

### Recovery — DAL read/restore
- `documents.listVersions(userId, path, {limit})` / `documents.restoreVersion(userId, path, id)`
  (restore = upsert the snapshot back ⇒ itself versioned ⇒ reversible both ways).
- `facts.listVersions(userId, {category, key, limit})` / `facts.restoreVersion(userId, id)`.

(MCP tool + portal surface for browsing/restoring history = a follow-up; the security gate is
"recoverable in-vault," which list+restore DAL methods satisfy and the gate proves.)

### Gate — `scripts/verify-write-recoverability.mjs` (V-series, real booted vault)
- V1 create ⇒ no version. V2 overwrite ⇒ prior captured. V3 snapshot ENCRYPTED at rest (rawRead =
  ciphertext, no plaintext substring). V4 restore round-trips prior content. V5 identical re-write ⇒
  no new version (no churn). V6 facts: remember→overwrite captures prior value, encrypted, restores.
  V7 raw-file scan: no version plaintext anywhere.
- Wire `verify:write-recoverability` into `package.json` + the `verify` aggregate.
- Re-run neighbors after build: `verify:facts`, `verify:loose-document`, `verify:run-import`,
  `verify:import`, `verify:portal-data` (catch any row-count assumptions).
