/**
 * Active-turn registry — single source of truth for "what is this daemon
 * currently replying to." Harvested from reference/egress/inbound-context.js
 * (which mirrors the canonical packages/server/lib/inbound-context.js).
 *
 * V1 channel-daemon is one process per host running one agent. The single-user
 * lane (agent/lane.js, Phase 2) guarantees at most one inbound turn is active
 * at any moment, so a single module-global reference is sufficient — no Map.
 *
 * Lifecycle:
 *   - the transport (Phase 1) sets the registry when an inbound message starts
 *     a turn, and clears it in a finally block when the turn ends.
 *   - In Phase 0 there is no transport yet; the registry is set directly (by
 *     tests, and by a curl helper) so the egress chokepoint + the `reply` MCP
 *     tool can be exercised end-to-end before the agent loop exists.
 *
 * The `reply` MCP tool (src/tools/reply.js) reads this over HTTP via
 * GET /internal/inbound-context/current and refuses cleanly (no-active-turn)
 * when the registry is empty.
 */

let _activeTurn = null;

/**
 * @typedef {object} ActiveTurnContext
 * @property {string}  source            'telegram' | 'telegram-group' | 'discord' | 'whatsapp'
 * @property {string}  channelKind       registry kind: 'telegram-dm' | 'telegram-group' | …
 * @property {string}  channelId         send-route target id (real chatId — NOT a synthetic key)
 * @property {string}  [channel]         human channel name (redacted in logs)
 * @property {string}  [username]
 * @property {string}  [userId]
 * @property {string}  [inboundMessageId]  reply-to id (groups)
 * @property {boolean} [voiceMode]       inbound was voice → reply tool may hint voice:true
 * @property {string}  [taskId]          stable id for audit correlation
 * @property {number}  setAt             timestamp ms (debug + stale-detection)
 */

/**
 * Set the active turn. Throws on a missing channelId — the registry is useless
 * without a routable target. Overwrites any prior entry; the single-user lane
 * guarantees no conflict, and overwrite-on-entry is the right defensive move if
 * a prior cleanup was missed (the next legitimate turn corrects it).
 * @param {Omit<ActiveTurnContext, 'setAt'>} ctx
 */
export function setActiveTurn(ctx) {
  if (!ctx || typeof ctx !== 'object') throw new TypeError('setActiveTurn: context object required');
  if (!ctx.channelId) throw new TypeError('setActiveTurn: channelId required');
  _activeTurn = { ...ctx, setAt: Date.now() };
}

/** @returns {ActiveTurnContext | null} */
export function getActiveTurn() {
  return _activeTurn;
}

/** Clear the active turn. Idempotent. */
export function clearActiveTurn() {
  _activeTurn = null;
}

/** Test seam — restore a clean state between cases. */
export function _resetForTests() {
  _activeTurn = null;
}
