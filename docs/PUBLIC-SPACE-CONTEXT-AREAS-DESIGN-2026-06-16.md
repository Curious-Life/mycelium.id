# Public Space & Context Areas (spec #19) — Design

**Date:** 2026-06-16
**Branch:** `claude/prelaunch-ux-v2` (worktree `mycelium-worktrees/prelaunch-ux`)
**Spec:** `~/Downloads/mycelium-coding-agent-spec-2026-06-16.md` §19 (P1)
**Protocol:** `/sweep-first-design` — 3 sweep cycles, every load-bearing claim re-read at file:line by the author.

---

## 0. What the spec actually asks (verbatim)

- **Public Space** section in Settings: toggle enable/disable; URL/slug config; privacy controls (what's visible publicly).
- **Context Areas** section: add named areas ("Work", "Research", "Health"); each area can have **documents attached**; show a **high-level summary** of each area; areas **provide context to the AI** about life domains.
- **Acceptance:** public space toggles on/off with URL config; areas can be created/named/populated with documents; each area shows a summary; settings persist.

---

## 1. Revision history — the pivots the sweep forced

**v1 (handoff sketch, 2026-06-16):** "Build context areas on `db.contexts`; the live V1 backend never mounted the portal sub-routers, so wiring is unverifiable — building blind risks broken mounts. Public Space ≈ extend Profile pane."

**v2 (this doc) — three pivots, each from reading live code:**

1. **PIVOT — contexts is already fully built AND mounted.** The premise "`db.contexts` doesn't exist / routers aren't mounted" is **false in this tree**. `src/db/contexts.js` is a complete namespace (12 methods), table `sharing_contexts` + junctions exist ([migrations/0001_init.sql], [src/db/contexts.js]), the CRUD router is **mounted** at `/api/v1/portal` ([src/server-rest.js:164]: `v.use('/api/v1/portal', portalCompatRouter(...))`), and a UI already consumes it (`ContextsView.svelte`, titled "Spaces"). **All 16 portal sub-routers are mounted** — the stale "never mounted" warning does not apply here. ⇒ Scope shrinks to *additive* extension, fully gate-verifiable on a running server.

2. **PIVOT — areas attach DOCUMENTS, but contexts today attach TERRITORIES.** The existing `sharing_contexts` model links **territories** (`context_territories`) for *federation sharing* and grants them to *connections* (`context_grants`). The spec's "Context Areas" attaches **documents** and synthesizes a **summary** for *AI context* — a different lens on the same row. No `context_documents` junction exists ([sweep: documents]). ⇒ Add one new junction + a `summary` column; do **not** overload the territory/grant machinery.

3. **PIVOT — the AI summary is sensitive and must be encrypted; `sharing_contexts` is currently 100% plaintext.** `sharing_contexts.name` is stored plaintext (generic facet labels — verified: the table has **no** entry in `ENCRYPTED_FIELDS`). A summary synthesized from "Health"/"Work" documents is a semantic fingerprint of plaintext (CLAUDE.md §1, §7) and **must** be encrypted. The codebase encrypts transparently via the `ENCRYPTED_FIELDS` registry at the D1-adapter boundary. ⇒ Add `sharing_contexts: ['summary']` to the **live** registry ([src/crypto/crypto-local.js], NOT the `reference/` copy a sweep mis-cited).

---

## 2. Sweep findings (consolidated, load-bearing parts only)

### Contexts backend (exists, live)
- Table `sharing_contexts (id, user_id, name, is_private, is_default, created_at, UNIQUE(user_id,name))` + `context_territories` + `context_grants` — [migrations/0001_init.sql].
- Namespace `createContextsNamespace` — `list/create/rename/remove/addTerritory/removeTerritory/getTerritories/grant/revoke/getGrants/ensureDefaults/canSeeTerritory` — [src/db/contexts.js:33-178]. `create` caps name at 50 chars; default rows are rename/delete-guarded by `is_default = 0` SQL clause.
- Wired in `src/db/index.js`: `contexts: createContextsNamespace({ d1Query, randomUUID })`.
- Routes `GET/POST/PUT/DELETE /contexts` + territory/grant sub-routes — [src/portal-compat.js:619-676], each ownership-guarded by `guardContext` ([src/portal-compat.js:614-617]) which checks `sharing_contexts WHERE id=? AND user_id=?`.
- Mounted at `/api/v1/portal` — [src/server-rest.js:164].
- UI `portal-app/src/lib/views/ContextsView.svelte` (titled "Spaces") calls `/portal/contexts/*`.

### Profile / Public Space
- `user_profiles (user_id PK, handle UNIQUE, display_name, signature, …, avatar_url, exlibris_url)` — [migrations/0001_init.sql:1734-1746]. **No public/visibility column.**
- Routes `GET /profile`, `GET /profile/handle/check`, `PUT /profile` (handle/display_name/signature), `POST /profile/stats/recompute` — [src/portal-compat.js:189-236]; `ensureRow()` upserts the single-user row.
- `HANDLE_RE` 3–30 chars `[a-z0-9_]`, `RESERVED_HANDLES` guard — [src/portal-compat.js:196,211].
- Publishing is **per-document only**: `public-server.js GET /p/:slug` serves iff `documents.published=1`; no per-handle landing page exists ([sweep: public space]). `exlibris_url` is a profile **bookplate image**, NOT a theme — must not be removed (prior #18 confusion).
- UI `portal-app/src/lib/views/ProfileView.svelte` edits handle/signature/avatar/exlibris.

### Encryption boundary (verified by author)
- Live registry: `src/crypto/crypto-local.js` (the `reference/encryption/…` copy is read-only reference and is NOT imported). [src/adapter/d1.js:17] imports `autoEncryptParams` from `../crypto/crypto-local.js`.
- `ENCRYPTED_FIELDS.documents = ['content','summary','title','tags','entities','relations','metadata','entity_summary','source_path']` — [src/crypto/crypto-local.js:246]. `documents.path` stays plaintext (UNIQUE lookup key).
- `sharing_contexts` is **absent** from the registry ⇒ everything plaintext today (verified: grep returns nothing).
- `autoEncryptParams` parses INSERT **and** UPDATE, encrypts listed columns under scope `'personal'` (default — [src/adapter/d1.js:31]), and **fail-closes**: `throw REFUSE … requires USER_MASTER_KEY` when no key — [src/crypto/crypto-local.js:1565-1583]. Decrypt failure leaves ciphertext + logs `[DECRYPT ERROR]`, never plaintext.
- `sharing_contexts` is not in `SCOPE_AWARE_TABLES` ([src/crypto/crypto-local.js:654]) — no `scope` column needed; same as `documents`.

### Text generation (reuse, do not invent)
- `createInferenceRouter({ fetch, ollamaUrl, localModel, anthropicApiKey, openaiApiKey, cloudModel, baseUrl, jurisdiction, onUsage, … })` → `.infer({ prompt, task, maxTokens })` — [src/inference/router.js:41]. Tasks: `summarize|classify|extract|narrate|complex` ([router.js:25-27]).
- Active provider/model at call time: `resolveInferenceConfigForTask(db, userId, task)` — [src/inference/resolve.js:76] (reads `users.settings.taskModels[task]`, falls back to MRU active provider).
- Usage auto-recorded: `createUsageSink(db, userId, { source })` → `db.usage.record` into `llm_usage` (counts only, never content) — [src/inference/usage.js:41].
- Template caller: [src/portal-chat.js:19,23,195] imports both and resolves provider per request. Synchronous inline `.infer()` is available — no background job needed for an on-demand "summarize this area" button.

### Documents + migrations
- `documents` stable id = `(user_id, path)` tuple (UNIQUE); `path` is plaintext ([sweep: documents]).
- `db.documents.list(userId, {category,folderId,pinnedOnly,internalOnly})` → `[{path,title,summary,folder_id,pinned,…}]` — [src/db/documents.js:118-132].
- **No** `context_documents` junction exists — must create.
- `applyMigrations` re-execs every `*.sql` each boot but **guards** `ALTER TABLE … ADD COLUMN` via a `columnSet()` existence check, and `CREATE TABLE IF NOT EXISTS` is naturally idempotent — [src/db/migrate.js:29-51]. No `_migrations` table; lexical filename order. **Never** put DELETE/UPDATE data-mutation in a migration (re-runs every boot). Latest file: `0014_llm_usage.sql`.

---

## 3. Design

### 3.1 Data model (one new migration: `0015_context_areas.sql`)

```sql
-- Areas reuse sharing_contexts rows. Add the "areas" lens: an encrypted
-- AI summary + a documents junction. Schema-only; safe to re-exec (ADD COLUMN
-- guarded by applyMigrations; CREATE TABLE IF NOT EXISTS idempotent).
ALTER TABLE sharing_contexts ADD COLUMN summary TEXT;            -- encrypted (registry)
ALTER TABLE sharing_contexts ADD COLUMN summary_updated_at TEXT; -- plaintext timestamp

CREATE TABLE IF NOT EXISTS context_documents (
  context_id    TEXT NOT NULL,
  document_path TEXT NOT NULL,
  added_at      TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (context_id, document_path)
);

-- Public Space: a single enable flag + an (intentionally public) bio on the profile.
ALTER TABLE user_profiles ADD COLUMN public_space_enabled INTEGER DEFAULT 0;
ALTER TABLE user_profiles ADD COLUMN public_bio TEXT; -- PUBLIC by design → plaintext
```

`context_documents` holds only `(context_id, document_path)` — both already plaintext elsewhere (`path` is the plaintext UNIQUE key) ⇒ no new exposure, no encryption needed.

**Encryption registry** ([src/crypto/crypto-local.js], add after the `facts:` block):
```js
// Sharing contexts double as "Context Areas". name stays plaintext (facet
// label, queryable); the AI summary is a synthesis of attached documents —
// a semantic fingerprint of plaintext → ENCRYPT.
sharing_contexts: ['summary'],
```
`public_bio` is **not** added to the registry — it is meant to be world-readable.

### 3.2 db.contexts additions ([src/db/contexts.js])

```js
async setSummary(userId, contextId, summary) // UPDATE sharing_contexts SET summary=?, summary_updated_at=datetime('now') WHERE id=? AND user_id=?
async addDocument(userId, contextId, path)   // INSERT OR IGNORE INTO context_documents
async removeDocument(userId, contextId, path)// DELETE FROM context_documents
async getDocuments(contextId)                // JOIN documents → [{path,title,summary,updated_at}]
```
`list()` gains a `doc_count` via `LEFT JOIN context_documents` (mirrors the existing `territory_count` pattern at [src/db/contexts.js:41-45]).

### 3.3 Routes ([src/portal-compat.js], beside the existing context routes ~L676)

```
GET    /contexts/:id/documents              → { documents: [...] }
POST   /contexts/:id/documents { path }     → { ok }
DELETE /contexts/:id/documents/:path        → { ok }     (path URL-encoded; decodePath)
POST   /contexts/:id/summary                → { ok, summary }   inline infer(), regenerate
```
Each guarded by the existing `guardContext(res, id)`. The summary route:
1. `getDocuments(id)` → if empty, `fail(400,'attach documents first')`.
2. Build a prompt from each doc's `title` + `summary` (fall back to truncated `content`).
3. `resolveInferenceConfigForTask(db,userId,'summarize')` → `createInferenceRouter({...cfg, onUsage: createUsageSink(db,userId,{source:'context-area'})})` → `.infer({ task:'summarize', prompt, maxTokens: 400 })`.
4. `setSummary(userId, id, text)`; return it.

**Profile / Public Space** ([src/portal-compat.js] PUT /profile + readProfile):
- `readProfile()` SELECT gains `public_space_enabled, public_bio`.
- `PUT /profile` accepts `public_space_enabled` (0/1) and `public_bio` (slice 1000) in the existing dynamic-`sets` builder ([src/portal-compat.js:205-222]).

### 3.4 UI

- **Settings "Areas" pane** — new `PaneDef { id:'areas', label:'Areas', icon:'layers', desc:'Life domains that give your AI context' }` in `GROUPS` ([SettingsView.svelte:127]) under "Intelligence & access"; render block `{#if activePane==='areas'}<AreasView/>{/if}`; `railIcon` case; import. New `portal-app/src/lib/views/AreasView.svelte` (list areas → create/rename/delete; per area: attach/detach documents via a document picker hitting `/portal/documents`, "Regenerate summary" button, summary display).
- **Public Space** — extend `ProfileView.svelte`: a "Public Space" card with the enable toggle, the public URL (`<handle>.mycelium.id`, read-only, derived from handle), a `public_bio` textarea, saving via the existing `PUT /portal/profile`.

The existing "Spaces" view (`ContextsView.svelte`, sharing/territories lens) is **left intact** — Areas is the documents+summary lens on the same rows.

### 3.5 Scope boundary (env-honest)

- **Build + gate-verify now (no browser):** migration, registry entry, db methods, routes, profile columns. Covered by a new `verify:context-areas` gate.
- **Build + browser-verify (vite proxy, like prior P0/P1):** Areas pane + Public Space card. These are form UI, not canvas — verifiable in the standing vite→:8787 setup.
- **DEFER (separate, explicitly out of scope for #19):** the actual rendered public landing page at `<handle>.mycelium.id` (new serving surface on `public-server.js`; needs the same live-serving env the visual tasks wait on). #19's acceptance is "toggles on/off with URL config" + "settings persist" — met by the flag + bio + URL display. The landing-page render is tracked as a follow-up, not a blocker.

---

## 4. Threat model

| Concern | Treatment |
|---|---|
| AI summary leaks life-domain content | Encrypted at rest via `sharing_contexts:['summary']` registry entry under `'personal'` scope; transparent encrypt on write, fail-closed if key missing. |
| `public_bio` exposure | Intentionally public; plaintext by design; user-authored; capped at 1000 chars. No vault data auto-included. |
| Cross-user area access | Every route ownership-guarded by `guardContext` (`WHERE id=? AND user_id=?`); `context_documents` writes only via guarded routes. |
| Public Space toggled on exposes vault | The flag persists a preference only; **no** content is served until the deferred landing page ships, and that will gate on `published`/explicit per-area opt-in — never the whole vault. |
| Summary prompt egress | Goes through the same `createInferenceRouter`/`onUsage`/egress path as chat; jurisdiction tag inherited from active provider; usage recorded (counts only). |
| New attack surface | 4 additive routes + 2 ADD COLUMN + 1 junction. No change to auth, mounting, or existing context sharing semantics. |

---

## 5. Module shape + LOC budget (±20%)

| File | Change | LOC |
|---|---|---|
| `migrations/0015_context_areas.sql` | new | ~12 |
| `src/crypto/crypto-local.js` | `sharing_contexts:['summary']` | ~2 |
| `src/db/contexts.js` | 4 methods + `doc_count` in list | ~45 |
| `src/portal-compat.js` | 4 area routes + profile fields | ~55 |
| `portal-app/src/lib/views/AreasView.svelte` | new pane | ~220 |
| `portal-app/src/lib/views/SettingsView.svelte` | registry+render+icon+import | ~12 |
| `portal-app/src/lib/views/ProfileView.svelte` | Public Space card | ~70 |
| `tests/context-areas.test.mjs` + `verify:context-areas` | new gate | ~120 |
| **Total** | | **~536** |

---

## 6. Edge cases — explicit decisions

- **Summary on a default context (e.g. "Work Self"):** allowed — defaults are rename/delete-guarded but summary/documents are not name mutations. ✓
- **Attach a forgotten/deleted document:** `getDocuments` JOINs `documents`; rows whose path no longer exists simply don't return (LEFT JOIN dropped → filter NULL title). Stale `context_documents` rows are harmless; optional cleanup deferred.
- **Empty area summary request:** `fail(400,'attach documents first')` — no empty-prompt LLM call.
- **No provider configured:** `infer()` fails-soft per router; route returns `fail(503,'no AI provider configured')`; UI shows "connect a provider in Settings → Intelligence."
- **Very large area (many docs):** prompt built from per-doc `summary` (already short), capped to first N docs; note truncation in the prompt (mirrors `describe-chronicles` sampling). `maxTokens:400` bounds output.
- **Handle not set but Public Space enabled:** URL field shows "set a handle first"; toggle persists but UI nudges to set handle (handle is the slug).
- **Name uniqueness:** `sharing_contexts UNIQUE(user_id,name)` already enforces; `create` surfaces the error as `fail(400)`.

---

## 7. Test strategy

`tests/context-areas.test.mjs` (Node, better-sqlite3 in-memory, mirrors existing db tests) → wired as `verify:context-areas`:
1. **migration idempotency** — apply twice; columns + junction present once; no throw.
2. **encryption** — write a summary; read the **raw** `sharing_contexts.summary` column via a non-adapter query → assert it is a ciphertext envelope (not the plaintext); read via `db.contexts` → assert plaintext round-trips. (This is the security-critical assertion.)
3. **CRUD** — addDocument/getDocuments/removeDocument; `doc_count` in `list()`.
4. **ownership** — a route call with a foreign `context_id` → 404 via `guardContext`.
5. **summary fail-closed** — empty area → 400; no provider → 503 (mock resolve returns none).
6. **profile** — PUT `public_space_enabled`/`public_bio` persists; readProfile returns them; `public_bio` is plaintext in raw column (public by design).
7. svelte-check `--fail-on-warnings` clean on the 3 touched components.

---

## 8. Implementation order (each independently shippable + smoke)

1. **Migration + registry** → boot once; `sqlite3 … '.schema sharing_contexts'` shows `summary`; `verify:context-areas` step 1-2 green.
2. **db.contexts methods + tests** → `node --test tests/context-areas.test.mjs` (steps 2-3).
3. **Routes (areas + summary + profile)** → `curl -s localhost:8787/api/v1/portal/contexts/<id>/documents` (loopback); summary route returns text with a live provider.
4. **AreasView + Settings wiring** → vite :5174 proxy; create area, attach a doc, regenerate summary, see it render.
5. **Public Space card in ProfileView** → toggle + bio persist across reload.
6. **Gate** `verify:context-areas` → `VERDICT: GO`; svelte-check clean; commit.

---

## 9. Decision criteria to proceed past #19

- `verify:context-areas` EXIT 0 + svelte-check `--fail-on-warnings` EXIT 0.
- Browser: an area created, a document attached, a summary generated and displayed; Public Space toggle + bio persist across a reload (proof screenshot).
- Raw-column assertion proves the summary is ciphertext at rest (no plaintext leak).

---

## 10. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Forget to add registry entry → summary stored plaintext | Med | High | Test step 2 asserts ciphertext in the raw column; gate fails if plaintext. |
| Mis-cite `reference/` crypto copy (sweep did) | — | High | Verified live import path [src/adapter/d1.js:17] → `src/crypto/crypto-local.js`; edit only that file. |
| Areas vs Spaces user confusion (two lenses, one row) | Low | Low | Distinct labels/desc; Areas = "life domains for AI"; Spaces = "share with people". Revisit if users conflate. |
| Public landing page expectation unmet | Med | Low | Scope §3.5 explicitly defers the render; #19 acceptance met by flag+URL+bio. Documented as follow-up. |
| Summary egress to cloud provider surprises a privacy-sensitive user | Low | Med | Same egress/jurisdiction/usage path as chat; user already chose the provider; counts logged. |

---

## 11. Open questions resolved during sweep

- *Does `db.contexts` exist?* Yes — full namespace, mounted, live. The handoff's "build it / unverifiable wiring" premise was stale.
- *Encrypt the summary where?* `src/crypto/crypto-local.js` registry (live), not `reference/`. Author-verified the import.
- *New table or extend?* Extend `sharing_contexts` (+ one junction) per the locked decision; the territory/grant machinery is untouched.
- *Generate summary how?* Reuse `createInferenceRouter().infer({task:'summarize'})` inline; usage auto-recorded.
- *Migration safety for ADD COLUMN re-exec?* Guarded by `migrate.js` columnSet check; safe.

## 12. Open questions deferred (named, out of scope)

- Rendered public landing page at `<handle>.mycelium.id` (serving surface; same env gate as visual #11/#13).
- Auto-refresh of an area summary when its documents change (currently manual "Regenerate"); could hook `enqueueEnrichment`.
- Whether Areas should also expose the existing territory/grant sharing inline (keep separate for now).

---

## Verification table

| Assumption | Verified at (author-read) |
|---|---|
| `db.contexts` namespace exists with CRUD | [src/db/contexts.js:33-178] |
| Context routes mounted live at `/api/v1/portal` | [src/server-rest.js:164] |
| Context routes ownership-guarded | [src/portal-compat.js:614-617,619-676] |
| Live crypto file is `src/crypto/crypto-local.js` (not `reference/`) | [src/adapter/d1.js:17] |
| `documents` encrypts `summary` via `ENCRYPTED_FIELDS` | [src/crypto/crypto-local.js:246] |
| `sharing_contexts` absent from registry (plaintext today) | grep `sharing_contexts` in crypto-local.js → none |
| `autoEncryptParams` encrypts INSERT+UPDATE, fail-closed | [src/crypto/crypto-local.js:1565-1583] |
| Default scope `'personal'`; `sharing_contexts` not scope-aware | [src/adapter/d1.js:31], [src/crypto/crypto-local.js:654] |
| `ALTER TABLE ADD COLUMN` re-exec-safe (guarded) | [src/db/migrate.js:29-51] |
| `user_profiles` has handle, no public/visibility column | [migrations/0001_init.sql:1734-1746] |
| Profile routes + dynamic `sets` builder | [src/portal-compat.js:189-236] |
| Publishing is per-document only; no handle landing page | `public-server.js` (sweep: public space) |
| `documents` stable id `(user_id,path)`; `path` plaintext | [src/db/documents.js:118-132] |
| No `context_documents` junction exists | grep migrations → none |
| Inference reuse: `createInferenceRouter().infer({task})` | [src/inference/router.js:41,25-27] |
| Active provider resolver | [src/inference/resolve.js:76] |
| Usage auto-record sink | [src/inference/usage.js:41] |
| Portal call template | [src/portal-chat.js:19,23,195] |
| Settings pane registry + render + icon pattern | [SettingsView.svelte:127] |
