/**
 * AgentRuntime — the one seam the rest of the daemon depends on for "run one LLM
 * turn over the vault's MCP tools and let the agent deliver via the reply tool."
 *
 * Contract (every backend implements exactly this):
 *   runtime.runTurn({ turnCtx, userMessage, signal })
 *     -> Promise<{ delivered: boolean, usedReplyTool: boolean, reason?: string }>
 *
 * Backends: native (the turn runs on the SERVER) · claude-agent-sdk (cloud BYOK) ·
 * ollama (local sovereign) · openai-compat (any OpenAI-compatible provider) · auto
 * (per-turn router over cloud+local).
 *
 * Locus is chosen by `MYCELIUM_CHANNEL_ROUTER` (cfg.channelRouter):
 *   - unset / 'native'  -> native  (DEFAULT since the RT4 flip, 2026-06-19)
 *   - 'cloud'           -> cloud        (null if no Anthropic key)
 *   - 'local'           -> ollama       (null if no Ollama model)
 *   - 'openai'          -> openai-compat(null if no base_url)
 *   - 'auto'            -> auto router over cloud+local (falls back to whichever exists)
 *
 * The explicit overrides are FAIL-CLOSED: a forced backend whose creds are absent
 * returns null rather than silently degrading. The default needs no creds here — the
 * server resolves the user's in-app provider and reports no-model honestly via
 * probeHealth, which is what keeps an unconfigured daemon capture-only.
 */
import { createClaudeSdkRuntime } from './backends/claude-sdk.js';
import { createOllamaRuntime } from './backends/ollama.js';
import { createOpenAiCompatRuntime } from './backends/openai-compat.js';
import { createAutoRuntime } from './backends/auto.js';
import { createNativeRuntime } from './backends/native.js';
import { parseSensitivePatterns } from './classify.js';

/**
 * @param {object} cfg   loadConfig() output (+ agent fields)
 * @param {object} [deps]
 * @param {Function} [deps.auditEgress]  hash-only inference-egress recorder (auto router)
 * @returns {{runTurn:Function, label:string}|null}
 */
export function selectRuntime(cfg, { auditEgress } = {}) {
  const hasCloud = !!cfg.anthropicApiKey;
  const hasLocal = !!cfg.ollamaModel;
  const hasOpenai = !!cfg.openaiBaseUrl; // generic OpenAI-compatible (Regolo/OpenRouter/…)
  const forced = cfg.channelRouter; // 'cloud' | 'local' | 'openai' | 'auto' | undefined

  const cloud = () => createClaudeSdkRuntime(cfg);
  const local = () => createOllamaRuntime(cfg);
  const openai = () => createOpenAiCompatRuntime(cfg);

  // Native backend (H11): the turn runs on the SERVER (POST /internal/agent/channel-turn);
  // this daemon just forwards. Needs no model creds here — the server resolves the user's
  // in-app provider. This is now the DEFAULT (red-team RT4 flip 2026-06-19): one engine for
  // chat + channels, the sovereignty floor, and honest capture-only enforced at boot via
  // probeHealth. The SDK/Ollama backends remain reachable as EXPLICIT overrides + rollback.
  if (forced === 'native') return createNativeRuntime(cfg);

  // Explicit override (the active-provider bridge / operator pins one backend).
  if (forced === 'cloud') return hasCloud ? cloud() : null;
  if (forced === 'local') return hasLocal ? local() : null;
  if (forced === 'openai') return hasOpenai ? openai() : null;
  if (forced === 'auto') {
    if (hasCloud && hasLocal) {
      return createAutoRuntime({
        local: local(), cloud: cloud(),
        sensitivePatterns: parseSensitivePatterns(cfg.sensitivePatterns) || undefined,
        auditEgress,
      });
    }
    // forced auto but only one backend → use whichever exists.
    if (hasCloud) return cloud();
    if (hasLocal) return local();
    return null;
  }

  // DEFAULT (no explicit override): the native engine. The server resolves the provider
  // and returns no-model honestly if none is configured (the daemon then stays capture-only).
  return createNativeRuntime(cfg);
}
