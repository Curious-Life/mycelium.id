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
import { appendFileSync } from 'node:fs';
import { setActiveTurn, clearActiveTurn } from '../inbound-context.js';

/**
 * @param {object} deps
 * @param {{runTurn:(a:{turnCtx:object,userMessage:string,signal?:AbortSignal})=>Promise<any>}} deps.runtime
 * @param {{start:(turnCtx:object)=>(()=>void)|null}} [deps.presence]  typing indicator (presence.js)
 * @param {number} [deps.turnTimeoutMs]
 * @param {string} [deps.logPrefix]
 */
export function createLane({ runtime, presence, turnTimeoutMs = 600_000, logPrefix = 'channel-daemon', turnLogPath = process.env.MYCELIUM_CHANNEL_TURN_LOG || null, onOutcome = null }) {
  if (!runtime?.runTurn) throw new TypeError('createLane: runtime.runTurn required');

  let tail = Promise.resolve(); // serial chain; the worker is "whatever tail resolves to"
  let active = 0;               // 0 or 1 — guards the no-overlap invariant
  let lastTurn = null;          // honest last-outcome for /healthz (incident forensics)

  // Observability (Layer 3b): persist EVERY turn outcome as one JSON line — server + daemon
  // console both go to /dev/null in the packaged app, so a silent `no-reply` was invisible.
  // LEAK-SAFE: metadata only (chatId, verdict, model, timings, flags) — NEVER message content (§1).
  const logTurn = (rec) => {
    try { if (onOutcome) onOutcome(rec); } catch { /* alert hook must never break a turn */ }
    if (!turnLogPath) return;
    try { appendFileSync(turnLogPath, JSON.stringify(rec) + '\n'); } catch { /* logging must never break a turn */ }
  };

  async function execute(turnCtx, msg) {
    active++;
    if (active > 1) console.error(`[${logPrefix}] LANE INVARIANT VIOLATED: ${active} concurrent turns`);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), turnTimeoutMs);
    setActiveTurn(turnCtx);
    // Typing presence: the user sees "typing…" while the turn runs. Stopped in
    // finally so it can never outlive the turn (error/timeout included).
    let stopPresence = null;
    const t0 = Date.now();
    try { stopPresence = presence?.start?.(turnCtx) || null; } catch { /* presence must never break a turn */ }
    try {
      const r = await runtime.runTurn({ turnCtx, userMessage: msg.content, signal: ac.signal });
      const verdict = r?.delivered ? 'delivered' : (r?.usedReplyTool ? 'reply-undelivered' : 'no-reply');
      lastTurn = { at: new Date().toISOString(), chatId: String(turnCtx.channelId), verdict, durationMs: Date.now() - t0,
        // senderId: the platform SENDER id from the turnCtx (metadata, like chatId) —
        // the auth-outage notifier proves Discord owner-ness with it (a Discord DM's
        // chatId is a channel id, not the owner's user id). Never message content.
        ...(turnCtx.userId != null ? { senderId: String(turnCtx.userId) } : {}),
        // guildId: present (non-null) only for a Discord SERVER channel; a DM is null.
        // The auth-outage notifier uses it for recipient-safety — the Discord owner
        // notice is restricted to DMs so it can never land in a public guild channel.
        ...(turnCtx.guildId != null ? { guildId: String(turnCtx.guildId) } : {}),
        ...(r?.reason ? { reason: r.reason } : {}), ...(r?.model ? { model: r.model } : {}),
        ...(r?.harvested ? { harvested: true } : {}), ...(r?.degraded ? { degraded: true } : {}) };
      // A delivered-but-degraded turn (fell back off the primary, or landed only via text-harvest)
      // is NOT a clean success — flag it so the operator alert + forensics see it.
      logTurn({ ...lastTurn, source: turnCtx.source || null, ok: verdict === 'delivered' });
      console.log(`[${logPrefix}] turn done for chat=${turnCtx.channelId}: ${verdict}${r?.degraded ? ' (degraded)' : ''}${r?.harvested ? ' (harvested)' : ''} model=${r?.model || '?'} ${Date.now() - t0}ms`);
      return r;
    } catch (e) {
      lastTurn = { at: new Date().toISOString(), chatId: String(turnCtx.channelId), verdict: 'error', durationMs: Date.now() - t0, error: String(e.message || e).slice(0, 200) };
      logTurn({ ...lastTurn, source: turnCtx.source || null, ok: false });
      console.error(`[${logPrefix}] turn error for chat=${turnCtx.channelId}: ${e.message}`);
    } finally {
      try { stopPresence?.(); } catch { /* never let presence cleanup throw */ }
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

    /** Outcome of the most recent turn ({at, chatId, verdict, reason?|error?}) — /healthz. */
    lastTurn() { return lastTurn; },
  };
}
