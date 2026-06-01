import express from 'express';

/**
 * apiRouter({ tools, handlers }) — build an Express Router exposing the
 * SAME tool handlers map the MCP server uses. No tool logic is re-implemented;
 * every route looks up handlers[toolName] and calls it with the request body.
 *
 * Routes:
 *   GET  /api/v1/tools        → { ok:true, tools:[{ name, description, inputSchema }] }
 *   POST /api/v1/:toolName    → { ok:true, result:<string> }
 *
 * Security posture (V1):
 *   - No auth yet (Phase 4 adds OAuth 2.1). Callers MUST bind localhost-only.
 *   - Errors NEVER leak internals/plaintext: handler throws return a generic
 *     "tool execution failed" message, not err.message, to honour the
 *     zero-plaintext-leakage rule. Unknown tools return a safe 404.
 *
 * @param {object} deps
 * @param {Array<{name:string,description:string,inputSchema:object}>} deps.tools
 * @param {Record<string, (args:object)=>Promise<string>>} deps.handlers
 * @returns {import('express').Router}
 */
export function apiRouter({ tools, handlers }) {
  if (!Array.isArray(tools)) throw new Error('apiRouter: tools must be an array');
  if (!handlers || typeof handlers !== 'object') {
    throw new Error('apiRouter: handlers must be an object');
  }

  const router = express.Router();

  // Parse JSON bodies; cap size to keep this a sane local control surface.
  router.use(express.json({ limit: '1mb' }));

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

  // Router-level error handler — catches malformed-JSON body-parser errors and
  // anything else, returning a safe JSON envelope instead of Express's default
  // HTML error page (which could leak a stack trace).
  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => {
    if (err && err.type === 'entity.parse.failed') {
      res.status(400).json({ ok: false, error: 'request body must be valid JSON' });
      return;
    }
    res.status(500).json({ ok: false, error: 'internal error' });
  });

  return router;
}
