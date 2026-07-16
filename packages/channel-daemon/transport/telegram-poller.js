/**
 * Telegram long-poll loop (Phase 1) — getUpdates over raw fetch, no Grammy.
 *
 * V1 deliberately avoids the Grammy/Telegraf dependency (the daemon, like the
 * inference layer, talks to platform APIs over Node's built-in fetch). This is
 * ~the whole inbound transport: confirm-by-offset long-poll, normalize each
 * update, hand it to the inbound handler, advance the offset, back off on error.
 *
 * Lifecycle: start() runs until stop() is called (or the AbortController fires).
 * Resilient — a getUpdates error backs off (capped) and retries; a per-message
 * handler error is swallowed by the handler itself (soft-fail) so the loop never
 * stalls on one bad message.
 *
 * Single-instance discipline: two pollers on one bot token cause Telegram 409
 * "terminated by other getUpdates". The operator runs exactly one daemon; the
 * 409 surfaces as a logged error + backoff rather than a crash loop.
 */
import { normalizeUpdate, maxUpdateId } from './normalize.js';

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/**
 * @param {object} deps
 * @param {{getUpdates:(a:object)=>Promise<any[]>}} deps.telegram
 * @param {(msg:object)=>Promise<void>} deps.handleInbound
 * @param {number} [deps.pollTimeout]   long-poll hold seconds (default 30)
 * @param {string} [deps.logPrefix]
 * @param {(ms:number)=>Promise<void>} [deps.sleep]   test seam
 */
export function createTelegramPoller({ telegram, handleInbound, pollTimeout = 30, logPrefix = 'channel-daemon', sleep }) {
  if (!telegram?.getUpdates) throw new TypeError('createTelegramPoller: telegram.getUpdates required');
  if (typeof handleInbound !== 'function') throw new TypeError('createTelegramPoller: handleInbound required');
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  let running = false;
  let offset; // last update_id + 1
  let backoff = BACKOFF_START_MS;
  let forceClose = false;      // set after a 409 → next poll drops the reused socket
  let conflictSince = null;    // health: another poller holds this bot token

  async function pollOnce() {
    const updates = await telegram.getUpdates({ offset, timeout: pollTimeout, forceClose });
    forceClose = false;        // a successful poll clears the socket-reset request…
    conflictSince = null;      // …and the conflict state.
    for (const u of updates) {
      const msg = normalizeUpdate(u);
      // Crash-safe, at-least-once: handleInbound durably captures the message
      // (deduped by tg-<id>-<chat>, inbound.js) BEFORE it returns, so the offset
      // advances ONLY after each update has been processed. A daemon crash/restart
      // mid-batch (config-save reload, OOM, etc.) re-fetches the un-advanced updates
      // and re-captures them — the dedup absorbs the replay, so nothing is lost.
      // (Previously the offset advanced for the whole batch BEFORE handling, so a
      // crash between advance and capture dropped those messages forever.)
      if (msg) await handleInbound(msg);
      offset = u.update_id + 1;
    }
  }

  return {
    /** Run the poll loop until stop(). Returns when stopped. */
    async start() {
      if (running) return;
      running = true;
      console.log(`[${logPrefix}] telegram poller started (long-poll ${pollTimeout}s)`);
      while (running) {
        try {
          await pollOnce();
          backoff = BACKOFF_START_MS; // healthy poll resets backoff
        } catch (e) {
          if (!running) break;
          if (e?.code === 'conflict') {
            // Another poller is holding this bot token (app running twice, or a
            // stale daemon). Reset the socket next poll + record it for health so
            // the UI can say the real cause instead of a vague "check the token".
            forceClose = true;
            if (!conflictSince) conflictSince = Date.now();
            console.error(`[${logPrefix}] getUpdates 409 CONFLICT — another poller is using this bot token (is Mycelium running twice?). Resetting the connection.`);
          }
          // ±30% jitter so repeated failures don't hammer the API in lockstep.
          const jittered = Math.round(backoff * (0.85 + Math.random() * 0.3));
          console.error(`[${logPrefix}] getUpdates error (backoff ~${jittered}ms): ${e.message}`);
          await wait(jittered);
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        }
      }
      console.log(`[${logPrefix}] telegram poller stopped`);
    },

    stop() { running = false; },

    /** Health for the status surface: 'conflict' (another poller on this token)
     *  else 'ok'. Consumed by the daemon /healthz → getHealth → Settings pill. */
    state() { return conflictSince ? { status: 'conflict', since: conflictSince } : { status: 'ok' }; },

    /** Test seam — run exactly one poll cycle. */
    _pollOnce: pollOnce,
  };
}
