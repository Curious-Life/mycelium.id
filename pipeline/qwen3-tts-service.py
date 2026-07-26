#!/usr/bin/env python3
# pipeline/qwen3-tts-service.py — local Text-to-Speech, the MLX-runtime successor
# to kokoro-service.py (removed). Qwen3-TTS via `mlx-audio` (Apple Silicon / Metal
# — a NEW runtime; design §4.2). Loopback-only, no secrets. Returns 24kHz mono
# s16le WAV; the Node side encodes OGG/Opus in pure JS — zero cloud egress
# (design §5.5), no ffmpeg. Mirrors kokoro-service.py: lazy single load,
# ThreadingHTTPServer on 127.0.0.1, Content-Length cap before read, NEVER throw
# across the boundary.
#
#   GET  /health -> {"ok": true, "loaded": bool, "runtime": "mlx", "render": "ready"|"pending-sample"}
#   POST /tts    {"text": "...", "ref_audio_b64": "...", "ref_text": "...", "instruct": "..."}
#                -> audio/wav   (REQUIRES a frozen reference sample — see the SEAM below)
#
# ⚠️ SYNTHESIS SEAM (design §2.2 — the KEYSTONE finding).
#    A DESCRIBED voice is NOT reproducible: the same description rendered twice
#    "sounded like different people". Identity is held ONLY by a FROZEN reference
#    sample (ref_audio + ref_text), which is authored on the per-agent character
#    page (design §5) — a SEPARATE unit not built yet. So without a ref sample this
#    service returns 501 "voice-sample-pending" HONESTLY; it never fabricates a
#    stable-sounding 'ok'. The model MANAGEMENT (download + health) is complete and
#    verified; this render call is the marked seam, and it is stated plainly in the
#    PR. When the character page lands it will POST ref_audio_b64 + ref_text here.
import io
import os
import json
import base64
import struct
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = int(os.environ.get("MYCELIUM_QWEN_TTS_PORT") or 8094)
# The vault POSTs ref_audio_b64 = base64(frozen WAV). The sample store caps a WAV
# at MAX_SAMPLE_BYTES (8 MB, src/tts/voice-sample-store.js); base64 inflates that
# ~4/3 (~10.7 MB) and the JSON adds text + ref_text. So the body cap MUST exceed
# base64(8 MB) or a valid sample is 413'd at render time — the exact bug behind the
# "▶ hear" audition failing with render-upstream-413 (the old 4 MB cap rejected
# every WAV over ~3 MB, i.e. a ~30 s 48 kHz clip). 16 MB mirrors the store's
# on-disk MAX_FILE_BYTES ceiling with headroom. Loopback-only + owner-gated +
# rate-limited upstream, so this is a bounded same-box body, not a DoS surface.
MAX_BODY = 16 * 1024 * 1024
SAMPLE_RATE = 24000
MODEL_DIR = os.environ.get("QWEN_TTS_MODEL_DIR") or ""

_model = None
_load_error = None
# WHICH KIND of load failure — the difference between "retry can help" and "retrying
# is a lie" (D-003 ↻2). 'runtime-missing' = `import mlx_audio` itself failed (Intel
# box / package never landed): no number of retries fixes that inside this process,
# so it is TERMINAL and the owner needs a named remedy. Anything else (a half-written
# snapshot, a transient OOM, a weights/runtime version mismatch) is RETRYABLE.
_load_error_kind = None
_load_attempts = 0
_load_next_at = 0.0
_load_lock = threading.Lock()
# Overridable so verify:voice-readiness can drive the REAL retry path in seconds
# instead of minutes (it spawns this service against a stub loader that fails once,
# then succeeds — the only way to prove the un-latch without Apple Silicon).
LOAD_RETRY_BASE_S = float(os.environ.get("QWEN_TTS_LOAD_RETRY_BASE_S") or 15)
LOAD_RETRY_MAX_S = float(os.environ.get("QWEN_TTS_LOAD_RETRY_MAX_S") or 120)

# The status vocabulary src/system/service-state.js already speaks, so the vault can
# map this onto the ONE four-state taxonomy without inventing a second mapping:
#   'ok'            → ready
#   'checking'      → loading  (no load attempted yet)
#   'needs-runtime' → degraded, retryable-by-install  (MLX not importable here)
#   'error'         → failed   (it tried to load and could not)
def _service_status():
    if _model is not None:
        return "ok", None
    if _load_error_kind == "runtime-missing":
        return "needs-runtime", "runtime-missing"
    if _load_error is not None:
        return "error", "load-failed"
    return "checking", None


def _load():
    """Lazy load — first request pays the model-load cost, then it's warm.

    Fail-soft: on any failure /tts returns 503, this never crashes (Kokoro
    precedent). MLX import fails on Intel — that surfaces as 'runtime-missing',
    honestly and TERMINALLY.

    ⚠️ D-003 ↻2 — this used to LATCH: `if _model is not None or _load_error is not
    None: return _model` meant ONE failed load pinned every later /tts at 503 for
    the whole process lifetime, while /health still answered ok:true so the
    supervisor never restarted it. The operator saw "voice engine is starting…
    try again shortly" forever. A retryable failure now retries on a bounded
    backoff; only a genuinely terminal one stops trying (and says so)."""
    global _model, _load_error, _load_error_kind, _load_attempts, _load_next_at
    if _model is not None:
        return _model
    if _load_error_kind == "runtime-missing":
        return None                      # terminal — retrying cannot help
    if _load_error is not None and time.monotonic() < _load_next_at:
        return None                      # inside the backoff window
    # Serialize: a retryable load is now re-entered, and two concurrent /tts
    # requests must never both pull a multi-GB model into memory.
    with _load_lock:
        if _model is not None:
            return _model
        if _load_error_kind == "runtime-missing" or (_load_error is not None and time.monotonic() < _load_next_at):
            return None
        try:
            # SEAM: the exact mlx-audio loader is confirmed only on an Apple-Silicon
            # box with the model present (design §2.1 rendered via mlx-audio). Kept
            # behind the lazy load so /health still answers before a model exists.
            from mlx_audio.tts.utils import load_model  # type: ignore
            _model = load_model(MODEL_DIR)
            _load_error = None
            _load_error_kind = None
            _load_attempts = 0
            print(f"[qwen3-tts] model loaded ({MODEL_DIR})", flush=True)
        except Exception as e:  # noqa: BLE001 — fail-soft
            # TERMINAL only when MLX ITSELF is absent. `except ImportError` was too
            # wide: mlx-audio lazily imports sub-dependencies (soundfile, per-model
            # backends), so a missing sub-dep would have been reported as "this Mac
            # cannot run the voice engine" on a machine one pip install away from
            # working — a WRONG terminal verdict, which is the same dishonest-state
            # family as the bug being fixed.
            missing = getattr(e, "name", None) or ""
            if isinstance(e, ImportError) and (missing.split(".")[0] == "mlx_audio" or "mlx_audio" in str(e)):
                _load_error = str(e)
                _load_error_kind = "runtime-missing"
                print(f"[qwen3-tts] load failed (runtime-missing, terminal): {_load_error}", flush=True)
            else:
                _load_attempts += 1
                _load_error = str(e)
                _load_error_kind = "load-failed"
                _load_next_at = time.monotonic() + min(
                    LOAD_RETRY_MAX_S, LOAD_RETRY_BASE_S * (2 ** min(_load_attempts - 1, 3))
                )
                print(f"[qwen3-tts] load failed (attempt {_load_attempts}, will retry): {_load_error}", flush=True)
    return _model


def _float_to_wav(samples, rate):
    """float32 [-1,1] mono -> 16-bit PCM WAV bytes (identical to kokoro-service)."""
    pcm = bytearray()
    for s in samples:
        v = int(max(-1.0, min(1.0, float(s))) * 32767)
        pcm += struct.pack("<h", v)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(pcm))
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # silence default access logging (no PII)
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            # render:'ready' would require a ref sample per call; the service can
            # only promise the model is LOADABLE — never that a stable render is
            # possible without a frozen sample. Report the seam honestly.
            #
            # `ok` stays True — the HTTP service IS answering, and the supervisor's
            # bind/adopt probe is allowed to read that. `status` is the MODEL's own
            # state, and it is what tells the supervisor apart "listening" from
            # "actually able to render" (D-003 ↻2: a latched load error kept
            # answering ok:true, so the supervisor reported "Local voice ready"
            # while every /tts 503'd).
            status, reason = _service_status()
            return self._json(200, {
                "ok": True, "loaded": _model is not None,
                "status": status, "reason": reason,
                # The raw exception stays on loopback for the operator's own log; the
                # vault NEVER echoes it to a UI unsanitized (src/tts/voice-render.js).
                "error": _load_error,
                "runtime": "mlx", "model": "qwen3-tts", "render": "pending-sample",
            })
        return self._json(404, {"ok": False, "error": "not-found"})

    def do_POST(self):
        if self.path != "/tts":
            return self._json(404, {"ok": False, "error": "not-found"})
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            return self._json(413, {"ok": False, "error": "bad-length"})
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json(400, {"ok": False, "error": "bad-json"})
        text = (req.get("text") or "").strip()
        if not text:
            return self._json(400, {"ok": False, "error": "empty-text"})

        # ── THE SEAM (design §2.2) — identity lives in the frozen sample ──
        # Without a ref sample, a Qwen3-TTS render is a DIFFERENT person each time,
        # so we refuse HONESTLY rather than ship an unstable voice. This is the one
        # path the model-management unit deliberately leaves pending; the character
        # page (design §5) will supply ref_audio_b64 + ref_text.
        ref_b64 = req.get("ref_audio_b64")
        ref_text = req.get("ref_text")
        if not ref_b64 or not ref_text:
            return self._json(501, {
                "ok": False, "error": "voice-sample-pending",
                "detail": "A described voice is not reproducible; freeze a reference sample on the character page first (design §2.2 / §5).",
            })

        # Decode + validate the reference WAV BEFORE the model touches it, so a
        # malformed/undecodable sample gives an HONEST, actionable 422 rather than
        # an opaque 500 from deep inside generate(). The vault produced this base64,
        # so a failure here means a corrupt stored sample — surface that plainly.
        try:
            ref_audio = base64.b64decode(ref_b64)
        except Exception:
            return self._json(422, {"ok": False, "error": "bad-ref-audio: not base64"})
        try:
            with wave.open(io.BytesIO(ref_audio), "rb") as _w:
                if _w.getnframes() <= 0:
                    raise ValueError("empty PCM")
        except Exception as e:  # noqa: BLE001
            return self._json(422, {"ok": False, "error": f"bad-ref-audio: {str(e)[:80]}"})

        k = _load()
        if k is None:
            # The TOKEN comes first so the vault can allowlist it and map it to a
            # remedy; the detail follows the colon and is SANITIZED vault-side before
            # any UI sees it. 'runtime-missing' is terminal (needs Apple Silicon /
            # an mlx-audio install); 'load-failed' will be retried.
            _status, reason = _service_status()
            token = "voice-runtime-missing" if reason == "runtime-missing" else "model-unavailable"
            return self._json(503, {"ok": False, "error": f"{token}: {_load_error}", "reason": reason})
        try:
            # SEAM: real render path — clone from the frozen sample (+ optional
            # `instruct` modulation, design §2.4). Confirmed runnable only on an
            # Apple-Silicon box with the model + a sample; wrapped so it never
            # throws across the boundary. A genuine model failure is a 500 here;
            # a malformed sample was already caught above (422).
            samples, rate = k.generate(  # type: ignore[attr-defined]
                text=text,
                ref_audio=ref_audio,
                ref_text=ref_text,
                instruct=(req.get("instruct") or None),
            )
        except Exception as e:  # noqa: BLE001
            return self._json(500, {"ok": False, "error": f"synth-failed: {str(e)[:120]}"})
        wav = _float_to_wav(samples, rate or SAMPLE_RATE)
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)


def _loader_loop():
    """Background eager load + BOUNDED RETRY.

    Two reasons this is a thread and not a call before bind():
      1. Loading before bind() means a doomed bind (:8094 already held) pays a full
         multi-GB model load before EADDRINUSE is discovered — up to once per
         supervisor restart attempt.
      2. Without it, the ONLY thing that ever re-attempts a failed load is an
         inbound /tts. So a retryable failure at boot pinned /health at
         status:'error' forever even though the load itself was retryable — the
         D-003 ↻2 dishonest state moved one layer up. Health must converge on its
         own, not on the owner poking it.
    Exits on success or on a TERMINAL failure; never raises into the server."""
    while True:
        if _model is not None:
            return
        if _load_error_kind == "runtime-missing":
            return                      # terminal — no amount of retrying helps
        try:
            _load()
        except Exception:               # noqa: BLE001 — _load is already fail-soft
            pass
        time.sleep(1)


def main():
    port = DEFAULT_PORT
    # BIND FIRST: a port conflict must surface immediately, not after a cold load.
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"[qwen3-tts] listening on http://127.0.0.1:{port}", flush=True)
    if os.environ.get("QWEN_TTS_PRELOAD", "0") == "1":
        threading.Thread(target=_loader_loop, name="qwen-tts-loader", daemon=True).start()
    srv.serve_forever()


if __name__ == "__main__":
    main()
