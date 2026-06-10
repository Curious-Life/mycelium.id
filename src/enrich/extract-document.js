// src/enrich/extract-document.js — best-effort, fail-soft document text extraction.
//
// PDF via unpdf (pure-JS pdf.js build, no native deps) and DOCX via mammoth —
// the same pair the canonical attachments pipeline used, minus its LibreOffice
// shell-out (no child processes in the vault; .pages/.odt/.epub stay
// unextracted and fail soft). Deps are imported LAZILY so the vault boots even
// if an optional dep is missing.
//
// Same contract as describe-image/transcribe-audio: NEVER hang, NEVER throw —
// unparseable/encrypted/scanned documents → null and the caller falls back to
// a filename placeholder. Bytes never leave the process; nothing is logged.

const MAX_EXTRACT_CHARS = 6000; // matches the attachment-context inline clamp

function clamp(text) {
  const t = String(text || "").replace(/\u0000/g, "").trim();
  if (!t) return null;
  return t.length > MAX_EXTRACT_CHARS ? `${t.slice(0, MAX_EXTRACT_CHARS)}\n[… truncated]` : t;
}

/** Classify whether this file is an extractable document (pdf/docx). */
export function documentKindOf(mimeType, fileName = "") {
  const m = String(mimeType || "").toLowerCase();
  const n = String(fileName || "").toLowerCase();
  if (m === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || n.endsWith(".docx")) return "docx";
  return null;
}

/**
 * Extract plain text from a PDF or DOCX buffer. Returns clamped text or null.
 * @param {object} a
 * @param {Buffer} a.bytes
 * @param {string} [a.mimeType]
 * @param {string} [a.fileName]
 * @param {number} [a.timeoutMs=30000]  parse budget (a hostile PDF must not hang the vault)
 * @returns {Promise<string|null>}
 */
export async function extractDocumentText({ bytes, mimeType, fileName, timeoutMs = 30000 }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return null;
  const kind = documentKindOf(mimeType, fileName);
  if (!kind) return null;

  const work = (async () => {
    if (kind === "pdf") {
      const { extractText } = await import("unpdf");
      const { text } = await extractText(new Uint8Array(bytes), { mergePages: true });
      return clamp(text);
    }
    const mammoth = (await import("mammoth")).default ?? (await import("mammoth"));
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    return clamp(value);
  })();

  // Promise.race timeout: the loser keeps running but the route moves on
  // fail-soft; unpdf/mammoth are pure JS with no handles to leak.
  const timeout = new Promise((resolve) => { setTimeout(() => resolve(null), timeoutMs).unref?.(); });
  try {
    return await Promise.race([work, timeout]);
  } catch {
    return null; // corrupt / password-protected / not-really-a-pdf → fall back
  }
}

export default extractDocumentText;
