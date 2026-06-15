/**
 * Inbound media work queue (MED-4) — keeps a minutes-long media contextualization
 * off the poller's critical path, with a per-sender throttle that DEGRADES to a
 * placeholder (never drops a message).
 *
 * Why: the poller `await`s handleInbound, and handleInbound `await`s the media
 * stage (download + vault vision/transcription, budget up to 660s — vault-client
 * attachmentContext). One sender streaming voice notes/images therefore occupies
 * the ONLY poll slot for minutes each, stalling ALL inbound — owner DMs and
 * /disallow included. This module lets handleInbound submit-and-return so the
 * poller keeps ingesting; a SERIAL worker drains the queue in the background.
 *
 * Shape: a single serial worker (concurrency 1, which also bounds local-inference
 * load — at most one attachment-context request to the vault at a time) draining a
 * priority queue, with an idle() drain seam.
 *
 * OWNER PRIORITY: an owner job is inserted AHEAD of any queued NON-owner work (the
 * running job is never preempted), so a non-owner flood can delay owner media by at
 * most the ONE job currently in flight — not the whole backlog. Owner-vs-owner stays
 * FIFO. (Owner CONTROL-plane — commands, owner text — already bypasses the queue
 * entirely; this is only about owner *media*.)
 *
 * Two gates, both fail toward DEGRADE (the caller captures + turns a placeholder),
 * never toward DROP:
 *   - bound:        pending (queued + running) ≥ maxPending → reason 'queue-full'
 *   - per-sender:   non-owner over senderMax/window → reason 'rate-limited'
 * The OWNER is exempt from the per-sender bucket (but NOT from the bound — a truly
 * full queue still degrades owner media, bounding total work). queue-full is checked
 * BEFORE the bucket so a rejected submit never consumes a sender token.
 */
import { createRateLimiter } from './ratelimit.js';

const DEFAULT_MAX_PENDING = 8;
const DEFAULT_SENDER_MAX = 3;
const DEFAULT_SENDER_WINDOW_MS = 60_000;

/**
 * @param {object} [opts]
 * @param {number} [opts.maxPending]        queued+running cap (default 8)
 * @param {number} [opts.senderMax]         non-owner admissions per window (default 3)
 * @param {number} [opts.senderWindowMs]    bucket window (default 60s)
 * @param {()=>number} [opts.now]           test seam (forwarded to the bucket)
 * @param {string} [opts.logPrefix]
 */
export function createMediaQueue({
  maxPending = DEFAULT_MAX_PENDING,
  senderMax = DEFAULT_SENDER_MAX,
  senderWindowMs = DEFAULT_SENDER_WINDOW_MS,
  now,
  logPrefix = 'channel-daemon',
} = {}) {
  const bucket = createRateLimiter({ maxPerWindow: senderMax, windowMs: senderWindowMs, ...(now ? { now } : {}) });
  const waiting = [];      // queued jobs: { run, owner } — owner jobs sorted ahead of non-owner
  let running = 0;         // 0 or 1 (concurrency 1)
  let idleWaiters = [];

  const pending = () => waiting.length + running;

  function settleIdle() {
    if (pending() === 0 && idleWaiters.length) {
      const ws = idleWaiters; idleWaiters = [];
      for (const r of ws) r();
    }
  }

  // Single serial worker. `running` is set synchronously before the first await
  // so a concurrent submit() can't start a second worker (the guard sees it).
  async function drain() {
    if (running) return;
    while (waiting.length) {
      const job = waiting.shift();
      running = 1;
      try { await job.run(); }
      catch (e) { console.error(`[${logPrefix}] media worker error: ${e?.message || e}`); }
      finally { running = 0; }
    }
    settleIdle();
  }

  return {
    /**
     * Admit a media job for background extraction, or reject so the caller can
     * degrade to a placeholder. NEVER runs the job inline (the caller owns the
     * degrade path); returns synchronously so the poller is never blocked.
     * @param {{fromId:string|number, owner:boolean, run:()=>Promise<any>}} a
     * @returns {{accepted:boolean, reason?:'queue-full'|'rate-limited'}}
     */
    submit({ fromId, owner, run }) {
      // bound first — a full queue must not consume a sender's token (owner too).
      if (pending() >= maxPending) {
        console.warn(`[${logPrefix}] media queue full (${pending()}/${maxPending}) — degrading from=${fromId}`);
        return { accepted: false, reason: 'queue-full' };
      }
      // per-sender throttle (owner exempt).
      if (!owner && !bucket.take(String(fromId)).allowed) {
        console.warn(`[${logPrefix}] media throttled (sender ${fromId} over ${senderMax}/${senderWindowMs}ms) — degrading`);
        return { accepted: false, reason: 'rate-limited' };
      }
      const job = { run, owner };
      if (owner) {
        // Owner priority: ahead of the first queued NON-owner job (owner-owner FIFO).
        const idx = waiting.findIndex((j) => !j.owner);
        if (idx === -1) waiting.push(job); else waiting.splice(idx, 0, job);
      } else {
        waiting.push(job);
      }
      drain();
      return { accepted: true };
    },

    /** Await a full drain — graceful stop + test seam. */
    idle() {
      if (pending() === 0) return Promise.resolve();
      return new Promise((r) => idleWaiters.push(r));
    },

    /** Queued + running count (for the bound + /healthz + tests). */
    pending,
  };
}
