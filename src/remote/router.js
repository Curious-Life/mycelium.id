// src/remote/router.js — localhost-only control surface for remote access,
// mounted at /api/v1/remote (server-rest.js). Lets the local UI set the operator
// password (the OAuth gate) and read/patch the non-secret remote config. Same
// trust model as account/router.js: single-user, loopback-only (defence in
// depth — these touch the auth gate). Never returns a secret value.
import express from 'express';
import { readRemoteConfig, writeRemoteConfig, setOperatorPassword, operatorUserExists } from './config.js';

export function remoteRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));

  // Loopback-only (mirrors account/router.js).
  router.use((req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    return res.status(403).json({ error: 'forbidden' });
  });

  // Current remote-access state for the Settings panel. No secrets.
  router.get('/status', (_req, res) => {
    const rc = readRemoteConfig();
    res.json({
      remoteEnabled: rc.remoteEnabled,
      publicBaseUrl: rc.publicBaseUrl,
      operatorEmail: rc.operatorEmail,
      passwordSet: operatorUserExists(),
    });
  });

  // Set the operator password (the OAuth authorize gate). Plaintext never
  // stored by us — better-auth hashes it. ≥12 chars enforced in config.js.
  router.post('/password', async (req, res) => {
    try {
      const { email } = await setOperatorPassword({ email: req.body?.email, password: req.body?.password });
      res.json({ ok: true, email });
    } catch (err) {
      const caller = /at least|required|must be|invalid/i.test(String(err?.message || ''));
      res.status(caller ? 400 : 500).json({ ok: false, error: caller ? err.message : 'could not set password' });
    }
  });

  // Patch the non-secret config (publicBaseUrl / operatorEmail / remoteEnabled).
  router.post('/config', (req, res) => {
    try {
      const next = writeRemoteConfig(req.body || {});
      res.json({
        ok: true,
        config: { publicBaseUrl: next.publicBaseUrl || '', operatorEmail: next.operatorEmail || '', remoteEnabled: next.remoteEnabled === true },
      });
    } catch {
      res.status(500).json({ ok: false, error: 'could not write config' });
    }
  });

  return router;
}

export default remoteRouter;
