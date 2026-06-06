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

      let usedReplyTool = false;
      let delivered = false;

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
          ...(cfg.anthropicApiKey ? { env: { ANTHROPIC_API_KEY: cfg.anthropicApiKey } } : {}),
          ...(signal ? { abortController: toAbortController(signal) } : {}),
        },
      });

      for await (const msg of iterator) {
        // Detect the reply tool firing + its delivered verdict. Message shapes
        // vary across SDK versions; we sniff defensively rather than assert one.
        const blocks = msg?.message?.content || msg?.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b?.type === 'tool_use' && typeof b.name === 'string' && b.name.endsWith(REPLY_TOOL_SUFFIX)) {
              usedReplyTool = true;
            }
            if (b?.type === 'tool_result') {
              const text = extractText(b);
              if (text && /"delivered"\s*:\s*true/.test(text)) delivered = true;
            }
          }
        }
      }

      return { delivered, usedReplyTool, reason: usedReplyTool ? (delivered ? 'delivered' : 'reply-not-delivered') : 'no-reply' };
    },
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
