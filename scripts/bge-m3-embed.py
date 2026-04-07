#!/usr/bin/env python3
"""
BGE-M3 Local Embedding Service — ONNX Runtime on CPU.

Generates 1024D dense vectors for semantic search (Vectorize).
Same pattern as Nomic embedder in cluster.py but for BGE-M3.

Modes:
  --serve --port 8091    HTTP server for real-time embedding
  --batch INPUT OUTPUT   Batch mode: JSONL in, JSONL out

API:
  POST /embed  { "text": "..." }  → { "embedding": [...], "dimensions": 1024 }
  POST /batch  { "texts": [...] } → { "embeddings": [[...], ...] }
  GET  /health                    → { "status": "ok", "model": "BAAI/bge-m3" }

Model: BAAI/bge-m3 ONNX (downloaded on first use via huggingface_hub)
"""

import argparse
import json
import sys
import gc
import os
import time
import numpy as np
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Timer

# ── Config ──

MODEL_ID = "BAAI/bge-m3"
ONNX_FILE = "onnx/model.onnx"  # float16 or quantized, depending on availability
MAX_LENGTH = 8192
BATCH_SIZE = 16
OUTPUT_DIM = 1024
IDLE_TIMEOUT = int(os.environ.get("BGE_IDLE_TIMEOUT", "10800"))  # 3h default — keep warm for search

# ── Global state ──

_session = None
_tokenizer = None
_last_used = 0


def _load_model():
    """Load BGE-M3 ONNX model + tokenizer. Cached after first call."""
    global _session, _tokenizer, _last_used

    if _session is not None:
        _last_used = time.time()
        return _session, _tokenizer

    import onnxruntime as ort
    from transformers import AutoTokenizer
    from huggingface_hub import hf_hub_download

    print(f"[bge-m3] Loading model {MODEL_ID}...", flush=True)

    # Try quantized first, fall back to float
    try:
        model_path = hf_hub_download(MODEL_ID, "onnx/model_quantized.onnx")
        print("[bge-m3] Using quantized ONNX model")
    except Exception:
        model_path = hf_hub_download(MODEL_ID, ONNX_FILE)
        print("[bge-m3] Using float ONNX model")

    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess_options.inter_op_num_threads = 2
    sess_options.intra_op_num_threads = 2

    _session = ort.InferenceSession(model_path, sess_options, providers=["CPUExecutionProvider"])
    _tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
    _last_used = time.time()

    print(f"[bge-m3] Model loaded ({os.path.getsize(model_path) / 1e6:.0f}MB)", flush=True)
    return _session, _tokenizer


def _unload_model():
    """Free model from RAM."""
    global _session, _tokenizer
    if _session is None:
        return
    print("[bge-m3] Unloading model (idle timeout)", flush=True)
    del _session, _tokenizer
    _session = None
    _tokenizer = None
    gc.collect()
    gc.collect()


def embed_texts(texts: list[str]) -> np.ndarray:
    """
    Embed a batch of texts → (N, 1024) float32 array.
    Uses mean pooling over token embeddings.
    """
    session, tokenizer = _load_model()

    all_embeddings = []

    for i in range(0, len(texts), BATCH_SIZE):
        batch = texts[i:i + BATCH_SIZE]
        encoded = tokenizer(
            batch, padding=True, truncation=True,
            max_length=MAX_LENGTH, return_tensors="np"
        )

        feed = {
            "input_ids": encoded["input_ids"].astype(np.int64),
            "attention_mask": encoded["attention_mask"].astype(np.int64),
        }
        if "token_type_ids" in encoded:
            feed["token_type_ids"] = encoded["token_type_ids"].astype(np.int64)
        else:
            feed["token_type_ids"] = np.zeros_like(encoded["input_ids"], dtype=np.int64)

        outputs = session.run(None, feed)

        # Mean pooling with attention mask
        token_embs = outputs[0]  # (batch, seq_len, hidden_dim)
        mask = encoded["attention_mask"][:, :, np.newaxis].astype(np.float32)
        pooled = (token_embs * mask).sum(axis=1) / mask.sum(axis=1).clip(min=1)

        # Take first 1024 dimensions (BGE-M3 native dim is 1024)
        embs = pooled[:, :OUTPUT_DIM].astype(np.float32)

        # L2 normalize
        norms = np.linalg.norm(embs, axis=1, keepdims=True).clip(min=1e-8)
        embs = embs / norms

        all_embeddings.append(embs)

        del encoded, outputs, token_embs, mask, pooled
        gc.collect()

    return np.vstack(all_embeddings) if all_embeddings else np.zeros((0, OUTPUT_DIM), dtype=np.float32)


# ── HTTP Server Mode ──

class EmbedHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Suppress default access logs
        pass

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {
                "status": "ok",
                "model": MODEL_ID,
                "loaded": _session is not None,
                "dimensions": OUTPUT_DIM,
            })
        else:
            self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(content_length)) if content_length > 0 else {}

        if self.path == "/embed":
            text = body.get("text", "")
            if not text or not isinstance(text, str):
                return self._send_json(400, {"error": "text field required"})
            try:
                emb = embed_texts([text[:8000]])
                self._send_json(200, {
                    "embedding": emb[0].tolist(),
                    "dimensions": OUTPUT_DIM,
                })
            except Exception as e:
                self._send_json(500, {"error": str(e)})

        elif self.path == "/batch":
            texts = body.get("texts", [])
            if not texts or not isinstance(texts, list):
                return self._send_json(400, {"error": "texts array required"})
            try:
                embs = embed_texts([t[:8000] for t in texts])
                self._send_json(200, {
                    "embeddings": embs.tolist(),
                    "count": len(embs),
                    "dimensions": OUTPUT_DIM,
                })
            except Exception as e:
                self._send_json(500, {"error": str(e)})
        else:
            self._send_json(404, {"error": "Not found"})


def _idle_checker(server):
    """Periodically check if model should be unloaded."""
    global _last_used
    while True:
        time.sleep(60)
        if _session is not None and time.time() - _last_used > IDLE_TIMEOUT:
            _unload_model()


def serve(port=8091, preload=False):
    """Run HTTP embedding server."""
    import threading

    server = HTTPServer(("127.0.0.1", port), EmbedHandler)
    print(f"[bge-m3] Serving on http://127.0.0.1:{port}", flush=True)
    print(f"[bge-m3] Idle timeout: {IDLE_TIMEOUT}s ({IDLE_TIMEOUT // 60}min)", flush=True)

    if preload or os.environ.get("BGE_PRELOAD", "1") == "1":
        print("[bge-m3] Preloading model at startup (BGE_PRELOAD=1)...", flush=True)
        _load_model()
        print("[bge-m3] Model ready — no cold start on first search", flush=True)

    # Start idle checker in background
    checker = threading.Thread(target=_idle_checker, args=(server,), daemon=True)
    checker.start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[bge-m3] Shutting down")
        server.shutdown()


# ── Batch Mode ──

def batch_process(input_path, output_path):
    """Process JSONL file: {id, text} → {id, embedding}."""
    print(f"[bge-m3] Batch processing: {input_path} → {output_path}")

    items = []
    with open(input_path) as f:
        for line in f:
            items.append(json.loads(line))

    texts = [item["text"][:8000] for item in items]
    print(f"[bge-m3] Embedding {len(texts)} texts...")

    embeddings = embed_texts(texts)

    with open(output_path, "w") as f:
        for item, emb in zip(items, embeddings):
            f.write(json.dumps({"id": item["id"], "embedding": emb.tolist()}) + "\n")

    print(f"[bge-m3] Done: {len(embeddings)} embeddings written")
    _unload_model()


# ── CLI ──

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="BGE-M3 ONNX Embedding Service")
    parser.add_argument("--serve", action="store_true", help="Run HTTP server")
    parser.add_argument("--port", type=int, default=8091, help="Server port (default 8091)")
    parser.add_argument("--batch", nargs=2, metavar=("INPUT", "OUTPUT"), help="Batch mode: JSONL in/out")
    parser.add_argument("--text", type=str, help="Embed single text, print vector")

    args = parser.parse_args()

    if args.serve:
        serve(args.port)
    elif args.batch:
        batch_process(args.batch[0], args.batch[1])
    elif args.text:
        emb = embed_texts([args.text])
        print(json.dumps({"embedding": emb[0].tolist(), "dimensions": OUTPUT_DIM}))
        _unload_model()
    else:
        parser.print_help()
