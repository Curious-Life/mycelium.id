#!/usr/bin/env python3
"""Mycelium local transcription service — dedicated Whisper speech-to-text.

Mirrors embed-service.py: a loopback-only HTTP service (127.0.0.1, default
:8093) supervised by node (src/transcribe/supervisor.js). Replaces the slow
"ask the chat LLM to transcribe" path with faster-whisper (CTranslate2, CPU
int8) once the user downloads a model from the Voice-transcription section.

Endpoints:
  GET  /health      → {status, model, progress?}   status: ok|loading|downloading|no_model|error
  POST /download    → {"model": "small"|"large-v3-turbo"}  background HF snapshot
  POST /transcribe  → body: WAV bytes (audio/wav) or JSON {"wav_base64": ...}
                      ← {"text": ..., "language": ..., "ms": ...}

Input contract: the node side sends 16-bit PCM mono WAV (src/enrich/ogg-opus.js
emits 48kHz mono s16le). We decode with stdlib `wave` and resample to 16kHz
float32 with scipy — faster-whisper's PyAV file path is never used, so audio
bytes stay in-process.

SECURITY: binds 127.0.0.1 only (CLAUDE.md §13); audio bytes and transcripts are
NEVER logged. Model downloads are the only network egress and happen ONLY on an
explicit /download (HF_HUB_OFFLINE is bypassed for that call alone). The HF
snapshot is pinned to an immutable commit (MODEL_REVISIONS) so a retagged or
compromised upstream repo cannot swap weights — see _revision().
"""

import io
import json
import os
import sys
import time
import wave
import threading
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = 8093
# Hard request-body ceiling. The node side only ever POSTs a single voice note
# (≤20MB Telegram cap → ~its WAV); 64MB leaves headroom while stopping any local
# actor from forcing an unbounded rfile.read() allocation (loopback DoS).
MAX_BODY = 64 * 1024 * 1024
# Curated, stable sizes only — resolved to official CT2 repos by faster-whisper.
ALLOWED_MODELS = ("large-v3-turbo", "small")
# Supply-chain pin — freeze each model to an IMMUTABLE commit so a retagged or
# compromised upstream HF repo can't silently swap model weights on the next
# /download. These are the exact revisions validated on this deployment (the
# commits faster-whisper's _MODELS currently resolves: large-v3-turbo →
# mobiuslabsgmbh/faster-whisper-large-v3-turbo, small → Systran/faster-whisper-
# small). Override the active model with WHISPER_MODEL_REVISION; an unknown model
# stays unpinned (revision=None ⇒ unchanged behavior). The same revision is used
# for download AND the offline load so the HF cache resolves consistently.
MODEL_REVISIONS = {
    "large-v3-turbo": "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf",
    "small": "536b0662742c02347bc0e980a01041f333bce120",
}


def _revision(model):
    """Pinned HF commit for `model` (env override → built-in map → None)."""
    return os.environ.get("WHISPER_MODEL_REVISION") or MODEL_REVISIONS.get(model)

_state = {
    "status": "no_model",   # ok | loading | downloading | no_model | error
    "model": os.environ.get("MYCELIUM_WHISPER_MODEL") or None,
    "error": None,
    "progress": None,        # {"pct": int} while downloading
}
_lock = threading.Lock()
_whisper = None              # loaded WhisperModel


def _deps_ok():
    try:
        import faster_whisper  # noqa: F401
        import scipy  # noqa: F401
        return True
    except Exception:
        return False


def _model_cached(model):
    """True when the CT2 snapshot is FULLY in the local HF cache.

    local_files_only can resolve a snapshot whose model.bin blob is still
    *.incomplete (live, 2026-06-11: health flashed 'ok' mid-download after a
    service restart) — verify the weights file actually exists.
    """
    if not model:
        return False
    try:
        from faster_whisper.utils import download_model
        # local_files_only never touches the network — raises when not cached.
        # Pin the revision so the lookup targets the SAME snapshot /download fetched.
        path = download_model(model, local_files_only=True, revision=_revision(model))
        return bool(path) and os.path.exists(os.path.join(str(path), "model.bin"))
    except Exception:
        return False


def _load_model(model):
    """Lazy-load under the lock. Sets status loading→ok / error."""
    global _whisper
    with _lock:
        if _whisper is not None:
            return _whisper
        _state.update(status="loading", error=None)
        try:
            from faster_whisper import WhisperModel
            _whisper = WhisperModel(model, device="cpu", compute_type="int8", local_files_only=True, revision=_revision(model))
            _state.update(status="ok", model=model)
            return _whisper
        except Exception as e:
            _state.update(status="error", error=str(e)[:200])
            return None


# Expected snapshot sizes (MB) for byte-accurate progress. Approximate is fine
# (pct is clamped to 99 until the snapshot returns).
EXPECTED_MB = {"large-v3-turbo": 1620, "small": 480}


def _download(model):
    """Background HF snapshot with BYTES-ON-DISK progress.

    Lesson (live, 2026-06-11): hooking snapshot_download's tqdm_class reports
    the OUTER "Fetching N files" bar — pct froze at 20% (1/5 files) while the
    1.6GB model.bin downloaded invisibly. Instead a sizer thread walks the
    repo's HF cache dir (incl. *.incomplete blobs) against the expected total.
    """
    _state.update(status="downloading", model=model, error=None, progress={"pct": 0})
    # Explicit user action — allow network for this thread even in offline mode.
    os.environ.pop("HF_HUB_OFFLINE", None)
    done = threading.Event()
    try:
        import huggingface_hub
        from faster_whisper.utils import _MODELS

        repo_id = _MODELS.get(model, model)
        expected = EXPECTED_MB.get(model, 500) * 1024 * 1024

        def _repo_cache_dir():
            base = os.environ.get("HF_HOME")
            hub = os.path.join(base, "hub") if base else os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")
            return os.path.join(hub, "models--" + repo_id.replace("/", "--"))

        def _sizer():
            d = _repo_cache_dir()
            while not done.wait(1.0):
                total = 0
                for root, _dirs, files in os.walk(d):
                    for f in files:
                        try:
                            total += os.path.getsize(os.path.join(root, f))
                        except OSError:
                            pass
                if total > 0:
                    _state["progress"] = {"pct": int(min(99, (total / expected) * 100))}

        threading.Thread(target=_sizer, daemon=True).start()
        huggingface_hub.snapshot_download(
            repo_id,
            revision=_revision(model),
            allow_patterns=["config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.*"],
        )
        _state.update(progress={"pct": 100})
        global _whisper
        with _lock:
            _whisper = None  # force reload with the new snapshot
        _state.update(status="ok" if _load_model(model) else _state["status"])
    except Exception as e:
        _state.update(status="error", error=str(e)[:200], progress=None)
    finally:
        done.set()


def _wav_to_float16k(buf):
    """16-bit PCM WAV bytes → mono float32 @16kHz (numpy). None on failure."""
    import numpy as np
    try:
        with wave.open(io.BytesIO(buf), "rb") as w:
            ch = w.getnchannels()
            sr = w.getframerate()
            if w.getsampwidth() != 2:
                return None
            raw = w.readframes(w.getnframes())
        x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        if ch > 1:
            x = x.reshape(-1, ch).mean(axis=1)
        if sr != 16000:
            from scipy.signal import resample_poly
            from math import gcd
            g = gcd(sr, 16000)
            x = resample_poly(x, 16000 // g, sr // g).astype(np.float32)
        return x
    except Exception:
        return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # never log request bodies/paths with content
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != "/health":
            return self._json(404, {"error": "not found"})
        if not _deps_ok():
            return self._json(200, {"status": "deps_missing", "model": _state["model"]})
        # Honest cache check when idle: a configured model that's cached but
        # not loaded yet still reports ok (load is lazy on first transcribe).
        st = dict(_state)
        if st["status"] == "no_model" and st["model"] and _model_cached(st["model"]):
            st["status"] = "ok"
        return self._json(200, {k: st[k] for k in ("status", "model", "error", "progress") if st.get(k) is not None or k == "status"})

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._json(400, {"error": "bad content-length"})
        if n > MAX_BODY:
            return self._json(413, {"error": "body too large"})
        body = self.rfile.read(n) if n > 0 else b""

        if self.path == "/download":
            try:
                model = (json.loads(body or b"{}").get("model") or "").strip()
            except Exception:
                model = ""
            if model not in ALLOWED_MODELS:
                return self._json(400, {"error": "unknown model", "allowed": list(ALLOWED_MODELS)})
            if not _deps_ok():
                return self._json(503, {"error": "deps_missing"})
            if _state["status"] == "downloading":
                return self._json(409, {"error": "download in progress"})
            threading.Thread(target=_download, args=(model,), daemon=True).start()
            return self._json(202, {"ok": True, "model": model})

        if self.path == "/transcribe":
            if not _deps_ok():
                return self._json(503, {"error": "deps_missing"})
            model = _state["model"]
            if not model or not _model_cached(model):
                return self._json(409, {"error": "no_model"})
            if self.headers.get("Content-Type", "").startswith("application/json"):
                try:
                    import base64
                    body = base64.b64decode(json.loads(body).get("wav_base64") or "")
                except Exception:
                    return self._json(400, {"error": "bad json"})
            if not body:
                return self._json(400, {"error": "empty body"})
            audio = _wav_to_float16k(body)
            if audio is None or not len(audio):
                return self._json(400, {"error": "bad wav"})
            m = _load_model(model)
            if m is None:
                return self._json(500, {"error": _state.get("error") or "load failed"})
            t0 = time.time()
            try:
                segments, info = m.transcribe(audio, beam_size=1, vad_filter=True)
                text = " ".join(s.text.strip() for s in segments).strip()
            except Exception as e:
                return self._json(500, {"error": str(e)[:200]})
            return self._json(200, {
                "text": text[:8000],
                "language": getattr(info, "language", None),
                "ms": int((time.time() - t0) * 1000),
            })

        return self._json(404, {"error": "not found"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--port", type=int, default=int(os.environ.get("MYCELIUM_TRANSCRIBE_PORT") or DEFAULT_PORT))
    args = ap.parse_args()
    if not args.serve:
        print("transcribe-service: use --serve", file=sys.stderr)
        sys.exit(2)
    if _state["model"] and _deps_ok() and _model_cached(_state["model"]):
        _state["status"] = "ok"  # lazy-load on first request
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"transcribe-service listening on 127.0.0.1:{args.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
