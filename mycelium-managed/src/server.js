// server.js — the managed control-plane API. Self-hostable; mycelium runs an
// instance. Verifies an ACTION-BOUND ed25519 handle claim (the same claimMessage
// the client signs), provisions acme-dns + apex DNS + a per-tenant FRP token,
// records it in the registry. It NEVER sees the master key or any vault data —
// only {action, handle, publicKey, nonce, signature}, verified with the public
// key alone.
//
// Abuse-hardened: per-IP rate limit on every endpoint + a global daily NEW-handle
// cap (stay under the CA's per-registered-domain weekly ceiling) + TOCTOU-safe
// atomic claim BEFORE external side-effects, with rollback on failure.
import express from 'express';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyWithPublicKey, isValidHandle } from '../../src/identity/identity.js';
import { claimMessage } from '../../src/remote/managed-claim.js';
import { openRegistry } from './registry.js';
import { createNonceStore } from './nonce.js';
import { createDnsClient } from './dns.js';
import { createAcmeDnsClient } from './acmedns.js';
import { createRelayHook } from './relay-hook.js';
import { createRateLimiter, createDailyCap } from './ratelimit.js';

// Never handed out (impersonation / infra names).
export const RESERVED = new Set(['admin', 'root', 'www', 'api', 'mcp', 'auth', 'connect', 'acme', 'acme-dns', 'relay', 'ns', 'mail', 'mycelium', 'anthropic', 'claude', 'support', 'help', 'status', 'app', 'id', 'docs']);

export function createControlPlane({ registry, dns, acmeDns, nonces, relayAddr, zone = 'mycelium.id', acmeDnsServer, bwLimit = '2MB', rateLimit, dailyCap }) {
  const app = express();
  // Behind the relay / Cloudflare → derive the client IP from X-Forwarded-For
  // (trust ONE hop). The rate limiter keys on req.ip.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '16kb' }));

  const limiter = rateLimit || createRateLimiter({ capacity: 20, refillPerMin: 20 });
  const newHandleCap = dailyCap || createDailyCap({ max: Number(process.env.MYC_MAX_NEW_HANDLES_PER_DAY) || 40 });
  const limit = (req, res, next) => {
    if (limiter.allow(req.ip)) return next();
    res.status(429).json({ ok: false, error: 'rate limited' });
  };

  app.get('/v1/challenge', limit, (_req, res) => {
    res.json({ nonce: nonces.issue() });
  });

  app.get('/v1/handle/:h', limit, (req, res) => {
    const h = String(req.params.h || '').toLowerCase();
    if (!isValidHandle(h)) { res.status(400).json({ ok: false, error: 'invalid handle' }); return; }
    res.json({ ok: true, handle: h, available: !(RESERVED.has(h) || !!registry.get(h)) });
  });

  app.post('/v1/provision', limit, async (req, res) => {
    try {
      const { handle, publicKey, nonce, signature } = req.body || {};
      const h = String(handle || '').toLowerCase();
      if (!isValidHandle(h)) { res.status(400).json({ ok: false, error: 'invalid handle' }); return; }
      if (RESERVED.has(h)) { res.status(409).json({ ok: false, error: 'handle reserved' }); return; }
      if (typeof publicKey !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string') {
        res.status(400).json({ ok: false, error: 'malformed claim' }); return;
      }
      // Replay protection THEN action-bound signature — both fail-closed.
      if (!nonces.consume(nonce)) { res.status(401).json({ ok: false, error: 'nonce invalid or expired' }); return; }
      if (!verifyWithPublicKey(publicKey, claimMessage('provision', h, nonce), signature)) {
        res.status(401).json({ ok: false, error: 'signature invalid' }); return;
      }

      // ATOMIC claim BEFORE any external side-effect (TOCTOU-safe). Same key reclaims.
      const claimed = registry.claim({ handle: h, publicKey });
      if (!claimed.ok) { res.status(409).json({ ok: false, error: 'handle already claimed' }); return; }
      // Self-throttle NEW handles to stay under the CA's per-domain weekly cap.
      if (!claimed.reclaimed && !newHandleCap.tryConsume()) {
        registry.remove({ handle: h, publicKey });
        res.status(503).json({ ok: false, error: 'new-handle quota reached; try again later' }); return;
      }

      let reg;
      try {
        reg = await acmeDns.register();
        await dns.createHandleRecords({ handle: h, acmeFulldomain: reg.fulldomain });
      } catch {
        // Roll back ONLY a fresh claim — never delete an existing (reclaimed) registration.
        if (!claimed.reclaimed) {
          try { await dns.deleteHandleRecords({ handle: h }); } catch { /* best-effort */ }
          registry.remove({ handle: h, publicKey });
          newHandleCap.refund();
        }
        res.status(502).json({ ok: false, error: 'provisioning backend failed' }); return;
      }

      const frpsToken = crypto.randomBytes(24).toString('base64url');
      registry.finalize({ handle: h, frpsToken, acmeSubdomain: reg.subdomain });

      res.json({
        ok: true,
        host: `${h}.${zone}`,
        relayAddr,
        relayToken: frpsToken,
        acmeDns: { username: reg.username, password: reg.password, subdomain: reg.subdomain, serverUrl: acmeDnsServer },
        reclaimed: !!claimed.reclaimed,
      });
    } catch {
      res.status(500).json({ ok: false, error: 'provision failed' });
    }
  });

  app.post('/v1/release', limit, async (req, res) => {
    const { handle, publicKey, nonce, signature } = req.body || {};
    const h = String(handle || '').toLowerCase();
    if (!nonces.consume(nonce)) { res.status(401).json({ ok: false, error: 'nonce invalid or expired' }); return; }
    if (!verifyWithPublicKey(publicKey, claimMessage('release', h, nonce), signature)) {
      res.status(401).json({ ok: false, error: 'signature invalid' }); return;
    }
    const row = registry.get(h);
    if (!row) { res.json({ ok: true }); return; }                 // already gone — idempotent
    if (row.public_key !== publicKey) { res.status(403).json({ ok: false, error: 'not owner' }); return; }
    // Tear down DNS (frees the name for everyone, orphans the acme-dns subdomain
    // harmlessly), then drop the registry row (invalidating the relay token).
    try { await dns.deleteHandleRecords({ handle: h }); } catch { /* best-effort */ }
    try { await acmeDns.deregister({ subdomain: row.acme_subdomain }); } catch { /* no-op */ }
    registry.release({ handle: h, publicKey });
    res.json({ ok: true });
  });

  // FRP NewProxy/Login auth-hook: per-tenant hostname binding (reads the registry).
  app.post('/frps/handler', createRelayHook(registry, { zone, bandwidthLimit: bwLimit }));

  return { app };
}

export function main() {
  const port = Number(process.env.PORT) || 8790;
  const zone = process.env.MYC_ZONE || 'mycelium.id';
  const relayAddr = process.env.MYC_RELAY_ADDR || '';
  const acmeDnsServer = process.env.MYC_ACME_DNS || '';
  const registry = openRegistry(process.env.MYC_REGISTRY_DB || './registry.db');
  const nonces = createNonceStore({ db: registry.db }); // shared store: HA + restart-survival
  nonces.startSweeper(); // periodic expiry sweep
  const dns = createDnsClient({
    provider: process.env.MYC_DNS_PROVIDER || 'mock',
    token: process.env.MYC_DNS_TOKEN,
    zone,
    relayIp: process.env.MYC_RELAY_IP,
  });
  // The register URL can differ from the public URL handed to clients: in a
  // hardened deploy acme-dns /register is loopback-only
  // (MYC_ACME_DNS_REGISTER=http://127.0.0.1:8081) while the Mac's Caddy reaches
  // /update at the public MYC_ACME_DNS. Defaults to the public URL (back-compat).
  const acmeDnsRegister = process.env.MYC_ACME_DNS_REGISTER || acmeDnsServer;
  const acmeDns = createAcmeDnsClient({ serverUrl: acmeDnsRegister, mock: process.env.MYC_ACME_DNS_MOCK === '1' });
  const { app } = createControlPlane({ registry, dns, acmeDns, nonces, relayAddr, zone, acmeDnsServer, bwLimit: process.env.MYC_BW_LIMIT || '2MB' });
  // Bind host: default all-interfaces (back-compat), but a deployment SHOULD set
  // MYC_BIND_HOST=127.0.0.1 so the control-plane — including the /frps/handler token
  // oracle — is loopback-only, reachable by the co-located frps + Caddy edge but
  // NEVER the public internet. Defence-in-depth alongside the host/cloud firewall.
  const bindHost = process.env.MYC_BIND_HOST || '0.0.0.0';
  app.listen(port, bindHost, () => console.log(`[mycelium-managed] control-plane on ${bindHost}:${port} (zone=${zone}, dns=${dns.provider})`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
