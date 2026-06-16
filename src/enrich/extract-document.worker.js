// src/enrich/extract-document.worker.js — the actual unpdf/mammoth parse, run
// in a throwaway worker_thread so the parent can HARD-KILL it.
//
// Why a worker and not Promise.race in the main worker: a decompression/XML
// bomb (a tiny ~10KB docx that mammoth unzips into GBs of XML) cannot be
// stopped by Promise.race — "the loser keeps running" and holds the memory for
// the full window, repeatable per upload. Here the parent runs us under
// `resourceLimits` (bounded heap → V8 OOMs us, parent survives) and
// `worker.terminate()` (synchronous hard stop on timeout). Either way the bomb
// dies; this thread owns the blast radius, the vault does not.
//
// Contract: NEVER throw across the boundary — every exit posts {text} (string
// or null). Bytes arrive by structured-clone copy in workerData and never leave
// this thread; nothing is logged.

import { workerData, parentPort } from "node:worker_threads";
import { clampStored } from "./text-limits.js";

const NUL = new RegExp(String.fromCharCode(0), "g");

// Store the FULL extracted text. The previous 6000-char clamp permanently
// truncated stored documents (it conflated a model-context budget with
// persistence). clampStored only guards against a pathological payload at a
// ~200k-char DoS ceiling — no real document is cut. See text-limits.js.
function clamp(text) {
  const t = String(text || "").replace(NUL, "").trim();
  if (!t) return null;
  return clampStored(t);
}

async function run() {
  const { kind, bytes } = workerData; // bytes: Uint8Array (Buffer cloned across)
  if (kind === "pdf") {
    const { extractText } = await import("unpdf");
    const { text } = await extractText(new Uint8Array(bytes), { mergePages: true });
    return clamp(text);
  }
  const mammoth = (await import("mammoth")).default ?? (await import("mammoth"));
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return clamp(value);
}

run()
  .then((text) => parentPort.postMessage({ text }))
  // corrupt / password-protected / not-really-a-pdf → null, fail-soft.
  .catch(() => parentPort.postMessage({ text: null }));
