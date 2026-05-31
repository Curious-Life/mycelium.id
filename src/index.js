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
  agentId = process.env.MYCELIUM_AGENT_ID || 'personal-agent',
  agentScopes = process.env.AGENT_SCOPES,
} = {}) {
  if (!userHex || !systemHex) {
    throw new Error('USER_MASTER_KEY and SYSTEM_KEY must be set (64-char hex each). Vault stays locked.');
  }
  // Single-user scope identity. crypto-local's scope-decryption guardian FAILS
  // CLOSED when AGENT_SCOPES is unset (an agent with no declared scope may read
  // nothing) — so the personal agent must declare the 'personal' scope to read
  // its own mind-files at rest. mind/ paths infer the 'personal' scope
  // (crypto-local.inferScope). Set it for the process if not already pinned.
  process.env.AGENT_SCOPES = agentScopes || '["personal"]';
  // The mind-files path encrypts via crypto-local.getMasterKey(), which resolves
  // its key from tmpfs → ENCRYPTION_MASTER_KEY (a 64-char hex string, validated
  // by importMasterKey) → null (fail-closed). The two-key adapter unlock takes
  // userHex (already 64-char hex) directly; bridge the SAME user master key into
  // ENCRYPTION_MASTER_KEY so mind-files at-rest encryption resolves it too —
  // one key, two consumers. Never overwrite an operator-pinned value.
  if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = userHex;
  const { userKey, systemKey } = await unlock({ userHex, systemHex, kcvPath });
  const { db, close } = getDb({ dbPath, userKey, systemKey });
  const { domains, deferred } = buildDomains({ db, userId, agentId });
  const { tools, handlers } = collectTools(domains);
  const server = createMcpServer({ tools, handlers });
  return { server, db, close, tools, deferred };
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
