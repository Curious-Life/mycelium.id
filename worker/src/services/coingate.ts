/**
 * Zero-dependency CoinGate API client for Cloudflare Workers.
 * Handles invoice creation, webhook verification, and status checks.
 * https://developer.coingate.com/reference
 */

import type { Env } from "../types/env";

// ── Types ──────────────────────────────────────────────────────────

export type CryptoPlan = "monthly" | "annual" | "decade";

export interface CoinGateOrder {
  id: number;
  order_id: string;
  status: string;
  price_amount: string;
  price_currency: string;
  receive_amount: string;
  receive_currency: string;
  pay_amount: string | null;
  pay_currency: string | null;
  payment_url: string;
  created_at: string;
  token: string;
}

export interface CoinGateWebhookPayload {
  id: number;
  order_id: string;
  status: "paid" | "pending" | "confirming" | "expired" | "invalid" | "canceled";
  price_amount: string;
  price_currency: string;
  receive_amount: string;
  receive_currency: string;
  pay_amount: string;
  pay_currency: string;
  created_at: string;
}

// ── Constants ──────────────────────────────────────────────────────

const COINGATE_API = "https://api.coingate.com/v2";
const COINGATE_SANDBOX_API = "https://api-sandbox.coingate.com/v2";

/** EUR prices for crypto payments (same as card) */
export const CRYPTO_PRICES: Record<CryptoPlan, number> = {
  monthly: 10,
  annual: 100,
  decade: 800,
};

/** Months credited per plan */
export const PLAN_MONTHS: Record<CryptoPlan, number> = {
  monthly: 1,
  annual: 12,
  decade: 120,
};

const VALID_PLANS = new Set<string>(["monthly", "annual", "decade"]);

// ── Helpers ────────────────────────────────────────────────────────

function getApiKey(env: Env): string {
  const key = (env as unknown as Record<string, string>).COINGATE_API_KEY;
  if (!key) throw new Error("COINGATE_API_KEY not configured");
  return key;
}

function getWebhookSecret(env: Env): string {
  const secret = (env as unknown as Record<string, string>).COINGATE_WEBHOOK_SECRET;
  if (!secret) throw new Error("COINGATE_WEBHOOK_SECRET not configured");
  return secret;
}

function getApiBase(env: Env): string {
  const environment = (env as unknown as Record<string, string>).COINGATE_ENVIRONMENT;
  return environment === "sandbox" ? COINGATE_SANDBOX_API : COINGATE_API;
}

// ── Plan Validation ────────────────────────────────────────────────

export function isValidPlan(plan: string): plan is CryptoPlan {
  return VALID_PLANS.has(plan);
}

// ── Create Order ───────────────────────────────────────────────────

export async function createOrder(
  env: Env,
  params: {
    userId: string;
    email: string;
    plan: CryptoPlan;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<{ paymentUrl: string; orderId: string; coingateId: number }> {
  const apiKey = getApiKey(env);
  const apiBase = getApiBase(env);
  const price = CRYPTO_PRICES[params.plan];
  const orderId = `mycelium_${params.userId}_${Date.now()}`;

  // WORKER_URL must be set in wrangler env — no hardcoded fallback to keep
  // personal subdomain out of the codebase.
  const workerUrl = (env as unknown as Record<string, string>).WORKER_URL;
  if (!workerUrl) {
    throw new Error('WORKER_URL not configured for crypto webhook callback');
  }
  const callbackUrl = `${workerUrl}/api/crypto/webhook`;

  const body = JSON.stringify({
    order_id: orderId,
    price_amount: price,
    price_currency: "EUR",
    receive_currency: "EUR",
    title: `Mycelium ${params.plan} subscription`,
    description: `Prepaid ${params.plan} access to Mycelium`,
    callback_url: callbackUrl,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    purchaser_email: params.email,
  });

  const res = await fetch(`${apiBase}/orders`, {
    method: "POST",
    headers: {
      "Authorization": `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`CoinGate create order failed (${res.status}): ${err}`);
  }

  const order = await res.json() as CoinGateOrder;

  return {
    paymentUrl: order.payment_url,
    orderId: order.order_id,
    coingateId: order.id,
  };
}

// ── Get Order Status ───────────────────────────────────────────────

export async function getOrderStatus(
  env: Env,
  coingateId: number,
): Promise<{ status: string; payAmount: string | null; payCurrency: string | null }> {
  const apiKey = getApiKey(env);
  const apiBase = getApiBase(env);

  const res = await fetch(`${apiBase}/orders/${coingateId}`, {
    headers: { "Authorization": `Token ${apiKey}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`CoinGate get order failed (${res.status}): ${err}`);
  }

  const order = await res.json() as CoinGateOrder;
  return {
    status: order.status,
    payAmount: order.pay_amount,
    payCurrency: order.pay_currency,
  };
}

// ── Webhook Verification ───────────────────────────────────────────

/**
 * Verify CoinGate webhook callback token.
 * CoinGate sends a `token` field in the webhook body that matches
 * the order's token. We also verify against our webhook secret.
 *
 * For additional security, verify the callback token header.
 */
export function verifyWebhookToken(
  payload: CoinGateWebhookPayload & { token?: string },
  env: Env,
): boolean {
  const secret = getWebhookSecret(env);
  // CoinGate sends x-coingate-callback-token header or token in body
  // Compare against our configured secret
  if (payload.token && payload.token === secret) {
    return true;
  }
  return false;
}

/**
 * Verify webhook from request headers.
 */
export function verifyWebhookHeader(
  request: Request,
  env: Env,
): boolean {
  const secret = getWebhookSecret(env);
  const token = request.headers.get("x-coingate-callback-token");
  if (!token) return false;

  // Timing-safe comparison
  if (token.length !== secret.length) return false;
  let result = 0;
  for (let i = 0; i < token.length; i++) {
    result |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  }
  return result === 0;
}

// ── Parse Order ID ─────────────────────────────────────────────────

/**
 * Extract user_id from our order_id format: mycelium_{userId}_{timestamp}
 */
export function parseOrderId(orderId: string): { userId: string; timestamp: number } | null {
  const match = orderId.match(/^mycelium_(.+)_(\d+)$/);
  if (!match) return null;
  return { userId: match[1], timestamp: parseInt(match[2], 10) };
}

/**
 * Determine credited months from EUR amount.
 */
export function monthsFromAmount(amountEur: number): number {
  if (amountEur >= 700) return 120;  // decade
  if (amountEur >= 80) return 12;    // annual
  return 1;                          // monthly
}

/**
 * Determine plan name from EUR amount.
 */
export function planFromAmount(amountEur: number): CryptoPlan {
  if (amountEur >= 700) return "decade";
  if (amountEur >= 80) return "annual";
  return "monthly";
}
