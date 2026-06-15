# Channel Inbound Throughput — Design (2026-06-11)

**Status:** DESIGN → BUILT (this session). Addresses **MED-4** from the media-smoke-2 adversarial review (`memory/media-smoke-2-security-review.md`).
**Scope:** Telegram channel-daemon inbound path. Stop heavy media contextualization from blocking the poller's offset advance, and add a per-sender inbound throttle that **degrades to a placeholder** (never drops an owner message). No vault/backend changes; no new egress.

## Problem (as reported)

The daemon processes inbound **serially**: the poller `await`s `handleInbound`
([transport/telegram-poller.js:46](../packages/channel-daemon/transport/telegram-poller.js)),
and `handleInbound` `await`s the media stage `contextualizeMedia`
([inbound.js:109](../packages/channel-daemon/inbound.js)). The media stage's worst
case is a 20MB download (≤120s, [telegram-api.js getFile](../packages/channel-daemon/telegram-api.js))
plus a vault attachment-context call whose daemon-side budget is **660s**
([vault-client.js:94](../packages/channel-daemon/vault-client.js)) backing a vault
vision/transcription budget. There is **no inbound rate limit** — the limiter in
[ratelimit.js](../packages/channel-daemon/ratelimit.js) is **outbound-only**, used
only in [egress/send-handler.js:125](../packages/channel-daemon/egress/send-handler.js).

So one authorized sender (e.g. a member of an authorized group) streaming voice
notes/images occupies the **only poll slot** for minutes each, serializing and
stalling ALL inbound — including owner DMs and `/disallow` commands. The offset
has already advanced (poller.js:43), but the next `getUpdates` cannot fire until
the current `pollOnce` returns, which waits on every `await handleInbound` in the
batch. Updates queue server-side; the backlog compounds.

## Key sweep findings (load-bearing, read with my own eyes)

1. **The poller already advances the offset before handling** — `offset = maxUpdateId(updates)+1` at [poller.js:43](../packages/channel-daemon/transport/telegram-poller.js), *before* the `for…await handleInbound` loop. So the stall is **not** a missing offset advance; it is that the loop (and therefore the next `getUpdates`) blocks on each `await handleInbound`.

2. **`runTurn` is already non-blocking.** It enqueues onto the lane's serial `tail` chain and returns `Promise.resolve()` ([lane.js:66-71](../packages/channel-daemon/agent/lane.js)); with coalescing on (default), `effectiveRunTurn` is `coalescer.push` which also returns immediately ([index.js:70-75](../packages/channel-daemon/index.js)). **The only multi-minute blocker inside `handleInbound` is `contextualizeMedia`.**

3. **The lane is the canonical in-process offload pattern.** `createLane` is a serial `tail = tail.then(execute)` chain with an `idle()` drain seam ([lane.js:31, 66-74](../packages/channel-daemon/agent/lane.js)). The media queue mirrors it exactly — no new cross-process pattern is introduced (per the sweep-first rule: there is no fourth state pattern).

4. **The media stage is already fail-soft and never throws** ([media.js:62, 71-101](../packages/channel-daemon/media.js)); it returns `{attachmentId, contextLine}`. Download+upload (seconds) is *not* currently separable from extraction (minutes) — all four stages run in one function. The degrade path therefore **skips the whole media stage** (cheapest, no download) rather than trying to split it.

5. **Capture metadata already records media even without a blob** — the capture `metadata` block sets `mediaKind` + `fileUniqueId` from `msg.media` ([inbound.js:133](../packages/channel-daemon/inbound.js)) regardless of whether extraction ran. So a degraded message still carries enough for a future backfill.

6. **Existing media unit tests call `createInboundHandler` with no queue and expect inline media** (M5-M10, ME1-5 in [scripts/verify-channel-inbound.mjs:140-240](../scripts/verify-channel-inbound.mjs)). The offload **must be opt-in**: inline when no `mediaQueue` dep is wired, offloaded when it is.

## Revision history

- **v1 (sketch, from the MED-4 brief):** option (a) advance offset before the media stage + bounded worker queue + re-capture/patch the message when text is ready; OR option (b) per-fromId token bucket that skips extraction under flood.
- **v2 (pivot 1 — no patching needed):** the brief's "re-capture/patch when text is ready" assumes capture must happen *before* extraction. The sweep shows there is **no such requirement** — the only reason text must precede capture is that `msg.content` is the coalescer-safe carrier, and that ordering is preserved by doing the *entire tail* (media → content → capture → turn) inside the worker job. Capture-then-patch would also require `captureMessage` to be an upsert that overwrites content on duplicate id, which is **unverified** (the design only guarantees id-dedup). So: **single capture after extraction, inside the worker** — no patch, no upsert dependency. The restart-during-queue drop is the *same class* as today's already-accepted restart-during-extraction drop (media design edge case "Daemon restart mid-download → message dropped").
- **v3 (pivot 2 — offset advance is already done):** v1 framed "advance the offset before the media stage" as the fix. The sweep (finding 1) shows the offset already advances at poller.js:43. The actual fix is narrower: make `handleInbound` *return fast* for media by offloading the stage, so the `for…await` loop drains and the next `getUpdates` fires. **No poller change is needed.**
- **v4 (hybrid, locked):** do **both** offload (the real anti-stall fix; a single legit voice note must not stall the poller for 2 min — a throttle alone can't fix that) **and** a per-sender throttle (defense-in-depth: keeps one flooding group member from monopolizing the single serial extraction worker and starving the owner). Throttle/queue-full **degrades to a placeholder**; owner is **exempt** from the throttle.

## Architecture

```
poller.pollOnce()  (UNCHANGED — offset advances at :43, then for…await handleInbound)
  └─ handleInbound(msg)
       0. commands            (inline, fast — /allow,/disallow never queue)
       1. authorize           (inline, fail-closed — media of unauthorized chats NEVER downloaded)
       2. content guard       (unchanged)
       3. branch:
            ├─ no media        → processMessage(msg, {extract:false})           [inline, fast]
            ├─ media + no queue → processMessage(msg, {extract:true})           [inline — legacy/test path]
            └─ media + queue:
                 decision = mediaQueue.submit({fromId, owner, run: ()=>processMessage(msg,{extract:true})})
                 ├─ accepted  → RETURN immediately  (poller continues; worker drains in background)
                 └─ rejected  → msg.content += degraded placeholder
                                processMessage(msg, {extract:false})            [inline, fast — NEVER dropped]

  processMessage(msg, {extract}):                       (the factored tail)
       presence.start (pre-turn typing, DM-gated)
       if extract: r = await contextualizeMedia(msg); msg.content += r.contextLine; attachmentId = r.attachmentId
       vault.captureMessage({... attachmentId? ... metadata})        (idempotent id, soft-fail)
       runTurn(turnCtx, msg)                                          (enqueue + return)
       finally: presence.stop
```

**media-queue.js** (new, mirrors lane.js):

- A **serial** `tail` chain (concurrency 1) — naturally bounds local-inference load: the daemon issues at most one `attachment-context` request to the vault at a time.
- A bounded `pending` counter (queued + running). `submit` rejects with reason `queue-full` when `pending >= maxPending`.
- A **per-sender token bucket** (reuses [`createRateLimiter`](../packages/channel-daemon/ratelimit.js) keyed by `fromId`, fixed-window): non-owner `submit` calls `take(fromId)`; over budget → reject reason `rate-limited`. **Owner (`owner:true`) is exempt** from the bucket.
- `submit({fromId, owner, run})` checks `queue-full` *first* (so a rejected job never consumes a token), then the bucket, then `pending++` and chains `run` on the tail with `pending--` in `finally`.
- `idle()` returns the tail (drain seam for tests + graceful stop); `pending()` returns the count.

## Threat model

- **No new egress, no new bytes path.** The bytes/extraction path is unchanged (media.js); this design only changes *when* it runs (background worker) and *whether* it runs under flood (degrade). Plaintext still crosses only the same loopback the message content already crosses.
- **Authorization unchanged and still precedes any download.** `isAuthorized` runs inline before `submit`/`processMessage`; the media stage (and therefore `telegram.getFile`) only runs after the existing fail-closed gate ([inbound.js:81](../packages/channel-daemon/inbound.js)). A rejected (degraded) job never downloads.
- **Flood resistance (the MED-4 fix):** a single sender can no longer occupy the poll slot — `handleInbound` returns after `submit`. The serial worker + per-sender bucket + queue bound cap how much extraction work any one sender can induce. Excess **degrades** (placeholder, still captured + turned), never drops. Owner stays in control because **commands and owner text bypass the queue entirely** and are handled inline immediately — so `/disallow` works even mid-flood.
- **Never-drop invariant:** every authorized message is captured (idempotent id `tg-<msgId>-<chatId>`) and handed to `runTurn`, on every branch — accepted, degraded, or inline. The throttle only removes the *expensive extraction*, replacing it with an honest placeholder; capture metadata still records `mediaKind`+`fileUniqueId` for future backfill.
- **Accepted residual:** owner media *extraction latency* can sit behind ≤`maxPending` already-queued non-owner jobs under sustained flood (serial worker, FIFO). Bounded (low defaults), and the owner can `/disallow` the flooder instantly (command bypasses the queue). An owner-priority lane is **deferred** (named below).
- **Restart drop unchanged in class:** offset advances before handling (existing semantics); a daemon restart between `submit` and the worker's capture drops the message — the *same class* as today's restart-mid-extraction drop, already accepted in the media design. The window grows only by the queue wait (≈0 for a single user, empty queue).

## Module shape (≈ 170 LOC total ± 20%)

| File | Change | LOC |
|---|---|---|
| `packages/channel-daemon/media-queue.js` (NEW) | `createMediaQueue({maxPending, senderMax, senderWindowMs, now?})` → `{submit, idle, pending}`; serial tail + bound + per-sender bucket (owner-exempt) | ~70 |
| `packages/channel-daemon/inbound.js` | factor the tail into `processMessage(msg,{extract})`; media branch submits to `mediaQueue` (inline fallback when absent); degrade-to-placeholder builder; accept `mediaQueue` dep | ~55 |
| `packages/channel-daemon/config.js` | `mediaQueueMax` (8), `mediaSenderMax` (3), `mediaSenderWindowMs` (60000) knobs + env passthrough | ~6 |
| `packages/channel-daemon/index.js` | build `createMediaQueue` when `cfg.mediaEnabled`; pass `mediaQueue` to `createInboundHandler` | ~4 |
| `scripts/verify-channel-inbound-throughput.mjs` (NEW) | the gate (below) | ~120 |
| `package.json` | `verify:channel-inbound-throughput` script + add to `verify` chain | ~2 |

## Edge cases — explicit decisions

| Case | Decision |
|---|---|
| No `mediaQueue` wired (existing unit tests, capture-only) | media runs **inline** exactly as today — backward compatible; offload is opt-in via the dep |
| Single legitimate owner voice note (cold model ~2min) | submitted → handler returns immediately → poller keeps polling; extraction completes in background; capture+turn happen when the worker runs it |
| Subsequent owner DM **text** arrives during a media extraction | handled **inline**, captured + turned immediately (does not enter the queue) — the headline anti-stall guarantee |
| Owner control command (`/disallow`) during a flood | handled inline at step 0, before the queue — works mid-flood |
| Non-owner floods media in an authorized-open group | first `senderMax`/window admitted (extracted), the rest **degrade** to placeholder; all captured + turned; access policy still gates replies; coalescer merges the placeholder turns |
| Queue at `maxPending` | next media (even owner) **degrades** to placeholder — captured + turned, never dropped |
| Degrade placeholder content | `[<kind> received — skipped under load; not processed]` appended to caption (or used alone for media-only); honest, non-leaky |
| Degrade path | **never** calls `contextualizeMedia` (no download, no extraction); fast inline capture+turn only |
| Worker job throws | wrapped — `run` is fail-soft (processMessage try/finally) and the tail `.then` also catches; `pending--` always runs; chain never breaks (mirrors lane.js:69) |
| Presence (typing) for a queued job | starts when the worker begins `processMessage` (not at submit) — covers the extraction stage as before; brief/none for a degraded job (DM-gated; owner rarely degraded) |
| Daemon restart between submit and capture | message dropped (offset already advanced) — same class as today's accepted restart-mid-extraction drop |

## Test strategy

`scripts/verify-channel-inbound-throughput.mjs` (pure DI, no network; modeled on
`verify-channel-inbound.mjs` — same `rec`/ledger/`VERDICT: GO`/exit pattern). A
deferred-promise "gate" makes the media stage controllably slow.

| Case | Asserts |
|---|---|
| Q-unit: submit/pending/idle | `submit` accepts up to bound; `pending()` tracks queued+running; `idle()` drains; rejected `queue-full` past bound |
| Q-unit: owner exemption | owner `submit` ignores the bucket; non-owner over `senderMax` → reject `rate-limited` |
| Q-unit: queue-full checked before bucket | a rejected (full) submit does not consume a sender token |
| I1: media submit returns immediately | after `await handle(mediaMsg)`, the media stage has started but capture is **not** yet done; `pending()===1` |
| I2 (headline): flood doesn't stall a later owner DM | with a media job blocked on the gate, a subsequent owner **text** DM is captured + turned **before** the gate resolves |
| I3: media completes after drain | resolve gate → `await queue.idle()` → media message captured with `attachmentId` + augmented content + turn fired |
| I4: non-owner throttle degrades, never drops | non-owner media past `senderMax` → captured with placeholder, turn runs, `contextualizeMedia` **not** called |
| I5: owner never throttled | N owner media all accepted (extract path), none degraded |
| I6: authorization still precedes offload | unauthorized media → never submitted, never captured (stage never invoked) |

Plus the **regression gate**: `verify:channel-inbound` must stay GO (proves the
inline/no-queue path and the exact capture shape are unchanged).

## Implementation order (each independently shippable)

1. `media-queue.js` + Q-unit cases → gate green for the module in isolation.
2. `inbound.js` refactor (factor `processMessage`, add the branch + degrade) → re-run `verify:channel-inbound` (regression must stay GO).
3. `config.js` + `index.js` wiring.
4. `verify-channel-inbound-throughput.mjs` + package.json registration → gate GO.
5. Living docs + handoff + MEMORY.md.

## Decision criteria for proceeding

DONE when: `verify:channel-inbound` (regression) **and**
`verify:channel-inbound-throughput` both print `VERDICT: GO` / exit 0, the I2
headline case passes (a blocked media job does not delay a subsequent owner DM's
capture+turn), and the degrade cases prove no message is ever dropped.

## Risks

| Risk | L | I | Mitigation |
|---|---|---|---|
| Owner media extraction latency behind a flooder | M | L | low defaults (senderMax 3/60s, queue 8); commands+text bypass the queue; owner `/disallow` is instant; owner-priority lane deferred |
| Background worker error silently swallows a message | L | M | processMessage is fail-soft + tail catch; capture is logged on failure; idempotent id allows manual replay |
| Restart drops a queued message | L | L | same class as existing accepted restart-drop; window ≈0 for single user |
| Throttle too aggressive for a legit busy group | L | L | all knobs are env/vault-config overridable; degrade is non-destructive (capture+turn still happen) |

## Deferred (named so they don't ambush later)

owner-priority queue (jump owner media ahead of a flooder) · splitting media.js so degrade can still store the blob without extracting (backfill-ready) · per-chat (not per-sender) budgets · Discord media (no attachment parsing yet) · making the inline `await isAuthorized` per-message non-blocking under a 100-update batch (bounded, not the multi-minute problem).

## Verification table

| # | Assumption | Verified at (read with my own eyes) |
|---|---|---|
| 1 | Poller advances offset before the handler loop; the stall is the `for…await handleInbound` blocking the next `getUpdates` | [transport/telegram-poller.js:43-48](../packages/channel-daemon/transport/telegram-poller.js) |
| 2 | `runTurn` enqueues + returns (lane tail) / coalescer.push returns — only `contextualizeMedia` blocks `handleInbound` | [agent/lane.js:66-71](../packages/channel-daemon/agent/lane.js); [index.js:70-75](../packages/channel-daemon/index.js); [inbound.js:107-156](../packages/channel-daemon/inbound.js) |
| 3 | Lane is the serial-tail + idle() pattern to mirror (no new state pattern) | [agent/lane.js:31, 66-74](../packages/channel-daemon/agent/lane.js) |
| 4 | Media stage is fail-soft, never throws, returns `{attachmentId, contextLine}`; download+extract not separated | [media.js:62, 71-101](../packages/channel-daemon/media.js) |
| 5 | Capture records mediaKind+fileUniqueId even with no blob (degrade keeps backfill info) | [inbound.js:126-134](../packages/channel-daemon/inbound.js) |
| 6 | Existing media tests use no queue + expect inline → offload must be opt-in | [scripts/verify-channel-inbound.mjs:140-240](../scripts/verify-channel-inbound.mjs) |
| 7 | Authorization is fail-closed and precedes the media stage | [inbound.js:57-84](../packages/channel-daemon/inbound.js) |
| 8 | Outbound limiter is egress-only; inbound has none | [egress/send-handler.js:125-133](../packages/channel-daemon/egress/send-handler.js); [index.js:48, 107](../packages/channel-daemon/index.js) |
| 9 | Daemon-side attachment-context budget is 660s (the multi-minute blocker) | [vault-client.js:86-99](../packages/channel-daemon/vault-client.js) |
| 10 | `createRateLimiter` is a per-target fixed-window bucket reusable keyed by fromId | [ratelimit.js:24-50](../packages/channel-daemon/ratelimit.js) |
