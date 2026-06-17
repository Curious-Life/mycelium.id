/**
 * AgentRuntime — the one seam the rest of the daemon depends on for "run one LLM
 * turn over the vault's MCP tools and let the agent deliver via the reply tool."
 *
 * Contract (every backend implements exactly this):
 *   runtime.runTurn({ turnCtx, userMessage, signal })
 *     -> Promise<{ delivered: boolean, usedReplyTool: boolean, reason?: string }>
 *
 * Backends: claude-agent-sdk (cloud BYOK) · ollama (local sovereign) · openai-compat
 * (any OpenAI-compatible provider — the in-app selection bridge uses this) · auto
 * (per-turn router over cloud+local). Locus is IMPLIED BY CONFIGURATION:
 *   - Anthropic key + Ollama model  -> auto (local-first, escalate complex→cloud)
 *   - OpenAI-compatible base_url     -> openai-compat
 *   - Anthropic key only            -> cloud
 *   - Ollama model only             -> local
 *   - neither                       -> null (capture-only)
 * `MYCELIUM_CHANNEL_ROUTER` (cfg.channelRouter) = 'cloud'|'local'|'openai'|'auto' overrides.
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
  // provider. Opt-in via MYCELIUM_CHANNEL_ROUTER=native (default OFF until soaked; the
  // SDK/Ollama backends remain the default + the rollback path).
  if (forced === 'native') return createNativeRuntime(cfg);

  // Explicit override (the active-provider bridge sets this to pin one backend).
  if (forced === 'cloud') return hasCloud ? cloud() : null;
  if (forced === 'local') return hasLocal ? local() : null;
  if (forced === 'openai') return hasOpenai ? openai() : null;
  if (forced === 'auto' || (hasCloud && hasLocal)) {
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

  if (hasOpenai) return openai(); // OpenAI-compatible BYOK (selected app provider)
  if (hasCloud) return cloud();   // cloud BYOK (Anthropic)
  if (hasLocal) return local();   // sovereign local
  return null;                    // capture-only (fail-closed, honest)
}
