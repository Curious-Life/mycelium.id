import express from 'express';
import path from 'node:path';
import { existsSync, mkdirSync, cpSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { boot } from './index.js';
import { dataDir, dbPath as resolveDbPath, kcvPath as resolveKcvPath, uploadsRoot as resolveUploadsRoot, remoteConfigPath as resolveRemoteConfigPath } from './paths.js';
import { resolveKeys } from './crypto/key-source.js';
import { applyMigrations } from './db/migrate.js';
import { apiRouter } from './api.js';
import { internalRouter } from './internal-router.js';
import { portalCompatRouter } from './portal-compat.js';
import { portalMindscapeRouter } from './portal-mindscape.js';
import { portalMeasurementRouter } from './portal-measurement.js';
import { portalClaimsRouter } from './portal-claims.js';
import { portalUploadsRouter } from './portal-uploads.js';
import { portalAttachmentsRouter } from './portal-attachments.js';
import { portalProvidersRouter } from './portal-providers.js';
import { portalHardwareRouter } from './portal-hardware.js';
import { createOllamaDaemon } from './hardware/ollama-daemon.js';
import { portalImportRouter } from './portal-import.js';
import { portalSettingsRouter } from './portal-settings.js';
import { portalChatRouter } from './portal-chat.js';
import { portalActivityRouter } from './portal-activity.js';
import { portalUsageRouter } from './portal-usage.js';
import { portalTranscriptionRouter } from './portal-transcription.js';
import { ensureTranscribeSupervisor } from './transcribe/supervisor.js';
import { detectHardware } from './hardware/detect.js';
import { portalChannelsRouter } from './portal-channels.js';
import { portalConnectorsRouter } from './portal-connectors.js';
import { registerBuiltinAdapters, createConnectorRunner, startConnectorScheduler } from './connectors/index.js';
import { authShimRouter } from './auth-shim.js';
import { accountRouter } from './account/router.js';
import { remoteRouter } from './remote/router.js';
import { createEnqueueEnrichment } from './ingest/enqueue.js';
import { startEnrichDrainer } from './enrich/drainer.js';
import { startClaimHeartbeat } from './claims/heartbeat.js';
import { startClaimDiscoveryJob, isClusteringRunning, startClusteringJob, shouldAutoGenerate } from './jobs.js';
import { startEmbedSupervisor } from './embed/supervisor.js';
import { startChannelSupervisor } from './channels/supervisor.js';
import { mcpLoopbackRouter } from './mcp-loopback.js';
import { matrixConfig } from './remote/config.js';
import { createSpaceSync } from './federation/space-sync.js';
import { createMatrixEgress } from './federation/matrix-egress.js';
import { createMatrixClient } from './federation/matrix-client.js';
import { resolveMatrixService } from './federation/did.js';
import { setSessionKeys } from './account/session-keys.js';
import { isTrustedLoopback } from './http/loopback.js';
import { createVaultAuthMiddleware, csrfCookieMiddleware, isAuthorized } from './http/require-vault-auth.js';

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

/**
 * Phase B Tier-1 Matrix wiring (membership-sync + egress + inbound). Always
 * returns a spaceSync so the portal's grant/revoke/mirror hooks have a target;
 * when no homeserver is configured (matrixConfig() === null) the client is null
 * and EVERY op is an inert no-op (space-sync.js degrades safe), so this is safe
 * to call unconditionally — including in verify scripts (auth.db :memory: → no
 * token → matrixConfig null). When configured, it wires the real client behind a
 * try/catch: createMatrixClient is a deploy-session stub today (throws) → caught
 * → matrixClient stays null → still inert, exactly as designed. Never logs the
 * access token (CLAUDE.md §1).
 */
async function buildSpaceSync({ db, userId, logger = console }) {
  const cfg = matrixConfig();
  let matrixClient = null;
  if (cfg) {
    try { matrixClient = await createMatrixClient(cfg); }
    catch (e) { logger.error?.(`[mycelium] Matrix configured but client unavailable (staying inert): ${e.message}`); }
  }
  // peer user id → their advertised MXID, via the peer's did:web #matrix service
  // (SSRF-guarded in did.js). null when the peer advertises no Matrix.
  const resolveMxid = async (peerUserId) => {
    try {
      const prof = await db.profiles?.get?.(peerUserId);
      return prof?.did ? await resolveMatrixService(prof.did) : null;
    } catch { return null; }
  };
  const matrixEgress = matrixClient ? createMatrixEgress({ matrixClient, db }) : null;
  const spaceSync = createSpaceSync({ db, matrixClient, matrixEgress, resolveMxid, selfMxid: cfg?.userId || null });
  if (matrixClient) {
    matrixClient.onTimelineEvent((e) => { spaceSync.handleInbound(e).catch(() => {}); });
    // Bind our MXID locally: it is both the inbound self-echo filter source and
    // the value the #matrix advertise publishes. Idempotent upsert.
    try { await db.identityChannels?.upsert?.({ channel_kind: 'matrix', channel_value: cfg.userId, owner_user_id: userId }); }
    catch (e) { logger.warn?.(`[mycelium] MXID bind failed: ${e.message}`); }
    logger.error?.(`[mycelium] Matrix Tier-1 wired: ${cfg.userId} @ ${cfg.homeserver}`);
  }
  return spaceSync;
}

/** Build the express sub-app that serves every VAULT-DEPENDENT route. Mounted
 *  behind a guard so it only handles traffic once the vault is open; until then
 *  data calls get a 503 and only the account ceremony + static UI are served. */
function buildVaultSubApp({ db, tools, handlers, userId, effectiveDbPath, enqueueEnrichment, connectorRunner, vaultAuth, channelSup, spaceSync = null }) {
  const v = express();
  v.disable('x-powered-by');
  // Fail-closed auth gate FIRST, mounted at `/api` — ALL vault data the sub-app
  // serves is under /api/* (portal routers at /api/v1/portal, apiRouter at
  // /api/v1/*), so Express's own routing decides what's gated (no hand-rolled
  // path check that could diverge from the routers). Loopback (desktop) bypasses;
  // SPA navigation isn't under /api so it falls through to static (step 1.2).
  if (vaultAuth) v.use('/api', vaultAuth);
  v.use('/api/v1/portal', portalCompatRouter({ db, userId, spaceSync }));
  // S1 measurement REST bridge — auth-GATED, fail-closed (the rest of the V1
  // surface is unauthenticated/localhost-only; this surface decrypts the
  // sensitive measurement plane, so it resolves the owner ONLY for a genuine
  // local request and rejects anything proxied from a network). The owner test
  // is the shared isTrustedLoopback (src/http/loopback.js): socket peer loopback
  // AND no X-Forwarded-For — the same boundary the /api/v1/account + remote
  // control surfaces use, so all three stay consistent (V-1).
  // Mounted BEFORE portalMindscapeRouter so the bridge's richer /trajectory/summary
  // (full headline numbers the vitality page reads) takes precedence over the
  // mindscape router's lightweight {phase,exploration_ratio} stub — the bridge
  // response is a superset, so MindscapeView's summary.phase read still works.
  v.use('/api/v1/portal', portalMeasurementRouter({
    db, userId,
    authenticatePortalRequest: (req) => (isTrustedLoopback(req) ? { id: userId } : null),
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
  // Unified activity feed (background_jobs) — header stream indicator + mindscape chip.
  v.use('/api/v1/portal', portalActivityRouter({
    db, userId,
    authenticatePortalRequest: (req) => (isTrustedLoopback(req) ? { id: userId } : null),
  }));
  // Token-usage transparency (input/output by area/source/provider/model/day).
  v.use('/api/v1/portal', portalUsageRouter({
    db, userId,
    authenticatePortalRequest: (req) => (isTrustedLoopback(req) ? { id: userId } : null),
  }));
  // Voice transcription (dedicated Whisper) — status + opt-in model download.
  v.use('/api/v1/portal', portalTranscriptionRouter({
    db, userId,
    authenticatePortalRequest: (req) => (isTrustedLoopback(req) ? { id: userId } : null),
    detectHardware,
  }));
  v.use('/api/v1/portal', portalUploadsRouter({ db, userId, enqueueEnrichment }));
  // Media library (the portal's /media view): list / preview / edit / delete
  // attachments — channel media + portal uploads. Same auth gate as uploads.
  v.use('/api/v1/portal', portalAttachmentsRouter({ db, userId }));
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
  // In-app chat agent (web + Tauri) — runs a bounded, user-driven tool-use loop
  // over the SAME tool handlers, gated by the user's "AI Access" policy. Auth is
  // loopback-trusted (decrypts vault plaintext), same boundary as measurement/claims.
  v.use('/api/v1/portal', portalChatRouter({
    db, userId, tools, handlers, enqueueEnrichment,
    authenticatePortalRequest: (req) => (isTrustedLoopback(req) ? { id: userId } : null),
  }));
  v.use('/api/v1/portal', portalChannelsRouter({ db, userId, channelSup }));
  if (connectorRunner) v.use('/api/v1/portal', portalConnectorsRouter({ runner: connectorRunner }));
  // Internal support endpoints for the channel-daemon egress chokepoint
  // (egress-audit sink + channel-authority resolver). Loopback-only, same
  // trust boundary as the tool routes below.
  v.use(internalRouter({ db, userId }));
  // Loopback-only MCP endpoint over the SAME open-vault tools, so the co-managed
  // channel daemon can run its agent turn (incl. the `reply` egress tool) without
  // a second vault process or OAuth. Strict-loopback gated; never binds publicly.
  v.use(mcpLoopbackRouter({ tools, handlers }));
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

  // Wire the `reply` egress tool (src/mcp.js gates it on AGENT_URL) to the
  // co-managed channel daemon's fixed loopback chokepoint port, so the daemon's
  // agent turn can deliver replies. ONLY on real app launches — verify scripts
  // inject keys and assert exact tool counts, so they must NOT gain `reply`.
  // The tool soft-fails ('no-active-turn') outside a channel turn, so its mere
  // presence is inert everywhere else.
  const keysInjectedAtStart = userHex !== undefined && systemHex !== undefined;
  if (!keysInjectedAtStart && !process.env.AGENT_URL) {
    process.env.AGENT_URL = `http://127.0.0.1:${Number(process.env.CHANNEL_DAEMON_PORT) || 3010}`;
  }

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
  // Backup/restore sources: co-located with the effective vault when paths are
  // injected (verify scripts), else env-aware (the real app). uploads/ + remote.json
  // sit in the data dir alongside mycelium.db/kcv.json (src/paths.js).
  const effectiveUploadsRoot = dbPath ? path.join(path.dirname(effectiveDbPath), 'uploads') : resolveUploadsRoot();
  const effectiveRemoteConfigPath = kcvPath ? path.join(path.dirname(effectiveKcvPath), 'remote.json') : resolveRemoteConfigPath();
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
    // Audit tag for the account ceremony that opened the vault ('setup'|'restore'
    // |'unlock'). The audit_log lives INSIDE the encrypted vault, so it can only
    // be written AFTER boot() — a ceremony FAILURE (wrong key) leaves the vault
    // closed and is intentionally not auditable. Not a boot option → kept aside.
    const reason = extraKeys.reason;
    try {
      const opts = { ...bootOpts, ...extraKeys };
      delete opts.reason;
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
      // Record the ceremony success now that the vault (and audit_log) is open.
      // Fire-and-forget — audit failure must never block a successful boot.
      if (reason && db?.audit?.log) {
        try { await db.audit.log({ action: `vault_${reason}`, userId: bootUserId, resourceType: 'account', resourceId: bootUserId }); }
        catch { /* fire-and-forget */ }
      }
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
      let channelSup = null;
      if (!injectedKeys) {
        // Own the embed-service (:8091) lifecycle in-process: spawn/adopt, dep
        // self-check, restart-on-crash, and expose health to /processing-status.
        // Without a live embedder the drainer can't embed → Generate has no data.
        const embedSup = startEmbedSupervisor({ home: process.cwd() });
        // First-run auto-continue: once the import backlog has embedded and there is
        // NO topology yet, kick the Generate pipeline automatically so the user isn't
        // stranded after import (the #1 "it embedded but nothing happened" report).
        // Gated, fail-soft: only when not already clustering, clustering_points is
        // empty (fires once on first generation — re-generation stays manual), and
        // past a data floor so we never build a trivial 1-cluster map. Manual Generate
        // (MIN_EMBEDDED=5) is unchanged for small/test vaults below the floor.
        const AUTO_GEN_MIN = Number(process.env.MYCELIUM_AUTO_GEN_MIN) || 25;
        const maybeAutoGenerate = async () => {
          try {
            const er = await db.rawQuery('SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND embedding_768 IS NOT NULL', [bootUserId]);
            const pr = await db.rawQuery('SELECT COUNT(*) AS c FROM clustering_points WHERE user_id = ?', [bootUserId]);
            const embedded = Number(er?.results?.[0]?.c ?? 0);
            const points = Number(pr?.results?.[0]?.c ?? 0);
            if (!shouldAutoGenerate({ embedded, points, clusteringRunning: isClusteringRunning(), min: AUTO_GEN_MIN })) return;
            console.error('[mycelium] auto-generating first topology — embedding settled');
            startClusteringJob({ dbPath: effectiveDbPath, userId: bootUserId, db });
          } catch { /* non-fatal; manual Generate still works */ }
        };
        const drainer = startEnrichDrainer({ db, userId: bootUserId, onSettled: maybeAutoGenerate });
        enqueueEnrichment = (id) => { try { baseEnqueue(id); } catch { /* :8095 optional */ } drainer.nudge(); };
        // Persona-Claims cadence trigger: a zero-LLM hourly heartbeat that spawns
        // the discovery child when a day/week/month/quarter window rolls over (and
        // no clustering run is in flight). The child is Tier-3 fail-soft (no local
        // model → no-op). Gated with the drainer so verify scripts never run it.
        const claimsHeartbeat = startClaimHeartbeat({
          db, userId: bootUserId, isJobRunning: isClusteringRunning,
          spawn: (cadences) => startClaimDiscoveryJob({ dbPath: effectiveDbPath, userId: bootUserId, cadence: cadences.join(',') }),
        });
        // Co-manage the channel daemon (Telegram/Discord bridge): spawn it when the
        // user enabled channels + configured a bot token, adopt an existing one,
        // restart on crash, and stop on shutdown. Keyless — it reaches the vault
        // only over loopback (vault-client + /internal/mcp). Reaped via the Rust
        // shell's process-group kill on app exit regardless.
        channelSup = startChannelSupervisor({ home: process.cwd(), db, userId: bootUserId, restPort: port });
        // Re-attach the Whisper transcription service when the user opted in
        // earlier (users.settings.transcribeModel survives restarts; ensure is
        // a no-op without a model — no idle python for users who never opted in).
        let transcribeSup = null;
        db.users.getSettings(bootUserId)
          .then((s) => { if (s?.transcribeModel) transcribeSup = ensureTranscribeSupervisor({ model: s.transcribeModel }); })
          .catch(() => { /* optional */ });
        closeHandle = () => {
          try { connectorScheduler?.stop(); } catch { /* */ }
          try { drainer.stop(); } catch { /* */ }
          try { claimsHeartbeat.stop(); } catch { /* */ }
          try { embedSup.stop(); } catch { /* */ }
          try { channelSup?.stop(); } catch { /* */ }
          try { transcribeSup?.stop(); } catch { /* */ }
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
      // Phase B Tier-1 Matrix: build the membership-sync hook (inert no-op until a
      // homeserver is configured — see buildSpaceSync) and thread it into the
      // portal's share grant/revoke + knowledge-mirror paths.
      const spaceSync = await buildSpaceSync({ db, userId: bootUserId });
      vaultSubApp = buildVaultSubApp({ db, tools, handlers, userId: bootUserId, effectiveDbPath, enqueueEnrichment, connectorRunner, vaultAuth: createVaultAuthMiddleware({ userId: bootUserId }), channelSup, spaceSync });
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

  // Issue the double-submit CSRF cookie early so it rides the SPA document load,
  // /auth/session, and every subsequent request. Loopback (desktop) ignores it
  // (the gate bypasses CSRF for loopback); harmless there.
  app.use(csrfCookieMiddleware);

  // Account ceremony — ALWAYS mounted (this is what setup mode serves): create
  // the vault, restore from a recovery key, or re-view the key. Mounted before
  // the vault guard so /api/v1/account/* is never 503'd.
  app.use('/api/v1/account', accountRouter({
    isInitialized: () => Boolean(vaultSubApp),
    completeBoot,
    kcvPath: effectiveKcvPath,
    lockFile: effectiveLockPath,
    dbPath: effectiveDbPath,
    uploadsRoot: effectiveUploadsRoot,
    remoteConfigPath: effectiveRemoteConfigPath,
  }));

  // Remote-access control surface (loopback-only): set the operator password
  // (the OAuth gate) + read/patch the non-secret remote config. Mounted before
  // the vault guard so it works in setup mode AND post-boot.
  app.use('/api/v1/remote', remoteRouter());

  // Local "always signed in" shim so the canonical portal's session check
  // (/auth/session) succeeds and the app opens instead of bouncing to /login.
  app.use('/auth', authShimRouter({
    userId: resolvedUserId,
    // Networked clients (over the relay) must present a valid session; loopback
    // (desktop) stays "always signed in". So /auth/session 401s an unauthed
    // networked browser → the SPA bounces it to /login (operator password).
    resolveAuthorized: (req) => isAuthorized(req, { userId: resolvedUserId }),
  }));

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
  app.use(express.static(portalDir, {
    setHeaders(res, filePath) {
      // The SPA shell (200.html / index.html) must NEVER be cached. SvelteKit's
      // JS/CSS are content-hashed and immutable, but the shell references them by
      // hash — a cached shell pins the OLD bundle, so the app "won't update" after
      // a deploy until the WebView cache is manually cleared (cost a debugging
      // round-trip 2026-06-15). no-store on the shell makes a reload always fetch
      // the current bundle; hashed assets keep their default long cache.
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    },
  }));
  if (spaFallback) {
    // /api, /ingest, /portal, /auth are data paths — never shadow them with the
    // SPA shell (so unmatched data calls 404 cleanly instead of returning HTML).
    // Exclude both `/api/…` and a bare `/api` (the `(?:\/|$)` guard).
    app.get(/^\/(?!(?:api|ingest|portal|auth)(?:\/|$))(?:[^.]*)$/, (req, res, next) => {
      if (req.method !== 'GET' || !req.accepts('html')) return next();
      res.setHeader('Cache-Control', 'no-store'); // see static setHeaders above
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
const REST_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

async function main() {
  const port = Number(process.env.MYCELIUM_REST_PORT ?? 8787);
  const host = process.env.MYCELIUM_REST_HOST ?? '127.0.0.1';
  // The portal/REST surface gates the recovery key + account/key-minting routes
  // on the loopback-trust invariant (socket peer is local AND no X-Forwarded-For).
  // A non-loopback bind — or a reverse proxy that does NOT inject X-Forwarded-For —
  // makes every request read as trusted-local and can hand out the recovery key.
  // FAIL CLOSED (M-REST-BIND): refuse a non-loopback bind unless explicitly opted in.
  if (!REST_LOOPBACK_HOSTS.has(host)) {
    if (process.env.MYCELIUM_ALLOW_NETWORK_REST !== '1') {
      process.stderr.write(
        `[mycelium] ⚠️ REFUSING to bind the portal/REST server to ${host} (non-loopback).\n` +
        `  The loopback-trust model gives anything that reaches this port WITHOUT an X-Forwarded-For\n` +
        `  header full local-owner access — including the recovery key. A non-loopback bind, or a front\n` +
        `  proxy that does not ALWAYS set X-Forwarded-For, exposes that.\n` +
        `  If you front it with a TLS reverse proxy that injects X-Forwarded-For AND enforces auth, set\n` +
        `  MYCELIUM_ALLOW_NETWORK_REST=1 to proceed.\n`);
      process.exit(2);
    }
    process.stderr.write(
      `[mycelium] ⚠️ portal/REST bound to ${host} (non-loopback, MYCELIUM_ALLOW_NETWORK_REST=1) — ` +
      `ensure the front proxy ALWAYS sets X-Forwarded-For and enforces auth.\n`);
  }
  const { url, server, close } = await startRestServer({ port, host });
  const reach = REST_LOOPBACK_HOSTS.has(host) ? 'localhost-only' : `bound to ${host} (networked — proxy must auth)`;
  process.stderr.write(`mycelium portal + REST on ${url} (open in a browser; ${reach})\n`);

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
