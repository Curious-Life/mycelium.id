import express from 'express';
import path from 'node:path';
import https from 'node:https';
import { existsSync, mkdirSync, cpSync, renameSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
import { createScheduler } from './agent/scheduler.js';
import { createChannelTurnRouter } from './agent/channel-turn.js';
import { createAgentHarness } from './agent/harness.js';
import { createAgentLoop } from './agent/loop.js';
import { createEgressAuditSink } from './inference/egress.js';
import { createUsageSink } from './inference/usage.js';
import { captureMessage } from './ingest/capture.js';
import { portalIngestRouter } from './portal-ingest.js';
import { portalHealthRouter } from './portal-health.js';
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
import { startKokoroSupervisor } from './tts/kokoro-supervisor.js';
import { startChannelSupervisor } from './channels/supervisor.js';
import { mcpLoopbackRouter } from './mcp-loopback.js';
import { matrixConfig, readRemoteConfig } from './remote/config.js';
import { isValidHandle } from './identity/identity.js';
import { createSpaceSync } from './federation/space-sync.js';
import { createMatrixEgress } from './federation/matrix-egress.js';
import { createMatrixClient } from './federation/matrix-client.js';
import { resolveMatrixService } from './federation/did.js';
import { setSessionKeys } from './account/session-keys.js';
import { createVaultAuthMiddleware, csrfCookieMiddleware, isAuthorized, makePortalOwnerGate } from './http/require-vault-auth.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// SINGLE SOURCE OF TRUTH: the one and only UI is the canonical SvelteKit app at
// portal-app/build. There is no second UI directory. When the build is missing
// (a fresh source checkout that skipped `npm run build:app` / `npm start`) we
// serve the inline PLACEHOLDER_HTML below — code, not a divergent on-disk shell.
const CANONICAL_BUILD = path.join(HERE, '..', 'portal-app', 'build');
const PORTAL_FAVICON = path.join(HERE, '..', 'portal-app', 'static', 'favicon.svg');

// "Not built" placeholder. No inline <script> (keeps the hardened CSP simple —
// buildPortalCsp fails closed to script-src 'self'); meta-refresh reloads into
// the real UI once `npm run build:app`/`portal:build` finishes.
const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Mycelium</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<meta http-equiv="refresh" content="5" />
<style>:root{color-scheme:dark}body{background:#0A0A0C;color:#E8E8EC;display:grid;place-items:center;height:100vh;margin:0;font:15px/1.6 system-ui,-apple-system,sans-serif;text-align:center;padding:2rem}main{max-width:30rem}.sub{color:#E5B84C;font-size:.8rem;letter-spacing:.08em;text-transform:uppercase}h1{font-weight:600;margin:.25rem 0 1rem}p{color:#9898A3;margin:.5rem 0}code{background:#141417;border:1px solid #2A2A32;border-radius:6px;padding:.15rem .45rem;color:#E8E8EC;font:13px ui-monospace,Menlo,monospace}</style>
</head><body><main>
<div class="sub">Mycelium</div>
<h1>The portal isn't built yet</h1>
<p>The UI is the SvelteKit app in <code>portal-app/</code>. Build it (this page reloads automatically when it's ready):</p>
<p><code>npm run build:app</code></p>
<p style="font-size:.8rem;margin-top:1.5rem">The packaged desktop app builds this for you — you only see this in a fresh source checkout.</p>
</main></body></html>`;

/**
 * Is the canonical UI (portal-app/build) available to serve?
 * mode: 'auto' (default) | 'canonical' | 'legacy'. 'legacy' forces the
 * placeholder (used by API/route tests that don't need the heavy SvelteKit
 * build). Resolved at call time so tests/CLI can pick a mode deterministically.
 * Returns { built, spaFallback }: spaFallback is the 200.html path when built.
 */
function resolvePortal(mode = process.env.MYCELIUM_PORTAL || 'auto') {
  const shell = path.join(CANONICAL_BUILD, '200.html');
  const built = mode !== 'legacy' && mode !== 'placeholder' && existsSync(shell);
  return { built, spaFallback: built ? shell : null };
}

/**
 * Build the Content-Security-Policy for the portal webview.
 *
 * The Tauri webview loads this Node server as a REMOTE origin
 * (http://127.0.0.1:8787), so Tauri's compile-time CSP (app.security.csp) does
 * NOT apply — the CSP must ride the HTTP response. We avoid `script-src
 * 'unsafe-inline'` (which would defeat most of CSP's XSS value, and this is a
 * cognitive vault) by hashing the shell's first-party inline scripts at boot:
 * the SES polyfill + SvelteKit's bootstrap are not byte-stable across builds, so
 * a hardcoded hash would rot — extracting them at startup auto-adapts and needs
 * no per-request HTML rewrite (the shell is still served via sendFile/static).
 *
 * Fail closed: if the shell can't be read, we emit `script-src 'self'` only
 * (stricter, not laxer). DOMPurify on rendered markdown remains the first layer;
 * this is defense-in-depth. See docs/APP-SANDBOX-HARDENING-DESIGN-2026-06-16.md.
 */
function buildPortalCsp(shellPath) {
  const hashes = [];
  try {
    const html = readFileSync(shellPath, 'utf8');
    // Inline <script> blocks only (those WITHOUT a src=) — src'd modules are 'self'.
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      const body = m[1];
      if (!body.trim()) continue;
      hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
    }
  } catch {
    /* shell unreadable → script-src 'self' only (fail closed = stricter) */
  }
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.basemaps.cartocdn.com",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    // Turnstile is a CROSS-ORIGIN iframe to the control plane (its script runs
    // THERE, never in this origin) — frame it, but grant it no script/connect here.
    "frame-src https://connect.mycelium.id",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
  ].join('; ');
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

// Vault schema self-initialisation moved into boot() → initVaultStorage()
// (src/db/init.js): it is now KEY-AWARE (a fresh at-rest vault is born encrypted;
// an already-encrypted vault opens keyed for the idempotent schema apply) and runs
// under a cross-process lock together with the migration. Opening the schema
// connection UNKEYED here threw "file is not a database" on any encrypted vault.

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
  // Connection-presence activity heartbeat. Every authenticated /api request (the
  // portal polls every 5–15s while the app is open) marks the owner "active now" so
  // the :4711 federation responder can answer online/offline for connections. This
  // is the shared-DB cross-process bridge (the responder runs in a different process
  // and cannot see an in-memory flag). Throttled to ≥60s, fire-and-forget (never
  // awaited, never throws) so it adds no latency. @see src/db/peer-presence.js.
  let lastTouchAt = 0;
  v.use('/api', (req, _res, next) => {
    const id = req.requester?.id;
    if (id) {
      const t = Date.now();
      if (t - lastTouchAt >= 60_000) {
        lastTouchAt = t;
        Promise.resolve(db.peerPresence?.touch(id)).catch(() => {});
      }
    }
    next();
  });
  // Per-router owner gate for the SENSITIVE routers (they decrypt vault plaintext,
  // so they authenticate independently of the global /api gate — defence in depth).
  // Trust: trusted-loopback (desktop) OR the owner's static Bearer (native app over
  // Tailscale / the native-TLS listener), the SAME authority the global gate trusts.
  const portalOwnerGate = makePortalOwnerGate({ userId });
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
    authenticatePortalRequest: portalOwnerGate,
  }));
  v.use('/api/v1/portal', portalClaimsRouter({
    db, userId,
    authenticatePortalRequest: portalOwnerGate,
  }));
  // Apple Health structured read/write (health_daily). Mounted BEFORE the mindscape
  // router so the real /health/summary wins over its legacy empty stub.
  v.use('/api/v1/portal', portalHealthRouter({ db, userId, authenticatePortalRequest: portalOwnerGate }));
  v.use('/api/v1/portal', portalMindscapeRouter({ db, userId, dbPath: effectiveDbPath }));
  // Unified activity feed (background_jobs) — header stream indicator + mindscape chip.
  v.use('/api/v1/portal', portalActivityRouter({
    db, userId,
    authenticatePortalRequest: portalOwnerGate,
  }));
  // Token-usage transparency (input/output by area/source/provider/model/day).
  v.use('/api/v1/portal', portalUsageRouter({
    db, userId,
    authenticatePortalRequest: portalOwnerGate,
  }));
  // Voice transcription (dedicated Whisper) — status + opt-in model download.
  v.use('/api/v1/portal', portalTranscriptionRouter({
    db, userId,
    authenticatePortalRequest: portalOwnerGate,
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
    authenticatePortalRequest: portalOwnerGate,
  }));
  // Owner push-ingestion for the native app (Apple data → the stream via the one
  // captureMessage boundary). Owner-gated like chat; decrypts/writes vault plaintext.
  v.use('/api/v1/portal', portalIngestRouter({
    db, userId, enqueueEnrichment,
    authenticatePortalRequest: portalOwnerGate,
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
  // Native channel-turn endpoint (Phase 5, Step 6c) — the channel-daemon's native
  // backend POSTs an inbound message here; the turn runs in-process over the same
  // open-vault tools (incl. `reply`), with conversation history + an untrusted
  // envelope. Strict-loopback gated inside the router (same boundary as MCP above).
  {
    const chHarness = createAgentHarness({ onEgress: createEgressAuditSink(db, userId), onUsage: createUsageSink(db, userId, { source: 'gateway' }), logger: (m) => console.error(`[channel-turn] ${m}`) });
    const chLoop = createAgentLoop({ harness: chHarness, logger: (m) => console.error(`[channel-turn] ${m}`) });
    v.use(createChannelTurnRouter({ db, userId, tools, handlers, loop: chLoop, logger: (m) => console.error(`[channel-turn] ${m}`) }));
  }
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
  // Why the vault didn't open, for transparent UX (else every failure looks like
  // "not set up yet"). null = no failure. Classified so the UI can route to the
  // right recovery (re-enter key vs. disable at-rest) instead of a dead-end setup.
  let bootError = null;
  const classifyBootError = (err) => {
    const m = String(err?.message || err || '');
    if (/KCV failed|wrong key|does not match/i.test(m)) return 'key_mismatch';
    if (/at-rest|MYCELIUM_AT_REST|migration/i.test(m)) return 'at_rest_migration_failed';
    return 'boot_failed';
  };
  const getBootError = () => bootError;

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
      // Schema + at-rest migration now happen INSIDE boot() → initVaultStorage(),
      // key-aware + under a cross-process lock (self-initialises a fresh vault).
      const { tools, handlers, db, close, userId: bootUserId, searchHelpers } = await boot(opts);
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
        // Warm the in-RAM mind-search index in the BACKGROUND, right after unlock,
        // so the FIRST search doesn't eat the full cold-start build (minutes on a
        // large vault: per-row content + 768-dim vector decrypt for tens of
        // thousands of rows on one thread). Fire-and-forget + single-flight: a user
        // search that arrives mid-warm joins this same build instead of starting a
        // second one. Gated with the drainer (real-app only) so verify scripts keep
        // their lazy first-query build. The cooperative yield in loadFromDb keeps the
        // event loop responsive while this runs.
        searchHelpers?.warm?.();
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
            const { embedded } = await db.messages.embedBacklogCached(bootUserId); // boot: warms the SWR cache so the first activity poll is instant (not a 6s cold scan)
            const pr = await db.rawQuery('SELECT COUNT(*) AS c FROM clustering_points WHERE user_id = ?', [bootUserId]);
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
        // Local TTS (Kokoro :8094): start the on-box voice service once the user
        // has downloaded the model AND opted in (KOKORO_TTS_ENABLED in secrets).
        // Keyless, loopback-only; stays idle (no python) until both are true.
        startKokoroSupervisor({
          home: process.cwd(),
          shouldRun: async () => { try { return (await db.secrets.get(bootUserId, 'KOKORO_TTS_ENABLED')) === '1'; } catch { return false; } },
        });
        // Re-attach the Whisper transcription service when the user opted in
        // earlier (users.settings.transcribeModel survives restarts; ensure is
        // a no-op without a model — no idle python for users who never opted in).
        let transcribeSup = null;
        db.users.getSettings(bootUserId)
          .then((s) => { if (s?.transcribeModel) transcribeSup = ensureTranscribeSupervisor({ model: s.transcribeModel }); })
          .catch(() => { /* optional */ });
        // Native agent harness (Phase 5, Step 4b): the autonomous wake-cycle runtime.
        // Fires due scheduled_tasks as headless turns over the SAME streamTurn engine
        // chat uses, serialized on one lane. Gated with the drainer so verify scripts
        // (injected keys) never run a turn against a deterministic test vault. The
        // delivery sink persists 'chat'-targeted output as an assistant message via the
        // same captureMessage funnel; 'channel:*' proactive sends are deferred to Step 6
        // (a turn-less send has no active-turn registry entry to target).
        const schedulerDeliver = async (task, text) => {
          const target = task.output_target || 'none';
          if (target === 'none' || target.startsWith('channel:')) return; // channel:* → Step 6
          const conversationId = target.startsWith('conversation:') ? target.slice('conversation:'.length) : null;
          await captureMessage(db, { role: 'assistant', content: text, source: 'scheduler', message_type: 'text', conversation_id: conversationId }, enqueueEnrichment);
        };
        const harnessScheduler = createScheduler({
          db, userId: bootUserId, tools, handlers, deliver: schedulerDeliver,
          logger: (m) => console.error(`[scheduler] ${m}`),
        });
        // Boot recovery (§5.4): flip orphaned in-flight runs to aborted, then push any
        // overdue tasks forward so a downtime gap doesn't fire them all at once.
        try {
          await db.harness.reconcileOnBoot();
          await db.harness.advanceOverdue(new Date().toISOString());
        } catch (e) { console.warn('[scheduler] boot reconcile skipped:', e?.message || e); }
        harnessScheduler.start();
        closeHandle = () => {
          try { harnessScheduler.stop(); } catch { /* */ }
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
      bootError = null; // opened cleanly → clear any prior failure
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
      // Only a bootError if a vault FILE actually exists (else this is a genuine
      // fresh "not created yet" — no keys present is expected, not a failure).
      if (existsSync(effectiveKcvPath)) {
        bootError = classifyBootError(err);
        // Surface the CLASS to /account/status so the UI offers the right recovery;
        // keep the raw reason out of the response (it can name key material) — log
        // it for the operator only.
        console.error(`[mycelium] vault not opened (${bootError}) — entering setup mode (${err?.message || err})`);
      } else {
        console.error(`[mycelium] no vault yet — entering setup mode (${err?.message || err})`);
      }
    }
  }
  const resolvedUserId = userId || process.env.MYCELIUM_USER_ID || 'local-user';

  const app = express();
  app.disable('x-powered-by');

  // Security headers on EVERY response (the webview loads us as a remote origin,
  // so this is the only place a CSP can attach — see buildPortalCsp). Computed
  // once at boot from the resolved shell. No HSTS: this origin is loopback HTTP
  // (HSTS is ignored there); caddy adds it for the public TLS host.
  {
    const { built: cspBuilt, spaFallback: cspShell } = resolvePortal(portalMode);
    // Built → hash the SvelteKit shell's inline scripts. Not built → the inline
    // placeholder has no inline <script>, so an unreadable path makes
    // buildPortalCsp fail closed to `script-src 'self'` (correct + strict).
    const portalCsp = buildPortalCsp(cspBuilt ? cspShell : '');
    app.use((req, res, next) => {
      res.setHeader('Content-Security-Policy', portalCsp);
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      next();
    });
  }

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
    getBootError,
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
    // The vault's tag (the first label of publicHost), read live so a handle
    // claimed after boot shows up without a restart; null when no remote handle
    // is set → the login UI brands generically instead of with a placeholder.
    // This is the IDENTITY the login surfaces show — the operator account's
    // internal email is never surfaced (single-user: there is one account).
    getHandle: () => { const h = (readRemoteConfig().publicHost || '').split('.')[0]; return isValidHandle(h) ? h : null; },
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
      // Distinguish "no vault yet" from "vault exists but couldn't open" so the UI
      // doesn't dead-end a mis-keyed vault into the create-new-vault flow.
      if (bootError) {
        return res.status(503).json({
          error: 'vault_locked', reason: bootError,
          message: bootError === 'key_mismatch'
            ? 'Your vault exists but the saved key can’t open it. Enter your recovery key, or restore from a backup.'
            : bootError === 'at_rest_migration_failed'
              ? 'Your vault couldn’t finish encrypting at rest and didn’t open. See recovery options.'
              : 'Your vault exists but failed to open. See recovery options.',
        });
      }
      return res.status(503).json({ error: 'vault_not_initialized', reason: 'not_created', message: 'Your vault is not set up yet.' });
    }
    return next();
  });

  // Portal UI (static + SPA fallback) — always, so /setup and the app shell load.
  // client-side routes (/library, /mindscape, /setup, …) have no file on disk, so
  // fall back to 200.html for NAVIGATION requests only — GET, accepts html, not
  // under a data prefix, extensionless (a missing asset like /x.js still 404s).
  const { built: portalBuilt, spaFallback } = resolvePortal(portalMode);
  // Navigation matcher: GET, html-accepting, extensionless (so a missing asset
  // like /x.js still 404s), not a data path. The regex's `(?!api…)` lookahead is
  // bypassable by a leading double-slash (`//api/…`), so isPortalNav ALSO rejects
  // data paths after collapsing duplicate slashes — otherwise an HTML 200 would
  // mask the auth gate (verify:portal-auth case I). Shared by built + placeholder.
  const NAV_ROUTE = /^\/(?!(?:api|ingest|portal|auth)(?:\/|$))(?:[^.]*)$/;
  const DATA_PREFIX = /^\/(?:api|ingest|portal|auth)(?:\/|$)/;
  const isPortalNav = (req) =>
    req.method === 'GET' && req.accepts('html') &&
    !DATA_PREFIX.test(req.path.replace(/\/{2,}/g, '/'));
  if (portalBuilt) {
    app.use(express.static(CANONICAL_BUILD, {
      setHeaders(res, filePath) {
        // The SPA shell (200.html) must NEVER be cached. SvelteKit's JS/CSS are
        // content-hashed + immutable, but the shell references them by hash — a
        // cached shell pins the OLD bundle, so the app "won't update" after a
        // deploy until the WebView cache is cleared (cost a round-trip 2026-06-15).
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
      },
    }));
    // Client-side routes (/library, /mindscape, /setup, …) have no file → SPA
    // fallback to 200.html for NAVIGATION requests only. Data paths never shadowed.
    app.get(NAV_ROUTE, (req, res, next) => {
      if (!isPortalNav(req)) return next();
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(spaFallback);
    });
  } else {
    // Canonical UI not built → serve the inline "not built" placeholder (no
    // second on-disk UI). Loud unless a test explicitly forced placeholder mode.
    if (portalMode !== 'legacy' && portalMode !== 'placeholder') {
      console.warn('[mycelium] portal-app/build not found — serving the "not built" placeholder. Build the real UI: npm run build:app');
    }
    // Favicon comes from portal-app/static (present in source even pre-build).
    app.get('/favicon.svg', (req, res, next) => {
      if (existsSync(PORTAL_FAVICON)) return res.type('image/svg+xml').sendFile(PORTAL_FAVICON);
      next();
    });
    app.get(NAV_ROUTE, (req, res, next) => {
      if (!isPortalNav(req)) return next();
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(PLACEHOLDER_HTML);
    });
  }

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.on('error', reject);
  });

  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host}:${boundPort}`;

  // ── Optional native TLS listener (S-REST-TLS) ──────────────────────────────
  // The plain-http server above stays LOOPBACK-only (desktop / Tauri / a loopback
  // reverse proxy). For a native mobile client that reaches the box DIRECTLY over
  // Tailscale we expose the SAME express app over real TLS on a network interface
  // (cert from `tailscale cert <node>.<tailnet>.ts.net`). The security model
  // (Odysseus "bind + TLS + auth-always-on"): a remote client's socket peer is its
  // real, NON-loopback address, so isTrustedLoopback() is false → every request
  // must carry the owner Bearer (require-vault-auth / A1), and the account/remote
  // control surfaces self-reject. There is NO dependence on a front proxy's
  // X-Forwarded-For header — the peer address alone enforces auth.
  //
  // Fail closed: TLS starts ONLY when BOTH cert+key are set AND readable. A
  // missing/unreadable cert logs loudly and is SKIPPED — we NEVER fall back to
  // serving the vault as plaintext on a network interface.
  let tlsServer = null;
  let tlsUrl = null;
  const certPath = process.env.MYCELIUM_REST_TLS_CERT;
  const keyPath = process.env.MYCELIUM_REST_TLS_KEY;
  if (certPath && keyPath) {
    const tlsPort = Number(process.env.MYCELIUM_REST_TLS_PORT ?? 8443);
    const tlsHost = process.env.MYCELIUM_REST_TLS_HOST ?? '0.0.0.0';
    try {
      const cred = { cert: readFileSync(certPath), key: readFileSync(keyPath) };
      tlsServer = await new Promise((resolve, reject) => {
        const s = https.createServer(cred, app).listen(tlsPort, tlsHost, () => resolve(s));
        s.on('error', reject);
      });
      const tlsAddr = tlsServer.address();
      const tlsBound = typeof tlsAddr === 'object' && tlsAddr ? tlsAddr.port : tlsPort;
      tlsUrl = `https://${tlsHost}:${tlsBound}`;
      console.error(`[mycelium] portal/REST TLS listener on ${tlsUrl} — remote clients authenticate via Bearer; loopback http stays on ${url}`);
    } catch (err) {
      // No insecure fallback: log + continue loopback-only (remote access stays OFF).
      console.error(
        `[mycelium] ⚠️ TLS listener NOT started: ${String(err?.message || err)}. ` +
        `Check MYCELIUM_REST_TLS_CERT / MYCELIUM_REST_TLS_KEY (PEM paths). ` +
        `Remote access is OFF; loopback http is unaffected.`);
      tlsServer = null;
    }
  }

  return {
    app, server, tlsServer, url, tlsUrl, port: boundPort, host,
    get db() { return dbHandle; },
    close: () => { try { tlsServer?.close(); } catch { /* */ } return closeHandle?.(); },
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
