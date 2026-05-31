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
import { createFisherToolsDomain } from './tools/fisher-tools.js';
import { createMessagesDomain } from './tools/messages.js';
import { createDocumentsDomain } from './tools/documents.js';
import { createInternalDomain } from './tools/internal.js';
import { createMindFiles, MIND_MIRRORS } from './mindfiles/mind-files.js';
import { createMetricsDomain } from './tools/metrics.js';

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
export function buildDomains({
  db,
  userId = 'local-user',
  agentId = 'personal-agent',
  agentRoot = process.env.MYCELIUM_AGENT_ROOT || 'data/mind',
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

  const domains = [
    createHealthDomain({ getDb: () => db, userId }),
    createTasksDomain({ db, userId }),
    createFisherToolsDomain({ db, userId }),
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
    createMetricsDomain({ db, userId }),
  ];
  // Deferred = domains needing a subsystem not yet built. Each lands with its
  // Wave-2 unit; listed explicitly so the surface is never silently dropped.
  //   topology-tools-> topologyHelpers (createTopologyHelpers)
  //   mindscape     -> mind-search (searchHelpers)
  const deferred = [
    'topology-tools (topologyHelpers)', 'mindscape (mind-search)',
    'reply', 'services'];
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
