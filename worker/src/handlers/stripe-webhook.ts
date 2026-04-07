/**
 * Stripe Webhook Handler
 *
 * Processes Stripe events with signature verification and idempotency.
 * Events: checkout.session.completed, invoice.payment_failed, invoice.paid,
 *         customer.subscription.updated, customer.subscription.deleted
 */

import type { Env } from "../types/env";
import {
  verifyWebhookSignature,
  retrieveSubscription,
  type StripeEvent,
} from "../services/stripe";

// ── Main Handler ───────────────────────────────────────────────────

export async function handleStripeWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const webhookSecret = (env as unknown as Record<string, string>).STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET not configured");
    return json({ error: "Webhook not configured" }, 503);
  }

  // Must read raw body for HMAC verification
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("Stripe-Signature");

  if (!signatureHeader) {
    return json({ error: "Missing Stripe-Signature header" }, 400);
  }

  // Verify signature
  let event: StripeEvent;
  try {
    event = await verifyWebhookSignature(rawBody, signatureHeader, webhookSecret);
  } catch (err: any) {
    console.error("[stripe-webhook] Signature verification failed:", err.message);
    return json({ error: "Invalid signature" }, 400);
  }

  // Idempotency: skip already-processed events
  if (env.DB) {
    const existing = await env.DB.prepare(
      "SELECT event_id FROM stripe_events WHERE event_id = ?"
    ).bind(event.id).first();

    if (existing) {
      console.log(`[stripe-webhook] Skipping duplicate event: ${event.id}`);
      return json({ received: true, duplicate: true });
    }
  }

  // Route event to handler
  console.log(`[stripe-webhook] Processing: ${event.type} (${event.id})`);

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event, env);
        break;
      case "invoice.payment_failed":
        await handlePaymentFailed(event, env);
        break;
      case "invoice.paid":
        await handleInvoicePaid(event, env);
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event, env);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event, env);
        break;
      default:
        console.log(`[stripe-webhook] Unhandled event type: ${event.type}`);
    }

    // Record event as processed
    if (env.DB) {
      await env.DB.prepare(
        "INSERT INTO stripe_events (event_id, event_type) VALUES (?, ?)"
      ).bind(event.id, event.type).run();
    }
  } catch (err: any) {
    console.error(`[stripe-webhook] Error processing ${event.type}:`, err.message);
    // Return 500 so Stripe retries
    return json({ error: "Processing failed" }, 500);
  }

  return json({ received: true });
}

// ── Event Handlers ──────────────────────���──────────────────────────

/**
 * checkout.session.completed
 * Creates a subscription record and marks the signup as paid in KV.
 */
async function handleCheckoutCompleted(event: StripeEvent, env: Env): Promise<void> {
  const session = event.data.object as Record<string, unknown>;
  const metadata = (session.metadata || {}) as Record<string, string>;
  const customerId = session.customer as string;
  const subscriptionId = session.subscription as string | null;
  const email = metadata.email || (session.customer_email as string);
  const plan = metadata.plan || "monthly";
  const mode = session.mode as string;

  if (!customerId || !email) {
    console.error("[stripe-webhook] checkout.session.completed missing customer or email");
    return;
  }

  // Determine subscription type and status
  const isLifetime = mode === "payment" || plan === "decade";
  const type = isLifetime ? "lifetime" : "recurring";
  const status = isLifetime ? "lifetime" : "active";

  // Get current_period_end from subscription if recurring
  let periodEnd: string | null = null;
  if (subscriptionId && !isLifetime) {
    try {
      const sub = await retrieveSubscription(env, subscriptionId);
      periodEnd = new Date(sub.current_period_end * 1000).toISOString();
    } catch (err: any) {
      console.error("[stripe-webhook] Failed to retrieve subscription:", err.message);
    }
  }

  // Generate deterministic user_id from email (same logic as handleSignupActivate)
  const userIdBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`mycelium:user:${email}`))
  );
  const userId = Array.from(new Uint8Array(userIdBytes.slice(0, 16)))
    .map(b => b.toString(16).padStart(2, "0")).join("");

  if (!env.DB) return;

  // Upsert subscription record (paid_through = current_period_end for Stripe, used as single access control field)
  await env.DB.prepare(`
    INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, plan, type, status, current_period_end, payment_method, paid_through, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'stripe', ?, datetime('now'), datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      stripe_customer_id = excluded.stripe_customer_id,
      stripe_subscription_id = excluded.stripe_subscription_id,
      plan = excluded.plan,
      type = excluded.type,
      status = excluded.status,
      current_period_end = excluded.current_period_end,
      payment_method = COALESCE(excluded.payment_method, payment_method),
      paid_through = excluded.paid_through,
      updated_at = datetime('now')
  `).bind(
    userId,
    customerId,
    subscriptionId,
    plan,
    type,
    status,
    periodEnd,
    periodEnd,
  ).run();

  // Store payment confirmation in KV for activate endpoint fallback
  if (env.KV) {
    await env.KV.put(`signup:paid:${email}`, JSON.stringify({
      customerId,
      subscriptionId,
      plan,
      type,
      userId,
    }), { expirationTtl: 3600 }); // 1 hour
  }

  console.log(`[stripe-webhook] Subscription created: ${userId} (${plan}/${type})`);
}

/**
 * invoice.payment_failed
 * Marks subscription as past_due and sends warning email.
 */
async function handlePaymentFailed(event: StripeEvent, env: Env): Promise<void> {
  const invoice = event.data.object as Record<string, unknown>;
  const customerId = invoice.customer as string;

  if (!customerId || !env.DB) return;

  // Find subscription by Stripe customer ID
  const sub = await env.DB.prepare(
    "SELECT id, user_id, status, payment_failed_at FROM subscriptions WHERE stripe_customer_id = ?"
  ).bind(customerId).first<{
    id: string; user_id: string; status: string; payment_failed_at: string | null;
  }>();

  if (!sub) {
    console.error(`[stripe-webhook] No subscription found for customer: ${customerId}`);
    return;
  }

  // Only update if this is the first failure or still recurring
  if (sub.status === "lifetime") return;

  await env.DB.prepare(`
    UPDATE subscriptions
    SET status = 'past_due',
        payment_failed_at = COALESCE(payment_failed_at, datetime('now')),
        updated_at = datetime('now')
    WHERE id = ?
  `).bind(sub.id).run();

  // Send warning email
  const customerEmail = invoice.customer_email as string;
  if (customerEmail && env.RESEND_API_KEY) {
    await sendEmail(env, customerEmail,
      "Action required: Payment failed for your Mycelium vault",
      `Your recent payment for Mycelium failed.\n\nPlease update your payment method within 7 days to keep your vault active.\n\nYou can manage your billing at your vault's settings page, or contact support if you need help.\n\n— Mycelium`,
    );
  }

  // Notify admin
  if (env.NOTIFICATION_EMAIL && env.RESEND_API_KEY) {
    await sendEmail(env, env.NOTIFICATION_EMAIL,
      `[Alert] Payment failed: ${customerEmail || customerId}`,
      `Payment failed for customer ${customerId}\nEmail: ${customerEmail || "unknown"}\nUser ID: ${sub.user_id}\nPrevious status: ${sub.status}`,
    );
  }

  console.log(`[stripe-webhook] Payment failed for ${sub.user_id}, status → past_due`);
}

/**
 * invoice.paid
 * Recovers subscription from past_due back to active.
 */
async function handleInvoicePaid(event: StripeEvent, env: Env): Promise<void> {
  const invoice = event.data.object as Record<string, unknown>;
  const customerId = invoice.customer as string;

  if (!customerId || !env.DB) return;

  const sub = await env.DB.prepare(
    "SELECT id, status FROM subscriptions WHERE stripe_customer_id = ?"
  ).bind(customerId).first<{ id: string; status: string }>();

  if (!sub) return;

  // Only recover if currently past_due
  if (sub.status === "past_due") {
    await env.DB.prepare(`
      UPDATE subscriptions
      SET status = 'active', payment_failed_at = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).bind(sub.id).run();

    console.log(`[stripe-webhook] Payment recovered for ${sub.id}, status → active`);
  }
}

/**
 * customer.subscription.updated
 * Syncs period end, cancellation intent, and status changes.
 */
async function handleSubscriptionUpdated(event: StripeEvent, env: Env): Promise<void> {
  const stripeSub = event.data.object as Record<string, unknown>;
  const subscriptionId = stripeSub.id as string;

  if (!subscriptionId || !env.DB) return;

  const sub = await env.DB.prepare(
    "SELECT id, type FROM subscriptions WHERE stripe_subscription_id = ?"
  ).bind(subscriptionId).first<{ id: string; type: string }>();

  if (!sub || sub.type === "lifetime") return;

  const periodEnd = stripeSub.current_period_end
    ? new Date((stripeSub.current_period_end as number) * 1000).toISOString()
    : null;
  const cancelAtPeriodEnd = stripeSub.cancel_at_period_end ? 1 : 0;
  const stripeStatus = stripeSub.status as string;

  // Map Stripe status to our status
  let status: string;
  switch (stripeStatus) {
    case "active":
    case "trialing":
      status = "active";
      break;
    case "past_due":
      status = "past_due";
      break;
    case "canceled":
    case "unpaid":
      status = "canceled";
      break;
    default:
      status = stripeStatus;
  }

  await env.DB.prepare(`
    UPDATE subscriptions
    SET status = ?, current_period_end = ?, cancel_at_period_end = ?, paid_through = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(status, periodEnd, cancelAtPeriodEnd, periodEnd, sub.id).run();

  console.log(`[stripe-webhook] Subscription updated: ${sub.id} → ${status}`);
}

/**
 * customer.subscription.deleted
 * Marks subscription as canceled.
 */
async function handleSubscriptionDeleted(event: StripeEvent, env: Env): Promise<void> {
  const stripeSub = event.data.object as Record<string, unknown>;
  const subscriptionId = stripeSub.id as string;

  if (!subscriptionId || !env.DB) return;

  const sub = await env.DB.prepare(
    "SELECT id, user_id FROM subscriptions WHERE stripe_subscription_id = ?"
  ).bind(subscriptionId).first<{ id: string; user_id: string }>();

  if (!sub) return;

  await env.DB.prepare(`
    UPDATE subscriptions
    SET status = 'canceled', updated_at = datetime('now')
    WHERE id = ?
  `).bind(sub.id).run();

  // Notify admin
  if (env.NOTIFICATION_EMAIL && env.RESEND_API_KEY) {
    await sendEmail(env, env.NOTIFICATION_EMAIL,
      `[Alert] Subscription canceled: ${sub.user_id}`,
      `Subscription ${subscriptionId} has been canceled.\nUser ID: ${sub.user_id}\nTime: ${new Date().toISOString()}`,
    );
  }

  console.log(`[stripe-webhook] Subscription deleted: ${sub.id} → canceled`);
}

// ── Helpers ───────���────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function sendEmail(
  env: Env,
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  if (!env.RESEND_API_KEY) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: (env as unknown as Record<string, string>).EMAIL_FROM || "Mycelium <martin@mycelium.id>",
        to,
        subject,
        text,
      }),
    });
  } catch (err: any) {
    console.error(`[stripe-webhook] Email to ${to} failed:`, err.message);
  }
}
