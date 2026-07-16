#!/usr/bin/env python3
"""
Local Embedding Service — Nomic v1.5 ONNX (768D, search-side).

Ported verbatim-in-spirit from reference/pipeline/embed-service.py for the
self-hosted V1 build. Runs the Nomic v1.5 ONNX file (~170MB int8 quantized)
configured for retrieval:

  - Default dim=768 (full Nomic v1.5 dim).
  - Task-aware prefixes: 'search_query: ' / 'search_document: '.
    These are the exact strings Nomic v1.5 was trained with — DO NOT
    edit; mismatched prefix at index vs query time tanks recall.
  - L2-normalized output for cosine search.
  - Always-loaded (no idle-unload). Model is small enough at <300MB
    resident to keep warm; eliminates cold-start at query time.

API:
  POST /embed
    { "text": "...", "task": "query"|"document" }
  -> { "embedding": [...], "dim": 768, "model": "nomic-v1.5", "task": "..." }

  POST /batch
    { "texts": [...], "task": "query"|"document" }
  -> { "embeddings": [[...], ...], "count": N, "dim": 768,
       "model": "nomic-v1.5", "task": "..." }

  GET /health
  -> { "status": "ok"|"loading"|"error", "model": "nomic-v1.5",
       "loaded": bool, "dim": 768 }

Bind: 127.0.0.1:8091 (loopback only — never expose this port; CLAUDE.md §13).
Embedding vectors are semantic fingerprints of plaintext — request bodies are
never logged and stack traces are never returned over the wire (CLAUDE.md §1/§7).

The model + tokenizer auto-download from the HuggingFace Hub on first use
(nomic-ai/nomic-embed-text-v1.5). Set HF_HOME to pin the cache; HF_HUB_OFFLINE=1
to force cache-only.

Usage:
  pipeline/.venv/bin/python pipeline/embed-service.py --serve --port 8091
  pipeline/.venv/bin/python pipeline/embed-service.py --text "hello" --task query
"""

import argparse
import gc
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Fail FAST + ACTIONABLE if the embed deps aren't installed for THIS interpreter.
# Otherwise the process dies at module load with a bare ModuleNotFoundError that
# nobody sees (it's spawned in the background) → the embedded count never moves →
# Generate's preflight 409s forever → the UI hangs at "Processing 0/N". The Node
# embed-supervisor also dep-checks before spawning, but this guard covers manual
# `python embed-service.py` runs too. Exit 3 = the agreed "deps missing" code.
try:
    import numpy as np
except ModuleNotFoundError as _e:  # noqa: N816
    sys.stderr.write(
        f"[embed-service] missing Python dependency: {_e.name}\n"
        "The embedding engine needs its dependencies — install with:\n"
        "  bash pipeline/setup.sh   (or: python -m pip install -r pipeline/requirements.txt)\n"
    )
    sys.exit(3)

# -- Config ------------------------------------------------------------------

MODEL_ID = "nomic-ai/nomic-embed-text-v1.5"
ONNX_FILE = "onnx/model_quantized.onnx"   # int8 quantized (~170MB on disk)
MODEL_NAME = "nomic-v1.5"                  # short label returned by API
OUTPUT_DIM = 768
MAX_LENGTH = 512                           # per-window token cap (model context window)
MAX_TOTAL_TOKENS = 8192                    # Nomic v1.5's real cap — we CHUNK long text
                                           # into <=MAX_LENGTH windows up to this total
                                           # and weight-pool, so the WHOLE message is
                                           # embedded (not just its first 512 tokens).
MAX_CHARS = 40000                          # bound payload before tokenization (~8k tokens)
BATCH_SIZE = 16                            # windows per inference batch

# Nomic v1.5 task prefixes — exact strings from the model card.
# Trailing space is intentional. Order: query/document for retrieval.
TASK_PREFIXES = {
    "query": "search_query: ",
    "document": "search_document: ",
}

# -- Module state ------------------------------------------------------------

_session = None
_tokenizer = None
_load_lock = threading.Lock()
# Serializes ONNX inference. The server is now THREADED (ThreadingHTTPServer) so /health
# and queued requests are never blocked by an in-flight batch — but the session is pinned
# to 1 inter/intra-op thread and concurrent batches would multiply peak memory, so actual
# inference stays one-at-a-time. /health deliberately does NOT take this lock: liveness
# must never depend on the model being idle.
#
# WHY THIS EXISTS (2026-07-15, proven): this service was a plain HTTPServer — ONE request
# at a time. Measured: /health returned nothing for 7.8s while a single 12-text batch ran.
# The enrichment drainer's cycle opens with `if (!(await embedHealthy())) return;` and
# embedHealthy() catches any error -> false, WITHOUT logging. So whenever this service was
# busy past the client's timeout, the drainer skipped SILENTLY every 15s. It sat dead for a
# month with the UI still cheerfully rendering "Embedding messages" (that label is just
# `pending > 0`). Its own 200-batch loop saturated this service (observed 99.2% CPU), which
# starved the health check, which killed the next cycle. Self-sustaining.
_infer_lock = threading.Lock()
# BACKPRESSURE (independent review): ThreadingHTTPServer accepts unbounded connections,
# so a slow spell used to queue threads that each hold a parsed body (<=12 x 40k chars)
# and then burn a full inference for a client that already timed out at 30s and hung up.
# The old single-request server couldn't accept the next request at all -- crude, but it
# WAS backpressure, and threading removed it. Bound the queue and shed load instead:
# the drainer treats a throw as transient (rows stay pending, retried next cycle), so a
# 503 is strictly safer than a queued request whose caller is gone. /health is never
# gated on this -- liveness must not depend on the model being idle.
MAX_QUEUED_INFER = int(os.environ.get('MYCELIUM_EMBED_MAX_QUEUE') or 4)
_infer_slots = threading.BoundedSemaphore(MAX_QUEUED_INFER)
_load_error = None  # last load exception; surfaced via /health


class BusyError(Exception):
    """Too many inference requests already queued -> shed load with 503 (retryable)."""


def _load_model():
    """Idempotent model load. Held under a lock so two cold-start
    requests don't race. Subsequent calls are O(1)."""
    global _session, _tokenizer, _load_error

    if _session is not None:
        return _session, _tokenizer

    with _load_lock:
        if _session is not None:
            return _session, _tokenizer

        try:
            import onnxruntime as ort
            from huggingface_hub import hf_hub_download
            from tokenizers import Tokenizer

            print(f"[embed-service] Loading {MODEL_ID} ({ONNX_FILE})...", flush=True)
            t0 = time.time()

            model_path = hf_hub_download(MODEL_ID, ONNX_FILE)

            # Memory-tuned for 4GB VPSes — same shape as cluster.py.
            sess_options = ort.SessionOptions()
            sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
            sess_options.inter_op_num_threads = 1
            sess_options.intra_op_num_threads = 1
            sess_options.enable_cpu_mem_arena = False
            sess_options.enable_mem_pattern = False

            # ATOMIC PUBLISH (independent review, 2026-07-15). Build into LOCALS and assign
            # the globals only once BOTH exist. Previously `_session` was published here and
            # `tokenizer.json` was fetched AFTER it: if that download failed (first run, flaky
            # network) the except below set _load_error and re-raised WITHOUT resetting
            # `_session`, serve() swallowed it and listened anyway, and /health — which reports
            # `ready = _session is not None` — answered {"status":"ok","loaded":true} FOREVER
            # while every /embed died on tokenizer=None. That is precisely the green-health-
            # while-dead failure this file was just fixed to eliminate, through another door —
            # and /health is now load-bearing for BOTH the drainer's gate and the UI's liveness.
            sess = ort.InferenceSession(
                model_path, sess_options, providers=["CPUExecutionProvider"]
            )

            tokenizer_path = hf_hub_download(MODEL_ID, "tokenizer.json")
            tok = Tokenizer.from_file(tokenizer_path)
            # Chunking owns length: cap the FULL tokenization at MAX_TOTAL_TOKENS (a
            # safety bound), and DON'T pad here — embed_texts slices into <=MAX_LENGTH
            # windows and pads each inference batch itself.
            tok.enable_truncation(max_length=MAX_TOTAL_TOKENS)
            tok.no_padding()

            elapsed_ms = (time.time() - t0) * 1000
            print(
                f"[embed-service] Model loaded in {elapsed_ms:.0f}ms "
                f"(dim={OUTPUT_DIM}, max_length={MAX_LENGTH})",
                flush=True,
            )
            # Publish tokenizer FIRST, session LAST: /health gates on _session, so it can
            # never observe a session without its tokenizer.
            _tokenizer = tok
            _session = sess
            _load_error = None
            return _session, _tokenizer

        except Exception as e:
            # Fail CLOSED: a partially-loaded model must never look ready.
            _session = None
            _tokenizer = None
            _load_error = str(e)
            print(f"[embed-service] Model load FAILED: {e}", flush=True)
            raise


def _resolve_prefix(task):
    if task not in TASK_PREFIXES:
        raise ValueError(
            f"task must be one of {list(TASK_PREFIXES)}, got '{task}'"
        )
    return TASK_PREFIXES[task]


def embed_texts(texts, task):
    """Embed a batch of texts -> (N, 768) float32 L2-normalized array.

    Mismatched prefix at index vs query time degrades recall; the
    `task` argument is therefore required (no default at this layer).
    The HTTP layer applies a default for ergonomics."""
    if not texts:
        return np.zeros((0, OUTPUT_DIM), dtype=np.float32)

    prefix = _resolve_prefix(task)
    session, tokenizer = _load_model()

    # One batch at a time (see _infer_lock); at most MAX_QUEUED_INFER waiting (see
    # _infer_slots) so we shed load instead of hoarding orphaned work.
    if not _infer_slots.acquire(blocking=False):
        raise BusyError('embed service busy: %d requests already queued' % MAX_QUEUED_INFER)
    try:
        with _infer_lock:
            return _embed_locked(texts, prefix, session, tokenizer)
    finally:
        _infer_slots.release()


def _embed_locked(texts, prefix, session, tokenizer):
    """Tokenize -> window -> batched inference -> weighted mean-pool -> L2-normalize.

    Caller holds _infer_lock (one batch at a time; the session is pinned to a single
    inter/intra-op thread and concurrent batches would multiply peak memory). The
    prefix is already resolved by embed_texts."""

    # Some Nomic ONNX exports require token_type_ids; some don't.
    # Build the feed dict from whatever the loaded model expects.
    expected_inputs = {inp.name for inp in session.get_inputs()}

    prefixed = [
        prefix + (t[:MAX_CHARS] if isinstance(t, str) else "")
        for t in texts
    ]

    # 1) Tokenize each (prefixed) text in full (capped at MAX_TOTAL_TOKENS) and slice
    #    into <=MAX_LENGTH-token WINDOWS so the WHOLE message is embedded, not just its
    #    first 512 tokens. A short text yields exactly ONE window whose masked mean-pool
    #    is byte-identical to the pre-chunking behavior — so existing vectors are stable.
    encs = tokenizer.encode_batch(prefixed)
    windows = []      # token-id lists, each length <= MAX_LENGTH
    owner = []        # window index -> text index
    weights = []      # window index -> real token count (pooling weight)
    for ti, enc in enumerate(encs):
        ids = enc.ids if enc.ids else [0]   # never produce zero windows
        for j in range(0, len(ids), MAX_LENGTH):
            w = ids[j : j + MAX_LENGTH]
            windows.append(w)
            owner.append(ti)
            weights.append(len(w))

    # 2) Inference over windows, batched + right-padded to the batch's longest window
    #    (padding is masked out of the pool, so it never affects the result).
    pooled_per_window = np.zeros((len(windows), OUTPUT_DIM), dtype=np.float32)
    for i in range(0, len(windows), BATCH_SIZE):
        batch = windows[i : i + BATCH_SIZE]
        maxlen = max(len(w) for w in batch)
        input_ids = np.zeros((len(batch), maxlen), dtype=np.int64)
        attention_mask = np.zeros((len(batch), maxlen), dtype=np.int64)
        for k, w in enumerate(batch):
            input_ids[k, : len(w)] = w
            attention_mask[k, : len(w)] = 1
        feed = {"input_ids": input_ids, "attention_mask": attention_mask}
        if "token_type_ids" in expected_inputs:
            feed["token_type_ids"] = np.zeros((len(batch), maxlen), dtype=np.int64)

        outputs = session.run(None, feed)
        token_embs = outputs[0]  # (batch, seq_len, 768)
        mask = attention_mask[:, :, np.newaxis].astype(np.float32)
        pooled = (token_embs * mask).sum(axis=1) / mask.sum(axis=1).clip(min=1)
        pooled_per_window[i : i + len(batch)] = pooled[:, :OUTPUT_DIM].astype(np.float32)
        del outputs, token_embs, mask, pooled, input_ids, attention_mask
        gc.collect()

    # 3) Per-text: token-count-weighted mean of its windows, then L2-normalize (cosine
    #    search expects unit vectors). One window -> the window itself, unchanged.
    out = np.zeros((len(texts), OUTPUT_DIM), dtype=np.float32)
    w_arr = np.asarray(weights, dtype=np.float32)
    owner_arr = np.asarray(owner)
    for ti in range(len(texts)):
        sel = owner_arr == ti
        wsum = float(w_arr[sel].sum())
        if wsum <= 0:
            continue
        out[ti] = (pooled_per_window[sel] * w_arr[sel, None]).sum(axis=0) / wsum
    norms = np.linalg.norm(out, axis=1, keepdims=True).clip(min=1e-8)
    return (out / norms).astype(np.float32)


# -- HTTP server -------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Suppress access logs — request paths could otherwise leak
        # into journald even though bodies are not logged.
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            # Defense in depth (CLAUDE.md §2): require BOTH halves. The atomic publish in
            # _load_model() already prevents a session without a tokenizer; this makes the
            # readiness contract explicit at the boundary the drainer + UI actually trust.
            ready = _session is not None and _tokenizer is not None
            payload = {
                "status": "ok" if ready else ("error" if _load_error else "loading"),
                "model": MODEL_NAME,
                "loaded": ready,
                "dim": OUTPUT_DIM,
            }
            if _load_error:
                payload["load_error"] = _load_error
            return self._json(200, payload)
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length > 0 else {}
        except Exception:
            return self._json(400, {"error": "invalid json"})

        if self.path == "/embed":
            text = body.get("text")
            task = body.get("task", "query")
            if not isinstance(text, str) or not text:
                return self._json(400, {"error": "text (non-empty string) required"})
            try:
                emb = embed_texts([text], task=task)
                return self._json(
                    200,
                    {
                        "embedding": emb[0].tolist(),
                        "dim": OUTPUT_DIM,
                        "model": MODEL_NAME,
                        "task": task,
                    },
                )
            except BusyError as e:
                # Shed load: retryable, not a fault. The drainer leaves rows pending and
                # retries next cycle; /health stays green because liveness != idleness.
                return self._json(503, {"error": str(e), "retryable": True})
            except ValueError as e:
                return self._json(400, {"error": str(e)})
            except Exception as e:
                return self._json(500, {"error": f"embed failed: {e}"})

        if self.path == "/batch":
            texts = body.get("texts")
            task = body.get("task", "query")
            if not isinstance(texts, list) or not texts:
                return self._json(400, {"error": "texts (non-empty list) required"})
            if not all(isinstance(t, str) for t in texts):
                return self._json(400, {"error": "all texts must be strings"})
            try:
                embs = embed_texts(texts, task=task)
                return self._json(
                    200,
                    {
                        "embeddings": [e.tolist() for e in embs],
                        "count": int(len(embs)),
                        "dim": OUTPUT_DIM,
                        "model": MODEL_NAME,
                        "task": task,
                    },
                )
            except BusyError as e:
                # Shed load: retryable, not a fault. The drainer leaves rows pending and
                # retries next cycle; /health stays green because liveness != idleness.
                return self._json(503, {"error": str(e), "retryable": True})
            except ValueError as e:
                return self._json(400, {"error": str(e)})
            except Exception as e:
                return self._json(500, {"error": f"batch embed failed: {e}"})

        return self._json(404, {"error": "not found"})


def serve(port=8091, preload=True):
    if preload and os.environ.get("EMBED_PRELOAD", "1") == "1":
        try:
            _load_model()
        except Exception:
            # Continue serving so /health surfaces the error and
            # individual /embed calls can retry.
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True  # a hung request must never block shutdown
    print(
        f"[embed-service] Listening on http://127.0.0.1:{port} "
        f"(model={MODEL_NAME}, dim={OUTPUT_DIM})",
        flush=True,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[embed-service] Shutdown", flush=True)
        httpd.shutdown()


# -- CLI ---------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Nomic v1.5 ONNX Embedding Service (search-side)"
    )
    parser.add_argument("--serve", action="store_true", help="Run HTTP server")
    parser.add_argument(
        "--port", type=int, default=8091, help="Server port (default 8091)"
    )
    parser.add_argument(
        "--text",
        type=str,
        help="Embed a single text and print the JSON response (CLI smoke test)",
    )
    parser.add_argument(
        "--task",
        type=str,
        default="query",
        choices=list(TASK_PREFIXES.keys()),
        help="Task prefix (default: query)",
    )

    args = parser.parse_args()

    if args.serve:
        serve(args.port)
    elif args.text:
        emb = embed_texts([args.text], task=args.task)
        print(
            json.dumps(
                {
                    "embedding": emb[0].tolist(),
                    "dim": OUTPUT_DIM,
                    "model": MODEL_NAME,
                    "task": args.task,
                }
            )
        )
    else:
        parser.print_help()
