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

import { promises as fsPromises } from 'node:fs';
import nodePath from 'node:path';

import { createHealthDomain } from './tools/health.js';
import { createTasksDomain } from './tools/tasks.js';
import { createFisherToolsDomain } from './tools/fisher-tools.js';
import { createMessagesDomain } from './tools/messages.js';
import { createDocumentsDomain } from './tools/documents.js';
import { createInternalDomain } from './tools/internal.js';
import { createMindFiles, MIND_MIRRORS } from './mindfiles/mind-files.js';

// Single-user defaults for the agent identity / scope deps the factories want.
const AGENT_LABELS = { 'personal-agent': 'Assistant' };

// Default root for per-agent mind-files (encrypted-at-rest disk state).
// Gitignored. createMindFiles places files under <agentRoot>/mind/, so the
// effective tree is <root>/<agentId>/mind/<filename>. Resolved at CALL time
// inside buildDomains (not module-load) so MIND_FILES_ROOT set by the caller
// after import is honored.
const DEFAULT_MIND_FILES_ROOT = 'data/mind';

/**
 * Assemble the live tool domains from the db namespace.
 *
 * Registered now = domains whose deps are satisfiable from `db` + the mind-files
 * subsystem. Deferred = domains needing subsystems not yet built (mind-search,
 * topologyHelpers, metrics CONTRACTS) — they land with their Wave-2 units;
 * listed here so the set is explicit, never silently dropped.
 *
 * @param {object} deps
 * @param {object} deps.db        - the encrypting db namespace
 * @param {string} deps.userId    - single-user id (default 'local-user')
 * @param {string} deps.agentId   - single-agent id (default 'personal-agent')
 */
export function buildDomains({ db, userId = 'local-user', agentId = 'personal-agent' } = {}) {
  // Mind-files subsystem: per-agent encrypted disk state. Owns the AES-256-GCM
  // envelope. The master key flows through crypto-local's getMasterKey(), which
  // reads USER_MASTER_KEY from the env (boot() requires it). Writes fail closed
  // in the encrypt path if the key is ever absent — we never emit plaintext.
  const mindFilesRoot = process.env.MIND_FILES_ROOT || DEFAULT_MIND_FILES_ROOT;
  const agentRoot = nodePath.join(mindFilesRoot, agentId);
  const mindFiles = createMindFiles({ agentRoot, fs: fsPromises, path: nodePath, agentId });
  const { readMindFile, writeMindFile } = mindFiles;

  const domains = [
    createHealthDomain({ getDb: () => db, userId }),
    createTasksDomain({ db, userId }),
    createFisherToolsDomain({ db, userId }),
    createMessagesDomain({ db, userId, agentLabels: AGENT_LABELS, isScoped: () => false }),
    // Internal mind-file tools (updateInternalModel, flagForDiscussion,
    // snapshotMindFile, readMindFile, editMindFile, writeMindFileWhole).
    // Deps are the bound (filename, content) helpers — mind-files is already
    // bound to this agent's root.
    createInternalDomain({ readMindFile, writeMindFile }),
    // Document store; mirrors the four MIND_MIRRORS paths into mind-files.
    // No publishing renderer / searchClient in V1 (later Waves) — those
    // optional deps default to null and the tools degrade gracefully
    // (publishDocument returns "not configured"; findDocuments is not
    // registered).
    createDocumentsDomain({
      db,
      userId,
      agentId,
      writeMindFile,
      mindMirrors: MIND_MIRRORS,
    }),
  ];
  // Deferred = domains needing a subsystem not yet built. Each lands with its
  // Wave-2 unit; listed explicitly so the surface is never silently dropped.
  //   metrics       -> @mycelium/metrics/contracts (CONTRACTS) not in reference/
  //   topology-tools-> topologyHelpers (createTopologyHelpers)
  //   mindscape     -> mind-search (searchHelpers)
  const deferred = ['metrics (CONTRACTS)',
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
