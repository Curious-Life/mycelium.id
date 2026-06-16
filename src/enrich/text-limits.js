// src/enrich/text-limits.js — ONE source of truth for how much DERIVED text we
// PERSIST from a user's own content: document extraction (pdf/docx), text-file
// decode, audio transcript, image caption. The captured message body, the
// Library document, and attachments.{description,transcript} all flow from here.
//
// These are DoS CEILINGS, not content limits. They sit far above any real
// content so we never silently lose a user's data. The bug they replace: a
// 6000-char clamp ([… truncated]) that conflated a *model-context budget* with
// *persistence* and permanently truncated stored documents. Persistence ≠ budget:
//   - budget belongs at READ time, where text is folded into a single model turn
//     (context assembly already previews at ~500 chars).
//   - persistence stores the FULL value; the embedder already chunks up to
//     ~8192 tokens (pipeline/embed-service.py), and the raw bytes are kept in
//     blob-store regardless, so nothing here should ever cut real content.

// ~50k tokens / ~130 pages — a generous guard against a decompression bomb or a
// pathological multi-MB paste, NOT a limit any genuine document hits.
export const DERIVED_TEXT_MAX_CHARS = Number(process.env.MYCELIUM_DERIVED_TEXT_MAX_CHARS) || 200_000;

// Vision captions are inherently short model summaries; generous headroom so a
// detailed multi-sentence description is never clipped.
export const CAPTION_MAX_CHARS = Number(process.env.MYCELIUM_CAPTION_MAX_CHARS) || 8_000;

// The marker we appended for truncation, kept for backfill detection of OLD rows
// (the pre-fix 6000/8000/600 clamps used this exact suffix).
export const LEGACY_TRUNCATION_MARKER = '\n[… truncated]';

/**
 * Last-resort DoS clamp for stored DERIVED text. Returns the input untouched for
 * any real-world size; only a pathological payload is cut, and then with a
 * self-describing marker (so a hit is unmistakably the ceiling, never the bug).
 */
export function clampStored(text, max = DERIVED_TEXT_MAX_CHARS) {
  const t = String(text == null ? '' : text);
  return t.length > max ? `${t.slice(0, max)}\n[… truncated at ${max} chars — DoS ceiling, not a content limit]` : t;
}
