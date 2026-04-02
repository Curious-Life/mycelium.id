import type { Env, TelegramQueueMessage, TelegramUpdate } from "./types/env";
import { TelegramService } from "./services/telegram";
import { handleMessage } from "./handlers/message";
import { handleCommand } from "./handlers/commands";
import { handleUpload, handleImportClaude, handleAnalyzeClaude, handleUploadUrl } from "./handlers/upload";
import { handleImportOpenAI, handleAnalyzeOpenAI } from "./handlers/import-openai";
import { handleImportObsidian, handleAnalyzeObsidian, handleUploadObsidianAttachment, handleRewriteObsidianEmbeds } from "./handlers/import-obsidian";
import { handleImportMyaLogs, handleAnalyzeMyaLogs } from "./handlers/import-mya-logs";
import { handleImportAppleNotes, handleAnalyzeAppleNotes } from "./handlers/import-apple-notes";
import { handleSearchDocuments, handleGetBacklinks, handleResolveLink } from "./handlers/links";
import { handleCreateDirectUpload, handleFinalizeVideoUpload } from "./handlers/video-upload";
import {
  handleMorningCheckIn,
  handleEveningCheckIn,
  handleWeeklyReview,
  handleReflection,
  handleEndOfDayTriage,
  handleDream,
} from "./handlers/scheduled";
import { SEED_DOCUMENTS, SEED_PEOPLE } from "./data/seed-documents";
import { SupabaseService } from "./services/supabase";
import { StreamService } from "./services/stream";
import { WorkersAIService } from "./services/workersai";
import { handleProxyRequest } from "./handlers/db-proxy";
import { handleDataRequest } from "./handlers/data-api";
import { authenticateRequest } from "./middleware/agent-auth";
import { handleGetSecrets, handlePutSecret, handleDeleteSecret } from "./handlers/secrets-api";
import { importMasterKey, decrypt, isEncrypted, type Scope } from "./services/crypto";
import { corsHeaders as makeCorsHeaders, corsOrigin, corsPreflight } from "./utils/cors";
import { timingSafeCompare } from "./utils/crypto";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "./utils/rate-limit";
import { handleIntelRequest, handleIntelSnapshot } from "./handlers/intel-public";
import { requireAuth } from "./middleware/agent-auth";

/** Verify auth for AI endpoints — accepts worker secret, admin secret, or agent tokens */
async function verifyAIAuth(request: Request, env: Env): Promise<{ ok: boolean; token: string }> {
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "") || "";
  if (!token) return { ok: false, token: "" };
  // Check legacy secrets first (fast path)
  if (await timingSafeCompare(token, env.MYA_WORKER_SECRET || "") || await timingSafeCompare(token, env.ADMIN_SECRET || "")) {
    return { ok: true, token };
  }
  // Check agent registry
  const identity = await requireAuth(request, env);
  if (!(identity instanceof Response)) return { ok: true, token };
  return { ok: false, token: "" };
}

export default {
  /**
   * Main fetch handler for webhook requests
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    // =========================================
    // Public Intel Endpoints (no auth — for public intel dashboard)
    // =========================================

    // Intel snapshot ingest (authenticated with ADMIN_SECRET — must be before public handler)
    if (url.pathname === "/api/intel/snapshot" && (request.method === "POST" || request.method === "OPTIONS")) {
      return await handleIntelSnapshot(request, env);
    }

    const intelResponse = await handleIntelRequest(request, env, url.pathname);
    if (intelResponse) return intelResponse;

    // =========================================
    // AI Processing Endpoints (for Discord bot)
    // =========================================

    // Transcribe audio endpoint
    if (url.pathname === "/api/transcribe" && request.method === "POST") {
      return await handleTranscribe(request, env);
    }
    if (url.pathname === "/api/transcribe" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Text-to-speech endpoint
    if (url.pathname === "/api/tts" && request.method === "POST") {
      return await handleTTS(request, env);
    }
    if (url.pathname === "/api/tts" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Describe image endpoint
    if (url.pathname === "/api/describe-image" && request.method === "POST") {
      return await handleDescribeImage(request, env);
    }
    if (url.pathname === "/api/describe-image" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Store attachment endpoint (for Discord bot R2 storage)
    if (url.pathname === "/api/store-attachment" && request.method === "POST") {
      return await handleStoreAttachment(request, env);
    }
    if (url.pathname === "/api/store-attachment" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Generate embeddings for agent messages (backfill)
    if (url.pathname === "/api/backfill-agent-embeddings" && request.method === "POST") {
      return await handleBackfillAgentEmbeddings(request, env);
    }
    if (url.pathname === "/api/backfill-agent-embeddings" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Generic embedding endpoint for single text (used by agent /search)
    if (url.pathname === "/api/embed" && request.method === "POST") {
      return await handleEmbed(request, env);
    }
    if (url.pathname === "/api/embed" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Message enrichment pipeline — tag, embed, update
    if (url.pathname === "/api/enrich" && request.method === "POST") {
      return await handleEnrich(request, env, ctx);
    }
    if (url.pathname === "/api/enrich" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Decrypt batch — returns decrypted message content for VPS-native enrichment
    if (url.pathname === "/api/decrypt-batch" && request.method === "POST") {
      return await handleDecryptBatch(request, env);
    }
    if (url.pathname === "/api/decrypt-batch" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // AI text generation endpoint (for cluster descriptions)
    if (url.pathname === "/api/ai/generate" && request.method === "POST") {
      return await handleAIGenerate(request, env);
    }
    if (url.pathname === "/api/ai/generate" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Encrypted data API endpoints (store/query with scope-based encryption)
    const dataResponse = await handleDataRequest(request, env, url.pathname);
    if (dataResponse) return dataResponse;

    // D1 + Vectorize proxy endpoints (for VPS agents — metadata only, content redacted)
    const proxyResponse = await handleProxyRequest(request, env, url.pathname);
    if (proxyResponse) return proxyResponse;

    // Secrets API (centralized secret store for agents)
    if (url.pathname === "/api/secrets" && request.method === "GET") {
      return await handleGetSecrets(request, env);
    }
    if (url.pathname === "/api/secrets" && request.method === "PUT") {
      return await handlePutSecret(request, env);
    }
    if (url.pathname.startsWith("/api/secrets/") && request.method === "DELETE") {
      const key = decodeURIComponent(url.pathname.slice("/api/secrets/".length));
      return await handleDeleteSecret(request, env, key);
    }
    if (url.pathname === "/api/secrets" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Waitlist signup (public — no auth required)
    if (url.pathname === "/api/waitlist" && request.method === "POST") {
      return await handleWaitlistSignup(request, env);
    }
    if (url.pathname === "/api/waitlist" && request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Webhook setup endpoint (call once to configure)
    if (url.pathname === "/setup-webhook" && request.method === "POST") {
      return await setupWebhook(request, env);
    }

    // Main webhook endpoint
    if (url.pathname === "/webhook" && request.method === "POST") {
      return await handleWebhook(request, env, ctx);
    }

    // Seed documents endpoint (one-time setup)
    if (url.pathname === "/seed-documents" && request.method === "POST") {
      return await seedDocuments(request, env);
    }

    // Upload endpoint (portal file uploads)
    if (url.pathname === "/upload") {
      return await handleUpload(request, env);
    }

    // Upload URL endpoint (extract web page content)
    if (url.pathname === "/upload-url" && request.method === "POST") {
      return await handleUploadUrl(request, env);
    }
    // CORS preflight for upload-url
    if (url.pathname === "/upload-url" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Import Claude endpoint (receives pre-parsed JSON, not ZIP)
    if (url.pathname === "/import-claude" && request.method === "POST") {
      return await handleImportClaude(request, env);
    }
    // CORS preflight for import-claude
    if (url.pathname === "/import-claude" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Analyze Claude endpoint (pre-import preview - shows new vs existing)
    if (url.pathname === "/analyze-claude" && request.method === "POST") {
      return await handleAnalyzeClaude(request, env);
    }
    // CORS preflight for analyze-claude
    if (url.pathname === "/analyze-claude" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Import OpenAI endpoint (receives pre-parsed JSON)
    if (url.pathname === "/import-openai" && request.method === "POST") {
      return await handleImportOpenAI(request, env);
    }
    // CORS preflight for import-openai
    if (url.pathname === "/import-openai" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Analyze OpenAI endpoint (pre-import preview)
    if (url.pathname === "/analyze-openai" && request.method === "POST") {
      return await handleAnalyzeOpenAI(request, env);
    }
    // CORS preflight for analyze-openai
    if (url.pathname === "/analyze-openai" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Import Obsidian endpoint (receives batched notes)
    if (url.pathname === "/import-obsidian" && request.method === "POST") {
      return await handleImportObsidian(request, env);
    }
    // CORS preflight for import-obsidian
    if (url.pathname === "/import-obsidian" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Analyze Obsidian endpoint (pre-import preview)
    if (url.pathname === "/analyze-obsidian" && request.method === "POST") {
      return await handleAnalyzeObsidian(request, env);
    }
    // CORS preflight for analyze-obsidian
    if (url.pathname === "/analyze-obsidian" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Upload Obsidian attachment endpoint
    if (url.pathname === "/upload-obsidian-attachment" && request.method === "POST") {
      return await handleUploadObsidianAttachment(request, env);
    }
    // CORS preflight for upload-obsidian-attachment
    if (url.pathname === "/upload-obsidian-attachment" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Rewrite Obsidian embeds endpoint
    if (url.pathname === "/rewrite-obsidian-embeds" && request.method === "POST") {
      return await handleRewriteObsidianEmbeds(request, env);
    }
    // CORS preflight for rewrite-obsidian-embeds
    if (url.pathname === "/rewrite-obsidian-embeds" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Import MYA logs endpoint (custom chat log JSON)
    if (url.pathname === "/import-mya-logs" && request.method === "POST") {
      return await handleImportMyaLogs(request, env);
    }
    // CORS preflight for import-mya-logs
    if (url.pathname === "/import-mya-logs" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Analyze MYA logs endpoint (pre-import preview)
    if (url.pathname === "/analyze-mya-logs" && request.method === "POST") {
      return await handleAnalyzeMyaLogs(request, env);
    }
    // CORS preflight for analyze-mya-logs
    if (url.pathname === "/analyze-mya-logs" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Import Apple Notes endpoint (receives batched notes parsed in browser)
    if (url.pathname === "/import-apple-notes" && request.method === "POST") {
      return await handleImportAppleNotes(request, env);
    }
    // CORS preflight for import-apple-notes
    if (url.pathname === "/import-apple-notes" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Analyze Apple Notes endpoint (pre-import preview)
    if (url.pathname === "/analyze-apple-notes" && request.method === "POST") {
      return await handleAnalyzeAppleNotes(request, env);
    }
    // CORS preflight for analyze-apple-notes
    if (url.pathname === "/analyze-apple-notes" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Search documents for wiki link autocomplete
    if (url.pathname === "/api/links/search" && request.method === "GET") {
      return await handleSearchDocuments(request, env);
    }
    // CORS preflight for links/search
    if (url.pathname === "/api/links/search" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Get backlinks for a document
    if (url.pathname === "/api/links/backlinks" && request.method === "GET") {
      return await handleGetBacklinks(request, env);
    }
    // CORS preflight for links/backlinks
    if (url.pathname === "/api/links/backlinks" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Resolve wiki link to document
    if (url.pathname === "/api/links/resolve" && request.method === "GET") {
      return await handleResolveLink(request, env);
    }
    // CORS preflight for links/resolve
    if (url.pathname === "/api/links/resolve" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Attachments endpoint (serves R2 files with signed URLs)
    if (url.pathname.startsWith("/attachments/")) {
      if (request.method === "OPTIONS") {
        return corsPreflight(request);
      }
      if (request.method === "GET" || request.method === "HEAD") {
        return await serveAttachment(request, env);
      }
      if (request.method === "DELETE") {
        return await deleteAttachment(request, env);
      }
    }

    // Stream token endpoint (generates signed playback tokens for videos)
    if (url.pathname.startsWith("/stream-token/")) {
      if (request.method === "OPTIONS") {
        return corsPreflight(request);
      }
      if (request.method === "POST" || request.method === "GET") {
        return await generateStreamToken(request, env);
      }
    }

    // Stream delete endpoint (deletes videos from Cloudflare Stream)
    if (url.pathname.startsWith("/stream-delete/")) {
      if (request.method === "OPTIONS") {
        return corsPreflight(request);
      }
      if (request.method === "DELETE") {
        return await deleteStreamVideo(request, env);
      }
    }

    // Direct video upload - create upload URL for client-side uploads to Stream
    // Bypasses the 100MB Worker limit, allows up to 200GB uploads
    if (url.pathname === "/create-direct-upload" && request.method === "POST") {
      return await handleCreateDirectUpload(request, env);
    }
    // CORS preflight for create-direct-upload
    if (url.pathname === "/create-direct-upload" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Finalize video upload - create attachment record after direct upload completes
    if (url.pathname === "/finalize-video-upload" && request.method === "POST") {
      return await handleFinalizeVideoUpload(request, env);
    }
    // CORS preflight for finalize-video-upload
    if (url.pathname === "/finalize-video-upload" && request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    // Generate embeddings for territories, semantic themes, and realms
    if (url.pathname === "/generate-embeddings" && request.method === "POST") {
      return await generateEmbeddings(request, env);
    }

    // Repair: assign folder_id to Obsidian documents missing it
    if (url.pathname === "/repair-obsidian-folders" && request.method === "POST") {
      return await repairObsidianFolders(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },

  /**
   * Scheduled triggers for check-ins and processing (hourly)
   * Each handler checks user timezones internally and processes if appropriate
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log("Hourly scheduled job triggered at:", new Date(event.scheduledTime).toISOString());

    try {
      // Run all handlers - they internally check user timezones
      // Using waitUntil to allow concurrent execution
      ctx.waitUntil(handleMorningCheckIn(env));     // 8am in user's timezone
      ctx.waitUntil(handleEveningCheckIn(env));     // 9pm in user's timezone
      ctx.waitUntil(handleReflection(env));         // Every 4 hours (0, 4, 8, 12, 16, 20)
      ctx.waitUntil(handleDream(env));              // 3am in user's timezone
      ctx.waitUntil(handleEndOfDayTriage(env));     // 11pm in user's timezone
      ctx.waitUntil(handleWeeklyReview(env));       // Sunday 10am in user's timezone

      console.log("All scheduled handlers dispatched");
    } catch (e) {
      console.error("Scheduled handler error:", e);
    }
  },

  /**
   * Queue consumer for Telegram messages
   * Processes voice, photo, video, and document messages asynchronously
   * Has 15-minute timeout (vs webhook's ~30-60 seconds)
   */
  async queue(batch: MessageBatch<TelegramQueueMessage>, env: Env): Promise<void> {
    console.log(`[Queue] Received batch of ${batch.messages.length} messages`);

    for (const msg of batch.messages) {
      const queueMsg = msg.body;
      const update = queueMsg.update;
      const queueDelay = Date.now() - queueMsg.receivedAt;

      console.log(`[Queue] Processing update ${update.update_id} (queued ${queueDelay}ms ago)`);

      try {
        // Process the update using Grammy bot
        const telegram = new TelegramService(env);
        const supabase = new SupabaseService(env);
        const bot = telegram.getBot();

        // Register message handler
        bot.on("message", async (ctx) => {
          console.log(`[Queue] Message handler triggered for update ${update.update_id}`);
          const ctxFromId = ctx.from?.id;

          // Verify user exists
          const user = await supabase.getUserByTelegramId(ctxFromId!);
          if (!user) {
            console.warn(`[Queue] Unauthorized user: ${ctxFromId}`);
            return;
          }

          try {
            console.log(`[Queue] Calling handleMessage for ${ctxFromId}`);
            await handleMessage(ctx, env);
            console.log(`[Queue] handleMessage done for update ${update.update_id}`);

            if (env.KV) {
              await env.KV.put(`tg_update:${update.update_id}`, "completed", {
                expirationTtl: 300,
              });
            }
          } catch (e) {
            console.error(`[Queue] Handler error:`, e);
            if (env.KV) {
              await env.KV.put(`tg_update:${update.update_id}`, "error", {
                expirationTtl: 300,
              });
            }
            await telegram.reply(ctx, "Sorry, something went wrong processing your message. Please try again.");
          }
        });

        // Initialize and process
        await bot.init();
        await bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]);

        console.log(`[Queue] Successfully processed update ${update.update_id}`);
        msg.ack();
      } catch (e) {
        console.error(`[Queue] Failed to process update ${update.update_id}:`, e);
        // Retry on failure (up to max_retries in wrangler.toml)
        msg.retry();
      }
    }
  },
};

/**
 * Setup webhook with Telegram
 * PROTECTED: Requires admin secret in Authorization header
 */
async function setupWebhook(request: Request, env: Env): Promise<Response> {
  // Require admin secret for webhook setup
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (!token || !await timingSafeCompare(token, env.ADMIN_SECRET || "")) {
    // Generic error - don't reveal this endpoint exists to attackers
    return new Response("Not Found", { status: 404 });
  }

  try {
    const body = await request.json() as { webhook_url: string };

    // Validate webhook URL format
    if (!body.webhook_url || !isValidWebhookUrl(body.webhook_url)) {
      return new Response(JSON.stringify({ ok: false, error: "Invalid webhook URL" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const telegram = new TelegramService(env);
    await telegram.setWebhook(body.webhook_url, env.TELEGRAM_WEBHOOK_SECRET);

    return new Response(JSON.stringify({ ok: true, message: "Webhook configured" }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    // Log error internally but don't expose details
    console.error("Webhook setup error:", e);
    return new Response(JSON.stringify({ ok: false, error: "Setup failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * Validate webhook URL is HTTPS and points to expected domain
 */
function isValidWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Must be HTTPS
    if (parsed.protocol !== "https:") return false;
    // Must end with /webhook path
    if (!parsed.pathname.endsWith("/webhook")) return false;
    // Should be a workers.dev or custom domain
    return true;
  } catch {
    return false;
  }
}

/**
 * Handle audio transcription request (for Discord bot)
 * Accepts: audio data as base64 or raw bytes
 * Returns: { text: string }
 */
async function handleTranscribe(request: Request, env: Env): Promise<Response> {
  const corsHeaders = {
    ...makeCorsHeaders(request),
    "Content-Type": "application/json",
  };

  // Verify admin/worker secret (accept either MYA_WORKER_SECRET or ADMIN_SECRET)
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (!token || (!await timingSafeCompare(token, env.MYA_WORKER_SECRET || "") && !await timingSafeCompare(token, env.ADMIN_SECRET || ""))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  // Rate limit AI inference
  const rlTranscribe = await checkRateLimit(env.KV, token.slice(0, 8), "transcribe", RATE_LIMITS.ai);
  if (!rlTranscribe.allowed) return rateLimitResponse(corsHeaders);

  try {
    const contentType = request.headers.get("Content-Type") || "";
    let audioData: ArrayBuffer;

    if (contentType.includes("application/json")) {
      // JSON body with base64 audio
      const body = await request.json() as { audio: string };
      if (!body.audio) {
        return new Response(JSON.stringify({ error: "Missing audio data" }), {
          status: 400,
          headers: corsHeaders,
        });
      }
      // Decode base64
      const binaryString = atob(body.audio);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      audioData = bytes.buffer;
    } else {
      // Raw audio bytes
      audioData = await request.arrayBuffer();
    }

    const ai = new WorkersAIService(env);
    const text = await ai.transcribeAudio(audioData);

    return new Response(JSON.stringify({ text }), {
      headers: corsHeaders,
    });
  } catch (e) {
    console.error("Transcribe error:", e);
    return new Response(JSON.stringify({ error: "Transcription failed" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}

/**
 * Handle text-to-speech request using OpenAI tts-1-hd
 * Accepts: { text: string, speaker?: string }
 * Returns: OGG/Opus audio data
 * Voices: alloy, ash, coral, echo, fable, nova, onyx, sage, shimmer
 */
async function handleTTS(request: Request, env: Env): Promise<Response> {
  const corsHeaders = makeCorsHeaders(request);

  // Verify admin/worker secret
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (!token || (!await timingSafeCompare(token, env.MYA_WORKER_SECRET || "") && !await timingSafeCompare(token, env.ADMIN_SECRET || ""))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Rate limit AI inference
  const rlTts = await checkRateLimit(env.KV, token.slice(0, 8), "tts", RATE_LIMITS.ai);
  if (!rlTts.allowed) return rateLimitResponse({ ...corsHeaders, "Content-Type": "application/json" });

  if (!env.OPENAI_API_KEY) {
    return new Response(JSON.stringify({ error: "OPENAI_API_KEY not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await request.json() as { text: string; speaker?: string };
    if (!body.text) {
      return new Response(JSON.stringify({ error: "Missing text" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const validVoices = ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];
    const voice = validVoices.includes(body.speaker || "") ? body.speaker! : "onyx";

    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1-hd",
        input: body.text.substring(0, 4096),
        voice,
        response_format: "opus",
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("OpenAI TTS error:", response.status, err);
      return new Response(JSON.stringify({ error: `OpenAI TTS failed: ${response.status}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(response.body, {
      headers: {
        ...corsHeaders,
        "Content-Type": "audio/ogg",
      },
    });
  } catch (e) {
    console.error("TTS error:", e);
    return new Response(JSON.stringify({ error: "Text-to-speech failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

/**
 * Handle image description request (for Discord bot)
 * Accepts: image data as base64 or raw bytes, optional mimeType
 * Returns: { description: string }
 */
async function handleDescribeImage(request: Request, env: Env): Promise<Response> {
  const corsHeaders = {
    ...makeCorsHeaders(request),
    "Content-Type": "application/json",
  };

  // Verify auth — accept MYA_WORKER_SECRET, ADMIN_SECRET, or valid agent tokens
  const authResult = await verifyAIAuth(request, env);
  if (!authResult.ok) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }
  const token = authResult.token;

  // Rate limit AI inference
  const rlDescribe = await checkRateLimit(env.KV, token.slice(0, 8), "describe-image", RATE_LIMITS.ai);
  if (!rlDescribe.allowed) return rateLimitResponse(corsHeaders);

  try {
    const contentType = request.headers.get("Content-Type") || "";
    let imageData: ArrayBuffer;
    let mimeType = "image/jpeg";

    if (contentType.includes("application/json")) {
      // JSON body with base64 image
      const body = await request.json() as { image: string; mimeType?: string };
      if (!body.image) {
        return new Response(JSON.stringify({ error: "Missing image data" }), {
          status: 400,
          headers: corsHeaders,
        });
      }
      if (body.mimeType) mimeType = body.mimeType;
      // Decode base64
      const binaryString = atob(body.image);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      imageData = bytes.buffer;
    } else {
      // Raw image bytes
      imageData = await request.arrayBuffer();
      // Try to get mime type from Content-Type header
      if (contentType.includes("image/")) {
        mimeType = contentType.split(";")[0].trim();
      }
    }

    const ai = new WorkersAIService(env);
    const description = await ai.describeImage(imageData, mimeType);

    return new Response(JSON.stringify({ description }), {
      headers: corsHeaders,
    });
  } catch (e) {
    console.error("Describe image error:", e);
    return new Response(JSON.stringify({ error: "Image description failed" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}

/**
 * Handle attachment storage request (for Discord bot)
 * Accepts: { data: base64, userId: string, type: 'voice'|'image'|'video'|'file', filename?: string, mimeType?: string }
 * Returns: { key: string }
 */
async function handleStoreAttachment(request: Request, env: Env): Promise<Response> {
  const corsHeaders = {
    ...makeCorsHeaders(request),
    "Content-Type": "application/json",
  };

  // Verify admin/worker secret (accept either MYA_WORKER_SECRET or ADMIN_SECRET)
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (!token || (!await timingSafeCompare(token, env.MYA_WORKER_SECRET || "") && !await timingSafeCompare(token, env.ADMIN_SECRET || ""))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  try {
    const body = await request.json() as {
      data: string;
      userId: string;
      type: 'voice' | 'image' | 'video' | 'file';
      filename?: string;
      mimeType?: string;
    };

    if (!body.data || !body.userId || !body.type) {
      return new Response(JSON.stringify({ error: "Missing required fields: data, userId, type" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Decode base64 data
    const binaryString = atob(body.data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const arrayBuffer = bytes.buffer;

    // Generate unique key
    const timestamp = Date.now();
    const randomBytes = new Uint8Array(16);
    crypto.getRandomValues(randomBytes);
    const random = Array.from(randomBytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Determine extension
    let extension = 'bin';
    if (body.filename) {
      extension = body.filename.split('.').pop() || 'bin';
    } else if (body.mimeType) {
      const mimeExtMap: Record<string, string> = {
        'audio/ogg': 'ogg',
        'audio/mpeg': 'mp3',
        'audio/wav': 'wav',
        'audio/mp4': 'm4a',
        'audio/webm': 'webm',
        'video/mp4': 'mp4',
        'video/quicktime': 'mov',
        'video/webm': 'webm',
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'application/pdf': 'pdf',
      };
      extension = mimeExtMap[body.mimeType] || body.mimeType.split('/')[1] || 'bin';
    }

    const key = `${body.userId}/${body.type}/${timestamp}-${random}.${extension}`;

    // Store in R2
    await env.BUCKET.put(key, arrayBuffer, {
      customMetadata: {
        type: body.type,
        ...(body.mimeType ? { mimeType: body.mimeType } : {}),
        ...(body.filename ? { originalFilename: body.filename } : {}),
      },
    });

    return new Response(JSON.stringify({ key }), {
      headers: corsHeaders,
    });
  } catch (e) {
    console.error("Store attachment error:", e);
    return new Response(JSON.stringify({ error: "Attachment storage failed" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}

// Commands that don't require user registration
const PUBLIC_COMMANDS = ["/start", "/register", "/help", "/portal"];

/**
 * Check rate limit for public commands (30/hour per Telegram ID)
 */
async function checkPublicCommandRateLimit(
  env: Env,
  telegramId: number
): Promise<{ allowed: boolean; count: number }> {
  if (!env.KV) return { allowed: true, count: 0 };

  const key = `ratelimit:public:hour:${telegramId}`;
  const count = parseInt((await env.KV.get(key)) || "0");

  if (count >= 30) {
    return { allowed: false, count };
  }

  await env.KV.put(key, String(count + 1), { expirationTtl: 3600 });
  return { allowed: true, count: count + 1 };
}

/**
 * Handle incoming webhook from Telegram
 * Security layers:
 * 1. Telegram webhook secret verification (proves request is from Telegram)
 * 2. Update ID deduplication via KV (prevents processing same update twice)
 * 3. Command classification (public vs authenticated)
 * 4. Rate limiting for public commands
 * 5. User authentication for non-public commands
 * 6. Audit logging for security events
 *
 * All messages that go to Claude (text, voice, photos, video) are queued for async processing.
 * Only public commands (/start, /register, /help, /portal) are processed synchronously.
 */
async function handleWebhook(
  request: Request,
  env: Env,
  execCtx: ExecutionContext
): Promise<Response> {
  console.log("Webhook received");
  const telegram = new TelegramService(env);
  const supabase = new SupabaseService(env);

  // Layer 1: Verify Telegram webhook secret
  if (!telegram.verifySecret(request, env.TELEGRAM_WEBHOOK_SECRET)) {
    console.log("Secret verification failed");
    return new Response("OK", { status: 200 });
  }
  console.log("Secret verified");

  // Parse the update
  const update = (await request.json()) as TelegramUpdate;
  console.log(
    "Update ID:",
    update.update_id,
    "Type:",
    Object.keys(update).join(", ")
  );

  // Layer 2: Deduplication - check if we've already processed this update_id
  if (env.KV) {
    const dedupeKey = `tg_update:${update.update_id}`;
    const alreadyProcessed = await env.KV.get(dedupeKey);
    if (alreadyProcessed) {
      console.log(
        `Duplicate update ${update.update_id} - skipping (status: ${alreadyProcessed})`
      );
      return new Response("OK", { status: 200 });
    }
    await env.KV.put(dedupeKey, "processing", { expirationTtl: 600 });
    console.log(`Marked update ${update.update_id} as processing`);
  }

  // Extract message info for authorization
  const fromId = update.message?.from?.id;
  const fromUsername = update.message?.from?.username;
  const messageText = update.message?.text || "";

  if (!fromId) {
    console.log("No from.id in message, skipping");
    return new Response("OK", { status: 200 });
  }

  // Check message type
  const isVoice = !!update.message?.voice;
  const isPhoto = !!update.message?.photo;
  const isVideo = !!update.message?.video;
  const isDocument = !!update.message?.document;

  // Layer 3: Command classification
  const isCommand = messageText.startsWith("/");
  const isPublicCommand = PUBLIC_COMMANDS.some((cmd) =>
    messageText.toLowerCase().startsWith(cmd)
  );

  // Queue messages that will call Claude (15-minute timeout vs webhook's ~30 seconds)
  // - Plain text messages (not commands) → go to Claude
  // - Media messages (voice, photo, video, document) → go to Claude
  // - Commands → fast, don't call Claude, run synchronously
  const isMediaMessage = isVoice || isPhoto || isVideo || isDocument;
  const isPlainTextMessage = !isCommand && messageText.length > 0;
  const needsQueueProcessing = isMediaMessage || isPlainTextMessage;

  console.log(
    `From: ${fromId}, Public: ${isPublicCommand}, Queue: ${needsQueueProcessing}, Voice: ${isVoice}`
  );

  // Layer 5: User authentication for non-public commands
  if (!isPublicCommand) {
    const user = await supabase.getUserByTelegramId(fromId);

    if (!user) {
      console.log(`Unregistered user attempted non-public command: ${fromId}`);
      await supabase.logAuthEvent(
        fromId,
        fromUsername,
        "unauthorized_command",
        false,
        null,
        "Not registered",
        request.headers.get("CF-Connecting-IP") || "unknown"
      );

      // Send helpful message
      const bot = telegram.getBot();
      try {
        await bot.init();
        await bot.api.sendMessage(
          fromId,
          "You need to register first.\n\nSend /start to begin registration."
        );
      } catch (e) {
        console.error("Failed to send registration prompt:", e);
      }
      return new Response("OK", { status: 200 });
    }

    // Check user status
    if (user.status === "suspended") {
      console.warn(`Suspended user attempted access: ${fromId}`);
      return new Response("OK", { status: 200 });
    }
  }

  // Queue messages for async processing (15-minute timeout vs webhook's ~30-60 seconds)
  // All messages that go to Claude are queued - only public commands run synchronously
  if (needsQueueProcessing && env.TELEGRAM_QUEUE) {
    const msgType = isVoice ? 'voice' : isPhoto ? 'photo' : isVideo ? 'video' : isDocument ? 'document' : 'text';
    console.log(`[Queue] Queuing ${msgType} message for async processing`);

    // Queue the message for processing
    // Note: "Transcribing..." indicator is sent by the message handler (which also deletes it)
    const queueMessage: TelegramQueueMessage = {
      update,
      receivedAt: Date.now(),
    };
    await env.TELEGRAM_QUEUE.send(queueMessage);
    console.log(`[Queue] Message ${update.update_id} queued successfully`);

    return new Response("OK", { status: 200 });
  }

  // For commands, process synchronously (they're fast, don't call Claude)
  const bot = telegram.getBot();

  // Register message handler
  bot.on("message", async (ctx) => {
    console.log("Message handler triggered for update:", update.update_id);
    const ctxFromId = ctx.from?.id;

    // For authenticated commands, verify user exists (defense in depth)
    const text = telegram.getMessageContent(ctx);
    const commandInfo = telegram.extractCommand(text);
    const ctxIsPublicCommand =
      commandInfo &&
      PUBLIC_COMMANDS.some(
        (cmd) => commandInfo.command.toLowerCase() === cmd.replace("/", "")
      );

    if (!ctxIsPublicCommand) {
      const user = await supabase.getUserByTelegramId(ctxFromId!);
      if (!user) {
        console.warn(`Unauthorized in handler: ${ctxFromId}`);
        return;
      }
    }

    try {
      console.log(`Text: ${text?.substring(0, 50)}`);

      if (commandInfo) {
        console.log(`Command: ${commandInfo.command}`);
        const handled = await handleCommand(
          ctx,
          commandInfo.command,
          commandInfo.args,
          env
        );
        if (handled) {
          if (env.KV) {
            await env.KV.put(`tg_update:${update.update_id}`, "completed", {
              expirationTtl: 300,
            });
          }
          return;
        }
      }

      console.log("Calling handleMessage");
      await handleMessage(ctx, env);
      console.log("handleMessage done");

      if (env.KV) {
        await env.KV.put(`tg_update:${update.update_id}`, "completed", {
          expirationTtl: 300,
        });
      }
    } catch (e) {
      console.error("Handler error:", e);
      if (env.KV) {
        await env.KV.put(`tg_update:${update.update_id}`, "error", {
          expirationTtl: 300,
        });
      }
      await telegram.reply(ctx, "Something went wrong. Please try again.");
    }
  });

  console.log("Initializing bot");

  try {
    await bot.init();
    console.log("Bot initialized");
    await bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]);
    console.log("Update handled");
  } catch (e) {
    console.error("Update error:", e);
  }

  return new Response("OK", { status: 200 });
}

/**
 * Repair Obsidian folder assignments
 * Creates missing folders from document source_paths and assigns folder_id
 * PROTECTED: Requires admin secret in Authorization header
 */
async function repairObsidianFolders(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (!token || !await timingSafeCompare(token, env.ADMIN_SECRET || "")) {
    return new Response("Not Found", { status: 404 });
  }

  try {
    const supabase = new SupabaseService(env);
    const client = supabase.getClient();

    // Get the user (single-user app)
    const user = await supabase.getOrCreateUser(
      parseInt(env.OWNER_TELEGRAM_ID),
      undefined,
      env.OWNER_NAME || "User"
    );
    const userId = user.id;

    // Get all Obsidian documents that need folder assignment
    const { data: obsidianDocs, error: docsError } = await client
      .from('documents')
      .select('id, source_path, path, folder_id')
      .eq('user_id', userId)
      .eq('source_type', 'obsidian')
      .limit(50000);

    if (docsError) {
      return new Response(JSON.stringify({ error: docsError.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const docs = obsidianDocs || [];
    console.log(`[repair] Found ${docs.length} Obsidian documents`);

    // Determine vault name from existing paths (e.g., "obsidian/natitaw.core/..." -> "natitaw.core")
    const vaultNames = new Set<string>();
    for (const doc of docs) {
      if (doc.path?.startsWith('obsidian/')) {
        const parts = doc.path.split('/');
        if (parts.length >= 2) {
          vaultNames.add(parts[1]);
        }
      }
    }

    console.log(`[repair] Found vaults: ${Array.from(vaultNames).join(', ')}`);

    let totalFixed = 0;
    let totalFoldersCreated = 0;
    const allDebug: Record<string, unknown> = {};

    // Sample source_paths for debugging
    const samplePaths = docs.slice(0, 20).map(d => ({
      source_path: d.source_path,
      path: d.path,
      folder_id: d.folder_id,
    }));
    allDebug.sampleSourcePaths = samplePaths;

    for (const vaultName of vaultNames) {
      const vaultDebug: Record<string, unknown> = {};
      // Get ALL docs for this vault
      const vaultDocs = docs.filter(d => d.path?.startsWith(`obsidian/${vaultName}/`));
      vaultDebug.totalDocs = vaultDocs.length;

      if (vaultDocs.length === 0) continue;

      // Collect all unique folder paths from source_paths
      const folderPaths = new Set<string>();
      for (const doc of vaultDocs) {
        if (!doc.source_path) continue;
        const parts = doc.source_path.split('/');
        parts.pop(); // Remove filename
        const folderPath = parts.join('/');
        if (folderPath) {
          const pathParts = folderPath.split('/');
          let current = '';
          for (const part of pathParts) {
            current = current ? `${current}/${part}` : part;
            folderPaths.add(current);
          }
        }
      }
      vaultDebug.uniqueFolderPaths = Array.from(folderPaths).slice(0, 30);

      // Get or create vault root folder
      let vaultFolderId: string;
      const { data: existingVault } = await client
        .from('folders')
        .select('id')
        .eq('user_id', userId)
        .eq('name', vaultName)
        .eq('folder_type', 'user')
        .is('parent_id', null)
        .single();

      if (existingVault) {
        vaultFolderId = existingVault.id;
      } else {
        const { data: newVault, error: vaultErr } = await client
          .from('folders')
          .insert({
            user_id: userId,
            name: vaultName,
            parent_id: null,
            folder_type: 'user',
            icon: '📚',
            sort_order: 0
          })
          .select('id')
          .single();

        if (vaultErr || !newVault) {
          console.error(`[repair] Failed to create vault folder:`, vaultErr);
          continue;
        }
        vaultFolderId = newVault.id;
        totalFoldersCreated++;
      }
      vaultDebug.vaultFolderId = vaultFolderId;

      // Get all existing folders for this user
      const { data: existingFolders } = await client
        .from('folders')
        .select('id, name, parent_id')
        .eq('user_id', userId)
        .eq('folder_type', 'user')
        .limit(10000);

      vaultDebug.existingFolderCount = existingFolders?.length || 0;

      // Build lookup: "parentId:name" -> folderId
      const existingByKey = new Map<string, string>();
      for (const f of existingFolders || []) {
        existingByKey.set(`${f.parent_id || 'root'}:${f.name}`, f.id);
      }

      // Build folderPath -> folderId map
      const folderMap = new Map<string, string>();
      folderMap.set('', vaultFolderId);

      // Sort by depth (parents first)
      const sortedPaths = Array.from(folderPaths).sort((a, b) =>
        a.split('/').length - b.split('/').length
      );

      const folderLookupDebug: Array<{path: string, name: string, parentPath: string, parentId: string, key: string, found: boolean}> = [];

      for (const folderPath of sortedPaths) {
        const parts = folderPath.split('/');
        const folderName = parts[parts.length - 1];
        const parentPath = parts.slice(0, -1).join('/');
        const parentId = folderMap.get(parentPath) || vaultFolderId;
        const key = `${parentId}:${folderName}`;
        const existingId = existingByKey.get(key);

        if (folderLookupDebug.length < 15) {
          folderLookupDebug.push({
            path: folderPath,
            name: folderName,
            parentPath,
            parentId,
            key,
            found: !!existingId,
          });
        }

        if (existingId) {
          folderMap.set(folderPath, existingId);
        } else {
          // Create it
          const { data: newFolder, error: folderErr } = await client
            .from('folders')
            .insert({
              user_id: userId,
              name: folderName,
              parent_id: parentId,
              folder_type: 'user',
              sort_order: 0
            })
            .select('id')
            .single();

          if (folderErr) {
            if (folderErr.code === '23505') {
              const { data: found } = await client
                .from('folders')
                .select('id')
                .eq('user_id', userId)
                .eq('name', folderName)
                .eq('parent_id', parentId)
                .single();
              if (found) {
                folderMap.set(folderPath, found.id);
                existingByKey.set(key, found.id);
              }
            } else {
              console.error(`[repair] Failed to create folder ${folderPath}:`, folderErr);
            }
            continue;
          }

          folderMap.set(folderPath, newFolder.id);
          existingByKey.set(key, newFolder.id);
          totalFoldersCreated++;
        }
      }

      vaultDebug.folderLookupDebug = folderLookupDebug;
      vaultDebug.folderMapSize = folderMap.size;

      // Now update ALL documents with correct folder_id based on source_path
      // Group by target folder to do bulk updates instead of one-at-a-time
      let needsUpdate = 0;
      let alreadyCorrect = 0;
      let noSourcePath = 0;
      let rootLevel = 0;
      const debugSamples: Array<{source_path: string, currentFolder: string | null, correctFolder: string, folderPath: string, mapHit: boolean}> = [];

      // Group doc IDs by their correct folder_id
      const updateGroups = new Map<string, string[]>();

      for (const doc of vaultDocs) {
        if (!doc.source_path) {
          noSourcePath++;
          continue;
        }

        const parts = doc.source_path.split('/');
        parts.pop();
        const folderPath = parts.join('/');

        if (!folderPath) {
          rootLevel++;
          continue;
        }

        const mappedFolder = folderMap.get(folderPath);
        const correctFolderId = mappedFolder || folderMap.get('') || vaultFolderId;

        if (doc.folder_id === correctFolderId) {
          alreadyCorrect++;
          continue;
        }

        needsUpdate++;
        if (debugSamples.length < 10) {
          debugSamples.push({
            source_path: doc.source_path,
            currentFolder: doc.folder_id,
            correctFolder: correctFolderId,
            folderPath,
            mapHit: !!mappedFolder,
          });
        }

        if (!updateGroups.has(correctFolderId)) {
          updateGroups.set(correctFolderId, []);
        }
        updateGroups.get(correctFolderId)!.push(doc.id);
      }

      // Execute bulk updates - one query per target folder
      vaultDebug.updateGroupCount = updateGroups.size;
      for (const [targetFolderId, docIds] of updateGroups) {
        // Supabase .in() has a limit, batch in chunks of 500
        for (let i = 0; i < docIds.length; i += 500) {
          const chunk = docIds.slice(i, i + 500);
          const { error: updateErr } = await client
            .from('documents')
            .update({ folder_id: targetFolderId })
            .in('id', chunk);

          if (updateErr) {
            console.error(`[repair] Bulk update failed for folder ${targetFolderId}:`, updateErr);
          } else {
            totalFixed += chunk.length;
          }
        }
      }

      vaultDebug.rootLevel = rootLevel;
      vaultDebug.alreadyCorrect = alreadyCorrect;
      vaultDebug.needsUpdate = needsUpdate;
      vaultDebug.noSourcePath = noSourcePath;
      vaultDebug.debugSamples = debugSamples;
      allDebug[vaultName] = vaultDebug;
    }

    return new Response(JSON.stringify({
      ok: true,
      totalDocs: docs.length,
      foldersCreated: totalFoldersCreated,
      docsFixed: totalFixed,
      vaults: Array.from(vaultNames),
      debug: allDebug,
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error("[repair] Error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Seed documents with initial data
 * PROTECTED: Requires admin secret in Authorization header
 * Run once to populate the owner's context
 */
async function seedDocuments(request: Request, env: Env): Promise<Response> {
  // Require admin secret
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (!token || !await timingSafeCompare(token, env.ADMIN_SECRET || "")) {
    return new Response("Not Found", { status: 404 });
  }

  try {
    const supabase = new SupabaseService(env);

    // Get or create user (using owner telegram ID)
    const user = await supabase.getOrCreateUser(
      parseInt(env.OWNER_TELEGRAM_ID),
      undefined,
      env.OWNER_NAME || "User"
    );

    console.log(`Seeding documents for user ${user.id}`);

    // Insert all documents
    let inserted = 0;
    let updated = 0;

    for (const doc of SEED_DOCUMENTS) {
      const existing = await supabase.getDocument(user.id, doc.path);

      await supabase.upsertDocument({
        user_id: user.id,
        path: doc.path,
        title: doc.title,
        content: doc.content,
        summary: doc.title,
        is_internal: doc.is_internal,
        metadata: {},
      });

      if (existing) {
        updated++;
      } else {
        inserted++;
      }
      console.log(`${existing ? "Updated" : "Inserted"}: ${doc.path}`);
    }

    // Seed initial tags
    await supabase.seedInitialTags(user.id);
    console.log("Seeded initial tags");

    // Seed people
    const peopleCount = await supabase.seedPeople(user.id, SEED_PEOPLE);
    console.log(`Seeded ${peopleCount} people`);

    return new Response(
      JSON.stringify({
        ok: true,
        message: `Seeded ${inserted} new documents, updated ${updated} existing, ${peopleCount} people`,
        user_id: user.id,
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (e) {
    console.error("Seed error:", e);
    return new Response(
      JSON.stringify({ ok: false, error: "Seed operation failed" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

/**
 * Verify HMAC-SHA256 signature for signed URLs
 */
/**
 * Verify attachment signature
 * Signature format: HMAC-SHA256({key}:{userId}:{expires})
 * Also verifies that the key starts with the claimed userId for defense-in-depth
 */
async function verifySignature(
  key: string,
  userId: string,
  expires: string,
  sig: string,
  secret: string
): Promise<boolean> {
  // Defense-in-depth: verify key belongs to claimed user
  if (!key.startsWith(userId + "/")) {
    console.error(`Key ownership mismatch: key=${key}, userId=${userId}`);
    return false;
  }

  const message = `${key}:${userId}:${expires}`;
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const msgData = encoder.encode(message);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  const expectedSig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  return timingSafeCompare(sig, expectedSig);
}

/**
 * Verify Stream token signature
 * Signature format: HMAC-SHA256({uid}:{expires})
 * Stream UIDs are not user-scoped, so no user_id verification needed
 */
async function verifyStreamSignature(
  uid: string,
  expires: string,
  sig: string,
  secret: string
): Promise<boolean> {
  const message = `${uid}:${expires}`;
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const msgData = encoder.encode(message);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  const expectedSig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  return timingSafeCompare(sig, expectedSig);
}

/**
 * Serve attachment from R2
 * Supports two auth methods:
 * 1. Signed URL (ATTACHMENT_SECRET) — for portal/browser direct access
 * 2. Bearer token (MYA_WORKER_SECRET) — for server-side proxy access
 */
async function serveAttachment(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // CORS headers - iOS Safari needs exposed headers for video streaming
  const corsHeaders: Record<string, string> = {
    ...makeCorsHeaders(request),
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
  };

  // Extract parameters
  const key = decodeURIComponent(url.pathname.replace("/attachments/", ""));
  const expires = url.searchParams.get("expires");
  const userId = url.searchParams.get("uid");
  const sig = url.searchParams.get("sig");

  if (!key) {
    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }

  // Check for Bearer token auth (server-side proxy access)
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;
  const hasBearerAuth = bearerToken && env.MYA_WORKER_SECRET && await timingSafeCompare(bearerToken, env.MYA_WORKER_SECRET);

  // Verify auth: either Bearer token or signed URL
  if (!hasBearerAuth) {
    const attachmentSecret = env.ATTACHMENT_SECRET;
    if (!attachmentSecret) {
      // No ATTACHMENT_SECRET configured and no valid bearer token — deny access
      return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    }

    if (!expires || !sig || !userId) {
      return new Response("Missing signature parameters", { status: 401, headers: corsHeaders });
    }

    // Check expiry
    const expiresTime = parseInt(expires, 10);
    if (isNaN(expiresTime) || expiresTime < Math.floor(Date.now() / 1000)) {
      return new Response("URL expired", { status: 401, headers: corsHeaders });
    }

    // Verify signature (also checks key belongs to userId)
    const valid = await verifySignature(key, userId, expires, sig, attachmentSecret);
    if (!valid) {
      return new Response("Invalid signature", { status: 401, headers: corsHeaders });
    }
  }

  // Get file from R2
  const object = await env.BUCKET.get(key);

  if (!object) {
    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }

  // Determine content type - prefer stored mimeType from metadata, fall back to extension
  let contentType = object.customMetadata?.mimeType || "application/octet-stream";

  // If no stored mimeType, determine from file extension
  if (contentType === "application/octet-stream") {
    // Audio
    if (key.endsWith(".ogg")) contentType = "audio/ogg";
    else if (key.endsWith(".mp3")) contentType = "audio/mpeg";
    else if (key.endsWith(".wav")) contentType = "audio/wav";
    // Video
    else if (key.endsWith(".mp4")) contentType = "video/mp4";
    else if (key.endsWith(".webm")) contentType = "video/webm";
    else if (key.endsWith(".mov")) contentType = "video/quicktime";
    else if (key.endsWith(".avi")) contentType = "video/x-msvideo";
    else if (key.endsWith(".mkv")) contentType = "video/x-matroska";
    // Images
    else if (key.endsWith(".jpg") || key.endsWith(".jpeg")) contentType = "image/jpeg";
    else if (key.endsWith(".png")) contentType = "image/png";
    else if (key.endsWith(".gif")) contentType = "image/gif";
    else if (key.endsWith(".webp")) contentType = "image/webp";
  }

  // Determine if this is a video/audio file that needs special handling for iOS Safari
  const isMediaFile = contentType.startsWith("video/") || contentType.startsWith("audio/");

  const headers: Record<string, string> = {
    ...corsHeaders,
    "Content-Type": contentType,
    // no-transform prevents Cloudflare from compressing/modifying - critical for iOS Safari video
    "Cache-Control": isMediaFile ? "private, max-age=3600, no-transform" : "private, max-age=3600",
    "Accept-Ranges": "bytes",
    "Content-Length": object.size.toString(),
  };

  // Handle HEAD requests (return headers only, no body)
  if (request.method === "HEAD") {
    return new Response(null, { headers });
  }

  // Handle range requests for audio/video seeking
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : object.size - 1;
      const chunkSize = end - start + 1;

      // Get the range from R2
      const rangeObject = await env.BUCKET.get(key, {
        range: { offset: start, length: chunkSize },
      });

      if (!rangeObject) {
        return new Response("Not Found", { status: 404, headers: corsHeaders });
      }

      return new Response(rangeObject.body, {
        status: 206,
        headers: {
          ...headers,
          "Content-Range": `bytes ${start}-${end}/${object.size}`,
          "Content-Length": chunkSize.toString(),
        },
        // @ts-ignore - Cloudflare-specific option to prevent encoding
        encodeBody: "manual",
      });
    }
  }

  // @ts-ignore - Cloudflare-specific option to prevent encoding for iOS Safari video compatibility
  return new Response(object.body, { headers, encodeBody: "manual" });
}

/**
 * Delete attachment from R2
 * Requires Authorization: Bearer {ATTACHMENT_SECRET}
 */
async function deleteAttachment(request: Request, env: Env): Promise<Response> {
  const corsHeaders: Record<string, string> = makeCorsHeaders(request);

  // Verify authorization — accept MYA_WORKER_SECRET (primary) or ATTACHMENT_SECRET (legacy)
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;
  const isAuthorized = bearerToken && (
    (env.MYA_WORKER_SECRET && bearerToken === env.MYA_WORKER_SECRET) ||
    (env.ATTACHMENT_SECRET && bearerToken === env.ATTACHMENT_SECRET)
  );

  if (!isAuthorized) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = new URL(request.url);
  const key = decodeURIComponent(url.pathname.replace("/attachments/", ""));

  if (!key) {
    return new Response(JSON.stringify({ error: "Key required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    await env.BUCKET.delete(key);
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Failed to delete from R2:", e);
    return new Response(JSON.stringify({ error: "Delete failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

/**
 * Generate a signed playback token for Cloudflare Stream videos
 * Security: Requires HMAC-signed request (same as R2 attachments)
 * Path: /stream-token/{uid}?expires={timestamp}&sig={signature}
 */
async function generateStreamToken(request: Request, env: Env): Promise<Response> {
  const corsHeaders: Record<string, string> = {
    ...makeCorsHeaders(request),
    "Content-Type": "application/json",
  };

  const url = new URL(request.url);
  const uid = url.pathname.replace("/stream-token/", "");

  if (!uid) {
    return new Response(JSON.stringify({ error: "Video UID required" }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  // Auth: Bearer token (MYA_WORKER_SECRET) or HMAC signature (ATTACHMENT_SECRET)
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;
  const hasBearerAuth = bearerToken && env.MYA_WORKER_SECRET && await timingSafeCompare(bearerToken, env.MYA_WORKER_SECRET);

  if (!hasBearerAuth) {
    const attachmentSecret = env.ATTACHMENT_SECRET;
    if (!attachmentSecret) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const expires = url.searchParams.get("expires");
    const sig = url.searchParams.get("sig");

    if (!expires || !sig) {
      return new Response(JSON.stringify({ error: "Missing signature" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    // Check expiry
    const expiresTime = parseInt(expires, 10);
    if (isNaN(expiresTime) || expiresTime < Math.floor(Date.now() / 1000)) {
      return new Response(JSON.stringify({ error: "URL expired" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    // Verify signature for Stream token (uses different format than R2 attachments)
    const valid = await verifyStreamSignature(uid, expires, sig, attachmentSecret);
    if (!valid) {
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        status: 401,
        headers: corsHeaders,
      });
    }
  }

  // Check Stream is configured
  if (!StreamService.isConfigured(env)) {
    return new Response(JSON.stringify({ error: "Stream not configured" }), {
      status: 500,
      headers: corsHeaders,
    });
  }

  try {
    const stream = new StreamService(env);

    // Note: requireSignedURLs is already set during upload, no need to update here
    const token = await stream.generateSignedToken(uid, 3600); // 1 hour token

    return new Response(JSON.stringify({
      success: true,
      token,
      embedUrl: StreamService.getSignedEmbedUrl(uid, token),
      hlsUrl: StreamService.getSignedHlsUrl(uid, token),
      thumbnailUrl: StreamService.getSignedThumbnailUrl(uid, token),
    }), {
      headers: corsHeaders,
    });
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error("Failed to generate Stream token:", errorMessage);
    return new Response(JSON.stringify({
      error: "Failed to generate token",
      details: errorMessage
    }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}

/**
 * Delete a video from Cloudflare Stream
 * Security: Requires Bearer token matching ATTACHMENT_SECRET
 * Path: /stream-delete/{uid}
 */
async function deleteStreamVideo(request: Request, env: Env): Promise<Response> {
  const corsHeaders: Record<string, string> = {
    ...makeCorsHeaders(request),
    "Content-Type": "application/json",
  };

  const url = new URL(request.url);
  const uid = url.pathname.replace("/stream-delete/", "");

  if (!uid) {
    return new Response(JSON.stringify({ error: "Video UID required" }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  // Verify authorization — accept MYA_WORKER_SECRET (primary) or ATTACHMENT_SECRET (legacy)
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;
  const isAuthorized = bearerToken && (
    (env.MYA_WORKER_SECRET && bearerToken === env.MYA_WORKER_SECRET) ||
    (env.ATTACHMENT_SECRET && bearerToken === env.ATTACHMENT_SECRET)
  );

  if (!isAuthorized) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  // Check Stream is configured
  if (!StreamService.isConfigured(env)) {
    return new Response(JSON.stringify({ error: "Stream not configured" }), {
      status: 500,
      headers: corsHeaders,
    });
  }

  try {
    const stream = new StreamService(env);
    const deleted = await stream.deleteVideo(uid);

    if (!deleted) {
      return new Response(JSON.stringify({ error: "Failed to delete video" }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: corsHeaders,
    });
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error("Failed to delete Stream video:", errorMessage);
    return new Response(JSON.stringify({
      error: "Failed to delete video",
      details: errorMessage
    }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}

/**
 * Generate BGE-M3 embeddings for territories, semantic themes, and realms
 * PROTECTED: Requires admin secret in Authorization header
 */
async function generateEmbeddings(request: Request, env: Env): Promise<Response> {
  // Require admin secret
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (!token || !await timingSafeCompare(token, env.ADMIN_SECRET || "")) {
    return new Response("Not Found", { status: 404 });
  }

  const body = await request.json() as { user_id?: string; force?: boolean };
  if (!body.user_id) {
    return new Response(JSON.stringify({ error: "user_id required" }), { status: 400 });
  }

  const userId = body.user_id;
  const force = body.force === true;
  const supabase = new SupabaseService(env);

  // Helper to get embeddings using Workers AI binding
  async function getEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await env.AI.run("@cf/baai/bge-m3", { text: texts }) as { data: number[][] };
    return response.data;
  }

  const results = {
    territories_embedded: 0,
    semantic_themes_embedded: 0,
    realms_embedded: 0,
    documents_embedded: 0,
    territories_skipped: 0,
    semantic_themes_skipped: 0,
    realms_skipped: 0,
    documents_skipped: 0,
    documents_unchanged: 0,
    errors: [] as string[],
  };

  // Simple hash function for content change detection
  async function hashContent(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  }

  try {
    // ===== TERRITORIES =====
    const { data: territories } = await supabase.getClient()
      .from("territory_profiles")
      .select("territory_id, name, essence, embedding")
      .eq("user_id", userId);

    const territoriesToEmbed = (territories || []).filter(
      (t) => force || !t.embedding
    );

    if (territoriesToEmbed.length > 0) {
      const batchSize = 50;
      for (let i = 0; i < territoriesToEmbed.length; i += batchSize) {
        const batch = territoriesToEmbed.slice(i, i + batchSize);
        const texts: string[] = [];
        const ids: number[] = [];

        for (const t of batch) {
          let text = t.name || "";
          if (t.essence) text += " " + t.essence;
          text = text.trim();

          if (!text) {
            results.territories_skipped++;
            continue;
          }

          texts.push(text);
          ids.push(t.territory_id);
        }

        if (texts.length > 0) {
          const embeddings = await getEmbeddings(texts);
          for (let j = 0; j < ids.length; j++) {
            const { error } = await supabase.getClient()
              .from("territory_profiles")
              .update({ embedding: embeddings[j] })
              .eq("user_id", userId)
              .eq("territory_id", ids[j]);

            if (error) {
              results.errors.push(`Territory ${ids[j]}: ${error.message}`);
            } else {
              results.territories_embedded++;
            }
          }
        }
      }
    }

    // ===== SEMANTIC THEMES =====
    const { data: themes } = await supabase.getClient()
      .from("semantic_themes")
      .select("realm_id, semantic_theme_id, name, essence, embedding")
      .eq("user_id", userId);

    const themesToEmbed = (themes || []).filter((t) => force || !t.embedding);

    if (themesToEmbed.length > 0) {
      const batchSize = 50;
      for (let i = 0; i < themesToEmbed.length; i += batchSize) {
        const batch = themesToEmbed.slice(i, i + batchSize);
        const texts: string[] = [];
        const keys: Array<{ realm_id: number; semantic_theme_id: number }> = [];

        for (const t of batch) {
          let text = t.name || "";
          if (t.essence) text += " " + t.essence;
          text = text.trim();

          if (!text) {
            results.semantic_themes_skipped++;
            continue;
          }

          texts.push(text);
          keys.push({ realm_id: t.realm_id, semantic_theme_id: t.semantic_theme_id });
        }

        if (texts.length > 0) {
          const embeddings = await getEmbeddings(texts);
          for (let j = 0; j < keys.length; j++) {
            const { error } = await supabase.getClient()
              .from("semantic_themes")
              .update({ embedding: embeddings[j] })
              .eq("user_id", userId)
              .eq("realm_id", keys[j].realm_id)
              .eq("semantic_theme_id", keys[j].semantic_theme_id);

            if (error) {
              results.errors.push(`SemanticTheme ${keys[j].realm_id}-${keys[j].semantic_theme_id}: ${error.message}`);
            } else {
              results.semantic_themes_embedded++;
            }
          }
        }
      }
    }

    // ===== REALMS =====
    const { data: realms } = await supabase.getClient()
      .from("realms")
      .select("realm_id, name, essence, embedding")
      .eq("user_id", userId);

    const realmsToEmbed = (realms || []).filter((r) => force || !r.embedding);

    if (realmsToEmbed.length > 0) {
      const texts: string[] = [];
      const ids: number[] = [];

      for (const r of realmsToEmbed) {
        let text = r.name || "";
        if (r.essence) text += " " + r.essence;
        text = text.trim();

        if (!text) {
          results.realms_skipped++;
          continue;
        }

        texts.push(text);
        ids.push(r.realm_id);
      }

      if (texts.length > 0) {
        const embeddings = await getEmbeddings(texts);
        for (let j = 0; j < ids.length; j++) {
          const { error } = await supabase.getClient()
            .from("realms")
            .update({ embedding: embeddings[j] })
            .eq("user_id", userId)
            .eq("realm_id", ids[j]);

          if (error) {
            results.errors.push(`Realm ${ids[j]}: ${error.message}`);
          } else {
            results.realms_embedded++;
          }
        }
      }
    }

    // ===== DOCUMENTS =====
    // Only regenerate embeddings if content has changed (tracked via hash in metadata)
    const { data: documents } = await supabase.getClient()
      .from("documents")
      .select("id, path, content, embedding, metadata")
      .eq("user_id", userId);

    if (documents && documents.length > 0) {
      const batchSize = 20; // Smaller batches for potentially longer content
      const docsToEmbed: Array<{ id: string; path: string; content: string; newHash: string }> = [];

      // First pass: determine which docs need embedding
      for (const doc of documents) {
        if (!doc.content || doc.content.trim().length === 0) {
          results.documents_skipped++;
          continue;
        }

        const newHash = await hashContent(doc.content);
        const existingHash = doc.metadata?.embedding_content_hash;

        // Skip if hash unchanged and embedding exists (unless force=true)
        if (!force && doc.embedding && existingHash === newHash) {
          results.documents_unchanged++;
          continue;
        }

        docsToEmbed.push({ id: doc.id, path: doc.path, content: doc.content, newHash });
      }

      // Process in batches
      for (let i = 0; i < docsToEmbed.length; i += batchSize) {
        const batch = docsToEmbed.slice(i, i + batchSize);
        const texts = batch.map(d => d.content.slice(0, 8000)); // Truncate very long docs

        if (texts.length > 0) {
          const embeddings = await getEmbeddings(texts);

          for (let j = 0; j < batch.length; j++) {
            const doc = batch[j];
            const existingMetadata = documents.find(d => d.id === doc.id)?.metadata || {};

            const { error } = await supabase.getClient()
              .from("documents")
              .update({
                embedding: embeddings[j],
                metadata: { ...existingMetadata, embedding_content_hash: doc.newHash },
              })
              .eq("user_id", userId)
              .eq("id", doc.id);

            if (error) {
              results.errors.push(`Document ${doc.path}: ${error.message}`);
            } else {
              results.documents_embedded++;
            }
          }
        }
      }
    }

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error("Generate embeddings error:", errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * Backfill embeddings for agent messages (Discord bot messages)
 * These messages are saved without embeddings and need BGE-M3 embeddings for search
 * PROTECTED: Requires admin secret in Authorization header
 */
async function handleBackfillAgentEmbeddings(request: Request, env: Env): Promise<Response> {
  // Require admin secret
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (!token || !await timingSafeCompare(token, env.ADMIN_SECRET || "")) {
    return new Response("Not Found", { status: 404 });
  }

  const body = await request.json() as {
    agent_id?: string;
    batch_size?: number;
    max_messages?: number;
  };

  const agentId = body.agent_id || "company-agent";
  const batchSize = Math.min(body.batch_size || 50, 100); // Max 100 per batch
  const maxMessages = body.max_messages || 500; // Default limit

  const supabase = new SupabaseService(env);
  const workersAI = new WorkersAIService(env);

  const results = {
    agent_id: agentId,
    messages_processed: 0,
    messages_embedded: 0,
    messages_skipped: 0,
    errors: [] as string[],
  };

  try {
    // Fetch messages without embeddings for this agent
    const { data: messages, error: fetchError } = await supabase.getClient()
      .from("messages")
      .select("id, content")
      .eq("agent_id", agentId)
      .is("embedding", null)
      .order("created_at", { ascending: false })
      .limit(maxMessages);

    if (fetchError) {
      throw new Error(`Failed to fetch messages: ${fetchError.message}`);
    }

    if (!messages || messages.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: "No messages need embeddings",
        results
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log(`[Backfill] Processing ${messages.length} messages for agent ${agentId}`);

    // Process in batches
    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      const texts: string[] = [];
      const ids: string[] = [];

      for (const msg of batch) {
        const content = msg.content?.trim();
        if (!content) {
          results.messages_skipped++;
          continue;
        }
        // Truncate to 8000 chars (BGE-M3 limit)
        texts.push(content.substring(0, 8000));
        ids.push(msg.id);
      }

      if (texts.length === 0) continue;

      try {
        // Generate embeddings using Workers AI (same as portal)
        const response = await env.AI.run("@cf/baai/bge-m3", { text: texts }) as { data: number[][] };
        const embeddings = response.data;

        // Update each message with its embedding
        for (let j = 0; j < ids.length; j++) {
          const { error: updateError } = await supabase.getClient()
            .from("messages")
            .update({ embedding: embeddings[j] })
            .eq("id", ids[j]);

          if (updateError) {
            results.errors.push(`Message ${ids[j].substring(0, 8)}: ${updateError.message}`);
          } else {
            results.messages_embedded++;
          }
        }

        results.messages_processed += batch.length;
        console.log(`[Backfill] Processed batch ${Math.floor(i / batchSize) + 1}: ${ids.length} embedded`);

      } catch (batchError) {
        const errorMsg = batchError instanceof Error ? batchError.message : String(batchError);
        results.errors.push(`Batch ${Math.floor(i / batchSize) + 1}: ${errorMsg}`);
        console.error(`[Backfill] Batch error:`, errorMsg);
      }

      // Small delay between batches to avoid rate limits
      if (i + batchSize < messages.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    console.log(`[Backfill] Complete: ${results.messages_embedded} embedded, ${results.messages_skipped} skipped, ${results.errors.length} errors`);

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error("[Backfill] Error:", errorMessage);
    return new Response(JSON.stringify({ error: errorMessage, results }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * Generate embedding for a single text
 * Used by agent servers for semantic search queries
 * PROTECTED: Requires MYA_WORKER_SECRET or ADMIN_SECRET
 */

/**
 * Handle waitlist email signup
 * PUBLIC: No auth required (called from landing page)
 * Stores email in D1 waitlist table + sends Resend notification
 */
async function handleWaitlistSignup(request: Request, env: Env): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  try {
    const body = await request.json() as { email?: string; source?: string };
    const email = body.email?.trim().toLowerCase();

    if (!email || !email.includes("@")) {
      return new Response(JSON.stringify({ error: "Invalid email" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Store in D1
    try {
      await env.DB.prepare(
        "INSERT INTO waitlist (email, source, created_at) VALUES (?, ?, datetime('now')) ON CONFLICT(email) DO NOTHING"
      ).bind(email, body.source || "landing").run();
    } catch (dbErr: any) {
      console.log("Waitlist DB insert (may be dupe):", dbErr.message);
    }

    // Count total signups for the notification
    const countResult = await env.DB.prepare("SELECT COUNT(*) as total FROM waitlist").first<{ total: number }>();
    const total = countResult?.total || "?";

    // Send emails via Resend
    if (env.RESEND_API_KEY) {
      const resendHeaders = {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      };

      // 1. Welcome email to subscriber
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: resendHeaders,
          body: JSON.stringify({
            from: env.EMAIL_FROM || "Mycelium <noreply@example.com>",
            to: email,
            subject: "You're on the Mycelium waitlist",
            text: `Hey — thanks for signing up for Mycelium.\n\nWe're building an open-source agent framework that gives AI real memory, real relationships, and real autonomy. It's in active development and we're using it daily.\n\nWe'll reach out when it's ready for you. In the meantime, the code is at https://github.com/Curious-Life/mycelium.id if you want to self-host.`,
          }),
        });
      } catch (emailErr: any) {
        console.log("Welcome email failed:", emailErr.message);
      }

      // 2. Notification to admin
      if (env.NOTIFICATION_EMAIL) {
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: resendHeaders,
            body: JSON.stringify({
              from: env.EMAIL_FROM || "Mycelium <noreply@example.com>",
              to: env.NOTIFICATION_EMAIL,
              subject: `New signup: ${email}`,
              text: `New waitlist signup:\n\nEmail: ${email}\nSource: ${body.source || "landing"}\nTime: ${new Date().toISOString()}\nTotal signups: ${total}`,
            }),
          });
        } catch (emailErr: any) {
          console.log("Resend notification failed:", emailErr.message);
        }
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: corsHeaders,
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: "Server error" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}

async function handleEmbed(request: Request, env: Env): Promise<Response> {
  const corsHeaders = {
    ...makeCorsHeaders(request),
    "Content-Type": "application/json",
  };

  // Auth check - supports agent tokens, session tokens, and legacy secrets
  const identity = await authenticateRequest(request, env);
  if (!identity) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  // Rate limit AI inference
  const rl = await checkRateLimit(env.KV, identity.agent || "unknown", "embed", RATE_LIMITS.ai);
  if (!rl.allowed) return rateLimitResponse(corsHeaders);

  try {
    const body = await request.json() as { text: string };

    if (!body.text) {
      return new Response(JSON.stringify({ error: "text required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Truncate to BGE-M3 limit
    const text = body.text.substring(0, 8000);

    // Generate embedding using Workers AI
    const result = await env.AI.run("@cf/baai/bge-m3", { text: [text] }) as { data: number[][] };
    const embedding = result.data[0];

    return new Response(JSON.stringify({ embedding }), {
      headers: corsHeaders,
    });

  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error("[Embed] Error:", errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}

/**
 * Message enrichment pipeline.
 *
 * Accepts message IDs after insert. For each message:
 *   1. Read content from D1
 *   2. Tag with Workers AI (Llama 4 Scout) → tags, entities
 *   3. Embed with BGE-M3 → 1024D vector
 *   4. Update D1 row with tags, entities, entity_summary, nlp_processed
 *   5. Upsert embedding to Vectorize
 *
 * Called fire-and-forget by agent-server after storeMessages().
 * Uses ctx.waitUntil so the caller gets a fast 202 response.
 *
 * Body: { messageIds: string[], userId?: string, agentId?: string }
 */

/**
 * POST /api/ai/generate — Generate text using Workers AI (Llama 4 Scout)
 * Used for cluster description generation.
 * Body: { prompt: string, maxTokens?: number }
 */
async function handleAIGenerate(
  request: Request,
  env: Env,
): Promise<Response> {
  const corsHeaders = {
    ...makeCorsHeaders(request),
    "Content-Type": "application/json",
  };

  const identity = await authenticateRequest(request, env);
  if (!identity) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  // Rate limit AI generation
  const rl = await checkRateLimit(env.KV, identity.agent || "unknown", "ai-generate", RATE_LIMITS.generate);
  if (!rl.allowed) return rateLimitResponse(corsHeaders);

  const body = await request.json() as { prompt: string; maxTokens?: number };
  if (!body.prompt) {
    return new Response(JSON.stringify({ error: "prompt required" }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  try {
    const ai = new WorkersAIService(env);
    const response = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
      messages: [{ role: "user", content: body.prompt }],
      max_tokens: body.maxTokens || 300,
    }) as { response?: string };

    return new Response(
      JSON.stringify({ text: response.response || "" }),
      { headers: corsHeaders },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[AI Generate]", msg);
    return new Response(
      JSON.stringify({ error: "AI generation failed" }),
      { status: 500, headers: corsHeaders },
    );
  }
}

async function handleEnrich(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const corsHeaders = {
    ...makeCorsHeaders(request),
    "Content-Type": "application/json",
  };

  const identity = await authenticateRequest(request, env);
  if (!identity) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  // Rate limit enrichment (triggers AI tagging + embedding)
  const rl = await checkRateLimit(env.KV, identity.agent || "unknown", "enrich", RATE_LIMITS.ai);
  if (!rl.allowed) return rateLimitResponse(corsHeaders);

  const body = await request.json() as {
    messageIds: string[];
    userId?: string;
    agentId?: string;
  };

  if (!body.messageIds?.length) {
    return new Response(JSON.stringify({ error: "messageIds required" }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  // sync=true: wait for completion (for backfill scripts)
  // default: fire-and-forget (for real-time enrichment)
  const sync = body.sync === true || new URL(request.url).searchParams.get("sync") === "true";

  if (sync) {
    const count = await enrichMessages(env, body.messageIds, body.userId, body.agentId);
    return new Response(
      JSON.stringify({ processed: count }),
      { status: 200, headers: corsHeaders },
    );
  }

  ctx.waitUntil(enrichMessages(env, body.messageIds, body.userId, body.agentId));
  return new Response(
    JSON.stringify({ queued: body.messageIds.length }),
    { status: 202, headers: corsHeaders },
  );
}

/**
 * Background enrichment worker — runs inside ctx.waitUntil().
 */
async function enrichMessages(
  env: Env,
  messageIds: string[],
  userId?: string,
  agentId?: string,
): Promise<number> {
  if (!env.DB || !env.AI) {
    console.error("[Enrich] D1 or AI not configured");
    return 0;
  }

  const ai = new WorkersAIService(env);

  // Import master key for decryption
  const masterKeyHex = (env as unknown as Record<string, unknown>).ENCRYPTION_MASTER_KEY as string | undefined;
  let masterKey: CryptoKey | null = null;
  if (masterKeyHex) {
    try {
      masterKey = await importMasterKey(masterKeyHex);
    } catch (e) {
      console.error("[Enrich] Failed to import master key:", e);
    }
  }

  // Read messages from D1
  const placeholders = messageIds.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `SELECT id, content, role, source, agent_id FROM messages WHERE id IN (${placeholders})`,
  ).bind(...messageIds).all();

  const rows = (result.results || []) as Array<{
    id: string;
    content: string;
    role: string;
    source: string;
    agent_id: string;
  }>;

  if (rows.length === 0) {
    console.warn("[Enrich] No messages found for IDs:", messageIds);
    return;
  }

  const vectors: Array<{ id: string; values: number[]; metadata: Record<string, string> }> = [];
  let successCount = 0;

  for (const row of rows) {
    if (!row.content || row.content.length < 5) continue;

    // Decrypt content if encrypted
    let plaintext = row.content;
    if (masterKey && isEncrypted(row.content)) {
      try {
        // Allow all scopes for enrichment — it's a system-level operation
        plaintext = await decrypt(row.content, ["personal", "org", "wealth", "moms"] as Scope[], masterKey);
      } catch (e) {
        console.error(`[Enrich] Decrypt failed for ${row.id}:`, e);
        continue; // Skip messages we can't decrypt
      }
    }

    if (!plaintext || plaintext.length < 5) continue;

    try {
      // Run tagging + embedding in parallel
      const [tagging, embedding] = await Promise.all([
        ai.tagMessage(plaintext.substring(0, 4000)),
        ai.generateEmbedding(plaintext.substring(0, 8000)),
      ]);

      // Build entity summary for FTS
      const allEntities = [
        ...tagging.entities.people,
        ...tagging.entities.companies,
        ...tagging.entities.projects,
        ...tagging.entities.places,
      ];
      const entitySummary = allEntities.join(", ");

      // Update the message row
      await env.DB.prepare(
        `UPDATE messages SET
          tags = ?,
          entities = ?,
          entity_summary = ?,
          nlp_processed = 1,
          nlp_processed_at = datetime('now')
        WHERE id = ?`,
      ).bind(
        JSON.stringify(tagging.tags),
        JSON.stringify(tagging.entities),
        entitySummary || null,
        row.id,
      ).run();

      // Collect vector for batch upsert
      vectors.push({
        id: row.id,
        values: embedding,
        metadata: {
          type: "message",
          userId: userId || "",
          agentId: row.agent_id || agentId || "",
        },
      });

      successCount++;
      console.log(
        `[Enrich] ${row.id}: ${tagging.tags.length} tags, ${allEntities.length} entities`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Enrich] Failed for ${row.id}:`, msg);

      // Mark as failed so we don't retry indefinitely
      await env.DB.prepare(
        `UPDATE messages SET nlp_processed = -1, nlp_error = ? WHERE id = ?`,
      ).bind(msg.substring(0, 500), row.id).run();
    }
  }

  // Batch upsert to Vectorize
  if (vectors.length > 0 && env.VECTORS_1024) {
    try {
      await env.VECTORS_1024.upsert(vectors);
      console.log(`[Enrich] Upserted ${vectors.length} vectors to Vectorize`);
    } catch (err) {
      console.error("[Enrich] Vectorize upsert failed:", err);
    }
  }

  return successCount;
}

/**
 * Decrypt a batch of messages — lightweight endpoint for VPS-native enrichment.
 * Master key stays in Cloudflare. VPS gets plaintext, does AI calls directly.
 * Only accessible with ADMIN_SECRET (full scope).
 */
async function handleDecryptBatch(
  request: Request,
  env: Env,
): Promise<Response> {
  const corsHeaders = { ...makeCorsHeaders(request), "Content-Type": "application/json" };

  const identity = await authenticateRequest(request, env);
  if (!identity || identity.auth_type !== "legacy" || identity.agent !== "admin") {
    return new Response(JSON.stringify({ error: "Admin access required" }), {
      status: 403, headers: corsHeaders,
    });
  }

  const body = await request.json() as { messageIds: string[] };
  if (!body.messageIds?.length || body.messageIds.length > 50) {
    return new Response(JSON.stringify({ error: "messageIds required (max 50)" }), {
      status: 400, headers: corsHeaders,
    });
  }

  const masterKeyHex = (env as unknown as Record<string, unknown>).ENCRYPTION_MASTER_KEY as string | undefined;
  if (!masterKeyHex) {
    return new Response(JSON.stringify({ error: "Encryption not configured" }), {
      status: 500, headers: corsHeaders,
    });
  }

  const masterKey = await importMasterKey(masterKeyHex);

  const placeholders = body.messageIds.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `SELECT id, content, user_id, agent_id, source FROM messages WHERE id IN (${placeholders})`,
  ).bind(...body.messageIds).all();

  const rows = (result.results || []) as Array<{
    id: string; content: string; user_id: string; agent_id: string; source: string;
  }>;

  const decrypted: Array<{
    id: string; content: string; user_id: string; agent_id: string; source: string;
  }> = [];

  for (const row of rows) {
    if (!row.content || row.content.length < 5) continue;

    let plaintext = row.content;
    if (isEncrypted(row.content)) {
      try {
        plaintext = await decrypt(row.content, ["personal", "org", "wealth", "moms"] as Scope[], masterKey);
      } catch {
        continue; // Skip undecryptable
      }
    }

    decrypted.push({ ...row, content: plaintext });
  }

  return new Response(JSON.stringify({ messages: decrypted }), { headers: corsHeaders });
}

