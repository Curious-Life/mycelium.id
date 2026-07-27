// src/enrich/derived-text.js — what happens to a MESSAGE when its attachment's
// DERIVED TEXT (voice transcript, image caption, extracted document text) lands.
//
// Two halves of one rule, kept in one file because they are only correct together:
//   1. embedTextOf(row)      — the text the embed drain actually vectorises: the
//                              message body PLUS its attachment's derived text.
//   2. markMessagesForReembed — when that derived text arrives AFTER the message was
//                              already embedded, put the message back in the embed queue.
//
// ════════════════════════════════════════════════════════════════════════════════
//  THE DEFECT (2026-07-26): a transcript that arrives late is never embedded
// ════════════════════════════════════════════════════════════════════════════════
// `messages.embedding_768` was computed by the enrich drain from `messages.content`
// ALONE. On the IMPORT path that content is just "File: memo.ogg" — the transcript is
// written LATER, onto `attachments.transcript`, by transcribe-attachment.js (portal
// Transcribe button · import's fire-and-forget call · the background retry drain).
// Nothing touched the message row, so:
//   • the words the person SPOKE were BM25-searchable (the keyword index reads the
//     attachment's text), and
//   • they were NOT semantically searchable — the message's vector still described
//     the string "File: memo.ogg".
// RRF fusion still surfaced the keyword hit, so this was a QUALITY GAP, not an outage:
// a voice note was findable by exact words and invisible to a paraphrase.
//
// ⚠️ BOTH HALVES ARE LOAD-BEARING. Marking a message for re-embed while the drain
// still reads `content` alone would recompute the SAME vector from the SAME
// "File: memo.ogg" — pure compute burned for no change. Composing the text without
// marking would only help messages that had not been embedded yet. Do not land one
// without the other.
//
// SECURITY: transcript/description are user content, decrypted by the db adapter on
// the existing read path. Nothing here is ever logged (CLAUDE.md §1) — the marker
// helper logs a COUNT and an attachment id, never a character of derived text.

// ── RELATIONSHIP TO THE BM25 SIDE (#403, landed 2026-07-27) ─────────────────────
// `src/search/d1-loader.js` composes the SAME three fields for the KEYWORD index, with its
// own `textFrom: [content, transcript, description].filter(Boolean).join(' ')`. The two are
// deliberately NOT shared, and the difference is one line each:
//   • this one de-duplicates on full containment and joins with '\n' — a duplicated
//     transcript SKEWS a vector toward those sentences, which is a retrieval defect.
//   • that one keeps duplicates and joins with ' ' — in BM25 a repeated term only nudges
//     term frequency, and the loader has no message-body containment to check against.
// They agree on WHAT is indexed, which is the property that matters; unifying them would
// impose one index's tuning on the other. If you change which FIELDS either reads, change
// both — a message that is keyword-findable but not semantically findable (or vice versa)
// is the exact asymmetry this whole change exists to remove.
//
// ⚠️ KNOWN RESIDUAL, recorded rather than half-fixed: #403 WIDENED the corpus predicate so a
// message with EMPTY content but a transcript is still indexed for BM25.
// `selectPendingEnrichment` still requires non-empty `content`, so such a row is never
// selected for embedding — keyword-findable, not semantically findable. Deliberately not
// widened here: the drain predicate is mirrored EXACTLY by three backlog counters
// (`_computeEmbedBacklog`, `_computeCategoriesBacklog`, `_computeNlpBacklog`), and a drain
// predicate that disagrees with its pending count is this codebase's documented
// stuck-forever bug class (gate: verify:enrich-backlog-parity). Widening is a four-site
// change with its own gate work, not a clause to slip in.

/**
 * Does `content` already carry `text` in full?
 *
 * ⚠️ NORMALISED, and that is the whole point — a raw `content.includes(t)` was NOT the rule it
 * claimed to be. The channel path builds the body by folding a RENDERED transcript line into
 * `msg.content` (attachment-context.js `attachmentContextLine`), which re-wraps and clamps, so
 * the stored body routinely differs from `attachments.transcript` by whitespace or case alone.
 * A raw test misses that and embeds the same sentences twice, skewing the vector toward them —
 * the exact defect the check exists to prevent. Byte-identical containment (which is all the
 * first version caught, and all its fixture exercised) is the rare case, not the common one.
 *
 * Deliberately the SAME predicate as `alreadyCarries` in src/agent/attachment-context.js: both
 * answer "has this text already reached the consumer through the message body?", and two
 * subtly-different answers to one question is how they drift. The ≥8-char floor is theirs too —
 * below it, containment is coincidence rather than evidence.
 */
function alreadyCarries(content, text) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const t = norm(text);
  if (t.length < 8) return false;
  return norm(content).includes(t);
}

/**
 * The text the embed drain vectorises for one pending row: the message body,
 * followed by whatever derived text its attachment carries.
 *
 * ⚠️ DE-DUPLICATED ON FULL CONTAINMENT, and that is not a nicety. The CHANNEL path
 * already folds the transcript into `msg.content` at capture time (channel-daemon
 * inbound.js `msg.content += contextLine`), so a live voice note's body ALREADY
 * carries the transcript. Appending it again would embed the same sentences twice
 * and skew the vector toward them. Only FULL containment suppresses — a partial
 * overlap (the 500-char content slice the channel path stores) still appends, so a
 * long transcript's tail is never lost. Same rule as the agent-facing seam's
 * `alreadyCarries` (src/agent/attachment-context.js, gate T11b).
 *
 * NO CLAMP HERE, deliberately. `clampStored` already bounds what is PERSISTED (a
 * 200k DoS ceiling), and the embed service bounds what it TOKENISES (MAX_CHARS
 * 40000, pipeline/embed-service.py) — content comes first in this concatenation, so
 * a pathological transcript can never push the message's own words out of the
 * window. A third clamp here would be a budget masquerading as persistence, the
 * exact conflation text-limits.js exists to prevent.
 *
 * @param {{content?: string|null, attachment_transcript?: string|null, attachment_description?: string|null}} row
 *   as returned by messages.selectPendingEnrichment (which LEFT JOINs the attachment).
 * @returns {string}
 */
export function embedTextOf(row) {
  const content = String(row?.content ?? '');
  // A whitespace-only body contributes NOTHING — so a row whose only real text is its
  // transcript embeds the transcript, while a row with neither still resolves to '' and
  // takes the drain's unchanged blank-skip path (nlp_processed = 1, terminal).
  const parts = content.trim() ? [content] : [];
  // transcript first, then description: an attachment carries at most one of them in
  // practice (audio → transcript, image/pdf → description), so the order is only a
  // tie-break for the pathological both-set row.
  for (const derived of [row?.attachment_transcript, row?.attachment_description]) {
    const t = String(derived ?? '').trim();
    if (!t) continue;
    if (alreadyCarries(content, t)) continue;   // FULL containment only — see above
    parts.push(t);
  }
  return parts.join('\n');
}

/**
 * A derived-text write completed for `attachmentId` — put every ALREADY-EMBEDDED
 * message that owns it back in the embed queue, so the drain recomputes
 * `embedding_768` over content + the new derived text.
 *
 * BEST-EFFORT AND NEVER THROWS. Every call site is a transcription/description write
 * that has ALREADY SUCCEEDED and already returned its own result; a failure to
 * re-queue must never turn a successful transcription into an error. The cost of a
 * miss is the pre-existing quality gap, not data loss.
 *
 * ⚠️ NOT COMPUTE-GOVERNED, and it must stay that way. This is one indexed UPDATE —
 * no model, no memory, nothing to serialize (D-001). Taking a governor ticket here
 * would be worse than useless: `transcribe-attachment.js` calls this while still
 * HOLDING its own transcribe ticket, so asking for a second one on the same path is
 * how a self-deadlock gets written.
 *
 * @param {{messages?: {markForReembed?: Function}}} db
 * @param {string} userId
 * @param {string} attachmentId
 * @param {{log?: (m: string) => void}} [opts]
 * @returns {Promise<number>} messages re-queued (0 is the normal, healthy answer)
 */
export async function markMessagesForReembed(db, userId, attachmentId, { log = null } = {}) {
  try {
    if (!db?.messages?.markForReembed || !userId || !attachmentId) return 0;
    const n = await db.messages.markForReembed(userId, String(attachmentId));
    // Count + opaque id only — never the derived text, never the message body (§1).
    if (n > 0 && typeof log === 'function') log(`[enrich] derived text arrived for ${attachmentId} — ${n} message(s) re-queued for embedding`);
    return n;
  } catch {
    return 0;   // see BEST-EFFORT above
  }
}

export default embedTextOf;
