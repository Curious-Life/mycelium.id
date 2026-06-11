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

const MAX_EXTRACT_CHARS = 6000; // matches the attachment-context inline clamp
const NUL = new RegExp(String.fromCharCode(0), "g");

function clamp(text) {
  const t = String(text || "").replace(NUL, "").trim();
  if (!t) return null;
  return t.length > MAX_EXTRACT_CHARS ? `${t.slice(0, MAX_EXTRACT_CHARS)}\n[… truncated]` : t;
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
