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
import { maybeScheduleIntegrityCheck, armPeriodicIntegrityCheck } from './db/integrity.js';
import { startSnapshotSchedule } from './db/snapshot-schedule.js';
import { armVaultCopy } from './db/vault-copy.js';
import { bindStdioLifetime } from './db/mcp-lifetime.js';
import { claimVaultOwnership, bindBoundedShutdown } from './db/vault-lease.js';
import { initVaultStorage } from './db/init.js';
import { resolveDbKeyHex, atRestEnabled, vaultIsEncrypted } from './db/open.js';
import { purgePlaintextBackup } from './account/db-cipher-migrate.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIdentity } from './identity/identity.js';
// The ONE authoritative read of the vault's handle (derived from publicHost).
import { currentHandle } from './identity/handle-service.js';
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
  onPhase = null, // D-130: boot-phase reporter ('snapshot'|'migrating') for /account/status honesty
  // Real-app launches set this so the full corpus build runs in a spawned child
  // (search/build-child.js) instead of starving this serving thread for minutes
  // on a large vault. Verify scripts leave it off and keep the lazy in-process
  // build against their deterministic fixtures.
  searchChildBuild = false,
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
    // D-080 (aggravating factor): an INHERITED ENCRYPTION_MASTER_KEY must never
    // silently outrank the configured source. crypto-local's getMasterKey() falls
    // back to this env var and pins it as `source=env-deprecated` — so a dev key
    // left in the environment becomes the key a production boot writes with. It
    // is cleared here, BEFORE resolution, whenever the configured source is not
    // 'env': line 99 below re-sets it from the key we actually resolved, so the
    // env var can only ever mirror the authoritative source, never replace it.
    const configuredSource = (process.env.MYCELIUM_KEY_SOURCE || 'env').trim().toLowerCase();
    if (configuredSource !== 'env' && process.env.ENCRYPTION_MASTER_KEY) {
      delete process.env.ENCRYPTION_MASTER_KEY;
      console.error(`[mycelium] ignoring an inherited ENCRYPTION_MASTER_KEY — keys come from '${configuredSource}' (D-080)`);
    }
    const resolved = resolveKeys();
    userHex = userHex ?? resolved.userHex;
    systemHex = systemHex ?? resolved.systemHex;
  }
  if (!userHex || !systemHex) {
    throw new Error('USER_MASTER_KEY and SYSTEM_KEY must be set (64-char hex each). Vault stays locked.');
  }
  // dbPath is load-bearing here (D-080): it is what stops a fresh KCV being
  // minted beside a vault this key has not been proven against.
  const { userKey, systemKey } = await unlock({ userHex, systemHex, kcvPath, dbPath });
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
  // 0600 tmpfs file (env never set).
  process.env.ENCRYPTION_MASTER_KEY = userHex;

  // Box identity (Tier-0 federation): one ed25519 identity from the master key,
  // bound to the public host when remote access is configured. publicHost is the
  // full did:web host (e.g. alice.mycelium.id, incl. custom domains); handle is
  // its first label, validated. When remote is off both are null → the
  // federation surfaces fail closed (did.json 404, /federation/connect 503).
  const publicHost = readRemoteConfig().publicHost || '';
  // ONE derivation, shared with every other reader (src/identity/handle-service.js).
  const handle = currentHandle();
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
  // The open-only branch (public server) still needs the foreign-WAL guard: it opens
  // the SAME canonical vault, and `npm run public` launched first after a bad manual
  // swap would otherwise replay a stale previous-generation WAL exactly as before the
  // guard existed (independent review, finding 4). The guard is cheap (a stat + a
  // 16-byte read), quarantines only on proof, and its unguardable failure mode throws —
  // which is the correct fail-closed outcome for this path too.
  // ── VAULT OWNERSHIP ────────────────────────────────────────────────────────────────
  // "If the app is closed, we should not let other processes write to the db." Before
  // ANYTHING opens this vault write-capable, establish that we are entitled to: either we
  // take ownership (a standalone entry point — the app, `npm start`, a headless self-host,
  // a verify gate against its own fixture), or we inherit it from a live owner of our own
  // family (the app's second node sibling, a pipeline child). A spawned child whose app has
  // died gets neither and stops here.
  //
  // No-op on a non-canonical vault, which is why the ~104 fixture-based gates need no
  // changes and no new escape hatch. @see src/db/vault-lease.js, and
  // the vault-ownership design for why this is a kernel lock and not a pidfile.
  const vaultLease = claimVaultOwnership({ dbPath, log: (m) => console.error(m) });

  if (!initStorage) {
    const { guardAgainstForeignWal } = await import('./db/wal-guard.js');
    const { recordDurabilityEvent } = await import('./db/durability-log.js');
    guardAgainstForeignWal(dbPath, {
      log: (m) => console.error(m),
      onEvent: (e) => recordDurabilityEvent(e.kind, e),
    });
  }
  // A vault this box previously condemned is SUSPECT, not condemned forever.
  //
  // The first version of this threw unconditionally when `.vault-corrupt` existed. That was
  // a permanent lockout, and three independent reviews caught it: NOTHING clears the marker
  // — `install-vault.mjs` does not touch it, and `integrity.js:83` (which does) is scheduled
  // ~40 lines AFTER this point, so a refusing boot can never reach the code that would clear
  // it. Worse, `scripts/` is not in the app bundle at all (verified against
  // Contents/Resources/app), so every message pointing a user at `scripts/vault-repair/`
  // named a directory that does not exist on their machine. Net effect: repair the vault
  // successfully, and the app still refuses — forever, with no in-product way out. That is
  // strictly worse than the silent degradation this whole change set set out to fix.
  //
  // So the marker now means "prove yourself": run the integrity check the marker is asking
  // for. Clean → clear it and carry on (a repaired or restored vault self-heals, which is
  // exactly what should happen after install-vault.mjs). Still damaged → refuse, with the
  // damage as the reason rather than a stale file. quick_check costs ~24 s on a 2 GB vault,
  // which is only ever paid on a vault already flagged as suspect — correctness beats speed
  // on that path. @see the vault-durability architecture design.
  if (process.env.MYCELIUM_IGNORE_VAULT_HALT !== '1') { // same test as vault-halt.js bypassed()
    const { readVaultCorruptMarker, clearVaultCorruptMarker, verifyVaultIntegritySync, decideMarkerAction } =
      await import('./db/vault-halt.js');
    const mark = readVaultCorruptMarker(dbPath);
    if (mark) {
      // KEY ONLY IF THE FILE IS ACTUALLY ENCRYPTED. resolveDbKeyHex returns a derived key
      // whenever at-rest is enabled — which the real launch guard always sets — but this
      // gate runs BEFORE the plaintext→cipher migration, so a still-plaintext vault would
      // be opened WITH a key, answer SQLITE_NOTADB, and refuse forever.
      const keyForCheck = vaultIsEncrypted(dbPath) ? resolveDbKeyHex(userHex, dbPath) : null;
      const verdict = verifyVaultIntegritySync(dbPath, keyForCheck);

      // THE DECISION IS A PURE, TOTAL FUNCTION — see decideMarkerAction's header. This
      // block used to be a chain of if/else, and six review rounds each found an unhandled
      // combination that fell into a permissive branch. Boot now only EXECUTES the decision,
      // so the state space can be enumerated and covered by a table instead of by judgement.
      const decision = decideMarkerAction({ mark, verdict, dbFile: path.basename(dbPath) });
      const when = mark.at || 'an earlier boot';

      if (decision.clearMarker) clearVaultCorruptMarker(dbPath);

      if (decision.action === 'REFUSE') {
        const err = new Error(
          `this vault was flagged as damaged at ${when} and ${decision.why} (${verdict.reason}). `
          + `Refusing to open it rather than risk writing to a damaged file — nothing has been modified. `
          + `Restore a snapshot from the snapshots folder beside your vault, or run the vault-repair tools `
          + `against a copy. To start over deliberately, delete the vault file. `
          + `Set MYCELIUM_IGNORE_VAULT_HALT=1 only for recovery tooling that knowingly owns the box.`,
        );
        err.code = 'vault_corrupt';
        err.markerDecision = decision.kind;
        throw err;
      }

      console.error(
        `[mycelium] vault was flagged corrupt at ${when}: ${decision.why}`
        + `${decision.clearMarker ? ' — clearing the flag and continuing.' : ' — continuing; the flag names another vault and is left in place.'}`,
      );
    }
  }

  const dbKeyHex = initStorage
    ? await initVaultStorage({ dbPath, userHex, log: (m) => console.error(m), onPhase })
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
  // Early corruption detection (defense-in-depth): a DETACHED, throttled (default 6 h,
  // MYCELIUM_INTEGRITY_INTERVAL_H), read-only quick_check on the CANONICAL vault only.
  // Fire-and-forget — never blocks boot (the scan is ~24 s on a 2 GB vault, so it must
  // not run in-process). Fixtures / pipeline temp DBs are skipped. D-140: also re-armed
  // hourly for long uptimes — the 08-05 damage sat ~9 h undetected inside one uptime.
  // @see src/db/integrity.js.
  maybeScheduleIntegrityCheck({ dbPath, userHex, isCanonical: isCanonicalVault });
  armPeriodicIntegrityCheck({ dbPath, userHex, isCanonical: isCanonicalVault });
  // ROLLING SNAPSHOTS. snapshot-on-boot.js covers the pre-MIGRATION moment and stops
  // there — its trigger is "migration set changed OR no snapshot at all", so a settled
  // vault takes one baseline and never another. That is how a production vault reached
  // 2026-07-26 with nothing to restore from. Bounding damage is the halt latch's job;
  // being able to go back a day is this one's. Detached + unref'd: never blocks a boot,
  // never holds the process open, and refuses outright on a vault already marked corrupt
  // (a timer that keeps copying a damaged file rotates every good snapshot away).
  // @see src/db/snapshot-schedule.js, the vault fail-stop design.
  if (isCanonicalVault) {
    startSnapshotSchedule({ dbPath, dbKeyHex, isCanonical: true, log: (m) => console.error(m) });
    armVaultCopy({ dbPath, dbKeyHex }); // D-130: lets jobs.js take off-loop consistent copies without key plumbing
  }
  const { domains, deferred, searchHelpers, isTopologyReady } = buildDomains({ db, userId, embedder, identity, childBuild: searchChildBuild });
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
  // Release the vault lease when the caller closes the vault. The KERNEL releases the
  // lock itself on exit — crash, SIGKILL, panic — so this is only for an orderly
  // shutdown that keeps the process alive afterwards (tests, a re-boot in one process).
  const closeAll = () => { try { close(); } finally { vaultLease.release(); } };
  return { server, db, close: closeAll, tools, handlers, deferred, userId, identity, publicHost, handle, searchHelpers, isTopologyReady };
}

async function startStdio() {
  const { server, tools, deferred, close } = await boot({ searchChildBuild: true });
  // A stdio MCP server's lifetime IS its stdin. Nothing was listening: observed on a real
  // machine, a Claude-Code-spawned `node src/index.js` had been holding a vault open
  // read/write for 2 h 54 m with its session long gone. 171 worktrees × 12 worktree vaults
  // is a lot of orphans waiting to happen, and an orphan from a STALE worktree carries a
  // divergent migration lineage — mechanism #1 in the 2026-07-16 root cause, and the one
  // case the stress harness cannot model because it runs a single build.
  // @see src/db/mcp-lifetime.js.
  // stderr only — never write non-protocol bytes to stdout on stdio transport.
  console.error(`[mycelium] ${tools.length} tools registered; ${deferred.length} deferred (${deferred.join(', ')})`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // AFTER connect, never before: the transport attaches its own stdin handler inside
  // start(), and resuming the stream earlier discards bytes already in flight — the
  // `initialize` request among them.
  bindStdioLifetime({ close, label: 'stdio MCP' });
  console.error('[mycelium] stdio MCP server connected.');
}

async function startHttp() {
  // Lazy import so the stdio path never loads express/better-auth.
  const { startHttpServer } = await import('./server-http.js');
  // SIGTERM DOES NOT RUN EXIT HANDLERS, and SIGTERM is how the Tauri shell quits this
  // sibling. Without this it never seals the vault — and since which sibling OWNS the lease
  // is a startup race, that made the branch's headline claim false about half the time.
  // I added this once, deleted it when the shell briefly owned sealing, and failed to
  // restore it when sealing came back to node. @see src/db/vault-lease.js.
  const httpServer = await startHttpServer();
  // ⚠️ THIS IS THE ONLY ONE THE TAURI SHELL ACTUALLY SPAWNS (main.rs:803) — the :4711
  // remote MCP/OAuth surface, with streaming sessions and long-running tool calls, i.e. the
  // MOST in-flight work of any entry point. It had an IMMEDIATE process.exit() and got 0 ms
  // to drain, while --enrich and --public (which the shell does not spawn at all) got
  // 2500 ms. My previous commit claimed "every http entry point" and this was not one of
  // them; the same commit's own comment described the defect it was shipping here.
  //
  // No vault `close` at this level is correct, not an omission: server-http.js calls boot()
  // PER MCP SESSION, so there is no single handle to close. The seal still happens — the
  // exit handler carries leaveVault().
  bindBoundedShutdown({ server: httpServer, log: (m) => console.error(m) });
}

async function startEnrich() {
  // ⚠️ FOUR ENTRY POINTS BOOT THE VAULT AND I WIRED THE SEAL INTO ONE. --enrich and
  // --public both claim ownership (unlock + presence) and had no signal handler at all, so
  // SIGTERM left the vault UNLOCKED WITH NOBODY OWNING IT — measured, mode 600 with a stale
  // presence file. That is precisely the state Layer B exists to prevent.
  // Lazy import so stdio/http paths never load the enrichment server.
  // MYCELIUM_ENRICH_PORT overrides the default :8095 (the port the ingestion
  // enqueue nudge targets); leave unset in production.
  const { startEnrichmentServer } = await import('./enrich/server.js');
  const port = process.env.MYCELIUM_ENRICH_PORT
    ? Number(process.env.MYCELIUM_ENRICH_PORT) : undefined;
  const { url, server, close } = await startEnrichmentServer(port !== undefined ? { port } : {});
  // DRAIN, then seal — the same bounded shutdown both http servers use. An immediate
  // process.exit() here would seal correctly but cut in-flight enrichment work dead; this
  // gives it the budget and still exits well inside the shell's 6 s grace.
  bindBoundedShutdown({ server, close, log: (m) => console.error(m) });
  console.error(`[mycelium] enrichment service on ${url} — POST /enrich-all, GET /health`);
}

async function startPublic() {
  // Lazy import so other paths never load the public server. Serves ONLY
  // explicitly published/unlisted docs (fail-closed) — point your domain/tunnel
  // at MYCELIUM_PUBLIC_HOST:MYCELIUM_PUBLIC_PORT (default 127.0.0.1:8788).
  const { startPublicServer } = await import('./publish/public-server.js');
  const port = Number(process.env.MYCELIUM_PUBLIC_PORT ?? 8788);
  const host = process.env.MYCELIUM_PUBLIC_HOST ?? '127.0.0.1';
  const { url, identity, server, close } = await startPublicServer({ port, host });
  // @see startEnrich. Running this module DIRECTLY already binds the same bounded shutdown
  // (public-server.js main()); binding it here too means the `--public` MODE behaves
  // identically instead of exiting instantly without draining. Two paths to one server that
  // shut down differently is how the unbounded version survived a commit that fixed it.
  bindBoundedShutdown({ server, close, log: (m) => console.error(m) });
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
