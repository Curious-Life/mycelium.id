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
import { createServiceEmbedder } from './search/embedder.js';
import { resolveKeys } from './crypto/key-source.js';
import { dbPath as resolveDbPath, kcvPath as resolveKcvPath } from './paths.js';

/**
 * Resolve the query-time mind-search embedder for the CLI/server paths. Wires
 * the embed-service client (:8091) by default so semantic search is live; the
 * search backend fail-softs to BM25 per-query when the service is down, so this
 * is safe to wire unconditionally. Opt out with MYCELIUM_DISABLE_EMBED=1
 * (BM25-only); point elsewhere with MYCELIUM_EMBED_URL. Exported for testing.
 */
export function resolveDefaultEmbedder({ env = process.env } = {}) {
  if (env.MYCELIUM_DISABLE_EMBED === '1') return null;
  return createServiceEmbedder({
    baseUrl: env.MYCELIUM_EMBED_URL || undefined,
    timeoutMs: env.MYCELIUM_EMBED_TIMEOUT_MS ? Number(env.MYCELIUM_EMBED_TIMEOUT_MS) : 15000,
  });
}

export async function boot({
  // Defaults route through src/paths.js: an explicit MYCELIUM_DB/MYCELIUM_KCV
  // still wins, else <dataDir>/… (the durable app-data dir in the packaged app,
  // ./data in dev). Callers/tests may pass dbPath/kcvPath directly to override.
  dbPath = resolveDbPath(),
  kcvPath = resolveKcvPath(),
  // Master keys: resolved from MYCELIUM_KEY_SOURCE (env | keychain | 1password)
  // below when not passed explicitly. Callers/tests may inject the hex directly.
  userHex,
  systemHex,
  userId = process.env.MYCELIUM_USER_ID || 'local-user',
  // embedder: the query-time mind-search embedder ({ embed, health }). Defaults
  // to the embed-service client (:8091) via resolveDefaultEmbedder() so semantic
  // search is live out of the box; the backend fail-softs to BM25 per-query when
  // :8091 is down. Pass an explicit embedder (e.g. a stub) to override, or `null`
  // to force BM25-only. The default param only evaluates when the arg is omitted.
  embedder = resolveDefaultEmbedder(),
} = {}) {
  // Acquire the two hex keys from the configured source unless injected. The
  // source layer keeps keys out of shell history / config files on a Mac (macOS
  // Keychain or 1Password); default 'env' preserves the USER_MASTER_KEY /
  // SYSTEM_KEY behavior. resolveKeys() fails closed (clear error, no key value).
  if (userHex === undefined || systemHex === undefined) {
    const resolved = resolveKeys();
    userHex = userHex ?? resolved.userHex;
    systemHex = systemHex ?? resolved.systemHex;
  }
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
  const { domains, deferred, searchHelpers } = buildDomains({ db, userId, embedder });
  const { tools, handlers } = collectTools(domains);
  const server = createMcpServer({ tools, handlers });
  // handlers is returned so non-MCP transports (REST) can reuse the SAME
  // tool handler map without re-implementing tool logic. userId is returned so
  // HTTP ingestion routes (upload) can scope writes without re-deriving it.
  return { server, db, close, tools, handlers, deferred, userId, searchHelpers };
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

async function startEnrich() {
  // Lazy import so stdio/http paths never load the enrichment server.
  // MYCELIUM_ENRICH_PORT overrides the default :8095 (the port the ingestion
  // enqueue nudge targets); leave unset in production.
  const { startEnrichmentServer } = await import('./enrich/server.js');
  const port = process.env.MYCELIUM_ENRICH_PORT
    ? Number(process.env.MYCELIUM_ENRICH_PORT) : undefined;
  const { url } = await startEnrichmentServer(port !== undefined ? { port } : {});
  console.error(`[mycelium] enrichment service on ${url} — POST /enrich-all, GET /health`);
}

async function startPublic() {
  // Lazy import so other paths never load the public server. Serves ONLY
  // explicitly published/unlisted docs (fail-closed) — point your domain/tunnel
  // at MYCELIUM_PUBLIC_HOST:MYCELIUM_PUBLIC_PORT (default 127.0.0.1:8788).
  const { startPublicServer } = await import('./publish/public-server.js');
  const port = Number(process.env.MYCELIUM_PUBLIC_PORT ?? 8788);
  const host = process.env.MYCELIUM_PUBLIC_HOST ?? '127.0.0.1';
  const { url, identity } = await startPublicServer({ port, host });
  console.error(`[mycelium] PUBLIC surface on ${url} — published/unlisted docs only (handle: ${identity.handle ?? 'unset'})`);
}

// Run only when invoked directly (not when imported by a verifier).
if (import.meta.url === `file://${process.argv[1]}`) {
  let run = startStdio;
  if (process.argv.includes('--enrich') || process.env.MYCELIUM_ENRICH === '1') {
    run = startEnrich;
  } else if (process.argv.includes('--public') || process.env.MYCELIUM_PUBLIC === '1') {
    run = startPublic;
  } else if (process.argv.includes('--http') || process.env.MYCELIUM_HTTP === '1') {
    run = startHttp;
  }
  run().catch((err) => { console.error('[mycelium] fatal:', err.message); process.exit(1); });
}
