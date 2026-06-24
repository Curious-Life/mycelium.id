// src/enrich/extract-document.js — best-effort, fail-soft document text extraction.
//
// PDF via unpdf (pure-JS pdf.js build, no native deps) and DOCX via mammoth —
// the same pair the canonical attachments pipeline used, minus its LibreOffice
// shell-out (.pages/.odt/.epub stay unextracted and fail soft).
//
// The parse itself runs in a throwaway worker_thread (extract-document.worker.js)
// that the parent can HARD-KILL — a decompression/XML bomb (a tiny docx that
// mammoth unzips into GBs of XML) cannot be stopped by Promise.race ("the loser
// keeps running" and holds the memory for the full window, repeatable per
// upload — MED-3, media-smoke-2 review). The worker runs under a bounded heap
// (`resourceLimits` → V8 OOMs the worker, parent survives) and is `terminate()`d
// on timeout. Either way the bomb dies in an isolated thread. The 20MB
// attachment gate bounds INPUT; this bounds DECOMPRESSED output + wall-clock.
//
// Same contract as describe-image/transcribe-audio: NEVER hang, NEVER throw —
// unparseable/encrypted/scanned documents → null and the caller falls back to
// a filename placeholder. Bytes never leave the process; nothing is logged.

import { Worker } from "node:worker_threads";

const WORKER_URL = new URL("./extract-document.worker.js", import.meta.url);

// Bounded heap for the parse worker. A valid 20MB doc extracts well under this;
// a bomb inflating past it gets OOM-killed by V8 (the worker, not the vault).
const HEAP_MB = Math.max(64, Number(process.env.MYCELIUM_EXTRACT_HEAP_MB) || 256);

// Active parse workers — exported for the verify gate to assert teardown.
let _activeWorkers = 0;
export function activeExtractWorkers() { return _activeWorkers; }

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
 * @param {number} [a.timeoutMs]  parse budget (a hostile PDF must not hang the vault)
 * @returns {Promise<string|null>}
 */
export async function extractDocumentText({ bytes, mimeType, fileName, timeoutMs }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return null;
  const kind = documentKindOf(mimeType, fileName);
  if (!kind) return null;

  const budgetMs = Number(timeoutMs) || Number(process.env.MYCELIUM_EXTRACT_TIMEOUT_MS) || 30_000;

  return await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let worker = null;

    // Single exit point: stop the timer, hard-kill the worker, resolve once.
    // Resolution waits for terminate() so callers (and the gate) observe a torn
    // -down worker — _activeWorkers is back to its prior count by the time we
    // resolve. A bomb mid-parse is killed here; its memory is reclaimed with it.
    const done = async (val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (worker) {
        try { await worker.terminate(); } catch { /* already gone */ }
        _activeWorkers--;
      }
      resolve(val);
    };

    try {
      worker = new Worker(WORKER_URL, {
        // Structured-clone COPY of the bytes (no transfer — `bytes` may be a view
        // into a pooled ArrayBuffer; transferring would corrupt the pool). 20MB
        // cap makes the copy cheap.
        workerData: { kind, bytes },
        resourceLimits: { maxOldGenerationSizeMb: HEAP_MB, maxYoungGenerationSizeMb: 64 },
      });
    } catch {
      // Worker construction failed (e.g. missing file) → fail soft.
      resolve(null);
      return;
    }
    _activeWorkers++;

    // The hard kill: on timeout we terminate() the worker mid-parse. This is the
    // protection Promise.race could not give — the parse thread actually stops.
    timer = setTimeout(() => { void done(null); }, budgetMs);
    timer.unref?.();

    worker.once("message", (msg) => { void done(msg && typeof msg.text === "string" ? msg.text : null); });
    // 'error' includes ERR_WORKER_OUT_OF_MEMORY (bomb tripped the heap cap).
    worker.once("error", () => { void done(null); });
    // Worker exited on its own (clean finish handled by 'message'; a bare exit
    // — including a terminate — resolves null if nothing else settled first).
    worker.once("exit", () => { void done(null); });
  });
}

export default extractDocumentText;
