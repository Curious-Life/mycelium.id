import express from 'express';
import { uploadAttachment } from './ingest/upload.js';

/**
 * apiRouter({ tools, handlers, db?, userId?, enqueueEnrichment? }) — build an
 * Express Router exposing the SAME tool handlers map the MCP server uses, plus a
 * dependency-free file-upload route. No tool logic is re-implemented; every tool
 * route looks up handlers[toolName] and calls it with the request body.
 *
 * Routes:
 *   GET  /api/v1/tools        → { ok:true, tools:[{ name, description, inputSchema }] }
 *   POST /api/v1/upload       → { ok:true, result:{ attachmentId, size, … } }   (raw bytes)
 *   POST /api/v1/:toolName    → { ok:true, result:<string> }
 *
 * High-volume ingest: the JSON body limit is generous (env MYCELIUM_API_BODY_LIMIT,
 * default 64mb) so bulk `importMessages` works; uploads accept up to
 * MYCELIUM_UPLOAD_LIMIT (default 256mb) of raw bytes. The portal chunks very
 * large imports client-side so no single request has to be enormous.
 *
 * Security posture (V1): no auth yet (Phase 4); bind localhost-only. Errors never
 * leak internals/plaintext.
 *
 * @param {object} deps
 * @param {Array<{name:string,description:string,inputSchema:object}>} deps.tools
 * @param {Record<string, (args:object)=>Promise<string>>} deps.handlers
 * @param {object} [deps.db]                wired db namespace (enables /upload)
 * @param {string} [deps.userId]            owner for uploaded attachments
 * @param {(id:string)=>void} [deps.enqueueEnrichment]  best-effort enrich nudge
 * @returns {import('express').Router}
 */
export function apiRouter({ tools, handlers, db = null, userId = null, enqueueEnrichment = null }) {
  if (!Array.isArray(tools)) throw new Error('apiRouter: tools must be an array');
  if (!handlers || typeof handlers !== 'object') {
    throw new Error('apiRouter: handlers must be an object');
  }

  const JSON_LIMIT = process.env.MYCELIUM_API_BODY_LIMIT || '64mb';
  const UPLOAD_LIMIT = process.env.MYCELIUM_UPLOAD_LIMIT || '256mb';

  const router = express.Router();

  // POST /api/v1/upload — store a file. Raw bytes = body (dependency-free, no
  // multipart). Query: ?filename=…&type=…&asMessage=1 . Registered BEFORE the
  // JSON parser so octet-stream bodies are read raw. Only mounted when a db is
  // wired (the REST/portal server passes one; pure tool tests may not).
  if (db) {
    router.post('/api/v1/upload', express.raw({ type: '*/*', limit: UPLOAD_LIMIT }), async (req, res) => {
      const bytes = req.body;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        res.status(400).json({ ok: false, error: 'upload body must be non-empty raw bytes' });
        return;
      }
      try {
        const result = await uploadAttachment(db, {
          userId,
          bytes,
          fileName: typeof req.query.filename === 'string' ? req.query.filename : undefined,
          fileType: typeof req.query.type === 'string' ? req.query.type : undefined,
          asMessage: req.query.asMessage === '1' || req.query.asMessage === 'true',
        }, enqueueEnrichment || undefined);
        res.json({ ok: true, result });
      } catch (err) {
        const msg = String(err?.message ?? '');
        const caller = /is required|must be|invalid/i.test(msg) && msg.length <= 200;
        res.status(caller ? 400 : 500).json({ ok: false, error: caller ? 'invalid upload: check filename/bytes' : 'upload failed' });
      }
    });
  }

  // Parse JSON bodies for the tool routes; generous cap for bulk ingest.
  router.use(express.json({ limit: JSON_LIMIT }));

  // GET /api/v1/tools — list registered tools (name + description + inputSchema).
  router.get('/api/v1/tools', (_req, res) => {
    res.json({
      ok: true,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema ?? {},
      })),
    });
  });

  // POST /api/v1/:toolName — invoke a tool with the JSON body as args.
  router.post('/api/v1/:toolName', async (req, res) => {
    const { toolName } = req.params;
    const handler = handlers[toolName];

    // Unknown tool → 404, fail closed.
    if (typeof handler !== 'function') {
      res.status(404).json({ ok: false, error: `unknown tool: ${toolName}` });
      return;
    }

    // Body must be a plain JSON object (the args map). Reject arrays/primitives.
    const body = req.body;
    const isPlainObject =
      body !== null && typeof body === 'object' && !Array.isArray(body);
    if (!isPlainObject) {
      res.status(400).json({ ok: false, error: 'request body must be a JSON object' });
      return;
    }

    try {
      const result = await handler(body);
      res.json({ ok: true, result });
    } catch (err) {
      // NEVER echo raw internals/plaintext (zero-leakage rule). Tool handlers
      // may throw messages that embed user-supplied content, so we never
      // surface err.message. We DO distinguish caller-input errors (400) from
      // internal failures (500) by matching a strict allowlist of generic
      // validation phrases — the response text is a fixed safe constant, not
      // the raw message.
      const msg = String(err?.message ?? '');
      const isValidationError =
        msg.length <= 200 && /(is required|is missing|must be|invalid)/i.test(msg);
      if (isValidationError) {
        res.status(400).json({ ok: false, error: 'invalid request: check tool arguments' });
      } else {
        res.status(500).json({ ok: false, error: 'tool execution failed' });
      }
    }
  });

  // Router-level error handler — catches malformed-JSON / too-large-body errors
  // and anything else, returning a safe JSON envelope instead of Express's
  // default HTML error page (which could leak a stack trace).
  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => {
    if (err && err.type === 'entity.parse.failed') {
      res.status(400).json({ ok: false, error: 'request body must be valid JSON' });
      return;
    }
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      res.status(413).json({ ok: false, error: 'payload too large — import in smaller batches' });
      return;
    }
    res.status(500).json({ ok: false, error: 'internal error' });
  });

  return router;
}
