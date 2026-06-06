/**
 * AgentRuntime — the one seam the rest of the daemon depends on for "run one LLM
 * turn over the vault's MCP tools and let the agent deliver via the reply tool."
 *
 * Contract (every backend implements exactly this):
 *   runtime.runTurn({ turnCtx, userMessage, signal })
 *     -> Promise<{ delivered: boolean, usedReplyTool: boolean, reason?: string }>
 *
 * Backends: claude-agent-sdk (cloud BYOK) · ollama (local sovereign) · auto
 * (per-turn router over both). Locus is IMPLIED BY CONFIGURATION:
 *   - Anthropic key + Ollama model  -> auto (local-first, escalate complex→cloud)
 *   - Anthropic key only            -> cloud
 *   - Ollama model only             -> local
 *   - neither                       -> null (capture-only)
 * `MYCELIUM_CHANNEL_ROUTER` (cfg.channelRouter) = 'cloud'|'local'|'auto' overrides.
 */
import { createClaudeSdkRuntime } from './backends/claude-sdk.js';
import { createOllamaRuntime } from './backends/ollama.js';
import { createAutoRuntime } from './backends/auto.js';
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
  const forced = cfg.channelRouter; // 'cloud' | 'local' | 'auto' | undefined

  const cloud = () => createClaudeSdkRuntime(cfg);
  const local = () => createOllamaRuntime(cfg);

  // Explicit override.
  if (forced === 'cloud') return hasCloud ? cloud() : null;
  if (forced === 'local') return hasLocal ? local() : null;
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

  if (hasCloud) return cloud();   // cloud BYOK
  if (hasLocal) return local();   // sovereign local
  return null;                    // capture-only (fail-closed, honest)
}
