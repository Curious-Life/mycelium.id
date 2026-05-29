#!/usr/bin/env python3
"""
Local Embedding Service — Nomic v1.5 ONNX (768D, search-side).

Replaces BGE-M3 for mind-search retrieval. Runs the same Nomic v1.5
ONNX file used by clustering (~170MB int8 quantized) but configured
for retrieval rather than clustering:

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
  → { "embedding": [...], "dim": 768, "model": "nomic-v1.5", "task": "..." }

  POST /batch
    { "texts": [...], "task": "query"|"document" }
  → { "embeddings": [[...], ...], "count": N, "dim": 768,
      "model": "nomic-v1.5", "task": "..." }

  GET /health
  → { "status": "ok"|"loading"|"error", "model": "nomic-v1.5",
      "loaded": bool, "dim": 768 }

Why split from cluster.py:
  cluster.py uses the 'clustering: ' prefix and 256D matryoshka
  truncation. mind-search needs different prefixes and full 768D.
  Sharing one entrypoint would couple two consumers that should
  evolve independently.

Why no idle-unload:
  Nomic v1.5 ONNX int8 sits at ~250–300MB resident. That's small
  enough to keep loaded permanently, which removes the cold-start
  spike when the agent issues its first query of the day. BGE-M3
  was 2.5GB resident which forced unload — Nomic does not.

Usage:
  scripts/.venv/bin/python scripts/embed-service.py --serve --port 8091
  scripts/.venv/bin/python scripts/embed-service.py --text "hello" --task query
"""

import argparse
import gc
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np

# ── Config ─────────────────────────────────────────────────────────────────

MODEL_ID = "nomic-ai/nomic-embed-text-v1.5"
ONNX_FILE = "onnx/model_quantized.onnx"   # int8 quantized (~170MB on disk)
MODEL_NAME = "nomic-v1.5"                  # short label returned by API
OUTPUT_DIM = 768
MAX_LENGTH = 512                           # Nomic v1.5 token cap
MAX_CHARS = 8000                           # bound payload before tokenization
BATCH_SIZE = 16

# Nomic v1.5 task prefixes — exact strings from the model card.
# Trailing space is intentional. Order: query/document for retrieval.
TASK_PREFIXES = {
    "query": "search_query: ",
    "document": "search_document: ",
}

# ── Module state ───────────────────────────────────────────────────────────

_session = None
_tokenizer = None
_load_lock = threading.Lock()
_load_error = None  # last load exception; surfaced via /health


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

            _session = ort.InferenceSession(
                model_path, sess_options, providers=["CPUExecutionProvider"]
            )

            tokenizer_path = hf_hub_download(MODEL_ID, "tokenizer.json")
            _tokenizer = Tokenizer.from_file(tokenizer_path)
            _tokenizer.enable_truncation(max_length=MAX_LENGTH)
            _tokenizer.enable_padding()

            elapsed_ms = (time.time() - t0) * 1000
            print(
                f"[embed-service] Model loaded in {elapsed_ms:.0f}ms "
                f"(dim={OUTPUT_DIM}, max_length={MAX_LENGTH})",
                flush=True,
            )
            _load_error = None
            return _session, _tokenizer

        except Exception as e:
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
    """Embed a batch of texts → (N, 768) float32 L2-normalized array.

    Mismatched prefix at index vs query time degrades recall; the
    `task` argument is therefore required (no default at this layer).
    The HTTP layer applies a default for ergonomics."""
    if not texts:
        return np.zeros((0, OUTPUT_DIM), dtype=np.float32)

    prefix = _resolve_prefix(task)
    session, tokenizer = _load_model()

    # Some Nomic ONNX exports require token_type_ids; some don't.
    # Build the feed dict from whatever the loaded model expects.
    expected_inputs = {inp.name for inp in session.get_inputs()}

    prefixed = [
        prefix + (t[:MAX_CHARS] if isinstance(t, str) else "")
        for t in texts
    ]

    out = []
    for i in range(0, len(prefixed), BATCH_SIZE):
        batch = prefixed[i : i + BATCH_SIZE]
        enc = tokenizer.encode_batch(batch)
        input_ids = np.array([e.ids for e in enc], dtype=np.int64)
        attention_mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
        feed = {"input_ids": input_ids, "attention_mask": attention_mask}
        if "token_type_ids" in expected_inputs:
            feed["token_type_ids"] = np.array(
                [e.type_ids for e in enc], dtype=np.int64
            )

        outputs = session.run(None, feed)
        token_embs = outputs[0]  # (batch, seq_len, 768)

        # Mean-pool with attention mask
        mask = attention_mask[:, :, np.newaxis].astype(np.float32)
        pooled = (token_embs * mask).sum(axis=1) / mask.sum(axis=1).clip(min=1)
        embs = pooled[:, :OUTPUT_DIM].astype(np.float32)

        # L2 normalize (cosine search expects unit vectors)
        norms = np.linalg.norm(embs, axis=1, keepdims=True).clip(min=1e-8)
        embs = embs / norms

        out.append(embs)
        del enc, input_ids, attention_mask, outputs, token_embs, mask, pooled
        gc.collect()

    return np.vstack(out)


# ── HTTP server ────────────────────────────────────────────────────────────


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
            ready = _session is not None
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

    httpd = HTTPServer(("127.0.0.1", port), Handler)
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


# ── CLI ────────────────────────────────────────────────────────────────────

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
