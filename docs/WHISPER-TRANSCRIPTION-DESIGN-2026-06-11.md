# Dedicated Whisper transcription — design

**Date:** 2026-06-11 · **Status:** locked, implementing
**Trigger:** voice transcription today rides the chat LLM's `audio` capability (src/enrich/transcribe-audio.js) — it only exists when the selected model happens to be audio-capable, and it is slow (~7s voice note → >180s cold on a 12B model; 300s budget). Operator call: a separate "Transcription" section that prompts downloading a stable Whisper model; once present, transcription uses it.

## Revision history

- v1 (operator sketch): "download whisper when the user selects their AI; use it for transcription."
- v2 (post-sweep): runtime = **faster-whisper (CTranslate2)**, NOT raw ONNX (whisper ONNX needs custom mel-spectrogram + decoder loop — unmaintainable DSP) and NOT whisper.cpp (per-arch binary ops surface). Feed it raw PCM float32 decoded from our own WAV (stdlib `wave` + scipy `resample_poly` 48k→16k) so faster-whisper's PyAV path is never exercised. Service is a NEW process (`transcribe-service.py`), not folded into embed-service — embedding is critical-path and must not share a crash domain with a 1.5GB model load. Download progress via **health-poll** (HF hub has no clean per-chunk callback; a tqdm subclass updates a global, UI polls) instead of SSE.

## Sweep findings (load-bearing)

- Pattern source: `pipeline/embed-service.py` (loopback :8091, `hf_hub_download`, `/health` with loading state) + `src/embed/supervisor.js` (spawn via `MYCELIUM_PYTHON`→`pipeline/.venv`→`python3`, env allowlist PATH/HOME/HF_HOME/HF_HUB_OFFLINE, health states `ok|loading|starting|error|deps_missing|down`, backoff cap 30s).
- venv probe (2026-06-11): onnxruntime 1.20.1 ✓, tokenizers ✓, huggingface-hub ✓, scipy ✓ (requirements.txt), **faster_whisper absent** → new `requirements-transcribe.txt`, supervisor surfaces `deps_missing` (actionable) when absent — fail-soft to the LLM path.
- WAV input contract: `src/enrich/ogg-opus.js` outputs 48kHz mono s16le with a 44-byte RIFF header — python `wave` reads it; whisper wants 16k float32 → `scipy.signal.resample_poly(x, 1, 3)`.
- UI pattern: AISettings.svelte lanes + `pullAndUse` SSE reader (`/portal/hardware/pull`); onboarding Intelligence step mirrors it collapsed. Settings persistence: `users.settings` JSON for non-secret choices (`db.users.getSettings/updateSettings`).
- Enrich wiring: channel-daemon → `POST /api/v1/internal/attachment-context` → `transcribeAudio()` (internal-router.js:302-359). The preference seam is INSIDE `transcribeAudio` — callers unchanged.

## Module shape (~600 LOC total)

1. **`pipeline/transcribe-service.py`** (~220 LOC): loopback HTTP, `--serve --port` (default 8093).
   - `GET /health` → `{status: 'ok'|'loading'|'downloading'|'no_model'|'error', model, progress?: {pct}}`
   - `POST /download {model}` → starts a background `snapshot_download` thread (custom tqdm_class → global pct); 409 if busy. `HF_HUB_OFFLINE` is unset for this call only.
   - `POST /transcribe` (body: WAV bytes or `{wav_base64}`) → `{text, language, ms}`. Decodes WAV via stdlib, resamples 48k→16k (scipy), `WhisperModel(model, device='cpu', compute_type='int8')` loaded lazily under a lock.
   - Model ids: size aliases resolved by faster-whisper (`large-v3-turbo` recommended ≥16GB RAM, `small` light option). Chosen model persisted node-side; service receives it via `/download` + `MYCELIUM_WHISPER_MODEL` env on spawn.
2. **`src/transcribe/supervisor.js`** (~150 LOC): clone of embed supervisor (spawn, probe, backoff, `getTranscriberHealth()`); only starts when `users.settings.transcribeModel` is set OR a model is already in the HF cache (no idle python process for users who never opted in). Exposes `transcribeServiceUrl()`.
3. **`src/portal-transcription.js`** (~90 LOC): `GET /portal/transcription/status` (supervisor health + chosen model + catalog [turbo, small] with RAM-based `recommended`), `POST /portal/transcription/download {model}` (persists choice, ensures supervisor up, proxies `/download`), auth like other portal routers.
4. **`src/enrich/transcribe-audio.js`** (+~35 LOC): try Whisper service FIRST (health ok → POST WAV, 120s budget), fall back to the existing audio-capable-LLM path, then null. Same NEVER-throw contract.
5. **UI** (~120 LOC): AISettings "Voice transcription" section (status line, two model cards with ★ recommended, download with polled progress, "uses your chat model (slow)" before setup); onboarding Intelligence step gets a one-line CTA variant.
6. **Gate** `scripts/verify-transcribe-service.mjs`: supervisor states (deps_missing path), REST status/download validation (mock service), transcribe-audio preference order (mock fetch: whisper-first, LLM fallback, null).

## Threat model

- Bytes: loopback-only (127.0.0.1:8093), never logged — same as embed-service (§1).
- New egress: model weights download from HuggingFace on explicit user action (same class as Ollama pulls / nomic auto-download). No vault data leaves; audio never leaves the box.
- Fail-closed/fail-soft: no model/no deps/service down → existing LLM path → placeholder; transcription failures never block capture.

## Edge cases — decisions

- Deps absent in dev venv → `deps_missing` health, UI shows actionable hint; `requirements-transcribe.txt` documented (bundle parity noted for the Tauri build, arm64 wheels exist for ctranslate2/av).
- Download interrupted/app restart → HF cache resumes; service re-reports `downloading`/`no_model` honestly.
- Model switch (turbo→small) → `/download` for the new size; `transcribeModel` setting updated; service reloads lazily.
- Long audio: cap input at existing media maxBytes; whisper handles minutes-long audio fine within a 120s budget for typical notes (budget configurable `MYCELIUM_WHISPER_TIMEOUT_MS`).
- `HF_HUB_OFFLINE=1` in bundled env: `/download` clears it for its own thread only; `/transcribe` honors cache-only.

## Test strategy

- Hermetic gate (above) — no model download in CI.
- Live e2e (dev box): `pip install faster-whisper` into venv → download `small` → synthesize speech with macOS `say` → WAV → `/transcribe` returns the spoken text → then a real Telegram voice note end-to-end.

## Verification table

| Assumption | Verified at |
|---|---|
| Current transcription = LLM `audio` capability, 300s budget | src/enrich/transcribe-audio.js:51-114 (read) |
| Capability probe + prefer-active-model | src/enrich/model-caps.js (read) |
| WAV from ogg-opus = 48kHz mono s16le + RIFF | src/enrich/ogg-opus.js wavHeader (sweep, quoted) |
| Supervisor pattern (spawn/env/health/backoff) | src/embed/supervisor.js:46-125 (sweep, quoted) |
| venv: onnxruntime/tokenizers/hf-hub present; faster-whisper absent; scipy present | live probe 2026-06-11 + pipeline/requirements.txt |
| UI pull pattern (SSE reader) + settings persistence (users.settings JSON) | AISettings.svelte:160-199, portal-providers.js (sweep, quoted) |
| Enrich seam: internal-router → transcribeAudio; daemon waits ≤420s | src/internal-router.js:302-359, vault-client.js:86-103 (sweep, quoted) |
| Telegram voice flow live-works via LLM path today | CHANNEL-INBOUND-MEDIA design + 2026-06-10 live spike |

## Deferred

- Cloud STT fallback (BYOK OpenAI/Groq whisper API) — separate decision, egress-sensitive.
- Onboarding step beyond the one-line CTA; auto-prompt after first voice note arrives ("Download Whisper for fast transcripts?").
- TTS voice-reply model section (same UX family).
