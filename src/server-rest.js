import express from 'express';
import path from 'node:path';
import { existsSync, mkdirSync, cpSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { boot } from './index.js';
import { dataDir, dbPath as resolveDbPath } from './paths.js';
import { apiRouter } from './api.js';
import { portalCompatRouter } from './portal-compat.js';
import { portalMindscapeRouter } from './portal-mindscape.js';
import { portalUploadsRouter } from './portal-uploads.js';
import { authShimRouter } from './auth-shim.js';
import { createEnqueueEnrichment } from './ingest/enqueue.js';

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
  // boot() returns the db namespace object plus a separate close() function;
  // the namespace has no .close method, so we hold close() for shutdown.
  const { tools, handlers, db, close, userId: bootUserId } = await boot(bootOpts);

  // The mindscape clustering job (Phase G) spawns a subprocess that opens the
  // vault by path via MYCELIUM_DB. In the normal app launch, server-rest's own
  // `dbPath` param is undefined (boot() applies its own default), so resolve the
  // SAME effective path here — absolute, so the spawned child finds it
  // regardless of its cwd — and hand it to the mindscape router. Without this,
  // the child fell back to './data/vault.db' (empty) → "no such table: messages".
  const effectiveDbPath = dbPath ? path.resolve(dbPath) : resolveDbPath();

  const app = express();
  app.disable('x-powered-by');
  // Wire db + userId + a best-effort enrichment nudge so /api/v1/upload works
  // (file → encrypted blob → attachment → enrich), same seam as the MCP path.
  const enqueueEnrichment = createEnqueueEnrichment({ userId: bootUserId });
  // Canonical-portal compatibility surface (/api/v1/portal/* → db). Mounted at
  // its own prefix so its JSON body-parser is scoped to portal calls only (it
  // must not touch the raw-bytes /api/v1/upload route). The canonical UI's
  // api.ts rewrites /portal/* → /api/v1/portal/*.
  app.use('/api/v1/portal', portalCompatRouter({ db, userId: bootUserId }));
  // Mindscape read surface (3D scene aggregator + per-panel reads). Same prefix
  // (unmatched paths fall through from the compat router above); its JSON parser
  // is likewise scoped to /api/v1/portal so it never touches /api/v1/upload.
  app.use('/api/v1/portal', portalMindscapeRouter({ db, userId: bootUserId, dbPath: effectiveDbPath }));
  // Import surface (multipart upload + chunk assembly → parse → captureMessage).
  // Multipart bodies pass through the JSON parsers above untouched (content-type
  // gated); its own /upload/complete handler scopes express.json to that route.
  app.use('/api/v1/portal', portalUploadsRouter({ db, userId: bootUserId, enqueueEnrichment }));
  // Local "always signed in" shim so the canonical portal's session check
  // (/auth/session) succeeds and the app opens instead of bouncing to /login —
  // V1 is single-user and unlocked at boot (keys from the server-side source).
  app.use('/auth', authShimRouter({ userId: bootUserId }));
  app.use(apiRouter({ tools, handlers, db, userId: bootUserId, enqueueEnrichment }));
  // Portal UI after the API router (so /api/v1/* matches first). express.static
  // serves the built assets; for the canonical SPA, client-side routes
  // (/library, /mindscape, …) have no file on disk, so fall back to 200.html
  // for NAVIGATION requests only — GET, accepts html, not under /api|/ingest,
  // and extensionless (so a missing asset like /x.js still 404s, no SPA shadow).
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

  return { app, server, db, close, url, port: boundPort, host };
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
