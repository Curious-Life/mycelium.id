// src/agent/loop.js — the native agent loop core (Phase 5, Step 1).
//
// ONE turn driver, three surfaces. Today this wraps the existing single-exchange
// streamTurn (src/agent/harness.js) with the reliability layer that used to live
// inline in portal-chat.js: a two-budget watchdog (TTFB for first token, IDLE for
// inter-token) + retry-on-empty with exponential backoff + first-token signalling.
// It is TRANSPORT-AGNOSTIC: `send` is any sink (SSE writer for chat, no-op/collector
// for channel/scheduler), so the same driver serves all three triggers.
//
// Step 1 is BEHAVIOR-PRESERVING: this is portal-chat's attempt-loop verbatim,
// extracted. Multi-turn continuation, history hydration and auto-compaction (spec
// §5.1/§5.2) attach here in later steps via the marked extension points — without
// changing this signature.
//
// SECURITY: never logs prompt/response text; the egress audit + leak-safety live in
// streamTurn (the harness), which this only orchestrates. Tool-execution errors are
// surfaced as events by streamTurn, never as raw messages (§1).

import { describeProvider } from './harness.js';
import { classifyProviderError } from './provider-errors.js';

const DEFAULT_TTFB_MS = 45000;     // first-token wait (cold local load + reasoning)
const DEFAULT_IDLE_MS = 60000;     // inter-token gap before declaring a stall
const DEFAULT_MAX_RETRIES = 2;     // whole-turn retries while it produced NOTHING
const BACKOFF_BASE_MS = Number(process.env.MYCELIUM_BACKOFF_BASE_MS) || 1000;   // base, exp-backed
const BACKOFF_CAP_MS = Number(process.env.MYCELIUM_BACKOFF_CAP_MS) || 30000;    // cap before jitter
const RETRY_AFTER_CAP_MS = Number(process.env.MYCELIUM_RETRY_AFTER_CAP_MS) || 60000; // clamp a provider's Retry-After so a bad/huge value can't hang the turn

/**
 * Create the agent loop core.
 * @param {object} opts
 * @param {{streamTurn:Function}} opts.harness   createAgentHarness() result
 * @param {(msg:string)=>void} [opts.logger]
 */
export function createAgentLoop({ harness, logger = () => {} }) {
  if (!harness || typeof harness.streamTurn !== 'function') {
    throw new TypeError('createAgentLoop: harness with streamTurn required');
  }

  /**
   * Drive ONE turn to completion (with watchdog + retry), streaming events via send().
   *
   * @param {object} a
   * @param {object}   a.provider      resolveInferenceConfig* result (or {} for local)
   * @param {string}   a.system        system preamble (getContext + retrieval)
   * @param {string}   a.userMessage
   * @param {Array}    a.tools         granted tool defs (already domain-filtered)
   * @param {(name:string,args:object)=>Promise<string>} a.call   in-proc handler dispatch
   * @param {(ev:object)=>void} a.send  emits {type,...} events (SSE writer | sink)
   * @param {number}  [a.maxTokens]
   * @param {number}  [a.numCtx]
   * @param {number}  [a.ttfbMs]       first-token budget (default 45s)
   * @param {number}  [a.idleMs]       inter-token budget (default 60s)
   * @param {number}  [a.maxRetries]   empty-turn retries (default 2)
   * @param {AbortSignal} [a.signal]   external abort = "client gone" / cancel
   * @param {()=>void} [a.onStall]     called when a stall is detected (clear activity row)
   * @param {()=>void} [a.onHeartbeat] called each healthy watchdog tick (refresh activity row)
   * @returns {Promise<{text:string, toolsUsed:string[], truncated:boolean, capped:boolean,
   *                    aborted:boolean, clientGone:boolean, lastErr:any}>}
   *   `text` is the streamed assistant text (accumulated here); `clientGone` ⇒ the external
   *   signal fired (caller should emit nothing further); `truncated` ⇒ output cap hit.
   */
  async function run({
    provider, system, userMessage, tools = [], call, send = () => {},
    maxTokens, numCtx, maxIterations, webSearch = false, requireTool = null,
    ttfbMs = DEFAULT_TTFB_MS, idleMs = DEFAULT_IDLE_MS, maxRetries = DEFAULT_MAX_RETRIES,
    signal, onStall, onHeartbeat, providerChain = null,
  }) {
    // Provider-fallback (Step 7a): an OPTIONAL ordered chain (resolveProviderChain). The
    // autonomous surfaces pass it; interactive chat passes a single `provider` (chain null
    // → today's behavior, unchanged). A provider can't be swapped mid-stream, so we only
    // advance the chain on a RETRYABLE error with NOTHING streamed yet (pre-content).
    const chain = Array.isArray(providerChain) && providerChain.length ? providerChain : null;
    let chainIdx = 0;
    let activeProvider = chain ? chain[0] : provider;
    let fellBack = false;
    let assistantText = '';
    let lastActivity = Date.now();
    let streaming = false;             // flipped on the first token (text or thinking)
    let attemptCtrl = null;            // the current attempt's AbortController (watchdog aborts it)
    let retryAfterMs = 0;              // provider Retry-After (429/503) carried into the NEXT backoff

    const clientGone = () => !!signal?.aborted;

    // Wrap the caller's send: track activity for the watchdog, flip to the looser
    // IDLE budget + signal `responding` on the first token, accumulate the answer.
    const sink = (ev) => {
      if (ev.type === 'text_delta' || ev.type === 'tool_start' || ev.type === 'tool_complete' || ev.type === 'thinking_delta') {
        lastActivity = Date.now();
        if (!streaming && (ev.type === 'text_delta' || ev.type === 'thinking_delta')) {
          streaming = true;
          send({ type: 'responding' });
        }
      }
      if (ev.type === 'text_delta' && ev.content) assistantText += ev.content;
      send(ev);
    };

    // Watchdog: first-token wait vs inter-token gap. On breach, abort the current
    // attempt (keeps any partial text already streamed) and let onStall clear the
    // live row immediately — a hung upstream fetch may never settle the promise.
    const watchTick = Math.max(500, Math.min(4000, Math.floor(ttfbMs / 4)));
    const watchdog = setInterval(() => {
      const limit = streaming ? idleMs : ttfbMs;
      if (Date.now() - lastActivity > limit) {
        try { attemptCtrl?.abort(); } catch { /* noop */ }
        try { onStall?.(); } catch { /* noop */ }
      } else if (!clientGone()) {
        try { onHeartbeat?.(); } catch { /* noop */ }
      }
    }, watchTick);

    let result = null;
    let lastErr = null;
    try {
      // Attempt loop: retry the whole turn while it produced NOTHING (stalled or
      // errored before any token). Once any text streams, keep it — no retry
      // (re-streaming would duplicate into the same bubble).
      for (let attempt = 0; ; attempt++) {
        if (clientGone()) break;
        if (attempt > 0) {
          // Decorrelated jittered exponential backoff (hermes) — avoids hammering a
          // rate-limited provider in lockstep. min(base·2^n, cap) + 0–50% jitter. When the
          // provider ASKED for a longer wait via Retry-After (429/503), honor that instead
          // (best practice — waiting less just gets re-throttled), clamped so a bad header
          // can't hang the turn.
          const d = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
          const jittered = d + Math.floor(Math.random() * 0.5 * d);
          const backoff = Math.min(Math.max(jittered, retryAfterMs), RETRY_AFTER_CAP_MS);
          retryAfterMs = 0;   // consumed
          await new Promise((r) => setTimeout(r, backoff));
          if (clientGone()) break;
          send({ type: 'retry', attempt });
          logger(`loop: empty/stalled — retry ${attempt}/${maxRetries} after ${backoff}ms`);
        }
        // Fresh per-attempt state + controller; link the external (client-gone) signal.
        attemptCtrl = new AbortController();
        lastActivity = Date.now();
        streaming = false;
        if (signal) {
          if (signal.aborted) attemptCtrl.abort();
          else signal.addEventListener('abort', () => { try { attemptCtrl.abort(); } catch {} }, { once: true });
        }

        try {
          result = await harness.streamTurn({
            provider: activeProvider, system, userMessage, tools, call,
            send: sink, signal: attemptCtrl.signal, maxTokens, numCtx, webSearch, requireTool,
            // Per-turn tool-loop cap (undefined → the harness default). Untrusted channel
            // turns pass a LOWER cap so a coaxed runaway can't ride the owner's 100-round
            // budget on Opus (MED-1). Owner/interactive turns leave it undefined → 100.
            ...(maxIterations != null ? { maxIterations } : {}),
          });
          lastErr = null;
        } catch (e) {
          lastErr = e;
          const { retryable, reason, retryAfterMs: ra } = classifyProviderError(e);
          retryAfterMs = ra || 0;   // honored by the next attempt's backoff (clamped there)
          logger(`loop: attempt ${attempt} failed (${reason}; ${e?.status || e?.message || 'error'}${ra ? `; retry-after ${ra}ms` : ''})`);
          if (reason === 'aborted') break;   // our watchdog/cancel — stop, don't fall back
          // AUTH IS NEVER A FALLBACK CONDITION.
          // A 401/403 means the credential for the provider the user CHOSE was rejected.
          // Advancing the chain here would silently answer with a DIFFERENT model, from a
          // DIFFERENT provider — possibly in a different jurisdiction — under the label the
          // user picked. That is precisely the lie this repo documents at
          // claude-config-dir.js:101-105: "every native channel/harness turn sent an EXPIRED
          // Bearer → 401 → the provider-fallback chain silently downgraded the turn to
          // local/EU qwen while the activity feed still recorded claude-opus-4-8."
          // An expired subscription must surface so the user can reconnect — their vault's
          // prompts must never be re-routed to another brain because a token lapsed.
          // Transient failures (429 / 5xx / network) still cascade below: same intent,
          // temporary fault. classifyProviderError already separates them
          // (provider-errors.js: 401/403 → {retryable:false, reason:'auth'}).
          if (reason === 'auth') break;
          // Pre-content provider-fallback: nothing streamed + a next provider exists →
          // advance the chain (transient/retryable errors only — see the auth break above).
          // A fallback doesn't consume the empty-retry budget; total tries stay bounded by
          // maxRetries + chain length.
          if (!assistantText.trim() && chain && chainIdx < chain.length - 1) {
            chainIdx += 1; activeProvider = chain[chainIdx]; fellBack = true;
            retryAfterMs = 0;   // LOW-1: don't carry provider A's Retry-After onto B's path
            const d = describeProvider(activeProvider);
            const to = d?.label || null;
            // Carry the new MODEL, not just the label: callers stamp the model onto the
            // persisted message DURING the turn (run-turn.js's `call` closure), so without
            // this they can only record the pre-turn primary — masking a downgraded turn as
            // the model the user chose. The label alone can't be persisted as `model`.
            send({ type: 'fallback', reason, to, toModel: d?.model || null });
            logger(`loop: provider fallback (${reason}) → ${to || 'next'}`);
            attempt -= 1; continue;
          }
          // Chain exhausted / no chain: a fatal error won't change on retry — stop now
          // rather than burning empty-retries on it.
          if (!retryable) break;
        }

        // Stop when: client gone, got text, DELIVERED via the required tool (a reply-only
        // turn streams no text but must NOT retry → double-send), the model hit its output
        // cap (retry would re-hit it), or retries exhausted. Otherwise (empty/stalled) → retry.
        const delivered = requireTool && Array.isArray(result?.toolsUsed) && result.toolsUsed.includes(requireTool);
        if (clientGone() || assistantText.trim() || delivered || result?.truncated || attempt >= maxRetries) break;
      }
    } finally {
      clearInterval(watchdog);
    }

    return {
      text: assistantText,
      toolsUsed: result?.toolsUsed || [],
      truncated: !!result?.truncated,
      capped: !!result?.capped,
      aborted: !!result?.aborted,
      clientGone: clientGone(),
      fellBack,
      // Delivery guarantee (Layer 2): reply was landed via the text-harvest last resort.
      harvested: !!result?.harvested,
      // Observability (Layer 3): the ACTUAL provider/model that produced the answer AFTER any
      // fallback — so the activity feed reports what really ran (was masked as the primary model).
      actualModel: describeProvider(activeProvider)?.model || null,
      actualJurisdiction: describeProvider(activeProvider)?.jurisdiction || null,
      // Did the content stay on THIS MACHINE? Only knowable HERE — after any chain advance
      // above. A sensitive chain is [localPrimary, eu-zdr…, localFloor], so a run whose on-box
      // Ollama dies FALLS BACK TO EU CLOUD mid-run: anything computed before loop.run (a
      // start-of-run snapshot) would claim on-box while the bytes left. Distinct from
      // actualJurisdiction — a `.local` LAN box is 'local' but NOT this device. @see
      // describeProvider. `?? null` NOT `|| false`: the local FLOOR ({jurisdiction:'local',
      // localFallback:true}) has no base_url, so describeProvider returns null and the honest
      // answer is UNKNOWN. Callers must fail closed on null (claim nothing) rather than read a
      // `false` as "it left" (a false alarm is also a false statement).
      actualOnThisDevice: describeProvider(activeProvider)?.onThisDevice ?? null,
      lastErr,
    };
  }

  return { run };
}

export default createAgentLoop;
