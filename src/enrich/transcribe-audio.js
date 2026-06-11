// src/enrich/transcribe-audio.js — best-effort, fail-soft LOCAL audio transcription.
//
// Turns a voice note / audio file into text so it can be embedded by the TEXT
// pipeline and read by the channel agent — entirely on-box (no Whisper, no
// cloud). SPIKE-VERIFIED 2026-06-10: Ollama's NATIVE /api/chat silently ignores
// audio fields; the working shape is the OpenAI-compatible endpoint
// /v1/chat/completions with an `input_audio` content part. gemma4:12b
// (capabilities: [...,'audio',...]) transcribed real speech this way.
//
// Same discipline as describe-image.js: NEVER hang, NEVER throw — no
// audio-capable model / Ollama down / decode failure → null, the caller falls
// back to a placeholder. Bytes go to 127.0.0.1 only and are never logged.

import { DEFAULT_OLLAMA_URL } from "../inference/local.js";
import { pickModelWithCapability } from "./model-caps.js";
import { getTranscriberHealth, transcribeServiceUrl } from "../transcribe/supervisor.js";

const TRANSCRIBE_PROMPT =
  "Transcribe this audio exactly, word for word. Output ONLY the transcription " +
  "text — no preamble, no quotes, no commentary. If the audio is empty or " +
  "unintelligible, output nothing.";

/** Map a mime type / filename to the OpenAI input_audio `format` field. */
export function audioFormatFor(mimeType, fileName = "") {
  const m = String(mimeType || "").toLowerCase();
  const n = String(fileName || "").toLowerCase();
  if (m.includes("ogg") || m.includes("opus") || n.endsWith(".ogg") || n.endsWith(".opus")) return "ogg";
  if (m.includes("mpeg") || m.includes("mp3") || n.endsWith(".mp3")) return "mp3";
  if (m.includes("wav") || n.endsWith(".wav")) return "wav";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac") || n.endsWith(".m4a")) return "m4a";
  if (m.includes("webm") || n.endsWith(".webm")) return "webm";
  if (m.includes("flac") || n.endsWith(".flac")) return "flac";
  return "wav"; // benign default — the decoder rejects what it can't read and we fail soft
}

/**
 * Transcribe audio bytes via a local audio-capable model. Returns the
 * transcription string, or null when no model is available / decode failed.
 *
 * @param {object} opts
 * @param {Buffer} [opts.bytes]      raw audio bytes
 * @param {string} [opts.base64]     alternative to bytes (no data: prefix)
 * @param {string} [opts.mimeType]
 * @param {string} [opts.fileName]
 * @param {string} [opts.model]      force a model (else capabilities probe)
 * @param {string} [opts.prefer]     prefer this model when it qualifies (active provider)
 * @param {string} [opts.baseUrl]
 * @param {typeof fetch} [opts.fetch]
 * @param {number} [opts.timeoutMs]  whole-call budget (cold model + decode + generate)
 * @returns {Promise<string|null>}
 */
export async function transcribeAudio({
  bytes,
  base64,
  mimeType,
  fileName,
  model,
  prefer,
  baseUrl = DEFAULT_OLLAMA_URL,
  fetch: fetchImpl = globalThis.fetch,
  // 300s: a ~7s voice note on a 12B model took >180s live (2026-06-10) — the
  // same cold-model lesson as the channel turn's CHANNEL_OLLAMA_TIMEOUT_MS.
  timeoutMs = Number(process.env.MYCELIUM_TRANSCRIBE_TIMEOUT_MS) || 300000,
} = {}) {
  let buf = Buffer.isBuffer(bytes) ? bytes : (base64 ? Buffer.from(base64, "base64") : null);
  if (!buf || typeof fetchImpl !== "function") return null;

  // llama.cpp's audio loader rejects Ogg containers outright (live-verified
  // 2026-06-10) and Telegram voice notes are always OGG/Opus — transcode to
  // WAV in-process (pure JS, src/enrich/ogg-opus.js). Fail-soft: if the
  // transcode returns null we still try the original bytes (a future decoder
  // may accept them) and otherwise fall back via the normal null path.
  let format = audioFormatFor(mimeType, fileName);
  if (format === "ogg") {
    const { oggOpusToWav } = await import("./ogg-opus.js");
    const wav = await oggOpusToWav(buf);
    if (wav) { buf = wav; format = "wav"; }
  }

  // PREFERENCE 1 — the dedicated Whisper service, when the user set it up
  // (docs/WHISPER-TRANSCRIPTION-DESIGN-2026-06-11.md). ~100x faster than the
  // LLM path (1.8s vs >180s live, 2026-06-11) and independent of the chat
  // model. Only WAV reaches it (Telegram voice is transcoded above); other
  // formats fall through to the LLM path which decodes them natively.
  if (format === "wav" && getTranscriberHealth().status === "ok") {
    const text = await transcribeViaWhisper({ buf, fetch: fetchImpl });
    if (text) return text;
    // fall through — whisper hiccup must never lose a voice note
  }
  const b64 = buf.toString("base64");

  const chosen = model
    || process.env.MYCELIUM_AUDIO_MODEL
    || (await pickModelWithCapability("audio", { prefer, baseUrl, fetch: fetchImpl }));
  if (!chosen) return null; // no audio-capable model → graceful fallback

  const base = String(baseUrl || "").replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: chosen,
        stream: false,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: TRANSCRIBE_PROMPT },
            { type: "input_audio", input_audio: { data: b64, format } },
          ],
        }],
      }),
      signal: controller.signal,
    });
    if (!res || !res.ok) return null;
    const data = await res.json().catch(() => null);
    const text = String(data?.choices?.[0]?.message?.content || "").trim();
    return text.length ? text.slice(0, 8000) : null;
  } catch {
    return null; // timeout / decode error / model error → caller falls back
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST the WAV to the local Whisper service. Same NEVER-throw contract:
 * any failure → null → the caller's LLM fallback runs.
 * @param {{buf: Buffer, fetch: typeof fetch, timeoutMs?: number}} a
 */
async function transcribeViaWhisper({ buf, fetch: fetchImpl, timeoutMs = Number(process.env.MYCELIUM_WHISPER_TIMEOUT_MS) || 120000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${transcribeServiceUrl()}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: buf,
      signal: controller.signal,
    });
    if (!res || !res.ok) return null;
    const data = await res.json().catch(() => null);
    const text = String(data?.text || "").trim();
    return text.length ? text.slice(0, 8000) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default transcribeAudio;

