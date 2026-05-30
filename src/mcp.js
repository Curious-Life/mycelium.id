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

import { createHealthDomain } from './tools/health.js';
import { createTasksDomain } from './tools/tasks.js';
import { createFisherToolsDomain } from './tools/fisher-tools.js';
import { createMessagesDomain } from './tools/messages.js';
import { createMindscapeDomain } from './tools/mindscape.js';
import { createSearchHelpers } from './search/helpers.js';

// Single-user defaults for the agent identity / scope deps the factories want.
const AGENT_LABELS = { 'personal-agent': 'Assistant' };

/**
 * Assemble the live tool domains from the db namespace.
 *
 * Registered now = domains whose deps are satisfiable from `db` alone.
 * Deferred = domains needing subsystems not yet built (mind-files, mind-search,
 * topologyHelpers) — they land with their Wave-2 units; listed here so the set
 * is explicit, never silently dropped.
 */
export function buildDomains({ db, userId = 'local-user', embedder = null, searchHelpers } = {}) {
  // mind-search subsystem (Wave-2): in-RAM BM25 + ANN cosine + RRF + temporal
  // boost behind the bulkSearch contract searchMindscape consumes. The embedder
  // is INJECTED; the real Nomic v1.5 embed-service (:8091) ships in a sibling
  // unit (R2). With no embedder the local tier runs lexical-only (BM25) and
  // still serves results — semantic recall lights up when R2 lands.
  const helpers = searchHelpers ?? createSearchHelpers({ db, embedder, userId });

  const domains = [
    createHealthDomain({ getDb: () => db, userId }),
    createTasksDomain({ db, userId }),
    createFisherToolsDomain({ db, userId }),
    createMessagesDomain({ db, userId, agentLabels: AGENT_LABELS, isScoped: () => false }),
    createMindscapeDomain({ searchHelpers: helpers, userId }),
  ];
  // Deferred = domains needing a subsystem not yet built. Each lands with its
  // Wave-2 unit; listed explicitly so the surface is never silently dropped.
  //   metrics       -> @mycelium/metrics/contracts (CONTRACTS) not in reference/
  //   documents     -> mind-files (writeMindFile, mindMirrors)
  //   topology-tools-> topologyHelpers (createTopologyHelpers)
  //   internal      -> mind-files (readMindFile/writeMindFile)
  const deferred = ['metrics (CONTRACTS)', 'documents (mind-files)',
    'topology-tools (topologyHelpers)',
    'internal (mind-files)', 'reply', 'services'];
  return { domains, deferred };
}

/**
 * Flatten domains into a tools array + a name->handler map, guarding against
 * duplicate tool names (a real risk when 14 files each declare tools).
 */
export function collectTools(domains) {
  const tools = [];
  const handlers = Object.create(null);
  for (const d of domains) {
    for (const t of d.tools) {
      if (handlers[t.name]) throw new Error(`duplicate tool name: ${t.name}`);
      tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
      handlers[t.name] = d.handlers[t.name];
      if (typeof handlers[t.name] !== 'function') {
        throw new Error(`tool '${t.name}' has no handler`);
      }
    }
  }
  return { tools, handlers };
}

/** Create a configured low-level MCP Server over the given tools/handlers. */
export function createMcpServer({ tools, handlers }) {
  const server = new Server(
    { name: 'mycelium', version: '0.1.0' },
    { capabilities: { tools: {} } },
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
      // Never leak internals; surface a safe error to the client.
      return { content: [{ type: 'text', text: `Error in ${name}: ${err.message}` }], isError: true };
    }
  });

  return server;
}
