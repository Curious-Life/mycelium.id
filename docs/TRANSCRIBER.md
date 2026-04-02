# Mycelium Transcriber — macOS Menu Bar App

> Implementation spec for a native macOS menu bar app that captures audio during calls, transcribes locally using WhisperKit, identifies speakers, and uploads transcripts to the mycelium agent-server.

**Repo:** `mycelium-transcriber` (new GitHub repo)
**Min macOS:** 14.4 (Sonoma) — required for Core Audio Taps API

---

## 1. Overview

A lightweight SwiftUI menu bar app. Click to start recording, click to stop. Audio is captured from two streams — system output ("Them") via Core Audio Taps and microphone input ("You") via AVAudioEngine. After recording stops, chunks are transcribed locally with WhisperKit (large-v3-turbo, CoreML), assembled into a speaker-labeled markdown transcript, saved locally, and uploaded to the mycelium agent-server as a library document with an optional notification to Alea.

## 2. Architecture

```
MenuBarExtra (SwiftUI)
    |
    v
AppState (ObservableObject)
    |
    +-- AudioCaptureManager
    |     +-- SystemAudioCapture (Core Audio Taps, macOS 14.4+) → "Them"
    |     +-- MicrophoneCapture (AVAudioEngine) → "You"
    |     +-- AudioChunker x2 (30s chunks, 1s overlap)
    |
    +-- TranscriptionPipeline
    |     +-- WhisperKit v0.15.0 (large-v3-turbo, CoreML, multilingual)
    |     +-- Sequential chunk processing with progress
    |     +-- Built-in VAD (voice activity detection) filters silence
    |
    +-- TranscriptAssembler
    |     +-- Sort by timestamp, deduplicate overlaps, merge consecutive same-speaker
    |     +-- MarkdownFormatter → "[00:15] **You:** ..." format
    |
    +-- Storage
    |     +-- TranscriptStore (local ~/Library/Application Support/MyceliumTranscriber/)
    |     +-- RecoveryManager (crash recovery from saved PCM chunks)
    |
    +-- ServerUploader
          +-- POST /portal/documents (3 retries, exponential backoff)
          +-- POST /portal/chat/stream (fire-and-forget, notify Alea)
          +-- Auth: Bearer token stored in Keychain
```

## 3. Key Decisions

| Decision | Choice | Why |
|---|---|---|
| **Speaker separation** | Dual audio streams (mic=You, system=Them) | Simple, no ML diarization needed for 1:1 calls |
| **Transcription engine** | WhisperKit v0.15.0 | Apple-optimized CoreML, auto model download, VAD built-in, Apple co-developing (WWDC 2025) |
| **Whisper model** | large-v3-turbo | Best accuracy/speed, multilingual, ~3x realtime on M-series, ~1.5GB |
| **System audio capture** | Core Audio Taps (macOS 14.4+) | Apple's recommended API for audio-only. No Screen Recording permission — only audio permission prompt |
| **Chunking** | 30s with 1s overlap | Matches Whisper's native segment size, overlap prevents word splitting |
| **Processing** | After recording stops (fire-and-forget) | Simpler, lower resource use during calls |
| **Model delivery** | WhisperKit auto-download from HuggingFace | Built-in model management, no manual download code |
| **Auth** | Bearer token pasted from portal | Avoids complex passkey flow in native app |

## 4. UX Flow

1. **Idle** — waveform icon (`waveform.circle`) in menu bar
2. **Click → Start Recording** — icon turns red dot (`record.circle.fill`), timer shows in dropdown
3. **Click → Stop Recording** — icon changes to spinner, progress % shown
4. **Processing complete** — checkmark icon, "Transcript saved" in dropdown
5. **Settings** (Cmd+,) — server URL, API token, notify agent toggle, model status

## 5. Project Structure

```
MyceliumTranscriber/
  MyceliumTranscriber.xcodeproj
  MyceliumTranscriber/
    App/
      MyceliumTranscriberApp.swift       — @main, MenuBarExtra
      AppState.swift                     — ObservableObject, central state machine
      MenuBarView.swift                  — Dropdown menu content
    Audio/
      AudioCaptureManager.swift          — Orchestrates dual-stream capture
      SystemAudioCapture.swift           — Core Audio Taps (system audio)
      MicrophoneCapture.swift            — AVAudioEngine (mic)
      AudioChunker.swift                 — Splits PCM buffers into timed chunks
    Transcription/
      TranscriptionEngine.swift          — WhisperKit wrapper
      TranscriptionPipeline.swift        — Chunk queue → transcribe → results
    Assembly/
      TranscriptAssembler.swift          — Merge + deduplicate speaker segments
      MarkdownFormatter.swift            — Final markdown output
    Storage/
      TranscriptStore.swift              — Local file persistence
      RecoveryManager.swift              — Crash recovery from partial state
    Network/
      ServerClient.swift                 — HTTP client for agent-server
      ServerUploader.swift               — Upload orchestration with retry
    Settings/
      SettingsView.swift                 — SwiftUI preferences window
      SettingsStore.swift                — UserDefaults + Keychain
    Resources/
      Assets.xcassets                    — Menu bar icons
    Entitlements/
      MyceliumTranscriber.entitlements
  Tests/
    AudioChunkerTests.swift
    TranscriptAssemblerTests.swift
    MarkdownFormatterTests.swift
```

## 6. Audio Pipeline

### 6.1 System Audio — Core Audio Taps (macOS 14.4+)

Core Audio Taps is Apple's recommended API for capturing system audio without requiring Screen Recording permission. Only an audio permission prompt is shown.

```swift
import CoreAudio
import AudioToolbox

class SystemAudioCapture {
    private var tapID: AudioObjectID = .init()
    private var aggregateDeviceID: AudioObjectID = .init()
    private var ioUnit: AudioComponentInstance?
    private var onAudioBuffer: ((AVAudioPCMBuffer, TimeInterval) -> Void)?

    func start(onBuffer: @escaping (AVAudioPCMBuffer, TimeInterval) -> Void) throws {
        self.onAudioBuffer = onBuffer

        // 1. Create a CATapDescription for system-wide audio
        var tapDescription = CATapDescription(stereoMixdownOfProcesses: [])
        // stereoMixdownOfProcesses: [] captures ALL system audio output

        // 2. Create the audio tap
        var tapID: AudioObjectID = 0
        var err = AudioHardwareCreateProcessTap(&tapDescription, &tapID)
        guard err == noErr else { throw AudioCaptureError.tapCreationFailed(err) }
        self.tapID = tapID

        // 3. Create aggregate device that includes the tap
        // (follow Apple's "Capturing system audio with Core Audio taps" sample)
        // ...configure aggregate device with tap as sub-device...

        // 4. Install an AudioUnit render callback that receives mixed system audio
        // 5. Resample to 16kHz mono Float32 for Whisper
    }

    func stop() {
        if let ioUnit = ioUnit {
            AudioOutputUnitStop(ioUnit)
            AudioComponentInstanceDispose(ioUnit)
        }
        AudioHardwareDestroyProcessTap(tapID)
    }
}
```

**References:**
- Apple sample: https://developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps
- Reference implementation: https://github.com/insidegui/AudioCap

**Permission:** Core Audio Taps requires only an audio permission prompt, NOT the Screen Recording permission that ScreenCaptureKit requires. The user mutes unrelated apps during calls.

### 6.2 Microphone — AVAudioEngine

Captures "what you say" via the default input device.

```swift
import AVFoundation

class MicrophoneCapture {
    private let engine = AVAudioEngine()
    private var onAudioBuffer: ((AVAudioPCMBuffer, TimeInterval) -> Void)?
    private var startTime: Date?

    /// Whisper needs 16kHz mono Float32
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 16000,
        channels: 1,
        interleaved: false
    )!

    func start(onBuffer: @escaping (AVAudioPCMBuffer, TimeInterval) -> Void) throws {
        self.onAudioBuffer = onBuffer
        self.startTime = Date()

        let inputNode = engine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)

        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            throw AudioCaptureError.formatConversion
        }

        let bufferSize: AVAudioFrameCount = 4800  // 300ms at 16kHz
        inputNode.installTap(onBus: 0, bufferSize: AVAudioFrameCount(inputFormat.sampleRate * 0.3), format: inputFormat) { [weak self] buffer, time in
            guard let self = self else { return }
            let convertedBuffer = AVAudioPCMBuffer(pcmFormat: self.targetFormat, frameCapacity: bufferSize)!
            var error: NSError?
            let status = converter.convert(to: convertedBuffer, error: &error) { _, outStatus in
                outStatus.pointee = .haveData
                return buffer
            }
            guard status != .error else { return }
            let elapsed = Date().timeIntervalSince(self.startTime ?? Date())
            self.onAudioBuffer?(convertedBuffer, elapsed)
        }

        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}
```

**Permission:** `NSMicrophoneUsageDescription` in Info.plist.

### 6.3 Audio Chunker

Each stream feeds its own `AudioChunker`. At 480,000 samples (30s at 16kHz), emit a chunk tagged with speaker + timestamp. Keep 16,000 samples (1s) overlap for context continuity.

```swift
struct AudioChunk {
    let pcmData: [Float]        // Raw PCM samples at 16kHz
    let startTime: TimeInterval // Offset from recording start
    let duration: TimeInterval
    let speaker: Speaker

    enum Speaker: String {
        case you = "You"
        case them = "Them"
    }
}

class AudioChunker {
    private let chunkDuration: TimeInterval = 30.0
    private let overlapDuration: TimeInterval = 1.0
    private let sampleRate: Double = 16000.0

    private var buffer: [Float] = []
    private var bufferStartTime: TimeInterval = 0
    private let speaker: AudioChunk.Speaker
    private let onChunk: (AudioChunk) -> Void

    private let samplesPerChunk: Int   // 480,000
    private let overlapSamples: Int    // 16,000

    init(speaker: AudioChunk.Speaker, onChunk: @escaping (AudioChunk) -> Void) {
        self.speaker = speaker
        self.onChunk = onChunk
        self.samplesPerChunk = Int(chunkDuration * sampleRate)
        self.overlapSamples = Int(overlapDuration * sampleRate)
    }

    func append(pcmBuffer: AVAudioPCMBuffer, timestamp: TimeInterval) {
        guard let channelData = pcmBuffer.floatChannelData else { return }
        let frameCount = Int(pcmBuffer.frameLength)
        let samples = Array(UnsafeBufferPointer(start: channelData[0], count: frameCount))

        if buffer.isEmpty { bufferStartTime = timestamp }
        buffer.append(contentsOf: samples)

        while buffer.count >= samplesPerChunk {
            let chunkSamples = Array(buffer.prefix(samplesPerChunk))
            let chunk = AudioChunk(
                pcmData: chunkSamples,
                startTime: bufferStartTime,
                duration: chunkDuration,
                speaker: speaker
            )
            onChunk(chunk)

            let advanceBy = samplesPerChunk - overlapSamples
            buffer.removeFirst(advanceBy)
            bufferStartTime += Double(advanceBy) / sampleRate
        }
    }

    func flush() {
        guard !buffer.isEmpty else { return }
        let duration = Double(buffer.count) / sampleRate
        guard duration > 0.5 else { return }
        let chunk = AudioChunk(
            pcmData: buffer,
            startTime: bufferStartTime,
            duration: duration,
            speaker: speaker
        )
        onChunk(chunk)
        buffer.removeAll()
    }
}
```

**During recording:** Chunks are written to disk via `RecoveryManager` for crash safety and enqueued for post-recording transcription. Only current buffer (~1MB per chunker) is in RAM.

## 7. WhisperKit Integration

WhisperKit v0.15.0 handles model management, VAD, and CoreML optimization:

```swift
import WhisperKit

class TranscriptionEngine {
    private var whisperKit: WhisperKit?

    func loadModel() async throws {
        whisperKit = try await WhisperKit(
            model: "large-v3-turbo",          // Auto-downloads from HuggingFace
            computeOptions: .init(useCoreML: true)
        )
    }

    func transcribe(chunk: AudioChunk) async throws -> [TranscriptionSegment] {
        guard let wk = whisperKit else { throw TranscriptionError.modelNotLoaded }

        let result = try await wk.transcribe(audioArray: chunk.pcmData)
        // result.segments contains timestamped text segments
        // Built-in VAD filters silence automatically

        return result.segments.compactMap { seg in
            let text = seg.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return TranscriptionSegment(
                text: text,
                startTime: TimeInterval(seg.start),
                endTime: TimeInterval(seg.end),
                language: result.language ?? "en"
            )
        }
    }
}
```

**Advantages over raw whisper.cpp:**
- **Auto model management** — downloads, caches, and loads CoreML models automatically
- **VAD built-in** — skips silence chunks without extra code
- **CoreML optimized** — uses Apple Neural Engine + GPU via CoreML, faster than Metal-only whisper.cpp
- **Apple SpeechAnalyzer fallback** — can use pre-installed Apple model while WhisperKit model downloads

### 7.1 Transcription Pipeline

```swift
struct SpeakerSegment {
    let text: String
    let speaker: AudioChunk.Speaker
    let absoluteStartTime: TimeInterval
    let absoluteEndTime: TimeInterval
    let language: String
}

class TranscriptionPipeline {
    private let engine: TranscriptionEngine
    private var pendingChunks: [AudioChunk] = []
    private var completedSegments: [SpeakerSegment] = []
    var onProgress: ((Double) -> Void)?

    func enqueue(chunk: AudioChunk) {
        pendingChunks.append(chunk)
    }

    /// Process all enqueued chunks after recording stops
    func processAll() async throws -> [SpeakerSegment] {
        try await engine.loadModel()

        let chunks = pendingChunks
        pendingChunks.removeAll()

        for (i, chunk) in chunks.enumerated() {
            let segments = try await engine.transcribe(chunk: chunk)

            let speakerSegments = segments.map { seg in
                SpeakerSegment(
                    text: seg.text,
                    speaker: chunk.speaker,
                    absoluteStartTime: chunk.startTime + seg.startTime,
                    absoluteEndTime: chunk.startTime + seg.endTime,
                    language: seg.language
                )
            }
            completedSegments.append(contentsOf: speakerSegments)

            let progress = Double(i + 1) / Double(chunks.count)
            await MainActor.run { onProgress?(progress) }
        }

        return completedSegments
    }
}
```

**Performance:** 2-hour call = ~480 chunks (240/stream). At ~3-5s/chunk on Apple Silicon, total processing ~25-40 min. Progress bar makes this visible.

## 8. Transcript Assembly

### 8.1 Assembler

1. All segments (both speakers) sorted by absolute timestamp
2. Deduplicate: same speaker, overlapping time (within 1.5s), >80% word overlap → keep first
3. Merge consecutive: same speaker, gap < 2s → combine into one paragraph

```swift
class TranscriptAssembler {
    func assemble(segments: [SpeakerSegment]) -> [TranscriptEntry] {
        let sorted = segments.sorted { $0.absoluteStartTime < $1.absoluteStartTime }
        let deduped = deduplicateOverlaps(sorted)
        let merged = mergeConsecutive(deduped)
        return merged
    }

    private func deduplicateOverlaps(_ segments: [SpeakerSegment]) -> [SpeakerSegment] {
        var result: [SpeakerSegment] = []
        for segment in segments {
            if let last = result.last,
               last.speaker == segment.speaker,
               abs(last.absoluteStartTime - segment.absoluteStartTime) < 1.5,
               textSimilarity(last.text, segment.text) > 0.8 {
                continue  // Skip duplicate
            }
            result.append(segment)
        }
        return result
    }

    private func mergeConsecutive(_ segments: [SpeakerSegment]) -> [TranscriptEntry] {
        var entries: [TranscriptEntry] = []
        for segment in segments {
            if let lastIndex = entries.indices.last,
               entries[lastIndex].speaker == segment.speaker.rawValue,
               segment.absoluteStartTime - entries[lastIndex].endTime < 2.0 {
                // Merge into previous
                entries[lastIndex] = TranscriptEntry(
                    speaker: entries[lastIndex].speaker,
                    text: entries[lastIndex].text + " " + segment.text,
                    startTime: entries[lastIndex].startTime,
                    endTime: segment.absoluteEndTime,
                    language: segment.language
                )
            } else {
                entries.append(TranscriptEntry(
                    speaker: segment.speaker.rawValue,
                    text: segment.text,
                    startTime: segment.absoluteStartTime,
                    endTime: segment.absoluteEndTime,
                    language: segment.language
                ))
            }
        }
        return entries
    }
}
```

### 8.2 Markdown Formatter

Output format:

```markdown
# Standup Call — Feb 28, 2026

**Date:** February 28, 2026 at 10:30 AM
**Duration:** 45:23
**Languages:** English, Icelandic

---

[00:15] **You:** Good morning, how's everything going?

[00:22] **Them:** Hey, morning! Pretty good, been working on the new feature...

[01:05] **You:** Nice. I had a question about the API changes...
```

## 9. Server Integration

**No new endpoints needed for v1.** Uses existing mycelium agent-server API.

### 9.1 Authentication

Bearer token in `Authorization` header. Token stored in macOS Keychain. Validated via `GET /auth/session`.

For v1, user extracts token from browser dev tools or portal exposes a "Generate API Token" button.

### 9.2 Upload Transcript — `POST /portal/documents`

```json
POST /portal/documents
Authorization: Bearer {token}
Content-Type: application/json

{
  "path": "transcriptions/2026-02-28-standup-call",
  "title": "Standup Call — Feb 28, 2026",
  "content": "# Standup Call...\n\n[00:15] **You:** ...",
  "source_type": "transcription"
}
```

Maps to `agent-server.js` line ~4485. The `documents.upsert()` in `lib/db-d1.js` accepts `source_type` as a passthrough column.

### 9.3 Notify Agent — `POST /portal/chat/stream`

```json
POST /portal/chat/stream
Authorization: Bearer {token}
Content-Type: application/json

{
  "prompt": "I just finished a call. Transcript saved as 'Standup Call' at path 'transcriptions/2026-02-28-standup-call'. Please extract action items, decisions, and key topics.",
  "source": "transcriber-app"
}
```

Fire-and-forget: read first SSE event (`stream_start`) to confirm acceptance, then disconnect.

### 9.4 Upload Logic — ServerUploader

```swift
class ServerUploader {
    func upload(transcript: String, metadata: RecordingMetadata) async -> UploadResult {
        guard let config = settings.serverConfig else {
            return UploadResult(documentUploaded: false, agentNotified: false, error: nil)
        }

        let client = ServerClient(config: config)
        let docPath = "transcriptions/\(datestamp)-\(slug)"

        // Step 1: Upload document with 3 retries + exponential backoff
        var documentUploaded = false
        for attempt in 1...3 {
            do {
                try await client.uploadTranscript(path: docPath, title: metadata.title, content: transcript)
                documentUploaded = true
                break
            } catch {
                if attempt < 3 {
                    try? await Task.sleep(nanoseconds: UInt64(attempt) * 2_000_000_000)
                }
            }
        }

        // Step 2: Notify agent (best-effort, single attempt)
        var agentNotified = false
        if documentUploaded && settings.notifyAgent {
            do {
                try await client.notifyAgent(transcriptPath: docPath, title: metadata.title)
                agentNotified = true
            } catch { /* Non-fatal */ }
        }

        return UploadResult(documentUploaded: documentUploaded, agentNotified: agentNotified, error: nil)
    }
}
```

## 10. Storage & Recovery

### 10.1 Local Transcript Store

```
~/Library/Application Support/MyceliumTranscriber/
  transcripts/           — Saved markdown files
  recovery/              — PCM chunks + state for crash recovery
  models/                — WhisperKit model cache (auto-managed)
```

Transcripts always saved locally first. Upload is best-effort on top.

### 10.2 Recovery Manager

During recording, chunks are saved to disk as they're emitted. A state file tracks the recording ID, start time, chunk references, and completion status.

**On launch:** `RecoveryManager.checkForRecovery()` checks for incomplete recordings. If found, offer to resume transcription from saved PCM chunks.

**State saved every 10 chunks (~5 min of audio)** — at most ~5 min of audio lost on crash.

## 11. Settings

**Settings view (Cmd+,):**

- **Server URL** — text field (e.g., `https://mycelium.example.com:3004`)
- **API Token** — secure field, stored in Keychain
- **Validate Connection** — button, calls `GET /auth/session`
- **Notify AI agent after transcription** — toggle
- **Launch at login** — toggle (SMAppService)
- **Auto-generate title from transcript** — toggle
- **Model status** — download progress, ready state, file size

## 12. Data Flow — Complete Recording Lifecycle

```
User clicks "Start Recording"
    |
    v
[1] Request permissions (Audio Tap + Microphone)
    |-- Denied? → Show error with link to System Settings
    |
    v
[2] Initialize AudioCaptureManager
    |-- Create SystemAudioCapture (Core Audio Taps)
    |-- Create MicrophoneCapture (AVAudioEngine)
    |-- Create AudioChunker x2 (one per speaker)
    |-- Create RecoveryManager, generate recordingId
    |
    v
[3] Start capture (both streams simultaneously)
    |
    |   SystemAudioCapture.onBuffer ──→ AudioChunker("Them").append()
    |   MicrophoneCapture.onBuffer  ──→ AudioChunker("You").append()
    |                                           |
    |   AudioChunker emits 30s chunks ────→ RecoveryManager.saveChunk()
    |                                  +──→ TranscriptionPipeline.enqueue()
    |
    v
User clicks "Stop Recording"
    |
    v
[4] Stop both audio streams
    |-- SystemAudioCapture.stop()
    |-- MicrophoneCapture.stop()
    |-- AudioChunker.flush() x2 (emit remaining audio)
    |
    v
[5] AppState → .processing(progress: 0.0)
    |-- Load WhisperKit model (if not already loaded)
    |-- Process all chunks sequentially
    |-- Update progress as each chunk completes
    |
    v
[6] Assemble transcript
    |-- TranscriptAssembler.assemble(segments)
    |--   Sort by time, deduplicate overlaps, merge consecutive
    |-- MarkdownFormatter.format(entries, metadata)
    |
    v
[7] Save locally
    |-- TranscriptStore.save(markdown, filename)
    |
    v
[8] Upload to server (AppState → .uploading)
    |-- ServerUploader.upload(transcript, metadata)
    |--   POST /portal/documents (3 retries with backoff)
    |--   POST /portal/chat/stream (single attempt, best-effort)
    |
    v
[9] AppState → .complete(transcriptPath)
    |-- Clean up recovery data
    |-- Menu bar icon → checkmark (reverts to idle after 10s)
```

## 13. Edge Cases

| Scenario | Handling |
|---|---|
| **2+ hour calls** | Chunks saved to disk (~460MB/stream). Processing ~25-40min. Progress bar shown. |
| **App crash during recording** | RecoveryManager saves PCM chunks + state. On relaunch, offers to resume. |
| **App crash during processing** | Pipeline re-runs on saved PCM chunks. Skip already-processed chunks. |
| **Upload failure** | Transcript always saved locally first. 3 retries with backoff. Pending uploads tracked. |
| **Audio device change** | Handle `AVAudioEngineConfigurationChange`, re-install tap. Core Audio Taps handles gracefully. |
| **Permission denied** | Actionable error with button to open System Settings. |
| **Model not ready** | WhisperKit auto-downloads on first use. Show progress in Settings. Apple SpeechAnalyzer fallback while downloading. |
| **Model corrupted** | Verify file size on load. Delete and re-download if corrupt. |

## 14. Entitlements & Permissions

**MyceliumTranscriber.entitlements:**

```xml
<dict>
    <key>com.apple.security.app-sandbox</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
    <key>com.apple.security.network.client</key>
    <true/>
    <key>com.apple.security.files.user-selected.read-write</key>
    <true/>
</dict>
```

**Info.plist:**

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Mycelium Transcriber needs microphone access to capture your voice during calls.</string>
```

No `NSScreenCaptureUsageDescription` needed — Core Audio Taps uses an audio-only permission, not Screen Recording.

## 15. Build Requirements

- **Xcode 15+**, macOS 14.4+ deployment target
- **SPM:** `WhisperKit` v0.15.0 (https://github.com/argmaxinc/WhisperKit)
- **Apple Silicon** recommended (CoreML Neural Engine acceleration). Intel supported but significantly slower.

## 16. Server-Side Changes

Two small additions to the mycelium codebase:

### 16.1 Library source label

In `portal/src/routes/(app)/library/+page.svelte`, add to `getSourceLabel()`:

```typescript
case 'transcription': return 'Call Transcript';
```

### 16.2 API token endpoint (optional convenience)

```javascript
// POST /portal/api-tokens — generate a long-lived session token
app.post('/portal/api-tokens', async (req, res) => {
    const user = await authenticatePortalRequest(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const db = tryGetDb();
    await db.sessions.create({ token, user_id: user.id, expires_at: expiresAt });
    res.json({ token, expiresAt });
});
```

For v1, the user can extract their session token from the browser dev tools instead.

## 17. Testing Strategy

| Component | Test Type | What to Verify |
|---|---|---|
| `AudioChunker` | Unit | Correct chunk boundaries, overlap handling, flush behavior |
| `TranscriptAssembler` | Unit | Time-sorted merging, de-duplication, consecutive speaker merging |
| `MarkdownFormatter` | Unit | Correct timestamp formatting, header metadata, edge cases |
| `ServerClient` | Integration | Auth header, response parsing, error codes |
| `RecoveryManager` | Unit | State persistence, chunk save/load, cleanup |
| Full pipeline | Integration | Record 30s test audio, transcribe, verify output format |

## 18. Implementation Order

1. Create repo + Xcode project + menu bar shell with state machine
2. Core Audio Taps system audio capture
3. AVAudioEngine mic capture
4. AudioChunker with disk persistence
5. WhisperKit integration + TranscriptionEngine
6. TranscriptionPipeline (sequential processing with progress)
7. TranscriptAssembler + MarkdownFormatter
8. Local storage (TranscriptStore + RecoveryManager)
9. Settings view + Keychain token storage
10. ServerClient + ServerUploader
11. Server-side: source label + optional API token endpoint
12. Testing + polish

## 19. Future Enhancements (Out of Scope for v1)

1. **App-specific audio capture** — let user pick a specific app (Zoom, Meet) via window picker
2. **Real-time transcription** — process chunks during recording, show live preview
3. **Global keyboard shortcut** — start/stop without opening menu
4. **Calendar integration** — auto-detect meeting title from calendar events
5. **Smaller models** — quality/speed tradeoff with base or small models
6. **On-device summarization** — use Apple Intelligence or local LLM for immediate action items
