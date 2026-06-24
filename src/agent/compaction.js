// src/agent/compaction.js — auto-compaction (Phase 5, Step 3). Spec §5.2.
//
// Keeps a long conversation inside the model's real context window without losing the
// thread, deterministically and leak-safely. Pure + provider-agnostic: operates on a
// NEUTRAL message model ({role:'system'|'user'|'assistant'|'tool', content, name?}) so
// it composes with streamTurn's adapters and serves chat / channel / scheduler alike.
//
// Synthesised from the references (spec §4): proactive token-threshold trigger
// (hermes/odysseus) + reactive `truncated` fallback (canonical); WINDOWED — protect
// leading system messages + a recent verbatim tail, summarize the middle
// (hermes/openclaw); PRE-PRUNE tool-results to 1-liners before any LLM call (hermes,
// often enough alone); STRUCTURED summary prompt (Goal/Done/State/Next/Key Context) with
// temporal anchoring + iterative preserve-and-add update (hermes/openclaw/odysseus);
// ANTI-THRASH skip after weak saves (hermes); ORPHAN-tool sanitize after trim (odysseus);
// FAIL-THROUGH — never block a turn on compaction (odysseus).
//
// SECURITY (§1): the caller redacts secrets before any CLOUD summarize call; this module
// never logs content. Summaries persist under the at-rest boundary (conversation_summaries).

import { estimateTokens } from '../inference/token-budget.js';

export const COMPACT_RATIO = 0.75;           // proactive trigger: fraction of usable input budget
export const KEEP_RECENT_TOKENS = 20000;     // recent tail kept verbatim (clamped ≤40% of window)
export const BUDGET_MARGIN = 512;            // headroom (chars/4 imprecision + chat templating)
const TOOL_DIGEST_CHARS = 120;
const THRASH_MIN_SAVE = 0.10;                // two saves below this ⇒ stop trying (anti-thrash)
const PER_MSG_OVERHEAD = 4;                  // tokens of role/delimiters per message

const text = (m) => (typeof m?.content === 'string' ? m.content : '');

/** Total token estimate for a neutral message list. */
export function estimateMessagesTokens(messages = []) {
  let t = 0;
  for (const m of messages) t += estimateTokens(text(m)) + PER_MSG_OVERHEAD;
  return t;
}

/** Tokens available for input after reserving the output cap + margin. */
export function usableInputBudget(contextWindow, maxOutputTokens) {
  return Math.max(256, (contextWindow || 8192) - (maxOutputTokens || 1024) - BUDGET_MARGIN);
}

/** Summary output cap: min(5% of window, 8192), floor 512 (hermes). */
export function summaryCap(contextWindow) {
  return Math.max(512, Math.min(8192, Math.round((contextWindow || 8192) * 0.05)));
}

/**
 * Proactive trigger. True when the assembled input would exceed COMPACT_RATIO of the
 * usable budget. `extraTokens` accounts for the system preamble + the new input.
 */
export function shouldCompact({ messages = [], extraTokens = 0, contextWindow, maxOutputTokens, ratio = COMPACT_RATIO }) {
  const used = estimateMessagesTokens(messages) + extraTokens;
  return used > ratio * usableInputBudget(contextWindow, maxOutputTokens);
}

/** One-line digest for an old tool result (hermes pre-prune). */
function digestTool(m) {
  const body = text(m).replace(/\s+/g, ' ').trim();
  const head = body.slice(0, TOOL_DIGEST_CHARS);
  return `[tool:${m.name || 'result'}] ${head}${body.length > TOOL_DIGEST_CHARS ? '…' : ''} (${body.length} chars)`;
}

/** Indices of the recent tail kept verbatim (cumulative tokens ≤ keepRecentTokens). */
function tailStartIndex(messages, keepRecentTokens) {
  let acc = 0;
  let i = messages.length;
  while (i > 0) {
    const t = estimateTokens(text(messages[i - 1])) + PER_MSG_OVERHEAD;
    if (acc + t > keepRecentTokens && acc > 0) break;
    acc += t; i -= 1;
  }
  return i;
}

/**
 * Replace tool-result contents OLDER than the protected tail with 1-line digests.
 * Cheapest compaction; often avoids an LLM call entirely. Non-tool messages untouched.
 */
export function pruneToolResults(messages = [], { keepRecentTokens = KEEP_RECENT_TOKENS } = {}) {
  const cut = tailStartIndex(messages, keepRecentTokens);
  return messages.map((m, i) => (i < cut && m.role === 'tool' && text(m).length > TOOL_DIGEST_CHARS)
    ? { ...m, content: digestTool(m) }
    : m);
}

/** Partition into protected head (leading system msgs), middle (to summarize), recent tail. */
export function partition(messages = [], { keepRecentTokens = KEEP_RECENT_TOKENS } = {}) {
  let h = 0;
  while (h < messages.length && messages[h].role === 'system') h += 1;
  const cut = Math.max(h, tailStartIndex(messages, keepRecentTokens));
  return { head: messages.slice(0, h), middle: messages.slice(h, cut), tail: messages.slice(cut) };
}

/** Drop a leading 'tool' message with no preceding 'assistant' (orphan after a trim). odysseus. */
export function sanitizeOrphans(messages = []) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const prev = out[out.length - 1];
      if (!prev || (prev.role !== 'assistant' && prev.role !== 'tool')) continue; // drop orphan
    }
    out.push(m);
  }
  return out;
}

export const SUMMARY_SYSTEM = [
  'You are a context-compaction assistant. Read the conversation excerpt and produce ONLY a',
  'structured summary in the exact format below. Do NOT continue the conversation, answer',
  'questions, or call tools. Preserve specifics: names, dates, ids, numbers, decisions.',
].join(' ');

/** Build the structured summary user-prompt (temporal anchoring + iterative update). */
export function buildSummaryUser(middle = [], prevSummary = null, { dateStr } = {}) {
  const serialized = middle.map((m) => `${(m.role || 'user').toUpperCase()}${m.name ? `(${m.name})` : ''}: ${text(m)}`).join('\n');
  const parts = [];
  parts.push('Summarize the earlier part of this conversation for continuity.');
  if (dateStr) parts.push(`TEMPORAL ANCHORING: today is ${dateStr}; phrase completed actions as past-tense dated facts.`);
  parts.push([
    '## Goal — what the user is ultimately trying to do',
    '## Done — actions already completed (with ids/dates)',
    '## Current State — where things stand now',
    '## Open / Next — unresolved threads, next steps',
    '## Key Context — durable facts, preferences, constraints to remember',
  ].join('\n'));
  if (prevSummary) parts.push(`Update this prior summary — PRESERVE its facts, ADD new ones:\n${prevSummary}`);
  parts.push(`---\n${serialized}`);
  return parts.join('\n\n');
}

/**
 * Compact a neutral message list. Tries pruning first; summarizes the middle only if still
 * over budget. Never throws — on summarizer failure returns the pruned messages.
 *
 * @param {object} a
 * @param {Array}    a.messages
 * @param {number}   a.contextWindow
 * @param {number}   a.maxOutputTokens
 * @param {(system:string,user:string,maxTokens:number)=>Promise<string>} a.summarize  LLM call (caller wires)
 * @param {string}  [a.prevSummary]
 * @param {string}  [a.dateStr]
 * @param {number}  [a.extraTokens]        system preamble + new input (for the threshold check)
 * @param {number}  [a.keepRecentTokens]
 * @param {number[]} [a.thrashHistory]     prior savedRatios (anti-thrash)
 * @returns {Promise<{messages:Array, summary:?string, compacted:boolean, savedRatio:number,
 *                    viaPruneOnly?:boolean, skippedThrash?:boolean, error?:boolean}>}
 */
export async function compact({
  messages = [], contextWindow, maxOutputTokens, summarize,
  prevSummary = null, dateStr, extraTokens = 0,
  keepRecentTokens = KEEP_RECENT_TOKENS, thrashHistory = [],
}) {
  const before = estimateMessagesTokens(messages);
  const keep = Math.min(keepRecentTokens, Math.round((contextWindow || 8192) * 0.4));

  // 1) Pre-prune tool results — cheapest, often enough.
  const pruned = pruneToolResults(messages, { keepRecentTokens: keep });
  const savedByPrune = before > 0 ? 1 - estimateMessagesTokens(pruned) / before : 0;
  if (!shouldCompact({ messages: pruned, extraTokens, contextWindow, maxOutputTokens })) {
    return { messages: pruned, summary: prevSummary, compacted: false, viaPruneOnly: true, savedRatio: savedByPrune };
  }

  // 2) Anti-thrash: if the last two summaries barely helped, stop summarizing.
  const recent = thrashHistory.slice(-2);
  if (recent.length === 2 && recent.every((s) => s < THRASH_MIN_SAVE)) {
    return { messages: pruned, summary: prevSummary, compacted: false, skippedThrash: true, savedRatio: savedByPrune };
  }

  const { head, middle, tail } = partition(pruned, { keepRecentTokens: keep });
  if (!middle.length) return { messages: pruned, summary: prevSummary, compacted: false, viaPruneOnly: true, savedRatio: savedByPrune };

  // 3) Summarize the middle (fail-through — never block the turn).
  let summary;
  try {
    summary = await summarize(SUMMARY_SYSTEM, buildSummaryUser(middle, prevSummary, { dateStr }), summaryCap(contextWindow));
  } catch {
    return { messages: pruned, summary: prevSummary, compacted: false, error: true, savedRatio: savedByPrune };
  }
  if (typeof summary !== 'string' || !summary.trim()) {
    return { messages: pruned, summary: prevSummary, compacted: false, error: true, savedRatio: savedByPrune };
  }

  const summaryMsg = { role: 'system', content: `[Earlier conversation compacted]\n${summary.trim()}` };
  const out = sanitizeOrphans([...head, summaryMsg, ...tail]);
  const savedRatio = before > 0 ? 1 - estimateMessagesTokens(out) / before : 0;
  return { messages: out, summary: summary.trim(), compacted: true, savedRatio };
}

export default compact;
