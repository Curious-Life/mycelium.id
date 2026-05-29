/**
 * Document content size budget.
 *
 * `documents.content` (and `summary`, `title`, etc.) are in
 * ENCRYPTED_FIELDS — Swiss Vault wraps them in AES-256-GCM and stores
 * the base64 envelope in D1. The size budget is therefore:
 *
 *   plaintext bytes
 *     + ~28 B AES-GCM overhead (12 B IV + 16 B auth tag)
 *     + JSON envelope wrapper (~80 B)
 *     × 4/3   (base64 expansion)
 *     = at-rest bytes in the D1 row
 *
 * D1 caps a single row at 1 MB. Other encrypted columns on the same
 * row (title, summary, tags, entities, metadata, ...) consume budget
 * too. 750 KB plaintext content yields ~1.0 MB at rest, leaving
 * ~50–100 KB headroom for everything else — tight but workable for
 * typical inputs and far more than the legacy 50 KB cap allowed.
 *
 * Inputs above the limit are truncated at a UTF-8 codepoint boundary
 * with a clear marker appended, so an agent reading the row knows it
 * was clipped (rather than silently reasoning over a partial doc).
 * The full file remains in R2 via attachments.r2_key — content is
 * the agent-readable cache, not the canonical store.
 *
 * Multi-hour conversation transcripts at typical word density:
 *   1 h podcast        ≈   60 KB (well within budget)
 *   3 h conversation   ≈  220 KB (well within budget)
 *   8 h day-recording  ≈  600 KB (within budget)
 *  12 h+               ≈ 900 KB+ (truncated with marker)
 */

export const MAX_DOCUMENT_CONTENT_BYTES = 750_000;
export const MAX_DOCUMENT_SUMMARY_BYTES = 4_000;
export const DOCUMENT_TRUNCATION_MARKER = '\n\n[content truncated — full file available in attachments]';

/**
 * Clamp content to MAX_DOCUMENT_CONTENT_BYTES at a UTF-8 codepoint
 * boundary, appending a marker if anything was clipped. Returns the
 * input verbatim when within budget. Non-string inputs pass through
 * unchanged so callers can pre-stringify other types without us
 * second-guessing.
 */
export function clampDocumentContent(content) {
  if (typeof content !== 'string') return content;
  const byteLen = Buffer.byteLength(content, 'utf8');
  if (byteLen <= MAX_DOCUMENT_CONTENT_BYTES) return content;

  const markerBytes = Buffer.byteLength(DOCUMENT_TRUNCATION_MARKER, 'utf8');
  const budget = MAX_DOCUMENT_CONTENT_BYTES - markerBytes;
  const buf = Buffer.from(content, 'utf8').slice(0, budget);
  // toString may emit U+FFFD if we clipped mid-codepoint; trim trailing
  // replacement chars so the marker reads cleanly.
  const safe = buf.toString('utf8').replace(/[�]+$/, '');
  return safe + DOCUMENT_TRUNCATION_MARKER;
}

/**
 * Clamp the summary string. Summary is a short preview, no truncation
 * marker — the library UI is the only consumer and it expects a
 * complete-feeling sentence rather than a "[truncated]" tail.
 */
export function clampDocumentSummary(summary) {
  if (typeof summary !== 'string') return summary;
  const byteLen = Buffer.byteLength(summary, 'utf8');
  if (byteLen <= MAX_DOCUMENT_SUMMARY_BYTES) return summary;
  const buf = Buffer.from(summary, 'utf8').slice(0, MAX_DOCUMENT_SUMMARY_BYTES);
  return buf.toString('utf8').replace(/[�]+$/, '');
}
