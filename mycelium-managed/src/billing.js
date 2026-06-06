// billing.js — thin Stripe wrapper for the control-plane (O4). No SDK: we POST
// to the Stripe REST API with the same fetch pattern as turnstile.js, and verify
// webhook signatures with node:crypto. Two reasons over the `stripe` package:
// (1) keeps the control-plane dependency-light; (2) the security-critical bit —
// webhook signature verification — is a pure local HMAC, so it's fully hermetic
// to test (no network, deterministic).
//
// SECRETS are env-only (MYC_STRIPE_SECRET / MYC_STRIPE_WEBHOOK_SECRET), never on
// the Mac, never in the registry, never logged — same discipline as the master
// key and the Turnstile secret. We persist ONLY {stripe_customer_id, paid_until}
// against a publicKey; cards/emails live at Stripe (PII minimization, §6).
//
// OPT-IN + FAIL-CLOSED. Disabled when no secret is set (self-hosters / dev / the
// hermetic tests run with billing off → /v1/provision skips the paywall). When
// enabled, a bad/forged/stale webhook signature is rejected (verifyWebhook → null,
// never throws), and a checkout failure surfaces as an error (never a silent
// "entitled").
import crypto from 'node:crypto';

const STRIPE_API = 'https://api.stripe.com/v1';

// Stripe wants application/x-www-form-urlencoded with PHP-style bracket nesting
// (a[b]=c, a[b][c]=d). Flatten a nested object into that shape.
function formEncode(obj, prefix, out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) formEncode(v, key, out);
    else if (Array.isArray(v)) v.forEach((item, i) => formEncode({ [i]: item }, key, out));
    else out.append(key, String(v));
  }
  return out;
}

/**
 * @param {{ secret?:string, webhookSecret?:string, priceMonthly?:string, priceAnnual?:string,
 *           returnUrl?:string, toleranceSec?:number, fetch?:Function, now?:()=>number }} opts
 */
export function createBilling({
  secret, webhookSecret, priceMonthly, priceAnnual,
  returnUrl = 'https://connect.mycelium.id/billing/return',
  toleranceSec = 300, fetch: fetchImpl, now = () => Date.now(),
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const enabled = !!secret;

  async function stripePost(path, params) {
    const res = await doFetch(`${STRIPE_API}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/x-www-form-urlencoded',
        // Pin the API version so event/object shapes we parse stay stable.
        'Stripe-Version': '2024-06-20',
      },
      body: formEncode(params),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`stripe ${path} ${res.status}: ${data?.error?.message || 'failed'}`);
    return data;
  }

  return {
    enabled,
    /** Hosted Checkout for a €1/mo (or annual) subscription. Binds the tenant
     *  identity in client_reference_id AND subscription metadata so every later
     *  webhook can recover the publicKey. Returns { url, id }. */
    async createCheckoutSession({ publicKey, handle, plan = 'monthly' }) {
      if (!enabled) throw new Error('billing disabled');
      const price = plan === 'annual' ? priceAnnual : priceMonthly;
      if (!price) throw new Error(`no Stripe price configured for plan=${plan}`);
      const session = await stripePost('/checkout/sessions', {
        mode: 'subscription',
        client_reference_id: publicKey,
        // Bracketed array form: line_items[0][price]=…&line_items[0][quantity]=1
        line_items: [{ price, quantity: 1 }],
        metadata: { public_key: publicKey, handle },
        subscription_data: { metadata: { public_key: publicKey, handle } },
        // Deep-link back into the app on either outcome (the app re-provisions).
        success_url: `${returnUrl}?status=success&handle=${encodeURIComponent(handle)}`,
        cancel_url: `${returnUrl}?status=cancel&handle=${encodeURIComponent(handle)}`,
        // Stripe Tax (decision 8.1.1) — let Stripe compute EU VAT.
        automatic_tax: { enabled: true },
      });
      return { url: session.url, id: session.id };
    },

    /** Stripe Customer Portal (O7) — cancel / update card / see paid_until. */
    async customerPortalSession(customerId) {
      if (!enabled) throw new Error('billing disabled');
      if (!customerId) throw new Error('no customer id');
      const s = await stripePost('/billing_portal/sessions', { customer: customerId, return_url: returnUrl });
      return { url: s.url };
    },

    /**
     * Verify a Stripe webhook signature and parse the event. FAIL-CLOSED: returns
     * null on any missing/bad/stale signature or malformed body — never throws,
     * never returns an unverified event. Implements Stripe's scheme: the
     * Stripe-Signature header is `t=<ts>,v1=<hexHmac>[,v1=…]`, and the signed
     * payload is `<t>.<rawBody>` HMAC-SHA256'd with the endpoint secret.
     * @param {Buffer|string} rawBody  the EXACT bytes Stripe sent (no re-encode)
     * @param {string} sigHeader       the Stripe-Signature header value
     */
    verifyWebhook(rawBody, sigHeader) {
      if (!webhookSecret || typeof sigHeader !== 'string' || rawBody == null) return null;
      const parts = Object.create(null);
      for (const kv of sigHeader.split(',')) {
        const i = kv.indexOf('=');
        if (i < 0) continue;
        const k = kv.slice(0, i).trim();
        const v = kv.slice(i + 1).trim();
        if (k === 't') parts.t = v;
        else if (k === 'v1') (parts.v1 ||= []).push(v);
      }
      if (!parts.t || !parts.v1 || !/^\d+$/.test(parts.t)) return null;
      // Reject stale/future timestamps (replay window).
      const ageSec = Math.abs(Math.floor(now() / 1000) - Number(parts.t));
      if (ageSec > toleranceSec) return null;
      const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
      const expected = crypto.createHmac('sha256', webhookSecret)
        .update(Buffer.concat([Buffer.from(`${parts.t}.`, 'utf8'), payload]))
        .digest('hex');
      const expBuf = Buffer.from(expected, 'utf8');
      // Constant-time compare against EACH provided v1 (Stripe may send several
      // during secret rotation). Any match → authentic.
      const ok = parts.v1.some((sig) => {
        const sigBuf = Buffer.from(sig, 'utf8');
        return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
      });
      if (!ok) return null;
      try { return JSON.parse(payload.toString('utf8')); }
      catch { return null; }
    },
  };
}
