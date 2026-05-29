/**
 * Active-turn registry — single source of truth for "what is this agent
 * currently replying to."
 *
 * Phase 2 of EGRESS-PROVENANCE-PLAN-2026-05-06. The agent-server is one
 * Node process per agent. Per-agent lane serialization in chat.js
 * (laneId = `agent:${AGENT_ID}`) guarantees at most one /chat turn is
 * active at any moment. Therefore a single global `activeTurn` reference
 * is sufficient — no Map keyed by anything.
 *
 * Lifecycle:
 *   - chat.js sets the registry on lane entry, clears in finally.
 *   - recovery.js sets the registry before runClaudeCode (resume) when
 *     the checkpoint carries a deliveryContext, clears in finally.
 *   - All other entry points (think, triage, portal-stream, scheduler)
 *     never write the registry. The reply MCP tool (Phase 2 step 4)
 *     refuses cleanly when the registry is empty.
 *
 * The reply MCP tool will read via GET /internal/inbound-context/current
 * (Phase 2 step 2 adds the endpoint). In-process callers (send-handler
 * audit emitter, recovery resumption) can read directly via getActiveTurn().
 *
 * See docs/EGRESS-PROVENANCE-PHASE2-DESIGN-2026-05-06.md for the design
 * including threat model, edge cases, and the rationale for in-memory
 * registry over file-on-disk.
 */

let _activeTurn = null;

/**
 * @typedef {object} ActiveTurnContext
 * @property {string}  source           e.g. 'discord' | 'telegram' | 'telegram-group' | 'whatsapp' | 'portal'
 * @property {string}  channelKind      registry kind: 'discord-channel' | 'telegram-dm' | 'telegram-group' | 'whatsapp-jid' | etc.
 * @property {string}  channelId        send-route target id (real chatId/channelId — NOT synthetic `telegram_<id>`)
 * @property {string}  [channel]        human channel name (privacy-redacted in logs)
 * @property {string}  [username]
 * @property {string}  [userId]
 * @property {string}  [inboundMessageId]   for reply-to in groups
 * @property {boolean} [voiceMode]      inbound was voice → reply tool can hint voice:true
 * @property {string}  [taskId]         stable identifier for audit correlation
 * @property {number}  setAt            timestamp ms (debug + stale-detection)
 */

/**
 * Set the active turn. Throws on missing channelId — the registry is
 * useless without a routable target. Overwrites any prior entry; lane
 * serialization guarantees no conflict in well-formed callers, and
 * overwrite-on-entry is the right defensive move if a prior cleanup
 * was missed (next legitimate turn corrects).
 *
 * @param {Omit<ActiveTurnContext, 'setAt'>} ctx
 */
export function setActiveTurn(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    throw new TypeError('setActiveTurn: context object required');
  }
  if (!ctx.channelId) {
    throw new TypeError('setActiveTurn: channelId required');
  }
  _activeTurn = { ...ctx, setAt: Date.now() };
}

/**
 * @returns {ActiveTurnContext | null}
 */
export function getActiveTurn() {
  return _activeTurn;
}

/**
 * Clear the active turn. Idempotent.
 */
export function clearActiveTurn() {
  _activeTurn = null;
}

/**
 * Test seam — restore the module to a clean state between cases.
 */
export function _resetForTests() {
  _activeTurn = null;
}
