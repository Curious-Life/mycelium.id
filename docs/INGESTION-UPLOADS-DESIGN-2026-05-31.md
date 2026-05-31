# Ingestion + Uploads — Design (V1)

**Date:** 2026-05-31 · **Status:** DESIGN (sweep-first protocol applied; no code written yet).
**Companions:** `docs/V1-BUILD-SPEC.md` (D7 enrichment), `docs/V1-BUILD-HANDOFF-2026-05-30.md`, `docs/TOOL-UX-REVIEW-2026-05-31.md`.
**Operator intent (verbatim):** *"message capture should work for all messages that get sent to the server. any message that comes in should be saved. we also need document uploads etc."*

---

## Goal
Two durable-write surfaces on the self-hosted single-user server:
1. **Message capture** — every message that reaches the server is persisted to the `messages` table (encrypted at rest), then queued for enrichment (embedding + NLP).
2. **Document/file uploads** — a file sent to the server is stored on local disk (encrypted at rest), recorded in `attachments`, optionally linked to a message and/or surfaced as a `documents` row, and queued for text-extraction + enrichment.

Both must be **fail-closed** (no key ⇒ no write), **idempotent** (retries don't double-save), and leave **zero plaintext at rest** (CLAUDE.md §1).

---

## Load-bearing assumptions (Step 1) → all verified (see table at end)
1. `messages.insert(rows)` needs only caller columns; schema defaults `id`/`created_at`/`role`/`scope`/`nlp_processed`. 
2. Message encryption is transparent at the `d1Query` layer (`content`, `metadata`, etc. auto-encrypted).
3. `attachments` namespace is **NOT wired** into `getDb()` — must be wired.
4. `attachments.r2_key` is **nullable** — reusable for a local path without a migration.
5. File **bytes** are never a db column — they need separate encryption-at-rest on disk.
6. Mind-files already implements local encrypt-at-rest (MIND-magic envelope) — the precedent to reuse.
7. The current REST surface (`src/api.js`) is **JSON-only, localhost, no auth, no multipart**.
8. MCP tool handlers receive **only JSON args** — file bytes cannot flow through a tool.
9. The OAuth/HTTP server (`src/server-http.js`) is the only **authenticated, network-facing** surface.
10. Enrichment is the build-new :8095 async service (D7); the trigger contract is fire-and-forget.

---

## Sweep findings (consolidated, Step 2–3)

**Ingestion (reference).** No single choke-point in the canonical code — `db.messages.insert` is called from `/chat` (`storeUserMessage`, chat.js:927), bulk import (portal-export-import.js:1181), and restore. Callers populate `{id?, user_id, role, content, source, message_type, metadata, created_at?}`. **V1 should impose the single choke-point the reference lacks** (operator: "any message that comes in should be saved" ⇒ one capture function all paths call).

**Dedup.** Reference uses `insertIgnore` (`INSERT OR IGNORE` on `id` PK) + caller-side `getExistingIds`, plus an optional `metadata.dedupeNonce`. For V1: **caller-supplied `id` + `insertIgnore`** is the honest idempotency key (a webhook resend carries the same source-message id).

**Uploads (reference).** `portal-uploads.js`: Busboy multipart → temp file → **R2 object store via a Worker round-trip** → `attachments` row with `r2_key`/`stream_uid` → optional `documents` row for text files. Extraction (Whisper/vision/unpdf) happens **in the Worker**, results land in `attachments.transcript`/`description`. **None of the R2/Worker path exists in self-hosted V1.**

**Encryption boundary.** `ENCRYPTED_FIELDS.attachments = ['transcript','file_name','description','metadata']` (crypto-local.js:234) — db-layer auto-encryption covers the *metadata row* but **not the file payload**. File bytes must be encrypted **on disk** separately. Mind-files (`src/mindfiles/mind-files.js:117`) already does exactly this: `encrypt(content, scope, masterKey)` → `MIND`-magic-prefixed envelope → atomic tmp+rename write. **Reuse this pattern for the blob store.**

**Entry surface.** REST (`api.js`) is JSON-only/localhost/no-auth/1MB — wrong for user-facing, network, or binary. MCP tools are JSON-args-only — **cannot carry bytes**. The OAuth/HTTP server (`server-http.js`) is the only authenticated network surface and is where new `/ingest` + `/upload` routes belong, behind the same `withMcpAuth`/Bearer guard.

---

## Revision history
- **v1 (sketch, pre-sweep):** "add a `captureMessage` MCP tool + an upload tool." **PIVOTED** — MCP tool handlers receive only JSON args (mcp.js:142, verified); **a tool can never receive file bytes**. Uploads MUST be an HTTP route, not a tool. Message capture *can* be a tool, but the operator's "any message that comes in" means the durable path is a **server endpoint**, with the tool as a convenience wrapper.
- **v2 (this doc):** message capture + uploads are **HTTP endpoints on the OAuth/HTTP server**; a thin `captureMessage` MCP tool is added for the connected-agent convenience path, but it calls the same internal capture function. Bytes go to a **local encrypted blob store** modeled on mind-files. Enrichment hand-off is async via D7's :8095 (with an inline-embed fallback until :8095 ships).

---

## Design

### Component 1 — `captureMessage()` (the single choke-point) — `src/ingest/capture.js`
The function every ingestion path calls. ~40 LOC.
```
captureMessage(db, { userId, role='user', content, source, messageType='chat',
                     conversationId, attachmentId, metadata, id }) -> { id, deduped }
```
- Builds the row; lets the schema default `id` (or accepts a caller `id` for idempotency) + `created_at`.
- Writes via `db.messages.insertIgnore([row])` (idempotent on `id`).
- `content`/`metadata` auto-encrypt at the `d1Query` layer (no explicit crypto here).
- After a successful *new* insert, calls `enqueueEnrichment(id)` (Component 4) — fire-and-forget.
- Fail-closed: if the vault key is absent, `autoEncryptParams` already throws `REFUSE: write … requires USER_MASTER_KEY` — capture surfaces that, never writes plaintext.

### Component 2 — local encrypted blob store — `src/ingest/blob-store.js`
Models mind-files' encrypt-at-rest. ~60 LOC.
```
putBlob(buffer, { userId, ext }) -> { path, size }   // encrypt → magic-prefixed → atomic write
getBlob(path) -> Buffer                               // read → strip magic → decrypt
```
- Path: `data/uploads/<userId>/<uuid><ext>.enc` (gitignored, like `data/`).
- Encrypts the raw bytes with `crypto-local.encrypt` under the user key (same key bridge `boot()` already pins).
- **Bytes never touch the db**; `attachments.r2_key` stores the **relative blob path** (reusing the nullable column — no migration). A code comment + the design note rename its *meaning* to "storage key (local path in V1)".

### Component 3 — upload + ingest HTTP routes — added to `src/server-http.js`
Behind the existing Bearer guard. Multipart via `busboy` (already the reference's choice) or `multer`.
- `POST /ingest/message` (JSON) → `captureMessage(...)` → `{ id }`. Honors `Idempotency-Key`/body `id`.
- `POST /ingest/upload` (multipart) → stream to temp → `putBlob` → wire `attachments` row (Component 5) → optional `captureMessage` with `attachmentId` → optional `documents` row for text files → enqueue extraction+enrichment → `{ attachmentId, messageId? }`.
- Both fail-closed on missing auth (401) and missing key (refuse).

### Component 4 — enrichment hand-off — `src/ingest/enqueue.js`
- **Primary:** the row is written with `nlp_processed=0`; the D7 :8095 service (when present) drains the `idx_messages_nlp_pending` work queue. `enqueueEnrichment` POSTs `/enrich-all {userId}` to :8095 best-effort (timeout-guarded; absence is non-fatal — the row is already durably queued by its `nlp_processed=0` default).
- **Interim (until :8095 ships):** an optional inline embed-on-write via the injected embed client (R2). If no embedder, the row simply waits in the queue. **No fabrication** — search works on what's embedded; the rest is honestly pending.

### Component 5 — wire `attachments` into `getDb()` — `src/db/index.js`
Import + assemble `createAttachmentsNamespace({ d1Query, firstRow })` (one line; the namespace already exists and its deps are satisfied). Adds `db.attachments`.

### Tool surface additions (the convenience layer)
- `captureMessage` MCP tool (JSON) → calls Component 1. For the connected agent to log a note into the stream. Lives in a new `src/tools/ingest.js`.
- **No upload tool** (bytes can't flow through MCP) — uploads are HTTP-only; the agent references an already-uploaded `attachmentId`.

---

## Threat model
- **New attack surface:** two authenticated HTTP endpoints + a local blob directory. Both sit behind the same Bearer/OAuth guard as `/mcp` (verified the only network surface). The blob dir is `data/uploads/` (gitignored, encrypted-at-rest).
- **Plaintext-at-rest:** file bytes encrypted via the same AES-256-GCM envelope as mind-files; transcripts/descriptions/filenames encrypted by the db layer. **`file_type`/`file_size` stay plaintext** (accepted metadata leak, documented in crypto-local.js:231 — needed for listing UI). Carried forward as an accepted risk.
- **Fail-closed:** no key ⇒ `autoEncryptParams` throws ⇒ no row, and `putBlob` refuses (encrypt throws). Verified the refuse path exists (crypto-local.js:1327).
- **Idempotency / abuse:** `insertIgnore` on `id` prevents webhook-storm duplication; multipart size cap + a per-request byte ceiling prevent disk exhaustion (to set).
- **Audit:** every capture + upload writes an `audit` row (db.audit is wired) — cross-boundary traceability (§8).

---

## Edge cases — explicit decisions
- **Message with no content (attachment-only):** allowed — `content` may be empty; the `attachment_id` carries the payload. captureMessage requires *either* content or attachmentId.
- **Upload of a text file:** stored as a blob AND surfaced as a `documents` row (reference parity) so it's searchable/editable, AND a transcript-less `attachments` row. One upload → up to 3 rows (attachment + document + optional message), all idempotent.
- **Large file:** streamed to temp, size-capped; ZIP text-extraction (reference's 200MB path) is **deferred** — V1 caps upload size and rejects oversize rather than extract.
- **Video / `stream_uid`:** **dropped in V1** (no HLS without ffmpeg infra; reference assumes Cloudflare Stream). Documented deferral.
- **Extraction (Whisper/vision/PDF):** the *hooks* are designed (extraction → `transcript`/`description`), but the **local models are deferred to the enrichment unit** — V1 stores the blob + a null transcript, enrichment fills it later. No fabricated transcripts.
- **Enrichment service down:** non-fatal — row sits at `nlp_processed=0`, drained when :8095 comes up.

---

## Test strategy (by file)
- `scripts/verify-ingest.mjs` — (I1) `captureMessage` writes a row, `getDailyMessages`/`getContext` surface it; (I2) ciphertext-at-rest on the raw `content` column; (I3) idempotency — same `id` twice = one row; (I4) fail-closed — wrong key ⇒ no row; (I5) `nlp_processed=0` set (queued).
- `scripts/verify-upload.mjs` — (U1) multipart upload over the Bearer-guarded route returns `attachmentId`; (U2) blob on disk is a magic-prefixed envelope, NOT plaintext; (U3) `getBlob` round-trips to the original bytes; (U4) `attachments` row present with encrypted `file_name`; (U5) text upload also creates a `documents` row; (U6) unauth request → 401.
- Wire both into `npm run verify`.

---

## Implementation order (each independently shippable + smoke-tested)
1. **Wire `attachments` into getDb()** + a 1-check verify. (Unblocks everything; trivial.)
2. **`captureMessage` choke-point** + `src/tools/ingest.js` tool + `verify-ingest.mjs` (I1–I5). (Message capture works end-to-end via MCP + REST.)
3. **`blob-store.js`** + `verify` (U2/U3 round-trip in isolation). (Encrypted local bytes proven before any HTTP.)
4. **`/ingest/message` + `/ingest/upload` HTTP routes** on server-http.js + `verify-upload.mjs` (U1/U4/U5/U6). (Network-facing, authenticated.)
5. **`enqueueEnrichment`** hand-off (best-effort :8095 + inline fallback). (Closes the loop to D7.)

## Decision criteria to proceed past this design
Operator confirms: (a) uploads are HTTP-only (not a tool) — bytes can't flow through MCP; (b) the local encrypted blob store reusing `attachments.r2_key` as a path (no migration) is acceptable vs. adding a `local_path` column; (c) video + local extraction models are deferred.

## Risks + mitigations
| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Reusing `r2_key` for a local path is semantically confusing | Med | Low | Comment + design note; optional later migration to `storage_key` |
| 2 | Multipart middleware adds a dep + parsing attack surface | Med | Med | Use busboy (reference-proven); size-cap; behind Bearer guard |
| 3 | Blob dir grows unbounded | Med | Med | Size cap per upload; document a retention/GC follow-on |
| 4 | Enrichment never runs (:8095 unbuilt) | High (now) | Low | Rows durably queued at `nlp_processed=0`; inline-embed fallback; search degrades honestly |
| 5 | `file_size`/`file_type` plaintext leak | Certain (accepted) | Low | Documented accepted risk (crypto-local.js:231); revisit if threat model tightens |

## Open questions deferred
- Local transcription/vision models (Whisper/PDF/image) — belong to the enrichment unit, not here.
- Video/HLS — dropped for V1.
- Multi-source dedup beyond `id` (fuzzy near-duplicate) — out of scope.
- A `storage_key` rename migration — optional cleanup, not blocking.

---

## Verification table (every load-bearing assumption, read myself)
| # | Assumption | Verified at |
|---|---|---|
| 1 | `messages.insert` needs only caller columns; schema defaults id/created_at/role/scope/nlp_processed | `src/db/messages.js:56`; `migrations/0001_init.sql:950` (read: `id … DEFAULT (lower(hex(randomblob(16))))`, `role … DEFAULT 'user'`, `scope … DEFAULT 'org'`, `nlp_processed INTEGER DEFAULT 0`) |
| 2 | Message fields auto-encrypt at the query layer | `src/crypto/crypto-local.js:214` (`ENCRYPTED_FIELDS.messages` incl. content, metadata); `src/adapter/d1.js` (autoEncryptParams on writes) |
| 3 | `attachments` is NOT wired in getDb() | `src/db/index.js` (read: 13 namespaces wired; no `createAttachmentsNamespace`) |
| 4 | `attachments.r2_key` is nullable (reusable for local path, no migration) | `migrations/0001_init.sql` attachments block (read: `r2_key TEXT,` — no NOT NULL) |
| 5 | File bytes are not a db column; only transcript/file_name/description/metadata encrypted | `src/crypto/crypto-local.js:234` (`attachments: ['transcript','file_name','description','metadata']`) |
| 6 | Local encrypt-at-rest precedent exists (reuse, don't reinvent) | `src/mindfiles/mind-files.js:117` (`encrypt(...)`), `:102-125` (magic-prefix + atomic tmp+rename) |
| 7 | REST surface is JSON-only/localhost/no-auth/no-multipart | `src/api.js:32` (`express.json({limit:'1mb'})`); `src/server-rest.js` (`127.0.0.1`, "no auth — Phase 4") |
| 8 | MCP tool handlers receive only JSON args (no bytes) | `src/mcp.js:142` (`CallToolRequestSchema` → `handler(args)`, args from `req.params.arguments`) |
| 9 | OAuth/HTTP server is the only authenticated network surface; routes addable behind Bearer | `src/server-http.js` (`/mcp` behind `authenticate()`; `app.all('/api/auth/*splat')`; well-knowns) |
| 10 | Enrichment is async :8095 with fire-and-forget trigger + `nlp_processed` states | `reference/server-routes/portal-enrichment.js:158` (`POST /enrich-all`), `:84` (states 0/1/2/-1); `migrations/0001_init.sql:1833` (work-queue index) |
| 11 | Fail-closed write path (no key ⇒ refuse, no plaintext) | `src/crypto/crypto-local.js:1327` (`REFUSE: write … requires USER_MASTER_KEY`) |
