// src/remote/router.js — localhost-only control surface for remote access,
// mounted at /api/v1/remote (server-rest.js). Lets the local UI set the operator
// password (the OAuth gate) and read/patch the non-secret remote config. Same
// trust model as account/router.js: single-user, loopback-only (defence in
// depth — these touch the auth gate). Never returns a secret value.
import express from 'express';
import net from 'node:net';
import { readRemoteConfig, writeRemoteConfig, setOperatorPassword, operatorUserExists } from './config.js';

/** Is the remote OAuth server actually listening (so the UI shows live state vs
 *  "enabled — restart to apply")? Best-effort TCP probe; never throws. */
function probeListening(port, host = '127.0.0.1', timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => { try { sock.destroy(); } catch { /* */ } resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

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
  router.get('/status', async (_req, res) => {
    const rc = readRemoteConfig();
    const port = Number(process.env.MYCELIUM_PORT) || 4711;
    res.json({
      remoteEnabled: rc.remoteEnabled,
      publicBaseUrl: rc.publicBaseUrl,
      operatorEmail: rc.operatorEmail,
      passwordSet: operatorUserExists(),
      httpListening: await probeListening(port),
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
