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
import { createTurnstileVerifier } from './turnstile.js';
import { createBilling } from './billing.js';

// Reserve-then-pay tunables (O5). Config values, not structural — the design's
// still-open decision #4. A claimed-but-unpaid placeholder is swept after HOLD_TTL;
// GRACE absorbs Stripe dunning before a lapsed tenant is treated as unentitled.
const HOLD_TTL_MS = Number(process.env.MYC_HOLD_TTL_MS) || 30 * 60 * 1000;        // 30 min
const GRACE_MS = Number(process.env.MYC_GRACE_MS) || 3 * 24 * 60 * 60 * 1000;     // 3 days
// Immediate-access floor set at checkout.session.completed; invoice.paid refines
// paid_until to the real period end moments later.
const PROVISIONAL_MS = 34 * 24 * 60 * 60 * 1000;

// Never handed out (impersonation / infra names).
export const RESERVED = new Set(['admin', 'root', 'www', 'api', 'mcp', 'auth', 'connect', 'acme', 'acme-dns', 'relay', 'ns', 'mail', 'mycelium', 'anthropic', 'claude', 'support', 'help', 'status', 'app', 'id', 'docs']);

export function createControlPlane({ registry, dns, acmeDns, nonces, relayAddr, zone = 'mycelium.id', acmeDnsServer, bwLimit = '2MB', rateLimit, dailyCap, turnstile, turnstileSitekey, billing }) {
  const app = express();
  // Behind the relay / Cloudflare → derive the client IP from X-Forwarded-For
  // (trust ONE hop). The rate limiter keys on req.ip.
  app.set('trust proxy', 1);

  const limiter = rateLimit || createRateLimiter({ capacity: 20, refillPerMin: 20 });
  // Bot-gate (O2): disabled by default (opt-in), so self-hosters + tests run
  // without Cloudflare. When enabled, verify() fails closed on a missing/bad token.
  const botGate = turnstile || createTurnstileVerifier({});
  // Billing (O4): disabled by default (no Stripe secret) → /v1/provision skips the
  // paywall, so self-hosters + the hermetic tests provision for free.
  const pay = billing || createBilling({});
  const newHandleCap = dailyCap || createDailyCap({ max: Number(process.env.MYC_MAX_NEW_HANDLES_PER_DAY) || 40 });
  const limit = (req, res, next) => {
    if (limiter.allow(req.ip)) return next();
    res.status(429).json({ ok: false, error: 'rate limited' });
  };

  // Stripe webhook — registered BEFORE express.json so it gets the RAW bytes the
  // signature is computed over (re-serializing would change them and break verify).
  // FAIL-CLOSED: an unverifiable signature → 400, no entitlement change. The event
  // binds to a tenant by client_reference_id / subscription metadata (set at
  // checkout), falling back to the customer→publicKey reverse lookup.
  app.post('/v1/stripe/webhook', limit, express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const event = pay.verifyWebhook(req.body, req.headers['stripe-signature']);
    if (!event) { res.status(400).json({ ok: false, error: 'bad signature' }); return; }
    try {
      const obj = event.data?.object || {};
      const customerId = typeof obj.customer === 'string' ? obj.customer : null;
      const pkFrom = (o) =>
        o.client_reference_id
        || o.metadata?.public_key
        || o.subscription_details?.metadata?.public_key
        || (Array.isArray(o.lines?.data) && o.lines.data[0]?.metadata?.public_key)
        || null;
      let publicKey = pkFrom(obj);
      if (!publicKey && customerId) publicKey = registry.getEntitlementByCustomer(customerId)?.public_key || null;

      switch (event.type) {
        case 'checkout.session.completed':
          // Binds customer↔publicKey + grants immediate access; invoice.paid refines.
          if (publicKey) registry.setEntitlement({ publicKey, stripeCustomerId: customerId, paidUntil: Date.now() + PROVISIONAL_MS });
          break;
        case 'invoice.paid':
        case 'invoice.payment_succeeded': {
          const periodEnd = obj.lines?.data?.[0]?.period?.end;
          const paidUntil = periodEnd ? Number(periodEnd) * 1000 : Date.now() + PROVISIONAL_MS;
          if (publicKey) registry.setEntitlement({ publicKey, stripeCustomerId: customerId, paidUntil });
          break;
        }
        case 'invoice.payment_failed':
        case 'customer.subscription.deleted':
          if (publicKey) registry.clearEntitlement(publicKey);
          break;
        default: break; // unknown types → idempotent ack
      }
      res.json({ ok: true, received: true });
    } catch {
      // The signature was authentic but processing threw — let Stripe retry.
      res.status(500).json({ ok: false, error: 'webhook processing failed' });
    }
  });

  app.use(express.json({ limit: '16kb' }));

  // Public, non-secret bootstrap config for the app's connect UI. Carries ONLY
  // the Turnstile SITEKEY (public by design — the SECRET stays in env, never
  // here) so the widget can render without baking the key into the app build; a
  // null sitekey means the gate is off and the app shows no widget (the
  // /v1/challenge gate is the actual security boundary either way).
  app.get('/v1/config', limit, (_req, res) => {
    res.json({ turnstileSitekey: turnstileSitekey || null });
  });

  // Sandboxed Turnstile widget page (O2). The app embeds THIS in a cross-origin
  // <iframe>, so Cloudflare's third-party script runs in the control-plane origin
  // — NEVER in the vault portal origin (no access to its DOM / CSRF cookie). On
  // solve it postMessages ONLY the token string up to the parent; the parent
  // validates event.origin === this origin (the real check). The token is a
  // single-use human-proof, useless without the master-key provision flow, so we
  // don't lock frame-ancestors here (a harvested token buys nothing); that
  // hardening can follow once the live parent origin is confirmed in a browser.
  app.get('/turnstile', limit, (req, res) => {
    // The parent (loopback portal) passes its origin in ?o= so we can scope the
    // postMessage target. Untrusted: validate to a bounded localhost/tauri shape
    // or fall back to '*' (the parent's origin check is what enforces trust).
    const raw = typeof req.query?.o === 'string' ? req.query.o : '';
    const okOrigin = /^(https?|tauri):\/\/(localhost|127\.0\.0\.1|tauri\.localhost)(:\d{1,5})?$/.test(raw);
    const target = okOrigin ? raw : '*';
    // Inject as JS string literals, hardened against </script> / U+2028/9 breakout.
    const js = (v) => JSON.stringify(String(v)).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTs&render=explicit" async defer></script>
</head><body><div id="w"></div><script>
var SITEKEY=${js(turnstileSitekey || '')},TARGET=${js(target)};
function send(m){try{window.parent.postMessage(Object.assign({source:'mycelium-turnstile'},m),TARGET)}catch(e){}}
if(!SITEKEY){send({error:'not-configured'})}
window.onTs=function(){if(!SITEKEY)return;turnstile.render('#w',{sitekey:SITEKEY,
callback:function(t){send({token:t})},
'error-callback':function(){send({error:'challenge-error'})},
'expired-callback':function(){send({error:'expired'})}})};
</script></body></html>`);
  });

  app.get('/v1/challenge', limit, async (req, res) => {
    // Bot-gate the nonce: a bot can't provision without a nonce, and can't get a
    // nonce without solving Turnstile. The token rides in ?cf_turnstile=… (the
    // app's widget supplies it). When the gate is disabled, verify() returns true.
    const token = req.query?.cf_turnstile;
    if (!(await botGate.verify(typeof token === 'string' ? token : '', req.ip))) {
      res.status(403).json({ ok: false, error: 'bot check failed' }); return;
    }
    res.json({ nonce: nonces.issue() });
  });

  app.get('/v1/handle/:h', limit, async (req, res) => {
    const h = String(req.params.h || '').toLowerCase();
    if (!isValidHandle(h)) { res.status(400).json({ ok: false, error: 'invalid handle' }); return; }
    // Also reflect a pre-existing zone record (legacy/infra). Advisory + fail-open
    // here (a DNS hiccup shouldn't block the UI); provision re-checks fail-closed.
    let dnsTaken = false;
    try { dnsTaken = await dns.recordExists({ handle: h }); } catch { dnsTaken = false; }
    res.json({ ok: true, handle: h, available: !(RESERVED.has(h) || !!registry.get(h) || dnsTaken) });
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
      // Refuse a name that already exists in the zone (legacy site / infra / other) —
      // never create a second, conflicting record. A reclaim by the same key keeps its
      // own record, so only gate NEW claims. Fail CLOSED if we can't verify.
      if (!claimed.reclaimed) {
        let exists;
        try { exists = await dns.recordExists({ handle: h }); }
        catch { registry.remove({ handle: h, publicKey }); res.status(503).json({ ok: false, error: 'could not verify name availability' }); return; }
        if (exists) { registry.remove({ handle: h, publicKey }); res.status(409).json({ ok: false, error: 'handle unavailable' }); return; }
      }

      // ENTITLEMENT GATE (O5) — "reserve, then pay": the cert-consuming side-effects
      // below (acme-dns + DNS + frps token) run ONLY for a paid tenant. When billing
      // is enabled and this publicKey isn't entitled (within grace), we KEEP the
      // placeholder under a hold and hand back a Checkout URL — no free side-effects,
      // no daily-cap spend. Billing off (self-hosted / dev) → this whole block is
      // skipped and provisioning is free, exactly as before.
      if (pay.enabled && !registry.isEntitled(h, Date.now(), GRACE_MS)) {
        registry.setHold(h, Date.now() + HOLD_TTL_MS);
        let checkoutUrl;
        try {
          ({ url: checkoutUrl } = await pay.createCheckoutSession({ publicKey, handle: h }));
        } catch {
          // Don't strand a fresh claim with no way to pay — roll it back (a reclaim
          // of a live handle is left intact; its hold is a no-op on a finalized row).
          if (!claimed.reclaimed) registry.remove({ handle: h, publicKey });
          res.status(502).json({ ok: false, error: 'could not start checkout' }); return;
        }
        res.status(402).json({ ok: false, error: 'subscription required', checkoutUrl }); return;
      }

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
  // Bot-gate: secret is env-only (never logged); mock for staging. Off if neither set.
  const turnstile = createTurnstileVerifier({ secret: process.env.MYC_TURNSTILE_SECRET, mock: process.env.MYC_TURNSTILE_MOCK === '1' });
  // Public sitekey for the app widget (non-secret; pairs with the secret above).
  const turnstileSitekey = process.env.MYC_TURNSTILE_SITEKEY || null;
  // Billing (O4): secrets env-only, never logged/persisted. Off when MYC_STRIPE_SECRET
  // is unset (free provisioning). €1/mo + annual Price IDs from env (decision 8.1.2).
  const billing = createBilling({
    secret: process.env.MYC_STRIPE_SECRET,
    webhookSecret: process.env.MYC_STRIPE_WEBHOOK_SECRET,
    priceMonthly: process.env.MYC_STRIPE_PRICE_MONTHLY,
    priceAnnual: process.env.MYC_STRIPE_PRICE_ANNUAL,
    returnUrl: process.env.MYC_APP_RETURN_URL,
  });
  const { app } = createControlPlane({ registry, dns, acmeDns, nonces, relayAddr, zone, acmeDnsServer, bwLimit: process.env.MYC_BW_LIMIT || '2MB', turnstile, turnstileSitekey, billing });
  // Bind host: default all-interfaces (back-compat), but a deployment SHOULD set
  // MYC_BIND_HOST=127.0.0.1 so the control-plane — including the /frps/handler token
  // oracle — is loopback-only, reachable by the co-located frps + Caddy edge but
  // NEVER the public internet. Defence-in-depth alongside the host/cloud firewall.
  const bindHost = process.env.MYC_BIND_HOST || '0.0.0.0';
  app.listen(port, bindHost, () => console.log(`[mycelium-managed] control-plane on ${bindHost}:${port} (zone=${zone}, dns=${dns.provider})`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
