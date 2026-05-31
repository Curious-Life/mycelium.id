// Mycelium V1 entry — stdio MCP server (default transport).
//
// Boot sequence: load two hex keys from env -> unlock + KCV verify (fail closed)
// -> open the encrypting db + assemble namespaces -> build tool domains ->
// register on the low-level Server -> connect stdio.
//
// HTTP/StreamableHTTP transport + OAuth land in Phase 4 (the OAuth provider is
// verified GO via spike/oauth/). This entry is stdio-only for now.
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
  // embedder: the mind-search embed-service client (:8091, sibling unit R2).
  // Optional — when omitted, mind-search runs BM25-only. The CLI path leaves it
  // null until R2 wires the real client; verify scripts inject a stub.
  embedder = null,
} = {}) {
  if (!userHex || !systemHex) {
    throw new Error('USER_MASTER_KEY and SYSTEM_KEY must be set (64-char hex each). Vault stays locked.');
  }
  const { userKey, systemKey } = await unlock({ userHex, systemHex, kcvPath });
  // Bridge the vault key to the mind-files subsystem. mind-files encrypts via
  // crypto-local.getMasterKey(), which resolves USER_MASTER from tmpfs or the
  // ENCRYPTION_MASTER_KEY env fallback — NOT the unlock()-derived CryptoKey the
  // db adapter holds. Pin it (authoritatively — overwrite any stale value) to
  // the same hex so mind files and vault rows share one key and can never
  // diverge. Without this, getMasterKey() returns null on a host without tmpfs
  // and every mind-file write throws. getMasterKey() pins on first use, so this
  // must run before buildDomains (the first encrypt/decrypt path). Process-local
  // env, memory-only, never logged — consistent with the key discipline.
  process.env.ENCRYPTION_MASTER_KEY = userHex;
  const { db, close } = getDb({ dbPath, userKey, systemKey });
  const { domains, deferred } = buildDomains({ db, userId, embedder });
  const { tools, handlers } = collectTools(domains);
  const server = createMcpServer({ tools, handlers });
  // handlers is returned so non-MCP transports (REST) can reuse the SAME
  // tool handler map without re-implementing tool logic.
  return { server, db, close, tools, handlers, deferred };
}

async function main() {
  const { server, tools, deferred } = await boot();
  // stderr only — never write non-protocol bytes to stdout on stdio transport.
  console.error(`[mycelium] ${tools.length} tools registered; ${deferred.length} deferred (${deferred.join(', ')})`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mycelium] stdio MCP server connected.');
}

// Run only when invoked directly (not when imported by the verifier).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error('[mycelium] fatal:', err.message); process.exit(1); });
}
