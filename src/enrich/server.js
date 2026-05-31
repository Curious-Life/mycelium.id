// D7 enrichment service — the :8095 HTTP listener (the nudge target).
//
// The ingestion choke-point fires a best-effort POST /enrich-all { userId }
// at this loopback service the moment a message is captured (src/ingest/
// enqueue.js). This server is that target: it wraps the pure drainOnce core
// (src/enrich/service.js) behind a tiny HTTP surface and a shared db + embed
// client.
//
// SECURITY (V1, mirrors server-rest.js): this surface has NO auth. It binds
// 127.0.0.1 ONLY and MUST NOT be exposed to a network. The enqueue nudge is
// itself unauthenticated loopback traffic; the master key never crosses this
// boundary (drainOnce resolves it in-process via getMasterKey). The drain
// fails closed on a locked vault → 503, never a partial write.
//
// Routes:
//   GET  /health      → { ok: true, dim }
//   POST /enrich-all   { userId? }  → 200 { scanned, embedded, failed }
//                                     503 if the vault is locked
//                                     400 on malformed JSON
//
// Tier-2: with the real :8091 embed-service down, each row's embed throws and
// the row is marked failed (-1) — honest, non-fatal. Inject `embed` for tests.

import { createServer } from 'node:http';

import { boot } from '../index.js';
import { createEmbedClient, EMBED_DIM } from '../embed/client.js';
import { getMasterKey } from '../crypto/crypto-local.js';
import { createEnrichmentService } from './service.js';

const MAX_BODY_BYTES = 64 * 1024; // nudge bodies are tiny; cap to be safe

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

/**
 * Boot the shared assembly + an embed client, then serve the enrichment drain
 * over loopback HTTP. Mirrors startRestServer's lifecycle contract.
 *
 * @param {object} [opts]
 * @param {number} [opts.port=8095]
 * @param {string} [opts.host='127.0.0.1']
 * @param {string} [opts.userId]        default tenant when the nudge omits one
 * @param {string} [opts.embedBaseUrl]  embed-service base (default :8091)
 * @param {object} [opts.embed]         injected embed client (tests)
 * @param {string} [opts.dbPath] @param {string} [opts.kcvPath]
 * @param {string} [opts.userHex] @param {string} [opts.systemHex]
 * @returns {Promise<{server: import('node:http').Server, db: object, url: string, close: () => void, drainOnce: Function}>}
 */
export async function startEnrichmentServer({
  port = 8095,
  host = '127.0.0.1',
  userId,
  embedBaseUrl,
  embed,
  dbPath,
  kcvPath,
  userHex,
  systemHex,
} = {}) {
  const bootOpts = {};
  if (dbPath !== undefined) bootOpts.dbPath = dbPath;
  if (kcvPath !== undefined) bootOpts.kcvPath = kcvPath;
  if (userHex !== undefined) bootOpts.userHex = userHex;
  if (systemHex !== undefined) bootOpts.systemHex = systemHex;
  const { db, close } = await boot(bootOpts);

  const embedClient = embed || createEmbedClient(embedBaseUrl ? { baseUrl: embedBaseUrl } : {});
  const svc = createEnrichmentService({ messages: db.messages, embed: embedClient, getMasterKey });
  const defaultUserId = userId || process.env.MYA_USER_ID || 'local-user';

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, { ok: true, dim: EMBED_DIM });
      }
      if (req.method === 'POST' && req.url === '/enrich-all') {
        let body;
        try { body = await readJsonBody(req); }
        catch (e) { return sendJson(res, 400, { error: e.message }); }
        const uid = (body && typeof body.userId === 'string' && body.userId) || defaultUserId;
        try {
          // Full pipeline: embed (0→2) then the NLP rules pass (2→1). One nudge
          // fully enriches a backlog. embed fails closed on a locked vault (503).
          const embed = await svc.drainOnce({ userId: uid });
          const nlp = await svc.enrichNlpOnce({ userId: uid });
          return sendJson(res, 200, { embed, nlp });
        } catch (e) {
          // Locked vault / write refusal → fail closed. Never echo internals
          // or anything derived from message content (CLAUDE.md §1).
          return sendJson(res, 503, { error: 'enrichment unavailable' });
        }
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch {
      // Last-resort guard: never leak a stack to the wire.
      try { sendJson(res, 500, { error: 'internal error' }); } catch { /* */ }
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const bound = server.address();
  const url = `http://${host}:${typeof bound === 'object' && bound ? bound.port : port}`;

  return {
    server,
    db,
    url,
    drainOnce: svc.drainOnce,
    close() {
      try { server.close(); } catch { /* */ }
      try { close(); } catch { /* */ }
    },
  };
}

export default startEnrichmentServer;
