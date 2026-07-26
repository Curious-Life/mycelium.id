// Canonical-Mycelium vault import — ingest the ZIP produced by the canonical
// production Mycelium's `POST /portal/export` (one plaintext `manifest.json`
// with ~47 table families inline + `attachments/{id}/{file}` binaries + an
// `agents/` tree) into this V1 vault, re-encrypting everything under the V1 key.
// Design: the vault-import design.
//
// HOW DATA LANDS (the whole crypto story): every row goes through db.rawQuery —
// the SAME auto-encrypting adapter passthrough every namespace uses
// (src/db/index.js:62 → src/adapter/d1.js autoEncryptParams), so plaintext
// export values are encrypted at the query boundary with zero crypto code here.
// Attachment binaries go through putBlob (encrypted blob store). Nothing from
// the manifest is ever written to disk in plaintext (CLAUDE.md §1), and nothing
// from the archive ever chooses a filesystem path (no zip-slip surface — blob
// names are generated UUIDs; we only READ entries the manifest references).
//
// WHAT'S RESET: messages/documents arrive with their canonical enrichment
// products stripped (`nlp_processed=0`, embedding columns nulled) because the
// export carries NO search vectors (canonical Vectorize was never exported) —
// the local drainer re-embeds the whole backlog, then Generate evolves the
// (restored) mindscape natively.
//
// WHAT'S SKIPPED (reported, never silent): passkeys (WebAuthn credentials are
// origin-bound — meaningless on a new substrate) and secrets (the exporter
// excludes the values; key-only stubs would shadow real secret reads).
//
// WHAT'S REFUSED (round-3, reported in `refusedFamilies`): this archive is
// ATTACKER-SUPPLYABLE INPUT on THIS route too — it arrives through
// POST /api/v1/portal/upload → run-import.js → here — so the same deny-by-default
// import policy applies (src/ingest/import-credential-policy.js). Seven families
// this importer used to land verbatim are now refused: share_links (raw bearer
// capability tokens over a document path), access_grants + canvas_collaborators
// (latent ACLs), agent_tasks (the executed work queue), scheduled_events (a dormant
// executor), agent_events (this box's own runtime stream) and user_identities (the
// provider_id → owner mapping). restoreTable enforces the policy itself, so this is
// belt AND braces.
//
// Everything else crosses: user identity meta (display name / timezone /
// settings → the V1 users row), internal_model_items (the agent's model of the
// user), connections (canonical-uid remapped to the V1 user), ai_providers
// (the canonical export decrypts, so credentials may ride along — re-encrypted
// here by the adapter), and the `agents/` filesystem's text files (mind files,
// memory, prompts — V1 has no agent runtime FS, so they land as documents under
// `agents/...`, deterministic ids ⇒ idempotent).
import { extname, basename } from 'node:path';
import crypto from 'node:crypto';
import { putBlob, isUserNamespacedBlobPath, assertUserNamespacedBlobPath } from './blob-store.js';
import { getMasterKey } from '../crypto/crypto-local.js';
import { encryptVector } from '../search/ann/decode.js';
import { assertSafeBaseUrl } from '../inference/base-url.js';
import { KNOWN_PROVIDERS } from '../inference/known-providers.js';
import { credentialsCarrySubscriptionMaterial } from '../inference/subscription-token.js';
import { isImportAllowed, filterImportSettings } from './import-credential-policy.js';

const MAX_ROWS_PER_TABLE = Number(process.env.MYCELIUM_IMPORT_MAX_MESSAGES) || 1_000_000;
const MAX_ATTACHMENT_BYTES = Number(process.env.MYCELIUM_IMPORT_ATTACHMENT_LIMIT_BYTES) || 100 * 1024 * 1024;

const asArray = (v) => (Array.isArray(v) ? v : Array.isArray(v?.data) ? v.data : []);

/** Resolve a table's live columns.
 *
 * ⚠️ THE TABLE NAME IS NOT ALWAYS TRUSTED. This used to read "SQL-safe by construction:
 * table names come ONLY from this module's fixed spec below — never from the manifest."
 * That is true of THIS file's callers (every one passes a string literal) but restoreTable
 * is SHARED: full-export-import derives the table name from a bundle-controlled FILENAME.
 * The untrue comment is plausibly why nobody normalized it — and SQLite resolves
 * identifiers CASE-INSENSITIVELY, so an exact-match DENY let a bundle's "Secrets.ndjson"
 * write the field-encrypted `secrets` table. better-sqlite3's prepare() rejects
 * multi-statement SQL, so "; DROP" was never the risk — the DENY BYPASS was.
 *
 * ROUND-3: restoreTable no longer depends on its callers for this. It normalizes +
 * shape-checks the name itself before the policy match and before any SQL, so the
 * identifier reaching here is already `^[a-z_][a-z0-9_]*$`. full-export-import still
 * does its own check — defence in depth, not delegation. */
async function tableColumns(db, table) {
  try {
    const res = await db.rawQuery(`PRAGMA table_info(${table})`);
    return new Set((res?.results || []).map((r) => r.name));
  } catch { return new Set(); }
}

const normalizeValue = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return null; } }
  return v;
};

/**
 * Insert rows into one allowlisted table: column-intersected against the live
 * schema, user_id forced to the V1 user, INSERT OR IGNORE on preserved ids
 * (⇒ idempotent re-import). Fail-soft per row — one malformed row must not
 * abort a 50k-row import.
 */
export async function restoreTable(db, table, rows, { userId, overrides = {} }) {
  // `attempted`/`capped` feed the reconciliation report: declared − attempted
  // must be zero, or the report names exactly what was never even tried.
  // `inferredNow` (FAIL-LOUD, design Fix B): rows we INSERTED into a table that
  // HAS a created_at column WITHOUT carrying one → SQLite stamps the schema
  // default (import-time "now"). Silently this is the date-cliff bug; counted
  // here it surfaces in the reconciliation report so a lossy restore is visible.
  // `refused` (FAIL-LOUD, like skippedEmpty): a row dropped by a per-table SECURITY
  // policy, not by malformed data. Counted apart from `failed` so the reconciliation
  // report can say "we refused 1 provider row" instead of burying it in a generic
  // failure — a silently-vanishing credential row is indistinguishable from a bug.
  const out = { attempted: 0, inserted: 0, deduped: 0, failed: 0, capped: 0, skippedEmpty: 0, inferredNow: 0, refused: 0 };

  // ══ THE IMPORT POLICY GATE — at the CHOKEPOINT, not at one caller ══════════
  //
  // ROUND-3 FIX (2026-07-22). This check used to live in full-export-import.js
  // ONLY. restoreTable is SHARED by both shipped import routes, and the other one —
  // importMyceliumVault(), the route a user takes when they drag a vault export into
  // the app (run-import.js ARCHIVE_ADAPTERS.mycelium ← POST /api/v1/portal/upload) —
  // called it with SEVEN hardcoded literals this policy classifies `deny`:
  // share_links, access_grants, canvas_collaborators, agent_tasks, scheduled_events,
  // agent_events, user_identities. A reviewer reproduced it live: an attacker bearer
  // token landed in share_links (re-owned to the importing owner, expiring 2099) and
  // a status='pending' row landed in agent_tasks (agent-tasks.js:32 selects exactly
  // that for execution). The policy was right; its COVERAGE was one caller wide.
  //
  // Putting it here makes every present AND FUTURE call site fail closed by
  // construction — a new import route cannot forget a check it never has to write.
  // verify:import-credential-deny additionally ENUMERATES every restoreTable call
  // site in src/ at the source level, so a new literal naming a denied table also
  // fails the BUILD instead of quietly landing zero rows.
  //
  // The name is normalized + shape-checked HERE too, rather than trusted from the
  // caller. The old comment above tableColumns explained that full-export-import
  // lowercases the bundle-derived name before calling in; a shared function whose
  // safety depends on what its callers remember to do is the exact shape of the bug
  // this fix exists to close. `table` is interpolated into SQL, so the same check
  // that makes the policy match meaningful also makes the identifier safe.
  const t = String(table || '').trim().toLowerCase();
  if (t !== String(table || '') || !/^[a-z_][a-z0-9_]*$/.test(t)) {
    return { ...out, attempted: Array.isArray(rows) ? rows.length : 0, refused: Array.isArray(rows) ? rows.length : 0, skipped: 'invalid_table_name', policyDenied: true };
  }
  if (!isImportAllowed(t)) {
    // FAIL-LOUD, like `refused`: the count is reported so the reconciliation report
    // can say WHY rows did not land, instead of showing an unexplained `missing`.
    const n = Array.isArray(rows) ? rows.length : 0;
    return { ...out, attempted: n, refused: n, skipped: 'denied', policyDenied: true };
  }

  if (!Array.isArray(rows) || rows.length === 0) return out;
  const cols = await tableColumns(db, table);
  if (cols.size === 0) { out.failed = rows.length; out.attempted = rows.length; out.tableMissing = true; return out; }

  let n = 0;
  for (const row of rows) {
    if (++n > MAX_ROWS_PER_TABLE) { out.capped++; continue; }
    out.attempted++;
    if (!row || typeof row !== 'object') { out.failed++; continue; }
    try {
      const r = { ...row, ...overrides };
      if (cols.has('user_id')) r.user_id = userId;
      // Row↔envelope scope consistency: the adapter seals every imported value
      // under its fixed 'personal' scope, so the plaintext scope COLUMN must
      // say the same — a canonical 'org' label over a 'personal' envelope would
      // trip scope-filtered readers (SQL-level AGENT_SCOPES filtering and the
      // decrypt-time scope guardian both key off it).
      if (cols.has('scope')) r.scope = 'personal';
      // embedding_768 is NEVER_AUTO_DECRYPT: the canonical exporter's SELECT *
      // ships it as a CANONICAL-KEY envelope (territory_profiles, realms,
      // semantic_themes…), undecryptable here. Null it everywhere — V1 re-embeds.
      if (cols.has('embedding_768')) r.embedding_768 = null;
      // Fail-closed pipeline integrity (PIPELINE-INTEGRITY design §P1.1): a message
      // with no content AND no attachment can never embed/cluster/search — it would
      // land as a permanently-pending dead row (the source of the stuck "N remaining"
      // backlog). Skip it, mirroring captureMessage's live-path rule. Other tables
      // are unaffected.
      if (table === 'messages') {
        const content = typeof r.content === 'string' ? r.content.trim() : '';
        const hasAttachment = (r.attachment_id != null && r.attachment_id !== '') || (r.attachmentId != null && r.attachmentId !== '');
        if (!content && !hasAttachment) { out.skippedEmpty++; continue; }
        // ⛔ THE ENRICHMENT STRIP LIVES HERE, NOT IN A PER-CALLER `overrides` (D-047 ↻1).
        // The line 10 above already nulls `embedding_768` for EVERY table unconditionally — so any
        // caller that restores messages WITHOUT passing the enrichment overrides lands rows with no
        // vector but with the exporting vault's `categories_processed` and `nlp_processed` intact.
        // That is `tagged > embedded` straight out of an import, and permanently: a row left at
        // `nlp_processed = 1|2` fails selectPendingEnrichment's `(nlp_processed = 0 OR NULL)` so it
        // NEVER re-embeds, while `categories_processed = 1` means selectPendingCategories never
        // re-selects it either. Tagged forever, unsearchable forever.
        // `src/ingest/restore-core.js` was exactly that caller — `restoreTable(db, 'messages', part,
        // { userId })`, no overrides — reachable in production through the `recent-export` import
        // route (ingest/registry.js). Two of the three message-restore paths carried the strip in
        // their own MESSAGE_OVERRIDES and the third silently did not; the fix is to stop making it
        // optional. Same argument this file already makes for the credential policy: a rule a
        // future import route can forget is a rule that will be forgotten. (Callers may still pass
        // the overrides — they are now redundant, not wrong.)
        // `cols`-guarded like the `scope` / `embedding_768` strips above: only real columns of the
        // live schema are set, so this cannot fabricate a field on an older/newer table shape.
        for (const c of ['nlp_processed', 'categories_processed']) if (cols.has(c)) r[c] = 0;
        for (const c of ['nlp_processed_at', 'nlp_error', 'categorized_at', 'categories_model', 'domain', 'register', 'subregister']) {
          if (cols.has(c)) r[c] = null;
        }
      }
      // Multi-tenant floor: an attachments row may only carry a local_path
      // namespaced under its own user. Fail-closed here so no restore path (a
      // bundle-supplied value, or a future refactor that trusts it) can seed a
      // foreign-prefixed key the unscoped blob-GC would then treat as shared.
      // r.user_id was forced to `userId` above; null local_path (legacy r2-only)
      // is allowed.
      if (table === 'attachments' && r.local_path != null) assertUserNamespacedBlobPath(r.local_path, userId);
      // AI providers: this row is LIVE EGRESS CONFIG — `credentials` is sent in an
      // Authorization header to `base_url` along with the prompt (vault plaintext).
      // A bundle is attacker-supplyable input, and an import is a raw column-
      // intersected INSERT, so it bypasses every invariant POST /providers enforces
      // (portal-providers.js:332-364). Re-assert them here, at the only chokepoint
      // both import surfaces share. Refuse, never repair: a row we can't vouch for
      // is dropped, not silently rewritten into a different provider.
      if (table === 'ai_providers') {
        // (a) auth_type: the ONLY writer of an oauth row is persistSubscription
        //     (portal-providers.js:497-514) — the BYOK route hardcodes 'api_key', so
        //     an oauth row can never originate from a request body. Never import one:
        //     it would land a Claude subscription token (+ refresh token) chosen by
        //     whoever built the bundle, and §4g exemption keys off this row's vendor
        //     string. Cost of refusing: the user reclicks "Connect" — the token is
        //     device-scoped and paired with a config-dir seed the import can't do
        //     anyway, so a restored one is half-configured at best.
        if (String(r.auth_type || '').toLowerCase() === 'oauth') { out.refused++; continue; }
        // (a2) …but auth_type ALONE is a bypassable filter, so this is the real
        //     invariant: an import may never introduce subscription material in ANY
        //     shape. resolve.js:128 accepts a row as a subscription when a token is
        //     present AND (auth_type='oauth' OR vendor ∈ anthropic/claude/
        //     claude_subscription) — auth_type is only one DISJUNCT. So a row typed
        //     auth_type='api_key', provider='anthropic', credentials={claudeOAuthToken}
        //     passes (a) and still resolves as claude_subscription. Refuse on the
        //     credential SHAPE, read through the same helper the resolver uses so the
        //     two cannot drift. A legitimate BYOK row carries {apiKey} and is unaffected.
        if (credentialsCarrySubscriptionMaterial(r.credentials)) { out.refused++; continue; }
        // (b) provider: the column has no CHECK constraint, so an unknown vendor
        //     string would be resolvable by readers that switch on it. Store the
        //     NORMALIZED value — POST /providers lowercases before create, so letting
        //     'ANTHROPIC' land would resurrect a value the write path can never make
        //     (and setActive groups by exact string, so it could co-activate with
        //     'anthropic'). Compare and store the same form.
        const vendor = String(r.provider || '').toLowerCase();
        if (!KNOWN_PROVIDERS.has(vendor)) { out.refused++; continue; }
        r.provider = vendor;
        // (c) base_url: the SSRF/exfil guard (H5) the write path applies. Deliberately
        //     the SYNC literal check, not assertSafeBaseUrlResolved — a DNS lookup per
        //     row would make an OFFLINE restore fail closed on a legitimate provider.
        //     The resolving check still runs at every USE (base-url.js:54-60), which is
        //     where H5's defense-in-depth actually stops a live fetch.
        //     Counted as `refused`, NOT left to throw into the generic `failed` catch:
        //     this is a security refusal, and burying it in `failed` is exactly what
        //     `refused` exists to prevent (a legit self-hosted http://192.168.x LAN
        //     row would otherwise read as a mystery failure).
        //     NOTE: this rejects private/internal targets only. A public
        //     https://attacker.example PASSES here and CANNOT be allowlisted away
        //     (OpenRouter/Groq/Regolo are arbitrary public hosts) — which is why (d)
        //     is the control that actually carries this case.
        try { assertSafeBaseUrl(r.base_url); } catch { out.refused++; continue; }
        // (d) never resolvable until a human arms it. NOT merely cosmetic: `is_active`
        //     alone would be advisory — resolveProviderChain enumerates EVERY row and
        //     resolveInferenceConfigForTask takes a providerId out of users.settings,
        //     so neither consults it. status='pending' is ENFORCED at resolve.js's
        //     mapRowToConfig, the chokepoint every RESOLVER shares, so an imported row
        //     is unreachable to inference — not just unflagged — until the user clicks
        //     activate (setActive → status='active'), where the base_url is visible.
        //     This matters even with (a)-(c) passed: a bare public base_url resolves
        //     with NO credential at all (resolve.js OpenAI-compatible branch).
        //     SCOPE: mapRowToConfig covers resolution, NOT every read — a route reading
        //     the row directly must decide about 'pending' itself (GET /providers/:id/
        //     models was that gap; now guarded). Any new ai_providers reader must too.
        r.is_active = 0;
        r.status = 'pending';
      }
      // Connections: the row is user data (the federation graph) and must import,
      // but three of its columns are a PEER-KEY CACHE — remote_key_agreement is the
      // X25519 public key every outbound envelope is SEALED to, and remote_relay_inbox
      // is where it is posted (connections.js:284-306). A bundle-supplied pair would
      // silently redirect every sealed send for that peer to an attacker inbox, under
      // an attacker key, until the TTL expired. They are a CACHE by construction —
      // nulling them costs one did.json re-resolve on the next send — so scrub, and
      // let the live path re-derive them from the peer's own document.
      // (Not a DENY: connections themselves are exactly what a restore must bring back.)
      //
      // ⚠️ SCOPE of "a bundle cannot redirect sealed sends": that holds for a
      // PRE-EXISTING peer, where INSERT OR IGNORE + UNIQUE(user_a,user_b) mean the
      // bundle cannot overwrite the real row at all. For a bundle-INJECTED
      // connection the scrub only delays the redirect by one resolve —
      // federationDeliver computes peerDid = remote_did || did:web:<remoteDomain>
      // (connections.js:279) and re-resolves, after which the ATTACKER'S OWN
      // did.json legitimately caches the attacker's key + inbox (:296-300).
      // remote_did / remote_instance / remote_user_handle are attacker-chosen and
      // are NOT scrubbed — a connection's peer identity is what makes it that
      // connection. So the control for the INJECTED case is the status force below.
      if (table === 'connections') {
        r.remote_key_agreement = null; r.remote_relay_inbox = null; r.remote_keys_cached_at = null;
        // Never born accepted. Same shape as ai_providers' status='pending': an
        // imported connection is inert until a human re-establishes it, so an
        // injected peer cannot become a live sealed-send target by import alone.
        // accepted_at is cleared too so the row is not self-contradictory.
        r.status = 'pending'; r.accepted_at = null;
      }
      // Documents: the content must restore, but the PUBLICATION STATE must not.
      // published=1 is exactly what public-server.js:120-126 serves on `/p/:slug`,
      // and publish_nonce is the capability epoch an unlisted `/s/:slug?t=` link is
      // bound to (publish/links.js:49, verified at public-server.js:143). Without
      // this reset a bundle lands an attacker-authored page ALREADY PUBLIC under the
      // user's own handle, or a pre-minted unlisted link that works the moment the
      // import finishes. Re-publishing mints a fresh nonce (documents.js
      // setPublicSlug/publish), so nothing legitimate is lost.
      // ROUND-3 ADDITION: public_slug too. It is the PUBLIC NAMESPACE of the user's
      // own handle. An injected doc carrying an attacker-chosen slug SQUATS it —
      // tools/documents.js:132-135 then refuses the user's own publish with
      // "already in use by another doc", and :138-139 re-uses the planted slug for
      // the planted doc. Re-publishing re-derives a slug from the title.
      if (table === 'documents') { r.published = 0; r.publish_nonce = null; r.public_slug = null; }
      // peer_messages is a LIVE FEDERATION EGRESS QUEUE, not just history:
      // federationOutbox (db/connections.js:930-956) selects
      //   direction='out' AND status='failed' AND send_attempts < N
      // and calls federationDeliver with the row's own `content`, on an automatic
      // loop (server-rest.js:696 → createFederationPullLoop). An imported row in
      // that shape, hung off a real ACCEPTED connection (every real connection id
      // is in the user's own export), is attacker-authored text DELIVERED to a real
      // peer under the victim's federation identity with no explicit send — a
      // CLAUDE.md §11 violation. So force every imported row to a TERMINAL status
      // and zero its attempts: history restores, the queue predicate can never
      // match. (Not a DENY — the peer conversation is user data.)
      // The connections status='pending' force is a SECOND, weaker control here
      // (federationOutbox's loadConnection requires 'accepted'): it covers an
      // INJECTED peer but not a PRE-EXISTING accepted one. This force is the
      // control that carries the case. Recorded as `depends:` in the policy so it
      // cannot be removed silently one table away.
      if (table === 'peer_messages') {
        const dir = String(r.direction || '').toLowerCase() === 'out' ? 'out' : 'in';
        r.direction = dir;
        r.status = dir === 'out' ? 'delivered' : 'received';
        if (cols.has('send_attempts')) r.send_attempts = 0;
      }
      // harness_runs.prompt_hash is the key of a LIVE SUPPRESSION DECISION:
      // harness.wasRecentlyCompleted (db/harness.js:155-163) → agent/scheduler.js:162
      // skips a scheduled task when a run with the same prompt_hash is 'done' and
      // finished_at >= cutoff — and a bundle-chosen FUTURE finished_at satisfies that
      // cutoff forever. The hash includes the task's uuid, but in this threat model
      // the attacker holds the user's own export, so the uuid is not a secret. That
      // SELECT is the column's only reader (`prompt_hash = ?` never matches NULL), so
      // nulling it removes the suppression surface and keeps the run accounting.
      if (table === 'harness_runs') r.prompt_hash = null;
      // user_profiles: `handle` is a DERIVED MIRROR owned by identity/handle-service.js
      // (:169-181) and resolved as an identity at connections.js:446 — `users` was
      // DENIED for exactly this column. `did` belongs to federation identity, and
      // `public_space_enabled` is an opt-in PUBLIC exposure flag (migration 0016):
      // consent must never transfer through a file. Prose fields (signature,
      // public_bio, public_realms_json) are the user's own content and stay.
      // Only reachable on a FRESH vault anyway — user_id is the PK and the insert is
      // INSERT OR IGNORE — but dormancy is not a defence in this policy.
      // conversation_summaries — the round-4 review's third finding, and the one
      // place its proposed remedy was WRONG in the direction it claimed.
      //
      // harness.getSummary (db/harness.js:213-219) takes `ORDER BY created_at DESC
      // LIMIT 1` for (user_id, conversation_id), and INSERT OR IGNORE dedups on the
      // PK `id` — NOT on (user_id, conversation_id). So a bundle row naming a REAL
      // conversation with a future created_at WINS the ordering and is fed to
      // agent/history.js:66-72 as `prevSummary`: it REPLACES the agent's compacted
      // memory of a real thread. (`allow` still stands — a summary is analysis
      // output over the user's own corpus, not an authority decision — so this is a
      // neutralisation, not a denial.)
      //
      // ⚠️ The review said "force created_at to import-time closes it cheaply". It
      // does NOT: import-time is NEWER than every pre-existing real summary, so the
      // planted row would still sort first — the remedy would have made the attack
      // MORE reliable, not less. TWO controls, and the second is the one that carries:
      //   1. CLAMP a future stamp to import-time (a summary cannot predate its
      //      import into the future; a genuine restore's past stamps are untouched,
      //      which matters because created_at is also the ordering of real history).
      //   2. NEVER DISPLACE: if this vault already holds a summary for that
      //      conversation, the bundle's row is dropped as a duplicate.
      //
      // ⚠️ ROUND-5 CORRECTION OF THE COMMENT ABOVE. Round 4 called control 2 what
      // "makes the ordering unwinnable". It does NOT, and the residual is stated
      // rather than implied: never-displace only protects a conversation that
      // ALREADY HAS a summary. A real conversation with NONE yet — the COMMON case,
      // since summaries are written only after compaction — has no competitor to
      // out-order, so a bundle row for it still lands and still becomes `prevSummary`.
      // What the two controls actually buy: an EXISTING agent memory can never be
      // replaced, and no planted row can sort ahead of genuine history by claiming
      // the future. The remainder is bundle-authored recalled text entering a real
      // thread's context — bounded by, and no worse than, the PROMPT-INJECTION
      // RESIDUAL that `messages` already accepts wholesale (import-credential-policy.js,
      // foot of file). Accepted, documented, not closed here.
      //
      // On a FRESH vault (the normal restore) neither fires and the whole summary
      // history lands as-is.
      if (table === 'conversation_summaries') {
        const ts = Date.parse(r.created_at);
        if (!Number.isFinite(ts) || ts > Date.now()) r.created_at = new Date().toISOString();
        if (r.conversation_id != null && r.conversation_id !== '') {
          let held = false;
          try {
            const ex = await db.rawQuery(
              'SELECT id FROM conversation_summaries WHERE user_id = ? AND conversation_id = ? LIMIT 1',
              [userId, r.conversation_id],
            );
            held = Boolean((ex?.results || ex || []).length);
          } catch { held = false; }   // fail-soft read; the clamp above still stands
          if (held) { out.deduped++; continue; }
        }
      }
      if (table === 'user_profiles') { r.handle = null; r.did = null; r.public_space_enabled = 0; }
      const keys = Object.keys(r).filter((k) => cols.has(k) && r[k] !== undefined);
      if (keys.length === 0) { out.failed++; continue; }
      // Will this insert fall back to the schema-default created_at?
      const createdAtMissing = cols.has('created_at') && !keys.includes('created_at');
      const res = await db.rawQuery(
        `INSERT OR IGNORE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
        keys.map((k) => normalizeValue(r[k])),
      );
      if ((res?.meta?.changes ?? 0) > 0) { out.inserted++; if (createdAtMissing) out.inferredNow++; } else out.deduped++;
    } catch { out.failed++; }
  }
  return out;
}

/**
 * Inflate one zip entry to a Buffer with TWO independent caps so a decompression
 * bomb can never exhaust memory (M-ZIPBOMB, mirrors import-parsers.js):
 *   1) fast reject on the DECLARED uncompressed size before inflating; and
 *   2) a STREAMING byte counter that aborts inflation the instant the output
 *      passes maxBytes — bounds memory even if the header lies low or a future
 *      jszip drops the internal size field. Returns null if absent/empty/oversized.
 */
export function streamEntryCapped(entry, maxBytes) {
  if (!entry || entry.dir) return Promise.resolve(null);
  const declared = entry?._data?.uncompressedSize;
  if (typeof declared === 'number' && declared > maxBytes) return Promise.resolve(null);
  return new Promise((resolve) => {
    let total = 0;
    const chunks = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let stream;
    try { stream = entry.nodeStream('nodebuffer'); } catch { return finish(null); }
    stream.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) { try { stream.destroy(); } catch { /* noop */ } return finish(null); }
      chunks.push(chunk);
    });
    stream.on('end', () => finish(total === 0 ? null : Buffer.concat(chunks)));
    stream.on('error', () => finish(null));
    stream.on('close', () => finish(null)); // aborted/destroyed without 'end'
  });
}

/** Read one zip binary entry, streaming-capped at MAX_ATTACHMENT_BYTES. */
async function readBinaryEntry(zip, name) {
  return streamEntryCapped(zip.file(name), MAX_ATTACHMENT_BYTES);
}

/** Strip canonical enrichment products so the local pipeline regenerates them. */
// ⛔ `categories_processed: 0` IS PART OF THE STRIP (D-047 ↻1). This override nulls the vector
// and resets the embed stage, but used to leave `categories_processed` at whatever the exporting
// vault had — so a restore landed rows counted as TAGGED with NO EMBEDDING, i.e. `tagged >
// embedded` on the first read, before the drainer had run once. The L1 labels are an enrichment
// product exactly like `entities`; strip them with the rest so the local pipeline regenerates
// them in the right order (embed → categorize).
const MESSAGE_OVERRIDES = {
  nlp_processed: 0, nlp_processed_at: null, nlp_error: null,
  embedding_768: null, entities: null, relations: null, entity_summary: null,
  categories_processed: 0, categorized_at: null, categories_model: null,
  domain: null, register: null, subregister: null,
};

/**
 * Import a canonical `mycelium-vault-export` manifest (+ binaries) into the open
 * V1 vault. Returns the import screen's `{ imported, skipped, stats }` shape.
 *
 * @param {import('jszip')} zip      the loaded export archive
 * @param {object} manifest         parsed manifest.json (format already verified)
 * @param {{ db:object, userId:string, enqueueEnrichment?:(id:string)=>void }} deps
 */
export async function importMyceliumVault(zip, manifest, { db, userId, enqueueEnrichment = null }) {
  if (!db?.rawQuery) throw new Error('importMyceliumVault: db.rawQuery required');
  if (!userId) throw new Error('importMyceliumVault: userId required');
  const m = manifest || {};
  const stats = {};
  // Settings keys refused from the bundle (see the user_meta block). Held OUTSIDE `stats`
  // deliberately: the reconciliation loop iterates stats as {table → counters}, so an
  // array parked there becomes a junk pseudo-table ({declared:0,landed:0…}) AND still
  // never reaches the durable report. It belongs in the report, by name.
  let settingsRefused = [];
  // Round-4: unknown (un-classified) bundle settings keys, parked in the quarantine
  // rather than deleted, and the reason if the quarantine itself had to be dropped.
  // Same reporting rule as settingsRefused — a silent loss is indistinguishable from a bug.
  let settingsQuarantined = [];
  let settingsQuarantineDropped = null;
  // Round-5: allow-classified keys that were reverted to the LOCAL value because the
  // resulting blob blew the total cap (IMPORT_SETTINGS_MAX_BYTES). Reported for the
  // same reason as the two above — a silent loss is indistinguishable from a bug.
  let settingsOversizeDropped = [];
  const run = async (table, rows, overrides) => { stats[table] = await restoreTable(db, table, asArray(rows), { userId, overrides }); };

  /**
   * ROUND-3: a manifest family this policy REFUSES. Reported, never silent — the
   * user must be able to see in the durable report that e.g. their share links did
   * not come back, and why.
   *
   * Why a separate helper rather than deleting the lines: the manifest still
   * DECLARES these families, and a family that vanishes from the code is a family
   * whose absence nobody can audit. Why not just call restoreTable and let its gate
   * refuse: so the SOURCE-LEVEL call-site scan (verify:import-credential-deny) can
   * keep the simple, checkable rule "every literal restoreTable call site names an
   * allow table" — a denied literal there is now always a bug.
   *
   * Asserted, not asserted-in-a-comment: it refuses to be used on an allow table.
   */
  const refuseFamily = (table, rows) => {
    const n = asArray(rows).length;
    if (isImportAllowed(table)) throw new Error(`refuseFamily called on an importable table: ${table}`);
    stats[table] = { attempted: n, inserted: 0, deduped: 0, failed: 0, refused: n, skipped: 'denied' };
  };

  // Dependency-ordered (folders before documents, people before links, points
  // after hierarchy) — mirrors the reference import's order (reference:1012-1135).
  await run('folders', m.folders);

  // Documents — CONTENT DEDUP across paths, sources and imports. The schema's
  // UNIQUE(user_id, path) already blocks same-path duplicates; the gap is the
  // same CONTENT at different paths — canonical exports carry mind files BOTH
  // as documents AND as agents/-tree mirrors, and a doc may already exist here
  // via Obsidian import or native saveDocument (which writes the same
  // SHA-256(plaintext) content_hash — document-store.js B1). One copy wins; the
  // mirror is skipped. Guard: only dedupe substantial content (≥ 32 chars) so
  // trivially-identical stubs (empty README) don't collapse.
  const DOC_DEDUP_MIN_CHARS = 32;
  const docHashesSeen = new Set();
  try {
    const existingDocs = await db.rawQuery('SELECT content_hash FROM documents WHERE content_hash IS NOT NULL', []);
    for (const row of existingDocs?.results || []) if (row.content_hash) docHashesSeen.add(row.content_hash);
  } catch { /* no preload → path/id dedup still holds */ }
  const docHashOf = (content) => (typeof content === 'string' && content.length >= DOC_DEDUP_MIN_CHARS)
    ? crypto.createHash('sha256').update(content, 'utf8').digest('hex') : null;
  {
    const incoming = asArray(m.documents);
    let dedupedByContent = 0;
    const rows = [];
    for (const doc of incoming) {
      if (!doc || typeof doc !== 'object') { rows.push(doc); continue; }
      const hash = docHashOf(doc.content);
      if (hash && docHashesSeen.has(hash)) { dedupedByContent++; continue; }
      if (hash) docHashesSeen.add(hash);
      rows.push(hash ? { ...doc, content_hash: hash } : doc);
    }
    stats.documents = await restoreTable(db, 'documents', rows, { userId, overrides: { embedding_768: null } });
    stats.documents.dedupedByContent = dedupedByContent;
  }
  await run('document_versions', m.documents_meta?.versions);
  await run('note_links', m.documents_meta?.noteLinks);
  // ⚠️ REFUSED (round-3 P0). These two were `run(...)` — hardcoded literals for
  // tables the policy denies, on the route a user actually uses. share_links rows
  // are RAW BEARER CAPABILITY TOKENS over a document path (documents.js:385): the
  // reviewer landed a 64-char attacker token re-owned to the vault owner, pointing
  // at `private/notes.md`, expiring 2099. access_grants is a latent entity ACL.
  // Re-share instead; a share link is one click.
  refuseFamily('share_links', m.documents_meta?.shareLinks);
  refuseFamily('access_grants', m.documents_meta?.accessGrants);

  // Attachments (images/media): binary → encrypted blob → row (id preserved so
  // messages link). DEDUP SEMANTICS differ from documents: rows must ALWAYS
  // land (message attachment_ids point at them), but identical BYTES are stored
  // ONCE — duplicates share one encrypted blob via the same local_path. The
  // binary's SHA-256 rides in the row's metadata JSON so FUTURE imports dedupe
  // against blobs already in the vault, and rows whose id already exists skip
  // the blob write entirely (a re-import must not orphan duplicate blobs on
  // disk). Per-FILE accountability: every id that lost its binary or failed its
  // row is NAMED in the report (ids only — zero-leakage).
  // CONSTRAINT for future blob DELETION (none exists today — blob-store has no
  // unlink path): local_path may be SHARED by several attachment rows; delete a
  // blob only when no other row references its local_path.
  const attRows = asArray(m.attachments);
  const attStats = { attempted: attRows.length, inserted: 0, deduped: 0, failed: 0, blobs: 0, blobsReused: 0, blobMissing: 0, blobMissingIds: [], failedIds: [] };
  const existingAttIds = new Set();
  const blobByHash = new Map(); // sha256(bytes) → local_path (existing vault + this import)
  try {
    const existingAtts = await db.rawQuery('SELECT id, local_path, metadata FROM attachments', []);
    for (const row of existingAtts?.results || []) {
      if (row.id) existingAttIds.add(row.id);
      try {
        const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
        if (meta?.sha256 && row.local_path) blobByHash.set(meta.sha256, row.local_path);
      } catch { /* metadata not JSON → no hash to reuse */ }
    }
  } catch { /* no preload → per-id skip unavailable, import still correct */ }
  for (const att of attRows) {
    if (!att || typeof att !== 'object') { attStats.failed++; continue; }
    try {
      if (att.id && existingAttIds.has(att.id)) { attStats.deduped++; continue; } // row exists → no blob write
      let localPath = null;
      let sha = null;
      const buf = att.zipPath ? await readBinaryEntry(zip, att.zipPath) : null;
      if (buf) {
        sha = crypto.createHash('sha256').update(buf).digest('hex');
        // Reuse a byte-identical blob only if its path is namespaced under THIS
        // user. In single-user V1 it always is; the guard is the multi-tenant
        // floor for when the dedup preload SELECT spans other tenants — never
        // reuse a foreign-prefixed path, write a fresh owned blob instead.
        const reuse = blobByHash.get(sha);
        if (reuse && isUserNamespacedBlobPath(reuse, userId)) {
          localPath = reuse;
          attStats.blobsReused++;
        } else {
          const ext = att.file_name ? extname(att.file_name) : '';
          const { path } = await putBlob(buf, { userId, ext });
          localPath = path;
          blobByHash.set(sha, path);
          attStats.blobs++;
        }
      } else { attStats.blobMissing++; if (att.id) attStats.blobMissingIds.push(att.id); }
      const { zipPath: _zp, ...row } = att;
      let meta = null;
      try { meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? null); } catch { meta = null; }
      const metadata = sha ? { ...(meta && typeof meta === 'object' ? meta : {}), sha256: sha } : row.metadata;
      const r = await restoreTable(db, 'attachments', [{ ...row, metadata, local_path: localPath, r2_key: null, stream_uid: null }], { userId });
      attStats.inserted += r.inserted; attStats.deduped += r.deduped;
      if (r.failed) { attStats.failed += r.failed; if (att.id) attStats.failedIds.push(att.id); }
    } catch { attStats.failed++; if (att?.id) attStats.failedIds.push(att.id); }
  }
  stats.attachments = attStats;

  // Messages — the core corpus. Ids + timestamps preserved; enrichment reset so
  // the drainer re-embeds locally (the export has no search vectors).
  //
  // CROSS-IMPORT CONTENT DEDUP: a message that already exists under a DIFFERENT
  // id (e.g. the same conversation previously imported via the Claude/ChatGPT
  // path) must not duplicate. Key = plaintext SHA-256 of content (the exact
  // captureMessage/0007 hash, kept in the plaintext content_hash column)
  // + normalized created_at — content alone is too aggressive (repeated short
  // messages like "ok" are legitimate); content AT the same instant is the same
  // original message. Rows without content or timestamp fall back to id-dedup.
  {
    const incoming = asArray(m.messages);
    const normTs = (t) => { const d = t ? new Date(t) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null; };
    const seen = new Set();
    try {
      const existing = await db.rawQuery('SELECT content_hash, created_at FROM messages WHERE content_hash IS NOT NULL', []);
      for (const row of existing?.results || []) {
        const ts = normTs(row.created_at);
        if (row.content_hash && ts) seen.add(`${row.content_hash}:${ts}`);
      }
    } catch { /* no preload → id-dedup still holds */ }
    let dedupedByContent = 0;
    const rows = [];
    for (const msg of incoming) {
      if (!msg || typeof msg !== 'object') { rows.push(msg); continue; }
      const hash = (typeof msg.content === 'string' && msg.content)
        ? crypto.createHash('sha256').update(msg.content, 'utf8').digest('hex') : null;
      const ts = normTs(msg.created_at);
      const key = hash && ts ? `${hash}:${ts}` : null;
      if (key && seen.has(key)) { dedupedByContent++; continue; }
      if (key) seen.add(key); // also dedupes duplicates WITHIN the export itself
      rows.push(hash ? { ...msg, content_hash: hash } : msg);
    }
    stats.messages = await restoreTable(db, 'messages', rows, { userId, overrides: MESSAGE_OVERRIDES });
    stats.messages.dedupedByContent = dedupedByContent;
  }

  await run('people', m.contacts);
  await run('contact_territories', m.contacts?.territoryLinks);

  // health arrives in the namespace's getRange shape (parsed rows, numbers,
  // possibly no id) — synthesize the documented deterministic key when absent.
  {
    const healthRows = asArray(m.health?.daily ?? m.health).map((h) =>
      (h && typeof h === 'object' && !h.id && h.date) ? { ...h, id: `${userId}:${h.date}` } : h);
    stats.health_daily = await restoreTable(db, 'health_daily', healthRows, { userId });
  }
  await run('activity_sessions', m.activity?.sessions);
  await run('activity_daily', m.activity?.daily);

  await run('wealth_portfolios', m.wealth?.portfolios);
  await run('wealth_assets', m.wealth?.assets);
  await run('wealth_positions', m.wealth?.positions);
  await run('wealth_transactions', m.wealth?.transactions);
  await run('wealth_snapshots', m.wealth?.snapshots);
  await run('wealth_watchlist', m.wealth?.watchlist);
  await run('wealth_wallets', m.wealthExtra?.wallets);
  await run('wealth_portfolio_access', m.wealthExtra?.portfolioAccess);

  await run('canvas_workspaces', m.canvases?.workspaces);
  await run('canvas_nodes', m.canvases?.nodes);
  await run('canvas_edges', m.canvases?.edges);
  refuseFamily('canvas_collaborators', m.canvases?.collaborators); // canvas ACL (access_level)

  // agent_tasks is the AGENT WORK QUEUE — agent-tasks.js:32 selects status='pending'
  // for execution, with a bundle-authored description/context and channel_id, and it
  // has no user_id so the forced re-own never fires. The reviewer landed
  // {"status":"pending","description":"EXFIL EVERYTHING"} through this exact call.
  refuseFamily('agent_tasks', m.tasks?.agentTasks);
  await run('tasks', m.tasks?.personalTasks); // the user's TODO list — nothing executes it
  await run('reflections', m.reflections);
  await run('cycle_metrics', m.cycleMetrics);
  refuseFamily('scheduled_events', m.scheduledEvents); // dormant executor table (event_type + schedule + enabled)
  refuseFamily('agent_events', m.agentEvents);         // this box's own append-only runtime stream

  // The agent's internal model of the user — "model internals" are continuity-
  // critical even though new writes go to persona-claims; preserve the history.
  await run('internal_model_items', m.internalModel);

  // AI providers: the canonical export reads through its decrypting proxy, so
  // credentials MAY ride along as plaintext.
  // ⚠️ STALE PROSE CORRECTED (2026-07-16): this used to end "— the adapter re-encrypts
  // them here (ENCRYPTED_FIELDS.ai_providers)". That is FALSE and was the exact failure
  // mode crypto-local.js:243 documents: ENCRYPTED_FIELDS.ai_providers is `[]` (a
  // DELIBERATE post-SQLCipher-collapse choice, crypto-local.js:209-220), so `credentials`
  // lands VERBATIM in the column and its at-rest protection is whole-file SQLCipher —
  // not a field envelope. Nothing re-encrypts on the way in.
  // restoreTable() refuses oauth rows / unknown vendors / unsafe base_urls and never
  // imports a row as active — see the ai_providers branch there for why.
  await run('ai_providers', m.aiProviders);

  // Connections: V1 carries the same user_a/user_b schema. Remap the canonical
  // user id to the V1 user on every side it appears; the counterpart stays as
  // recorded (it's another instance's identity — historical, not actionable).
  {
    const canonicalUid = m.user?.id;
    const remap = (v) => (canonicalUid && v === canonicalUid ? userId : v);
    const conns = asArray(m.connections).map((c) => (c && typeof c === 'object'
      ? { ...c, user_a: remap(c.user_a), user_b: remap(c.user_b), initiated_by: remap(c.initiated_by) }
      : c));
    stats.connections = await restoreTable(db, 'connections', conns, { userId });
  }

  await run('user_profiles', m.user?.profile ? [m.user.profile] : []);
  // user_identities maps a discord provider_id → owner user_id (db/user-identities.js:23):
  // a bundle row makes an attacker's Discord account resolve as the vault owner.
  refuseFamily('user_identities', m.user?.identities);

  // User identity meta → the V1 users row (UPDATE, never a second row keyed by
  // the canonical id): display name, timezone, settings carry the person over.
  {
    const u = m.user || {};
    const sets = [];
    const params = [];
    // ROUND-5: both are bundle-chosen strings on the SAME write as the settings blob,
    // and both were uncapped here while the portal's own PUT caps display_name at 200
    // (portal-compat.js:473). display_name is rendered in the portal and joined into
    // member listings; timezone is read on scheduling paths. An import must not be a
    // wider door than the UI — clamp to the UI's own bound rather than reject, so a
    // legitimately long name still restores (truncated) instead of vanishing.
    if (typeof u.displayName === 'string' && u.displayName) { sets.push('display_name = ?'); params.push(u.displayName.slice(0, 200)); }
    if (typeof u.timezone === 'string' && u.timezone) { sets.push('timezone = ?'); params.push(u.timezone.slice(0, 64)); }
    // ── users.settings — the THIRD write path, ALLOWLISTED (round-4) ─────────
    //
    // This block is the ONE write in this file that does not go through
    // `restoreTable`, so the chokepoint's table policy does not cover it. `users`
    // is classified `deny` there; the exception is deliberate and narrow (carry the
    // PERSON over: display name, timezone, settings) and it carries its own gate.
    //
    // WHAT CHANGED IN ROUND 4, and why the old shape was not salvageable:
    //   • It was a second, hand-maintained DENYLIST (`IMPORT_REFUSED_SETTINGS`) with
    //     ZERO verify: coverage — the third such list to rot in three rounds.
    //   • Its own comment claimed the vocabulary "IS enumerable — nine keys". It was
    //     FOURTEEN when that sentence was written. The five it never saw were the two
    //     P1s: `enrich*Paused*` (a bundle durably stops the user's own embedding +
    //     categorization, re-read on EVERY boot by enrich/drainer.js) and
    //     `recovery_key_backed_up` (a bundle defeats the U1.3 backup gate, so the user
    //     is never shown their recovery key — durable, silent, unrecoverable loss).
    //   • It REPLACED the blob wholesale, so a bundle that merely OMITS
    //     `recovery_key_backed_up` deletes the explicit `false` the server wrote at
    //     setup and defeats the same gate with no forgery at all.
    //
    // Now: the vocabulary is CLASSIFIED in import-credential-policy.js (one place to
    // look, next to the table policy), the surviving set is the ALLOW set, the write
    // MERGES over the local blob instead of replacing it, and
    // `verify:import-credential-deny` enumerates every settings key written or read
    // anywhere in src/ and REDs on any that is not classified — so a settings key
    // added tomorrow is safe by default rather than dangerous by default.
    //
    // Sovereignty is preserved, not traded away: keys this backend does not know
    // (a CANONICAL vault carries some) are not deleted, they are parked in
    // `importedSettingsQuarantine`, which by gate-enforced assertion nothing in src/
    // reads. Classified-dangerous keys ARE dropped — consent and policy must not
    // transfer through a file — and both lists are reported.
    if (u.settings && typeof u.settings === 'object' && Object.keys(u.settings).length) {
      let local = {};
      try { local = (await db.users?.getSettings?.(userId)) || {}; } catch { local = {}; }
      const f = filterImportSettings(u.settings, local);
      settingsRefused = f.refused;
      settingsQuarantined = f.quarantined;
      settingsQuarantineDropped = f.quarantineDropped;
      settingsOversizeDropped = f.oversizeDropped;
      if (f.changed) { sets.push('settings = ?'); params.push(JSON.stringify(f.next)); }
    }
    let updated = 0;
    if (sets.length) {
      try {
        await db.rawQuery('INSERT OR IGNORE INTO users (id) VALUES (?)', [userId]);
        const res = await db.rawQuery(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, userId]);
        updated = res?.meta?.changes ?? 0;
      } catch { /* fail-soft like every family */ }
    }
    // `updated`, not `inserted`: an UPDATE re-applies on every run (SQLite
    // counts matched rows), so it must not break re-import ⇒ imported:0.
    stats.user_meta = { inserted: 0, deduped: 0, failed: 0, updated };
  }

  // Mindscape — restored, not regenerated: territory narratives/names/lineage
  // are user history that cannot be recreated identically. Nomic hex vectors are
  // folded into clustering_points and auto-encrypted on insert; the next
  // Generate run evolves this hierarchy from the re-embedded messages.
  await run('realms', m.mindscape?.realms);
  await run('semantic_themes', m.mindscape?.semanticThemes);
  await run('territory_profiles', m.mindscape?.territories);
  await run('theme_cards', m.mindscape?.themeCards);
  {
    // nomicEmbeddings.data is an OBJECT MAP { pointId: hex } (reference:827) —
    // hex() of whatever bytes canonical stored. Two honest cases:
    //   • raw float32 bytes (multiple of 4) → re-encrypt under the V1 key via
    //     encryptVector — nomic_embedding is CALLER-encrypted by design
    //     (NEVER_AUTO_DECRYPT_COLUMNS: the adapter never touches it);
    //   • a wrapped-DEK envelope (JSON, starts '{') → ciphertext under the
    //     CANONICAL key, undecryptable here → DROP the vector (reported), keep
    //     the point row; the next Generate re-derives vectors.
    const points = asArray(m.mindscape?.clusteringPoints);
    const rawNomic = m.mindscape?.nomicEmbeddings?.data ?? m.mindscape?.nomicEmbeddings;
    const nomicHex = new Map();
    if (rawNomic && typeof rawNomic === 'object' && !Array.isArray(rawNomic)) {
      for (const [id, hx] of Object.entries(rawNomic)) if (typeof hx === 'string') nomicHex.set(id, hx);
    } else {
      for (const e of asArray(rawNomic)) {
        const hx = e?.nomic_embedding ?? e?.hex ?? e?.embedding;
        if (e?.id && typeof hx === 'string') nomicHex.set(e.id, hx);
      }
    }
    let vectors = 0, foreignVectors = 0;
    const masterKey = nomicHex.size ? await getMasterKey() : null;
    const folded = [];
    for (const p of points) {
      if (!p) continue;
      const hx = nomicHex.get(p.id);
      if (!hx) { folded.push(p); continue; }
      let envelope = null;
      try {
        const buf = Buffer.from(hx, 'hex');
        if (buf.length > 0 && buf[0] === 0x7b /* '{' — already an envelope */) {
          foreignVectors++;
        } else if (buf.length > 0 && buf.length % 4 === 0) {
          const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
          envelope = await encryptVector(new Float32Array(ab), 'personal', masterKey);
          vectors++;
        }
      } catch { /* malformed hex → point without vector */ }
      folded.push(envelope ? { ...p, nomic_embedding: envelope } : p);
    }
    stats.clustering_points = await restoreTable(db, 'clustering_points', folded, { userId });
    stats.clustering_points.vectors = vectors;
    stats.clustering_points.foreignVectors = foreignVectors;
  }
  await run('cluster_events', m.mindscape?.clusterEvents);
  await run('territory_cofire', m.topology?.cofiring);
  await run('territory_neighbors', m.topology?.territoryNeighbors);
  await run('realm_neighbors', m.topology?.realmNeighbors);
  // Entity change-log (V1-native; absent from canonical exports → no-op there).
  // Present so a V1→V1 export/import round-trips the history; restoreTable
  // re-encrypts the payload blob via the adapter like every other table.
  await run('entity_snapshots', m.history?.entitySnapshots);

  // Temporal Chronicles — period narratives + the current arc. The canonical
  // exporter does not ship these yet (exporter-side gap, flagged 2026-06-10);
  // the receiver is ready for the manifest keys the exporter patch adds, and
  // tolerates singular/plural. Absent keys → no-op, like every family.
  await run('time_chronicles', m.timeChronicles);
  await run('current_arc_chronicles', m.currentArcChronicles ?? (m.currentArcChronicle ? [m.currentArcChronicle].flat() : undefined));

  // v4 historical metrics (v3 bundles simply lack these keys → no-op).
  await run('cognitive_metrics_window', m.cognitiveMetrics?.window);
  await run('cognitive_metrics_trajectory', m.cognitiveMetrics?.trajectory);
  await run('cognitive_metrics_per_territory', m.cognitiveMetrics?.perTerritory);
  await run('topology_metrics', m.cognitiveMetrics?.topology);

  // The agents/ filesystem — mind files, memory, prompts, .shared/ notes. V1 is
  // a pure tool server (no agent runtime FS), so the TEXT files land as
  // documents under their original `agents/...` path. Deterministic ids
  // (sha256 of the path) make re-imports no-ops; binaries and oversized files
  // are counted, never silently dropped. Shares the documents content-hash set:
  // canonical MIRRORS mind files into the agent tree (MIND_MIRRORS), so a file
  // whose content already landed as a document is a mirror → skipped, counted.
  {
    const TEXT_EXT = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.csv']);
    const MAX_AGENT_FILE_BYTES = 5 * 1024 * 1024;
    const agentStats = { attempted: 0, inserted: 0, deduped: 0, dedupedByContent: 0, failed: 0, skippedBinary: 0, skippedOversize: 0, skippedUnsafe: 0, inferredNow: 0 };
    const entries = Object.values(zip.files).filter((f) => !f.dir && f.name.startsWith('agents/'));
    for (const entry of entries) {
      // Path-traversal guard: entry.name is stored verbatim as documents.path.
      // A crafted `agents/../../x` passes the startsWith filter; reject any `..`
      // segment / absolute / `//` so a malicious export can't write outside the
      // agents/ namespace in the document model.
      const segs = entry.name.split('/');
      if (entry.name.startsWith('/') || segs.some((s) => s === '..' || s === '')) { agentStats.skippedUnsafe++; continue; }
      const ext = extname(entry.name).toLowerCase();
      if (!TEXT_EXT.has(ext)) { agentStats.skippedBinary++; continue; }
      try {
        // Streaming-capped inflate (M-ZIPBOMB): aborts past MAX_AGENT_FILE_BYTES
        // before buffering the whole entry. null = absent/empty/oversized.
        const buf = await streamEntryCapped(entry, MAX_AGENT_FILE_BYTES);
        if (!buf) { agentStats.skippedOversize++; continue; }
        const content = buf.toString('utf8');
        const hash = docHashOf(content);
        if (hash && docHashesSeen.has(hash)) { agentStats.dedupedByContent++; continue; }
        agentStats.attempted++;
        const id = crypto.createHash('sha256').update(`vault-import:agents:${entry.name}`).digest('hex').slice(0, 32);
        // created_at from the zip entry's stored date — WITHOUT it restoreTable
        // omits the column and documents.created_at defaults to now(), stamping
        // every agent mind-file with the IMPORT date (the same bug fixed on the
        // full-export path). Fall back to now() only when the entry carries no
        // usable date. PROPER FIX is exporter-side: mycelium-vault-export should
        // write each agent file's ORIGINAL mtime into the zip entry (JSZip
        // `{ date }`) so the stored date is the authored date, not export time.
        const entryDate = entry.date instanceof Date && !Number.isNaN(entry.date.getTime()) ? entry.date : null;
        const r = await restoreTable(db, 'documents', [{
          id,
          path: entry.name,
          title: basename(entry.name),
          content,
          content_hash: hash,
          ...(entryDate ? { created_at: entryDate.toISOString() } : {}),
          created_by: 'vault-import',
          embedding_768: null,
        }], { userId });
        if (hash && r.inserted) docHashesSeen.add(hash);
        agentStats.inserted += r.inserted; agentStats.deduped += r.deduped; agentStats.failed += r.failed;
        agentStats.inferredNow += (r.inferredNow || 0); // FAIL-LOUD: agent files stamped import-time (no entry date)
      } catch { agentStats.failed++; }
    }
    stats.agent_files = agentStats;
  }

  // One nudge wakes the drainer; it scans the whole nlp_processed=0 backlog.
  const firstMsg = asArray(m.messages)[0];
  if (firstMsg?.id && typeof enqueueEnrichment === 'function') {
    try { enqueueEnrichment(firstMsg.id); } catch { /* non-fatal */ }
  }

  let imported = 0, skipped = 0, failed = 0;
  for (const s of Object.values(stats)) {
    imported += s.inserted || 0;
    skipped += (s.deduped || 0) + (s.dedupedByContent || 0);
    failed += s.failed || 0;
  }

  // ── Reconciliation: account for EVERY data point the export declared ───────
  // Three independent accountability layers, so loss can never be silent:
  //   1. per-family: declared (the exporter's own totals where present, else
  //      the array length we consumed) vs landed (inserted+deduped) vs failed —
  //      `missing` > 0 means rows we never even attempted (cap hit etc.);
  //   2. manifest coverage: any TOP-LEVEL key this importer does not know is
  //      named in `unhandledFamilies` — a future exporter addition is flagged
  //      loudly, never silently dropped;
  //   3. per-file: attachment ids that lost a binary or failed a row are listed
  //      by id (zero-leakage) in stats.attachments.
  const KNOWN_KEYS = new Set([
    'exportedAt', 'version', 'format', 'meta', 'user', 'messages', 'documents',
    'folders', 'attachments', 'mindscape', 'contacts', 'health', 'activity',
    'wealth', 'wealthExtra', 'canvases', 'tasks', 'internalModel',
    'documents_meta', 'connections', 'reflections', 'aiProviders',
    'scheduledEvents', 'secrets', 'agentEvents', 'cycleMetrics',
    'cognitiveMetrics', 'topology', 'timeChronicles', 'currentArcChronicle',
    'currentArcChronicles',
  ]);
  const unhandledFamilies = Object.keys(m).filter((k) => !KNOWN_KEYS.has(k));

  const declaredOf = {
    messages: m.messages?.total,
    documents: m.documents?.total,
    attachments: m.attachments?.total,
    people: m.contacts?.total,
    clustering_points: m.mindscape?.clusteringPoints?.total,
    agent_events: m.agentEvents?.total,
  };
  const reconciliation = {};
  let missingTotal = 0, cappedTotal = 0, tableMissingCount = 0;
  for (const [table, s] of Object.entries(stats)) {
    const handled = (s.attempted ?? 0) + (s.capped ?? 0) + (s.dedupedByContent ?? 0);
    const declared = Number.isFinite(declaredOf[table]) ? declaredOf[table] : handled;
    const landed = (s.inserted || 0) + (s.deduped || 0) + (s.dedupedByContent || 0) + (s.updated || 0);
    // `refused` is a DELIBERATE security drop (restoreTable's per-table policy), so it
    // is accounted here rather than left to surface as unexplained `missing` — the
    // durable report is the only artifact the user keeps, and "missing: 1" with no
    // reason is precisely the burying `refused` was split out of `failed` to avoid.
    const refused = s.refused || 0;
    const missing = Math.max(0, declared - landed - (s.failed || 0) - refused);
    reconciliation[table] = {
      declared, landed, failed: s.failed || 0, missing,
      ...(refused ? { refused } : {}),
      ...(s.capped ? { capped: s.capped } : {}),
      ...(s.tableMissing ? { tableMissing: true } : {}),
      ...(s.dedupedByContent ? { dedupedByContent: s.dedupedByContent } : {}),
    };
    missingTotal += missing; cappedTotal += s.capped || 0;
    if (s.tableMissing) tableMissingCount++;
  }
  // Export-side losses (canonical couldn't fetch these from R2 — they were
  // never IN the zip; distinct from receiver-side loss but still reported).
  const exportSide = { attachmentsFetchFailedAtExport: Number(m.attachments?.failed) || 0 };
  const complete = failed === 0 && missingTotal === 0 && cappedTotal === 0
    && tableMissingCount === 0 && unhandledFamilies.length === 0;

  // Persist the report INSIDE the vault (encrypted document, deterministic id
  // keyed by the export's timestamp → a re-import refreshes it in place). The
  // response is transient; this is the durable migration-audit artifact.
  const report = {
    v: 1,
    importedAt: new Date().toISOString(),
    exportedAt: m.exportedAt ?? null,
    exportVersion: m.version ?? null,
    complete,
    unhandledFamilies,
    reconciliation,
    exportSide,
    attachmentsDetail: { blobMissingIds: stats.attachments?.blobMissingIds || [], failedIds: stats.attachments?.failedIds || [] },
    agentFiles: stats.agent_files || null,
    // Named in the DURABLE report, not just the transient response: these are settings
    // the user HAD and no longer has, and the report is the only artifact they keep.
    // (This is the same bug `refused` was split out of `failed` to cure — reporting it
    // into `stats` alone would have repeated it one function down.)
    // Its OWN field, not an extra `skippedFamilies` entry: these are settings KEYS, not a
    // table family, and skippedFamilies is a fixed 2-element contract (verify:vault-import
    // V8). Named here because the report is the only artifact the user keeps — this is the
    // same lesson as `refused`, which is why it isn't parked in `stats` either.
    settingsRefused,
    settingsQuarantined,
    settingsQuarantineDropped,
    settingsOversizeDropped,
    // ROUND-3: the families the import POLICY refuses (src/ingest/import-credential-policy.js).
    // Named in the durable report for the same reason as `settingsRefused`: these are
    // rows the user HAD and no longer has, and a silent security drop is
    // indistinguishable from a bug. Its own field, not an extra `skippedFamilies`
    // entry — that is a fixed 2-element contract (verify:vault-import V8).
    refusedFamilies: Object.entries(stats)
      .filter(([, s]) => s?.skipped === 'denied')
      .map(([t, s]) => `${t} (${s.refused || 0} rows refused — denied by the import policy)`),
    skippedFamilies: [
      'passkeys (WebAuthn is origin-bound — re-enroll on this device)',
      'secrets (values excluded by the exporter — re-add in Settings)',
    ],
  };
  const reportPath = `imports/vault-import-report-${String(m.exportedAt || report.importedAt).slice(0, 10)}.json`;
  try {
    const reportId = crypto.createHash('sha256').update(`vault-import-report:${m.exportedAt ?? 'unknown'}`).digest('hex').slice(0, 32);
    await db.rawQuery(
      'INSERT OR REPLACE INTO documents (id, user_id, path, title, content, created_by, scope) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [reportId, userId, reportPath, 'Vault import report', JSON.stringify(report, null, 2), 'vault-import', 'personal'],
    );
  } catch { /* the response still carries the report */ }

  return {
    imported, skipped, failed,
    complete,
    stats,
    reconciliation,
    unhandledFamilies,
    exportSide,
    reportPath,
    settingsRefused,
    settingsQuarantined,
    settingsQuarantineDropped,
    settingsOversizeDropped,
    refusedFamilies: report.refusedFamilies,
    skippedFamilies: report.skippedFamilies,
    exportVersion: m.version ?? null,
    exportedAt: m.exportedAt ?? null,
  };
}
