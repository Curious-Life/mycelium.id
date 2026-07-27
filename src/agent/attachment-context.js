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

// text-limits.js is pure constants + one pure function (no I/O, no express) — safe for the
// stdio MCP tool path that imports this module. transcript-coverage.js is likewise pure
// parsing (readCoverage NEVER throws; malformed metadata reads as "no coverage recorded").
import { DERIVED_TEXT_MAX_CHARS } from '../enrich/text-limits.js';
import { readCoverage } from '../enrich/transcript-coverage.js';

// ════════════════════════════════════════════════════════════════════════════════════════
//  A PARTIAL TRANSCRIPT MUST NOT READ AS A COMPLETE ONE (D-076, #386 — added 2026-07-26)
// ════════════════════════════════════════════════════════════════════════════════════════
// #386 exists because "a partial transcript had NO representation, so it read as complete":
// a 30-minute recording transcribed part-way and the system recorded it as finished. The fix
// was a REPRESENTATION — `attachments.metadata.transcription` coverage, where `complete` is an
// assertion that must be EARNED and an unearned row stays eligible for resume.
//
// That honesty layer stopped at the DB. This module renders the stored transcript to the AGENT,
// and rendering a half-transcribed recording as bare text re-creates the same lie one layer up —
// worse now that the text is no longer clamped, because there is no truncation marker left to
// hint that anything is missing. So when coverage says INCOMPLETE we still show the full text
// (the operator's call: no rationing) and we PREFIX what the text actually covers.
//
// Absence of coverage is NOT incompleteness: legacy rows predate the marker and carry good
// transcripts. `incomplete && !complete` mirrors both isCoverageIncomplete() and the SQL drain
// predicate, so a legacy row renders exactly as before.
//
// §1: numbers and booleans only — seconds, counts, a gap count. Never a fault string (which can
// carry a service error), never an excerpt, never a filename beyond the one already rendered.
const dur = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};

/** Honest coverage prefix for a transcript, or '' when the row is complete/legacy. */
function coverageNote(att) {
  const c = readCoverage(att?.metadata);
  // Null-safe throughout, not just at the guard: this predicate is the ONE thing standing
  // between "legacy row with a good transcript" and "every pre-#386 transcript smeared as
  // partial", so it must stay legible and total rather than depending on an early return to
  // protect the reads below it.
  if (!c?.incomplete || c?.complete) return '';
  const of = c?.durationSec > 0 ? ` of ${dur(c.durationSec)}` : '';
  const covered = c?.coveredSec > 0 ? `covers ${dur(c.coveredSec)}${of}` : 'is partial';
  const gaps = c?.gaps?.length ? `, with ${c.gaps.length} un-transcribed gap${c.gaps.length > 1 ? 's' : ''} inside it` : '';
  return ` — INCOMPLETE: transcription was interrupted and this text ${covered}${gaps}; the recording continues past it and a resume is pending, so treat silence past the end as MISSING, not as nothing said`;
}

// ════════════════════════════════════════════════════════════════════════════════════════
//  FULL CONTENT — DoS CEILINGS ONLY (operator decision 2026-07-26; supersedes the 4000-char
//  per-message clamp and the tiered 6000/8000/24000 aggregate rationing)
// ════════════════════════════════════════════════════════════════════════════════════════
// D-076 made long-audio transcription actually COMPLETE (chunk + stitch), so a 30-minute
// recording now yields a ~27,000-char transcript. Under the old clamp the model read 4,000
// of them — ~15% of the recording — and the remainder was reachable only through a pointer
// line that named a retrieval route WHICH DOES NOT EXIST. No MCP tool reads
// attachments.transcript: the whole tool surface touches attachments in exactly three files
// (tools/context.js + tools/messages.js — this join — and tools/ingest.js, which only WRITES
// attachment_id). Transcripts are deliberately not Library documents (internal-router.js:505
// — "a single canonical Library presence"), so getDocument/findDocuments cannot reach one,
// and db/search.js indexes territory_profiles/realms/semantic_themes, not attachments. A
// budget whose overflow path is a dead end is not a budget; it is a silent cap with a note.
//
// The rationing was also sized against the WRONG number: LOCAL_DEFAULT's 8192-token window
// (model-profile.js:38) is only the FLOOR used when the Ollama probe fails. Real windows are
// 40k-200k (model-registry.js) and a successful probe replaces the default with the model's
// true contextLength. A 30-minute transcript is ~6,750 tokens — 3% of a 200k window.
//
// So: show the full transcript. What remains is a DoS ceiling in the exact sense
// text-limits.js means it — "far above any real content so we never silently lose a user's
// data" — and never a model-context budget.
//
// ⚠️ THE CONSEQUENCE THIS TRADES FOR, STATED PLAINLY: on a SMALL-window model (the unprobed
// 8192 floor, or gemma2/qwen3.5 at 8192) a full transcript can push the assembled system
// prompt past inputBudget, and run-turn.js:233 trims the prompt by TAIL truncation — so the
// sections getContext appends AFTER RECENT MESSAGES are what a small window now loses. That
// is a deliberate trade (full content beats rationed content), not an oversight.

/** Per-message DoS ceiling — NOT a content limit. Set to the PERSISTENCE ceiling, which
 *  every transcript write already passes through (clampStored: transcribe-audio.js:92/175/180,
 *  transcribe-attachment.js:212/218, portal-attachments.js:209). Nothing that reaches this
 *  module can exceed it, so the clamp below PROVABLY never fires and the message renders its
 *  full transcript. Kept as a ceiling rather than deleted so a future write path that forgets
 *  clampStored still cannot put an unbounded string in front of a model. */
export const MAX_ATTACHMENT_TEXT = DERIVED_TEXT_MAX_CHARS;

// AGGREGATE DoS ceiling. One transcript is bounded above; a BATCH still needs a total,
// because 40 messages × the 200k persistence ceiling is ~8MB of string assembled in memory
// and handed to a model — a decompression-bomb shape, not a briefing. 1,000,000 chars
// ≈ 250k tokens, above EVERY context window in model-registry.js except gpt-4.1's, so no
// real batch reaches it; a pathological one degrades to POINTER lines, never silence.
//
// The three per-surface tiers are RETIRED — they WERE the rationing. The names are kept so
// the four call sites (tools/context.js:205, agent/channel-turn.js:154, portal-chat.js:559,
// tools/messages.js:87) read unchanged, and so the seam stays threaded if a future decision
// re-introduces genuine per-surface budgets.
export const TRANSCRIPT_DOS_CEILING = 1_000_000;
export const TRANSCRIPT_BUDGET_BRIEFING = TRANSCRIPT_DOS_CEILING;
export const TRANSCRIPT_BUDGET_HISTORY = TRANSCRIPT_DOS_CEILING;
export const TRANSCRIPT_BUDGET_DAILY = TRANSCRIPT_DOS_CEILING;
export const DEFAULT_TRANSCRIPT_BUDGET = TRANSCRIPT_DOS_CEILING;

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

// Unreachable in practice (see MAX_ATTACHMENT_TEXT — persistence clamps at the same value).
// The marker is SELF-DESCRIBING so that if it ever does fire, it reads unmistakably as the
// ceiling rather than as a content decision — the same discipline as clampStored's marker.
const clamp = (s) => {
  const t = String(s).trim();
  return t.length > MAX_ATTACHMENT_TEXT
    ? `${t.slice(0, MAX_ATTACHMENT_TEXT)}\n[… truncated at ${MAX_ATTACHMENT_TEXT} chars — DoS ceiling, not a content limit]`
    : t;
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

/** The 4th honest state: derived text EXISTS but was left out because the batch hit the
 *  aggregate DoS ceiling (pathological only — see TRANSCRIPT_DOS_CEILING). A pointer, never
 *  silence.
 *
 *  WORDING (fixed with the 2026-07-26 decision): this line used to end "ask me to read it",
 *  which named a retrieval path that does not exist — there is NO tool that reads
 *  attachments.transcript, so an agent that followed the instruction had nowhere to go, and
 *  the "me" contradicted the sibling pending line's voice ("you" = agent, "them" = human).
 *  It now points at Media, which is the only route that actually exists today. */
export function attachmentPointerLine(att) {
  const kind = attachmentKindOf(att.file_type);
  const label = KIND_LABEL[kind] || 'File';
  const name = att.file_name ? `: ${att.file_name}` : '';
  const noun = (kind === 'voice' || kind === 'video') ? 'transcript' : 'text';
  const chars = derivedText(att).length.toLocaleString('en-US');
  // Carry the incompleteness into the pointer too — "transcript stored (N chars)" would
  // otherwise read as a complete recording that merely wasn't inlined.
  const note = coverageNote(att);
  return `[${label}${name}${note ? ` (${note.replace(/^ — /, '')})` : ''} — ${noun} stored (${chars} chars), not included here: this batch hit the aggregate size ceiling. You can ask them to open it in Media.]`;
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
      // The coverage note rides OUTSIDE the dedup check: a channel-inbound message that already
      // folded the transcript into content still needs to be told the text is partial, so the
      // note is what makes this line worth emitting even when the words themselves are a dup.
      const note = coverageNote(att);
      if (alreadyCarries(content, transcript)) {
        return note ? `[${head}${note}]` : null;
      }
      return `[${head}${note} — transcript: "${clamp(transcript)}"]`;
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
 * AGGREGATE DoS CEILING: `budget` chars of derived text are spent across the batch
 * MOST-RECENT-FIRST (created_at desc — NOT array order: selectRecent hands rows
 * newest-first but selectPaginated/selectByConversation hand them oldest-first, so
 * we sort by real recency). At the ceiling's real value every transcript in any realistic
 * batch renders IN FULL; the spend loop exists so that a pathological batch (a bomb, not a
 * briefing) degrades to POINTER lines rather than silence — and so it degrades the OLDEST
 * first, never the message the human just sent.
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
