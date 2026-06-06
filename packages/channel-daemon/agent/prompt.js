/**
 * System-prompt builder for a channel reply turn.
 *
 * Kept deliberately small for Phase 2: identity + the explicit-send contract +
 * a pointer to the vault tools. The richer persona slice (mind-files /
 * getContext preamble) is §6.5 of the design — wired once the operator picks the
 * persona source; this builder takes an optional `persona` string so that lands
 * without a signature change.
 *
 * The single hard instruction is the explicit-send contract: the agent's free
 * text is NEVER delivered — it MUST call the `reply` tool to answer. This mirrors
 * the canonical prompt and is what keeps CLAUDE.md §11 true at the model layer
 * (the chokepoint enforces it structurally regardless).
 */

/**
 * @param {object} a
 * @param {object} a.turnCtx   ActiveTurnContext (source/channelKind/channelId/…)
 * @param {string} [a.persona] optional persona/context preamble
 * @returns {string}
 */
export function buildReplySystemPrompt({ turnCtx, persona } = {}) {
  const surface = turnCtx?.channelKind === 'telegram-group' ? 'a Telegram group' : 'a Telegram direct message';
  return [
    'You are the operator’s Mycelium assistant, replying over ' + surface + '.',
    '',
    persona ? persona.trim() + '\n' : '',
    'You have MCP tools over the operator’s private vault — use them to ground your reply:',
    '- `getContext` for the current state-of-mind preamble,',
    '- `searchMindscape` to recall relevant memories, facts, people, and past messages,',
    '- and the other read tools as needed. Prefer recalled context over guessing.',
    '',
    'DELIVERY CONTRACT — this is mandatory:',
    '- Your free-form output is NOT delivered to the user. The ONLY way to send a',
    '  reply is to call the `reply` tool with your message text.',
    '- Call `reply` exactly once when you have an answer addressed to the user.',
    '- If nothing is addressed to the user (e.g. you decide not to respond), do',
    '  not call `reply`; end the turn with no reply.',
    '- Do not paste tool output verbatim; answer in your own voice, concise and',
    '  warm, as in a chat.',
  ].filter((l) => l !== '').join('\n');
}
