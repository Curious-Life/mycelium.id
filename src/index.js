// Mycelium V1 entry — stdio MCP server (default transport).
//
// Boot sequence: load two hex keys from env -> unlock + KCV verify (fail closed)
// -> open the encrypting db + assemble namespaces -> build tool domains ->
// register on the low-level Server -> connect stdio.
//
// Default transport is stdio. Pass `--http` (or set MYCELIUM_HTTP=1) to start
// the remote Streamable-HTTP + OAuth 2.1 server (src/server-http.js) instead.
// Both paths call the SAME boot() below, so the tool surface is identical.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { unlock } from './crypto/keys.js';
import { getDb } from './db/index.js';
import { buildDomains, collectTools, createMcpServer } from './mcp.js';

export async function boot({
  dbPath = process.env.MYCELIUM_DB || 'data/mycelium.db',
  kcvPath = process.env.MYCELIUM_KCV || 'data/kcv.json',
  userHex = process.env.USER_MASTER_KEY,
  systemHex = process.env.SYSTEM_KEY,
  userId = process.env.MYCELIUM_USER_ID || 'local-user',
} = {}) {
  if (!userHex || !systemHex) {
    throw new Error('USER_MASTER_KEY and SYSTEM_KEY must be set (64-char hex each). Vault stays locked.');
  }
  const { userKey, systemKey } = await unlock({ userHex, systemHex, kcvPath });
  const { db, close } = getDb({ dbPath, userKey, systemKey });
  const { domains, deferred } = buildDomains({ db, userId });
  const { tools, handlers } = collectTools(domains);
  const server = createMcpServer({ tools, handlers });
  return { server, db, close, tools, deferred };
}

async function startStdio() {
  const { server, tools, deferred } = await boot();
  // stderr only — never write non-protocol bytes to stdout on stdio transport.
  console.error(`[mycelium] ${tools.length} tools registered; ${deferred.length} deferred (${deferred.join(', ')})`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mycelium] stdio MCP server connected.');
}

async function startHttp() {
  // Lazy import so the stdio path never loads express/better-auth.
  const { startHttpServer } = await import('./server-http.js');
  await startHttpServer();
}

// Run only when invoked directly (not when imported by a verifier).
if (import.meta.url === `file://${process.argv[1]}`) {
  const httpMode = process.argv.includes('--http') || process.env.MYCELIUM_HTTP === '1';
  const run = httpMode ? startHttp : startStdio;
  run().catch((err) => { console.error('[mycelium] fatal:', err.message); process.exit(1); });
}
