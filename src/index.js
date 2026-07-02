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
import { maybeScheduleIntegrityCheck } from './db/integrity.js';
import { initVaultStorage } from './db/init.js';
import { resolveDbKeyHex, atRestEnabled } from './db/open.js';
import { purgePlaintextBackup } from './account/db-cipher-migrate.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIdentity, isValidHandle } from './identity/identity.js';
import { readRemoteConfig } from './remote/config.js';
import { buildDomains, collectTools, createMcpServer, TIER2_TOOLS, TOPOLOGY_NOT_READY_MESSAGE } from './mcp.js';
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
  // initStorage: apply schema + run the at-rest migration (key-aware, locked) on
  // open. Default true — the app + MCP + pipeline self-initialise the vault. The
  // PUBLIC server passes false: it is a read-only serving surface that must FAIL
  // CLOSED on a wrong/old schema (e.g. missing publish_nonce), never auto-repair
  // it by re-applying migrations. It still opens an encrypted vault keyed
  // (resolveDbKeyHex self-detects) — just without touching the schema.
  initStorage = true,
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
  // must run before buildDomains (the first encrypt/decrypt path). NOTE: this
  // puts the hex in process.env. The keychain/1Password source only protects the
  // key AT REST (shell history, config files), NOT at runtime; once boot() runs
  // the key is in env for the process lifetime (clearMasterKeyFromEnv() can't run
  // here — mind-files/identity/blob/publish/remote read it lazily). For the
  // PRIMARY deployment — a single-user LOCAL install — this is an accepted
  // same-user-trust boundary: CLAUDE.md §4 ("never in env") came from the
  // multi-tenant VPS repo and its shared-host threat model doesn't apply. Every
  // child spawn uses an env allowlist, so the key never leaks to the embed/
  // transcribe/channel services. A shared/multi-tenant host would harden with a
  // 0600 tmpfs file (env never set): docs/SECURITY-FOLLOWUP-KEY-IN-ENV-2026-06-11.md.
  process.env.ENCRYPTION_MASTER_KEY = userHex;

  // Box identity (Tier-0 federation): one ed25519 identity from the master key,
  // bound to the public host when remote access is configured. publicHost is the
  // full did:web host (e.g. alice.mycelium.id, incl. custom domains); handle is
  // its first label, validated. When remote is off both are null → the
  // federation surfaces fail closed (did.json 404, /federation/connect 503).
  const publicHost = readRemoteConfig().publicHost || '';
  const handleCandidate = publicHost ? publicHost.split('.')[0] : null;
  const handle = handleCandidate && isValidHandle(handleCandidate) ? handleCandidate : null;
  const identity = createIdentity({ masterHex: userHex, handle });
  const federationDeps = {
    sign: handle ? (canonical) => identity.sign(canonical) : undefined,
    did: publicHost ? () => `did:web:${publicHost}` : undefined,
    selfInstance: () => publicHost,
    // E2E shared-spaces seam: the full identity (X25519 keyAgreement + Ed25519 sign) +
    // the owner DID. Gated on publicHost so E2E space sharing is off until remote is set.
    identity,
    selfDid: publicHost ? `did:web:${publicHost}` : null,
  };

  // At-rest blindness (A′). initVaultStorage applies the schema (key-aware) and,
  // when at-rest is opted in (MYCELIUM_AT_REST), migrates a still-plaintext vault
  // to whole-file cipher — ALL under a cross-process lock so the several node
  // processes the app spawns (server-rest, index.js --http, the stdio MCP server,
  // pipeline children) can NEVER race on the one-time migration. It returns the
  // key getDb opens with: set when the vault is encrypted (self-detected, so a
  // Finder launch / MCP server opens it without the env flag) or at-rest is on;
  // null for a plaintext vault with at-rest off → plaintext open, unchanged.
  // FAIL CLOSED inside initVaultStorage: a migration error refuses a plaintext open.
  //
  // AT-REST DEFAULT-ON IS WIRED AT THE ENTRY POINT, NOT HERE. The SQLCipher Stage B/C
  // collapse removed per-field content encryption, so whole-file SQLCipher is now the
  // ONLY at-rest defense — and the documented self-host launch (`node src/index.js` /
  // `npm start`, connect.md) + `cargo tauri dev` carry no MYCELIUM_AT_REST. The real
  // launch opts in from the `import.meta.url === argv1` main guard below (the packaged
  // app already sets the flag). It MUST NOT be done here: boot() is called as a library
  // by the ~104 verify gates AND the pipeline subprocesses (compute-*.js → import boot),
  // many of which set MYCELIUM_DB to a temp fixture — keying off the path/MYCELIUM_DB
  // would born-encrypt those plaintext fixtures (it did: it broke verify:vitality + 28
  // other gates). Entry-point gating keeps Design D5 intact: importers never trip it.
  const dbKeyHex = initStorage
    ? await initVaultStorage({ dbPath, userHex, log: (m) => console.error(m) })
    : resolveDbKeyHex(userHex, dbPath); // open-only (e.g. public server): no schema apply, fail-closed

  // FAIL CLOSED (belt to the default-on suspenders): once at-rest is enabled — the real
  // launch sets it below, the packaged app sets it, or the vault self-detects as already
  // encrypted — the vault must NEVER open UNKEYED, since content carries no field
  // envelope after the collapse. Refuse rather than open plaintext / fail obscurely.
  // (Plaintext test fixtures with at-rest off: atRestEnabled()=false → unaffected.)
  if (atRestEnabled() && !dbKeyHex) {
    throw new Error('REFUSE: at-rest is enabled but the vault would open UNKEYED — content is not field-encrypted after the SQLCipher collapse, so whole-file at-rest (USER_MASTER → dbKey) is required. Set USER_MASTER or derive the DB key.');
  }
  const { db, close } = getDb({ dbPath, userKey, systemKey, federationDeps, dbKeyHex });
  // Stage 0 (SQLCipher-mandatory): the at-rest migration leaves a full PLAINTEXT
  // copy at <db>.pre-cipher-<ts>. Once the REAL vault is open + keyed, remove it —
  // a plaintext backup on disk would defeat at-rest encryption. purgePlaintextBackup
  // is self-verifying (re-opens keyed + reads before deleting; keeps the backup on
  // any doubt). Scoped to the canonical vault so test fixtures (which pass a temp
  // dbPath and assert the backup is kept) are never touched.
  const isCanonicalVault = path.resolve(dbPath) === resolveDbPath();
  if (dbKeyHex && isCanonicalVault) {
    try { purgePlaintextBackup({ dbPath, dbKeyHex, log: (m) => console.error(m) }); }
    catch (e) { console.error(`[mycelium] at-rest: backup purge skipped (${e?.message || e})`); }
  }
  // Early corruption detection (defense-in-depth): a DETACHED, throttled (once/day),
  // read-only quick_check on the CANONICAL vault only. Fire-and-forget — never blocks
  // boot (the scan is ~24 s on a 2 GB vault, so it must not run in-process). Fixtures /
  // pipeline temp DBs are skipped. @see src/db/integrity.js.
  maybeScheduleIntegrityCheck({ dbPath, userHex, isCanonical: isCanonicalVault });
  const { domains, deferred, searchHelpers, isTopologyReady } = buildDomains({ db, userId, embedder, identity });
  // Cold-start gating (Phase 4): Tier-2 readers return a uniform "not ready"
  // message until the topology pipeline has run, instead of honest-empty.
  const { tools, handlers } = collectTools(domains, {
    isReady: isTopologyReady,
    gatedTools: TIER2_TOOLS,
    message: TOPOLOGY_NOT_READY_MESSAGE,
  });
  const server = createMcpServer({ tools, handlers });
  // handlers is returned so non-MCP transports (REST) can reuse the SAME
  // tool handler map without re-implementing tool logic. userId is returned so
  // HTTP ingestion routes (upload) can scope writes without re-deriving it.
  return { server, db, close, tools, handlers, deferred, userId, identity, publicHost, handle, searchHelpers, isTopologyReady };
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

// Run only when invoked directly (not when imported by a verifier). Compare decoded
// FS paths — `file://${argv[1]}` keeps a raw space but import.meta.url percent-encodes
// it, so a bundle path WITH A SPACE ("Mycelium Dev.app") never matched.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // AT-REST DEFAULT-ON (SQLCipher collapse): content lost its per-field envelope, so the
  // REAL server launch must default to whole-file at-rest — the documented self-host path
  // (`node src/index.js` / `npm start`) and `cargo tauri dev` carry no MYCELIUM_AT_REST.
  // This is entry-point-gated (we are argv1, not an importer), so the verify gates +
  // pipeline subprocesses that `import { boot }` as a library are untouched (Design D5).
  // The packaged app already sets the flag; setting it again here is a harmless no-op.
  // boot() then born-encrypts a fresh vault / migrates an existing plaintext one, and the
  // fail-closed belt refuses an unkeyed open. Spawned children inherit it via env.
  if (!atRestEnabled()) process.env.MYCELIUM_AT_REST = '1';
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
