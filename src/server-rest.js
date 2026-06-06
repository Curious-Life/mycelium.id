import express from 'express';
import path from 'node:path';
import { existsSync, mkdirSync, cpSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { boot } from './index.js';
import { dataDir, dbPath as resolveDbPath, kcvPath as resolveKcvPath } from './paths.js';
import { resolveKeys } from './crypto/key-source.js';
import { applyMigrations } from './db/migrate.js';
import { apiRouter } from './api.js';
import { portalCompatRouter } from './portal-compat.js';
import { portalMindscapeRouter } from './portal-mindscape.js';
import { portalMeasurementRouter } from './portal-measurement.js';
import { portalClaimsRouter } from './portal-claims.js';
import { portalUploadsRouter } from './portal-uploads.js';
import { portalProvidersRouter } from './portal-providers.js';
import { portalHardwareRouter } from './portal-hardware.js';
import { createOllamaDaemon } from './hardware/ollama-daemon.js';
import { portalImportRouter } from './portal-import.js';
import { portalSettingsRouter } from './portal-settings.js';
import { portalConnectorsRouter } from './portal-connectors.js';
import { registerBuiltinAdapters, createConnectorRunner, startConnectorScheduler } from './connectors/index.js';
import { authShimRouter } from './auth-shim.js';
import { accountRouter } from './account/router.js';
import { remoteRouter } from './remote/router.js';
import { createEnqueueEnrichment } from './ingest/enqueue.js';
import { startEnrichDrainer } from './enrich/drainer.js';
import { startClaimHeartbeat } from './claims/heartbeat.js';
import { startClaimDiscoveryJob, isClusteringRunning } from './jobs.js';
import { startEmbedSupervisor } from './embed/supervisor.js';
import { setSessionKeys } from './account/session-keys.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CANONICAL_BUILD = path.join(HERE, '..', 'portal-app', 'build');
const LEGACY_PORTAL = path.join(HERE, '..', 'portal');

/**
 * Resolve which portal to serve. The canonical SvelteKit app
 * (portal-app/build — the real UI, see portal-app/README.md) is preferred when
 * it's been built; otherwise we serve the single-file SPA in portal/.
 *
 * mode: 'auto' (default) | 'canonical' | 'legacy'. Set per-call or via the
 * MYCELIUM_PORTAL env var. Resolved at call time (not import) so tests/CLI can
 * pick a mode deterministically. Returns { dir, spaFallback|null }.
 */
function resolvePortal(mode = process.env.MYCELIUM_PORTAL || 'auto') {
  const canonicalFallback = path.join(CANONICAL_BUILD, '200.html');
  const canonicalBuilt = existsSync(canonicalFallback);
  const useCanonical = mode === 'canonical' || (mode !== 'legacy' && canonicalBuilt);
  if (useCanonical && canonicalBuilt) {
    return { dir: CANONICAL_BUILD, spaFallback: canonicalFallback };
  }
  return { dir: LEGACY_PORTAL, spaFallback: null };
}

/**
 * One-time, NON-DESTRUCTIVE relocation of a legacy in-repo vault into the
 * durable data dir. The vault used to live at ./data/mycelium.db inside the
 * bundle (wiped on every app update); dataDir() now points at the OS app-data
 * dir (see src/paths.js). If the new dir has no vault yet but a legacy
 * ./data/mycelium.db exists, COPY the db (+ -wal/-shm), kcv.json and uploads/
 * across, then rename the legacy db aside (.migrated-<ts>) so this never runs
 * twice. Copy-not-move: the original bytes are preserved (just renamed). No-op
 * in dev (active dir IS ./data) or once already relocated. Idempotent.
 */
export function ensureDataDir({ env = process.env } = {}) {
  const dir = dataDir({ env });
  mkdirSync(dir, { recursive: true });

  const legacyDir = path.resolve('data');
  if (path.resolve(dir) === legacyDir) return; // dev: nothing to relocate

  const newDb = path.join(dir, 'mycelium.db');
  const legacyDb = path.join(legacyDir, 'mycelium.db');
  if (existsSync(newDb) || !existsSync(legacyDb)) return; // already moved, or no legacy vault

  const copyIfPresent = (from, to, opts) => { if (existsSync(from) && !existsSync(to)) cpSync(from, to, opts); };
  cpSync(legacyDb, newDb);                                   // main db
  for (const sfx of ['-wal', '-shm']) copyIfPresent(legacyDb + sfx, newDb + sfx); // consistent snapshot
  copyIfPresent(path.join(legacyDir, 'kcv.json'), path.join(dir, 'kcv.json'));
  copyIfPresent(path.join(legacyDir, 'uploads'), path.join(dir, 'uploads'), { recursive: true });

  renameSync(legacyDb, `${legacyDb}.migrated-${Date.now()}`); // never relocate again
  console.error(`[mycelium] relocated legacy vault ./data → ${dir} (original db renamed aside, not deleted)`);
}

/** Create the data dir + apply all migrations to the vault db (idempotent). Lets
 *  a fresh vault self-initialise on first boot — no separate `init-db` needed. */
function ensureVaultSchema(dbFile) {
  mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  try { applyMigrations(db); } finally { db.close(); }
}

/** Build the express sub-app that serves every VAULT-DEPENDENT route. Mounted
 *  behind a guard so it only handles traffic once the vault is open; until then
 *  data calls get a 503 and only the account ceremony + static UI are served. */
function buildVaultSubApp({ db, tools, handlers, userId, effectiveDbPath, enqueueEnrichment, connectorRunner }) {
  const v = express();
  v.disable('x-powered-by');
  v.use('/api/v1/portal', portalCompatRouter({ db, userId }));
  // S1 measurement REST bridge — auth-GATED, fail-closed (the rest of the V1
  // surface is unauthenticated/localhost-only; this surface decrypts the
  // sensitive measurement plane, so it resolves the owner ONLY for a genuine
  // local request and rejects anything proxied from a network. Pattern-B
  // loopback check (mirrors src/internal-metrics.js precedent): a request is
  // the owner iff its immediate socket peer is loopback AND no x-forwarded-for
  // header is present (genuine same-host requests never carry one).
  // Mounted BEFORE portalMindscapeRouter so the bridge's richer /trajectory/summary
  // (full headline numbers the vitality page reads) takes precedence over the
  // mindscape router's lightweight {phase,exploration_ratio} stub — the bridge
  // response is a superset, so MindscapeView's summary.phase read still works.
  v.use('/api/v1/portal', portalMeasurementRouter({
    db, userId,
    authenticatePortalRequest: (req) => {
      const ip = req.socket?.remoteAddress || '';
      const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (!loopback || req.headers['x-forwarded-for']) return null;
      return { id: userId };
    },
  }));
  v.use('/api/v1/portal', portalClaimsRouter({
    db, userId,
    authenticatePortalRequest: (req) => {
      const ip = req.socket?.remoteAddress || '';
      const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (!loopback || req.headers['x-forwarded-for']) return null;
      return { id: userId };
    },
  }));
  v.use('/api/v1/portal', portalMindscapeRouter({ db, userId, dbPath: effectiveDbPath }));
  v.use('/api/v1/portal', portalUploadsRouter({ db, userId, enqueueEnrichment }));
  v.use('/api/v1/portal', portalProvidersRouter({ db, userId }));
  // One lazy Ollama daemon controller, shared by the hardware routes; stopped in
  // closeHandle. dataDir = where we download the runtime + store its models (app-
  // private, survives .app replacement). Lazy: nothing fetches until a Pull & use.
  // (A daemon we spawn is also in our process group, so app exit reaps it
  // regardless — stop() is the graceful SIGTERM path.) Auto-download opt-out via
  // MYCELIUM_AUTO_OLLAMA=0.
  const hwOllamaDaemon = createOllamaDaemon({
    dataDir: dataDir(),
    autoInstall: process.env.MYCELIUM_AUTO_OLLAMA !== '0',
  });
  v.use('/api/v1/portal', portalHardwareRouter({ daemon: hwOllamaDaemon }));
  v.use('/api/v1/portal', portalImportRouter({ db, userId, enqueueEnrichment }));
  v.use('/api/v1/portal', portalSettingsRouter({ db, userId }));
  if (connectorRunner) v.use('/api/v1/portal', portalConnectorsRouter({ runner: connectorRunner }));
  v.use(apiRouter({ tools, handlers, db, userId, enqueueEnrichment }));
  return v;
}

/**
 * startRestServer({ dbPath, port, host }) — boot the shared assembly and
 * serve the tool handlers over REST.
 *
 * SECURITY (V1): there is NO auth on this surface yet (Phase 4 adds OAuth 2.1).
 * It therefore binds to localhost (127.0.0.1) by default and MUST NOT be
 * exposed to a network without an auth layer in front of it.
 *
 * Returns { app, server, db, url } where `server` is the live http.Server
 * and `url` is the bound base URL. Callers (CLI, tests) own shutdown via
 * server.close() + db.close().
 */
export async function startRestServer({
  dbPath,
  kcvPath,
  userHex,
  systemHex,
  userId,
  port = 0,
  host = '127.0.0.1',
  portalMode,
} = {}) {
  // Relocate a legacy in-repo vault into the durable data dir before anything
  // opens it — only for the default location (explicit-dbPath callers, e.g.
  // verify scripts, manage their own path).
  if (dbPath === undefined) ensureDataDir();

  // boot() reads keys from env by default; forward overrides when given
  // (verify scripts inject ephemeral keys) so undefined doesn't clobber env.
  const bootOpts = {};
  if (dbPath !== undefined) bootOpts.dbPath = dbPath;
  if (kcvPath !== undefined) bootOpts.kcvPath = kcvPath;
  if (userHex !== undefined) bootOpts.userHex = userHex;
  if (systemHex !== undefined) bootOpts.systemHex = systemHex;
  if (userId !== undefined) bootOpts.userId = userId;

  // Absolute, canonical vault + KCV paths so boot(), the clustering child
  // (spawned with MYCELIUM_DB) and the account/restore KCV check all agree.
  const effectiveDbPath = dbPath ? path.resolve(dbPath) : resolveDbPath();
  const effectiveKcvPath = kcvPath ? path.resolve(kcvPath) : resolveKcvPath();
  // The optional passphrase seal lives NEXT TO the KCV (same dir) in every mode,
  // so it's isolated in tests and sits durably beside the vault in the packaged app.
  const effectiveLockPath = path.join(path.dirname(effectiveKcvPath), 'vault-lock.json');
  bootOpts.kcvPath = effectiveKcvPath;

  // ── mutable boot context ──────────────────────────────────────────────────
  // vaultSubApp is null until the vault is open. completeBoot() opens it once
  // (idempotent) and is also called by the account router after setup/restore.
  let vaultSubApp = null;
  let dbHandle = null;
  let closeHandle = null;
  let booting = false;

  async function completeBoot(extraKeys = {}) {
    if (vaultSubApp || booting) return;
    booting = true;
    try {
      const opts = { ...bootOpts, ...extraKeys };
      // Resolve keys up front so we NEVER create an empty vault when there are
      // none (resolveKeys throws KeySourceError → caller stays in setup mode).
      if (opts.userHex === undefined || opts.systemHex === undefined) {
        const k = resolveKeys();
        opts.userHex = k.userHex;
        opts.systemHex = k.systemHex;
      }
      ensureVaultSchema(effectiveDbPath); // self-initialise a fresh vault (idempotent)
      const { tools, handlers, db, close, userId: bootUserId } = await boot(opts);
      dbHandle = db;
      // Pin both keys in memory so the clustering child (src/jobs.js) can obtain
      // them in passphrase-lock mode, where they are NOT in the Keychain.
      setSessionKeys({ userHex: opts.userHex, systemHex: opts.systemHex });
      const baseEnqueue = createEnqueueEnrichment({ userId: bootUserId });
      let enqueueEnrichment = baseEnqueue;
      closeHandle = close;
      // Real app launches (NOT verify scripts injecting keys) run the in-process
      // enrichment drainer so UI-imported messages embed against :8091 — on boot,
      // on a timer, and nudged on import. Without it nothing embeds and Generate
      // has no data. Gated off when keys are injected so it never mutates a
      // verify script's deterministic test vault.
      const injectedKeys = userHex !== undefined && systemHex !== undefined;
      let connectorScheduler = null;
      if (!injectedKeys) {
        // Own the embed-service (:8091) lifecycle in-process: spawn/adopt, dep
        // self-check, restart-on-crash, and expose health to /processing-status.
        // Without a live embedder the drainer can't embed → Generate has no data.
        const embedSup = startEmbedSupervisor({ home: process.cwd() });
        const drainer = startEnrichDrainer({ db, userId: bootUserId });
        enqueueEnrichment = (id) => { try { baseEnqueue(id); } catch { /* :8095 optional */ } drainer.nudge(); };
        // Persona-Claims cadence trigger: a zero-LLM hourly heartbeat that spawns
        // the discovery child when a day/week/month/quarter window rolls over (and
        // no clustering run is in flight). The child is Tier-3 fail-soft (no local
        // model → no-op). Gated with the drainer so verify scripts never run it.
        const claimsHeartbeat = startClaimHeartbeat({
          db, userId: bootUserId, isJobRunning: isClusteringRunning,
          spawn: (cadences) => startClaimDiscoveryJob({ dbPath: effectiveDbPath, userId: bootUserId, cadence: cadences.join(',') }),
        });
        closeHandle = () => {
          try { connectorScheduler?.stop(); } catch { /* */ }
          try { drainer.stop(); } catch { /* */ }
          try { claimsHeartbeat.stop(); } catch { /* */ }
          try { embedSup.stop(); } catch { /* */ }
          try { hwOllamaDaemon.stop(); } catch { /* */ }
          try { close(); } catch { /* */ }
        };
      }
      // Connector framework: register adapters once, build the runner (always —
      // the HTTP routes need it), and start the periodic sync scheduler only in
      // the real app. The scheduler is gated like the drainer so verify scripts
      // (injected keys) never sync a connector against a deterministic test vault.
      registerBuiltinAdapters();
      const connectorRunner = createConnectorRunner({ db, userId: bootUserId, enqueueEnrichment });
      // One-time migration of pre-2b `connector:<id>:state` secret blobs into the
      // dedicated connectors table (migration 0008). Idempotent; safe every boot.
      await connectorRunner.store.backfillLegacyState().catch((e) => {
        console.warn('[connectors] legacy state backfill skipped:', e?.message || e);
      });
      if (!injectedKeys) {
        connectorScheduler = startConnectorScheduler({ runner: connectorRunner });
      }
      vaultSubApp = buildVaultSubApp({ db, tools, handlers, userId: bootUserId, effectiveDbPath, enqueueEnrichment, connectorRunner });
    } finally {
      booting = false;
    }
  }

  // Tests/verify inject keys → the vault MUST open (rethrow on failure). A normal
  // app launch reads keys from the source; if they're missing or the vault won't
  // open, fall back to SETUP MODE so the UI can create or restore it.
  const keysInjected = userHex !== undefined && systemHex !== undefined;
  if (keysInjected) {
    await completeBoot();
  } else {
    try {
      await completeBoot();
    } catch (err) {
      console.error(`[mycelium] vault not opened — entering setup mode (${err?.message || err})`);
    }
  }
  const resolvedUserId = userId || process.env.MYCELIUM_USER_ID || 'local-user';

  const app = express();
  app.disable('x-powered-by');

  // Account ceremony — ALWAYS mounted (this is what setup mode serves): create
  // the vault, restore from a recovery key, or re-view the key. Mounted before
  // the vault guard so /api/v1/account/* is never 503'd.
  app.use('/api/v1/account', accountRouter({
    isInitialized: () => Boolean(vaultSubApp),
    completeBoot,
    kcvPath: effectiveKcvPath,
    lockFile: effectiveLockPath,
  }));

  // Remote-access control surface (loopback-only): set the operator password
  // (the OAuth gate) + read/patch the non-secret remote config. Mounted before
  // the vault guard so it works in setup mode AND post-boot.
  app.use('/api/v1/remote', remoteRouter());

  // Local "always signed in" shim so the canonical portal's session check
  // (/auth/session) succeeds and the app opens instead of bouncing to /login.
  app.use('/auth', authShimRouter({ userId: resolvedUserId }));

  // Vault-dependent routes: delegate to the sub-app once the vault is open. Until
  // then, DATA calls get a clear 503 while the static UI still loads (so the
  // first-run /setup screen renders). A booted sub-app that doesn't match a route
  // calls next(), so static assets + the SPA fallback below still work.
  const isVaultDataPath = (p) => p.startsWith('/api/') || p.startsWith('/ingest/') || p.startsWith('/portal/');
  app.use((req, res, next) => {
    if (vaultSubApp) return vaultSubApp(req, res, next);
    if (isVaultDataPath(req.path)) {
      return res.status(503).json({ error: 'vault_not_initialized', message: 'Your vault is not set up yet.' });
    }
    return next();
  });

  // Portal UI (static + SPA fallback) — always, so /setup and the app shell load.
  // client-side routes (/library, /mindscape, /setup, …) have no file on disk, so
  // fall back to 200.html for NAVIGATION requests only — GET, accepts html, not
  // under a data prefix, extensionless (a missing asset like /x.js still 404s).
  const { dir: portalDir, spaFallback } = resolvePortal(portalMode);
  app.use(express.static(portalDir));
  if (spaFallback) {
    // /api, /ingest, /portal, /auth are data paths — never shadow them with the
    // SPA shell (so unmatched data calls 404 cleanly instead of returning HTML).
    // Exclude both `/api/…` and a bare `/api` (the `(?:\/|$)` guard).
    app.get(/^\/(?!(?:api|ingest|portal|auth)(?:\/|$))(?:[^.]*)$/, (req, res, next) => {
      if (req.method !== 'GET' || !req.accepts('html')) return next();
      res.sendFile(spaFallback);
    });
  }

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.on('error', reject);
  });

  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host}:${boundPort}`;

  return {
    app, server, url, port: boundPort, host,
    get db() { return dbHandle; },
    close: () => closeHandle?.(),
  };
}

/**
 * main() — CLI entrypoint for `node src/server-rest.js` (or `--rest`).
 * Reads MYCELIUM_REST_PORT / MYCELIUM_REST_HOST; defaults localhost:8787.
 */
async function main() {
  const port = Number(process.env.MYCELIUM_REST_PORT ?? 8787);
  const host = process.env.MYCELIUM_REST_HOST ?? '127.0.0.1';
  const { url, server, close } = await startRestServer({ port, host });
  process.stderr.write(`mycelium portal + REST on ${url} (open in a browser; localhost-only, no auth — Phase 4)\n`);

  const shutdown = () => {
    server.close(() => {
      try { close?.(); } finally { process.exit(0); }
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
const restFlag = process.argv.includes('--rest');
if (invokedDirectly || restFlag) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${String(err?.message ?? err)}\n`);
    process.exit(1);
  });
}
