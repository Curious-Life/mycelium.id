/**
 * Single-user lane (Phase 2) — the replacement for the Phase 1 runTurn stub.
 *
 * Why a lane: the active-turn registry (inbound-context.js) is a single global
 * reference (one operator, one conversation at a time). Two overlapping turns
 * would corrupt it — turn B's setActiveTurn would steal turn A's reply target.
 * The lane therefore SERIALIZES turns: at most one runs at any moment, exactly
 * the invariant the canonical per-agent lane provides, in ~40 LOC.
 *
 * Lifecycle per turn (the load-bearing guarantee):
 *   setActiveTurn(turnCtx)  →  runtime.runTurn(...)  →  clearActiveTurn()  [finally]
 * The registry is set before the turn and cleared after, even on error/timeout,
 * so the reply tool always resolves the right target and never a stale one.
 *
 * Enqueue-and-return: runTurn() returns immediately after queueing so the poller
 * keeps ingesting while a (possibly slow) turn runs; the serial worker drains
 * the queue in order. idle() awaits a full drain (test seam + graceful stop).
 */
import { setActiveTurn, clearActiveTurn } from '../inbound-context.js';

/**
 * @param {object} deps
 * @param {{runTurn:(a:{turnCtx:object,userMessage:string,signal?:AbortSignal})=>Promise<any>}} deps.runtime
 * @param {number} [deps.turnTimeoutMs]
 * @param {string} [deps.logPrefix]
 */
export function createLane({ runtime, turnTimeoutMs = 120_000, logPrefix = 'channel-daemon' }) {
  if (!runtime?.runTurn) throw new TypeError('createLane: runtime.runTurn required');

  let tail = Promise.resolve(); // serial chain; the worker is "whatever tail resolves to"
  let active = 0;               // 0 or 1 — guards the no-overlap invariant

  async function execute(turnCtx, msg) {
    active++;
    if (active > 1) console.error(`[${logPrefix}] LANE INVARIANT VIOLATED: ${active} concurrent turns`);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), turnTimeoutMs);
    setActiveTurn(turnCtx);
    try {
      const r = await runtime.runTurn({ turnCtx, userMessage: msg.content, signal: ac.signal });
      const verdict = r?.delivered ? 'delivered' : (r?.usedReplyTool ? 'reply-undelivered' : 'no-reply');
      console.log(`[${logPrefix}] turn done for chat=${turnCtx.channelId}: ${verdict}`);
      return r;
    } catch (e) {
      console.error(`[${logPrefix}] turn error for chat=${turnCtx.channelId}: ${e.message}`);
    } finally {
      clearTimeout(timer);
      clearActiveTurn();
      active--;
    }
  }

  return {
    label: runtime.label || 'runtime',

    /** inbound-compatible runTurn(turnCtx, msg): enqueue + return. */
    runTurn(turnCtx, msg) {
      tail = tail.then(() => execute(turnCtx, msg));
      // never let a rejected link break the chain
      tail = tail.catch(() => {});
      return Promise.resolve();
    },

    /** Await a full drain — graceful stop + test seam. */
    idle() { return tail; },
  };
}
