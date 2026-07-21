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


def _load():
    """Lazy single load — first request pays the model-load cost, then it's warm.
    Fail-soft: on any failure /tts returns 503, this never crashes (Kokoro
    precedent). MLX import fails on Intel — that surfaces as _load_error, honestly."""
    global _model, _load_error
    if _model is not None or _load_error is not None:
        return _model
    try:
        # SEAM: the exact mlx-audio loader is confirmed only on an Apple-Silicon
        # box with the model present (design §2.1 rendered via mlx-audio). Kept
        # behind the lazy load so /health still answers before a model exists.
        from mlx_audio.tts.utils import load_model  # type: ignore
        _model = load_model(MODEL_DIR)
        print(f"[qwen3-tts] model loaded ({MODEL_DIR})", flush=True)
    except Exception as e:  # noqa: BLE001 — fail-soft
        _load_error = str(e)
        print(f"[qwen3-tts] load failed: {_load_error}", flush=True)
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
            return self._json(200, {
                "ok": True, "loaded": _model is not None, "error": _load_error,
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
            return self._json(503, {"ok": False, "error": f"model-unavailable: {_load_error}"})
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


def main():
    port = DEFAULT_PORT
    if os.environ.get("QWEN_TTS_PRELOAD", "0") == "1":
        _load()
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"[qwen3-tts] listening on http://127.0.0.1:{port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
