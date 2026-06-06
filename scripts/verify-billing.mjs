// verify:billing — the Stripe wrapper (O4), with a MOCK Stripe (no network).
//   B1  OPT-IN: no secret → disabled; createCheckoutSession refuses
//   B2  checkout session carries client_reference_id=publicKey + metadata.handle +
//       subscription metadata + the monthly price + automatic_tax; returns the url
//   B3  plan='annual' selects the annual price
//   B4  verifyWebhook: a correctly-signed payload → parsed event
//   B5  FAIL-CLOSED: a tampered body (same sig) → null
//   B6  FAIL-CLOSED: a stale timestamp (outside tolerance) → null
//   B7  FAIL-CLOSED: missing / malformed Stripe-Signature → null
//   B8  secret rotation: header with several v1 sigs, one valid → event
//   B9  customerPortalSession posts {customer, return_url}
//   B10 LEAK: neither the API secret nor the webhook secret appears in any output
// All deterministic: checkout/portal use a capturing mock fetch; webhook verify is
// pure node:crypto HMAC (we sign with the same secret the verifier trusts).
import crypto from 'node:crypto';
import { createBilling } from '../mycelium-managed/src/billing.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const SECRET = 'sk_test_DO_NOT_LEAK';
const WHSEC = 'whsec_DO_NOT_LEAK';

// ── B1 — opt-in ──────────────────────────────────────────────────────────────
const off = createBilling({});
let refused = false;
try { await off.createCheckoutSession({ publicKey: 'pk', handle: 'alice' }); } catch { refused = true; }
rec('B1. opt-in: no secret → disabled, createCheckoutSession refuses', off.enabled === false && refused, '');

// ── B2/B3 — checkout session shape (capturing mock fetch) ────────────────────
let captured = null;
const captureFetch = async (url, opts) => {
  captured = { url, headers: opts.headers, params: new URLSearchParams(opts.body.toString()) };
  return { ok: true, json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test_123', id: 'cs_test_123' }) };
};
const pay = createBilling({
  secret: SECRET, webhookSecret: WHSEC,
  priceMonthly: 'price_monthly_eur1', priceAnnual: 'price_annual_eur10',
  returnUrl: 'https://connect.mycelium.id/billing/return', fetch: captureFetch,
});
const cs = await pay.createCheckoutSession({ publicKey: 'PUBKEY_ABC', handle: 'alice' });
const p = captured.params;
rec('B2. checkout: client_reference_id + metadata + monthly price + automatic_tax; returns url',
  captured.url.endsWith('/checkout/sessions')
  && captured.headers.authorization === `Bearer ${SECRET}`
  && p.get('mode') === 'subscription'
  && p.get('client_reference_id') === 'PUBKEY_ABC'
  && p.get('metadata[public_key]') === 'PUBKEY_ABC'
  && p.get('metadata[handle]') === 'alice'
  && p.get('subscription_data[metadata][public_key]') === 'PUBKEY_ABC'
  && p.get('line_items[0][price]') === 'price_monthly_eur1'
  && p.get('line_items[0][quantity]') === '1'
  && p.get('automatic_tax[enabled]') === 'true'
  && cs.url.startsWith('https://checkout.stripe.com/'),
  `url=${cs.url}`);

await pay.createCheckoutSession({ publicKey: 'PUBKEY_ABC', handle: 'bob', plan: 'annual' });
rec('B3. plan=annual selects the annual price', captured.params.get('line_items[0][price]') === 'price_annual_eur10', '');

// ── B4–B8 — webhook signature verification (pure HMAC) ───────────────────────
const sign = (rawBody, ts, secret = WHSEC) => {
  const hmac = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return { ts, hmac };
};
const evt = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { client_reference_id: 'PUBKEY_ABC', customer: 'cus_1' } } });
const nowTs = Math.floor(Date.now() / 1000);

{
  const { ts, hmac } = sign(evt, nowTs);
  const parsed = pay.verifyWebhook(Buffer.from(evt), `t=${ts},v1=${hmac}`);
  rec('B4. valid signature → parsed event', !!parsed && parsed.type === 'checkout.session.completed', `parsed=${!!parsed}`);
}
{
  const { ts, hmac } = sign(evt, nowTs);
  const tampered = evt.replace('PUBKEY_ABC', 'ATTACKER'); // same sig, different body
  rec('B5. fail-closed: tampered body (sig no longer matches) → null',
    pay.verifyWebhook(Buffer.from(tampered), `t=${ts},v1=${hmac}`) === null, '');
}
{
  const staleTs = nowTs - 3600; // 1h old, tolerance 300s
  const { hmac } = sign(evt, staleTs);
  rec('B6. fail-closed: stale timestamp (replay) → null',
    pay.verifyWebhook(Buffer.from(evt), `t=${staleTs},v1=${hmac}`) === null, '');
}
rec('B7. fail-closed: missing / malformed Stripe-Signature → null',
  pay.verifyWebhook(Buffer.from(evt), '') === null
  && pay.verifyWebhook(Buffer.from(evt), 'garbage') === null
  && pay.verifyWebhook(Buffer.from(evt), `t=abc,v1=zzz`) === null
  && pay.verifyWebhook(null, `t=${nowTs},v1=x`) === null, '');
{
  const { ts, hmac } = sign(evt, nowTs);
  const header = `t=${ts},v1=${'0'.repeat(64)},v1=${hmac}`; // one bogus, one valid (rotation)
  rec('B8. secret rotation: any matching v1 → event', !!pay.verifyWebhook(Buffer.from(evt), header), '');
}

// ── B9 — customer portal ─────────────────────────────────────────────────────
await pay.customerPortalSession('cus_42');
rec('B9. customerPortalSession posts {customer, return_url}',
  captured.url.endsWith('/billing_portal/sessions')
  && captured.params.get('customer') === 'cus_42'
  && captured.params.get('return_url') === 'https://connect.mycelium.id/billing/return', '');

// ── B10 — leak scan ──────────────────────────────────────────────────────────
const surfaces = JSON.stringify({ cs }) + '\n' + String(cs.url);
rec('B10. LEAK: API/webhook secret never in returned values',
  !surfaces.includes(SECRET) && !surfaces.includes(WHSEC), '');

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — billing: opt-in, checkout-bound-to-publicKey, webhook fail-closed, secret-tight' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
