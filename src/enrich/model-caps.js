// src/enrich/model-caps.js — capability-based local model selection.
//
// Ollama reports per-model `capabilities` (['completion','vision','audio',
// 'tools','thinking']) via POST /api/show. Name-list matching (the original
// pickVisionModel) goes stale the moment a new multimodal family ships —
// gemma4:12b does vision+audio but matches none of the llava/moondream
// patterns, so vision was silently dead on gemma-only machines (2026-06-10).
//
// Fail-soft like the rest of src/enrich: Ollama down / old Ollama without
// capabilities / no qualifying model → null, caller falls back. Results are
// cached per (baseUrl, capability) for the process lifetime — installs are
// rare and a re-boot re-probes.

import { DEFAULT_OLLAMA_URL } from "../inference/local.js";

const cache = new Map(); // `${baseUrl}|${capability}` → model tag | null

/** test seam */
export function _resetModelCapsCache() { cache.clear(); }

async function fetchJson(url, init, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!res || !res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pick an installed Ollama model that declares `capability`.
 *
 * Preference order:
 *   1. `prefer` (e.g. the user's ACTIVE provider model) when it qualifies —
 *      media understanding then runs on the same model the user already chose.
 *   2. First installed model (in /api/tags order) that declares the capability.
 *
 * @param {'vision'|'audio'} capability
 * @param {object} [opts]
 * @param {string} [opts.prefer]      model tag to prefer when it qualifies
 * @param {string} [opts.baseUrl]
 * @param {typeof fetch} [opts.fetch]
 * @param {number} [opts.timeoutMs=2500]  per HTTP call
 * @returns {Promise<string|null>}
 */
export async function pickModelWithCapability(capability, {
  prefer,
  baseUrl = DEFAULT_OLLAMA_URL,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 2500,
} = {}) {
  if (typeof fetchImpl !== "function") return null;
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const key = `${base}|${capability}|${prefer || ""}`;
  if (cache.has(key)) return cache.get(key);

  const pick = await (async () => {
    const tags = await fetchJson(`${base}/api/tags`, {}, fetchImpl, timeoutMs);
    const names = Array.isArray(tags?.models)
      ? tags.models.map((m) => m?.name || m?.model || "").filter(Boolean)
      : [];
    if (!names.length) return null;

    // Probe order: the preferred (active) model first, then install order.
    const ordered = prefer && names.includes(prefer)
      ? [prefer, ...names.filter((n) => n !== prefer)]
      : names;

    for (const name of ordered) {
      const show = await fetchJson(
        `${base}/api/show`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: name }) },
        fetchImpl, timeoutMs,
      );
      const caps = Array.isArray(show?.capabilities) ? show.capabilities : null;
      if (caps && caps.includes(capability)) return name;
      // caps === null → old Ollama without capabilities: keep probing others;
      // the caller's own fallback (name list / env override) covers this.
    }
    return null;
  })();

  // Cache POSITIVE picks only. A null here usually means Ollama was busy/down
  // during the probe (2.5s timeouts) — caching it would permanently disable
  // vision/audio for the process lifetime (live-bit 2026-06-11: the audio probe
  // ran while a vision call hogged Ollama, cached null, and every transcription
  // thereafter failed instantly).
  if (pick) cache.set(key, pick);
  return pick;
}

export default pickModelWithCapability;
