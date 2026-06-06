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

  return {
    botToken, ownerTelegramId, vaultBaseUrl, host, port, agentId, selfUrl,
    anthropicApiKey, mcpMode, mcpUrl, mcpBearer, mcpStdioEntry, model,
  };
}

/** Throw a clear error if a required secret is missing (fail-closed boot). */
export function assertEgressConfig(cfg) {
  if (!cfg.botToken) {
    throw new Error('channel-daemon: TELEGRAM_BOT_TOKEN is required for outbound egress');
  }
  if (!cfg.ownerTelegramId) {
    throw new Error('channel-daemon: OWNER_TELEGRAM_ID is required (the operator chat authorized for delivery in Phase 0)');
  }
}
