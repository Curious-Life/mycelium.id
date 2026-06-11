/**
 * Reply MCP tool — agent-explicit egress with default-to-inbound resolution.
 *
 * Phase 2 of EGRESS-PROVENANCE.
 * See docs/EGRESS-PROVENANCE-PHASE2-DESIGN-2026-05-06.md.
 *
 * The tool resolves the target by HTTP-callback to the agent-server's
 * /internal/inbound-context/current endpoint (Step 2). The active-turn
 * registry (Step 1) means there's exactly one possible target per agent
 * at any moment. The chokepoint POST carries the
 * x-egress-provenance: agent-explicit header (Step 3) so audit rows are
 * classified as 'agent-explicit-via-tool' and trackExplicitSend fires
 * (which is what makes the chat fallback at chat.js:254 not fire — the
 * structural fix to most of the leak class without deleting the fallback).
 *
 * Soft-fail philosophy mirrors createDelegationDomain — return a JSON
 * string with { delivered, errorCode } so the LLM gets a coherent result
 * regardless of failure shape. Never throw out of a handler.
 *
 * @typedef {object} ReplyDeps
 * @property {string|undefined} agentUrl  agent-server URL (e.g. http://localhost:3004)
 * @property {(url: string, init?: any) => Promise<any>} [fetch]  defaults to globalThis.fetch
 */

const REPLY_TOOL_DESCRIPTION = `Reply to the inbound message that started this turn. Auto-targets the inbound channel (Telegram chat / Discord channel / WhatsApp DM that delivered the user's message).

Use this tool instead of curl whenever you are replying to the message you were addressed in — it eliminates chatId/channelId hallucination and surfaces audit/provenance correctly. Replies are plain messages by default; pass quote: true to tag/quote the user's message (Telegram reply preview) when that genuinely helps, e.g. in a busy group.

Returns a JSON object: { delivered: boolean, errorCode?: string }.

errorCode values you may see:
  - 'no-active-turn'             - tool called outside a /chat turn (autonomous, triage, think). Agent should NOT retry; if you have nothing addressed to a user, end with NO_REPLY.
  - 'invalid-source'             - active turn is from a non-chat surface (recovery resume, portal stream). Fall back to curl if delivery is required.
  - 'agent-url-not-configured'   - AGENT_URL env var missing in MCP child. Fall back to curl.
  - 'channel-authority-denied'   - chokepoint refused the target (rare for reply path). Do NOT loop.
  - 'rate-limited'               - Discord per-hour budget hit. Wait, do NOT auto-retry.
  - 'fetch-failed'               - agent-server unreachable OR HTTP timeout (30s). Fall back to curl ONLY if you did NOT use voice mode — voice TTS can take 10-30s on the server and your text was likely delivered before the timeout fired. With voice, retry would duplicate. Wait for the next inbound to verify; do NOT auto-retry voice replies on fetch-failed.
  - 'http-<status>'              - chokepoint returned non-2xx without an error code. Read the status; do NOT loop.

Do NOT loop on errors. Cross-channel sends (posting to a different channel than the inbound) still use curl — see the cross-channel curl example below the reply guidance.`;

const REPLY_TOOL_SCHEMA = {
  name: 'reply',
  description: REPLY_TOOL_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Message body. Required.',
      },
      voice: {
        type: 'boolean',
        description: 'Telegram only — also synthesize a voice (TTS) message. Ignored on Discord/WhatsApp.',
      },
      quote: {
        type: 'boolean',
        description: "Telegram only — quote/tag the user's message you are replying to (Telegram reply preview). Default false: send a plain message. Set true only when it genuinely disambiguates — e.g. answering an older or specific message in a busy group chat. In a 1:1 DM quoting is almost never needed.",
      },
    },
    required: ['text'],
  },
};

function platformFromSource(source) {
  if (!source) return null;
  if (source === 'discord' || source === 'discord-thread') return 'discord';
  if (source === 'telegram' || source === 'telegram-group') return 'telegram';
  if (source === 'whatsapp') return 'whatsapp';
  return null;
}

function buildSendBody({ platform, channelId, text, voice, replyToMessageId, sourceKind, sourceId }) {
  if (platform === 'telegram') {
    return {
      chatId: String(channelId),
      text,
      ...(voice ? { voice: true } : {}),
      ...(replyToMessageId != null ? { replyToMessageId } : {}),
      ...(sourceKind ? { sourceKind } : {}),
      ...(sourceId ? { sourceId: String(sourceId) } : {}),
    };
  }
  if (platform === 'discord') {
    return {
      channelId: String(channelId),
      content: text,
      ...(sourceKind ? { sourceKind } : {}),
      ...(sourceId ? { sourceId: String(sourceId) } : {}),
    };
  }
  // whatsapp
  return {
    text,
    ...(channelId ? { jid: String(channelId) } : {}),
    ...(sourceKind ? { sourceKind } : {}),
    ...(sourceId ? { sourceId: String(sourceId) } : {}),
  };
}

export function createReplyDomain(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('createReplyDomain: deps required');
  const { agentUrl, fetch: fetchImpl = globalThis.fetch } = deps;
  if (typeof fetchImpl !== 'function') throw new TypeError('createReplyDomain: fetch required');

  async function fetchActiveTurn() {
    const res = await fetchImpl(`${agentUrl}/internal/inbound-context/current`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 404) return { error: 'no-active-turn' };
    if (!res.ok) return { error: 'context-fetch-failed' };
    return await res.json();
  }

  async function sendThroughChokepoint({ platform, body }) {
    const url = `${agentUrl}/${platform}/send`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-egress-provenance': 'agent-explicit',
      },
      body: JSON.stringify(body),
      // 30s covers voice-mode TTS latency (typical ~12s) with margin. The
      // chat turn has its own 1800s budget so the chokepoint round-trip
      // timeout doesn't constrain anything else. Pre-2026-05-07 this was
      // 10s, which raced with TTS and produced duplicate-send incidents
      // (agent saw fetch-failed, fell back to curl, message landed twice).
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return { delivered: true, httpStatus: res.status };
    let errorCode = `http-${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) errorCode = String(j.error).slice(0, 60);
    } catch { /* keep http-<status> */ }
    return { delivered: false, httpStatus: res.status, errorCode };
  }

  async function handleReply(args) {
    const text = typeof args?.text === 'string' ? args.text.trim() : '';
    if (!text) return JSON.stringify({ delivered: false, errorCode: 'missing-text' });

    if (!agentUrl) {
      return JSON.stringify({ delivered: false, errorCode: 'agent-url-not-configured' });
    }

    let turn;
    try {
      turn = await fetchActiveTurn();
    } catch {
      return JSON.stringify({ delivered: false, errorCode: 'context-fetch-failed' });
    }
    if (turn?.error) {
      return JSON.stringify({ delivered: false, errorCode: turn.error });
    }
    if (!turn || !turn.channelId) {
      return JSON.stringify({ delivered: false, errorCode: 'no-active-turn' });
    }

    const platform = platformFromSource(turn.source);
    if (!platform) {
      return JSON.stringify({ delivered: false, errorCode: 'invalid-source' });
    }

    const body = buildSendBody({
      platform,
      channelId: turn.channelId,
      text,
      voice: !!args?.voice && platform === 'telegram',
      // Reply-tagging is the AGENT'S CHOICE (quote: true), never automatic —
      // auto-tagging every reply reads as quote-spam in a 1:1 chat. The
      // inbound id stays available from the active turn when the agent asks.
      replyToMessageId: args?.quote ? turn.inboundMessageId : undefined,
      sourceKind: turn.channelKind,
      sourceId: turn.channelId,
    });

    let result;
    try {
      result = await sendThroughChokepoint({ platform, body });
    } catch (e) {
      return JSON.stringify({ delivered: false, errorCode: 'fetch-failed' });
    }
    return JSON.stringify(result);
  }

  return {
    tools: [REPLY_TOOL_SCHEMA],
    handlers: { reply: handleReply },
  };
}
