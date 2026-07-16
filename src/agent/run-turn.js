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

import { createHash } from 'node:crypto';
import { describeProvider } from './harness.js';
import { autonomyTools, WRITE_AUTONOMOUS_TOOLS } from './autonomy-tools.js';
import { hydrateHistoryBlock } from './history.js';
import { agentDisplayName } from '../portal-chat.js';

// One-way hash of tool args for the write-audit (RT2-H2) — correlate, never reverse.
const argHash = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v ?? '')).digest('hex').slice(0, 16);
import { resolveInferenceConfigForTask, resolveProviderChain } from '../inference/resolve.js';
import { isSensitiveTask } from '../inference/sensitivity.js';
import { DEFAULT_OLLAMA_URL } from '../inference/local.js';
// The FAIL-CLOSED reader of settings.taskModels.categorize.model (#148). See the §4g block below.
import { defaultLabelModel } from '../enrich/drainer.js';
import { resolveModelProfile } from '../inference/model-profile.js';
import { planGeneration, estimateTokens, trimToTokenBudget } from '../inference/token-budget.js';

// agentDisplayName is the ONE definition of what settings.agent.name may be — it is
// interpolated into this turn's SYSTEM PROMPT below, so it is an instruction slot, not a
// label. This function used to re-implement the read (`a.name.trim()`, no cap) while
// portal-chat capped at 40, which made THIS path — the autonomous/channel turns, the ones
// that hold tool grants and egress — the one place the bound didn't apply.
// Do not inline it again: a chokepoint with a second hand-rolled reader is not a
// chokepoint (this was the third instance of that exact drift; see the handoff).
// Exported ONLY as a test seam: verify:provider-import drives it with a 200-char planted
// name and asserts what reaches the prompt is capped. A regex check here was NOT enough —
// `catch { return agentDisplayName(null) }` keeps any "does it call the helper?" test true
// forever, so an inlined read alongside it stayed green while 200 uncapped chars flowed
// into this system prompt. Behaviour is the only thing that can't be formatted around.
export async function readAgentName(db, userId) {
  try {
    const a = (await db.users?.getSettings?.(userId))?.agent || {};
    return agentDisplayName(a.name);
  } catch { return agentDisplayName(null); }
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
 * @param {string}   [opts.inferenceTask] which inference task to route to (default 'harness';
 *                    reflection cycles pass 'reflection' → cloud-by-default, user-configurable)
 * @returns {Promise<{text:string,truncated?:boolean,skipped?:string,toolsUsed?:string[]}>}
 */
// Mirrors resolveProviderChain's §4g rule (resolve.js) and router.infer's (router.js): a us-*
// provider is refused for a sensitive task, EXCEPT the user's own Claude subscription when
// they explicitly opted in — which applySensitiveExempt marks. Never a plain US API key.
//
// ⚠️ `|| 'us-standard'` IS THE FAIL-CLOSED DEFAULT, and it is not decoration: both of the
// rules this mirrors use it (resolve.js `cfg.jurisdiction || 'us-standard'`; router.js
// `cloudJurisdiction = () => cfg.jurisdiction || "us-standard"`). An earlier version here
// used `|| ''`, so a cfg with NO jurisdiction read as not-US and was ALLOWED — the looser
// rule, on the PRIMARY, i.e. exactly the attempt that answers. Not reachable today
// (mapRowToConfig always sets one) but it violated §3 fail-closed and contradicted this very
// comment's claim to mirror them (independent review, 2026-07-16). Keep all three in step.
// AUDITED (CLAUDE.md §8), never silent: the owner PICKED that provider, so a refusal they
// cannot see is indistinguishable from the app ignoring them. Provider + jurisdiction + task
// only — never the prompt (§1), exactly like the router's own egress audit.
// (An earlier draft routed this through `hooks.onNotice`, which DOES NOT EXIST — optional-
// chained into a silent no-op under a comment promising a log. Verify the hook, not the
// intention.)
function auditUsBlock(db, userId, task, denied, usedJurisdiction, reason) {
  try {
    db?.audit?.log?.({
      action: 'sensitive-us-block',
      userId,
      resourceType: 'inference',
      resourceId: task,
      details: {
        deniedProvider: denied?.providerName || denied?.label || 'unknown',
        deniedJurisdiction: denied?.jurisdiction || 'unknown',
        usedJurisdiction,
        reason,
      },
    });
  } catch { /* audit must never break the turn */ }
}

const isUsNonExempt = (cfg) => /^us/.test(cfg?.jurisdiction || 'us-standard') && cfg?.sensitiveUsExempt !== true;

export async function runAgentTurn(
  { db, userId, tools = [], handlers = {}, loop, fetchImpl = globalThis.fetch, signal, hooks } = {},
  { userMessage, systemExtra = '', enabledTools = [], history = [], conversationId = null, recentN, localTools = false, historyUntrusted = false, onWrite = null, inferenceTask = 'harness', maxIterations, webSearch = false, harnessMode = 'native', sessionId = null, resume = false, ttfbMs, idleMs, deliverTool = null } = {},
) {
  // CLI engine: the `claude` session OWNS the conversation memory + in-session compaction,
  // so we do NOT hydrate history into the preamble (portal-chat.js does the same). The tool
  // grant + `call` below are inert for the CLI loop (it drives its own confined MCP toolset).
  const isCli = harnessMode === 'cli';
  if (!loop || typeof loop.run !== 'function') throw new TypeError('runAgentTurn: loop with run() required');

  // ── §4g, for the tasks that need it (sensitivity.js) ─────────────────────────
  // This path does NOT go through router.infer, so it never saw the §4g gate: it hard-coded
  // `{ sensitive: false }` below and resolved its primary with no jurisdiction check at all.
  // The agent NARRATION WALK runs here with inferenceTask 'narrate' (narration-walk.js →
  // narration-runner.js → jobs.js), i.e. the user's mindscape descriptions were free to go to
  // a US provider while role-models.js claimed they could not (found 2026-07-16).
  const sensitive = isSensitiveTask(inferenceTask);
  let provider = await resolveInferenceConfigForTask(db, userId, inferenceTask);
  // ⚠️ THE PRIMARY NEEDS THE GATE, NOT JUST THE CHAIN. The chain is only the FALLBACK ladder —
  // gating it alone would block US on retry while the FIRST attempt (the one that almost always
  // answers) sent the content anyway. That would be a guarantee that fails exactly when it is
  // load-bearing.
  if (sensitive && isUsNonExempt(provider)) {
    // Fail closed to the sensitive chain — eu-zdr first, on-box local as the guaranteed floor
    // — which is precisely what router.infer does on the same condition. Never silently: the
    // owner picked this provider, so the log must say why it is not being used.
    const denied = provider;
    const safe = await resolveProviderChain(db, userId, { sensitive: true });
    // ── What replaces the refused provider ──────────────────────────────────
    // resolveProviderChain's own floor is `{ jurisdiction:'local', localFallback:true }` — no
    // key, no baseUrl — which describeProvider REJECTS, so the turn used to die two lines
    // below at `{skipped:'no-model'}`. The first fix swapped in a floor shaped like a local
    // provider. Both were wrong, in the same way, and a second review caught it by DRIVING the
    // real loop instead of reading the diff:
    //
    //   the shape was never the problem. On the config this fix exists for — ONLY a Claude
    //   subscription, allowSubscriptionSensitive off (the default), Ollama not running, no
    //   model installed (a fresh post-#148 vault, BY DESIGN) — a well-shaped local provider
    //   just dead-ends into `{text:''}` instead of `{skipped:'no-model'}`. narration-walk
    //   cannot tell either from a real answer, so THE JOB STILL REPORTS SUCCESS while the
    //   audit row and the stderr line both say "using local". The failure MODE changed; the
    //   failure did not.
    //
    // So: refuse HONESTLY. This is the drainer's own §3.5 pattern (M) — "no approved model" is
    // a legitimate STEADY STATE, not an error and not a fake run.
    //
    // ⚠️ defaultLabelModel, NOT resolveOnBoxModel. They read the SAME settings key and
    // disagree about what silence means: defaultLabelModel returns null (fail-CLOSED — #148
    // made it so on purpose: "a settings read that fails must not be read as consent"), while
    // resolveOnBoxModel returns the fallback on unset AND on throw. Using the fail-OPEN one
    // here would run an UNAPPROVED qwen3.5:4b for narrate — breaching #148's "NEVER RUN" half
    // (it cannot pull, so the download guarantee held, but that is not the whole guarantee).
    // narrate-infer.js:84 has the identical fail-open call; copying it would have propagated a
    // hole rather than inherited a guarantee. That is now task_narrate_infer_consent.
    const head = safe?.find((c) => !c.localFallback);
    if (head) {
      provider = head;
    } else {
      const approved = await defaultLabelModel(db, userId);
      if (!approved) {
        // Nothing safe to run on: no EU provider, and no APPROVED on-box model. Say so.
        auditUsBlock(db, userId, inferenceTask, denied, 'none', 'sensitive_no_safe_provider');   // NOTHING ran — do not claim 'local'
        try { process.stderr.write(`[§4g] ${inferenceTask}: selected provider is US and no EU/on-box model is approved — refusing\n`); } catch { /* never */ }
        return { skipped: 'sensitive-no-safe-provider' };
      }
      provider = { jurisdiction: 'local', baseUrl: DEFAULT_OLLAMA_URL, cloudModel: approved };
    }
    auditUsBlock(db, userId, inferenceTask, denied, provider?.jurisdiction || 'local', 'sensitive_us_block');
    try { process.stderr.write(`[§4g] ${inferenceTask}: selected provider is US — using ${provider.jurisdiction || 'local'} instead\n`); } catch { /* never */ }
  }
  const info = describeProvider(provider);
  if (!info) return { skipped: 'no-model' };
  const isLocal = info.local;

  // Provider-fallback chain (Step 7c): the resolved primary first, then the
  // jurisdiction-ordered chain + the on-box local floor. loop.run advances it only
  // on a pre-content error (autonomous resilience). Fail-soft → single provider.
  let providerChain = null;
  try {
    const chain = await resolveProviderChain(db, userId, { sensitive });
    if (Array.isArray(chain) && chain.length) {
      // Layer 1 — DEDUP the chain: the active `provider` is ALSO present in the jurisdiction-
      // sorted chain, so [provider, ...chain] attempts the primary TWICE (verified live: a channel
      // turn tried claude-opus-4-8 → qwen3.6-27b → claude-opus-4-8 → local, wasting a whole retry
      // on the already-failed primary before reaching the floor). Key by providerName+model+baseUrl
      // +jurisdiction; keep first occurrence so the primary stays first. Local floor ({}) keys once.
      const key = (c) => `${c?.providerName || ''}::${c?.cloudModel || c?.model || ''}::${c?.baseUrl || ''}::${c?.jurisdiction || ''}`;
      const seen = new Set();
      providerChain = [provider, ...chain].filter((c) => { const k = key(c); if (seen.has(k)) return false; seen.add(k); return true; });
    }
  } catch { /* single provider */ }

  // Model-aware budgeting (fail-soft → legacy char cap). Resolved before the history
  // block so cross-turn compaction can size the window/output budget.
  let plan = null;
  // Tools are gated on model CAPABILITY (probe), not geography — capture it off the
  // same profile resolution. Fail-safe default: cloud capable, bare local not.
  let toolsCapable = !isLocal;
  try {
    const profile = await resolveModelProfile(provider, { fetch: fetchImpl, defaultModel: info.model });
    plan = profile ? planGeneration(profile, { task: 'chat' }) : null;
    if (profile?.capabilities) toolsCapable = !!profile.capabilities.tools;
  } catch { /* no profile → keep the fail-safe default */ }

  const name = await readAgentName(db, userId);
  let system = `Your name is ${name}. ${systemExtra}`.trim();
  const n = recentN != null ? recentN : (isLocal ? 5 : 12);
  try { const ctx = await handlers.getContext?.({ recentMessages: n }); if (typeof ctx === 'string' && ctx) system += `\n\n${ctx}`; } catch { /* honest-empty */ }

  // Conversation history → preamble, compacted (summarized + tail) when over budget (6d).
  // Skipped for the CLI engine — its session already holds the thread.
  if (!isCli && Array.isArray(history) && history.length) {
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

  // Tools gated on model CAPABILITY (model-profile probe), not geography: a tool-capable
  // model — cloud or a large local one — gets the autonomy grant; a no-tool model gets
  // none. `localTools` stays an explicit override for callers that force tools on local.
  const granted = (toolsCapable || localTools) ? autonomyTools(tools, enabledTools) : [];
  const grantedNames = new Set(granted.map((t) => t.name));
  // The model that is ACTUALLY serving this turn right now. Starts as the primary and
  // follows the provider chain if the loop falls back mid-turn (transient faults only —
  // auth never advances). `call` runs INSIDE loop.run, so it cannot see the post-turn
  // `out.actualModel`; without this live ref a fallen-back turn stamps the persisted
  // channel message with the PRIMARY — the same mask the return value at the bottom of
  // this file already fixed for callers. Updated from the loop's `fallback` event below.
  const live = { model: info.model };

  const call = async (toolName, args) => {
    if (!grantedNames.has(toolName)) return `Tool '${toolName}' is not available to this turn.`;
    const h = handlers[toolName];
    if (typeof h !== 'function') return `Unknown tool: ${toolName}`;
    // Tell the `reply` tool WHICH model produced the reply, so the daemon can record
    // it on the persisted channel message (model-in-history). `__model` is consumed by
    // the reply handler for the persist path ONLY — it is NEVER part of the external
    // Telegram/Discord payload (see reply.js buildSendBody). A model NAME only (§1 safe).
    const callArgs = (toolName === 'reply' && live.model) ? { ...(args || {}), __model: live.model } : (args || {});
    const out = await h(callArgs);
    // Audit autonomous vault WRITES (RT2-H2): hash-only, fire-and-forget — the audit must
    // NEVER break or block the turn. Only fires for the gated write tools + when a sink
    // is provided (owner-trusted turns wire it; see channel-turn.js).
    if (typeof onWrite === 'function' && WRITE_AUTONOMOUS_TOOLS.has(toolName)) {
      try { Promise.resolve(onWrite({ tool: toolName, argHash: argHash(args) })).catch(() => {}); } catch { /* never throw */ }
    }
    return typeof out === 'string' ? out : JSON.stringify(out);
  };

  const out = await loop.run({
    provider, providerChain, system, userMessage: userMessage || '', tools: granted, call,
    // Still discards the streamed text (a channel turn delivers ONLY via the reply tool),
    // but observes `fallback` so `live.model` tracks whoever is actually answering — so a
    // downgraded turn is persisted as the model that really ran, not the one we hoped for.
    send: (e) => { if (e?.type === 'fallback' && e.toModel) live.model = e.toModel; },
    maxTokens: plan?.maxTokens, numCtx: plan?.numCtx, signal, maxIterations, webSearch,
    // Channel egress: force delivery through the reply tool (the finalizer in streamTurn) —
    // a channel turn's text answer is discarded by the no-op `send`, so without this it drops.
    requireTool: deliverTool,
    // CLI session continuity (owner channel turns) + generous idle for long autonomous work.
    ...(sessionId ? { sessionId, resume } : {}),
    ...(ttfbMs ? { ttfbMs } : {}), ...(idleMs ? { idleMs } : {}),
  });
  // Surface WHICH model ran so headless callers (scheduler, channel) can record it on
  // the persisted assistant message + the activity feed. A model NAME only (§1 safe).
  // Prefer the ACTUAL post-fallback model (out.actualModel) over the primary (info.model) —
  // otherwise a turn that fell back (e.g. subscription 401 → local qwen) is MASKED as the
  // primary, hiding a degraded turn (observability, Layer 3). `fellBack`/`harvested` ride along.
  return { ...out, model: out?.actualModel || info.model, primaryModel: info.model };
}

export default runAgentTurn;
