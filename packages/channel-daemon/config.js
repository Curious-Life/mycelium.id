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

  // ── Phase 3 hardening ──────────────────────────────────────────────────────
  const coalesceWindowMs = Number(env.CHANNEL_COALESCE_MS || 1500); // 0 disables
  const rateLimitMax = Number(env.CHANNEL_RATELIMIT_MAX || 20);     // sends per window per target
  const rateLimitWindowMs = Number(env.CHANNEL_RATELIMIT_WINDOW_MS || 60000);

  return {
    botToken, ownerTelegramId, discordBotToken, ownerDiscordId, vaultBaseUrl, host, port, agentId, selfUrl,
    anthropicApiKey, mcpMode, mcpUrl, mcpBearer, mcpStdioEntry, model,
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
  put('TTS_PROVIDER', cc.tts?.provider);
  put('OPENAI_API_KEY', cc.tts?.openaiApiKey);
  put('OPENAI_TTS_VOICE', cc.tts?.openaiVoice);
  put('OPENAI_TTS_MODEL', cc.tts?.openaiModel);
  put('ELEVENLABS_API_KEY', cc.tts?.elevenApiKey);
  put('ELEVENLABS_VOICE_ID', cc.tts?.elevenVoiceId);
  put('ELEVENLABS_MODEL_ID', cc.tts?.elevenModel);
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
