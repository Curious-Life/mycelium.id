// src/remote/router.js — localhost-only control surface for remote access,
// mounted at /api/v1/remote (server-rest.js). Lets the local UI set the operator
// password (the OAuth gate) and read/patch the non-secret remote config. Same
// trust model as account/router.js: single-user, loopback-only (defence in
// depth — these touch the auth gate). Never returns a secret value.
import express from 'express';
import net from 'node:net';
import path from 'node:path';
import { readRemoteConfig, writeRemoteConfig, setOperatorPassword, operatorUserExists, passkeyEnrolled } from './config.js';
import { buildClaim } from './managed-claim.js';
import { materializeRemoteConfigs } from './runtime.js';
import { dataDir } from '../paths.js';
import { keychainNames } from '../account/keychain-names.js';
import { isTrustedLoopback } from '../http/loopback.js';
// The ONE handle writer — see src/identity/handle-service.js. `connect-managed`
// and PUT /portal/profile are both thin callers of setHandle().
import { setHandle, checkAvailability, mirrorProfileHandle, firstLabel } from '../identity/handle-service.js';

// Untrusted-input guards for the managed-connect flow: both the control-plane URL
// and its response flow into config files / env, so validate hard.
function isHttpsOrLocal(u) {
  try { const x = new URL(u); return x.protocol === 'https:' || x.hostname === 'localhost' || x.hostname === '127.0.0.1'; }
  catch { return false; }
}

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

/**
 * @param {object} [deps]
 * @param {() => any} [deps.getDb]      lazy vault handle (this router mounts BEFORE the
 *                                      vault guard, so the db may not exist yet)
 * @param {() => string} [deps.getUserId]
 */
export function remoteRouter({ getDb = () => null, getUserId = () => null } = {}) {
  const router = express.Router();
  // The DERIVED user_profiles.handle mirror. Best-effort + late-bound: the mirror
  // is a cache of publicHost, never the authority.
  const mirrorHandle = (h) => mirrorProfileHandle(getDb(), getUserId(), h);
  router.use(express.json({ limit: '16kb' }));

  // Loopback-only (mirrors account/router.js). isTrustedLoopback also rejects
  // reverse-proxied (X-Forwarded-For) requests, so the operator-password setter
  // stays unreachable over the relay even if path-routed there (V-1).
  router.use((req, res, next) => {
    if (isTrustedLoopback(req)) return next();
    return res.status(403).json({ error: 'forbidden' });
  });

  // Current remote-access state for the Settings panel. No secrets.
  router.get('/status', async (_req, res) => {
    const rc = readRemoteConfig();
    const port = Number(process.env.MYCELIUM_PORT) || 4711;
    res.json({
      remoteEnabled: rc.remoteEnabled,
      publicBaseUrl: rc.publicBaseUrl,
      remoteMode: rc.remoteMode,
      publicHost: rc.publicHost,
      operatorEmail: rc.operatorEmail,
      passwordSet: operatorUserExists(),
      // Require-passkey-for-web: the current policy + whether a passkey is enrolled
      // (the Settings toggle can only be ENABLED once a passkey exists).
      requirePasskeyForWeb: rc.requirePasskeyForWeb === true,
      passkeyEnrolled: passkeyEnrolled(),
      httpListening: await probeListening(port),
      // Non-secret transport coords for the own-relay / own-domain UI (O9).
      controlPlaneUrl: rc.controlPlaneUrl || '',
      relayAddr: rc.relayAddr || '',
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
  //
  // WHITELIST the keys accepted from this untrusted body (default-deny). This door
  // is loopback-only but loopback is NOT a trust boundary here: any same-uid process
  // (a foreign-lineage MCP, any local script) can POST it with ZERO password /
  // master-key / control-plane proof. The keys that grant a FEDERATION IDENTITY —
  // `publicHost` (the DID/WebFinger host), `desiredHandle`, and `remoteMode:'managed'`
  // (the managed-claim marker) — are NOT accepted here; identity is written solely by
  // identity/handle-service.setHandle() behind the managed-claim ceremony (which signs
  // with the in-process master key). Without this whitelist a TWO-STEP poke
  // (`publicHost:''` then `publicHost:'attacker'`) walks around writeRemoteConfig's
  // set-once guard — step 1 clears to '' (allowed, fail-closed), step 2 then sees an
  // empty currentHost and claims the attacker host — silently re-pointing did:web /
  // WebFinger and orphaning every pinned peer. So gate the DOOR, not just the store.
  // Legit callers (RemoteAccessSection.svelte saveConfig) only ever send these:
  const ALLOWED_CONFIG_KEYS = new Set([
    'publicBaseUrl', 'remoteEnabled', 'requirePasskeyForWeb',
    'remoteMode', 'controlPlaneUrl', 'relayAddr',
  ]);
  router.post('/config', (req, res) => {
    try {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const patch = {};
      for (const k of Object.keys(body)) {
        if (ALLOWED_CONFIG_KEYS.has(k)) patch[k] = body[k];
      }
      // `managed` is the identity-bearing mode (it pairs with a publicHost claim); it
      // must only be set by the managed-claim ceremony (handle-service), never from a
      // raw config poke. own-relay/off/direct are transport-only and stay allowed.
      if (patch.remoteMode === 'managed') delete patch.remoteMode;
      // Guard: don't let the policy be enabled before a passkey exists (would be a
      // no-op anyway — enforcement also gates on passkeyEnrolled — but reject clearly
      // so the UI can't show a misleading "on" with nothing protecting it).
      if (patch.requirePasskeyForWeb === true && !passkeyEnrolled()) {
        res.status(400).json({ ok: false, error: 'enroll a passkey before requiring one for web sign-in' });
        return;
      }
      const next = writeRemoteConfig(patch);
      res.json({
        ok: true,
        config: {
          publicBaseUrl: next.publicBaseUrl || '', operatorEmail: next.operatorEmail || '',
          remoteEnabled: next.remoteEnabled === true, requirePasskeyForWeb: next.requirePasskeyForWeb === true,
        },
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

  // Availability — delegates to the ONE check (identity/handle-service), the same
  // one the portal's /profile/handle/check now uses, so the two surfaces can never
  // disagree about whether a name is free.
  router.get('/managed/available', async (req, res) => {
    res.json(await checkAvailability(req.query.handle));
  });

  // Public Turnstile SITEKEY for the connect widget — proxied from the control
  // plane's /v1/config so the app never bakes in a key. NON-SECRET (the secret
  // stays in the control-plane env). Best-effort + fail-open to null: a sitekey
  // we can't fetch just means "no widget"; the /v1/challenge gate is the real
  // boundary, so a missing widget degrades to a clear 'bot check failed', never
  // to a bypass.
  router.get('/managed/turnstile', async (_req, res) => {
    const base = readRemoteConfig().controlPlaneUrl.replace(/\/$/, '');
    if (!isHttpsOrLocal(base)) { res.json({ sitekey: null, origin: null }); return; }
    // The widget embeds <origin>/turnstile in a cross-origin iframe and accepts a
    // token only from this exact origin — so hand back both the sitekey and the
    // control-plane origin it must validate against.
    let origin = null;
    try { origin = new URL(base).origin; } catch { origin = null; }
    try {
      const r = await cpFetch(`${base}/v1/config`);
      const data = await r.json().catch(() => ({}));
      const sitekey = typeof data?.turnstileSitekey === 'string' && data.turnstileSitekey ? data.turnstileSitekey : null;
      res.json({ sitekey, origin: sitekey ? origin : null });
    } catch {
      res.json({ sitekey: null, origin: null });
    }
  });

  // Claim <handle>.mycelium.id — a THIN WRAPPER over the ONE setter
  // (src/identity/handle-service.js). The provisioning body (challenge → signed
  // claim → provision → validate → persist → materialize) moved there verbatim so
  // this surface and PUT /portal/profile can never diverge again.
  // `requireProvision: true` — this surface INSISTS on a live claim; it must never
  // degrade to "recorded your intent".
  router.post('/connect-managed', async (req, res) => {
    try {
      const r = await setHandle({
        handle: req.body?.handle,
        turnstileToken: typeof req.body?.turnstileToken === 'string' ? req.body.turnstileToken : '',
        requireProvision: true,
        mirror: (h) => mirrorHandle(h),
      });
      res.json({ ok: true, host: r.host, connectorUrl: r.connectorUrl, restartRequired: r.restartRequired });
    } catch (e) {
      const status = Number.isInteger(e?.status) ? e.status : 400;
      const body = { ok: false, error: e?.message || 'could not connect' };
      if (e?.code === 'payment_required' && e.checkoutUrl) body.checkoutUrl = e.checkoutUrl;
      res.status(status).json(body);
    }
  });

  // Manage billing (O7): sign a 'billing' claim with the master key and exchange
  // it at the control plane for a one-time Stripe Customer Portal URL (cancel /
  // update card / see paid_until). The UI opens the returned https URL. Only a
  // managed tenant with the vault key can do this; the URL is validated https.
  router.get('/managed/billing-portal', async (_req, res) => {
    const rc = readRemoteConfig();
    const masterHex = process.env.ENCRYPTION_MASTER_KEY;
    if (rc.remoteMode !== 'managed' || !rc.publicHost) { res.status(400).json({ ok: false, error: 'not on a managed address' }); return; }
    if (!masterHex) { res.status(503).json({ ok: false, error: 'vault is locked — finish setup first' }); return; }
    const base = rc.controlPlaneUrl.replace(/\/$/, '');
    if (!isHttpsOrLocal(base)) { res.status(400).json({ ok: false, error: 'control plane URL must be https' }); return; }
    const handle = firstLabel(rc.publicHost);
    try {
      const nRes = await cpFetch(`${base}/v1/billing/nonce`);
      if (!nRes.ok) throw new Error('nonce failed');
      const { nonce } = await nRes.json();
      const claim = buildClaim({ action: 'billing', handle, nonce, masterHex });
      const pRes = await cpFetch(`${base}/v1/billing/portal`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(claim),
      });
      const data = await pRes.json().catch(() => ({}));
      if (pRes.status === 404) { res.status(404).json({ ok: false, error: 'no subscription on file' }); return; }
      if (!pRes.ok || typeof data.url !== 'string' || !/^https:\/\//i.test(data.url)) {
        res.status(502).json({ ok: false, error: 'could not open billing portal' }); return;
      }
      res.json({ ok: true, url: data.url });
    } catch {
      res.status(502).json({ ok: false, error: 'could not reach the control plane' });
    }
  });

  // Disconnect any remote mode: stop on next launch + remove sidecar configs.
  // For a managed handle, best-effort RELEASE it first (frees the name for
  // everyone + tears down DNS + invalidates the relay token); local-off must
  // succeed even if the release call fails.
  router.post('/disconnect', async (_req, res) => {
    try {
      const rc = readRemoteConfig();
      const masterHex = process.env.ENCRYPTION_MASTER_KEY;
      const base = rc.controlPlaneUrl.replace(/\/$/, '');
      if (rc.remoteMode === 'managed' && rc.publicHost && masterHex && isHttpsOrLocal(base)) {
        const handle = firstLabel(rc.publicHost);
        try {
          const chRes = await cpFetch(`${base}/v1/challenge`);
          if (chRes.ok) {
            const { nonce } = await chRes.json();
            const claim = buildClaim({ action: 'release', handle, nonce, masterHex });
            await cpFetch(`${base}/v1/release`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(claim) });
          }
        } catch { /* best-effort release — never block local disconnect */ }
      }
    } catch { /* never block local disconnect */ }
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
