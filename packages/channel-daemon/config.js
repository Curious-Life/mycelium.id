/**
 * Channel-daemon config — env only, fail-closed on the secrets it can't default.
 *
 * Required (Phase 0 egress): TELEGRAM_BOT_TOKEN.
 * Owner binding (Phase 0 authority): OWNER_TELEGRAM_ID — the operator's chatId;
 *   the one chat that is deliverable before the Phase 3 binding flow exists.
 * Vault: MYCELIUM_API_URL (defaults to the local REST server).
 */
export function loadConfig(env = process.env) {
  const botToken = env.TELEGRAM_BOT_TOKEN || '';
  const ownerTelegramId = env.OWNER_TELEGRAM_ID || '';
  const discordBotToken = env.DISCORD_BOT_TOKEN || '';
  const ownerDiscordId = env.OWNER_DISCORD_ID || '';
  const vaultBaseUrl =
    env.MYCELIUM_API_URL
    || `http://${env.MYCELIUM_REST_HOST || '127.0.0.1'}:${env.MYCELIUM_REST_PORT || 8787}`;
  const host = env.CHANNEL_DAEMON_HOST || '127.0.0.1';
  const port = Number(env.CHANNEL_DAEMON_PORT || 3010);
  const agentId = env.CHANNEL_AGENT_ID || 'personal-agent';
  const selfUrl = `http://${host}:${port}`;

  // ── Phase 2: the agent turn ────────────────────────────────────────────────
  // Inference locus is IMPLIED BY CONFIG (design §2): an Anthropic BYOK key ⇒
  // cloud Claude Agent SDK (the default). No key ⇒ runtime is null ⇒ two-way
  // replies are OFF and the daemon runs capture-only.
  const anthropicApiKey = env.ANTHROPIC_API_KEY || '';
  const mcpMode = env.CHANNEL_MCP_MODE || 'http'; // 'http' (running vault) | 'stdio' (spawn)
  const mcpUrl = env.MYCELIUM_MCP_URL || 'http://127.0.0.1:4711/mcp';
  const mcpBearer = env.MYCELIUM_MCP_BEARER || '';
  const mcpStdioEntry = env.CHANNEL_MCP_STDIO_ENTRY || 'src/index.js';
  const model = env.CHANNEL_AGENT_MODEL || ''; // backend default applies when empty
  // Sovereign local backend (config-implied when no Anthropic key): an Ollama
  // model name turns on the local runtime; no cloud egress.
  const ollamaModel = env.CHANNEL_OLLAMA_MODEL || '';
  const ollamaUrl = env.OLLAMA_URL || 'http://127.0.0.1:11434';
  // Generic OpenAI-compatible backend (cloud BYOK or self-hosted, e.g. Regolo /
  // OpenRouter / llama.cpp). Set when the user's selected app provider is an
  // OpenAI-compatible one that ISN'T native Ollama. baseUrl turns it on.
  const openaiBaseUrl = env.CHANNEL_OPENAI_BASE_URL || '';
  const openaiApiKey = env.CHANNEL_OPENAI_API_KEY || '';
  const openaiModel = env.CHANNEL_OPENAI_MODEL || '';
  // Auto router (when BOTH cloud + local are configured): 'auto' (default) routes
  // per-turn (local-first, complex→cloud, sensitive→local); 'cloud'/'local' force.
  const channelRouter = env.MYCELIUM_CHANNEL_ROUTER || '';
  const sensitivePatterns = env.CHANNEL_SENSITIVE_PATTERNS || '';

  // ── local-turn tuning (2026-06-10 silent-no-reply incident) ───────────────
  // A COLD local model (load + prompt ingest on a 7–12B) routinely exceeds the
  // old 120s fetch timeout, killing the turn with no user-visible trace.
  const ollamaTimeoutMs = Number(env.CHANNEL_OLLAMA_TIMEOUT_MS || 300_000);
  // Ollama serves models at a 4096 ctx by default — too small for tool schemas
  // + system prompt; a truncated prompt makes the model return EMPTY (no tool
  // calls, no text). Request a workable window explicitly.
  const ollamaNumCtx = Number(env.CHANNEL_OLLAMA_NUM_CTX || 8192);
  // Local models get a TRIMMED tool surface: the full vault schema set is ~7.7k
  // tokens of prompt — past the ctx and minutes of ingest per round on a 12B.
  // csv override; `reply` (the egress tool) is ALWAYS kept regardless.
  const localTools = (env.CHANNEL_LOCAL_TOOLS || 'getContext,searchMindscape,remember,reply')
    .split(',').map((s) => s.trim()).filter(Boolean);
  // Lane-level whole-turn budget (multi-round tool loop on a local model).
  const turnTimeoutMs = Number(env.CHANNEL_TURN_TIMEOUT_MS || 600_000);

  // ── inbound media (photos / documents / voice notes) ──────────────────────
  // 20MB = the Bot API getFile hard cap; telegram-api re-checks server-side.
  const mediaEnabled = env.CHANNEL_MEDIA_ENABLED !== '0';
  const mediaMaxBytes = Number(env.CHANNEL_MEDIA_MAX_BYTES || 20 * 1024 * 1024);
  // MED-4 — the media stage runs OFF the poller on a bounded serial worker so a
  // minutes-long extraction never stalls inbound. queueMax caps queued+running
  // jobs; over the cap a message degrades to a placeholder (still captured +
  // turned). senderMax/senderWindow throttle a single NON-owner flooder (owner
  // exempt) so they can't monopolize the one serial worker.
  const mediaQueueMax = Number(env.CHANNEL_MEDIA_QUEUE_MAX || 8);
  const mediaSenderMax = Number(env.CHANNEL_MEDIA_SENDER_MAX || 3);
  const mediaSenderWindowMs = Number(env.CHANNEL_MEDIA_SENDER_WINDOW_MS || 60_000);

  // ── Phase 3 hardening ──────────────────────────────────────────────────────
  const coalesceWindowMs = Number(env.CHANNEL_COALESCE_MS || 1500); // 0 disables
  const rateLimitMax = Number(env.CHANNEL_RATELIMIT_MAX || 20);     // sends per window per target
  const rateLimitWindowMs = Number(env.CHANNEL_RATELIMIT_WINDOW_MS || 60000);

  return {
    botToken, ownerTelegramId, discordBotToken, ownerDiscordId, vaultBaseUrl, host, port, agentId, selfUrl,
    anthropicApiKey, mcpMode, mcpUrl, mcpBearer, mcpStdioEntry, model,
    ollamaModel, ollamaUrl, openaiBaseUrl, openaiApiKey, openaiModel, channelRouter, sensitivePatterns,
    ollamaTimeoutMs, ollamaNumCtx, localTools, turnTimeoutMs,
    mediaEnabled, mediaMaxBytes, mediaQueueMax, mediaSenderMax, mediaSenderWindowMs,
    coalesceWindowMs, rateLimitMax, rateLimitWindowMs,
  };
}

/**
 * Hydrate process.env from vault-managed channel config (the UI is authoritative).
 * Vault values OVERRIDE env when present, so editing in the portal takes effect on
 * the next daemon start; an unset vault field leaves any existing env var intact.
 * The TTS module + loadConfig both read process.env, so this is the single bridge.
 * @param {object|null} cc  output of vaultClient.getChannelConfig()
 * @param {object} [env]
 */
export function applyChannelConfigToEnv(cc, env = process.env) {
  if (!cc) return;
  const put = (k, v) => { if (v != null && v !== '') env[k] = String(v); };
  put('TELEGRAM_BOT_TOKEN', cc.telegram?.botToken);
  put('OWNER_TELEGRAM_ID', cc.telegram?.ownerId);
  put('DISCORD_BOT_TOKEN', cc.discord?.botToken);
  put('OWNER_DISCORD_ID', cc.discord?.ownerId);
  put('ANTHROPIC_API_KEY', cc.agent?.anthropicApiKey);
  put('CHANNEL_AGENT_MODEL', cc.agent?.model);
  // OpenAI-compatible backend (set by the active-provider bridge for non-Anthropic,
  // non-native-Ollama providers). baseUrl is the on/off switch.
  put('CHANNEL_OPENAI_BASE_URL', cc.agent?.openai?.baseUrl);
  put('CHANNEL_OPENAI_API_KEY', cc.agent?.openai?.apiKey);
  put('CHANNEL_OPENAI_MODEL', cc.agent?.openai?.model);
  put('TTS_PROVIDER', cc.tts?.provider);
  put('OPENAI_API_KEY', cc.tts?.openaiApiKey);
  put('OPENAI_TTS_VOICE', cc.tts?.openaiVoice);
  put('OPENAI_TTS_MODEL', cc.tts?.openaiModel);
  put('ELEVENLABS_API_KEY', cc.tts?.elevenApiKey);
  put('ELEVENLABS_VOICE_ID', cc.tts?.elevenVoiceId);
  put('ELEVENLABS_MODEL_ID', cc.tts?.elevenModel);
  // Routing & tuning (Track A) — vault-managed knobs override env.
  put('MYCELIUM_CHANNEL_ROUTER', cc.routing?.router);
  put('CHANNEL_OLLAMA_MODEL', cc.routing?.ollamaModel);
  put('OLLAMA_URL', cc.routing?.ollamaUrl);
  put('CHANNEL_COALESCE_MS', cc.routing?.coalesceMs);
  put('CHANNEL_RATELIMIT_MAX', cc.routing?.rateLimitMax);
  put('CHANNEL_RATELIMIT_WINDOW_MS', cc.routing?.rateLimitWindowMs);
  put('CHANNEL_SENSITIVE_PATTERNS', cc.routing?.sensitivePatterns);
  // MED-4 inbound media throughput (optional vault overrides).
  put('CHANNEL_MEDIA_QUEUE_MAX', cc.routing?.mediaQueueMax);
  put('CHANNEL_MEDIA_SENDER_MAX', cc.routing?.mediaSenderMax);
  put('CHANNEL_MEDIA_SENDER_WINDOW_MS', cc.routing?.mediaSenderWindowMs);
}

/** Throw a clear error if no platform is configured (fail-closed boot). */
export function assertEgressConfig(cfg) {
  const telegramReady = cfg.botToken && cfg.ownerTelegramId;
  const discordReady = cfg.discordBotToken && cfg.ownerDiscordId;
  if (!telegramReady && !discordReady) {
    throw new Error('channel-daemon: configure at least one platform — TELEGRAM_BOT_TOKEN + OWNER_TELEGRAM_ID, or DISCORD_BOT_TOKEN + OWNER_DISCORD_ID (set them in Settings → Channels).');
  }
  if (cfg.botToken && !cfg.ownerTelegramId) throw new Error('channel-daemon: OWNER_TELEGRAM_ID required when TELEGRAM_BOT_TOKEN is set');
  if (cfg.discordBotToken && !cfg.ownerDiscordId) throw new Error('channel-daemon: OWNER_DISCORD_ID required when DISCORD_BOT_TOKEN is set');
}
