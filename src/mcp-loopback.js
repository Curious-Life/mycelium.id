// src/mcp-loopback.js — a LOOPBACK-ONLY Streamable-HTTP MCP endpoint over the
// app's already-open vault tools. Mounted by server-rest.js at /internal/mcp so
// the co-managed channel daemon (packages/channel-daemon) can run its agent turn
// against the SAME tool surface — including the `reply` egress tool (wired when
// AGENT_URL is set) — WITHOUT a second vault process, OAuth, or a static bearer.
//
// SECURITY (CLAUDE.md #3 fail-closed, #11 egress): this exposes the full tool
// surface, so it is gated to STRICT loopback (isTrustedLoopback: socket peer is
// 127.0.0.1/::1 AND no X-Forwarded-For) and refuses everything else — the SAME
// boundary the measurement/claims/account/internal routes already use in V1.
// It NEVER binds a public port (it rides on server-rest's 127.0.0.1 listener) and
// adds NO new egress: the `reply` tool still flows agent → AGENT_URL → the
// daemon's loopback chokepoint → Telegram. This is a separate path from the
// OAuth-guarded remote /mcp (src/server-http.js) — that one is unchanged.
//
// Lifted from server-http.js:240-385 MINUS auth and MINUS per-session boot(): we
// reuse the app's single open vault by building a fresh McpServer from the SAME
// `tools`/`handlers` per session (createMcpServer opens no db — src/mcp.js:229).
import { randomUUID } from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './mcp.js';
import { isTrustedLoopback } from './http/loopback.js';

/**
 * Build the loopback MCP router. Mount with: app.use(mcpLoopbackRouter({ tools, handlers }))
 * @param {object} deps
 * @param {Array} deps.tools     the app's assembled tool list (reply included when AGENT_URL set)
 * @param {Record<string,Function>} deps.handlers  tool name → handler
 * @param {string} [deps.path='/internal/mcp']
 */
export function mcpLoopbackRouter({ tools, handlers, path = '/internal/mcp' }) {
  const router = express.Router();

  // sessionId → { transport }. One McpServer per transport (SDK is 1:1), all
  // closing over the SAME open vault via the shared tools/handlers closures.
  const transports = new Map();

  const handler = async (req, res) => {
    // Fail closed: only a genuine local request may reach the tool surface.
    if (!isTrustedLoopback(req)) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Forbidden: loopback only' },
        id: null,
      });
      return;
    }

    try {
      const sessionId = req.headers['mcp-session-id'];

      // Existing session → route to its stored transport (handles POST/GET/DELETE).
      if (sessionId && transports.has(sessionId)) {
        await transports.get(sessionId).transport.handleRequest(req, res, req.body);
        return;
      }

      // No known session: only an `initialize` POST may open one.
      if (req.method === 'POST' && isInitializeRequest(req.body)) {
        const server = createMcpServer({ tools, handlers });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => { transports.set(sid, { transport }); },
        });
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // Anything else without a valid session is a protocol error.
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: no valid session for a non-initialize request' },
        id: null,
      });
    } catch {
      // Never leak internals/plaintext; fail closed.
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  };

  // JSON parsing is scoped to THIS route only (not router.use) so it never
  // shadows the malformed-body handling of the sibling /api/v1/* tool router.
  router.all(path, express.json({ limit: '4mb' }), handler);
  return router;
}
