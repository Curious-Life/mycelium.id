# Channel Inbound Media Pipeline — Design (2026-06-10)

**Status:** BUILT (steps 1–5) — gates GO: verify:ingest I8-I10, verify:model-caps 9/9, verify:attachment-context 13/13, verify:channel-inbound 33/33; live smoke = step 6 ledger in the PR

> **Hardening (MED-3, media-smoke-2 review, 2026-06-11):** PDF/DOCX extraction (`src/enrich/extract-document.js`) now runs the unpdf/mammoth parse in a throwaway `worker_thread` (`extract-document.worker.js`) under a bounded heap (`resourceLimits.maxOldGenerationSizeMb`, default 256MB / env `MYCELIUM_EXTRACT_HEAP_MB`) and is `terminate()`d on timeout. A decompression/XML bomb — a tiny docx that mammoth inflates to GBs — is now hard-killed in an isolated thread (V8 OOMs the worker, the vault survives) instead of running to completion behind a `Promise.race` ("the loser keeps running"). The 20MB attachment gate bounds INPUT; the worker bounds DECOMPRESSED output + wall-clock. Gate proof: `verify:attachment-context` A11 (570KB→~150MB bomb → null in ~0.9s, worker torn down) + A12 (timeout → terminate → null, torn down).
**Scope:** Telegram first. Photos, documents (txt/md/csv/json now; pdf/docx step 5), voice notes, audio files — downloaded from Telegram, encrypted-at-rest in the vault blob store, described/transcribed **locally** via the user's own multimodal model, linked to captured messages, and visible to the channel agent turn.
**Elevation over canonical:** canonical (`reference/core/attachments.js`) needed cloud (R2 storage, Workers AI vision, Workers AI Whisper). V1 does all three on-box: encrypted local blobs, local vision, local audio transcription — zero new egress.

## Revision history

- **v1 (sketch):** daemon downloads media and re-uses the portal multipart route `POST /api/v1/portal/upload/file`.
- **v2 (pivot 1 — route shape):** the portal route captures its own message with `source:'upload'` and no `conversationId` → wrong capture shape + double-capture risk. The **raw-bytes `POST /api/v1/upload`** (src/api.js:47, no multipart, `asMessage=false`) is the right reuse; capture stays in inbound.js where the idempotent id/senderRole live. Keyless-daemon auth is a non-issue: trusted loopback passes vaultAuth (src/http/require-vault-auth.js:80).
- **v3 (pivots 2–4, sweep/spike findings):**
  - **Pivot 2 — live bug found:** the `captureMessage` tool handler (src/tools/ingest.js:72-86) forwards only `content/role/source/conversationId/id`. The daemon's `metadata` (sender, senderRole, chatTitle, replyTo) and `createdAt` are **silently dropped** — confirmed in the live vault: every `source='telegram'` message has `metadata NULL`. Step 1 fixes the passthrough (+ `attachmentId`).
  - **Pivot 3 — vision picker is stale:** `pickVisionModel` (src/enrich/describe-image.js:17-27,61) matches a name list (`llava|vision|moondream|…`) that does NOT match `gemma4:12b` — on this very machine the existing vision path returns null even though the spike proved gemma4 describes images correctly. Replace name-matching with an Ollama `/api/show` **capabilities** probe.
  - **Pivot 4 — audio API shape:** Ollama's native `/api/chat` **silently ignores** unknown audio fields (spike: model replied "please provide the audio"). The working shape is the **OpenAI-compat** endpoint `/v1/chat/completions` with `{type:'input_audio', input_audio:{data,format}}` — spike transcribed real speech ("hello mycelium, remind me to water the plants tomorrow" → "Hello, my Celia, remind me to water the plants tomorrow") locally on gemma4:12b.

## Spike results (hard evidence, 2026-06-10)

| Probe | Result |
|---|---|
| `POST /api/chat` `images:[b64]`, gemma4:12b | ✓ correct description of generated test PNG ("a white rectangle centered on a solid red background"), 110s cold |
| `POST /api/chat` `audio:[b64]` / `audios:[b64]` | ✗ silently ignored / error — native API has no audio input |
| `POST /v1/chat/completions` `input_audio{data,format:'wav'}` | ✓ near-perfect transcription of real speech, 113s cold |
| `ollama /api/show gemma4:12b` | `capabilities: ['completion','vision','audio','tools','thinking']` |
| OGG/Opus acceptance | **UNVERIFIED** (no ffmpeg on dev machine to produce a fixture) — deferred to step 3 live smoke with a real Telegram voice note; design fails soft |

## Architecture

```
Telegram update (poller, allowed_updates:['message'] — already includes media)
  └─ normalize.js          + media descriptor {kind, fileId, fileUniqueId, fileName, mimeType, fileSize, duration}
       └─ inbound.js
            1. commands            (unchanged)
            2. authorize           (unchanged, fail-closed — media of unauthorized chats is NEVER downloaded)
            3. content guard       CHANGED: skip only if no content AND no media
            4. media stage (NEW, media.js)
                 a. size gate      (≤ CHANNEL_MEDIA_MAX_BYTES, default 20MB = Bot API getFile hard limit)
                 b. telegram.getFile(fileId) → bytes      (daemon MEMORY ONLY, never daemon disk)
                 c. POST /api/v1/upload?filename&type     → encrypted blob + attachments row → {attachmentId}
                 d. POST /api/v1/internal/attachment-context {attachmentId, kind}
                      vault: getBlob → image⇒describeImage / audio⇒transcribeAudio / text⇒utf8+clamp / pdf,docx⇒step 5
                      stores description|transcript on the attachments row (encrypted at db layer)
                      → {contextText}
                 e. msg.content = caption + "\n[Image attached: cat.jpg — «a tabby cat …»]"  (or transcript / file text)
                    — context rides msg.content, so it SURVIVES THE COALESCER (which keeps only content+turnCtx)
            5. capture             (unchanged path) + attachmentId + metadata + createdAt (passthrough fix)
            6. runTurn             (unchanged — userMessage already carries the media context; NO backend changes)
```

Every media step is **fail-soft**: download error → capture caption + `[media could not be fetched]`; no capable model → placeholder with filename (same discipline as describe-image.js); oversize → not downloaded, placeholder notes size. A media failure never blocks the text turn. The text path is byte-for-byte unchanged when no media is present.

## Threat model

- **Bytes path:** Telegram TLS → daemon memory → loopback HTTP → vault AES-256-GCM blob (`.enc`, fail-closed on missing key — blob-store.js:42,49). Bytes never touch daemon disk, never appear in logs (log only kind/size/filename-length). Plaintext crossing loopback is the SAME trust boundary `captureMessage` content already crosses.
- **New route surface:** `/api/v1/internal/attachment-context` is loopback-gated like every `/internal` route (vaultAuth via `resolveRequester` loopback path + internal-router pattern). It accepts only `{attachmentId, kind}` — no bytes, no paths — and operates on vault-owned rows for `userId` only.
- **Derived text is plaintext-sensitive:** description/transcript land in `attachments` encrypted columns (`ENCRYPTED_FIELDS.attachments = ['transcript','file_name','description','metadata']`, crypto-local.js:266) and in `messages.content` (already encrypted). Embeddings of that text follow the existing message pipeline (CLAUDE.md §7 applies as before).
- **Inference egress:** extraction is LOCAL ONLY in this design (127.0.0.1 Ollama). When the selected provider is cloud, extraction fails soft to filename placeholders — media bytes are never sent to a cloud provider without an explicit future design (deferred).
- **Group abuse:** media in groups downloads only after the group is authorized (fail-closed) — but any member of an authorized-open group can trigger a ≤20MB download + ≤2min local inference. **RESOLVED 2026-06-11 (MED-4):** the media stage is now OFFLOADED onto a bounded serial worker (`media-queue.js`) so it no longer serializes the poller, with a per-sender throttle (owner-exempt) that degrades a flooder to a placeholder (never drops). See [`CHANNEL-INBOUND-THROUGHPUT-DESIGN-2026-06-11.md`](CHANNEL-INBOUND-THROUGHPUT-DESIGN-2026-06-11.md).
- **Replay:** the poller advances offset before handling (restart = drop, not replay); message capture is idempotent on `tg-<msgId>-<chatId>`. A re-handled message would re-download and create a duplicate attachment row (message row dedups) — accepted (rare, harmless duplicate blob); `fileUniqueId` is stored in attachment metadata to make later dedup/GC possible.

## Module shape (≈ 460 LOC total ± 20%)

| File | Change | LOC |
|---|---|---|
| `src/tools/ingest.js` | captureMessage handler+schema passthrough: `attachmentId`, `metadata`, `createdAt` | ~15 |
| `src/enrich/model-caps.js` (NEW) | `pickModelWithCapability(cap, {baseUrl,fetch})` — `/api/tags` then `/api/show` per model, boot-cached; prefers the ACTIVE provider's model when it qualifies | ~60 |
| `src/enrich/describe-image.js` | swap name-list picker → capabilities probe (keep `MYCELIUM_VISION_MODEL` override + name list as fallback for old Ollama without capabilities) | ~15 |
| `src/enrich/transcribe-audio.js` (NEW) | `transcribeAudio({bytes,mimeType,model?,baseUrl?,timeoutMs})` → string\|null; OpenAI-compat `/v1/chat/completions` `input_audio` (format from mime: wav/mp3/ogg/m4a passthrough); fail-soft null | ~70 |
| `src/internal-router.js` | `POST /api/v1/internal/attachment-context` `{attachmentId, kind}` → getBlob → extract → `db.attachments.update(id,{description\|transcript})` → `{ok, contextText}` | ~55 |
| `src/db/attachments.js` | add `local_path` to `getById` SELECT (line 58 — currently missing) | ~2 |
| `packages/channel-daemon/transport/normalize.js` | media descriptor (photo: largest size; document; voice; audio) | ~30 |
| `packages/channel-daemon/telegram-api.js` | `getFile({fileId})` → getFile + `https://api.telegram.org/file/bot<t>/<path>` download → Buffer; size-gated | ~35 |
| `packages/channel-daemon/media.js` (NEW) | `contextualizeMedia(msg, {telegram, vault, cfg})` → `{attachmentId, contextText}` fail-soft; placeholder text builders | ~85 |
| `packages/channel-daemon/vault-client.js` | `uploadAttachment(bytes,{filename,type})` (raw POST), `attachmentContext({attachmentId,kind})` | ~30 |
| `packages/channel-daemon/inbound.js` | content-guard change + media stage + content assembly + attachmentId/metadata in capture | ~30 |
| `packages/channel-daemon/config.js` | `CHANNEL_MEDIA_MAX_BYTES` (20MB), `CHANNEL_MEDIA_ENABLED` (default on) | ~8 |
| verify scripts | see test strategy | ~120 |

## Edge cases — explicit decisions

| Case | Decision |
|---|---|
| Photo arrives as `m.photo[]` size array | pick the LARGEST `PhotoSize` whose `file_size` ≤ cap (Telegram thumbnails are first) |
| Media + caption | caption stays first in content; context block appended |
| Media, no caption, capture-only daemon | still captured with placeholder+attachment (capture is independent of replies) |
| Voice note OGG/Opus rejected by model | transcript null → `[Voice note attached (0:07) — transcription unavailable]`; attachment still stored; OGG acceptance verified live in step 3, optional ffmpeg transcode if present is a follow-up |
| File > 20MB | not downloaded (Bot API getFile cannot fetch it anyway); content gets `[File attached: name (34MB) — too large to import]` |
| Sticker / video / video-note / location / contact | normalize returns no media descriptor → behaves exactly as today (skipped if no caption); video deferred |
| No vision/audio-capable local model | extraction returns null → filename placeholder (same as portal uploads); message still captured + turned |
| Cloud provider selected (no local Ollama) | same as above — local-only extraction, fail-soft; cloud multimodal deferred |
| Coalescer merges media msg with text msgs | safe by construction: context is IN content before push (coalescer keeps only `parts`+`turnCtx` — coalescer.js:35-58) |
| Non-owner sender in authorized open group sends media | captured with `senderRole:'other'` like text; access policy still gates the reply |
| Replay of an already-captured message | message dedups on id; duplicate attachment row accepted (metadata carries `fileUniqueId` for future GC) |
| Daemon restart mid-download | offset already advanced → message dropped (existing semantics, unchanged) |
| Extraction slow (cold model ~2min) | ~~inline await in inbound handler (poller pauses)~~ **RESOLVED 2026-06-11 (MED-4):** offloaded to `media-queue.js` (bounded serial worker) — poller never pauses; see [`CHANNEL-INBOUND-THROUGHPUT-DESIGN-2026-06-11.md`](CHANNEL-INBOUND-THROUGHPUT-DESIGN-2026-06-11.md) |

## Test strategy

| Gate | Asserts |
|---|---|
| `verify:channel-inbound` (extend) | normalize: photo→largest-size descriptor, document/voice/audio descriptors, no-media unchanged; inbound: media stage called for authorized only; content assembly (caption+context, placeholder on null); capture carries attachmentId+metadata; fail-soft on download error (turn still runs) |
| `verify:capture-passthrough` (new, or fold into verify:ingest) | tool handler forwards metadata/createdAt/attachmentId → row has them; old callers (no new fields) unchanged |
| `verify:model-caps` (new) | capabilities probe picks vision/audio models from faked /api/tags+/api/show; override env wins; name-list fallback when /api/show lacks capabilities; cache hit |
| `verify:attachment-context` (new) | route: loopback-gated; image→describe path stores description; audio→transcribe stores transcript; text→utf8 clamp; unknown attachment 404; never throws (fail-soft null ⇒ ok:true contextText:null) — all with fake Ollama fetch + temp vault |
| `verify:transcribe-audio` (new or in above) | request body shape (input_audio, format from mime), timeout abort → null, non-200 → null |
| Live smoke (step 4 gate) | send real photo / voice note / .md file via Telegram → assistant reply references content; attachments rows present (description/transcript non-null); blob `.enc` on disk; no plaintext in logs |

## Implementation order (each step independently shippable)

1. **captureMessage passthrough fix** (standalone live-bug fix: metadata/createdAt/attachmentId) — gate: capture passthrough checks GO; smoke: send a Telegram text msg → metadata non-NULL in vault.
2. **model-caps picker + describe-image swap** — fixes vision for PORTAL uploads on gemma4-class models too; gate: `verify:model-caps` + `verify:describe-image` GO; smoke: portal-upload a PNG on this machine → `captioned:true`.
3. **transcribe-audio + attachment-context route** — gate: `verify:attachment-context` GO; smoke: `/tmp/spike.wav` through the route end-to-end + REAL Telegram-voice OGG fixture (verifies the open question).
4. **daemon media stage** (normalize, getFile, media.js, inbound, vault-client, config) — gate: `verify:channel-inbound` GO; LIVE smoke: photo + voice + md over Telegram.
5. **pdf/docx extraction** — add `unpdf` + `mammoth` (pure-JS, canonical-proven), wire into attachment-context; gate + live pdf smoke.
6. **living docs + handoff** (`/living-docs`, `/handoff-discipline`).

## Decision criteria for proceeding

Step 4 is DONE when: a photo, a voice note, and an .md file each produce (a) an `attachments` row with encrypted description/transcript, (b) an `.enc` blob under `uploadsRoot()`, (c) a captured message whose content embeds the derived text, and (d) an assistant Telegram reply that demonstrably references the media content — with `verify` chain green and zero plaintext in daemon/vault logs.

## Risks

| Risk | L | I | Mitigation |
|---|---|---|---|
| OGG/Opus unsupported by llama.cpp audio decode | M | M | fail-soft placeholder; step-3 live fixture decides; optional ffmpeg transcode follow-up |
| Cold-model extraction latency (≈2min) stalls poller | ~~M~~ | ~~L~~ | **RESOLVED 2026-06-11 (MED-4):** media stage offloaded to a bounded serial worker (`media-queue.js`); gate `verify:channel-inbound-throughput` proves a media flood doesn't stall a subsequent owner DM |
| Capabilities probe unsupported on old Ollama | L | L | name-list fallback retained |
| 20MB+ media expectations | M | L | clear placeholder text tells the user the limit |
| Duplicate attachment rows on rare replay | L | L | fileUniqueId in metadata enables GC |

## Deferred (named so they don't ambush later)

video ingestion · cloud-provider multimodal extraction · auto-document creation from text files (canonical behavior; V1 captures as message only) · group @mention-triage gate · ~~per-chat media rate budget~~ (per-sender throttle BUILT 2026-06-11, MED-4) · re-extraction backfill when a capable model is installed later · WhatsApp/Discord media (Discord normalize has no attachment parsing).

## Verification table

| # | Assumption | Verified at (read with my own eyes) |
|---|---|---|
| 1 | Daemon is keyless; vault writes must cross loopback | src/channels/supervisor.js:89-96 (env allowlist, no keys) |
| 2 | Blob store encrypts at rest, fail-closed | src/ingest/blob-store.js:42 (throw on no key), :49 (AES-GCM envelope) |
| 3 | Loopback caller passes vaultAuth (daemon can POST /api/v1/upload) | src/http/require-vault-auth.js:80; raw-bytes route src/api.js:47-67 (256MB limit) |
| 4 | getFile hard limit 20MB (Bot API) | Telegram Bot API docs (external, well-known); enforced by our size gate regardless |
| 5 | Poller already receives media updates | packages/channel-daemon/telegram-api.js:54-68 (`allowed_updates:['message']` — message updates carry photo/document/voice) |
| 6 | gemma4:12b vision via native `images`; audio ONLY via OpenAI-compat `input_audio` | live spikes 2026-06-10 (this doc, Spike results); localInfer images passthrough src/inference/local.js:63 |
| 7 | Existing describe path + its stale picker | src/enrich/describe-image.js:17-27 (name list), :94 (pickVisionModel), :98-106 (localInfer images) |
| 8 | Extraction must precede runTurn; content is the only coalescer-safe carrier | packages/channel-daemon/transport/coalescer.js:35-41 (`parts.join`), agent/lane.js:40 (`userMessage: msg.content`) |
| 9 | capture.js accepts attachmentId; tool handler currently DROPS metadata/createdAt/attachmentId | src/ingest/capture.js:84; src/tools/ingest.js:72-86; live DB: telegram messages metadata NULL |
| 10 | attachments columns + encryption + local_path; getById lacks local_path | migrations/0002_attachments_local_path.sql; crypto-local.js:266; src/db/attachments.js:58 |
| 11 | Media bytes plaintext-sensitive end-to-end | blob-store .enc on disk; ENCRYPTED_FIELDS messages.content + attachments.transcript/description (crypto-local.js:266) |
