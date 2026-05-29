/**
 * Tenant Self-Service API
 *
 * Endpoints that customer agents can call with their own AGENT_TOKEN to perform
 * operations that USED to require ADMIN_SECRET. The Worker enforces tenant
 * isolation server-side: an agent can only ever notify itself, export its own
 * vault, and store/retrieve its own attachments.
 *
 * This is the Option-3 replacement for the legacy admin endpoints that customer
 * VPSes used to call. The legacy admin endpoints (`/api/admin/send-email`,
 * `/api/admin/store-export`) remain for OPERATOR scripts (provisioning,
 * one-shot tooling) but are NOT used by agent runtime any more.
 *
 * Two-key separation alignment:
 *   - Operator-infra and customer-data keys live exclusively on the VPS
 *     tmpfs; the Worker is still ciphertext-only and has no path to either.
 *   - The point of this file is to remove ADMIN_SECRET from agent process.env
 *     so a compromised customer VPS can never escalate to operator god-mode.
 */

import { requireAuth, type AgentIdentity } from "../middleware/agent-auth";
import { corsHeaders } from "../utils/cors";
import type { Env } from "../types/env";

/** Allowed templated security event types — agents cannot send arbitrary text. */
const NOTIFY_TEMPLATES: Record<string, { subject: string; body: (ctx: NotifyContext) => string }> = {
  new_device: {
    subject: "New device registered on your Mycelium account",
    body: (c) =>
      `A new passkey was registered on your Mycelium account.\n\nTime: ${c.time}\nIP: ${c.ip}\nDevice: ${c.ua}\n\nIf this wasn't you, your account may be compromised. SSH into your server and revoke all sessions immediately.\n\n— Mycelium`,
  },
  login: {
    subject: "New login to your Mycelium account",
    body: (c) =>
      `A new login was detected on your Mycelium account.\n\nTime: ${c.time}\nIP: ${c.ip}\nDevice: ${c.ua}\n\nIf this wasn't you, your account may be compromised.\n\n— Mycelium`,
  },
  export: {
    subject: "Your data was exported from your Mycelium account",
    body: (c) =>
      `A full data export was requested from your Mycelium account.\n\nTime: ${c.time}\nIP: ${c.ip}\nDevice: ${c.ua}${c.messageCount ? `\nMessages exported: ${c.messageCount}` : ""}\n\nIf this wasn't you, your account may be compromised. Revoke all sessions immediately.\n\n— Mycelium`,
  },
  export_ready: {
    subject: "Your Mycelium vault export is ready",
    body: (c) =>
      `Your vault export is ready${c.zipSizeMB ? ` (${c.zipSizeMB} MB)` : ""}.\n\nDownload link (expires in 1 hour):\n${c.downloadUrl}\n\nYou'll need the verification PIN shown in your portal to download. The link can only be used once.\n\n— Mycelium`,
  },
};

interface NotifyContext {
  time: string;
  ip: string;
  ua: string;
  messageCount?: number;
  zipSizeMB?: string;
  downloadUrl?: string;
}

/**
 * POST /api/notify-self
 *
 * Body: { event: 'new_device' | 'login' | 'export' | 'export_ready', details?: {...} }
 *
 * Auth: any valid agent token. The Worker resolves the tenant's email from
 * the OWNER D1's `provisioning_jobs` table using the agent's user_id — the
 * agent never sees or supplies the destination address.
 */
export async function handleNotifySelf(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  const identity = auth as AgentIdentity;

  if (!identity.user_id) {
    return new Response(JSON.stringify({ error: "Token has no user_id" }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  let body: { event: string; details?: Record<string, unknown> };
  try {
    body = (await request.json()) as { event: string; details?: Record<string, unknown> };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  const template = NOTIFY_TEMPLATES[body.event];
  if (!template) {
    return new Response(JSON.stringify({ error: `Unknown notify event: ${body.event}` }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  // Resolve the tenant's email from the OWNER D1 (where provisioning_jobs lives).
  // We deliberately use env.DB here, NOT the tenant DB — provisioning state is
  // operator-managed and customer agents must not modify it.
  if (!env.DB) {
    return new Response(JSON.stringify({ error: "Owner DB not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  const job = await env.DB
    .prepare("SELECT email FROM provisioning_jobs WHERE user_id = ? AND status = ? LIMIT 1")
    .bind(identity.user_id, "ready")
    .first<{ email: string }>();

  if (!job?.email) {
    // Not an error — self-hosted/legacy users have no provisioning row.
    // Return ok=false so the agent can fall back gracefully.
    return new Response(JSON.stringify({ ok: false, reason: "no_email_on_file" }), {
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  // Build templated email
  const ctx: NotifyContext = {
    time: new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC",
    ip: String((body.details?.ip as string) || "unknown"),
    ua: String((body.details?.ua as string) || "unknown"),
    messageCount: body.details?.messageCount as number | undefined,
    zipSizeMB: body.details?.zipSizeMB as string | undefined,
    downloadUrl: body.details?.downloadUrl as string | undefined,
  };

  const resendKey = (env as unknown as Record<string, string>).RESEND_API_KEY;
  if (!resendKey) {
    return new Response(JSON.stringify({ ok: false, reason: "resend_not_configured" }), {
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  const fromAddress = (env as unknown as Record<string, string>).RESEND_FROM_ADDRESS || "Mycelium <noreply@mycelium.id>";

  const sendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress,
      to: job.email,
      subject: template.subject,
      text: template.body(ctx),
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!sendRes.ok) {
    const errBody = await sendRes.text().catch(() => "");
    console.warn(`[notify-self] Resend ${sendRes.status} for ${identity.user_id}: ${errBody.slice(0, 200)}`);
    return new Response(JSON.stringify({ ok: false, reason: "send_failed", status: sendRes.status }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

/**
 * POST /api/export-self
 *
 * Body: { data: string }   // base64 ZIP
 *
 * Auth: any valid agent token. The Worker stores the export at
 * `exports/<identity.user_id>/...` so an agent can only ever store its own
 * tenant's export. Returns a 1-hour signed URL + a 6-digit PIN that the
 * customer must enter in the portal to download.
 */
export async function handleExportSelf(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  const identity = auth as AgentIdentity;

  if (!identity.user_id) {
    return new Response(JSON.stringify({ error: "Token has no user_id" }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  if (!env.BUCKET) {
    return new Response(JSON.stringify({ error: "R2 bucket not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  let body: { data?: string };
  try {
    body = (await request.json()) as { data?: string };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  if (!body.data || typeof body.data !== "string") {
    return new Response(JSON.stringify({ error: "data (base64) required" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  // Tenant-scoped R2 path — server-enforced. Agent CANNOT influence the user_id.
  // Path includes user_id for forensics; the SIGNED URL bound by HMAC is what
  // actually authorizes downloads (not path knowledge).
  const random = crypto.randomUUID().slice(0, 8);
  const key = `exports/${identity.user_id}/${Date.now()}-${random}.zip`;

  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(body.data), (c) => c.charCodeAt(0));
  } catch {
    return new Response(JSON.stringify({ error: "data must be valid base64" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  await env.BUCKET.put(key, bytes, {
    customMetadata: { userId: identity.user_id, createdAt: new Date().toISOString() },
    httpMetadata: { contentType: "application/zip" },
  });

  // Sign with the SAME scheme used by the existing handleServeExport
  // (`/exports/{key}?expires={ts}&sig={base64url}`) so the same download
  // page + PIN verification flow works without changes.
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const attachmentSecret = (env as unknown as Record<string, string>).ATTACHMENT_SECRET || "";
  if (!attachmentSecret) {
    return new Response(JSON.stringify({ error: "ATTACHMENT_SECRET not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  const message = `export:${key}:${expires}`;
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(attachmentSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const macBuf = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  const sig = btoa(String.fromCharCode(...new Uint8Array(macBuf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  // 6-digit PIN — same KV key format as the legacy export endpoint so the
  // existing handleServeExport PIN-entry page and verification flow work.
  let pin: string | null = null;
  if (env.KV) {
    const pinBytes = new Uint8Array(3);
    crypto.getRandomValues(pinBytes);
    pin = String((pinBytes[0] * 65536 + pinBytes[1] * 256 + pinBytes[2]) % 1_000_000).padStart(6, "0");
    await env.KV.put(`export:pin:${key}`, pin, { expirationTtl: 3600 });
  }

  const workerOrigin = new URL(request.url).origin;
  const downloadUrl = `${workerOrigin}/exports/${key}?expires=${expires}&sig=${sig}`;

  return new Response(JSON.stringify({ ok: true, key, downloadUrl, pin }), {
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

/**
 * POST /api/notify-peer
 *
 * Body: { toHandle: string, fromHandle: string, signature?: string }
 *
 * Auth: any valid agent token. Sends a templated "connection request" email
 * to the user behind `toHandle`, looked up via the OWNER D1's
 * handle_reservations + provisioning_jobs tables.
 *
 * The agent CANNOT supply free-form subject or body — only the variables
 * the template needs. Per-sender rate limiting (KV-backed) prevents abuse:
 * a compromised agent can email at most N peers/day.
 */
const PEER_NOTIFY_RATE_LIMIT = 20; // requests per sender per 24h
const PEER_NOTIFY_WINDOW_S = 86400;

export async function handleNotifyPeer(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  const identity = auth as AgentIdentity;

  if (!identity.user_id) {
    return new Response(JSON.stringify({ error: "Token has no user_id" }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  let body: { toHandle?: string; fromHandle?: string; signature?: string };
  try {
    body = (await request.json()) as { toHandle?: string; fromHandle?: string; signature?: string };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  if (!body.toHandle || !body.fromHandle) {
    return new Response(JSON.stringify({ error: "toHandle and fromHandle required" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  // Sanitize handles — alphanumeric + dash + underscore only
  const cleanTo = body.toHandle.replace(/^@/, "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const cleanFrom = body.fromHandle.replace(/^@/, "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!cleanTo || !cleanFrom) {
    return new Response(JSON.stringify({ error: "Invalid handles" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  // Rate limit per sender user_id (KV-backed). 20 peer notifications per 24h.
  if (env.KV) {
    const rlKey = `notify-peer-rl:${identity.user_id}`;
    const current = parseInt((await env.KV.get(rlKey)) || "0", 10);
    if (current >= PEER_NOTIFY_RATE_LIMIT) {
      return new Response(JSON.stringify({ ok: false, reason: "rate_limited" }), {
        status: 429,
        headers: { "Content-Type": "application/json", ...corsHeaders(request) },
      });
    }
    await env.KV.put(rlKey, String(current + 1), { expirationTtl: PEER_NOTIFY_WINDOW_S });
  }

  if (!env.DB) {
    return new Response(JSON.stringify({ error: "Owner DB not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  // Resolve toHandle → user_id via handle_reservations (central handle registry)
  const reservation = await env.DB
    .prepare("SELECT user_id FROM handle_reservations WHERE handle = ?")
    .bind(cleanTo)
    .first<{ user_id: string }>();
  if (!reservation?.user_id) {
    return new Response(JSON.stringify({ ok: false, reason: "handle_not_found" }), {
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  // Resolve target user_id → email via provisioning_jobs
  const job = await env.DB
    .prepare("SELECT email FROM provisioning_jobs WHERE user_id = ? AND status = ? LIMIT 1")
    .bind(reservation.user_id, "ready")
    .first<{ email: string }>();
  if (!job?.email) {
    return new Response(JSON.stringify({ ok: false, reason: "no_email_on_file" }), {
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  const resendKey = (env as unknown as Record<string, string>).RESEND_API_KEY;
  if (!resendKey) {
    return new Response(JSON.stringify({ ok: false, reason: "resend_not_configured" }), {
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  const fromAddress = (env as unknown as Record<string, string>).RESEND_FROM_ADDRESS || "Mycelium <noreply@mycelium.id>";
  const sigLine = body.signature ? `\n"${body.signature.slice(0, 200)}"` : "";

  // Resolve sender's actual user_id (owner agents have user_id="system")
  const senderUserId = identity.user_id === "system" && env.OWNER_USER_ID
    ? env.OWNER_USER_ID
    : (identity.user_id !== "system" ? identity.user_id : null);

  // Check if sender has an avatar on the CDN
  let avatarUrl: string | null = null;
  if (env.PUBLIC_BUCKET && senderUserId) {
    const avatarKey = `avatars/${senderUserId}.jpg`;
    const head = await env.PUBLIC_BUCKET.head(avatarKey);
    if (head) {
      avatarUrl = `https://cdn.mycelium.id/${avatarKey}`;
    }
  }

  // Look up sender's display name via handle → user_id → profile
  let senderName: string | null = null;
  const fromReservation = await env.DB
    .prepare("SELECT user_id FROM handle_reservations WHERE handle = ?")
    .bind(cleanFrom)
    .first<{ user_id: string }>();
  if (fromReservation?.user_id) {
    const senderProfile = await env.DB
      .prepare("SELECT display_name FROM user_profiles WHERE user_id = ?")
      .bind(fromReservation.user_id)
      .first<{ display_name: string }>();
    if (senderProfile?.display_name) senderName = senderProfile.display_name;
  }

  const displayName = senderName || `@${cleanFrom}`;
  const sigHtml = body.signature ? `<div style="font-size:14px;color:#44403C;line-height:1.7;margin-top:16px;padding:14px 18px;background:#F7F5EF;border-radius:8px;border-left:3px solid #E5C46B;">${body.signature.slice(0, 200).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] || c))}</div>` : "";

  const avatarHtml = avatarUrl
    ? `<img src="${avatarUrl}" alt="" width="64" height="64" style="width:64px;height:64px;border-radius:50%;object-fit:cover;border:2px solid #E5C46B;display:block;">`
    : `<div style="width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#B8860B,#E5C46B);display:flex;align-items:center;justify-content:center;font-size:24px;color:#fff;font-weight:600;font-family:-apple-system,system-ui,sans-serif;">${(senderName || cleanFrom).charAt(0).toUpperCase()}</div>`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#F7F5EF;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F5EF;padding:40px 20px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#FFFFFF;border-radius:16px;border:1px solid #E7E5E4;overflow:hidden;">

<!-- Header -->
<tr><td style="padding:32px 36px 24px;border-bottom:1px solid #F0EDE4;">
  <img src="https://mycelium.id/mushroom.svg" alt="" width="28" height="28" style="vertical-align:middle;margin-right:10px;border-radius:6px;">
  <span style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:20px;color:#1C1917;letter-spacing:-0.01em;vertical-align:middle;">mycelium</span><span style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;font-size:20px;color:#B8860B;vertical-align:middle;">.id</span>
</td></tr>

<!-- Avatar + Name -->
<tr><td style="padding:36px 36px 0;" align="center">
  ${avatarHtml}
  <div style="font-size:18px;color:#1C1917;font-weight:500;margin-top:16px;">${displayName}</div>
  <div style="font-size:13px;color:#A8A29E;margin-top:4px;">@${cleanFrom}</div>
</td></tr>

<!-- Body -->
<tr><td style="padding:20px 36px 28px;">
  <div style="font-size:15px;color:#1C1917;font-weight:500;text-align:center;margin-bottom:8px;">wants to connect with you</div>
  ${sigHtml}
</td></tr>

<!-- CTA -->
<tr><td style="padding:0 36px 32px;" align="center">
  <a href="https://mycelium.id/login" style="display:inline-block;padding:12px 32px;background:#1C1917;color:#FFFFFF;text-decoration:none;border-radius:8px;font-size:14px;font-weight:500;font-family:-apple-system,system-ui,sans-serif;">Open your portal</a>
</td></tr>

</table>

<!-- Brand footer -->
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;margin-top:24px;">
<tr><td style="text-align:center;font-size:11px;color:#A8A29E;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;">
  Your rights preserved
</td></tr>
</table>

</td></tr>
</table>
</body></html>`;

  const sendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress,
      to: job.email,
      subject: `@${cleanFrom} wants to connect`,
      text: `@${cleanFrom} sent you a connection request.${sigLine}\n\nLog in to your portal to accept or ignore.\n\n— Mycelium`,
      html,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!sendRes.ok) {
    const errBody = await sendRes.text().catch(() => "");
    console.warn(`[notify-peer] Resend ${sendRes.status} from ${identity.user_id} to ${cleanTo}: ${errBody.slice(0, 200)}`);
    return new Response(JSON.stringify({ ok: false, reason: "send_failed", status: sendRes.status }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}
