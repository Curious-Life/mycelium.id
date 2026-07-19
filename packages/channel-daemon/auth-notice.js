/**
 * Owner notice on a channel AUTH outage — SECURITY-SENSITIVE (egress-adjacent).
 *
 * Context (2026-07-18 incident): an expired Claude subscription makes every
 * channel turn end verdict no-reply with reason 'auth' (channel-turn.js
 * classifies the loop's 401 — loop.js deliberately never falls back on auth, so
 * the vault's prompts are never re-routed to another brain). The daemon WARNed
 * on console + /healthz, but the packaged app pipes both to /dev/null and the
 * owner saw typing-then-silence with zero signal. This module makes the outage
 * VISIBLE to the owner, under hard constraints:
 *
 *   • §11 explicit-send only — the notice is DELIVERED by the caller-supplied
 *     `send`, which index.js wires to the EXISTING /telegram/send | /discord/send
 *     egress chokepoint route (the same per-boot-token trusted path command acks
 *     use). This module never opens a send path of its own.
 *   • Content-free — AUTH_NOTICE_TEXT is a static constant. No vault content,
 *     no token material, no model output can enter the notice: `send` receives
 *     only routing metadata ({source, chatId}), never text.
 *   • Owner-only — the caller-supplied `isOwnerChat(rec)` must prove the chat
 *     that messaged IS the owner's; anything else (groups, strangers) is
 *     silently skipped. Never broadcast.
 *   • Episode-limited, OUTCOME-based (the barrenPasses pattern, not a clock):
 *     ONE notice per auth outage. The episode latch resets only when a turn
 *     actually succeeds (rec.ok) — a second test message during the same outage
 *     sends nothing; the first auth failure after a recovery notifies again.
 *   • Fail-soft — a throwing `send` is logged and swallowed; the lane is never
 *     affected. The latch stays set even if the send failed (deterministic
 *     one-per-episode; the /healthz + turn-log signals still carry the outage).
 */

export const AUTH_NOTICE_TEXT =
  "I can't reach the Claude subscription — it needs to be reconnected in the Mycelium app (Settings → Intelligence). I'll reply again once it's restored.";

/**
 * @param {object} deps
 * @param {(rec:object)=>boolean} deps.isOwnerChat  proves rec.chatId is the owner's chat
 * @param {(a:{source:string|null,chatId:string})=>Promise<void>} deps.send
 *        routing-metadata-only transport; MUST route through the existing egress
 *        chokepoint (index.js wires it to POST {selfUrl}/telegram/send | /discord/send)
 * @param {(m:string)=>void} [deps.log]
 * @returns {{onTurnOutcome:(rec:object)=>Promise<void>, _inEpisode:()=>boolean}}
 */
export function createAuthOutageNotifier({ isOwnerChat, send, log = () => {} }) {
  if (typeof isOwnerChat !== 'function') throw new TypeError('auth-notice: isOwnerChat required');
  if (typeof send !== 'function') throw new TypeError('auth-notice: send required');

  let noticed = false; // the episode latch — outcome-based, reset only by a successful turn

  return {
    /** Feed every lane outcome record here (lane.js onOutcome). Never throws. */
    async onTurnOutcome(rec) {
      try {
        if (!rec) return;
        if (rec.ok) { noticed = false; return; }  // a delivered turn ENDS the episode
        if (rec.reason !== 'auth') return;        // only the auth outage class
        if (noticed) return;                      // one notice per episode
        if (!isOwnerChat(rec)) return;            // owner chat only — never broadcast
        // Latch BEFORE the await: a second auth outcome racing the in-flight send
        // must not double-notify.
        noticed = true;
        await send({ source: rec.source || null, chatId: String(rec.chatId) });
      } catch (e) {
        // Fail-soft: the notice is best-effort; the lane must never feel this.
        try { log(`auth-outage notice failed (fail-soft): ${e?.message || e}`); } catch { /* */ }
      }
    },
    /** Test seam: is the episode latch currently set? */
    _inEpisode: () => noticed,
  };
}

export default createAuthOutageNotifier;
