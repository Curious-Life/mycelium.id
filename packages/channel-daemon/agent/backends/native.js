/**
 * Native backend (Phase 5, Step 6f) — H11 "core-as-library".
 *
 * Unlike the SDK/Ollama backends (which run the agent loop IN the daemon), this backend
 * is a THIN FORWARDER: it POSTs the inbound message to the main server's loopback endpoint
 * (POST /internal/agent/channel-turn) and the turn runs THERE — over the keyed vault, the
 * user's configured provider, getContext, conversation history + compaction, and the
 * read-safe + reply grant. One engine, on the server; the daemon stays pure transport.
 *
 * The daemon holds the active-turn registry OPEN across this call (lane.js sets it before
 * runTurn and clears it after), so the server-run `reply` tool still resolves the channel
 * target through the daemon's existing /{platform}/send egress chokepoint.
 *
 * Contract (same as every backend): runTurn({ turnCtx, userMessage, signal })
 *   -> { delivered, usedReplyTool, reason }. Needs NO model creds — the server picks the
 *   provider; with none configured the server returns reason 'no-model' and the daemon
 *   stays silent.
 */

const DEFAULT_VAULT = 'http://127.0.0.1:8787';

export function createNativeRuntime(cfg = {}) {
  const base = String(cfg.vaultBaseUrl || DEFAULT_VAULT).replace(/\/+$/, '');
  const url = `${base}/internal/agent/channel-turn`;
  const fetchImpl = cfg.fetch || globalThis.fetch;

  async function runTurn({ turnCtx = {}, userMessage, signal } = {}) {
    const kind = String(turnCtx.channelKind || turnCtx.source || '');
    const group = /group/i.test(kind);
    // conversation_id MUST match what the daemon persists inbound/outbound under —
    // the bare chatId (inbound.js / send-handler.js), so history hydration lines up.
    const conversationId = turnCtx.channelId != null ? String(turnCtx.channelId) : null;
    const body = {
      userMessage: typeof userMessage === 'string' ? userMessage : '',
      conversationId,
      source: turnCtx.source || turnCtx.channelKind || 'channel',
      group,
      addressed: !group,                 // DMs always; groups rely on the server's name-mention triage
      voiceMode: !!turnCtx.voiceMode,
      senderRole: turnCtx.senderRole || 'other',   // gates the owner write grant (W3)
    };
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!res || !res.ok) return { delivered: false, usedReplyTool: false, reason: `server-${res?.status || 'error'}` };
      const j = await res.json().catch(() => ({}));
      return { delivered: !!j.delivered, usedReplyTool: !!j.usedReplyTool, reason: j.reason || 'native' };
    } catch {
      // Forward failure → no reply, no auto-replay (a retry could double-send).
      return { delivered: false, usedReplyTool: false, reason: 'native-forward-failed' };
    }
  }

  return { runTurn, label: 'native' };
}

export default createNativeRuntime;
