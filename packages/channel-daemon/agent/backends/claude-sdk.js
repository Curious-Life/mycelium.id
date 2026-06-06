/**
 * Claude Agent SDK backend (cloud BYOK) — the DEFAULT runtime.
 *
 * Why the SDK: V1 is already an MCP server, so the SDK attaches to the vault's
 * tools as a native MCP client with zero glue, and the agentic tool-use loop
 * (parallel tool calls, max-tokens mid-tool, malformed args, loop bounds,
 * session resume) is maintained by Anthropic rather than hand-rolled here.
 *
 * The SDK is an OPTIONAL dependency — lazy-imported so CI / a local-only vault
 * never needs it. If it's absent we throw a clear, actionable error.
 *
 * MCP wiring (cfg.mcpMode):
 *   - 'http'  (default): connect to the already-running vault HTTP MCP
 *     (cfg.mcpUrl + cfg.mcpBearer). The vault is the single key-holder; the
 *     daemon stays keyless. The vault MUST be booted with AGENT_URL pointing at
 *     this daemon so its `reply` tool calls the egress chokepoint back here.
 *   - 'stdio': the SDK spawns `node src/index.js` as a child with AGENT_URL +
 *     the vault keys in its env (daemon-env then holds the keys). Self-contained
 *     but heavier; use only when no HTTP vault is running.
 *
 * The agent delivers via the `reply` MCP tool → the chokepoint → Telegram. This
 * backend does NOT send or audit directly; it only runs the turn and reports
 * whether `reply` fired and whether it reported delivery.
 */
import { buildReplySystemPrompt } from '../prompt.js';

const REPLY_TOOL_SUFFIX = 'reply'; // MCP tools surface as mcp__<server>__reply

async function loadQuery() {
  try {
    const mod = await import('@anthropic-ai/claude-agent-sdk');
    if (typeof mod.query !== 'function') throw new Error('query export missing');
    return mod.query;
  } catch (e) {
    throw new Error(
      'channel-daemon: @anthropic-ai/claude-agent-sdk is required for two-way replies '
      + '(install it, or run local-only). Underlying: ' + e.message,
    );
  }
}

/** Build the SDK `mcpServers` config for the configured mode. */
function mcpServersConfig(cfg) {
  if (cfg.mcpMode === 'stdio') {
    return {
      mycelium: {
        command: process.execPath,
        args: [cfg.mcpStdioEntry || 'src/index.js'],
        // The spawned MCP server needs AGENT_URL (so its reply tool calls this
        // daemon) and the vault keys (to decrypt). The operator supplies keys to
        // the daemon env in stdio mode.
        env: { ...process.env, AGENT_URL: cfg.selfUrl },
      },
    };
  }
  // http (default)
  return {
    mycelium: {
      type: 'http',
      url: cfg.mcpUrl,
      ...(cfg.mcpBearer ? { headers: { Authorization: `Bearer ${cfg.mcpBearer}` } } : {}),
    },
  };
}

export function createClaudeSdkRuntime(cfg) {
  const model = cfg.model || 'claude-sonnet-4-6';

  return {
    label: `claude-agent-sdk(${model}, mcp:${cfg.mcpMode || 'http'})`,

    async runTurn({ turnCtx, userMessage, signal }) {
      const query = await loadQuery();
      const systemPrompt = buildReplySystemPrompt({ turnCtx, persona: cfg.persona });

      const iterator = query({
        prompt: userMessage,
        options: {
          model,
          systemPrompt,
          mcpServers: mcpServersConfig(cfg),
          // Read tools + the reply egress tool. Keep it tight; no write tools on
          // an autonomous reply turn.
          allowedTools: cfg.allowedTools || [
            'mcp__mycelium__getContext',
            'mcp__mycelium__searchMindscape',
            'mcp__mycelium__reply',
          ],
          permissionMode: 'bypassPermissions', // headless; the chokepoint is the real gate
          maxTurns: cfg.maxTurns || 12,
          // env is passed wholesale to the bundled Claude Code CLI subprocess —
          // spread process.env so PATH etc. survive, then pin the API key.
          ...(cfg.anthropicApiKey ? { env: { ...process.env, ANTHROPIC_API_KEY: cfg.anthropicApiKey } } : {}),
          ...(signal ? { abortController: toAbortController(signal) } : {}),
        },
      });

      const tracker = createReplyTracker();
      for await (const msg of iterator) tracker.observe(msg);
      const { usedReplyTool, delivered } = tracker.result();

      return { delivered, usedReplyTool, reason: usedReplyTool ? (delivered ? 'delivered' : 'reply-not-delivered') : 'no-reply' };
    },
  };
}

/**
 * Interpret the Claude Agent SDK message stream to decide (a) whether the
 * `reply` tool was called and (b) whether it reported delivered:true.
 *
 * Verified against @anthropic-ai/claude-agent-sdk v0.3.x message shapes (depth
 * sweep 2026-06-06): tool USE blocks ride an `type:'assistant'` SDKMessage at
 * `msg.message.content[]` ({type:'tool_use', name, id}); the tool RESULT comes
 * back on a LATER `type:'user'` SDKMessage at `msg.message.content[]`
 * ({type:'tool_result', tool_use_id, content}) — NOT in the same assistant
 * message. We correlate by tool_use_id so a non-reply tool's result can't be
 * mistaken for the reply's. Exported pure so it's unit-testable without the SDK.
 */
export function createReplyTracker() {
  const replyToolUseIds = new Set();
  let usedReplyTool = false;
  let delivered = false;

  function blocksOf(msg) {
    const c = msg?.message?.content ?? msg?.content;
    return Array.isArray(c) ? c : [];
  }

  return {
    observe(msg) {
      const type = msg?.type;
      if (type === 'assistant') {
        for (const b of blocksOf(msg)) {
          if (b?.type === 'tool_use' && typeof b.name === 'string' && b.name.endsWith(REPLY_TOOL_SUFFIX)) {
            usedReplyTool = true;
            if (b.id) replyToolUseIds.add(b.id);
          }
        }
      } else if (type === 'user') {
        for (const b of blocksOf(msg)) {
          if (b?.type !== 'tool_result') continue;
          // Only trust a result that correlates to a reply tool_use (or, if the
          // SDK omitted ids, fall back to content sniffing on any tool_result).
          const correlated = b.tool_use_id ? replyToolUseIds.has(b.tool_use_id) : usedReplyTool;
          if (!correlated) continue;
          if (/"delivered"\s*:\s*true/.test(extractText(b))) delivered = true;
        }
      }
    },
    result() { return { usedReplyTool, delivered }; },
  };
}

function toAbortController(signal) {
  const ac = new AbortController();
  if (signal.aborted) ac.abort();
  else signal.addEventListener('abort', () => ac.abort(), { once: true });
  return ac;
}

function extractText(block) {
  const c = block?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join(' ');
  return block?.text || '';
}
