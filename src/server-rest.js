import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { boot } from './index.js';
import { apiRouter } from './api.js';
import { portalCompatRouter } from './portal-compat.js';
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
  app.use(apiRouter({ tools, handlers, db, userId: bootUserId, enqueueEnrichment }));
  // Portal UI after the API router (so /api/v1/* matches first). express.static
  // serves the built assets; for the canonical SPA, client-side routes
  // (/library, /mindscape, …) have no file on disk, so fall back to 200.html
  // for NAVIGATION requests only — GET, accepts html, not under /api|/ingest,
  // and extensionless (so a missing asset like /x.js still 404s, no SPA shadow).
  const { dir: portalDir, spaFallback } = resolvePortal(portalMode);
  app.use(express.static(portalDir));
  if (spaFallback) {
    // /api, /ingest, /portal are data paths — never shadow them with the SPA
    // shell (so unmatched data calls 404 cleanly instead of returning HTML).
    app.get(/^\/(?!api\/|ingest\/|portal\/)(?:[^.]*)$/, (req, res, next) => {
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
