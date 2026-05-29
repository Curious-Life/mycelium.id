# Egress Provenance — Phase 3 Detailed Design (2026-05-07)

**Companion to:** [docs/EGRESS-PROVENANCE-PLAN-2026-05-06.md](EGRESS-PROVENANCE-PLAN-2026-05-06.md), [docs/EGRESS-PROVENANCE-PHASE2-DESIGN-2026-05-06.md](EGRESS-PROVENANCE-PHASE2-DESIGN-2026-05-06.md), [docs/EGRESS-PROVENANCE-HANDOFF-2026-05-06.md](EGRESS-PROVENANCE-HANDOFF-2026-05-06.md).

**Status:** Design ready. Implementation gates on ≥7 days of audit data per §6.

## TL;DR

Phase 3 is the structural fix for the monologue leak. Phase 2 built the replacement path (`reply` MCP tool); Phase 3 deletes the leaky path that exists today. Two delete targets:

1. **`deliverNaturalReplyFallback`** at [chat.js:226-366](../packages/server/routes/chat.js#L226) — when an agent produces text but doesn't call reply/curl, this delivers the scratchpad as a real message. The leak class that originally motivated the entire 7-phase plan.
2. **`proactiveSendFallback`** at [agent-server.js:1157-1233](../packages/server/agent-server.js#L1157) — same shape, different surface (connection-recovery path).

Both are replaced with a **`chat-fallback-skipped`** operator-diagnostic template that fires a SHORT, OPERATOR-VISIBLE notification: "agent skipped explicit-send for inbound X — Y bytes of scratchpad discarded". The user does NOT receive the agent's scratchpad text. The operator sees the event, can review the conversation, and decides what (if anything) to do.

Net effect: silent leak → loud, operator-visible signal. The user gets nothing instead of leaked monologue. Operator gets enough info to debug.

## 1. Sweep findings (consolidated)

### 1a. Delete target #1: `deliverNaturalReplyFallback` ([chat.js:226-366](../packages/server/routes/chat.js#L226))

```js
async function deliverNaturalReplyFallback(args) {
  const { source, channelId: ch, chatId: tgChatId, text, replyToMessageId, voiceMode } = args;
  const trimmed = (text || '').trim();
  if (!trimmed) return { delivered: false, channelId: null };
  // ... 3 platform branches (Discord/Telegram/WhatsApp) — each:
  //   - POSTs to bot URL with `trusted: true`
  //   - records audit row provenance_kind='agent-explicit-via-fallback'
  //   - returns delivery result
}
```

**Single call site** at [chat.js:1162-1172](../packages/server/routes/chat.js#L1162):
```js
const fallbackText = (!result?.noReply && result?.response) ? String(result.response).trim() : '';
if (fallbackText && inboundSendsAfter === 0) {
  const fallbackResult = await deliverNaturalReplyFallback({
    source: inboundSource,
    channelId: inboundChannelId,
    chatId: req.body?.inboundChatId || null,
    text: fallbackText,
    replyToMessageId: req.body?.inboundMessageId || null,
    voiceMode: !!req.body?.voiceMode,
  }).catch(...);
  // Plus persistence block at lines 1189-1213
}
```

**Audit emit sites** (3 platform branches): [chat.js:260, 310, 350](../packages/server/routes/chat.js#L260) — each calls `recordEgress({ provenanceKind: 'agent-explicit-via-fallback', ... })`.

**Known bug (fixed by deletion)**: [chat.js:275](../packages/server/routes/chat.js#L275) checks `source === 'telegram'` which excludes `'telegram-group'`. Group inbound where agent skips reply → fallback silent-drops. Phase 3 deletes the function; the bug is gone as a side effect.

### 1b. Delete target #2: `proactiveSendFallback` ([agent-server.js:1157-1233](../packages/server/agent-server.js#L1157))

Same shape, different surface. Fires on connection recovery (5s + retry). Records `provenanceKind: 'agent-explicit-via-recovery'`. Doesn't overlap with chat fallback (different code path). Phase 3 deletes both for the same reason: both deliver agent text the agent didn't curl-send.

### 1c. Replacement primitive: operator-diagnostic ([agent-egress.js:81-128](../packages/server/lib/agent-egress.js#L81))

`agent-egress.js` already has the `send()` primitive used for `recovery-complete`, `artifacts-summary`, etc. Pattern is established:

```js
async function send(message, opts = {}) {
  const { channelIdOverride, templateId = 'agent-egress.send' } = opts;
  // Routes to Discord channel → Telegram DM → WhatsApp → silent
  // POSTs through the chokepoint with x-egress-provenance: system-template + x-egress-template-id: ${templateId}
}
```

Adding a `chat-fallback-skipped` template = new helper function calling `send()` with that templateId. The chokepoint already records template_id in `egress_audit`; no schema change needed.

### 1d. Privacy-safe content utilities ([packages/core/log-redact.js](../packages/core/log-redact.js))

```js
export function redactId(value, prefix = '') { ... }   // 6-char SHA-256 prefix; stable per tenant lifetime; not reversible
export function redactText(text) { return `${text.length} chars`; }   // length only, never content
```

Operator-diagnostic message will include:
- `redactId(inboundChannelId, 'tg-')` — operator can search audit for full ID
- `${scratchpadBytes} bytes` — via `redactText` (count, no content)
- preview: first 80 chars of scratchpad with `[...]` truncation suffix (acceptable PII risk; operator-only Telegram DM)

### 1e. Lane completion hook (does not exist; must be added in chat.js)

[lanes.js](../packages/core/lanes.js) is just a queue; no "drained" event. The diagnostic must fire INSIDE the existing post-lane code in chat.js — at exactly the same point where `deliverNaturalReplyFallback` was called. It's a one-line replacement of the function call.

### 1f. trackExplicitSend ([send-handler.js:308](../packages/server/lib/send-handler.js#L308))

```js
if (!isSystemTemplate) {
  ctx.trackExplicitSend(canonicalChannelId(auth.kind, auth.id));
}
```

Per-channel counter increments on every non-system-template send. Phase 3 reads the same `inboundSendsAfter` value the chat fallback reads today. NO change to this counter logic.

### 1g. Tests in scope

| Test file | Lines | Action |
|---|---|---|
| `packages/server/test/routes/chat.test.js` | 413-530 | DELETE the fallback-fire tests; ADD operator-diagnostic-fire tests |
| `packages/server/test/lib/send-handler.test.js` | 424-443 (Phase 2 trackExplicitSend tests) | Untouched (counter logic unchanged) |
| `packages/server/test/lib/agent-egress.test.js` | template tests | ADD chat-fallback-skipped template test |

## 2. Threat model

The original leak is structural: agents that produce text in scratchpad without curl-sending get their text auto-delivered. Phase 3 removes that auto-delivery. New attack surface = none (we delete code, don't add it). Risks:

| Threat | Mitigation |
|---|---|
| **UX regression**: agents that worked via fallback now fail silently to user | Phase 2's reply tool is the documented replacement path. The operator-diagnostic surfaces the case loudly. ≥7 days of audit data gates Phase 3 deployment, ensuring reply-tool adoption is real. |
| **Notification spam**: agent skips reply 50× in a row → operator gets 50 pings | Per-channel dedup: suppress duplicate `chat-fallback-skipped` for same channelId within 60s. Counter resets at task start. |
| **Information disclosure in preview**: 80-char preview leaks PII to operator | Operator-only channel (Telegram DM / Discord ops). Same trust boundary as `recovery-complete` template (which has freer text). Preview already truncated; no further redaction needed. |
| **Audit log gaps**: deleting fallback removes its audit rows; `agent-explicit-via-fallback` count drops to 0 mid-deploy | Replaced by `chat-fallback-skipped` audit rows (system-template kind, with template_id). The total "agent skipped explicit send" count is unchanged; it just moves from `agent-explicit-via-fallback` to `system-template/chat-fallback-skipped`. |

**No security non-negotiable violated.** Phase 3 strengthens the explicit-send invariant by removing the only remaining bypass.

## 3. Module shape

### 3a. New helper in `agent-egress.js` (~30 LOC)

```js
/**
 * Notify operator that an agent produced text but didn't explicit-send.
 * Replaces the deliverNaturalReplyFallback auto-delivery (deleted in Phase 3).
 * Fires when /chat completes with `result.response` set AND
 * trackExplicitSend(inboundChannelId) === 0.
 *
 * Privacy-safe: redacts the inbound channel ID, includes scratchpad byte
 * count, and a 80-char preview. Operator can review the conversation in
 * audit + recall channels using the redacted ID as the lookup key.
 *
 * @param {object} info
 * @param {string} info.inboundChannelKind  e.g. 'telegram-dm', 'discord-channel'
 * @param {string} info.inboundChannelId    raw channel/chat ID (redacted in message)
 * @param {number} info.scratchpadBytes     count, not content
 * @param {string} info.preview             first 80 chars of scratchpad (rest truncated)
 */
async function notifyFallbackSkipped(info) {
  const { inboundChannelKind, inboundChannelId, scratchpadBytes, preview } = info;
  // Per-channel dedup: 60s suppression window
  if (recentlyNotified(inboundChannelId, 60)) return false;
  markNotified(inboundChannelId);
  const previewSafe = preview.length > 80 ? preview.slice(0, 80) + '…' : preview;
  const redactedId = redactId(inboundChannelId, `${inboundChannelKind}-`);
  const message = `⚠ Agent skipped explicit-send for ${redactedId} — ${scratchpadBytes} bytes scratchpad discarded\nPreview: "${previewSafe}"`;
  return send(message, { templateId: 'chat-fallback-skipped' });
}
```

### 3b. `chat.js` replacement (≈10 LOC change vs ~140 LOC delete)

```js
// BEFORE (chat.js:1159-1213, ~55 LOC)
const fallbackText = ...;
if (fallbackText && inboundSendsAfter === 0) {
  const fallbackResult = await deliverNaturalReplyFallback({...}).catch(...);
  // Plus persistence block (lines 1189-1213)
}

// AFTER
const fallbackText = ...;
if (fallbackText && inboundSendsAfter === 0) {
  // Phase 3: agent skipped explicit-send. Surface the event to the operator
  // instead of auto-delivering the scratchpad (the May 2026 monologue leak).
  await operatorNotifier.notifyFallbackSkipped({
    inboundChannelKind: deriveChannelKind(inboundSource, inboundChannelId, req.body?.inboundChatId),
    inboundChannelId: inboundChannelId || req.body?.inboundChatId,
    scratchpadBytes: fallbackText.length,
    preview: fallbackText.slice(0, 80),
  }).catch((err) => {
    console.warn(`[${logPrefix}] operator-diagnostic fire failed: ${err.message}`);
  });
}
```

`deliverNaturalReplyFallback` function (lines 226-366): **DELETED**.

### 3c. `agent-server.js` `proactiveSendFallback` replacement

Same pattern: replace the auto-delivery with a `recovery-fallback-skipped` operator-diagnostic. Different template ID for audit distinguishability.

### 3d. Audit-side: existing `egress_audit` schema unchanged

The `provenance_kind: 'agent-explicit-via-fallback'` rows go to zero post-deploy. The replacement is `provenance_kind: 'system-template'` with `template_id: 'chat-fallback-skipped'`. Operator queries:

```sql
-- Phase 3 monitoring: how often does the fallback skip event fire?
SELECT date(created_at), COUNT(*) FROM egress_audit
WHERE template_id = 'chat-fallback-skipped'
GROUP BY date(created_at) ORDER BY date(created_at) DESC;
```

Decreasing trend = Phase 2's reply tool is being adopted (good). Spike = a specific agent has lost the curl/reply discipline (operator investigates).

## 4. Edge cases — explicit decisions

### 4a. /chat/triage, /chat/stream, /think, scheduler runs

None of these fire `deliverNaturalReplyFallback` today. None will fire `notifyFallbackSkipped` either. Their `noReply: true` semantics are unchanged.

### 4b. Recovery resumes

Phase 2 Step 1 wired the active-turn registry into `recovery.resumeSession`. If a resumed run produces `result.response` without explicit-send, the chat-handler-side check doesn't fire (recovery is a separate code path). The `proactiveSendFallback` deletion in 3c covers this case.

### 4c. Inter-agent collab (`sourceAgent` set)

Today `deliverNaturalReplyFallback` doesn't check `sourceAgent` — it fires regardless. Phase 3's replacement should NOT fire for inter-agent: scratchpad in collab context is the agent's reasoning trace, not user-bound text. Add `if (sourceAgent) return;` at top of the diagnostic check.

### 4d. Long scratchpad (10,000+ chars)

Preview truncates to 80 chars with `…` suffix. Bytes count is full. Operator sees scale + flavor without reading the full transcript.

### 4e. Empty scratchpad (`!result.response`)

Today: fallback skips (the `if (fallbackText)` guard). Phase 3: same — diagnostic doesn't fire when there's nothing to discard.

### 4f. Sub-agent context

Sub-agents (`/spawn-task-async`) don't have an active turn registry; their reply tool refuses with `no-active-turn`. If a sub-agent produces text without sending, the parent's chat handler doesn't see it (sub-agent runs in a fresh runtime). No diagnostic fires. The sub-agent's output is captured in the spawn result; the operator sees that via the spawn audit, separate channel.

## 5. Implementation order

| Step | Description | Tests | Smoke |
|---|---|---|---|
| 3.1 | Add `notifyFallbackSkipped` to `agent-egress.js` (with per-channel dedup) | `agent-egress.test.js` template assertions + dedup test | Locally invoke; observe operator notification fires |
| 3.2 | Replace chat.js fallback call with operator-diagnostic | Rewrite chat.test.js cases | Send Telegram DM, agent skips reply, observe diagnostic + no message to user |
| 3.3 | Delete `deliverNaturalReplyFallback` function entirely | Removes 140 LOC; tests pass | grep confirms no remaining call sites |
| 3.4 | Replace `proactiveSendFallback` with `recovery-fallback-skipped` diagnostic | New tests for recovery diagnostic | Trigger recovery scenario, observe diagnostic |
| 3.5 | Delete `proactiveSendFallback` function | Removes ~80 LOC | grep confirms no callers |
| 3.6 | Bundle commit + push + admin deploy + verify-deploy.sh smoke | Verify-deploy passes | New `chat-fallback-skipped` template ID appears in audit |
| 3.7 | Customer fleet rollout (`update-customers.sh --restart`) | Per-host verify | Customer audit logs show new template_id |

Steps 3.1-3.5 are one logical commit. Step 3.6 is the deploy. Step 3.7 is the fleet rollout.

## 6. Decision criteria for proceeding (≥7-day gate)

Phase 3 implementation gates on the following metrics from `egress_audit` over a 7-day window AFTER Phase 2 Step 4 customer fleet rollout (today, 2026-05-07):

| Metric | Phase 2 baseline | Phase 3 gate |
|---|---|---|
| `count(agent-explicit-via-tool)` per day | 0 (pre-Phase-2) | > 50 across fleet |
| `count(agent-explicit-via-fallback)` per day | ~50-200 (estimate, pre-Phase-2 baseline) | < pre-Phase-2 baseline by 60%+ |
| Inbound delivery rate (any provenance) | per-channel baseline | within ±10% of baseline |
| `no-active-turn` errorCode from /chat | 0 | < 5 across fleet |

The gate query (run on operator's admin VPS):
```bash
ssh mycelium-vps 'cd /home/claude/mycelium && bash scripts/phase3-readiness-gate.sh'
```

(This gate script is part of Phase 3's first commit — `phase3-readiness-gate.sh` queries the metrics above and outputs PASS/FAIL with thresholds.)

## 7. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Reply tool adoption < target | Medium | Phase 3 stays gated until prompt iteration | Audit + operator review; may require a Phase 2.5 prompt-tuning commit |
| Operator-diagnostic fires too often (spam) | Low | Alert fatigue | 60s per-channel dedup; if inadequate, raise to 5min in commit |
| Diagnostic delivery fails (Telegram down) | Low | Operator misses event | Audit row still records `system-template/chat-fallback-skipped` even on delivery failure (Phase 1 contract) — operator can query later |
| Telegram-group bug regression | Negligible | Bug already in code; deletion fixes it | Phase 3 deletes the buggy function entirely |
| proactiveSendFallback delete breaks recovery | Low | Recovery path silent-fails to user | Operator-diagnostic catches it; recovery completion is already operator-visible via `recovery-complete` template |
| Customer fleet drift | Low | Some customers stay on fallback | `update-customers.sh --restart` rolls all 3; per-host verify confirms |

## 8. Open questions resolved during sweep

1. **Should diagnostic fire for inter-agent (sourceAgent)?** → No (§4c). Inter-agent scratchpad is reasoning trace.
2. **What about `proactiveSendFallback`?** → Same delete pattern, separate template (`recovery-fallback-skipped`).
3. **Should the diagnostic include scratchpad content?** → Only 80-char preview + length. Operator can audit the conversation if curious.
4. **Per-channel dedup window?** → 60s. Adjustable in commit.
5. **Audit row for the "skipped" event?** → `provenance_kind: 'system-template'` + `template_id: 'chat-fallback-skipped'`. Total skip count tracking is unchanged (just moves vocabularies).

## 9. Open questions deferred

1. **Per-agent diagnostic config**: Should certain agents (e.g., qa-agent) have lower thresholds for "skipped" because their normal output mode is silent-or-tool-call? Defer to operator review post-Phase-3.
2. **Long-term remediation if reply-tool adoption is poor**: prompt iteration loop. Out of scope.
3. **Vault-data scratchpad**: if scratchpad contains decrypted vault content, the 80-char preview + length leak some metadata to operator's Telegram DM. Acceptable per the existing trust boundary, but flag for future review.

## 10. Verification table (sweep evidence)

| Load-bearing assumption | Verified at | Evidence |
|---|---|---|
| `deliverNaturalReplyFallback` exists at chat.js:226-366 | [packages/server/routes/chat.js:226](../packages/server/routes/chat.js#L226) | sweep #1 |
| Single call site at chat.js:1162 with persistence at 1189-1213 | [chat.js:1162-1213](../packages/server/routes/chat.js#L1162) | sweep #1 |
| Three audit emit sites for `agent-explicit-via-fallback` | chat.js:260, 310, 350 | sweep #1 |
| Telegram-group bug at chat.js:275 (not 254 as previously thought) | [chat.js:275](../packages/server/routes/chat.js#L275) | sweep #1 |
| `proactiveSendFallback` at agent-server.js:1157-1233 | [agent-server.js:1157](../packages/server/agent-server.js#L1157) | sweep #1 |
| Audit emits `agent-explicit-via-recovery` at agent-server.js:1201, 1233 | sweep #1 | sweep #1 |
| `agent-egress.js:send()` accepts arbitrary `content` + `templateId` | [agent-egress.js:81-128](../packages/server/lib/agent-egress.js#L81) | sweep #2 |
| `redactId` available at log-redact.js:50 (6-char SHA-256) | [packages/core/log-redact.js:50](../packages/core/log-redact.js#L50) | sweep #2 |
| `redactText` returns `${length} chars` (no content) | [packages/core/log-redact.js:68](../packages/core/log-redact.js#L68) | sweep #2 |
| `trackExplicitSend` increments per-channel counter | [send-handler.js:308](../packages/server/lib/send-handler.js#L308) | sweep #1 |
| `inboundSendsAfter === 0` is the existing fallback condition | [chat.js:1160](../packages/server/routes/chat.js#L1160) | sweep #1 |
| `agent-egress.js` has no rate-limit/dedup pattern today | (sweep #2 — explicit "no precedent found") | sweep #2 |
| Worker chokepoint accepts `x-egress-template-id` header → audit row template_id | [send-handler.js:162-164](../packages/server/lib/send-handler.js#L162) | Phase 1 design |
| `lanes.js` has no completion hook | [packages/core/lanes.js](../packages/core/lanes.js) | sweep #2 |
| Existing chat.test.js fallback tests at lines 413-530 | [chat.test.js:413-530](../packages/server/test/routes/chat.test.js#L413) | sweep #1 |
| `agent-egress.test.js` provides template-test pattern | [agent-egress.test.js:80-104](../packages/server/test/lib/agent-egress.test.js#L80) | sweep #2 |
| inter-agent (sourceAgent) handling: deliverNaturalReplyFallback doesn't differentiate | sweep #1 (explicit "no special handling") | sweep #1 |
| Audit `template_id` column exists in egress_audit | [migrations/151_egress_audit.sql:32](../migrations/151_egress_audit.sql#L32) | Phase 1 design |

## 11. Final state after Phase 3

- `deliverNaturalReplyFallback` deleted; 140 LOC removed
- `proactiveSendFallback` deleted; ~80 LOC removed
- New: `notifyFallbackSkipped` in agent-egress.js (~30 LOC)
- New: `chat-fallback-skipped` + `recovery-fallback-skipped` audit template IDs
- Telegram-group source-check bug eliminated as side effect
- Customer fleet inherits the delete + diagnostic via `update-customers.sh --restart`
- Audit query distinguishes "agent forgot to send" events for ongoing observability
- Monologue leak structurally closed across all 4 VPSes

This is the final state where "monologue leak fixed across all customers in a robust, secure way" is achieved.
