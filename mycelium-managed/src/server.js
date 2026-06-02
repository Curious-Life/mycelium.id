// server.js — the managed control-plane API. Self-hostable; mycelium runs an
// instance. Verifies an ed25519 handle claim (the SAME claimMessage the client
// signs), provisions acme-dns + apex DNS + a per-tenant FRP token, records it in
// the registry. It NEVER sees the master key or any vault data — only
// {handle, publicKey, nonce, signature}, and verifies with the public key alone.
import express from 'express';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyWithPublicKey, isValidHandle } from '../../src/identity/identity.js';
import { claimMessage } from '../../src/remote/managed-claim.js';
import { openRegistry } from './registry.js';
import { createNonceStore } from './nonce.js';
import { createDnsClient } from './dns.js';
import { createAcmeDnsClient } from './acmedns.js';

// Never handed out (impersonation / infra names).
export const RESERVED = new Set(['admin', 'root', 'www', 'api', 'mcp', 'auth', 'connect', 'acme', 'acme-dns', 'relay', 'ns', 'mail', 'mycelium', 'anthropic', 'claude', 'support', 'help', 'status', 'app', 'id', 'docs']);

export function createControlPlane({ registry, dns, acmeDns, nonces, relayAddr, zone = 'mycelium.id', acmeDnsServer }) {
  const app = express();
  app.use(express.json({ limit: '16kb' }));

  app.get('/v1/challenge', (_req, res) => {
    res.json({ nonce: nonces.issue() });
  });

  app.get('/v1/handle/:h', (req, res) => {
    const h = String(req.params.h || '').toLowerCase();
    if (!isValidHandle(h)) { res.status(400).json({ ok: false, error: 'invalid handle' }); return; }
    res.json({ ok: true, handle: h, available: !(RESERVED.has(h) || !!registry.get(h)) });
  });

  app.post('/v1/provision', async (req, res) => {
    try {
      const { handle, publicKey, nonce, signature } = req.body || {};
      const h = String(handle || '').toLowerCase();
      if (!isValidHandle(h)) { res.status(400).json({ ok: false, error: 'invalid handle' }); return; }
      if (RESERVED.has(h)) { res.status(409).json({ ok: false, error: 'handle reserved' }); return; }
      if (typeof publicKey !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string') {
        res.status(400).json({ ok: false, error: 'malformed claim' }); return;
      }
      // Replay protection THEN signature — both fail-closed.
      if (!nonces.consume(nonce)) { res.status(401).json({ ok: false, error: 'nonce invalid or expired' }); return; }
      if (!verifyWithPublicKey(publicKey, claimMessage(h, nonce), signature)) {
        res.status(401).json({ ok: false, error: 'signature invalid' }); return;
      }
      // Reject a taken handle BEFORE external side-effects (no wasted acme-dns reg).
      const owned = registry.get(h);
      if (owned && owned.public_key !== publicKey) { res.status(409).json({ ok: false, error: 'handle already claimed' }); return; }

      const reg = await acmeDns.register();
      await dns.createHandleRecords({ handle: h, acmeFulldomain: reg.fulldomain });
      const frpsToken = crypto.randomBytes(24).toString('base64url');
      const r = registry.reserve({ handle: h, publicKey, frpsToken, acmeSubdomain: reg.subdomain });
      if (!r.ok) { res.status(409).json({ ok: false, error: 'handle already claimed' }); return; }

      res.json({
        ok: true,
        host: `${h}.${zone}`,
        relayAddr,
        relayToken: frpsToken,
        acmeDns: { username: reg.username, password: reg.password, subdomain: reg.subdomain, serverUrl: acmeDnsServer },
        reclaimed: !!r.reclaimed,
      });
    } catch {
      res.status(500).json({ ok: false, error: 'provision failed' });
    }
  });

  app.post('/v1/release', (req, res) => {
    const { handle, publicKey, nonce, signature } = req.body || {};
    const h = String(handle || '').toLowerCase();
    if (!nonces.consume(nonce)) { res.status(401).json({ ok: false, error: 'nonce invalid or expired' }); return; }
    if (!verifyWithPublicKey(publicKey, claimMessage(h, nonce), signature)) {
      res.status(401).json({ ok: false, error: 'signature invalid' }); return;
    }
    const r = registry.release({ handle: h, publicKey });
    res.status(r.ok ? 200 : 403).json(r.ok ? { ok: true } : { ok: false, error: 'not owner' });
  });

  return { app };
}

export function main() {
  const port = Number(process.env.PORT) || 8790;
  const zone = process.env.MYC_ZONE || 'mycelium.id';
  const relayAddr = process.env.MYC_RELAY_ADDR || '';
  const acmeDnsServer = process.env.MYC_ACME_DNS || '';
  const registry = openRegistry(process.env.MYC_REGISTRY_DB || './registry.db');
  const nonces = createNonceStore();
  const dns = createDnsClient({
    provider: process.env.MYC_DNS_PROVIDER || 'mock',
    token: process.env.MYC_DNS_TOKEN,
    zone,
    relayIp: process.env.MYC_RELAY_IP,
  });
  const acmeDns = createAcmeDnsClient({ serverUrl: acmeDnsServer, mock: process.env.MYC_ACME_DNS_MOCK === '1' });
  const { app } = createControlPlane({ registry, dns, acmeDns, nonces, relayAddr, zone, acmeDnsServer });
  app.listen(port, () => console.log(`[mycelium-managed] control-plane on :${port} (zone=${zone}, dns=${dns.provider})`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
