import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from './index.js';
import { apiRouter } from './api.js';
import { createEnqueueEnrichment } from './ingest/enqueue.js';

// The static portal (single-file SPA) lives at <repo>/portal, served at / from
// the SAME origin as the API so the browser/Tauri webview calls /api/v1/* with
// no CORS. localhost-only (see SECURITY note above).
const PORTAL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'portal');

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
  app.use(apiRouter({ tools, handlers, db, userId: bootUserId, enqueueEnrichment }));
  // Portal UI after the API router (so /api/v1/* matches first). express.static
  // serves portal/index.html at GET /.
  app.use(express.static(PORTAL_DIR));

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
