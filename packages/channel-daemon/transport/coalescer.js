/**
 * Inbound coalescer (Phase 3 hardening) — platform-agnostic.
 *
 * People type in bursts ("hey" … "did you see" … "the thing?"). Without
 * coalescing each fragment triggers its own agent turn → three replies to one
 * thought. This buffers fragments per chat and, after a quiet window, flushes a
 * single merged turn. Every fragment is still captured individually upstream
 * (in inbound.js) — coalescing only affects how many TURNS fire, never what the
 * vault stores.
 *
 * Merge rule: concatenate fragment texts with newlines; carry the LATEST
 * fragment's turnCtx (so reply-to targets the most recent message) but keep the
 * earliest arrival for ordering. One in-flight timer per chat; a new fragment
 * resets it (debounce).
 *
 * Reused by Discord unchanged — it operates on {turnCtx, content}, not on any
 * Telegram specifics.
 */

const DEFAULT_WINDOW_MS = 1_500;

/**
 * @param {object} deps
 * @param {(turnCtx:object, mergedMsg:{content:string})=>any} deps.flush  called once per burst
 * @param {number} [deps.windowMs]
 * @param {(fn:Function, ms:number)=>any} [deps.setTimer]   test seam (default setTimeout)
 * @param {(t:any)=>void} [deps.clearTimer]                 test seam (default clearTimeout)
 */
export function createCoalescer({ flush, windowMs = DEFAULT_WINDOW_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (typeof flush !== 'function') throw new TypeError('createCoalescer: flush required');

  /** @type {Map<string, {parts:string[], turnCtx:object, timer:any}>} */
  const buffers = new Map();

  function fire(chatId) {
    const buf = buffers.get(chatId);
    if (!buf) return;
    buffers.delete(chatId);
    const content = buf.parts.join('\n');
    flush(buf.turnCtx, { content });
  }

  return {
    /** Buffer one inbound fragment; (re)arm the quiet-window timer for its chat. */
    push(turnCtx, msg) {
      const chatId = String(turnCtx.channelId);
      const existing = buffers.get(chatId);
      if (existing) {
        existing.parts.push(msg.content);
        existing.turnCtx = turnCtx;            // latest wins for reply-to
        clearTimer(existing.timer);
        existing.timer = setTimer(() => fire(chatId), windowMs);
      } else {
        const buf = { parts: [msg.content], turnCtx, timer: null };
        buf.timer = setTimer(() => fire(chatId), windowMs);
        buffers.set(chatId, buf);
      }
    },

    /** Flush a chat's buffer immediately (e.g. graceful shutdown). */
    flushNow(chatId) {
      const buf = buffers.get(String(chatId));
      if (buf) { clearTimer(buf.timer); fire(String(chatId)); }
    },

    /** Flush every pending buffer. */
    flushAll() {
      for (const chatId of [...buffers.keys()]) this.flushNow(chatId);
    },

    _pending() { return buffers.size; },
  };
}
