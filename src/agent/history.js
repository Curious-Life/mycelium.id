// src/agent/history.js — conversation-history → preamble block, with cross-turn
// compaction (Phase 5, Step 6d). Spec §5.2/§6.
//
// streamTurn is single-message-in, so a multi-turn channel history rides the system
// preamble (exactly as getContext does). When the raw history fits the budget we render
// it verbatim — NO model call (the common, cheap path). When it would blow the budget we
// run the Step-3 compaction module: pre-prune tool results, summarize the middle, keep a
// verbatim tail, and PERSIST the summary (conversation_summaries) so the next turn updates
// it instead of re-summarizing from scratch (anti-thrash).
//
// Pure orchestration: the model call (`summarize`) and the summary store (`getSummary`/
// `putSummary`) are injected, so this is unit-testable without a configured provider.
// SECURITY (§1): never logs content; the summary persists under the at-rest boundary via
// putSummary (db.harness.putSummary encrypts `summary`).

import { shouldCompact, compact, estimateMessagesTokens } from './compaction.js';

const line = (m) => `${m.role === 'assistant' ? 'You' : 'Them'}: ${typeof m.content === 'string' ? m.content : ''}`;

// Render a (possibly compacted) neutral message list into a preamble block. A compaction
// summary arrives as a leading system message ("[Earlier conversation compacted]…").
function renderBlock(messages) {
  const parts = [];
  const convo = [];
  for (const m of messages) {
    if (m.role === 'system') parts.push(`## Earlier conversation (summarized)\n${String(m.content).replace(/^\[Earlier conversation compacted\]\n?/, '')}`);
    else convo.push(line(m));
  }
  if (convo.length) parts.push(`## Conversation so far\n${convo.join('\n')}`);
  return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}

/**
 * @param {object} a
 * @param {Array}    a.history          hydrated [{role,content}] (chronological)
 * @param {number}   a.contextWindow
 * @param {number}   a.maxOutputTokens
 * @param {(system:string,user:string,maxTokens:number)=>Promise<string>} [a.summarize]
 * @param {(userId:string,conversationId:string)=>Promise<?{summary:string}>} [a.getSummary]
 * @param {(rec:object)=>Promise<any>} [a.putSummary]
 * @param {string}  [a.conversationId]
 * @param {string}  [a.userId]
 * @param {string}  [a.dateStr]
 * @returns {Promise<string>}  the preamble block ('' for empty history)
 */
export async function hydrateHistoryBlock({
  history = [], contextWindow = 8192, maxOutputTokens = 1024,
  summarize, getSummary, putSummary, conversationId, userId, dateStr,
} = {}) {
  const neutral = (Array.isArray(history) ? history : [])
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : (m.role === 'tool' ? 'tool' : 'user'), content: m.content, ...(m.name ? { name: m.name } : {}) }));
  if (!neutral.length) return '';

  // Cheap path: fits budget → render verbatim, no model call.
  if (typeof summarize !== 'function' || !shouldCompact({ messages: neutral, contextWindow, maxOutputTokens })) {
    return renderBlock(neutral);
  }

  // Over budget → compact (prefer a stored prior summary so we UPDATE, not restart).
  let prevSummary = null;
  if (typeof getSummary === 'function' && conversationId) {
    try { prevSummary = (await getSummary(userId, conversationId))?.summary || null; } catch { /* fail-soft */ }
  }
  const res = await compact({ messages: neutral, contextWindow, maxOutputTokens, summarize, prevSummary, dateStr });
  if (res.compacted && res.summary && conversationId && typeof putSummary === 'function') {
    try { await putSummary({ userId, conversationId, summary: res.summary, tokensBefore: estimateMessagesTokens(neutral) }); } catch { /* fail-soft */ }
  }
  return renderBlock(res.messages);
}

export default hydrateHistoryBlock;
