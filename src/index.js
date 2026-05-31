// Mycelium V1 entry — MCP server. Two transports share ONE assembly (boot()):
//   - stdio (default)         — local MCP clients spawn the process.
//   - Streamable HTTP + OAuth — `--http` / MYCELIUM_HTTP=1 for remote clients.
//
// Boot sequence: load two hex keys from env -> unlock + KCV verify (fail closed)
// -> open the encrypting db + assemble namespaces -> build tool domains ->
// register on the low-level Server. The transport is bound by the caller (stdio
// here; src/server-http.js for the HTTP/OAuth path), so the tool surface is
// identical across transports.
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

async function mainStdio() {
  const { server, tools, deferred } = await boot();
  // stderr only — never write non-protocol bytes to stdout on stdio transport.
  console.error(`[mycelium] ${tools.length} tools registered; ${deferred.length} deferred (${deferred.join(', ')})`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mycelium] stdio MCP server connected.');
}

async function mainHttp() {
  // Lazy import so the stdio path has zero load-time dependency on
  // express / better-auth.
  const { startHttpServer } = await import('./server-http.js');
  await startHttpServer();
}

function wantsHttp(argv = process.argv) {
  return argv.includes('--http') || process.env.MYCELIUM_HTTP === '1';
}

async function main() {
  if (wantsHttp()) await mainHttp();
  else await mainStdio();
}

// Run only when invoked directly (not when imported by a verifier).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error('[mycelium] fatal:', err.message); process.exit(1); });
}
