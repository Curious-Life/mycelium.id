/**
 * Zero-dependency Stripe API client for Cloudflare Workers.
 * All calls use raw fetch() to api.stripe.com — no npm SDK required.
 * Webhook verification uses Web Crypto HMAC-SHA256.
 */

import type { Env } from "../types/env";

const STRIPE_API = "https://api.stripe.com/v1";

// ── Types ──────────────────────────────────────────────────────────

export interface CheckoutSessionParams {
  email: string;
  plan: "monthly" | "annual" | "decade";
  handle: string;
  keyHash: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  id: string;
  url: string;
  payment_status: string;
  customer_email: string;
  customer: string;
  subscription: string | null;
  metadata: Record<string, string>;
  mode: string;
}

export interface StripeSubscription {
  id: string;
  status: string;
  current_period_end: number;
  cancel_at_period_end: boolean;
  items: {
    data: Array<{
      price: { id: string; recurring: { interval: string } | null };
    }>;
  };
}

export interface StripeEvent {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
}

// ── Price IDs ──────────────────────────────────────────────────────

export const STRIPE_PRICES: Record<string, string> = {
  monthly: "price_1TInCrJgY5LAsqRxB7W68xPG",
  annual: "price_1TInCsJgY5LAsqRxxgtAxd94",
  decade: "price_1TInCsJgY5LAsqRxdpUiYloI",
};

// ── Helpers ────────────────────────────────────────────────────────

function getStripeKey(env: Env): string {
  const key = (env as unknown as Record<string, string>).STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  return key;
}

function authHeader(key: string): Record<string, string> {
  return {
    "Authorization": `Basic ${btoa(key + ":")}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

async function stripeRequest<T>(
  key: string,
  endpoint: string,
  method: "GET" | "POST" = "GET",
  params?: URLSearchParams,
): Promise<T> {
  const url = `${STRIPE_API}/${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: authHeader(key),
    ...(params ? { body: params.toString() } : {}),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Stripe ${endpoint} failed (${res.status}): ${err}`);
  }

  return res.json() as Promise<T>;
}

// ── Checkout ───────────────────────────────────────────────────────

export async function createCheckoutSession(
  env: Env,
  params: CheckoutSessionParams,
): Promise<{ sessionId: string; url: string }> {
  const key = getStripeKey(env);
  const isRecurring = params.plan !== "decade";
  const priceId = STRIPE_PRICES[params.plan];

  if (!priceId) throw new Error(`Invalid plan: ${params.plan}`);

  const body = new URLSearchParams();
  body.set("mode", isRecurring ? "subscription" : "payment");
  body.set("success_url", params.successUrl);
  body.set("cancel_url", params.cancelUrl);
  body.set("customer_email", params.email);
  body.set("line_items[0][price]", priceId);
  body.set("line_items[0][quantity]", "1");
  body.set("metadata[handle]", params.handle);
  body.set("metadata[keyHash]", params.keyHash);
  body.set("metadata[plan]", params.plan);
  body.set("metadata[email]", params.email);

  const session = await stripeRequest<CheckoutSession>(
    key, "checkout/sessions", "POST", body,
  );

  return { sessionId: session.id, url: session.url };
}

export async function retrieveCheckoutSession(
  env: Env,
  sessionId: string,
): Promise<CheckoutSession> {
  const key = getStripeKey(env);
  return stripeRequest<CheckoutSession>(key, `checkout/sessions/${sessionId}`);
}

// ── Subscriptions ──────────────────────────────────────────────────

export async function retrieveSubscription(
  env: Env,
  subscriptionId: string,
): Promise<StripeSubscription> {
  const key = getStripeKey(env);
  return stripeRequest<StripeSubscription>(key, `subscriptions/${subscriptionId}`);
}

// ── Customer Lookup ────────────────────────────────────────────────

export async function findCustomerByEmail(
  env: Env,
  email: string,
): Promise<string | null> {
  const key = getStripeKey(env);
  const params = new URLSearchParams();
  params.set("email", email);
  params.set("limit", "1");

  const result = await stripeRequest<{ data: Array<{ id: string }> }>(
    key, `customers?${params.toString()}`,
  );

  return result.data.length > 0 ? result.data[0].id : null;
}

export async function listCustomerCheckoutSessions(
  env: Env,
  customerId: string,
): Promise<CheckoutSession[]> {
  const key = getStripeKey(env);
  const params = new URLSearchParams();
  params.set("customer", customerId);
  params.set("limit", "5");

  const result = await stripeRequest<{ data: CheckoutSession[] }>(
    key, `checkout/sessions?${params.toString()}`,
  );

  return result.data;
}

// ── Billing Portal ─────────────────────────────────────────────────

export async function createBillingPortalSession(
  env: Env,
  customerId: string,
  returnUrl: string,
): Promise<string> {
  const key = getStripeKey(env);
  const params = new URLSearchParams();
  params.set("customer", customerId);
  params.set("return_url", returnUrl);

  const session = await stripeRequest<{ url: string }>(
    key, "billing_portal/sessions", "POST", params,
  );

  return session.url;
}

// ── Webhook Signature Verification ─────────────────────────────────

const WEBHOOK_TOLERANCE_SECONDS = 300; // 5 minutes

/**
 * Verify a Stripe webhook signature using HMAC-SHA256.
 * Returns the parsed event if valid, throws if invalid.
 *
 * Follows Stripe's signature scheme:
 *   Stripe-Signature: t=<timestamp>,v1=<hmac-sha256>
 *   signed_payload = "<timestamp>.<raw_body>"
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): Promise<StripeEvent> {
  // Parse header
  const parts = signatureHeader.split(",");
  let timestamp: string | null = null;
  let signature: string | null = null;

  for (const part of parts) {
    const [key, value] = part.split("=", 2);
    if (key === "t") timestamp = value;
    if (key === "v1") signature = value;
  }

  if (!timestamp || !signature) {
    throw new Error("Invalid Stripe-Signature header: missing t or v1");
  }

  // Replay protection
  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > WEBHOOK_TOLERANCE_SECONDS) {
    throw new Error(`Webhook timestamp too old: ${now - ts}s drift`);
  }

  // Compute expected signature
  const signedPayload = `${timestamp}.${rawBody}`;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedPayload),
  );

  const expectedSig = Array.from(new Uint8Array(mac))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  // Timing-safe comparison
  const sigBytes = encoder.encode(signature);
  const expectedBytes = encoder.encode(expectedSig);

  if (sigBytes.byteLength !== expectedBytes.byteLength) {
    throw new Error("Webhook signature length mismatch");
  }

  const match = await crypto.subtle.timingSafeEqual(sigBytes, expectedBytes);
  if (!match) {
    throw new Error("Webhook signature verification failed");
  }

  // Signature valid — parse the event
  return JSON.parse(rawBody) as StripeEvent;
}
