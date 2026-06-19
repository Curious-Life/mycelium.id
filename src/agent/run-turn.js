// src/agent/run-turn.js — the shared headless turn assembly (Phase 5, Step 6b).
// Spec §5.5/§6.
//
// Factored out of the scheduler's buildAndRunTurn so BOTH autonomous surfaces — the
// scheduler (wake-cycles) and the channel endpoint (auto-reply) — run ONE turn the same
// way: resolve provider → role preamble + getContext (+ optional conversation history)
// → model-aware budget → autonomy-grant tools → in-proc `call` → loop.run with a no-op
// `send` (headless). The surfaces differ ONLY in: the userMessage, the role preamble,
// which gated tools are enabled, and whether a conversation history is threaded.
//
// SECURITY: tools come through autonomyTools() (agent/autonomy-tools.js) — read-safe
// always, gated tools only when explicitly enabled. A local model gets no tools (TTFB).
// Never logs prompt/response (loop/harness own the leak-safe egress audit).

import { describeProvider } from './harness.js';
import { autonomyTools } from './autonomy-tools.js';
import { hydrateHistoryBlock } from './history.js';
import { resolveInferenceConfigForTask, resolveProviderChain } from '../inference/resolve.js';
import { resolveModelProfile } from '../inference/model-profile.js';
import { planGeneration, estimateTokens, trimToTokenBudget } from '../inference/token-budget.js';

const DEFAULT_AGENT_NAME = 'Mycelium';

async function readAgentName(db, userId) {
  try {
    const a = (await db.users?.getSettings?.(userId))?.agent || {};
    return (typeof a.name === 'string' && a.name.trim()) ? a.name.trim() : DEFAULT_AGENT_NAME;
  } catch { return DEFAULT_AGENT_NAME; }
}

/**
 * Assemble + drive one headless turn.
 * @param {object} deps  { db, userId, tools, handlers, loop, fetchImpl?, signal? }
 * @param {object} opts
 * @param {string}   opts.userMessage
 * @param {string}   [opts.systemExtra]   role preamble after "Your name is X."
 * @param {string[]} [opts.enabledTools]  gated autonomy tools this turn may use
 * @param {Array}    [opts.history]       hydrated [{role,content}] (chronological)
 * @param {number}   [opts.recentN]       getContext recentMessages (default by model size)
 * @param {boolean}  [opts.localTools]    allow tools even on a local model (default false)
 * @returns {Promise<{text:string,truncated?:boolean,skipped?:string,toolsUsed?:string[]}>}
 */
export async function runAgentTurn(
  { db, userId, tools = [], handlers = {}, loop, fetchImpl = globalThis.fetch, signal, hooks } = {},
  { userMessage, systemExtra = '', enabledTools = [], history = [], conversationId = null, recentN, localTools = false, historyUntrusted = false } = {},
) {
  if (!loop || typeof loop.run !== 'function') throw new TypeError('runAgentTurn: loop with run() required');

  const provider = await resolveInferenceConfigForTask(db, userId, 'harness');
  const info = describeProvider(provider);
  if (!info) return { skipped: 'no-model' };
  const isLocal = info.local;

  // Provider-fallback chain (Step 7c): the resolved primary first, then the
  // jurisdiction-ordered chain + the on-box local floor. loop.run advances it only
  // on a pre-content error (autonomous resilience). Fail-soft → single provider.
  let providerChain = null;
  try {
    const chain = await resolveProviderChain(db, userId, { sensitive: false });
    if (Array.isArray(chain) && chain.length) providerChain = [provider, ...chain];
  } catch { /* single provider */ }

  // Model-aware budgeting (fail-soft → legacy char cap). Resolved before the history
  // block so cross-turn compaction can size the window/output budget.
  let plan = null;
  try { const profile = await resolveModelProfile(provider, { fetch: fetchImpl, defaultModel: info.model }); plan = profile ? planGeneration(profile, { task: 'chat' }) : null; } catch { /* no profile */ }

  const name = await readAgentName(db, userId);
  let system = `Your name is ${name}. ${systemExtra}`.trim();
  const n = recentN != null ? recentN : (isLocal ? 5 : 12);
  try { const ctx = await handlers.getContext?.({ recentMessages: n }); if (typeof ctx === 'string' && ctx) system += `\n\n${ctx}`; } catch { /* honest-empty */ }

  // Conversation history → preamble, compacted (summarized + tail) when over budget (6d).
  if (Array.isArray(history) && history.length) {
    const contextWindow = plan ? (plan.inputBudget + (plan.maxTokens || 1024)) : 8192;
    const maxOutputTokens = plan?.maxTokens || 1024;
    const summarize = async (sys, usr, maxTokens) => {
      const r = await loop.run({ provider, system: sys, userMessage: usr, tools: [], call: async () => '', send: () => {}, maxTokens, signal });
      return r?.text || '';
    };
    system += await hydrateHistoryBlock({
      history, contextWindow, maxOutputTokens, summarize,
      getSummary: db?.harness?.getSummary ? (u, c) => db.harness.getSummary(u, c) : undefined,
      putSummary: db?.harness?.putSummary ? (rec) => db.harness.putSummary(rec) : undefined,
      conversationId, userId, hooks, untrusted: historyUntrusted,
    });
  }

  if (plan) { const budget = Math.max(512, plan.inputBudget - estimateTokens(userMessage || '')); system = trimToTokenBudget(system, budget).text; }
  else { const cap = isLocal ? 5000 : 28000; if (system.length > cap) system = `${system.slice(0, cap)}\n\n[context truncated for this model]`; }

  // Local model → no tools (tool grammar pushes a small on-box model's TTFB past budget).
  const granted = (isLocal && !localTools) ? [] : autonomyTools(tools, enabledTools);
  const grantedNames = new Set(granted.map((t) => t.name));
  const call = async (toolName, args) => {
    if (!grantedNames.has(toolName)) return `Tool '${toolName}' is not available to this turn.`;
    const h = handlers[toolName];
    if (typeof h !== 'function') return `Unknown tool: ${toolName}`;
    const out = await h(args || {});
    return typeof out === 'string' ? out : JSON.stringify(out);
  };

  return loop.run({
    provider, providerChain, system, userMessage: userMessage || '', tools: granted, call,
    send: () => {}, maxTokens: plan?.maxTokens, numCtx: plan?.numCtx, signal,
  });
}

export default runAgentTurn;
