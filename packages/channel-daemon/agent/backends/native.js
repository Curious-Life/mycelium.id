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
      isDirect: turnCtx.isDirect != null ? !!turnCtx.isDirect : !group, // authoritative DM flag (RT1-MED)
      addressed: !group,                 // DMs always; groups rely on the server's name-mention triage
      voiceMode: !!turnCtx.voiceMode,
      senderRole: turnCtx.senderRole || 'other',   // gates the owner write grant (W3)
    };
    // Per-boot shared secret (RT1): authenticates THIS daemon to the server's channel-turn
    // endpoint so a random local process can't forge an owner-write turn. Set by the
    // supervisor in the daemon's env; absent ⇒ no header ⇒ server degrades us to read+reply.
    const turnToken = process.env.MYCELIUM_CHANNEL_TURN_TOKEN || '';
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(turnToken ? { 'x-mycelium-channel-turn-token': turnToken } : {}) },
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
