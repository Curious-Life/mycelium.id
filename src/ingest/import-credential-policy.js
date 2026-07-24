// Import table policy — the STRUCTURAL basis of the vault-import allow decision.
//
// WHY THIS FILE EXISTS
// -------------------
// TWO shipped importers restore an attacker-supplyable archive into the vault:
//   • `full-export-import.js` — a `mycelium-full-export` directory, where
//     `db/<table>.ndjson` NAMES the table; and
//   • `vault-import.js` `importMyceliumVault()` — a `mycelium-vault-export` ZIP,
//     reached from ANY file upload (`run-import.js` ARCHIVE_ADAPTERS.mycelium ←
//     `POST /api/v1/portal/upload`). This is the route a user actually takes when
//     they drag a vault export into the app. Its table names are HARDCODED
//     LITERALS, but the ROWS are still bundle-authored.
// Both land rows through the same `restoreTable`, which column-intersects against
// the live schema, forces `user_id` to the importing owner (vault-import.js), and
// runs with `PRAGMA foreign_keys = OFF`. Whatever an importer is willing to write,
// a bundle can choose the contents of.
//
// ⚠️ HISTORY, ROUND 3 (2026-07-22): the round-2 fix gated exactly ONE of those two
// routes. `isImportAllowed` was called only from full-export-import; `restoreTable`
// itself had NO table-level policy check, and `importMyceliumVault` called it with
// seven hardcoded literals this very file classifies `deny` — share_links,
// access_grants, canvas_collaborators, agent_tasks, scheduled_events, agent_events,
// user_identities. An independent reviewer REPRODUCED it live through
// `POST /api/v1/portal/upload`: a crafted zip landed an attacker bearer token in
// `share_links` (re-owned to the importing owner, expiring 2099) and a
// `status:'pending'` row in `agent_tasks` (which agent-tasks.js:32 selects for
// execution). The module header's "THE IMPORTABLE SET IS THE CLASSIFIED SET" was
// true of one importer, not of the tree.
//
// THE GATE IS NOW AT THE CHOKEPOINT, NOT AT ONE CALLER. `restoreTable` itself
// refuses any table without an explicit `allow` verdict, so every present and
// future call site is gated by construction; `verify:import-credential-deny`
// additionally ENUMERATES every `restoreTable` call site in `src/` at the SOURCE
// level, so an eighth route naming a denied table RED-fails the build.
//
// The first version of this file was a DENY list gated by a credential-shaped
// REGEX. That is fail-closed only within the regex's reach, and the reach is not
// the security boundary: a table named `device_login_blobs(id, user_id, data)`
// matches nothing, is classified by nothing, and imports silently. The regex is
// therefore demoted here to TRIAGE (severity hinting) and the basis is INVERTED:
//
//   ► THE IMPORTABLE SET IS THE CLASSIFIED SET.
//     A table is importable IFF it carries an explicit `allow` verdict below.
//     Every other live table — denied here, denied in the operational literal in
//     full-export-import.js, or simply NOT MENTIONED ANYWHERE — is refused at
//     runtime, and an unmentioned one additionally RED-fails
//     `verify:import-credential-deny` until a human writes down what it is.
//
// WHAT THAT ACTUALLY GUARANTEES (no more, no less):
//   1. A newly-added table cannot become importable by accident. It has no
//      `allow` verdict, so the importer skips it (`skipped:'not-classified'`),
//      and the gate goes RED so the omission is not silent.
//   2. Every importable table has a written, reviewable rationale.
//   3. It does NOT guarantee the rationales are correct. `allow` is a human
//      judgement; the gate only proves one was made and recorded.
//
// THE CLASSIFICATION RULE APPLIED BELOW
//   DENY when a row is (or plausibly becomes) read as an AUTHORITY DECISION —
//   authentication, authorization / ACL / membership, deliverability, key
//   distribution, autonomous execution, public exposure — or when it is this
//   box's own runtime / anti-replay state. Dormancy is NOT a defence: a table
//   nothing reads today is read tomorrow, and the bundle's row sits in the vault
//   until then.
//   ALLOW only for content, telemetry and analysis outputs the user reads back,
//   and only where any residual authority is neutralised — either by the forced
//   re-own (`reown: true`, gate-checked to actually have a `user_id` column) or
//   by an explicit column scrub in restoreTable (`scrub: [...]`, gate-checked to
//   be implemented).
//
// HISTORY: 2026-07-22 — `device_tokens` (migration 0052, the per-device owner
// bearer) was missing from DENY, so a bundle's `db/device_tokens.ndjson` planted
// an attacker-chosen `token_hash` as a LIVE owner-authority device token
// (src/db/device-tokens.js matchSync), reachable over the relay and able to read
// the static MCP bearer (portal-providers.js:467). The round-2 review then proved
// three more grants the regex had waved through (`identity_channels`,
// `channel_access`, `telegram_groups`) and nine the regex never saw at all — which
// is what forced the inversion above.

/** Name/column shapes that HINT a table is credential-ish.
 *
 *  ⚠️ TRIAGE ONLY — this is NOT the security boundary and must never be used as
 *  one. It exists so the gate can label a finding "credential-shaped" (raising
 *  its severity for a reviewer). The boundary is the explicit classification
 *  below: unclassified ⇒ not importable, regardless of what this matches. */
export const CREDENTIAL_TABLE_RX = /(token|secret|key|credential|session|hash|password|nonce|challenge|passkey|auth|otp|bearer|signature|private)/i;

/**
 * Verdicts:
 *   'deny'        — never importable. Must be present in full-export-import's DENY.
 *   'deny-future' — same, for a table that does not exist in the live schema YET
 *                   (designed-but-unshipped). Denied the day it lands; the gate
 *                   does NOT treat its absence as staleness.
 *   'allow'       — importable. `why` must say why the row carries no authority.
 *
 * Optional fields on an `allow`:
 *   reown: true   — the rationale RELIES on restoreTable forcing `user_id` to the
 *                   importing owner. The gate asserts the live table actually HAS
 *                   a `user_id` column, so this reasoning can never be applied to
 *                   one of the importable tables that lack one.
 *   scrub: [cols] — the rationale RELIES on restoreTable neutralising these
 *                   columns. The gate asserts restoreTable's `if (table === '<t>')`
 *                   BRANCH names each one — per-table, not file-wide, so a column
 *                   scrubbed for some OTHER table cannot satisfy this claim.
 *   depends: [{table, scrub:[cols]}]
 *                 — the rationale RELIES on a control that lives on a DIFFERENT
 *                   table's import (e.g. peer_messages is only safe because
 *                   `connections` is forced to status='pending'). The gate asserts
 *                   that other table's policy still declares that scrub, so the
 *                   dependency cannot be silently removed one entry away.
 *   update: [cols] — ROUND-5. This table is written by a raw `UPDATE` that does NOT
 *                   go through restoreTable, on the columns named. It is the only
 *                   annotation that records a MUTATION OF A PRE-EXISTING ROW, and it
 *                   is therefore what bounds every "INSERT OR IGNORE means a bundle
 *                   cannot overwrite the real row" argument elsewhere in this file —
 *                   those arguments are scoped to the chokepoint, not to the whole
 *                   importer. See THE FOUR WRITE PATHS below.
 *
 * ─── THE FOUR WRITE PATHS AN IMPORT HAS (round-5; complete as of this commit) ───
 *   1. restoreTable — the chokepoint. Everything in this policy gates it.
 *   2. vault-import.js `INSERT OR IGNORE INTO users` + `UPDATE users SET …` —
 *      display_name / timezone / settings. Gated by IMPORT_SETTINGS_POLICY below,
 *      enumerated by C7j. (Round 4.)
 *   3. the blob / attachment writes (content-addressed, confined under the import root).
 *   4. full-export-import.js `vectorPass` (:222-245) — six raw
 *      `UPDATE <t> SET <col> = ? WHERE id = ? AND user_id = ?` statements driven by
 *      embeddings/*.ndjson, selecting the row by a BUNDLE-SUPPLIED `id`. This is the
 *      ONLY import write that mutates a row the vault already had. Each of the six
 *      tables declares `update:` above. Risk as shipped is LOW — all six are already
 *      `allow`, the payload is a float32 blob (not an instruction), the statement is
 *      scoped `AND user_id = ?`, and the route requires an out-of-band-granted allowed
 *      root — but it is REAL: attacker vectors can displace a genuine
 *      `messages.embedding_768`, and the same statement sets `nlp_processed = 1` so
 *      nothing ever re-embeds it. That is durable retrieval poisoning, and it is
 *      recorded here rather than left to be re-discovered in a fifth round.
 *      C7j (generalized in round 5) now REDs on ANY INSERT/UPDATE/REPLACE under
 *      src/ingest/ that is neither restoreTable nor an enumerated, named exception.
 */
export const IMPORT_TABLE_POLICY = Object.freeze({
  // ══ DENY — authentication / bearer material ═══════════════════════════════
  sessions: { verdict: 'deny', why: 'portal session tokens — a bundle-chosen token authenticates as the owner.' },
  device_tokens: { verdict: 'deny', why: 'per-device owner bearer (0052). token_hash IS the credential; matchSync authorizes the portal + relay, and the session can read the static MCP bearer. The 2026-07-22 P0.' },
  device_sessions: { verdict: 'deny', why: 'per-device/web session rows (0056), bound to a device_tokens row. session_hash IS a credential: a bundle-chosen hash authenticates as the owner at both gates until the token is revoked. Now live (U7 unified auth) — flipped deny-future→deny.' },
  agent_tokens: { verdict: 'deny', why: 'agent bearer tokens (token_hash / parent_token_hash).' },
  passkey_credentials: { verdict: 'deny', why: 'WebAuthn credentials — origin-bound and authority-bearing.' },
  registration_tokens: { verdict: 'deny', why: 'one-shot enrolment tokens.' },
  step_up_tokens: { verdict: 'deny', why: 'step-up re-auth tokens + challenges.' },
  email_otp_challenges: { verdict: 'deny', why: 'OTP code hashes — a known code_hash is a login.' },
  oauth_states: { verdict: 'deny', why: 'OAuth/PKCE state — replayable authorization state.' },
  secrets: { verdict: 'deny', why: 'the field-encrypted secret store (bot tokens, API keys) — the adapter would re-seal a planted value under the user own key, producing a valid working secret.' },
  federation_keys: { verdict: 'deny', why: 'instance signing / key-agreement material — identity forgery.' },
  fleet_attest_keys: { verdict: 'deny', why: 'raw attestation key hex.' },
  provisioning_jobs: { verdict: 'deny', why: 'carries key_hash, agent_tokens_json, passkey_credential_id, passkey_public_key.' },
  visitor_sessions: { verdict: 'deny', why: 'public visitor session tokens.' },
  telegram_widget_sessions: { verdict: 'deny', why: 'Telegram login-widget auth signatures.' },
  public_presence: { verdict: 'deny', why: 'presence session ids for the public surface — cross-tenant + session material.' },
  claude_sessions: { verdict: 'deny', why: 'Claude Code session ids. Machine-local resume handles: a foreign value can only mis-point the harness at a session this box never created.' },
  share_links: { verdict: 'deny', why: 'raw bearer capability token granting read of a document path (documents.js:385). A bundle-chosen token is a pre-shared link into the victim vault. Re-share instead.' },

  // ══ DENY — identity binding, ACL, membership, deliverability ══════════════
  // Round-2 review PROVED the first three of these importable and exploitable on
  // the first fix. They are the reason the regex is no longer the boundary.
  identity_channels: {
    verdict: 'deny',
    why: 'the single source of truth for (channel_kind, channel_value) → owner_user_id (db/identity-channels.js:2), and delivery_enabled=1 IS the fail-closed §11 deliverability gate that internal-router.js:165-180 answers channel-authority from. A bundle row therefore BINDS an attacker-controlled Telegram/Discord target to the owner and marks it deliverable — the agent will send to it. It has owner_user_id, NOT user_id, so the forced re-own never fires. Written only by the pairing / authorize ceremonies; re-pair instead of restoring.',
  },
  channel_access: {
    verdict: 'deny',
    why: 'the prompt-injection ACL. decideAccess defaults a missing policy to "allowlist" precisely so a third party in a group cannot converse with the agent and surface recalled vault data (0011_channel_access.sql, db/channel-access.js:24-30). A bundle row setting mode="open" — or allowlisting an attacker sender id — flips that fail-closed default and internal-router.js:242 returns respond:true. No user_id, so no re-own. Invisible to the credential regex: this is exactly why the basis had to be inverted.',
  },
  telegram_groups: {
    verdict: 'deny',
    why: 'active=1 IS the channel on/off authorization (0011_channel_access.sql:2-3; telegram-groups.js:35 only ever selects active=1), answered to the daemon by internal-router.js:187. Chained with channel_access (also denied) a bundle owns the whole authorize→respond path. "It defers to channel_access" was not a defence — channel_access was importable too.',
  },
  user_identities: {
    verdict: 'deny',
    why: 'the discord provider_id → owner user_id mapping (db/user-identities.js:23). A bundle row makes an attacker Discord account resolve as the vault owner. "Dormant today" is not a defence — the row persists until the day something reads it.',
  },
  access_grants: { verdict: 'deny', why: 'entity-level ACL (access_level per entity_type/entity_id). No live V1 reader today, which is exactly why a planted grant would sit in the vault unnoticed until one exists.' },
  canvas_collaborators: { verdict: 'deny', why: 'canvas workspace ACL (access_level). Same latent-authority reasoning as access_grants; nothing legitimate is lost because V1 has no collaborator surface yet.' },
  context_grants: { verdict: 'deny', why: 'grants a federation connection access to a sharing context — an authorization edge to a PEER, and with no user_id it cannot be re-owned. Grants are made by the sharing ceremony, never restored.' },
  context_documents: {
    verdict: 'deny',
    why: 'ROUND-3 CORRECTION — was allow, on the false rationale "inert without a grant, and context_grants is denied". The grant does not have to be IMPORTED: it can ALREADY EXIST. sharing_contexts restores under INSERT OR IGNORE, so a bundle naming a REAL, already-granted context id leaves the real row (and its real grant) standing and merely attaches new rows to it. contexts.getDocuments (db/contexts.js:214) has NO user_id filter and the table has no user_id, and the peer-facing gate (connections.js:1244-1248) only requires a PRE-EXISTING grant on a non-private context. So a bundle row adding `private/*` paths to a live shared context OVER-SHARES arbitrary documents to a real peer. Nothing legitimate is lost that a re-add cannot restore; the membership is a handful of rows the user chose deliberately.',
  },
  context_territories: {
    verdict: 'deny',
    why: 'ROUND-3 CORRECTION — the identical hole one table over. canSeeTerritory (db/contexts.js:170-180) joins context_territories → context_grants → accepted connection → non-private sharing_contexts, with NO ownership filter on context_territories itself (it has no user_id). Adding a territory_id under a real already-granted context exposes that territory to a live peer. Denied with context_documents; re-add instead.',
  },
  inbound_shares: { verdict: 'deny', why: 'what a peer has shared INTO this vault, including the peer `role`. A bundle row fabricates a share (and its role) from an attacker did. No user_id.' },
  shared_spaces: { verdict: 'deny', why: 'the space membership / handshake row (status, settings_json, connection_id). Space membership is established by the space protocol, never restored from a bundle.' },
  space_invites: { verdict: 'deny', why: 'space invite token_hash + role. No user_id, so restoreTable cannot re-own it — it lands verbatim with a bundle-chosen invite secret and role.' },
  space_access: { verdict: 'deny', why: 'the live shared-space ACL (db/spaces.js requireRole) plus invite_token_hash.' },
  space_cek_grants: { verdict: 'deny', why: 'CEK GRANT RECORDS — key distribution. Each row hands an opaque wrapped-key `blob` for (space_id, gen) to a recipient_did (space-key-manager.js, space-oplog.js:89). A bundle chooses recipient_did, gen and blob: this is the key-distribution table, the one place a restore must never write.' },
  space_origin: { verdict: 'deny', why: 'declares which instance is a space HOME and its current key generation (is_home, current_gen, origin_did). A bundle row claims origin authority for a space and can roll the generation.' },
  space_oplog: { verdict: 'deny', why: 'the space operation log. Moved from allow in round 2: with space_access / space_origin / space_cek_grants all denied, restoring ops for a space this vault is not a member of is pure attacker-authored protocol state. Space content re-syncs from the space.' },
  space_rooms: { verdict: 'deny', why: 'space protocol structure (rooms) — re-synced from the space, never restored from a bundle. Denied with the space_* family.' },
  space_room_documents: { verdict: 'deny', why: 'space room ↔ document binding; a bundle row would expose a local document path inside a space. Denied with the space_* family.' },
  space_matrix_rooms: { verdict: 'deny', why: 'space ↔ Matrix room binding — a transport binding a bundle must not choose. Denied with the space_* family.' },
  space_knowledge: { verdict: 'deny', why: 'space-shared knowledge entries incl. visibility/status — a bundle must not author what this vault believes a space published. Denied with the space_* family.' },
  space_knowledge_history: { verdict: 'deny', why: 'edit history of the above, incl. edited_by_user_id attribution. Denied with the space_* family.' },
  space_conversations: { verdict: 'deny', why: 'per-space conversation binding incl. takeaway_opt_in (a sharing CONSENT flag a bundle must not set). Denied with the space_* family.' },

  // ══ DENY — autonomous execution / attacker-authored instructions ══════════
  scheduled_tasks: {
    verdict: 'deny',
    why: 'a scheduled_tasks row is a PERSISTENT ATTACKER-AUTHORED PROMPT that the scheduler fires as a headless turn (0019_harness.sql:27-51; agent/scheduler.js) with a bundle-chosen enabled_tools set and output_target (which can be channel:<id> — an egress). status/next_run are indexed for exactly that pickup. Cost of denying: the user re-creates their cycles, which are few and visible; the alternative is a bundle that runs turns in the vault forever.',
  },
  scheduled_events: { verdict: 'deny', why: 'the same shape one layer down (event_type + schedule + enabled) with no live V1 reader — a dormant executor table. Denied rather than left as a latent scheduled_tasks.' },
  agent_tasks: { verdict: 'deny', why: 'the agent work queue: agent-tasks.js:32 selects status="pending" for execution, with a bundle-authored description/context and a channel_id. No user_id, so no re-own.' },
  agent_events: { verdict: 'deny', why: 'this box own append-only agent event stream (db/events.js). Runtime state, no user_id, nothing legitimate to restore.' },
  agent_customizations: { verdict: 'deny', why: 'per-agent persona / system-prompt material (crypto-local.js:329; portal-mindscape.js:114 names system_prompt / tools_config). It enters the model context in INSTRUCTION position, not as recalled data — the distinction that makes messages/documents safe to restore and this not. Nothing reads it in V1 yet, so denying costs nothing today.' },

  // ══ DENY — this box's own runtime / anti-replay / provisioning state ══════
  federation_seen: { verdict: 'deny', why: 'inbound replay-dedup nonces. Pre-seeding them silently DROPS the user real inbound federation traffic.' },
  outbound_envelope_dedup: { verdict: 'deny', why: 'outbound send-dedup hashes — the same suppression hazard in the other direction.' },
  cascade_state: { verdict: 'deny', why: 'singleton reconciler state (assignments.js). A planted "applying" row stalls the cascade; it is this box own runtime state, never a bundle.' },
  deployment_log: { verdict: 'deny', why: 'operational deploy provenance incl. file_hashes — this box own record.' },
  egress_audit: { verdict: 'deny', why: 'the §11 egress record — THIS box account of what the agent actually sent, and it has no user_id so it cannot even be re-owned. Round-1 called it "user history"; that is the same reasoning that (correctly) denies deployment_log and ai_provider_assignments_audit: a bundle writing an audit table FORGES the evidence the audit exists to provide (CLAUDE.md §8). Nothing legitimate needs a foreign box egress log restored here.' },
  channel_write_audit: { verdict: 'deny', why: 'the per-channel write audit — same forging hazard as egress_audit, one surface over. Denied for the same reason rather than left as the one importable audit table.' },
  pipeline_state: { verdict: 'deny', why: 'per-stage pipeline ledger; `quarantined` is read as a live gate (metrics/freshness.js) so a planted row stalls the user own enrichment. This box runtime state, not vault content.' },
  narration_runs: { verdict: 'deny', why: 'in-flight narration run checkpoint + single-flight lock (jobs.js:720-734). A planted "running" row blocks the user own runs.' },
  connectors: { verdict: 'deny', why: 'live connector sync configuration (status/cursor). Its credential lives in `secrets` (denied), so a restored row is half-configured at best, and a bundle-chosen `cursor` silently suppresses the user own sync — the federation_seen hazard in another surface. Reconnect instead.' },
  ai_provider_assignments: { verdict: 'deny', why: 'desired_state per (agent, provider) — the input the assignment cascade applies (db/assignments.js:85). A bundle row is a request to re-point an agent inference at a provider row of its choosing.' },
  ai_provider_assignments_audit: { verdict: 'deny', why: 'the actor/action audit of the above. This box own record of who changed provider wiring; a bundle writing it forges that record.' },
  sqlite_sequence: { verdict: 'deny', why: 'SQLite internal AUTOINCREMENT bookkeeping. Writing it from a bundle corrupts id allocation; it is not user data under any reading.' },
  users: {
    verdict: 'deny',
    why: 'no user_id column, so the forced re-own never fires: a bundle row lands a GHOST USER with an attacker-chosen id, handle (the public publishing identity), settings blob (which selects providers) and type (incl. type="space"). The importing owner row already exists — identity meta is carried by the canonical vault-import path, not by a raw users INSERT from a bundle.',
  },

  // ══ ALLOW — content / telemetry / analysis outputs ════════════════════════
  // Each rationale must survive one question: "what live code path reads this row
  // as a DECISION?" If the answer is any authority decision, it belongs above.
  ai_providers: { verdict: 'allow', reown: true, scrub: ['is_active', 'status'], why: 'credentials/auth_type ARE sensitive, but this table is policed ROW-level in restoreTable: oauth rows and any subscription-shaped credential are refused, provider is allowlisted, base_url re-validated, and status is forced to "pending" so the row is unreachable to every resolver until a human arms it. Denying it would break the legitimate BYOK restore.' },
  connections: { verdict: 'allow', scrub: ['remote_key_agreement', 'remote_relay_inbox', 'remote_keys_cached_at', 'status', 'accepted_at'], why: 'the federation connection graph is user data and must restore. Neutralised on import: the peer-key CACHE (remote_key_agreement / remote_relay_inbox / remote_keys_cached_at) is scrubbed to NULL, and status is forced to "pending" with accepted_at cleared so an INJECTED connection is never born accepted. The scrub ALONE was not enough — federationDeliver derives peerDid = remote_did || did:web:<remote_instance> (connections.js:279) and re-resolves from the peer own did.json, so for an injected row an attacker domain would legitimately re-cache the attacker key + inbox one round later. For a PRE-EXISTING peer the scrub is sufficient on its own (INSERT OR IGNORE + UNIQUE(user_a,user_b) means the bundle cannot overwrite the real row THROUGH restoreTable — and `connections` declares no `update:`, so the round-5 vectorPass exception does not reach it either). ROUND-4 NOTE (depends, recorded so it cannot be removed silently): `initiated_by` / `user_a` / `user_b` are BUNDLE-CHOSEN and unscrubbed — an injected row can name anyone as the initiator. What actually keeps a FORGED incoming request from rendering as a one-click accept is not this entry at all: it is the INNER `JOIN user_profiles up ON up.user_id = c.initiated_by` in connections.pending() (db/connections.js:634-641) combined with user_profiles being force-re-owned + handle/did scrubbed on import, so a forged initiator resolves to no profile row and the request never appears. If that JOIN is ever relaxed to a LEFT JOIN, or the pending list stops requiring a profile, this becomes a live one-click-accept surface and these three columns must be scrubbed here.' },
  documents: {
    verdict: 'allow',
    reown: true,
    scrub: ['published', 'publish_nonce', 'public_slug'],
    update: ['embedding_768'],
    why: 'VECTOR UPDATE (see `messages`): vectorPass can overwrite a real document\'s embedding_768 by bundle-supplied id. ORIGINAL RATIONALE: documents are the vault. `published` and `publish_nonce` are forced back to 0/NULL on import so a bundle cannot land an attacker-authored page PRE-PUBLISHED under the user own handle (public-server.js:120-126 serves iff published=1; publish_nonce is the unlisted-link capability epoch, links.js:49). ROUND-3 ADDITION: `public_slug` is scrubbed too — it is the PUBLIC NAMESPACE of the user own handle, and an injected doc holding an attacker-chosen slug SQUATS it: tools/documents.js:132-135 then refuses the user own publish ("already in use by another doc"), and :138-139 would silently re-use the planted slug for the planted doc. Cost: a restored document re-derives its slug from the title on the next publish. Everything else is content metadata.' },
  document_versions: { verdict: 'allow', reown: true, why: 'prior revisions of the user own documents — content history, carrying no publish state.' },
  messages: {
    verdict: 'allow',
    reown: true,
    update: ['embedding_768', 'nlp_processed'],
    why: 'ROUND-5 — THE FOURTH UNGATED WRITE, recorded so it cannot be lost again: full-export-import.js:222-245 `vectorPass` issues raw `UPDATE messages SET embedding_768 = ? WHERE id = ? AND user_id = ?` from embeddings/*.ndjson. It does NOT go through restoreTable, and it is the ONLY import write that MUTATES A PRE-EXISTING ROW — the row is selected by a BUNDLE-SUPPLIED `id`. So the reassurance elsewhere in this file that "INSERT OR IGNORE means a bundle cannot overwrite the real row" does not hold for these columns. For `messages` it is the worst case of the six: an attacker vector can overwrite the REAL embedding_768 of a real message, and `nlp_processed = 1` is set in the same statement so nothing ever re-embeds it — durable retrieval poisoning (the message ranks for text it is not about, or for nothing). LOW as shipped: all six tables are `allow`, the vector is a blob not an instruction, and the route requires an out-of-band-granted allowed root — but it is a REAL ungated write and it is named here rather than argued away. ORIGINAL RATIONALE: the conversation corpus — the primary thing a restore exists to bring back. content_hash / thinking_tokens / pinned are content + accounting metadata; enrichment products are reset on import.' },
  peer_messages: {
    verdict: 'allow',
    reown: true,
    scrub: ['direction', 'status', 'send_attempts'],
    depends: [{ table: 'connections', scrub: ['status'] }],
    why: 'ROUND-3 CORRECTION — the round-2 rationale discussed only nonces and was therefore about the wrong column. peer_messages is also a LIVE FEDERATION EGRESS QUEUE: federationOutbox (db/connections.js:930-956) selects direction="out" AND status="failed" AND send_attempts < N and calls federationDeliver with the row own `content`, on an automatic loop (server-rest.js:696 → createFederationPullLoop). A bundle row with {direction:"out", status:"failed", connection_id:<a real ACCEPTED connection — every real connection id is in the user own export>} is therefore attacker-authored text delivered to a real peer under the victim federation identity with NO explicit send — a CLAUDE.md §11 egress violation. NEUTRALISED, not denied (the peer conversation history is exactly what a restore must bring back): restoreTable forces every imported row to a TERMINAL status — out→"delivered", in→"received" — normalizes `direction` to in/out, and zeroes send_attempts, so no imported row can ever match the outbox predicate. `depends` records the second, WEAKER control the round-2 text left implicit: connections import as status="pending", and federationOutbox loadConnection requires status="accepted" — that is a real defence for an INJECTED peer but NOT for a PRE-EXISTING accepted one, which is why the status force above is the control that actually carries this.',
  },
  conversation_summaries: {
    verdict: 'allow',
    reown: true,
    scrub: ['created_at', 'conversation_id'],
    why: 'ROUND-4 ADDITION — generated summaries of the user\'s own conversations are analysis output, not an authority decision, so `allow` stands. But harness.getSummary (db/harness.js:213-219) picks the winner by `ORDER BY created_at DESC LIMIT 1` per (user_id, conversation_id) while INSERT OR IGNORE dedups on the PK `id` — so a bundle row naming a REAL conversation with a future created_at outranks the genuine one and is handed to agent/history.js:66-72 as `prevSummary`, REPLACING the agent\'s compacted memory of a real thread. Neutralised in restoreTable by TWO controls: created_at is CLAMPED to import-time if it is in the future or unparseable, and a row is DROPPED (deduped) when this vault already holds a summary for that conversation_id. The clamp alone is not sufficient and the review\'s suggested "force to import-time" is actively wrong: import-time outranks every pre-existing real summary, so that remedy would have strengthened the attack. ROUND-5 CORRECTION OF THIS ENTRY\'S OWN CLAIM — round 4 said never-displace makes the ordering "unwinnable". It does not, and the residual must be stated: never-displace only protects a conversation that ALREADY HAS a summary. A real conversation with NO summary yet — the COMMON case, since summaries are written only after compaction — has no competitor to out-order, so a bundle row for it still lands and still becomes `prevSummary` on the next turn. What the two controls actually buy is: an EXISTING agent memory can never be replaced, and a planted row can never sort ahead of genuine history by claiming the future. The remaining surface is bundle-authored recalled text entering a real thread\'s context, whose severity is bounded by — and not better than — the PROMPT-INJECTION RESIDUAL recorded at the foot of this file, which `messages` already accepts wholesale. AND WHAT `scrub:` MEANS HERE, PRECISELY: neither column is neutralised in the sense the other entries use. `created_at` is CLAMPED (kept, bounded), and `conversation_id` is not altered at all — it is the DEDUP KEY the never-displace lookup reads. They are declared under `scrub:` because that is the only annotation the gate has, and the gate asserts only that the `table === \'conversation_summaries\'` BRANCH names each column — not that either is nulled. Read the branch (vault-import.js:352-366), not the annotation. On a fresh vault (the normal restore) neither control fires.',
  },
  attachments: { verdict: 'allow', reown: true, why: 'media rows. r2_key is a legacy object path, not a secret; local_path is separately forced user-namespaced (assertUserNamespacedBlobPath) and the blob pass owns the row.' },
  entities: { verdict: 'allow', reown: true, why: 'extracted entities — analysis output over the user own corpus. "pinned" is a UI flag.' },
  entity_links: { verdict: 'allow', reown: true, why: 'entity ↔ source references — analysis output.' },
  entity_versions: { verdict: 'allow', reown: true, why: 'entity revision history — analysis output.' },
  entity_snapshots: { verdict: 'allow', reown: true, why: 'periodic entity payload snapshots — analysis output.' },
  facts: { verdict: 'allow', reown: true, why: '"key" is a fact NAME (e.g. "home_city"); facts are extracted content and "pinned" is a UI flag.' },
  fact_versions: { verdict: 'allow', reown: true, why: 'same "key" = fact name; revision history of extracted facts.' },
  person_claims: { verdict: 'allow', reown: true, why: 'claims about people in the corpus; content_hash is of a claim string.' },
  person_claim_snapshots: { verdict: 'allow', reown: true, why: 'windowed confidence snapshots of those claims — analysis output.' },
  people: { verdict: 'allow', reown: true, why: 'the user contact graph — user data. It carries no authorization: channel identity binding lives in identity_channels (denied).' },
  contact_territories: { verdict: 'allow', reown: true, why: 'contact ↔ territory affinity — analysis output.' },
  internal_model_items: { verdict: 'allow', reown: true, why: 'the agent model of the user — continuity history a restore must bring back. ROUND-3 CORRECTION of the REASON (the verdict stands): round 2 said it "enters context as RECALLED DATA alongside messages". That is FALSE today — V1 has NO reader at all (the only references are the crypto registry, crypto-local.js:360, and the re-encrypt map, portal-mindscape.js:115). Allow rests on: re-owned via user_id, no executor, no gate reads it. If a reader is ever added it must treat these strings as recalled data, never instruction position — see the PROMPT-INJECTION RESIDUAL note at the foot of this file.' },
  reflections: { verdict: 'allow', reown: true, why: 'generated reflections over the user own corpus — content.' },
  reflection_records: { verdict: 'allow', reown: true, why: 'per-cycle reflection bodies — content.' },
  current_arc_chronicles: { verdict: 'allow', reown: true, why: 'the generated narrative of the user current arc — content.' },
  theme_cards: { verdict: 'allow', reown: true, why: 'generated per-theme narrative cards — content.' },
  folders: { verdict: 'allow', reown: true, why: 'the document folder tree — organisational metadata with no ACL (access_grants is denied).' },
  note_links: { verdict: 'allow', reown: true, why: 'wiki-style links between the user own notes — content structure.' },
  tasks: { verdict: 'allow', reown: true, why: 'the user TODO list. Unlike scheduled_tasks / agent_tasks nothing executes a `tasks` row — it has no schedule, no tool set and no executor query.' },
  sharing_contexts: { verdict: 'allow', reown: true, why: 'a named bundle of things the user MIGHT share; is_private is a visibility flag. It grants nothing on its own — the grant edge is context_grants, denied. It DOES have user_id and INSERT OR IGNORE on the id, so a bundle can neither re-own nor overwrite a pre-existing context THROUGH restoreTable (round-5 qualifier: the row-level claim is scoped to the chokepoint — vectorPass is a raw UPDATE and DOES mutate pre-existing rows, but only the vector columns of the six tables that declare `update:`) — which is precisely what makes context_documents/context_territories dangerous (they attach to the SURVIVING real row).' },
  canvas_workspaces: { verdict: 'allow', reown: true, why: 'user-authored canvas boards — content (the collaborator ACL, canvas_collaborators, is denied).' },
  canvas_nodes: { verdict: 'allow', reown: true, why: 'nodes on those boards — content.' },
  canvas_edges: { verdict: 'allow', why: 'edges between nodes on a board — content. No user_id, but an edge grants nothing; the worst case is clutter on the user own canvas.' },
  health_daily: { verdict: 'allow', reown: true, why: 'imported health metrics — user data.' },
  activity_daily: { verdict: 'allow', why: 'session_count = a COUNT of activity windows (telemetry). Keyed by (date, agent_id) with NO user_id — so the forced re-own does NOT apply and is not claimed here; an injected row is clutter in the user own activity view and authorises nothing.' },
  activity_sessions: { verdict: 'allow', why: '"session" here is an app-usage time window (app_bundle/window_title/duration_s) — telemetry, not auth. No user_id, so the re-own does not apply and is not claimed; an injected row is clutter in the user own timeline.' },
  llm_usage: { verdict: 'allow', reown: true, why: 'input/output token COUNTS (accounting).' },
  cycle_metrics: { verdict: 'allow', reown: true, why: 'input/output token COUNTS for one enrichment cycle (accounting).' },
  harness_runs: {
    verdict: 'allow',
    reown: true,
    scrub: ['prompt_hash'],
    why: 'per-run accounting for the agent harness (status + token counts). ROUND-3 CORRECTION — "nothing executes a harness_runs row" was FALSE: harness.wasRecentlyCompleted (db/harness.js:155-163) is a LIVE SUPPRESSION DECISION at agent/scheduler.js:162, and it matches on prompt_hash + status="done" + finished_at >= cutoff — a bundle-chosen FUTURE finished_at satisfies that cutoff FOREVER. Round 2 called it safe because promptHash = sha256(task.id + "\\n" + task.prompt) (scheduler.js:97) includes a uuid task.id. That control is WEAKER than stated: in this threat model the attacker holds a copy of the user OWN export, so if scheduled_tasks is in it the id and prompt are both KNOWN and the hash is computable — a planted row would silently kill the user own scheduled cycle. So do not rely on the uuid: prompt_hash is SCRUBBED to NULL on import (the ONLY reader is that dedup SELECT, and `prompt_hash = ?` never matches NULL), which keeps the run history and its token accounting while removing the suppression surface entirely.',
  },
  clustering_points: {
    verdict: 'allow',
    reown: true,
    update: ['nomic_embedding'],
    why: 'VECTOR UPDATE (see `messages`). ORIGINAL RATIONALE: the clustering corpus — analysis output over the user own content (vectors are re-encrypted on import).' },
  clustering_diagnostics: { verdict: 'allow', reown: true, why: 'clustering quality diagnostics — analysis output.' },
  cluster_events: { verdict: 'allow', reown: true, why: 'cluster-change events — analysis output.' },
  cognitive_events: { verdict: 'allow', reown: true, why: 'detected cognitive events — analysis output surfaced to the user.' },
  cognitive_metrics_anchor: { verdict: 'allow', reown: true, why: 'anchor-axis metrics — analysis output.' },
  cognitive_metrics_behavioral: { verdict: 'allow', reown: true, why: 'inter-session statistics over activity windows — analysis output.' },
  cognitive_metrics_coherence: { verdict: 'allow', reown: true, why: 'coherence metrics — analysis output.' },
  cognitive_metrics_criticality: { verdict: 'allow', reown: true, why: 'early-warning / criticality metrics — analysis output.' },
  cognitive_metrics_harmonic: { verdict: 'allow', reown: true, why: 'information-harmonics metrics — analysis output.' },
  cognitive_metrics_per_territory: { verdict: 'allow', reown: true, why: 'per-territory recurrence metrics — analysis output.' },
  cognitive_metrics_trajectory: { verdict: 'allow', reown: true, why: 'trajectory metrics — analysis output.' },
  cognitive_metrics_window: { verdict: 'allow', reown: true, why: 'windowed spectral metrics — analysis output.' },
  cognitive_anchor_vectors: { verdict: 'allow', why: 'measurement reference vectors keyed by (construct, anchor_version); seed_content_hash identifies the anchor text. No user_id, so the re-own does not apply and is not claimed. Worst case for an injected row is a SKEWED metric in the user own measurement view — an accuracy cost, not an authority grant.' },
  cognitive_axis_separability: { verdict: 'allow', why: 'per-axis separability diagnostics (loo_auc, antonym_cos). No user_id, but these are model-quality numbers read only by the measurement surface — they authorise nothing.' },
  complexity_snapshots: { verdict: 'allow', reown: true, why: 'LZ / complexity snapshots — analysis output.' },
  frequency_snapshots: { verdict: 'allow', reown: true, why: 'coherence / entropy snapshots — analysis output.' },
  embedding_trajectory: { verdict: 'allow', reown: true, why: 'centroid drift / dispersion over time — analysis output.' },
  fisher_trajectory: { verdict: 'allow', reown: true, why: 'Fisher-metric trajectory — analysis output.' },
  fisher_milestones: { verdict: 'allow', reown: true, why: 'detected trajectory milestones — analysis output surfaced to the user.' },
  cvp_labels: { verdict: 'allow', reown: true, why: 'construct-validity labels assigned by the user/pipeline — analysis input, no authority.' },
  topology_metrics: { verdict: 'allow', reown: true, why: 'territory-graph metrics — analysis output.' },
  territory_profiles: {
    verdict: 'allow',
    reown: true,
    update: ['embedding_768'],
    why: 'VECTOR UPDATE (see `messages`). ORIGINAL RATIONALE: signature_patterns / describe_input_hash are topology analysis outputs.' },
  territory_cofire: { verdict: 'allow', reown: true, why: 'cofire_session is an analysis window id.' },
  territory_pass_notes: { verdict: 'allow', reown: true, why: 'key_entities is a list of entity names.' },
  territory_river_cache: { verdict: 'allow', reown: true, why: 'cache_key is a derived cache identity.' },
  territory_neighbors: { verdict: 'allow', reown: true, why: 'territory adjacency — topology output.' },
  territory_lineage: { verdict: 'allow', reown: true, why: 'territory id lineage across cluster versions — topology output.' },
  territory_seen_points: { verdict: 'allow', reown: true, why: 'which points a territory pass has seen — per-user pipeline bookkeeping; no gate reads it as a permission.' },
  territory_vitality: { verdict: 'allow', reown: true, why: 'territory vitality metrics — topology output.' },
  realms: {
    verdict: 'allow',
    reown: true,
    update: ['embedding_768'],
    why: 'VECTOR UPDATE (see `messages`). ORIGINAL RATIONALE: signature_patterns / describe_input_hash — topology outputs.' },
  realm_neighbors: { verdict: 'allow', reown: true, why: 'realm adjacency — topology output.' },
  semantic_themes: {
    verdict: 'allow',
    reown: true,
    update: ['embedding_768'],
    why: 'VECTOR UPDATE (see `messages`). ORIGINAL RATIONALE: topology outputs (themes over the user own corpus).' },
  time_chronicles: { verdict: 'allow', reown: true, why: 'period_key is a date bucket; "signature" / "key_moments" are narrative fields.' },
  time_seen_points: { verdict: 'allow', reown: true, why: 'period_key is a date bucket.' },
  user_profiles: {
    verdict: 'allow',
    reown: true,
    scrub: ['handle', 'did', 'public_space_enabled'],
    why: 'ROUND-3 CORRECTION — round 2 mentioned only "signature" (a prose self-description). The row also carries `handle`, `did`, `public_realms_json` (transmitted to a PEER on every connect request, connections.js:351), and `public_space_enabled` (an opt-in PUBLIC exposure flag, migration 0016). Two structural facts limit the damage: user_id is the PRIMARY KEY and is force-re-owned, and the insert is INSERT OR IGNORE — so on a vault that already HAS a profile row the bundle row is dropped whole (again: through restoreTable; `user_profiles` declares no `update:`, so vectorPass does not reach it). The exposed case is a FRESH vault, where the bundle would choose all of them; `handle` matters most because connections.js:446 resolves a bare handle straight out of this table, and `users` was denied FOR its handle. So the three authority-ish fields are SCRUBBED to NULL/0 rather than argued about: `handle` is a DERIVED MIRROR written only by identity/handle-service.js:169-181 and re-derived on the next claim/boot, `did` likewise belongs to federation identity, and a public-exposure consent flag must never transfer through a file. `signature` / `public_bio` / `public_realms_json` stay: they are the user own prose, and the user is the one who sends them.',
  },
  wealth_watchlist: { verdict: 'allow', reown: true, why: 'watched assets + target prices — user data.' },
  wealth_portfolio_access: { verdict: 'allow', reown: true, why: 'IS the portfolio ACL (db/wealth.js:42) — but it is the one ACL the forced re-own actually neutralises: user_id is overwritten with the importing owner, so a bundle row can only ever grant the IMPORTER access to a portfolio in their own vault, never name a third party. Denying it would leave every restored portfolio unreadable.' },
  wealth_portfolios: { verdict: 'allow', why: 'portfolio records — user financial data. No user_id, but a portfolio is reachable only through wealth_portfolio_access whose rows are re-owned to the importer, so an injected portfolio is at worst clutter in the user own list.' },
  wealth_positions: { verdict: 'allow', why: 'holdings within a portfolio — user financial data, reachable only via the re-owned ACL.' },
  wealth_transactions: { verdict: 'allow', why: 'transaction history — user financial data, reachable only via the re-owned ACL. Nothing executes a transaction row; it is a ledger.' },
  wealth_snapshots: { verdict: 'allow', why: 'valuation snapshots — derived user financial data.' },
  wealth_assets: { verdict: 'allow', why: 'the shared instrument catalogue (symbol / name / exchange / price_source). Reference data: price_source names a quote provider, but it carries no credential and no egress decision hangs off an assets row.' },
  wealth_wallets: { verdict: 'allow', why: 'PUBLIC chain addresses the user tracks — read-only balance lookup. No key material (chain keys are never in this vault).' },
});

// ── PROMPT-INJECTION RESIDUAL — stated explicitly, because it is NOT closed ────
//
// The `allow` set above is chosen so that no imported row is read as an AUTHORITY
// DECISION. It does NOT — and cannot — stop imported rows being read as TEXT by the
// model. Every one of these is a bundle-authored string that reaches the model as
// RECALLED DATA, in a turn carrying the user's full tool authority:
//
//   entities.summary · facts.value · person_claims.content ·
//   territory_profiles.chronicle / essence · clustering_points.content ·
//   attachments.transcript / description · time_chronicles + current_arc_chronicles
//   + theme_cards narratives · reflections / reflection_records bodies ·
//   messages.content itself.
//
// Denying them is not viable: they ARE the vault. Denying `messages` would make the
// import pointless. The mitigation we actually have is the INSTRUCTION-POSITION vs
// RECALLED-DATA distinction — it is why `agent_customizations` (system-prompt
// material) and `scheduled_tasks` (a prompt WITH an executor) are denied while
// `messages` is not. That distinction is REAL but PARTIAL: a sufficiently well-
// crafted "recalled" string can still steer a turn, and this policy does not claim
// otherwise. Anyone reading this file for assurance should read this paragraph as
// the boundary of what it provides: it closes the AUTHORITY class, not the
// INJECTION class. The controls that bound the injection class live elsewhere
// (§11 explicit-send egress chokepoints, the enabled-tools set, and the fact that
// an import is an explicit, user-initiated act on a file the user chose).

/** Tables this policy REQUIRES to be denied (fed into full-export-import's DENY). */
export const POLICY_DENY_TABLES = Object.freeze(
  Object.entries(IMPORT_TABLE_POLICY)
    .filter(([, v]) => v.verdict === 'deny' || v.verdict === 'deny-future')
    .map(([t]) => t)
    .sort(),
);

/**
 * THE IMPORTABLE SET. `full-export-import.js` imports a table IFF it is in here.
 * Absence — an explicit deny, an operational deny, or a table nobody has
 * classified yet — means the bundle's rows are skipped. Fail-closed by default,
 * not fail-closed-within-a-regex.
 */
export const POLICY_ALLOW_TABLES = Object.freeze(new Set(
  Object.entries(IMPORT_TABLE_POLICY).filter(([, v]) => v.verdict === 'allow').map(([t]) => t),
));

/** True iff a bundle table may be restored. Asked by `restoreTable` itself — the
 *  ONE chokepoint every import route shares — and again by full-export-import
 *  before it even reads the file. */
export function isImportAllowed(table) {
  return POLICY_ALLOW_TABLES.has(String(table || '').trim().toLowerCase());
}

/**
 * Split restoreTable's source into its per-table `if (table === 'x')` branches so a
 * `scrub:` claim is checked against THAT TABLE's branch, not against the whole file.
 * (File-wide matching made the claim nearly free: `status` is named by the
 * ai_providers branch, so any table could have "claimed" to scrub `status`.)
 * @param {string} src @returns {Map<string,string>}
 */
export function restoreBranches(src) {
  const out = new Map();
  const rx = /table\s*===\s*'([a-z_][a-z0-9_]*)'/g;
  const starts = [];
  let m;
  while ((m = rx.exec(String(src || '')))) starts.push({ table: m[1], at: m.index });
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].at : String(src).length;
    const body = String(src).slice(starts[i].at, end);
    out.set(starts[i].table, (out.get(starts[i].table) || '') + '\n' + body);
  }
  return out;
}

/**
 * SOURCE-LEVEL CALL-SITE ENUMERATION — the round-3 control.
 *
 * Runtime safety now comes from `restoreTable` refusing an unclassified table
 * itself, so this scan is not the only line of defence. Its job is to make a NEW
 * import route fail LOUDLY at build time instead of silently landing zero rows at
 * runtime — the round-2 bug was exactly a second route nobody re-read the policy
 * for. Two rules, both fail-closed:
 *
 *   literal call site   `restoreTable(db, 'share_links', …)` — the table must carry
 *                       an explicit `allow` verdict. A literal naming a denied or
 *                       unclassified table is `ungated-call-site`: dead code at
 *                       best, and (as in round 2) a live exploit at worst.
 *   dynamic call site   `restoreTable(db, table, …)` — the table is not knowable
 *                       here, so the FILE must demonstrably consult the policy
 *                       (`isImportAllowed`). Otherwise `unproven-dynamic-call-site`.
 *
 * Pure + injectable so the gate can mutation-test it: an auditor that cannot fail
 * is a tautology.
 *
 * @param {Array<{file:string, source:string}>} sources
 * @param {{ allow?: (t:string)=>boolean }} [opts]
 * @returns {Array<{kind:string, file:string, table:string|null, detail:string}>}
 */
export function scanRestoreCallSites(sources, { allow = isImportAllowed } = {}) {
  const findings = [];
  // Comments are stripped first. A call site written in PROSE is not a call site
  // (this very doc block names one), and — more to the point — a real one must not
  // be able to hide behind a `//`.
  const strip = (s) => String(s || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((ln) => (/^\s*(\/\/|\*)/.test(ln) ? '' : ln)).join('\n');
  for (const { file, source } of Array.isArray(sources) ? sources : []) {
    const src = strip(source);
    const consultsPolicy = /isImportAllowed\s*\(/.test(src);
    // `restoreTable(<db-ish>, <arg2>` — arg2 is what we classify.
    const rx = /(?<![\w$.])restoreTable\s*\(\s*[^,()]+,\s*([^,]+?)\s*,/g;
    let m;
    while ((m = rx.exec(src))) {
      const arg = m[1].trim();
      const lit = /^'([^']*)'$/.exec(arg) || /^"([^"]*)"$/.exec(arg);
      if (lit) {
        const t = lit[1];
        if (!allow(t)) {
          findings.push({
            kind: 'ungated-call-site', file, table: t,
            detail: `restoreTable is called with the LITERAL table "${t}", which has no \`allow\` verdict — this is the round-2 bug (a second import route writing a denied table)`,
          });
        }
      } else if (!consultsPolicy) {
        findings.push({
          kind: 'unproven-dynamic-call-site', file, table: null,
          detail: `restoreTable is called with a NON-LITERAL table (\`${arg}\`) in a file that never calls isImportAllowed — the table cannot be checked here, so the caller must consult the policy`,
        });
      }
    }
  }
  return findings;
}

/**
 * Structural audit over the LIVE schema. Pure + injectable so the gate can
 * MUTATION-TEST it (an auditor that cannot fail is a tautology).
 *
 * Findings that must turn the gate RED:
 *   unclassified          a live table is neither explicitly denied nor classified
 *                         → it is already un-importable (fail-closed), but nobody
 *                           has written down what it is. `credentialShaped` marks
 *                           the regex hits for severity triage only.
 *   deny-not-enforced     policy says deny, runtime DENY lacks it
 *   allow-but-denied      policy says allow, runtime DENY blocks it
 *   deny-future-now-live  a deny-future table now exists → promote it
 *   stale-policy-entry    classified here, absent from the live schema
 *   no-rationale          missing / too-short `why`
 *   deny-not-normalized   a DENY entry the trim+lowercase match can never hit
 *   reown-without-user-id an `allow` whose rationale relies on the forced re-own,
 *                         on a table with NO user_id column (the mitigation does
 *                         not exist there — it does not for 34 importable tables)
 *   scrub-not-implemented an `allow` whose rationale relies on a column scrub that
 *                         restoreTable's OWN BRANCH for that table does not name
 *   dependency-not-scrubbed  an `allow` whose safety leans on another table's scrub
 *                         that that table's policy entry no longer declares
 *
 * @param {{ tables: Array<{name:string, columns:string[]}>, deny: Set<string>|Iterable<string>,
 *           policy?: object, restoreSource?: string }} args
 * @returns {Array<{kind:string, table:string, detail:string, credentialShaped?:boolean}>}
 */
export function auditImportPolicy({ tables, deny, policy = IMPORT_TABLE_POLICY, restoreSource = null }) {
  const denySet = deny instanceof Set ? deny : new Set(deny || []);
  const findings = [];
  const live = new Set();
  const branches = restoreSource ? restoreBranches(restoreSource) : new Map();

  for (const entry of Array.isArray(tables) ? tables : []) {
    const name = String(entry?.name || '');
    if (!name) continue;
    live.add(name);
    const cols = Array.isArray(entry?.columns) ? entry.columns.map(String) : [];
    const hits = [name, ...cols].filter((s) => CREDENTIAL_TABLE_RX.test(s));
    const credentialShaped = hits.length > 0;
    const p = policy[name];

    if (!p) {
      // DENY-BY-DEFAULT. An explicitly-denied table needs no policy entry (deny is
      // the safe direction, and the operational literal carries its own comment).
      // Anything else is unclassified: un-importable at runtime, RED here.
      if (denySet.has(name)) continue;
      findings.push({
        kind: 'unclassified', table: name, credentialShaped,
        detail: `live, not denied, and absent from IMPORT_TABLE_POLICY — refused at import (fail-closed) but it MUST be explicitly classified deny or allow-with-reason${credentialShaped ? ` [credential-shaped: ${hits.join(',')}]` : ''}`,
      });
      continue;
    }

    if (!p.why || String(p.why).trim().length < 20) {
      findings.push({ kind: 'no-rationale', table: name, detail: 'policy entry needs a written reason' });
    }
    if (p.verdict === 'deny' && !denySet.has(name)) {
      findings.push({ kind: 'deny-not-enforced', table: name, credentialShaped, detail: 'policy says deny but the table is NOT in full-export-import DENY' });
    }
    if (p.verdict === 'deny-future') {
      findings.push({ kind: 'deny-future-now-live', table: name, detail: 'table now exists — change verdict to "deny"' });
      if (!denySet.has(name)) findings.push({ kind: 'deny-not-enforced', table: name, detail: 'live table not in DENY' });
    }
    if (p.verdict === 'allow') {
      if (denySet.has(name)) findings.push({ kind: 'allow-but-denied', table: name, detail: 'policy says allow but DENY blocks it — policy and runtime disagree' });
      if (p.reown && !cols.includes('user_id')) {
        findings.push({ kind: 'reown-without-user-id', table: name, detail: 'rationale relies on restoreTable forcing user_id, but this table has NO user_id column — the mitigation does not exist' });
      }
      // PER-TABLE scrub check: the column must be named inside restoreTable's own
      // `if (table === '<name>')` branch. File-wide matching (round 2) let a table
      // "claim" a scrub another table's branch happened to implement.
      const branch = restoreSource ? (branches.get(name) || '') : null;
      for (const col of (Array.isArray(p.scrub) ? p.scrub : [])) {
        const safe = String(col).replace(/[^a-z0-9_]/gi, '');
        if (restoreSource && safe && !new RegExp(`\\b${safe}\\b`).test(branch)) {
          findings.push({ kind: 'scrub-not-implemented', table: name, detail: `rationale relies on scrubbing "${col}" but restoreTable's \`table === '${name}'\` branch never names it${branch ? '' : ' (there is no such branch at all)'}` });
        }
      }
      // CROSS-TABLE dependency: an allow whose safety leans on ANOTHER table's
      // control must say so, and that control must still be declared there.
      for (const dep of (Array.isArray(p.depends) ? p.depends : [])) {
        const other = policy[dep?.table];
        const declared = new Set(Array.isArray(other?.scrub) ? other.scrub : []);
        for (const col of (Array.isArray(dep?.scrub) ? dep.scrub : [])) {
          if (!other) {
            findings.push({ kind: 'dependency-not-scrubbed', table: name, detail: `safety depends on table "${dep.table}", which is not classified at all` });
          } else if (other.verdict === 'allow' && !declared.has(col)) {
            findings.push({ kind: 'dependency-not-scrubbed', table: name, detail: `safety depends on "${dep.table}.${col}" being scrubbed on import, but ${dep.table}'s policy entry no longer declares that scrub` });
          }
        }
      }
    }
  }

  for (const [name, p] of Object.entries(policy)) {
    if (p.verdict === 'deny-future') {
      if (!denySet.has(name)) findings.push({ kind: 'deny-not-enforced', table: name, detail: 'deny-future table must already be in DENY' });
      continue;
    }
    if (live.size && !live.has(name)) findings.push({ kind: 'stale-policy-entry', table: name, detail: 'classified here but not in the live schema' });
  }

  // Every DENY entry must already be normalized — the incoming bundle name is
  // trim+lowercased before matching, so a mis-cased entry would never match.
  for (const t of denySet) {
    if (t !== String(t).trim().toLowerCase()) findings.push({ kind: 'deny-not-normalized', table: t, detail: 'DENY entries must be trimmed + lowercase' });
  }

  return findings;
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE SETTINGS VOCABULARY — the THIRD write path (round-4)
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHY THIS SECTION EXISTS
// -----------------------
// Everything above gates `restoreTable`. `vault-import.js` has ONE write that does
// not go through it: `INSERT OR IGNORE INTO users` + `UPDATE users SET settings=?`,
// carrying the person over (display_name / timezone / settings). `users` is
// classified `deny` above — so that write is, by construction, an EXCEPTION to the
// chokepoint, and it needs its own gate rather than the chokepoint's.
//
// Its only control used to be `IMPORT_REFUSED_SETTINGS`, a second hand-maintained
// DENYLIST living inside vault-import.js with no verify: coverage at all. It had
// already rotted when it was written: its own comment claimed the vocabulary "IS
// enumerable — nine keys", and the live vocabulary was fourteen. The five it never
// saw were not cosmetic:
//
//   • enrichEmbedPaused / enrichCategorizePaused / enrichProcessingPaused /
//     enrichProcessingPausedAt — read by enrich/drainer.js on EVERY BOOT and by
//     readiness.js. A bundle setting them true silently and durably stops the
//     user's own embedding + categorization. That is precisely the hazard that
//     denies `pipeline_state` ("a planted row stalls the user's own enrichment")
//     one layer up: the table was denied and the equivalent settings key was open.
//   • recovery_key_backed_up — the U1.3 onboarding gate. The wizard forces Step 2
//     until it is set, so "a quit-before-backup can never leave a vault with an
//     un-backed-up key" (portal-compat.js). Fresh vault + import is the NORMAL
//     migration sequence; a bundle carrying `true` makes the wizard stop gating and
//     the user is never shown their recovery key. In a product where a lost key is
//     unrecoverable by design, that is durable, silent data loss.
//
// A SECOND ROT, found in the same sweep: the write REPLACED the settings blob
// WHOLESALE with the bundle's. So a bundle that merely OMITS `recovery_key_backed_up`
// deletes the explicit `false` the server wrote at setup, downgrading the vault to
// the "pre-U1.3, never gate, never re-reveal" population — the same outcome as the
// forged `true`, with no forgery. The fix therefore MERGES over the local blob; it
// never replaces it.
//
// THE INVERSION (same move as the table policy, for the same reason)
// ------------------------------------------------------------------
//   ► THE IMPORTABLE SETTINGS SET IS THE CLASSIFIED SET.
//     A settings key survives an import IFF it carries an explicit `allow` verdict
//     below. Everything else — classified `refuse`, or never classified at all —
//     is stripped from the bundle blob and REPORTED. A settings key added tomorrow
//     is therefore safe by default instead of dangerous by default, and
//     `verify:import-credential-deny` REDs until someone writes down what it is.
//
// WHAT THE INVERSION COSTS, AND WHAT PAYS FOR IT
// -----------------------------------------------
// The denylist's one honest argument was sovereignty: this blob comes from the
// CANONICAL production vault, a different codebase whose settings may carry keys
// V1 has no reader for, and an allowlist would DELETE them on the one path whose
// whole job is to bring the user's vault home. That argument is answered rather
// than overruled: unknown keys are not deleted, they are QUARANTINED into
// `importedSettingsQuarantine` — a single key that, by gate-enforced assertion,
// NOTHING in src/ reads. The data survives the migration and is recoverable by
// hand; no live decision can ever see it. Refused (classified-dangerous) keys are
// dropped outright — consent and policy must not transfer through a file — and
// both lists are reported so the loss is never silent.
//
// THE CLASSIFICATION RULE (the settings analogue of the table rule)
//   REFUSE when the key is read as a DECISION — egress, autonomous execution,
//   process spawn, model/provider selection, consent, an onboarding/safety gate,
//   or this box's own pipeline runtime state.
//   ALLOW only for inert preference data whose worst case, in an attacker's hands,
//   is a preference the user can flip back in one click.

/**
 * The ONE key that carries un-classified bundle settings across an import without
 * ever reaching a reader. Inert by gate-enforced assertion:
 * `verify:import-credential-deny` fails if any file under src/ other than the
 * importer/policy pair so much as names it.
 *
 * ⚠️ ROUND-5: this key is NOT an allow key on the input side. It carries an `allow`
 * VERDICT (so the vocabulary audit has an entry to point at, and so a V1→V1
 * round-trip preserves the parked data) but `filterImportSettings` treats an
 * INCOMING value for it as untrusted input to the same quarantine merge — it seeds
 * `parked`, it never takes the `carried` path. Round 4 shipped it on the carried
 * path, and the 32 KB cap lived inside `if (quarantined.length)`, so a bundle that
 * named this key DIRECTLY and supplied no unknown keys wrote an arbitrarily large
 * attacker object straight into `users.settings` — uncapped and unreported
 * (`quarantined: []`, `quarantineDropped: null`). 300 KB landed in the repro.
 */
export const IMPORT_SETTINGS_QUARANTINE_KEY = 'importedSettingsQuarantine';

/** Serialized cap on the quarantine blob. users.settings is read on hot paths
 *  (every chat turn resolves taskModels through it), so an unbounded attacker-authored
 *  object here would be a cheap availability/bloat lever. Over the cap ⇒ dropped + reported. */
export const IMPORT_SETTINGS_QUARANTINE_MAX_BYTES = 32 * 1024;

/**
 * TOTAL serialized cap on the settings blob an import may write. The quarantine cap
 * alone is not enough: it bounds ONE key, so every OTHER allow key is still an
 * unbounded channel (`keepAwake` has no value validation and accepted a 300 KB
 * nested payload in the round-5 repro). `users.settings` is SELECTed and JSON.parsed
 * on boot (enrich/drainer.js), on readiness polls, on keep-awake polls and on every
 * chat turn (portal-chat.js:186) — an oversized blob is a durable, reboot-surviving
 * availability attack that no code path can display or clear. The real outer bound
 * without this is MYCELIUM_IMPORT_MAX_JSON_BYTES = 384 MB (import-parsers.js:24).
 *
 * The cap is applied to the RESULT, and it is spent ONLY on bundle-contributed keys:
 * the vault's OWN local settings are never dropped to make room (an import must not
 * be able to delete local state by being fat).
 */
export const IMPORT_SETTINGS_MAX_BYTES = 64 * 1024;

/**
 * THE CLASSIFIED SETTINGS VOCABULARY.
 *
 * ⚠️ ROUND-5, SCOPE CORRECTION. This header used to claim it covered "every top-level
 * `users.settings` key written or read anywhere in src/ … the gate enumerates them
 * from source". That is an assertion-shaped enumeration — the exact bug this module
 * exists to fix — and it was false. What `scanSettingsKeys` ACTUALLY covers is:
 *
 *   COVERED    keys reached through the `db.users.updateSettings(...)` /
 *              `db.users.getSettings(...)` accessor pair (rules W / R / C below).
 *   NOT COVERED  keys written or read by RAW SQL against the `settings` column.
 *              `src/db/spaces.js:83-93` does exactly this
 *              (`SELECT settings FROM users …` → mutate → `UPDATE users SET settings = ?`),
 *              so `essence` / `voice` / `coverDocPath` are INVISIBLE to the scan.
 *              They are classified below by hand and marked `rawSql: true`; the stale-
 *              entry check skips them because the scan structurally cannot see them.
 *
 * The residual risk is therefore named rather than assumed: a NEW raw-SQL writer of
 * `users.settings` is not caught by the settings scan. It IS caught for `src/ingest/`
 * by `C7j` (every INSERT/UPDATE/REPLACE under src/ingest/ must be `restoreTable` or an
 * enumerated exception). Outside `src/ingest/` it is not caught, and closing that is
 * the named follow-up (a statement-layer, transaction-scoped writer) — deliberately
 * NOT in this PR.
 *
 * Everything the scan DOES see must appear here; the gate REDs on any it does not
 * (the structural analogue of scanRestoreCallSites).
 */
export const IMPORT_SETTINGS_POLICY = Object.freeze({
  // ══ ALLOW — inert preference data ═════════════════════════════════════════
  keepAwake: {
    verdict: 'allow',
    why: 'macOS caffeinate on/off (portal-system.js:36-61). Default ON, so the only state a bundle can force is OFF — the machine is allowed to sleep. No egress, no execution, no consent, no model selection; the user flips it back in one click and nothing about it is durable harm.',
  },
  [IMPORT_SETTINGS_QUARANTINE_KEY]: {
    verdict: 'allow',
    why: 'the quarantine bucket this policy writes itself: un-classified keys from a FOREIGN (canonical) vault are parked here so an allowlist does not destroy the user data an import exists to carry home. Inert BY GATE — verify:import-credential-deny asserts no file under src/ outside the importer/policy pair names this key, so no live decision can read anything inside it. The `allow` verdict is OUTPUT-side only (a V1→V1 round-trip must not drop the parked data); on the INPUT side filterImportSettings never carries it — an incoming value seeds `parked` and goes through the same cap, because round 4 let a bundle name this key directly and write 300 KB past the cap. See IMPORT_SETTINGS_QUARANTINE_KEY.',
  },

  // ══ REFUSE — egress / execution / model selection / consent / gates ═══════
  taskModels: {
    verdict: 'refuse',
    why: 'taskModels[task]={providerId,model} selects which ai_providers row serves chat/harness/channel/enrich/categorize turns. resolveInferenceConfigForTask (inference/resolve.js:256-262) takes the id DIRECTLY, bypassing is_active — so a bundle would re-point the user\'s inference at a provider row of its choosing. It is also the durable MODEL-CONSENT record (portal-hardware.js:236). Consent must not transfer through a file.',
  },
  allowSubscriptionSensitive: {
    verdict: 'refuse',
    why: 'flips the §4g sensitive→US jurisdiction guard (inference/resolve.js:201, :298). A bundle would grant an exemption the user never granted.',
  },
  agentCapture: {
    verdict: 'refuse',
    why: '{enabled, redactSecrets} — a FAIL-CLOSED, default-OFF consent gate for capture that "can contain secrets (keys, file contents, command output)" (ingest/capture.js:104-113). A bundle could switch capture on and redaction off in one key.',
  },
  reflection: {
    verdict: 'refuse',
    why: '{enabled} starts autonomous reflection cycles at the next boot (cost governance §10; portal-reflection.js:143). `seenAt` inside it is inert, but the key is refused whole rather than partially trusted — a nested allowlist is the same rot one level down.',
  },
  transcribeModel: {
    verdict: 'refuse',
    why: 'fed unvalidated into ensureTranscribeSupervisor (server-rest.js:613) ⇒ SPAWNS A PYTHON SERVICE with a bundle-chosen model string. The portal PUT validates it; this path never would.',
  },
  webSearch: {
    verdict: 'refuse',
    why: 'enables agent web egress (agent/web-search.js:50-52, default-on/explicit-false). Egress policy is not preference data.',
  },
  inferCascade: {
    verdict: 'refuse',
    dormant: true,
    why: 'legacy multi-provider routing policy. No live reader remains (gateway/openai-compat.js:54 ignores it intentionally, portal-providers.js:345 no longer writes it) — classified refuse anyway, because "dormant" is not a defence: the key sits in the vault until something reads it again, the same argument that denies dormant tables above.',
  },
  agent: {
    verdict: 'refuse',
    why: 'TWO decisions in one key. (1) agent.name is INTERPOLATED into the chat system prompt ("Your name is ${ident.name}." — portal-chat.js:408) and the READ path applies no length cap (portal-chat.js:122) unlike the PUT (:155 .slice(0,40)) ⇒ a bundle would own the first sentence of the system prompt on every turn. (2) agent.channelWrite is read by agent/channel-turn.js:137 as an input to isOwnerTrustedTurn — an AUTHORITY decision on the channel-write path, which by itself puts this key on the deny side of the rule.',
  },
  harnessMode: {
    verdict: 'refuse',
    why: 'picks the agent engine, CLI vs native (agent/resolve-harness.js:26). Fails safe today because the CLI branch needs a subscription row the provider import refuses — latent, not absent: it would activate silently the day the user connects a subscription.',
  },
  enrichEmbedPaused: {
    verdict: 'refuse',
    why: 'THE ROUND-4 P1. enrich/drainer.js re-reads it on every boot into _embedPaused; a bundle-set `true` stops the user\'s own embedding silently and keeps it stopped across reboots. Identical hazard to the denied `pipeline_state` table one layer up ("a planted row stalls the user\'s own enrichment") — this box\'s runtime state, never a bundle\'s.',
  },
  enrichCategorizePaused: {
    verdict: 'refuse',
    why: 'the categorize half of the same P1 — drainer.js reads it into _categorizePaused on every boot. A bundle silently and durably stops the user\'s own categorization.',
  },
  enrichProcessingPaused: {
    verdict: 'refuse',
    why: 'the LEGACY composite of the two above (portal-compat.js:1342-1347); drainer.js honours it as BOTH stages paused for vaults written before the split. Refused for the same reason, and refusing it alone would not have been enough.',
  },
  enrichProcessingPausedAt: {
    verdict: 'refuse',
    why: 'the durable "paused since" stamp read by readiness.js:589. Bundle-chosen (the observed exploit used 2099) it also FORGES the pipeline-status the user reads to notice the pause. This box\'s runtime state.',
  },
  // ── RAW-SQL keys: written/read by src/db/spaces.js via `UPDATE users SET settings = ?`,
  //    which scanSettingsKeys structurally cannot see. Classified BY HAND (round-5).
  essence: {
    verdict: 'refuse',
    rawSql: true,
    why: 'a space\'s description, written by db/spaces.js:85 through raw SQL (invisible to the settings scan). It is INTERPOLATED INTO AGENT CONTEXT — tools/spaces.js:117 renders it into the listSpaces tool result the model reads — and into the portal (SpacesView.svelte:192). Bundle-authored text on a model-visible surface is the same class as `agent.name`, so it takes the same verdict.',
  },
  voice: {
    verdict: 'refuse',
    rawSql: true,
    why: 'a space\'s tone/persona instruction, written by db/spaces.js:86 through raw SQL (invisible to the settings scan). It exists to steer how the agent writes; a bundle-supplied value is prompt content chosen by the bundle. Refused on the same rule as `agent`.',
  },
  coverDocPath: {
    verdict: 'refuse',
    rawSql: true,
    why: 'names an agent-authored HTML document that the portal FETCHES AND RENDERS as the space landing surface (db/spaces.js:87-90; SpaceDetailView.svelte:120,195,644). A bundle-chosen path is a bundle-chosen render target — a selection decision, not preference data.',
  },

  onboardingGreetingAt: {
    verdict: 'refuse',
    why: 'a per-vault timestamp the greeting composer stamps (portal-chat.js) so the agent\'s onboarding first message is generated EXACTLY ONCE. It gates a one-time UI event on THIS install; it is not portable user data and it carries no authority. A bundle setting it would suppress the first-message greeting on the importing vault (mild), or clearing/omitting it is harmless — either way it is per-install state, not content to carry home, so it is refused rather than allowed. Same class as the other local-UI flags above.',
  },

  recovery_key_backed_up: {
    verdict: 'refuse',
    why: 'THE ROUND-4 P1, and the most expensive one. TRI-STATE onboarding gate (portal-compat.js:1500-1526): explicit false ⇒ the wizard FORCES Step 2 and reveals the recovery key; true ⇒ done; absent ⇒ pre-U1.3, never gate. Fresh vault + import is the NORMAL migration sequence, and the server writes the explicit `false` at setup — so a bundle carrying `true` (forgery) OR simply OMITTING the key (the wholesale-replace variant) both stop the gate and the user is NEVER SHOWN THEIR RECOVERY KEY. A lost key is unrecoverable by design (CLAUDE.md): this is durable, silent data loss. Refusing the key is only half the fix — the import must MERGE over the local blob, never replace it, or the omission variant survives.',
  },
});

/** The importable settings set — the classified `allow` set, nothing else. */
export const IMPORT_SETTINGS_ALLOW = Object.freeze(new Set(
  Object.entries(IMPORT_SETTINGS_POLICY).filter(([, v]) => v.verdict === 'allow').map(([k]) => k),
));

/** Keys explicitly classified as dangerous (reported separately from unknown ones). */
export const IMPORT_SETTINGS_REFUSED = Object.freeze(new Set(
  Object.entries(IMPORT_SETTINGS_POLICY).filter(([, v]) => v.verdict === 'refuse').map(([k]) => k),
));

/**
 * True iff a bundle-supplied settings key may survive an import ON THE CARRIED PATH.
 * The quarantine key is deliberately EXCLUDED here even though its verdict is `allow`:
 * its allow-ness is output-side (round-trip preservation), never a licence for a
 * bundle to hand us a value for it. See IMPORT_SETTINGS_QUARANTINE_KEY.
 */
export function isImportSettingAllowed(key) {
  const k = String(key ?? '');
  if (k === IMPORT_SETTINGS_QUARANTINE_KEY) return false;
  return IMPORT_SETTINGS_ALLOW.has(k);
}

/**
 * Split a bundle's `users.settings` blob into what may land, what was refused, and
 * what is unknown-and-therefore-quarantined. Pure, so the gate can mutation-test it.
 *
 * @param {any} incoming  the bundle's settings object (untrusted)
 * @param {any} [local]   the vault's CURRENT settings (never overwritten wholesale)
 * @returns {{ next:object, refused:string[], quarantined:string[], quarantineDropped:string|null, oversizeDropped:string[], changed:boolean }}
 */
export function filterImportSettings(incoming, local = {}) {
  const base = (local && typeof local === 'object' && !Array.isArray(local)) ? { ...local } : {};
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { next: base, refused: [], quarantined: [], quarantineDropped: null, oversizeDropped: [], changed: false };
  }
  const bytes = (v) => { try { return Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8'); } catch { return Infinity; } };
  const refused = [];
  const quarantined = [];
  const carried = {};
  const parked = {};
  for (const k of Object.keys(incoming)) {
    // ROUND-5 BLOCKER: the quarantine key FIRST, and never on the carried path.
    // A bundle that names it directly is handing us un-classified data by another
    // route; it is spread into `parked` so it goes through the SAME cap and the
    // SAME report as any unknown key. Round 4 classified it `allow`, so it took
    // `carried` and skipped the cap entirely whenever the bundle supplied no other
    // unknown key — an uncapped, unreported write into a hot-path column.
    if (k === IMPORT_SETTINGS_QUARANTINE_KEY) {
      const v = incoming[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const ik of Object.keys(v)) {
          if (!quarantined.includes(ik)) quarantined.push(ik);
          parked[ik] = v[ik];
        }
      } else if (v !== undefined && v !== null) {
        // Not an object map ⇒ not round-trip data. Nothing to park; say so.
        refused.push(k);
      }
      continue;
    }
    if (isImportSettingAllowed(k)) { carried[k] = incoming[k]; continue; }
    if (IMPORT_SETTINGS_REFUSED.has(k)) { refused.push(k); continue; }
    quarantined.push(k);
    parked[k] = incoming[k];
  }
  // MERGE, never replace: the local blob holds decisions this box made about
  // itself (the explicit recovery_key_backed_up:false written at setup, the
  // user's own model consent). A wholesale replace deletes them even when the
  // bundle is honest — see the header.
  const next = { ...base, ...carried };
  let quarantineDropped = null;
  // The cap is evaluated on the RESULTING quarantine value, regardless of how the
  // bundle got data into it (unknown keys OR a direct value for the key itself).
  if (quarantined.length) {
    const merged = { ...(base[IMPORT_SETTINGS_QUARANTINE_KEY] || {}), ...parked };
    let blob = null;
    try { blob = JSON.stringify(merged); } catch { blob = null; }
    if (!blob) quarantineDropped = 'unserializable';
    else if (Buffer.byteLength(blob, 'utf8') > IMPORT_SETTINGS_QUARANTINE_MAX_BYTES) quarantineDropped = 'oversize';
    else next[IMPORT_SETTINGS_QUARANTINE_KEY] = merged;
  }
  // TOTAL cap — no ALLOWED key is an unbounded channel either. Spent only on
  // bundle-contributed keys: the quarantine first, then the carried keys largest
  // first, each REVERTED to whatever the local vault already had (or removed).
  // Local state is never sacrificed to make room.
  const oversizeDropped = [];
  if (bytes(next) > IMPORT_SETTINGS_MAX_BYTES) {
    if (next[IMPORT_SETTINGS_QUARANTINE_KEY] !== undefined) {
      if (base[IMPORT_SETTINGS_QUARANTINE_KEY] !== undefined) next[IMPORT_SETTINGS_QUARANTINE_KEY] = base[IMPORT_SETTINGS_QUARANTINE_KEY];
      else delete next[IMPORT_SETTINGS_QUARANTINE_KEY];
      quarantineDropped = quarantineDropped || 'oversize-total';
    }
    const byBulk = Object.keys(carried).sort((a, b) => bytes(carried[b]) - bytes(carried[a]));
    for (const k of byBulk) {
      if (bytes(next) <= IMPORT_SETTINGS_MAX_BYTES) break;
      if (Object.prototype.hasOwnProperty.call(base, k)) next[k] = base[k];
      else delete next[k];
      oversizeDropped.push(k);
    }
  }
  const changed = JSON.stringify(next) !== JSON.stringify(base);
  return { next, refused, quarantined, quarantineDropped, oversizeDropped, changed };
}

/**
 * SOURCE-LEVEL SETTINGS-KEY ENUMERATION — the round-4 control, and the structural
 * analogue of `scanRestoreCallSites`.
 *
 * Finds every top-level `users.settings` key that any file under src/ writes or
 * reads, so a key added tomorrow RED-fails the build until it is classified above.
 * Three rules, all comment-stripped first (a key named in PROSE is not a key — this
 * very file names all fourteen):
 *
 *   W  object-literal keys inside `updateSettings(<user>, { … })` — the write path.
 *   R  property access on an identifier BOUND DIRECTLY to a getSettings() result
 *      (`const s = (await db.users.getSettings(u)) || {}` ⇒ `s.enrichEmbedPaused`),
 *      scoped to that binding's region so an identifier reused later in a long
 *      file does not contribute noise. A binding that immediately drills in
 *      (`const a = (await …getSettings(u))?.agent`) is NOT a settings binding — its
 *      properties are SECOND-level keys; the top-level `agent` is caught by rule C.
 *   C  a property read chained straight off the call: `(await …getSettings(u))?.agent`.
 *
 * Property names that are immediately INVOKED (`.catch(`, `.then(`) are dropped:
 * a settings key is data, never a method.
 *
 * @param {Array<{file:string, source:string}>} sources
 * @returns {Map<string, string[]>} key → evidence strings (`file:rule`)
 */
export function scanSettingsKeys(sources) {
  const strip = (s) => String(s || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((ln) => (/^\s*(\/\/|\*)/.test(ln) ? '' : ln.replace(/\s\/\/.*$/, '')))
    .join('\n');
  // Consume promise plumbing that does NOT change the settled value — `.catch(…)`,
  // `.finally(…)` — so `await db.users.getSettings(u).catch(() => null)` still reads as
  // a settings binding. `.then(…)` is deliberately NOT settled: it replaces the value.
  const settle = (tail) => {
    let s = String(tail);
    for (;;) {
      const m2 = /^\s*\)*\s*\??\.\s*(catch|finally)\s*\(/.exec(s);
      if (!m2) return s;
      let depth = 0, i = m2[0].length - 1;
      for (; i < s.length; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')') { depth--; if (depth === 0) break; }
      }
      if (i >= s.length) return s;
      s = s.slice(i + 1);
    }
  };
  const out = new Map();
  const add = (k, ev) => { if (!out.has(k)) out.set(k, []); if (!out.get(k).includes(ev)) out.get(k).push(ev); };
  const IDENT = '[A-Za-z_$][\\w$]*';
  // Skip THIS file. It is the classifier: it names every key by construction (in the
  // policy object and in the prose above), so scanning it would make the audit
  // circular — a key would "exist in src/" merely because someone classified it.
  const SELF = /import-credential-policy\.js$/;

  for (const { file, source } of Array.isArray(sources) ? sources : []) {
    if (SELF.test(String(file))) continue;
    const src = strip(source);
    if (!/getSettings|updateSettings/.test(src)) continue;

    // ── W: object-literal keys handed to updateSettings ──────────────────────
    const rxW = /updateSettings\s*\(\s*[^,]+,\s*\{/g;
    let m;
    while ((m = rxW.exec(src))) {
      let depth = 0, end = src.length;
      for (let i = rxW.lastIndex - 1; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      const body = src.slice(rxW.lastIndex, end);
      let d = 0, cur = '';
      const parts = [];
      for (const ch of body) {
        if ('{(['.includes(ch)) d++;
        else if ('})]'.includes(ch)) d--;
        if (ch === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += ch;
      }
      parts.push(cur);
      for (const p of parts) {
        const km = new RegExp(`^\\s*(${IDENT})\\s*:`).exec(p);
        if (km) add(km[1], `${file}:literal`);
      }
    }

    // ── C: a key read straight off the call expression ───────────────────────
    const rxC = /getSettings\s*\??\.?\s*\(/g;
    while ((m = rxC.exec(src))) {
      // balance the call's parens, then look at what immediately follows
      let depth = 0, i = rxC.lastIndex - 1;
      for (; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') { depth--; if (depth === 0) break; }
      }
      // `\b` after the name matters: without it a greedy IDENT backtracks to satisfy
      // the "not invoked" lookahead and yields `the` out of `.then(` / `catc` out of
      // `.catch(`. With it, the whole method name must fail the lookahead.
      const after = settle(src.slice(i + 1, i + 120));
      const cm = new RegExp(`^\\s*\\)*\\s*\\??\\.\\s*(${IDENT})\\b\\s*(?!\\()`).exec(after);
      if (cm) add(cm[1], `${file}:chained`);
    }

    // ── R: property reads on an identifier bound to the whole settings object ─
    // Both binding forms: `const s = …getSettings(u)…;` and the declare-then-assign
    // `let s; try { s = (await …getSettings(u)) || {}; }` that portal-reflection uses.
    const rxB = new RegExp(`(?:(?:const|let|var)\\s+)?(${IDENT})\\s*=\\s*([^;]{0,240}?getSettings[^;]{0,240});`, 'g');
    while ((m = rxB.exec(src))) {
      const name = m[1];
      const rhs = m[2];
      // a binding that drills in is a SECOND-level binding, not a settings blob
      const ci = rhs.indexOf('getSettings');
      let depth = 0, j = rhs.indexOf('(', ci);
      if (j < 0) continue;
      for (; j < rhs.length; j++) {
        if (rhs[j] === '(') depth++;
        else if (rhs[j] === ')') { depth--; if (depth === 0) break; }
      }
      if (/^\s*\)*\s*\??\./.test(settle(rhs.slice(j + 1)))) continue;
      // scope: from this binding to the next binding of the SAME name, capped
      const from = m.index + m[0].length;
      const restRx = new RegExp(`(?:const|let|var)\\s+${name}\\s*=`, 'g');
      restRx.lastIndex = from;
      const nxt = restRx.exec(src);
      const to = Math.min(nxt ? nxt.index : src.length, from + 1500);
      const region = src.slice(from, to);
      const rxU = new RegExp(`(?<![\\w$.])${name}\\s*\\??\\.\\s*(${IDENT})\\b\\s*(?!\\()`, 'g');
      let u;
      while ((u = rxU.exec(region))) add(u[1], `${file}:via ${name}`);
    }
  }
  return out;
}

/**
 * Audit the settings vocabulary against the classification above.
 * Pure + injectable, so the gate can mutation-test it (M7).
 *
 * kinds:
 *   unclassified-settings-key  a key src/ writes or reads that nobody classified
 *                              → stripped at import (fail-closed) but unexplained
 *   stale-settings-entry       classified here, named nowhere in src/
 *   no-settings-rationale      missing / too-short `why`
 *   quarantine-key-is-read     a file OTHER than the importer/policy pair names the
 *                              quarantine key — the "inert by construction" claim is
 *                              no longer true
 *
 * @param {{ sources: Array<{file:string,source:string}>, policy?: object }} args
 */
export function auditSettingsPolicy({ sources, policy = IMPORT_SETTINGS_POLICY }) {
  const findings = [];
  const found = scanSettingsKeys(sources);
  for (const [key, evidence] of found) {
    if (key === IMPORT_SETTINGS_QUARANTINE_KEY) continue;   // handled below
    if (!policy[key]) {
      findings.push({ kind: 'unclassified-settings-key', key, detail: `written/read in src/ (${evidence.join(', ')}) but absent from IMPORT_SETTINGS_POLICY — stripped at import (fail-closed) and unexplained` });
    }
  }
  for (const [key, p] of Object.entries(policy)) {
    if (!p?.why || String(p.why).trim().length < 20) {
      findings.push({ kind: 'no-settings-rationale', key, detail: 'policy entry needs a written reason' });
    }
    if (key === IMPORT_SETTINGS_QUARANTINE_KEY) continue;   // never appears in src/ by design
    // `dormant: true` — a key with no live reader LEFT, kept classified on purpose.
    // Dormancy is not a defence (the same argument as the dormant tables above): the
    // key persists in vaults written by older builds and by the canonical product, so
    // it must keep its verdict even though the scan can no longer see it.
    if (p.dormant) continue;
    // `rawSql: true` — written/read through raw SQL against the settings column
    // (src/db/spaces.js), which this scan structurally cannot see. Classified by hand;
    // the stale check would otherwise RED on a key that is very much alive.
    if (p.rawSql) continue;
    if (found.size && !found.has(key)) {
      findings.push({ kind: 'stale-settings-entry', key, detail: 'classified here but named nowhere in src/ — confirm it is still real, or drop it' });
    }
  }
  // The quarantine's whole safety claim is "nothing reads it".
  const OWNERS = /(ingest\/vault-import\.js|ingest\/import-credential-policy\.js)$/;
  for (const { file, source } of Array.isArray(sources) ? sources : []) {
    if (OWNERS.test(String(file))) continue;
    if (String(source || '').includes(IMPORT_SETTINGS_QUARANTINE_KEY)) {
      findings.push({ kind: 'quarantine-key-is-read', key: IMPORT_SETTINGS_QUARANTINE_KEY, detail: `${file} names the quarantine key — it is no longer inert by construction` });
    }
  }
  return findings;
}
