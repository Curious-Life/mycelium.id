/**
 * AgentRuntime — the one seam the rest of the daemon depends on for "run one LLM
 * turn over the vault's MCP tools and let the agent deliver via the reply tool."
 *
 * Contract (every backend implements exactly this):
 *
 *   runtime.runTurn({ turnCtx, userMessage, signal })
 *     -> Promise<{ delivered: boolean, usedReplyTool: boolean, reason?: string }>
 *
 * Backends (all behind this interface, so transport/lane/egress never change):
 *   - claude-agent-sdk  (cloud BYOK, DEFAULT) — agent/backends/claude-sdk.js
 *   - messages-api      (cloud, SDK-less fallback) — future
 *   - ollama            (local, sovereign) — future (Phase 3)
 *
 * Inference locus is IMPLIED BY CONFIGURATION, fail-closed (design §2):
 *   - an Anthropic BYOK key present  -> cloud Claude Agent SDK   (the default)
 *   - only a local model configured  -> ollama runtime           (future)
 *   - neither                        -> null  -> two-way replies DISABLED
 *                                       (inbound capture still works)
 */
import { createClaudeSdkRuntime } from './backends/claude-sdk.js';
import { createOllamaRuntime } from './backends/ollama.js';

/**
 * Select the runtime from config. Returns null when nothing is configured —
 * the caller treats null as "capture-only" (two-way replies off), never as an
 * error, so a vault with no inference key still ingests channel messages.
 *
 * @param {object} cfg   loadConfig() output (+ agent fields)
 * @returns {{runTurn:Function, label:string}|null}
 */
export function selectRuntime(cfg) {
  if (cfg.anthropicApiKey) {
    return createClaudeSdkRuntime(cfg); // cloud BYOK (default)
  }
  if (cfg.ollamaModel) {
    return createOllamaRuntime(cfg); // sovereign local — no cloud egress
  }
  // Neither configured → null → two-way OFF, capture-only (honest, fail-closed).
  return null;
}
