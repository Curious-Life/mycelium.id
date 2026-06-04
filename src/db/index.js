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
import { createHealthNamespace } from './health.js';
import { createTasksNamespace } from './tasks.js';
import { createMetricsNamespace } from './metrics.js';
import { createTopologyNamespace } from './topology.js';
import { createFisherNamespace } from './fisher.js';
import { createFoldersNamespace } from './folders.js';
import { createCanvasesNamespace } from './canvases.js';
import { createAuditNamespace } from './audit.js';
import { createSpacesNamespace } from './spaces.js';
import { createSpaceKnowledgeNamespace } from './space-knowledge.js';
import { createPublicPresenceNamespace } from './public-presence.js';
import { createMindscapeNamespace } from './mindscape.js';
import { createTerritoryDocsNamespace } from './territory-docs.js';
import { createProvidersNamespace } from './providers.js';

/**
 * Open the vault db and assemble the tool-facing `db` namespace object.
 * @returns {{ db: object, close: () => void, adapter: object }}
 */
export function getDb({ dbPath, userKey, systemKey, scope = 'personal' }) {
  const adapter = createDb({ dbPath, userKey, systemKey, scope });
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
    health: createHealthNamespace({ d1QueryAdmin, firstRow, parseHealthRow, computeHealthSummary, now }),
    tasks: createTasksNamespace({ d1Query, firstRow }),
    metrics: createMetricsNamespace({ d1Query, firstRow }),
    topology: createTopologyNamespace({ d1Query, firstRow, cofireCol }),
    fisher: createFisherNamespace({ d1Query, firstRow }),
    folders: createFoldersNamespace({ d1Query, randomUUID }),
    canvases: createCanvasesNamespace({ d1Query, firstRow }),
    audit: createAuditNamespace({ d1QueryAdmin, randomUUID }),
    spaces: createSpacesNamespace({ d1Query, firstRow, parseJson }),
    spaceKnowledge: createSpaceKnowledgeNamespace({ d1Query, firstRow, randomUUID }),
    publicPresence: createPublicPresenceNamespace({ d1Query }),

    // AI providers (BYOK credentials for the outbound inference router + the
    // /portal/providers backend). `credentials` is encrypted at rest
    // (ENCRYPTED_FIELDS.ai_providers); list() returns metadata only.
    providers: createProvidersNamespace({ d1Query }),

    // Mindscape reads (clustering points + territory/realm/theme profiles) and
    // territory-docs (narrative read/write). Wired for the portal mindscape
    // surface (src/portal-mindscape.js) + the Phase C chronicles writer.
    mindscape: createMindscapeNamespace({ d1Query, parseJson }),
    territoryDocs: createTerritoryDocsNamespace({ d1Query, parseJson }),

    // db.shareLinks is intentionally omitted — every call site is optional-
    // chained (tools/documents.js:102,516 `db.shareLinks?.…`), so absence
    // cleanly degrades to "not public" / "no links" for the single-user vault.
    _base: base,
  };

  return { db, adapter, close: adapter.close };
}
