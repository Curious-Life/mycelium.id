// Connector HTTP routes — list status, connect (OAuth or local), OAuth
// callback, disconnect, manual sync. Backed by the connector runner
// (src/connectors/scheduler.js). Localhost-only, behind the vault-init guard.
//
//   GET    /portal/connectors                 → { connectors: [status...] }
//   POST   /portal/connectors/:id/connect     → { authUrl } (OAuth) | { status:'connected' }
//   GET    /portal/connectors/:id/callback    → OAuth redirect lands here (HTML)
//   POST   /portal/connectors/:id/disconnect  → { ok, status:'disconnected' }
//   POST   /portal/connectors/:id/sync        → run one sync now { pulled, created, deduped }

import express from 'express';

const statusFor = (r) => (r.error === 'unknown_adapter' ? 404 : 400);

export function portalConnectorsRouter({ runner }) {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  router.get('/connectors', async (_req, res) => {
    try {
      res.json({ connectors: await runner.status() });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
    }
  });

  router.post('/connectors/:id/connect', async (req, res) => {
    try {
      const r = await runner.connect(req.params.id, req.body || {});
      res.status(r.ok ? 200 : statusFor(r)).json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  });

  // OAuth redirect target — hit by the browser, returns a tiny HTML page.
  // Never interpolates untrusted text into the HTML (no reflected-XSS surface).
  router.get('/connectors/:id/callback', async (req, res) => {
    try {
      const r = await runner.handleCallback(req.params.id, { code: req.query.code, state: req.query.state });
      if (r.ok) {
        return res.type('html').send('<!doctype html><meta charset="utf-8"><title>Connected</title><body style="font-family:system-ui;padding:2rem">Connected. You can close this window and return to Mycelium.<script>setTimeout(()=>{try{window.close()}catch(e){}},800)</script></body>');
      }
      return res.status(400).type('html').send('<!doctype html><meta charset="utf-8"><title>Connection failed</title><body style="font-family:system-ui;padding:2rem">Connection failed. Please return to Mycelium and try again.</body>');
    } catch {
      res.status(500).type('html').send('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem">Connection error.</body>');
    }
  });

  router.post('/connectors/:id/disconnect', async (req, res) => {
    try {
      res.json(await runner.disconnect(req.params.id));
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  });

  router.post('/connectors/:id/sync', async (req, res) => {
    try {
      const r = await runner.runSync(req.params.id, { force: true });
      res.status(r.ok ? 200 : statusFor(r)).json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  });

  return router;
}
