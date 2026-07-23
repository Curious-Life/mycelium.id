// src/agent/attachment-context.js — the ONE seam that puts an attachment's
// DERIVED TEXT (voice-note transcript, image caption, extracted document text)
// in front of the agent for the message it belongs to.
//
// WHY THIS EXISTS (QA 2026-07-22): a voice note was transcribed successfully and
// the transcript WAS in the vault (attachments.transcript) — but the agent said it
// could not see it. The work succeeded and was thrown away. The transcript was
// stranded because every agent-facing read projects messages.content ONLY:
//   - src/tools/context.js       getContext "RECENT MESSAGES"  (content only)
//   - src/agent/channel-turn.js  history hydration             ({role, content})
//   - src/portal-chat.js         chat history hydration        ({role, content})
//   - src/tools/messages.js      getDailyMessages              (content only)
// while `messages.attachment_id → attachments.transcript` held the text. Only the
// DISPLAY path (src/streams/assemble-messages.js) ever did that join, so the
// transcript was visible to the human in Library/Media and invisible to the agent.
//
// Two write paths make the stranding permanent without this join:
//   1. Portal/local-file upload (src/ingest/run-import.js) — the message is captured
//      as "File: memo.m4a" and transcription runs FIRE-AND-FORGET afterwards. The
//      transcript lands on the attachment; the message body is never rewritten.
//   2. Channel inbound (packages/channel-daemon/media.js) — the transcript is folded
//      into msg.content at capture time, but only if extraction succeeded THEN. A
//      cold/absent model yields "[Voice note — transcription unavailable]" frozen
//      into the row; a later Media→Transcribe fills attachments.transcript and the
//      message body still says "unavailable".
//
// HONESTY CONTRACT (the second half of the bug — silence is worse than a transcript):
//   - transcript present         → the text (clamped), never silence
//   - audio, no transcript yet   → "transcription in progress or not yet run" —
//                                  NOT "unavailable" (which reads as permanent)
//   - attachment row unreadable  → "could not be loaded" — the agent is TOLD the
//                                  derived text exists-or-may-exist but did not load,
//                                  instead of silently receiving nothing.
//
// SECURITY:
//   - transcript/description are user content, decrypted by the db adapter on the
//     existing read path (db.attachments.getByIds). Nothing here reads blobs or
//     touches keys, and NOTHING here is ever logged (CLAUDE.md §1).
//   - user_id is passed to getByIds — the SQL-layer scoping (a bare-id read is
//     refused) — and rows are re-checked defensively below.
//   - the line rides the SAME egress as messages.content: a turn that may send
//     content to a cloud provider already cleared §4g/consent for that content;
//     this widens nothing (no new destination, no new field class).

/** Per-message clamp so one long transcript can't crowd out the whole briefing. */
export const MAX_ATTACHMENT_TEXT = 4000;

// AGGREGATE budget (QA 2026-07-22, round 2): the per-message clamp above bounds ONE
// transcript, but a batch has no total — 40 messages × a 4000-char clamp = 160KB of
// transcript in a single briefing (~40k tokens, 8× the pre-PR size). That silently
// evicts claims/reflections/cycles AND the very history this PR populated, because
// history is appended AFTER getContext and trimToTokenBudget is TAIL truncation.
// So the resolver spends an aggregate budget MOST-RECENT-FIRST: the newest transcripts
// get their full (clamped) text, and once the budget is spent, older ones degrade to a
// POINTER line ("transcript stored (N chars) … ask me to read it") — a 4th honest
// state, never a silent drop. Budgets are per call site (a day-review can afford more
// than a turn preamble); the default is a fail-closed constant, never Infinity.
export const TRANSCRIPT_BUDGET_BRIEFING = 6000;  // getContext getContext preamble (every turn)
export const TRANSCRIPT_BUDGET_HISTORY = 8000;   // channel-turn / portal-chat history hydration
export const TRANSCRIPT_BUDGET_DAILY = 24000;    // getDailyMessages day review (user-initiated, larger)
export const DEFAULT_TRANSCRIPT_BUDGET = 12000;  // fail-closed default when a caller forgets — finite, never Infinity

const KIND_LABEL = { voice: 'Voice note', image: 'Image', video: 'Video', file: 'File' };

/** mime / legacy-kind → the coarse kind we render. Local copy: this module is
 *  imported by the stdio MCP tool path, which must not pull in express. */
export function attachmentKindOf(fileType) {
  const t = String(fileType || '').toLowerCase();
  if (t.startsWith('audio/') || t === 'voice' || t === 'audio') return 'voice';
  if (t.startsWith('image/') || t === 'image') return 'image';
  if (t.startsWith('video/') || t === 'video') return 'video';
  return 'file';
}

const clamp = (s) => {
  const t = String(s).trim();
  return t.length > MAX_ATTACHMENT_TEXT ? `${t.slice(0, MAX_ATTACHMENT_TEXT)}… (truncated)` : t;
};

/** The derived text attachmentContextLine WOULD render for this attachment (before the
 *  clamp) — transcript for audio/video, description for images, description-or-transcript
 *  for documents. Empty string when there is nothing stored yet. Used to size the
 *  aggregate budget, so the budget tracks the SAME text the line emits. */
function derivedText(att) {
  if (!att) return '';
  const kind = attachmentKindOf(att.file_type);
  const transcript = typeof att.transcript === 'string' ? att.transcript.trim() : '';
  const description = typeof att.description === 'string' ? att.description.trim() : '';
  if (kind === 'voice' || kind === 'video') return transcript;
  if (kind === 'image') return description;
  return description || transcript;
}

/** Budget cost of an attachment: the length actually emitted (clamped), 0 when there is
 *  no derived text (a pending/undescribed line is short and never budgeted out). */
function budgetCost(att) {
  const len = derivedText(att).length;
  return len > MAX_ATTACHMENT_TEXT ? MAX_ATTACHMENT_TEXT : len;
}

/** The 4th honest state: derived text EXISTS but was left out to keep this briefing
 *  short (aggregate budget spent by more-recent attachments). A pointer, never silence —
 *  the agent is told the transcript is retrievable and how to get it. */
export function attachmentPointerLine(att) {
  const kind = attachmentKindOf(att.file_type);
  const label = KIND_LABEL[kind] || 'File';
  const name = att.file_name ? `: ${att.file_name}` : '';
  const noun = (kind === 'voice' || kind === 'video') ? 'transcript' : 'text';
  const chars = derivedText(att).length.toLocaleString('en-US');
  return `[${label}${name} — ${noun} stored (${chars} chars), not included here to keep this briefing short; ask me to read it.]`;
}

// Don't say the same thing twice: the channel inbound path already folds the
// transcript into msg.content, so re-appending it would duplicate it in context.
// Suppress ONLY on FULL containment of the normalized text (MINOR-1, round 2): the
// old leading-120-char check suppressed a line whenever the FIRST 120 chars matched,
// so a long transcript that content carries only PARTIALLY (or that a caller's content
// slice cut off past char 500) was dropped even though its tail never reached the agent.
function alreadyCarries(content, text) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const t = norm(text);
  if (t.length < 8) return false;
  return norm(content).includes(t);
}

/**
 * The bracketed line the agent sees for one message's attachment.
 * @param {object|null} att   the attachment row (id/file_type/file_name/transcript/description),
 *                            or null when the row could not be loaded / is missing.
 * @param {object} [opts]
 * @param {string} [opts.content]   the message body, so we never duplicate text it already carries
 * @returns {string|null}     the line, or null when there is nothing to add
 */
export function attachmentContextLine(att, { content = '' } = {}) {
  if (!att) {
    // Fail-LOUD-to-the-agent: an attachment is linked but we couldn't read its row.
    // Any derived text (a transcript that DOES exist) is missing from this turn —
    // say so rather than letting the agent conclude there is nothing there.
    return '[An attachment is linked to this message, but its stored text (transcript/description) could not be loaded right now — say so rather than assuming there is none.]';
  }
  const kind = attachmentKindOf(att.file_type);
  const label = KIND_LABEL[kind] || 'File';
  const name = att.file_name ? `: ${att.file_name}` : '';
  const head = `${label}${name}`;
  const transcript = typeof att.transcript === 'string' ? att.transcript.trim() : '';
  const description = typeof att.description === 'string' ? att.description.trim() : '';

  if (kind === 'voice' || kind === 'video') {
    if (transcript) {
      return alreadyCarries(content, transcript) ? null : `[${head} — transcript: "${clamp(transcript)}"]`;
    }
    // Pending ≠ impossible. "unavailable" reads as permanent and makes the agent
    // give up; the honest state is that transcription has not produced text YET.
    return `[${head} attached — no transcript stored yet (transcription in progress or not yet run); you can ask them to run it from Media.]`;
  }
  if (kind === 'image') {
    if (description) return alreadyCarries(content, description) ? null : `[${head} — ${clamp(description)}]`;
    return `[${head} attached — not described yet.]`;
  }
  // documents / unknown binaries: extract-document text lands in `description`.
  if (description) return alreadyCarries(content, description) ? null : `[${head} — content: ${clamp(description)}]`;
  if (transcript) return alreadyCarries(content, transcript) ? null : `[${head} — transcript: "${clamp(transcript)}"]`;
  return `[${head} attached — no extracted text stored.]`;
}

/**
 * Batch-resolve the attachment lines for a set of message rows.
 *
 * Fail-soft but HONEST: if the attachment read throws, every attachment-bearing
 * row still gets the "could not be loaded" line (never silence).
 *
 * AGGREGATE BUDGET: `budget` chars of derived text are spent across the batch
 * MOST-RECENT-FIRST (created_at desc — NOT array order: selectRecent hands rows
 * newest-first but selectPaginated/selectByConversation hand them oldest-first, so
 * we sort by real recency). The newest attachments render their full (clamped) text;
 * once the budget is spent, older ones degrade to a POINTER line (never a silent drop).
 * Pending/undescribed attachments cost 0 and always render their short honest line.
 *
 * SCOPE NOTE (MINOR-2, round 2): `attachments` ∈ SCOPE_AWARE_TABLES (crypto-local.js),
 * but db.attachments.getByIds neither SELECTs nor filters `scope` — it scopes by
 * user_id only. That is correct TODAY because attachment reads are message-gated (the
 * agent reaches a transcript through a message it is already entitled to see, and the
 * row ids come from those messages), so scope is not a read boundary here. Revisit if
 * scope ever becomes an independent read boundary for attachments.
 *
 * @param {Array<object>} rows  message rows carrying `attachment_id` (and `created_at`)
 * @param {{db: object, userId: string, budget?: number, contentLimit?: number}} ctx
 *   budget       — aggregate derived-text char budget (default fail-closed constant)
 *   contentLimit — if >0, the dedup compares against content sliced to this many chars,
 *                  matching a caller that RENDERS a slice (getContext slices to 500).
 * @returns {Promise<(row: object) => string|null>} lineFor(row)
 */
export async function attachmentLineResolver(
  rows,
  { db, userId, budget = DEFAULT_TRANSCRIPT_BUDGET, contentLimit = 0 } = {},
) {
  const list = rows || [];
  const ids = [...new Set(list.map((r) => r?.attachment_id).filter(Boolean))];
  if (!ids.length) return () => null;
  let map = new Map();
  let errored = false;
  try {
    if (typeof db?.attachments?.getByIds !== 'function') throw new Error('attachments namespace unavailable');
    const atts = await db.attachments.getByIds(ids, userId);
    // getByIds enforces the user_id scope IN SQL (a bare-id read is refused) and does
    // not project user_id back, so the filter below is a belt-and-braces no-op today —
    // kept only to stay correct if the projection ever starts carrying user_id.
    map = new Map((atts || [])
      .filter((a) => a && (a.user_id === undefined || a.user_id === userId))
      .map((a) => [a.id, a]));
  } catch {
    errored = true; // no detail logged — the message could carry content (§1)
  }

  // Spend the aggregate budget by REAL recency (created_at desc), not array order.
  // `included` = the attachment ids that earned their full text this batch; everything
  // else with stored text becomes a pointer. Fail-closed: a non-finite budget collapses
  // to the default constant so a mistake can never re-open the unbounded firehose.
  const included = new Set();
  if (!errored) {
    let remaining = Number.isFinite(budget) ? Math.max(0, budget) : DEFAULT_TRANSCRIPT_BUDGET;
    const seen = new Set();
    const byRecency = list
      .filter((r) => r?.attachment_id && map.has(r.attachment_id))
      .sort((a, b) => String(b?.created_at || '').localeCompare(String(a?.created_at || '')));
    for (const r of byRecency) {
      const id = r.attachment_id;
      if (seen.has(id)) continue;
      seen.add(id);
      const cost = budgetCost(map.get(id));
      if (cost === 0) { included.add(id); continue; }   // short honest line — never budgeted out
      if (cost <= remaining) { remaining -= cost; included.add(id); } // else: pointer
    }
  }

  const contentOf = (row) => {
    const c = row?.content;
    return contentLimit > 0 ? String(c || '').slice(0, contentLimit) : c;
  };

  return (row) => {
    const id = row?.attachment_id;
    if (!id) return null;
    if (errored) return attachmentContextLine(null, { content: contentOf(row) });
    const att = map.get(id) || null;
    // Has stored text but the budget was spent on more-recent attachments → pointer.
    if (att && !included.has(id) && derivedText(att)) return attachmentPointerLine(att);
    return attachmentContextLine(att, { content: contentOf(row) });
  };
}

/**
 * Convenience: return the rows with the attachment line appended to `content`.
 * Used by the history-hydration call sites, which hand {role, content} pairs to
 * the model. Callers that clamp `content` themselves (getContext) use
 * attachmentLineResolver directly so the clamp never truncates the transcript.
 */
export async function withAttachmentContext(rows, { db, userId, budget = DEFAULT_TRANSCRIPT_BUDGET }) {
  const lineFor = await attachmentLineResolver(rows, { db, userId, budget });
  return (rows || []).map((r) => {
    const line = lineFor(r);
    if (!line) return r;
    return { ...r, content: r.content ? `${r.content}\n${line}` : line };
  });
}

export default withAttachmentContext;
