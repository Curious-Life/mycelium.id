# Local TTS for Telegram voice replies — Design (2026-06-16)

**Goal:** voice replies on Telegram using a **local** TTS model (zero cloud egress), as the on-box counterpart to the local Whisper transcription. Adds a `kokoro` provider to the existing TTS pipeline.

## Sweep findings (verified, file:line)
- **Outbound voice infra is ~85% built** in `packages/channel-daemon/tts/`: provider contract [providers/_interface.js](../packages/channel-daemon/tts/providers/_interface.js), registry [providers/registry.js](../packages/channel-daemon/tts/providers/registry.js), selection/voice [config.js](../packages/channel-daemon/tts/config.js), `synthesizeForTelegram` [index.js](../packages/channel-daemon/tts/index.js). Providers today: `openai`, `elevenlabs` (both cloud).
- **The channel-daemon is LIVE in V1** — supervised by `startChannelSupervisor` ([src/channels/supervisor.js], wired at [src/server-rest.js:393](../src/server-rest.js)). It owns Telegram I/O + the voice pipeline + `sendVoice`. Loopback support endpoints for it live in [src/internal-router.js](../src/internal-router.js).
- **Telegram `sendVoice` already wired** (multipart OGG/Opus, ≤20 MB), as is the reply `voice:true` flag, the send-handler voice branch, and `voice-pipeline.deliver()`.
- **Provider contract** ([_interface.js](../packages/channel-daemon/tts/providers/_interface.js)): `{ name, maxChars, defaultVoice, isConfigured(), synthesize(text,voice,opts) → { audio:Buffer, format:'opus'|'mp3'|'wav', voiceUsed, bytesIn, bytesOut } }`.
- **Selection** ([config.js:39](../packages/channel-daemon/tts/config.js)): `TTS_PROVIDER` explicit (fail-closed if misconfigured) else `PROVIDER_FALLBACK_ORDER`. `resolveVoice` reads `TTS_VOICE_<AGENT>` / `<PROVIDER>_TTS_VOICE` / `provider.defaultVoice`.
- **THE codec decision — pure-JS, NOT ffmpeg.** The shared encoder [shared/remux.js](../packages/channel-daemon/tts/shared/remux.js) shells out to `ffmpeg`, but that's **canonical-ported code that violates the V1 principle**. [src/enrich/ogg-opus.js:6](../src/enrich/ogg-opus.js) states it verbatim: *"V1 must not depend on a system binary"* — inbound decodes OGG/Opus→WAV in pure JS via **prism-media `OggDemuxer` + `opusscript`** (libopus compiled to JS). **ffmpeg is NOT installed on the target Mac.** ⇒ outbound must do the mirror: **WAV→OGG/Opus in pure JS** (`opusscript` encode + a hand-written RFC 7845 Ogg muxer).
- **Local model = Kokoro-82M** (Apache-2.0, ~82M params, fast on Apple-Silicon CPU, 54 voices) — best quality-per-size; served as an own minimal loopback service mirroring [pipeline/transcribe-service.py] + [pipeline/embed-service.py] (NOT Kokoro-FastAPI — consistency + supervision parity).

## Architecture
```
reply(voice:true) → channel-daemon send-handler → voice-pipeline.deliver()
   → tts.synthesizeForTelegram(text)              [packages/channel-daemon/tts]
       → resolveProvider() = kokoroProvider        [new]
       → kokoro.synthesize(text, voice)            [new] POST loopback → WAV (24k mono)
       → wavToOggOpus(wav)                          [new, PURE-JS] → OGG/Opus (48k mono 32k VOIP)
   → telegram.sendVoice(oggOpusFile)               [existing]
```
Local model service (new, supervised like embed/transcribe):
```
kokoro-service.py  --serve --port 8094   (loopback 127.0.0.1)
   POST /tts   { text, voice }  → audio/wav (s16le 24kHz mono)
   GET  /health
```

## Components (new)
1. **`pipeline/kokoro-service.py`** — `pip kokoro` (+ `soundfile`/`numpy`); load model once; `/tts` returns WAV bytes; `/health`. Mirrors transcribe-service.py boot/threading/Content-Length-cap.
2. **Supervisor + client** — mirror `src/embed/supervisor.js` + `src/embed/client.js`: spawn/health/restart-backoff the python child; a `createTtsClient({baseUrl})` with `synth(text,voice)`. Lives where the channel-daemon can reach it (loopback HTTP, so no import coupling).
3. **`src/audio/wav-to-ogg-opus.js`** (pure-JS, the mirror of `ogg-opus.js`) — parse WAV → s16le PCM; resample 24k→48k (linear, mono); `opusscript` encode in 20 ms frames (960 samp @48k); **Ogg muxer** (OggS pages, CRC32 poly 0x04c11db7, OpusHead + OpusTags + audio pages, granulepos). Returns a Telegram-spec OGG/Opus Buffer. Fail-soft → null.
4. **`packages/channel-daemon/tts/providers/kokoro.js`** — `name:'kokoro'`, `maxChars` (chunk ~1000), `defaultVoice:'af_heart'`, `isConfigured()` = `KOKORO_TTS_URL` set / service flag, `synthesize()` → loopback `/tts` → `{ audio:wav, format:'wav', … }`.
5. **Registry + config** — register `kokoro` in [registry.js](../packages/channel-daemon/tts/providers/registry.js) (+ fallback order), add a `kokoro` branch to `resolveVoice` (`KOKORO_TTS_VOICE`).
6. **voice-pipeline / synth glue** — when provider `format==='wav'`, route through `wavToOggOpus` (pure-JS) instead of `remux.js` (ffmpeg). Keep ffmpeg path only as a last-resort fallback for cloud mp3 if ever needed (but prefer pure-JS).
7. **Settings** — extend `/settings/tts` ([src/portal-settings.js](../src/portal-settings.js)) with `kokoro` (enabled, voice) + a **per-channel "reply as voice" toggle** (a `secrets` key, e.g. `TTS_VOICE_REPLY_TELEGRAM=on`).

## Open decisions (resolved by codebase principles — no operator gate)
- **Encode: pure-JS** (V1 "no system binary" principle) — NOT ffmpeg. ✔
- **Service: own minimal kokoro-service.py** (parity with embed/transcribe) — NOT Kokoro-FastAPI. ✔
- **Model: Kokoro-82M** (best quality/size, Apache-2.0). ✔

## Verification gates
- `verify:wav-to-ogg-opus` — round-trip: synth a known PCM → `wavToOggOpus` → `oggOpusToWav` (the inbound decoder) recovers comparable PCM; output starts with `OggS`; Telegram geometry (48k mono).
- `verify:tts-kokoro` — provider `isConfigured`/`synthesize` against a stub service; fail-soft on service down.
- **Live smoke** — `npm run smoke:telegram-live --voice` (existing) end-to-end with a real Telegram bot once the service is up.

## Implementation order (each independently shippable)
1. `wav-to-ogg-opus.js` + gate (round-trip vs the existing decoder) — the novel/risky piece, fully testable offline. ← start here
2. `kokoro-service.py` + supervisor/client + `/health` smoke (pip kokoro on the box).
3. `kokoro` provider + registry/config + gate.
4. voice-pipeline glue (format:'wav' → pure-JS encode).
5. Settings (kokoro config + per-channel voice toggle).
6. Live Telegram voice-reply smoke.

## Risks
| Risk | Mitigation |
|---|---|
| Ogg muxer correctness (CRC/granulepos) | Round-trip gate against the proven inbound decoder; fail-soft → null |
| Kokoro install weight (espeak-ng dep, model DL) | Service is opt-in; `isConfigured` false until present → no regression |
| Bundle: pip kokoro + model into the Tauri app | Stage like Nomic model in build-app-bundle.sh (follow-up; dev works from pip first) |
| `opusscript` encode API parity with decode usage | Verify encode signature; it's the same lib already shipped for inbound |
