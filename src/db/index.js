// getDb() assembly — wires the db-d1 namespace factories into the single `db`
// object the MCP tool factories consume (verified contract: tools call
// db.<namespace>.<method>, e.g. db.health.getRange — tools/health.js:49).
//
// Scope: only the namespaces the V1 single-user tool surface (~34 tools)
// actually reference are wired. The remaining db-d1 files (auth/session/
// federation/space-rooms/etc.) are present in src/db/ and ready to wire when
// their tools land, but are NOT assembled here — wiring a namespace no tool
// calls would be dead surface. See TOOL_NAMESPACES below for the live set.
import { createDb } from '../adapter/d1.js';
import { parseHealthRow, computeHealthSummary, cofireCol } from './helpers.js';

import { createDocumentsNamespace } from './documents.js';
import { createMessagesNamespace } from './messages.js';
import { createFactsNamespace } from './facts.js';
import { createEntitiesNamespace } from './entities.js';
import { createAttachmentsNamespace } from './attachments.js';
import { createSecretsNamespace } from './secrets.js';
import { createHealthNamespace } from './health.js';
import { createTasksNamespace } from './tasks.js';
import { createMetricsNamespace } from './metrics.js';
import { createAnchorNamespace } from './anchor.js';
import { createTopologyNamespace } from './topology.js';
import { createFisherNamespace } from './fisher.js';
import { createFoldersNamespace } from './folders.js';
import { createCanvasesNamespace } from './canvases.js';
import { createAuditNamespace } from './audit.js';
import { createLlmUsageNamespace } from './llm-usage.js';
import { createActivityFeedNamespace } from './activity-feed.js';
import { createPipelineStateNamespace } from './pipeline-state.js';
import { createHarnessNamespace } from './harness.js';
import { createSpacesNamespace } from './spaces.js';
import { createSpaceKnowledgeNamespace } from './space-knowledge.js';
import { createPublicPresenceNamespace } from './public-presence.js';
import { createMindscapeNamespace } from './mindscape.js';
import { createTerritoryDocsNamespace } from './territory-docs.js';
import { createHistoryNamespace } from './history.js';
import { createProvidersNamespace } from './providers.js';
import { createConnectorsNamespace } from './connectors.js';
import { createUsersNamespace } from './users.js';
import { createClaimsNamespace } from './claims.js';
import { createReflectionsNamespace } from './reflections.js';
import { createEgressAuditNamespace } from './egress-audit.js';
import { createIdentityChannelsNamespace } from './identity-channels.js';
import { createTelegramGroupsNamespace } from './telegram-groups.js';
import { createChannelAccessNamespace } from './channel-access.js';
import { createConnectionsNamespace } from './connections.js';
import { createPeerPresenceNamespace } from './peer-presence.js';
import { createSpaceAccessNamespace } from './space-access.js';
import { createSpaceRoomsNamespace } from './space-rooms.js';
import { createSpaceRoomDocumentsNamespace } from './space-room-documents.js';
import { createSpaceConversationsNamespace } from './space-conversations.js';
import { createContextsNamespace } from './contexts.js';
import { createInboundSharesNamespace } from './inbound-shares.js';
import { createStreamsNamespace } from './streams.js';
import { createSpaceMatrixRoomsNamespace } from './space-matrix-rooms.js';

/**
 * Open the vault db and assemble the tool-facing `db` namespace object.
 * @returns {{ db: object, close: () => void, adapter: object }}
 */
export function getDb({ dbPath, userKey, systemKey, scope = 'personal', federationDeps = {}, dbKeyHex = null }) {
  const adapter = createDb({ dbPath, userKey, systemKey, scope, dbKeyHex });
  const { d1Query, d1QueryAdmin, d1Batch, firstRow, parseJson, randomUUID, now } = adapter;

  const base = { d1Query, d1QueryAdmin, d1Batch, firstRow, parseJson, randomUUID, now };

  const db = {
    // Raw passthrough — the enrichment-router / topology tools call db.rawQuery
    // (tools/topology-tools.js, fisher-tools.js). Same engine as d1Query.
    rawQuery: (sql, params = []) => d1Query(sql, params),

    documents: createDocumentsNamespace({ d1Query, firstRow }),
    messages: createMessagesNamespace({ d1Query, d1Batch, firstRow }),
    facts: createFactsNamespace({ d1Query, firstRow, randomUUID }),
    entities: createEntitiesNamespace({ d1Query, firstRow, randomUUID }),
    attachments: createAttachmentsNamespace({ d1Query, firstRow }),
    secrets: createSecretsNamespace({ d1Query, firstRow }),
    health: createHealthNamespace({ d1QueryAdmin, firstRow, parseHealthRow, computeHealthSummary, now }),
    tasks: createTasksNamespace({ d1Query, firstRow }),
    metrics: createMetricsNamespace({ d1Query, firstRow }),
    // Tier-1 embedding-anchor reader — deliberately a FAIL-CLOSED gated reader
    // (audit S1). The four anchor metrics are cvp_status='pending', so every read
    // returns honest refusal copy, never the raw number. It is the ONLY sanctioned
    // path to cognitive_metrics_anchor; the no-ungated-reader invariant is enforced
    // by verify:cvp. @see src/db/anchor.js, src/metrics/surface-gate.js.
    anchor: createAnchorNamespace({ d1Query, firstRow }),
    topology: createTopologyNamespace({ d1Query, firstRow, cofireCol }),
    fisher: createFisherNamespace({ d1Query, firstRow }),
    folders: createFoldersNamespace({ d1Query, randomUUID }),
    canvases: createCanvasesNamespace({ d1Query, firstRow }),
    audit: createAuditNamespace({ d1QueryAdmin, randomUUID }),
    // LLM token-usage accounting (counts + dimensions only, plaintext metadata) —
    // backs the /portal/usage transparency surface. @see src/db/llm-usage.js.
    usage: createLlmUsageNamespace({ d1Query, randomUUID }),
    // Cross-process job/activity feed over background_jobs (content-free, plaintext).
    activityFeed: createActivityFeedNamespace({ d1QueryAdmin, randomUUID }),
    // Per-stage measurement-health ledger over pipeline_state (content-free): the
    // recorder that pipeline/lib/stage-result.js finalize() writes — last success/
    // failure, streak, quarantine. Backs era-resolution rung 1 + /measurement-health.
    pipelineState: createPipelineStateNamespace({ d1QueryAdmin }),
    // Native agent harness state (Phase 5): scheduled_tasks (encrypted prompt) +
    // harness_runs (content-free run lifecycle/recovery/dedup) + conversation_summaries
    // (encrypted compaction). @see src/db/harness.js, migrations/0018_harness.sql.
    harness: createHarnessNamespace({ d1Query, d1QueryAdmin, randomUUID, now }),
    spaces: createSpacesNamespace({ d1Query, firstRow, parseJson }),
    // Shared spaces as default-private folders (Phase A). space_access is the
    // grant primitive (fail-closed: no grant = invisible); rooms + room-documents
    // are the nested-folder model; contexts is the per-connection territory model.
    spaceAccess: createSpaceAccessNamespace({ d1Query }),
    spaceRooms: createSpaceRoomsNamespace({ d1Query, firstRow, randomUUID }),
    spaceRoomDocuments: createSpaceRoomDocumentsNamespace({ d1Query, randomUUID }),
    spaceConversations: createSpaceConversationsNamespace({ d1Query, firstRow, randomUUID }),
    contexts: createContextsNamespace({ d1Query, randomUUID }),
    // Federation sharing (grantee side): spaces/contexts a peer shared WITH me.
    inboundShares: createInboundSharesNamespace({ d1Query, randomUUID }),
    // Per-user channel bindings (Phase B: the box's Matrix MXID under kind='matrix').
    identityChannels: createIdentityChannelsNamespace({ d1Query, firstRow }),
    spaceMatrixRooms: createSpaceMatrixRoomsNamespace({ d1Query, firstRow }),
    // Federation (Tier-0): the social graph + cross-instance connect. sign/did/
    // selfInstance come from boot() (derived from the box identity + publicHost);
    // absent when remote is off → outbound stays unsigned-disabled, cleanly.
    connections: createConnectionsNamespace({
      d1Query,
      sign: federationDeps.sign,
      did: federationDeps.did,
      selfInstance: federationDeps.selfInstance,
    }),
    // Connection online/offline presence: owner activity heartbeat (users.last_active_at),
    // written by the :8787 auth chokepoint, read by the :4711 federation responder.
    // NOT db.publicPresence (anonymous doc-reader counts). @see src/db/peer-presence.js.
    peerPresence: createPeerPresenceNamespace({ d1Query }),
    spaceKnowledge: createSpaceKnowledgeNamespace({ d1Query, firstRow, randomUUID }),
    publicPresence: createPublicPresenceNamespace({ d1Query }),

    // AI providers (BYOK credentials for the outbound inference router + the
    // /portal/providers backend). `credentials` is encrypted at rest
    // (ENCRYPTED_FIELDS.ai_providers); list() returns metadata only.
    providers: createProvidersNamespace({ d1Query }),

    // Connectors (data-connection operational state for the sync scheduler +
    // /portal/connectors). account_label/last_error/recent_runs are encrypted at
    // rest (ENCRYPTED_FIELDS.connectors); list() returns metadata only. OAuth
    // tokens stay in the `secrets` table (src/connectors/store.js).
    connectors: createConnectorsNamespace({ d1Query }),

    // Unified Streams surface. spectrum() is PLAINTEXT-ONLY aggregates across
    // messages/documents/health_daily/tasks + connector status (§7 fail-safe);
    // feed() (Phase 2) does the per-table decrypting union. Reads db.connectors
    // for the status join. @see src/db/streams.js, src/streams/source-registry.js.
    streams: null, // set below (needs the assembled `connectors` namespace)

    // Mindscape reads (clustering points + territory/realm/theme profiles) and
    // territory-docs (narrative read/write). Wired for the portal mindscape
    // surface (src/portal-mindscape.js) + the Phase C chronicles writer.
    mindscape: createMindscapeNamespace({ d1Query, parseJson }),
    territoryDocs: createTerritoryDocsNamespace({ d1Query, parseJson }),
    history: createHistoryNamespace({ d1Query, parseJson, now }),

    // Persona-Claims (PersonaTree adoption): current person-level claims +
    // per-window snapshots for temporal evolution. Sensitive cols encrypted at
    // rest (ENCRYPTED_FIELDS.person_claims / .person_claim_snapshots).
    // @see migrations/0011_persona_claims.sql, src/claims/.
    claims: createClaimsNamespace({ d1Query, firstRow, randomUUID }),

    // reflection_records (Context Engine "day cards"): a dated, queryable digest of each cycle's
    // reflective read — for categorizing days + tracing red threads. @see src/db/reflections.js.
    reflections: createReflectionsNamespace({ d1Query, randomUUID, now }),

    // Core user row: timezone (read by getContext — tools/context.js:63, which
    // already optional-chains db.users) + a `settings` JSON blob that backs the
    // §4g "smart routing" toggle (the cascade preference the gateway reads
    // DB-first, src/gateway/openai-compat.js).
    users: createUsersNamespace({ d1Query, firstRow }),

    // Channel egress — the channel-daemon's loopback chokepoint records every
    // outbound send here (hash only, never plaintext — egress-audit.js) and
    // resolves channel-authority from identity_channels. Both are read/written
    // ONLY via the internal router (src/internal-router.js); no MCP tool calls
    // them, so wiring them is additive — it changes no existing tool behavior.
    egressAudit: createEgressAuditNamespace({ d1Query }),
    telegramGroups: createTelegramGroupsNamespace({ d1Query }),
    channelAccess: createChannelAccessNamespace({ d1Query, firstRow }),

    // db.shareLinks is intentionally omitted — every call site is optional-
    // chained (tools/documents.js:102,516 `db.shareLinks?.…`), so absence
    // cleanly degrades to "not public" / "no links" for the single-user vault.
    _base: base,

    // Raw better-sqlite3 handle (same connection the adapter opened). Internal:
    // the on-disk SQLite search backend (src/search/backend/sqlite.js) needs
    // direct synchronous access to its FTS5/vec0 tables in this same vault file.
    // Underscore-prefixed = not a public namespace; only the search wiring reads it.
    _sqlite: adapter.db,
  };

  // streams.spectrum joins connector op-state + streams.feed reuses messages/
  // attachments for the message arm, so it's wired after the literal (it needs the
  // assembled db). Passing `db` is a deliberate back-reference (db.streams holds db).
  db.streams = createStreamsNamespace({ d1Query, connectors: db.connectors, db });

  return { db, adapter, close: adapter.close };
}
