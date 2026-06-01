/**
 * Express middleware adapter — wraps a guardian as connect-style middleware.
 *
 * Usage:
 *   app.use('/portal', toMiddleware(portalAuthGuardian, { on401: 'redirect' }));
 *
 * Behavior:
 *   - Calls guardian.check(ctx) with request metadata.
 *   - On allow: attaches principal to req._guardian, calls next().
 *   - On deny: responds per `on401` policy ('json' | 'redirect' | 'status-only').
 *
 * The middleware NEVER bubbles exceptions — the guardian's own fail-closed
 * behavior handles errors. If you need custom deny handling, wire a
 * guardian directly and call next(err) yourself from the handler.
 */

export function toMiddleware(guardian, opts = {}) {
  const on401 = opts.on401 || 'json';
  const loginPath = opts.loginPath || '/login';

  return async function guardianMiddleware(req, res, next) {
    const ctx = buildRequestContext(req);
    const result = await guardian.check(ctx);

    if (result.allow) {
      // Attach principal for downstream handlers without globals.
      if (result.principal) {
        req._guardian = req._guardian || {};
        req._guardian[guardian.id] = result.principal;
      }
      return next();
    }

    // Deny path. Never leak the reason to the wire verbatim — only to logs.
    if (on401 === 'redirect') {
      const next_path = encodeURIComponent(req.originalUrl || req.url || '/');
      return res.redirect(302, `${loginPath}?next=${next_path}`);
    }
    if (on401 === 'status-only') {
      return res.status(401).end();
    }
    // default: json
    return res.status(401).json({
      error: 'Unauthorized',
      // Safe: `reason` is a stable enum, not user input.
      reason: result.reason || 'unspecified',
    });
  };
}

export function buildRequestContext(req) {
  return {
    request: req,
    ip: req.ip || req.socket?.remoteAddress || null,
    method: req.method,
    path: req.path || (req.url || '').split('?')[0],
    headers: req.headers || {},
  };
}
