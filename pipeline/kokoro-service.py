#!/usr/bin/env python3
# pipeline/kokoro-service.py — local Text-to-Speech, the on-box counterpart to
# transcribe-service.py. Kokoro-82M via kokoro-onnx (onnxruntime — same runtime
# as embed-service.py's Nomic; NO torch, ~300MB model). Loopback-only, no
# secrets. Returns 24kHz mono s16le WAV; the Node side encodes OGG/Opus in pure
# JS (src/audio/wav-to-ogg-opus.js) — zero cloud egress, no ffmpeg.
#
#   POST /tts   {"text": "...", "voice": "af_heart", "speed": 1.0}  -> audio/wav
#   GET  /health -> {"ok": true, "loaded": bool, "model": "kokoro-82m"}
#
# Mirrors transcribe-service.py: lazy single load, ThreadingHTTPServer on
# 127.0.0.1, Content-Length cap before read, NEVER throw across the boundary.
import io
import os
import json
import wave
import struct
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = int(os.environ.get("MYCELIUM_KOKORO_PORT") or 8094)
MAX_BODY = 256 * 1024          # text payload cap (loopback DoS guard)
SAMPLE_RATE = 24000            # Kokoro native rate
DEFAULT_VOICE = os.environ.get("KOKORO_TTS_VOICE") or "af_heart"
MODEL_PATH = os.environ.get("KOKORO_MODEL_PATH") or "kokoro-v1.0.onnx"
VOICES_PATH = os.environ.get("KOKORO_VOICES_PATH") or "voices-v1.0.bin"

_kokoro = None
_load_error = None


def _load():
    """Lazy single load — first /tts pays the model-load cost, then it's warm."""
    global _kokoro, _load_error
    if _kokoro is not None or _load_error is not None:
        return _kokoro
    try:
        from kokoro_onnx import Kokoro
        _kokoro = Kokoro(MODEL_PATH, VOICES_PATH)
        print(f"[kokoro-service] model loaded ({MODEL_PATH})", flush=True)
    except Exception as e:  # noqa: BLE001 — fail-soft; /tts returns 503, never crashes
        _load_error = str(e)
        print(f"[kokoro-service] load failed: {_load_error}", flush=True)
    return _kokoro


def _float_to_wav(samples, rate):
    """float32 [-1,1] mono -> 16-bit PCM WAV bytes."""
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
            return self._json(200, {"ok": True, "loaded": _kokoro is not None, "error": _load_error, "model": "kokoro-82m"})
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
        voice = req.get("voice") or DEFAULT_VOICE
        speed = float(req.get("speed") or 1.0)
        lang = req.get("lang") or "en-us"

        k = _load()
        if k is None:
            return self._json(503, {"ok": False, "error": f"model-unavailable: {_load_error}"})
        try:
            samples, rate = k.create(text, voice=voice, speed=speed, lang=lang)
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
    if os.environ.get("KOKORO_PRELOAD", "0") == "1":
        _load()
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"[kokoro-service] listening on http://127.0.0.1:{port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
