// src/remote/router.js — localhost-only control surface for remote access,
// mounted at /api/v1/remote (server-rest.js). Lets the local UI set the operator
// password (the OAuth gate) and read/patch the non-secret remote config. Same
// trust model as account/router.js: single-user, loopback-only (defence in
// depth — these touch the auth gate). Never returns a secret value.
import express from 'express';
import net from 'node:net';
import path from 'node:path';
import { readRemoteConfig, writeRemoteConfig, setOperatorPassword, operatorUserExists, setRemoteSecret } from './config.js';
import { buildClaim } from './managed-claim.js';
import { materializeRemoteConfigs } from './runtime.js';
import { dataDir } from '../paths.js';
import { keychainNames } from '../account/keychain-names.js';

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

  // Local stdio connect params for THIS Mac — the Settings "Connect on this Mac"
  // helper renders a ready-to-paste .mcp.json (Claude Code / Claude Desktop) from
  // these. Surfaces the ACTUAL keychain account names + data dir THIS server uses
  // so the pasted config opens the SAME vault — a mismatched MYCELIUM_DATA_DIR or
  // KC account is the #1 "connected but no data" gotcha (docs/MCP-CONNECT-AND-TEST.md).
  // No secrets — only paths + non-secret service names.
  router.get('/local-config', (_req, res) => {
    const home = process.env.MYCELIUM_HOME || process.cwd();
    const kc = keychainNames();
    const custom = kc.account !== 'mycelium'
      || kc.userService !== 'mycelium-user-master'
      || kc.systemService !== 'mycelium-system-key';
    res.json({
      command: process.execPath,
      args: [path.join(home, 'src', 'index.js')],
      cwd: home,
      keySource: process.env.MYCELIUM_KEY_SOURCE || 'env',
      dataDir: dataDir(),
      keychain: { account: kc.account, userService: kc.userService, systemService: kc.systemService, custom },
    });
  });

  // ── Managed connect: claim <handle>.mycelium.id via the control-plane ──
  // Signs an ed25519 handle claim with the in-process master key (boot() set
  // ENCRYPTION_MASTER_KEY), provisions via the control plane, stores the relay
  // token + acme-dns creds as SECRETS (auth.db), writes the non-secret coords to
  // remote.json, and materializes frpc.toml + Caddyfile. The tunnel + Caddy start
  // on the next app launch (Tauri reconcile). The control plane only ever sees
  // {handle, publicKey, nonce, signature} — never the master key or vault data.
  async function cpFetch(url, opts, ms = 15000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ac.signal }); }
    finally { clearTimeout(t); }
  }

  router.get('/managed/available', async (req, res) => {
    const handle = String(req.query.handle || '').trim();
    const base = readRemoteConfig().controlPlaneUrl.replace(/\/$/, '');
    try {
      const r = await cpFetch(`${base}/v1/handle/${encodeURIComponent(handle)}`);
      const data = await r.json().catch(() => ({}));
      res.status(r.ok ? 200 : r.status).json(data);
    } catch {
      res.status(502).json({ ok: false, error: 'control plane unreachable' });
    }
  });

  router.post('/connect-managed', async (req, res) => {
    const handle = String(req.body?.handle || '').trim();
    const base = String(req.body?.controlPlaneUrl || readRemoteConfig().controlPlaneUrl).replace(/\/$/, '');
    const masterHex = process.env.ENCRYPTION_MASTER_KEY;
    if (!masterHex) { res.status(503).json({ ok: false, error: 'vault is locked — finish setup first' }); return; }
    try {
      const chRes = await cpFetch(`${base}/v1/challenge`);
      if (!chRes.ok) throw new Error('challenge failed');
      const { nonce } = await chRes.json();
      const claim = buildClaim({ handle, nonce, masterHex }); // throws on invalid handle/nonce
      const pvRes = await cpFetch(`${base}/v1/provision`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(claim),
      });
      const data = await pvRes.json().catch(() => ({}));
      if (!pvRes.ok) { res.status(pvRes.status === 409 ? 409 : 400).json({ ok: false, error: data.error || 'provision failed' }); return; }
      const { host, relayAddr, relayToken, acmeDns } = data;
      if (!host || !relayAddr || !relayToken || !acmeDns) throw new Error('incomplete control-plane response');
      setRemoteSecret('relayToken', relayToken);
      setRemoteSecret('acmeDns', JSON.stringify(acmeDns));
      writeRemoteConfig({ remoteMode: 'managed', publicHost: host, relayAddr });
      materializeRemoteConfigs({ dataDir: dataDir(), config: readRemoteConfig(), relayToken, acmeDns });
      res.json({ ok: true, host, connectorUrl: `https://${host}/mcp`, restartRequired: true });
    } catch (err) {
      const caller = /invalid handle|nonce/i.test(String(err?.message || ''));
      res.status(caller ? 400 : 502).json({ ok: false, error: caller ? err.message : 'could not reach the control plane' });
    }
  });

  // Disconnect any remote mode: stop on next launch + remove sidecar configs.
  router.post('/disconnect', (_req, res) => {
    try {
      writeRemoteConfig({ remoteMode: 'off', remoteEnabled: false });
      materializeRemoteConfigs({ dataDir: dataDir(), config: readRemoteConfig() });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false, error: 'could not disconnect' });
    }
  });

  return router;
}

export default remoteRouter;
