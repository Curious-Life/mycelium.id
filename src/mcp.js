// MCP tool registration seam (low-level Server).
//
// VERIFIED CONTRACT (4th sweep + reference reads):
//   - reference/ has NO @modelcontextprotocol/sdk; tool factories are plain
//     createXDomain(deps) -> { tools, handlers } where each tool is
//     { name, description, inputSchema(JSON-Schema) } and each handler is
//     async (args) => string.
//   => Use the low-level Server with ListTools/CallTool request handlers, pass
//      the JSON-Schema inputSchema straight through, and wrap the returned
//      string into a { content: [{ type:'text', text }] } envelope at the
//      single tools/call seam. Do NOT use McpServer.tool() (it wants Zod).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createHealthDomain } from './tools/health.js';
import { createTasksDomain } from './tools/tasks.js';
import { createCognitionDomain } from './tools/cognition.js';
import { createMessagesDomain } from './tools/messages.js';
import { createDocumentsDomain } from './tools/documents.js';
import { createInternalDomain } from './tools/internal.js';
import { createMindFiles, MIND_MIRRORS } from './mindfiles/mind-files.js';
import { createMindscapeDomain } from './tools/mindscape.js';
import { createSearchHelpers } from './search/index.js';
import { createTopologyHelpers } from './topology/helpers.js';
import { createContextDomain } from './tools/context.js';
import { createIngestDomain } from './tools/ingest.js';
import { createCurateDomain } from './tools/curate.js';
import { createFederationDomain } from './tools/federation.js';
import { createEnqueueEnrichment } from './ingest/enqueue.js';
import { getMasterKey } from './crypto/crypto-local.js';

// Single-user defaults for the agent identity / scope deps the factories want.
const AGENT_LABELS = { 'personal-agent': 'Assistant' };

/**
 * Assemble the live tool domains from the db namespace.
 *
 * Registered now = domains whose deps are satisfiable from `db` alone.
 * Deferred = domains needing subsystems not yet built (mind-files,
 * topologyHelpers) — they land with their Wave-2 units; listed here so the set
 * is explicit, never silently dropped.
 *
 * @param {object} args
 * @param {object} args.db
 * @param {string} [args.userId]
 * @param {{ embed, health }} [args.embedder]  injected mind-search embedder.
 *   The real one wraps embed-service (:8091, sibling unit R2). When absent the
 *   mind-search backend runs BM25-only and still returns ranked results.
 */
export function buildDomains({
  db,
  userId = 'local-user',
  agentId = 'personal-agent',
  agentRoot = process.env.MYCELIUM_AGENT_ROOT || 'data/mind',
  embedder = null,
  identity = null,
}) {
  // Mind-files subsystem (Wave 2). createMindFiles binds fs/path + an
  // AGENT_ROOT + agent identity; its read/write helpers encrypt at rest with
  // the same crypto-local AES-256-GCM envelope as the vault. mind-files calls
  // crypto-local.getMasterKey() (tmpfs/ENCRYPTION_MASTER_KEY-pinned) rather
  // than the unlock()-derived CryptoKey the db adapter uses — boot() bridges
  // the two by setting ENCRYPTION_MASTER_KEY = USER_MASTER before this runs,
  // so mind files and vault rows share one key. The mind/ subdir is created
  // lazily on first write.
  const mindFiles = createMindFiles({ agentRoot, agentId, fs, path });

  // searchHelpers wraps the mind-search subsystem (in-RAM ANN + BM25 + RRF +
  // temporal) plus topology reads. It is the dep createMindscapeDomain needs.
  // The embedder is injected (real one wraps embed-service :8091, sibling R2);
  // when absent the backend runs BM25-only and still returns ranked results.
  const searchHelpers = createSearchHelpers({ db, embedder, userId, getMasterKey });

  // topologyHelpers (Wave-2): resolver + fetchers over the db.topology
  // namespace. Honest-empty against an empty vault — see src/topology/helpers.js.
  const topologyHelpers = createTopologyHelpers({ db, userId });

  const domains = [
    // getContext: the D5 preamble — the entry point a client calls first.
    createContextDomain({
      getDb: () => db,
      readMindFile: (filename) => mindFiles.readMindFile(filename),
      userId,
    }),
    // captureMessage: the single choke-point — "any message that comes in is saved".
    // enqueueEnrichment nudges the :8095 service after each save (best-effort,
    // non-fatal when the service is absent — the row is queued at nlp_processed=0).
    createIngestDomain({ db, userId, enqueueEnrichment: createEnqueueEnrichment({ userId }) }),
    // forget + mark: cross-cutting curate verbs over a {type,id} ref. searchHelpers
    // is threaded so forget() can evict the in-RAM index; db.audit logs the forget.
    createCurateDomain({ db, userId, searchHelpers }),
    createHealthDomain({ getDb: () => db, userId }),
    createTasksDomain({ db, userId }),
    createMessagesDomain({ db, userId, agentLabels: AGENT_LABELS, isScoped: () => false }),
    // documents domain mirrors the MIND_MIRRORS paths to mind-files on
    // saveDocument/updateDocument. No searchClient/publicRenderer in V1, so
    // findDocuments + the publishing tools stay dormant (clean degrade).
    createDocumentsDomain({
      db,
      userId,
      agentId,
      writeMindFile: (filename, content) => mindFiles.writeMindFile(filename, content),
      mindMirrors: MIND_MIRRORS,
    }),
    // internal domain wants the two mind-file fns directly (not the bundle).
    createInternalDomain({
      readMindFile: (filename) => mindFiles.readMindFile(filename),
      writeMindFile: (filename, content) => mindFiles.writeMindFile(filename, content),
    }),
    createMindscapeDomain({ searchHelpers, db, userId }),
    // Phase 5: the 11 cluster/Fisher/metric/topology readers consolidated into
    // 3 cohesive tools (cognitiveState / cognitiveHistory / mindscape). Reuses
    // the fisher-tools/metrics/topology-tools handler logic verbatim.
    createCognitionDomain({ db, userId, topologyHelpers }),
    // Federation (Tier-0): request/manage cross-instance connections. The crypto
    // (signing outbound, verifying inbound) lives in db.connections + the
    // federation router; this is the user-facing verb surface.
    createFederationDomain({ db, userId }),
  ];
  // Deferred = domains needing a subsystem not yet built. Each lands with its
  // Wave-2 unit; listed explicitly so the surface is never silently dropped.
  const deferred = ['reply', 'services'];
  // Cold-start readiness probe (Phase 4). The Tier-2 readers below depend on the
  // topology pipeline having run (clustering_points with landscape coords). On a
  // fresh vault they'd return honest-empty; gating turns that into an explicit,
  // actionable message. The probe re-checks until ready, then caches true forever
  // (clustering doesn't un-compute) — so a mid-session import+cluster flips it on
  // the next call with no TTL, and zero queries once ready.
  const isTopologyReady = makeTopologyReadiness({ db, userId });

  return { domains, deferred, searchHelpers, isTopologyReady };
}

// Tier-2 tools: the cluster/Fisher/metric/topology readers that need the
// topology pipeline. NOT the Tier-1 surface (getContext, capture, remember/
// forget/mark/link, facts/entities listings, documents, mind-files, BM25 search
// + relatedTo) — those work on a fresh vault and are never gated.
export const TIER2_TOOLS = new Set([
  'cognitiveState', 'cognitiveHistory', 'mindscape',
]);

export const TOPOLOGY_NOT_READY_MESSAGE =
  "Your mindscape isn't computed yet. Import your conversation history and run clustering first "
  + '(see docs/HOW-IT-WORKS.md) — then this will show your real cognitive topology. '
  + 'Meanwhile getContext, searchMindscape (search / facts / entities / people), and capture all work now.';

/**
 * Build the topology readiness probe. ready iff clustering_points has landscape
 * rows (db.mindscape.getNoiseStats().total > 0). Caches true once seen; while
 * not-ready it re-queries each call (cheap COUNT) so readiness flips the moment
 * clustering lands. A probe failure is treated as not-ready (fail-closed).
 */
export function makeTopologyReadiness({ db, userId }) {
  let ready = false;
  return async function isTopologyReady() {
    if (ready) return true;
    try {
      const stats = await db?.mindscape?.getNoiseStats?.(userId);
      if (stats && Number(stats.total) > 0) ready = true;
    } catch { /* fail-closed: treat as not-ready */ }
    return ready;
  };
}

/**
 * Flatten domains into a tools array + a name->handler map, guarding against
 * duplicate tool names (a real risk when 14 files each declare tools).
 */
export function collectTools(domains, gate = null) {
  const tools = [];
  const handlers = Object.create(null);
  for (const d of domains) {
    for (const t of d.tools) {
      if (handlers[t.name]) throw new Error(`duplicate tool name: ${t.name}`);
      tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
      let h = d.handlers[t.name];
      if (typeof h !== 'function') {
        throw new Error(`tool '${t.name}' has no handler`);
      }
      // Cold-start gating (Phase 4): a Tier-2 reader returns the uniform
      // "not ready" message until the topology pipeline has run, instead of
      // honest-empty. Tier-1 tools are never wrapped. Readiness is re-checked
      // per call (the probe caches once ready), so this reflects mid-session
      // clustering with no restart.
      if (gate && typeof gate.isReady === 'function' && gate.gatedTools?.has(t.name)) {
        const inner = h;
        h = async (args) => (await gate.isReady()) ? inner(args) : (gate.message || 'Not ready yet.');
      }
      handlers[t.name] = h;
    }
  }
  return { tools, handlers };
}

// The MCP `instructions` string — surfaced in every `initialize` response (SDK
// >=1.x emits it), so a fresh client (Claude Desktop/web, opencode, …) is
// oriented before its first tool call. Deliberately SHORT + static: it points
// at the getContext preamble (D5) rather than duplicating its dynamic content.
export const MYCELIUM_INSTRUCTIONS =
  "Mycelium is the user's private cognitive vault — their notes, thoughts, people, " +
  "tasks and reflections, encrypted on their own machine. Call `getContext` FIRST to " +
  "orient (current time, what is on their mind, recent activity, system health). Prefer " +
  "recalling from this memory (the search / list / getFact tools) before answering from " +
  "general knowledge, and capture what the user shares. Everything here is sensitive and " +
  "personal; do not repeat vault contents outside this conversation.";

/** Create a configured low-level MCP Server over the given tools/handlers. */
export function createMcpServer({ tools, handlers }) {
  const server = new Server(
    { name: 'mycelium', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: MYCELIUM_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const handler = handlers[name];
    if (!handler) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    try {
      const result = await handler(args || {});
      // Handlers return strings (verified). Wrap into the MCP content envelope.
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      // Operator-only diagnostics (opt-in): the redacted client text below gives
      // no signal when a tool misbehaves, which makes local testing painful.
      // Gated behind MYCELIUM_DEBUG=1 and written to STDERR only — never stdout
      // (the stdio protocol stream) and never the client-facing content. Off by
      // default because an error can embed user content (CLAUDE.md §1); when on,
      // stderr goes to the operator's own machine (e.g. Claude Desktop's
      // mcp-server-mycelium.log) on their own single-user vault.
      if (process.env.MYCELIUM_DEBUG === '1') {
        console.error(`[mycelium] tool '${name}' threw:`, err?.stack || err?.message || err);
      }
      // Never leak internals/plaintext: a tool handler may throw a message that
      // embeds user content. Surface a fixed safe string (mirrors src/api.js),
      // distinguishing caller-input errors from internal failures via a strict
      // allowlist of generic validation phrases — the text is a constant, never
      // the raw message.
      const msg = String(err?.message ?? '');
      const isValidation = msg.length <= 200 && /(is required|is missing|must be|invalid|unknown)/i.test(msg);
      const text = isValidation ? `Error in ${name}: invalid arguments` : `Error in ${name}: tool execution failed`;
      return { content: [{ type: 'text', text }], isError: true };
    }
  });

  return server;
}
