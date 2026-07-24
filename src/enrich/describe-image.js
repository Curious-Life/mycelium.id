// src/enrich/describe-image.js — best-effort, fail-soft image captioning.
//
// Turns an uploaded image into a short text caption so it can be embedded by the
// existing TEXT pipeline (Nomic 768-d) and join the mindscape like any message.
// The only local LLM is Ollama (src/inference/local.js); captioning needs a
// VISION model (llava / llama3.2-vision / moondream / …), which the user may or
// may not have pulled — and Ollama may not be running at all.
//
// Design principle (matches the generate-robustness work): NEVER hang, NEVER
// throw to the caller. If no vision model is reachable, return null and let the
// upload path fall back to the filename. Bytes go to 127.0.0.1 only (on-box) and
// are never logged (CLAUDE.md §1 — the image is user plaintext).

import { localInfer, DEFAULT_OLLAMA_URL } from "../inference/local.js";
import { admit, withTicket, CLASS } from "../core/compute-governor.js";
import { pickModelWithCapability } from "./model-caps.js";
import { CAPTION_MAX_CHARS } from "./text-limits.js";

// Known multimodal Ollama tags, best-first. Override with MYCELIUM_VISION_MODEL.
const VISION_CANDIDATES = [
  "llama3.2-vision",
  "llava",
  "llava-llama3",
  "llava-phi3",
  "moondream",
  "bakllava",
  "minicpm-v",
  "qwen2.5vl",
  "qwen2-vl",
];

const CAPTION_PROMPT =
  "Describe this image in 1–3 plain sentences for search and topical clustering. " +
  "Note the main subject, any legible text, and notable details. Be concise and factual; " +
  "do not start with \"This image\".";

/**
 * Probe Ollama for a usable vision model. Returns a model tag or null.
 * Fast + fail-soft: a missing/old Ollama (no /api/tags, connection refused) → null.
 *
 * Order: env override → capabilities probe (/api/show, catches gemma4-class
 * models the name list can't know about) → legacy name-list match (covers old
 * Ollama builds whose /api/show has no `capabilities` field).
 */
export async function pickVisionModel({
  baseUrl = process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL,   // follows an ollama-daemon alt-port self-heal (loopback)
  fetch = globalThis.fetch,
  timeoutMs = 2500,
  prefer,
} = {}) {
  const override = process.env.MYCELIUM_VISION_MODEL;
  if (override) return override;
  if (typeof fetch !== "function") return null;

  const byCapability = await pickModelWithCapability("vision", { prefer, baseUrl, fetch, timeoutMs });
  if (byCapability) return byCapability;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/tags`, { signal: controller.signal });
    if (!res || !res.ok) return null;
    const data = await res.json().catch(() => null);
    const names = Array.isArray(data?.models) ? data.models.map((m) => m?.name || m?.model || "") : [];
    if (!names.length) return null;
    // Exact/prefix match against the known-vision list first…
    for (const cand of VISION_CANDIDATES) {
      const hit = names.find((n) => n === cand || n.startsWith(`${cand}:`) || n.startsWith(cand));
      if (hit) return hit;
    }
    // …then anything whose tag clearly signals vision.
    const visionish = names.find((n) => /llava|vision|moondream|bakllava|minicpm-v|vl\b/i.test(n));
    return visionish || null;
  } catch {
    return null; // unreachable / aborted — caller falls back to the filename
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Caption an image. Returns a trimmed caption string, or null if no vision model
 * is available or inference failed (the caller embeds the filename instead).
 *
 * @param {object} opts
 * @param {string} [opts.base64]   the image bytes, base64 (no data: prefix)
 * @param {Buffer} [opts.bytes]    alternative to base64
 * @param {string} [opts.model]    force a model (else probe / MYCELIUM_VISION_MODEL)
 * @param {string} [opts.baseUrl]
 * @param {typeof fetch} [opts.fetch]
 * @param {number} [opts.timeoutMs=30000]
 * @returns {Promise<string|null>}
 */
export async function describeImage({
  base64,
  bytes,
  model,
  baseUrl = process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL,   // follows an ollama-daemon alt-port self-heal (loopback)
  fetch = globalThis.fetch,
  timeoutMs = Number(process.env.MYCELIUM_VISION_TIMEOUT_MS) || 30000,
} = {}) {
  const b64 = base64 || (Buffer.isBuffer(bytes) ? bytes.toString("base64") : null);
  if (!b64) return null;

  const chosen = model || (await pickVisionModel({ baseUrl, fetch }));
  if (!chosen) return null; // no vision model → graceful fallback

  // COMPUTE GOVERNOR (D-001, L16 / P7 — the operator's ACTUAL import run): a vision model is a
  // THIRD resident model, loaded INLINE per image during import while embed + categorize also run.
  // That concurrency is a documented crash path (design §2 P7, "the most dangerous" §1). Vision is a
  // RESIDENT lane. If the model slot is busy, REJECT this caption (design §3.3): return null so the
  // caller embeds the FILENAME instead — the graceful fallback this function already documents —
  // rather than loading a second/third model and crashing the box. The image is not lost: it is
  // still embedded (by filename) and can be re-captioned once the slot is free. NEVER block/hang.
  const adm = admit({ lane: 'vision-caption', klass: CLASS.RESIDENT, timeoutMs: Math.max(timeoutMs * 2, 60000) });
  if (!adm.ok) return null; // model slot busy → filename fallback (P7/§3.3 REJECT), never a 3rd concurrent model

  // withTicket records the held ticket in AsyncLocalStorage so the §3.4 hold-and-wait guard is
  // ACTIVE for this lane (defense in depth) — a nested admit of another class inside the caption
  // would throw rather than deadlock. This is also the reference wiring of withTicket.
  try {
    return await withTicket(adm, async () => {
      const text = await localInfer({
        prompt: CAPTION_PROMPT,
        images: [b64],
        model: chosen,
        baseUrl,
        fetch,
        timeoutMs,
        maxTokens: 220,
        // Thinking models (gemma4-class) spend the whole token budget on hidden
        // reasoning on /api/generate → empty response. We want the caption.
        think: false,
      });
      const caption = String(text || "").trim().replace(/\s+/g, " ");
      return caption.length ? caption.slice(0, CAPTION_MAX_CHARS) : null; // was a silent 600-char cut
    });
  } catch {
    return null; // timeout / model error → fall back, never block the upload
  } finally {
    adm.release(); // crash-release #1 (finally) — always free the model slot
  }
}

export default describeImage;
