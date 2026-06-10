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
    'HOW TO ANSWER (mandatory): your free-form text is NEVER delivered. To say',
    'ANYTHING to the user you MUST call the `reply` tool with your message in the',
    '`text` field. Always finish your turn by calling `reply` exactly once.',
    '',
    persona ? persona.trim() + '\n' : '',
    'You also have read tools over the operator’s private vault — use them FIRST to',
    'ground your reply, then call `reply`:',
    '- `getContext` for the current state-of-mind preamble,',
    '- `searchMindscape` to recall relevant memories, facts, people, and past',
    '  messages. Prefer recalled context over guessing.',
    '',
    'Style: answer in your own voice — concise and warm, as in a chat. Do not paste',
    'tool output verbatim. (If you truly have nothing to say, you may end without a',
    'reply — but normally you should reply.)',
  ].filter((l) => l !== '').join('\n');
}
