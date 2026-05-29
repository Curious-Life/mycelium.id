# Egress Provenance — Phase 1 Detailed Design (2026-05-06)

Companion to [EGRESS-PROVENANCE-PLAN-2026-05-06.md](EGRESS-PROVENANCE-PLAN-2026-05-06.md). Phase 0 (observability) shipped on admin (commit `b5ac696`) and the customer fleet. This doc is the implementation design for Phase 1: route every system-authored send through the agent-server chokepoint (Layer A) instead of bypassing to bot subprocesses (Layer B), with a structurally honest provenance signal at the transport layer.

> **Revision history.** v1 (early draft) used a `provenanceKind` request-body field. Sweep #2 (this version) replaces that with an `x-egress-provenance` HTTP header and a stricter loopback gate; drops `agentExplicit` and `operator` entry points (no callers in Phase 1, YAGNI); enriches the hook-bus payload; preserves audit-trail distinguishability via persistence metadata; and tightens the threat model.

## Scope

**In:**
- A new `egress.js` in-process module with one entry point: `systemTemplate({ ... })`.
- Two callers migrate to it: `agent-egress.send` and `recovery.notifyContinuation`.
- The chokepoint (`send-handler.js`) gains:
  - Recognition of an `x-egress-provenance: system-template` header (set by in-process callers).
  - Strict-loopback gate (loopback socket AND no `x-forwarded-for`) for honoring the header.
  - Tailored gate set when the header is present: skip channel-authority, skip `trackExplicitSend`, retain dedup + persist + emitOutbound + audit.
- Audit emissions consolidate at the chokepoint. Origin-side emissions in `agent-egress.js` are removed.
- `message.outbound` hook bus payload gains `provenanceKind` + `templateId` fields.
- `persistOutboundIfPossible` accepts an `origin` override so system-template assistant rows are distinguishable in chat history.

**Out (later phases):**
- The `reply` MCP tool + `inbound-context` primitive — Phase 2.
- Chat fallback deletion + `proactiveSendFallback` removal — Phase 3.
- Retiring `trusted: true` HTTP support — Phase 4.
- File/voice/email migration — Phases 5-6.
- Default-to-inbound enforcement — Phase 7.

## 1. Sweep findings (consolidated)

### 1a. There are TWO existing system-authored callers, not one

`agent-egress.send` (called by `notifyArtifactsCreated`, `notifyRecoveryComplete`) was obvious. The hidden one is [recovery.js:422-491](../packages/server/lib/recovery.js#L422) — `notifyContinuation` — which posts directly to bot URLs without `trusted: true`, on five distinct templates (`recovery-timeout`, `recovery-rate-limit`, `recovery-max-turns`, `recovery-resuming`, `recovery-failed`). Phase 1 must migrate both. Direct callers of `operatorNotifier.send` outside `notifyArtifactsCreated`/`notifyRecoveryComplete`: zero. The blast radius is narrow.

### 1b. `requireWorkerSecret` allows loopback unconditionally

[auth-helpers.js:222-224](../packages/server/lib/auth-helpers.js#L222) trusts any `127.0.0.1` socket regardless of `X-Forwarded-For`. That's correct for normal `/send` traffic — Caddy proxies HTTPS to loopback and adds X-Forwarded-For. But it means a Caddy-proxied request could in principle assert `x-egress-provenance: system-template` from outside the VPS.

**Resolution:** the chokepoint must apply a STRICTER check before honoring the provenance header. Same shape as the existing `/internal/audit-status` endpoint: `isLocalSocket && !req.headers['x-forwarded-for']`. Caddy-proxied requests fall through to the agent-explicit path even if they include the header.

### 1c. Loopback self-fetch from the agent-server is structurally clean

When `egress.systemTemplate` POSTs to `http://127.0.0.1:<PORT>/<platform>/send`, the connection comes in on a fresh loopback socket — no X-Forwarded-For unless something between the caller and the chokepoint adds one (nothing does, in a same-process self-fetch). This is the in-process trust anchor.

### 1d. Today's chokepoint behavior, what changes for system-template:

| Gate (in send-handler.js) | Today | Phase 1 (system-template) | Why |
|---|---|---|---|
| `requireWorkerSecret` | passes (loopback) | passes (loopback) | Unchanged |
| `isPlatformDisabled` (kill switch) | applies | applies | System messages also respect operator emergency-disable |
| `assertDeliverable` | trusted-bypass via `trusted:true` | passes naturally — templates don't match silent-reply patterns | Provenance replaces flag-bypass |
| Trivial-content gate (≥8 chars stripped) | applies | applies | Templates ≥8 chars |
| Fail-closed routing (target required) | applies | applies | Caller must specify target |
| `enforceChannelAuthority` (registry) | applies | **bypassed** | Operator's Discord channel and OWNER_TELEGRAM_ID DM aren't auto-registered today; bypass preserves delivery |
| Encryption / allowlist (Matrix-only) | applies | applies | No matrix system-templates today; future-safe |
| `preApiGate` (Discord rate-limit) | applies | applies | System messages count toward rate budgets |
| Envelope dedup | trusted-bypass via `trusted:true` | applies | **Improvement** — prevents accidental double-delivery of identical templates within 30s |
| `trackExplicitSend` | applies | **skipped** | Counter drives the chat fallback's "if zero explicit sends" decision; incrementing on system messages would suppress legitimate fallback fires (acceptable in Phase 3, *not* Phase 1) |
| `persistOutboundIfPossible` | applies | applies, with `origin: 'system-template'` metadata | **Improvement** — assistant row in chat history, distinguishable by metadata |
| `emitOutbound` (hook bus) | fires | fires, with `provenanceKind` + `templateId` in payload | **Improvement** — extensions can react to provenance |
| Audit emission | once, classified by `trusted` flag | once, classified by `provenanceKind` (header) | Single source of truth |

### 1e. Three behavior improvements ride along

1. System messages now go through `assertDeliverable` (passes by content, not by flag-bypass).
2. System messages persist with distinguishable `origin` metadata (better chat history; future search/recall can filter).
3. System messages get envelope dedup (no more double-delivery on retries; affects e.g. recovery notifications when they fire from concurrent paths).

### 1f. Hook bus subscribers exist (extensions surface)

[core/extensions/hook-bus.js](../packages/core/extensions/hook-bus.js) — `message.outbound` is a documented extension surface. Today the payload includes `trusted: !!trusted`. Phase 1 should preserve it (don't break extensions) AND add `provenanceKind` + `templateId` so subscribers can distinguish provenance.

### 1g. `persistOutboundIfPossible` already accepts metadata.origin

[bots.js:336](../packages/server/routes/bots.js#L336) hardcodes `origin: 'explicit-send'`. Phase 1 makes the chokepoint pass an override when the request is system-template. Smallest possible change.

### 1h. `process.env.PORT` is reliably set

[agent-server.js:172](../packages/server/agent-server.js#L172) — `const PORT = process.env.PORT || 3002`. Each agent has its own PORT via PM2 ecosystem config. `egress.js` reads `process.env.PORT` to find its own loopback chokepoint. Same-process always agrees on PORT.

## 2. Threat model for the system-template gate-bypass

The provenance header (`x-egress-provenance: system-template`) is honored *only* when:
1. The connecting socket is loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`), AND
2. There is no `x-forwarded-for` header.

This excludes:
- External clients (no loopback socket).
- Caddy-proxied requests (Caddy adds X-Forwarded-For).
- Bot subprocesses calling back into the chokepoint (they're separate processes hitting loopback — but they don't send the provenance header).

This includes:
- The agent-server's own self-fetches (egress.systemTemplate).
- Other PM2 processes on the same VPS (orchestrator, schedulers).
- MCP child processes via fetch from inside agent runs.

**Threat: a malicious MCP extension could claim system-template to bypass channel-authority.** Mitigations:
1. *Audit log* captures `source_module` + `template_id`. Operator can detect anomalies (e.g., an unknown extension claiming `recovery-complete`).
2. *Channel-authority bypass is narrowly scoped*. Only registry-membership check is skipped; assertDeliverable, dedup, persist, emitOutbound, audit all still apply. Even a forged claim only buys "send to a channel I shouldn't have access to" — caught by the audit.
3. *Defense in depth*: ACE on the VPS already pwns the operator. The header isn't grant of new privilege; it's a tag for operator visibility.

**Threat acceptance:** any process with code execution on the VPS can claim system-template. That's structurally fine — owning the host means owning the agent. The audit log is the primary defense, not the gate.

## 3. Module shape

### `packages/server/lib/egress.js` (new — ~80 LOC)

```js
/**
 * Egress entry points — the in-process boundary every text crossing to a
 * person-visible channel passes through.
 *
 * Phase 1 ships ONE entry point: systemTemplate. Phase 2 adds agentExplicit;
 * neither agentExplicit nor a top-level operator helper exist yet (YAGNI —
 * agent-egress.js's notifyArtifactsCreated / notifyRecoveryComplete are
 * already the operator-routing abstraction; egress.systemTemplate is the
 * underlying mechanism they call into).
 */

import { recordEgress } from './egress-audit.js';

let _config = null;

export function configureEgress(cfg) {
  if (typeof cfg?.fetch !== 'function')      throw new TypeError('configureEgress: fetch required');
  if (typeof cfg?.agentServerPort !== 'number' && cfg.agentServerPort !== 'string') {
    throw new TypeError('configureEgress: agentServerPort required');
  }
  if (typeof cfg?.agentId !== 'string')      throw new TypeError('configureEgress: agentId required');
  if (typeof cfg?.logPrefix !== 'string')    throw new TypeError('configureEgress: logPrefix required');
  _config = cfg;
}

/**
 * @typedef {object} SystemTemplateArgs
 * @property {string} templateId         registered name (e.g. 'artifacts-summary')
 * @property {'telegram'|'discord'|'whatsapp'} platform
 * @property {string} channelId          Telegram chatId, Discord channelId, etc.
 * @property {string} content            fully composed message body
 * @property {object} [options]
 * @property {boolean} [options.voice]   Telegram-only TTS hint
 * @property {string|number} [options.replyToMessageId]
 *
 * @typedef {object} SystemTemplateResult
 * @property {boolean} delivered
 * @property {number} [httpStatus]
 * @property {string} [errorCode]
 */

/**
 * Send a system-template message via the loopback chokepoint.
 * Fire-and-forget by contract: returns delivery state, never throws.
 *
 * @param {SystemTemplateArgs} args
 * @returns {Promise<SystemTemplateResult>}
 */
export async function systemTemplate(args) {
  if (!_config) throw new Error('egress not configured');
  const { templateId, platform, channelId, content, options = {} } = args;

  if (!['telegram', 'discord', 'whatsapp'].includes(platform)) {
    return { delivered: false, errorCode: 'invalid-platform' };
  }
  if (!channelId || !content) {
    return { delivered: false, errorCode: 'missing-required' };
  }

  const url = `http://127.0.0.1:${_config.agentServerPort}/${platform}/send`;
  const body = platform === 'telegram'
    ? { chatId: String(channelId), text: content, ...options }
    : platform === 'discord'
      ? { channelId: String(channelId), content, ...options }
      : { text: content, ...options };  // whatsapp

  try {
    const res = await _config.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-egress-provenance': 'system-template',
        'x-egress-template-id': templateId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { delivered: res.ok, httpStatus: res.status };
  } catch (e) {
    console.warn(`[${_config.logPrefix}] egress.systemTemplate (${platform}/${templateId}) failed: ${e.message}`);
    return { delivered: false, errorCode: 'fetch-failed' };
  }
}
```

**Why headers, not body fields:**
- Headers are checked at the same code position as auth (start of request handling). Body fields force gate logic to spread across the handler.
- Headers don't pollute the request body schema.
- Headers can't be confused with delivery payload fields (e.g. a future field named `provenance` in the message body).
- Easier to test: `headers: { 'x-egress-provenance': 'system-template' }` vs editing JSON body in fetch mocks.

### `packages/server/lib/send-handler.js` (modified — ~25 LOC change)

```js
// At top of sendHandler:
const isLoopbackSocket = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress || '');
const noProxyHeader = !req.headers['x-forwarded-for'];
const headerProvenance = req.headers['x-egress-provenance'];
const isSystemTemplate = headerProvenance === 'system-template' && isLoopbackSocket && noProxyHeader;
const templateId = isSystemTemplate ? (req.headers['x-egress-template-id'] || null) : null;

// step 1 (requireWorkerSecret): unchanged
// step 5 (assertDeliverable): UNCHANGED — system-template messages pass naturally
// step 9 (channel authority):
let auth;
if (isSystemTemplate) {
  // System-template bypass: trust the provided id directly.
  // The audit log captures source_module + templateId; an MCP extension
  // forging this header would show up in the audit.
  auth = {
    kind: providedId ? route.inferKind(providedId) : route.allowedKinds[0],
    id: providedId,
    code: 'system-template-bypass',
  };
} else {
  auth = await ctx.enforceChannelAuthority({ /* existing args */ });
  if (!auth) return;
}

// step 12 (trackExplicitSend): SKIP for system-template
if (!isSystemTemplate) {
  ctx.trackExplicitSend(canonicalChannelId(auth.kind, auth.id));
}

// emitOutbound: enrich payload
emitOutbound(ctx.runtimeState.hookBus(), 'message.outbound', {
  ...existingFields,
  provenanceKind: isSystemTemplate ? 'system-template' : (trusted ? 'system-template-legacy-trusted' : 'agent-explicit'),
  templateId,
});

// persistOutboundIfPossible: pass origin override
ctx.persistOutboundIfPossible({
  ...existingArgs,
  origin: isSystemTemplate ? 'system-template' : undefined,  // undefined → defaults to 'explicit-send'
});

// recordEgress (audit): use header-derived provenance when present
recordEgress({
  provenanceKind: isSystemTemplate ? 'system-template'
    : (trusted ? 'system-template' : 'agent-explicit-via-curl'),
  templateId,
  sourceModule: 'send-handler',
  ...existingFields,
});
```

The legacy `trusted: true` body flag continues to behave as it does today (bypasses assertDeliverable + dedup, audit-classified as `system-template`). It's a Phase 4 retirement target — Phase 1 doesn't touch it.

### `packages/server/routes/bots.js` (modified — ~5 LOC change)

`persistOutboundIfPossible` extends to accept and forward `origin`:

```js
function persistOutboundIfPossible({ platform, chatId, text, partial, sent, total, origin }) {
  // ...existing...
  const metadata = {
    origin: origin || 'explicit-send',  // ← override when caller specifies
    channelId: String(chatId),
    delivery: partial ? 'partial' : 'sent',
    // ...existing...
  };
  // ...existing storeAssistantMessage call...
}
```

### `packages/server/lib/agent-egress.js` (modified — ~80 LOC change)

The `send()` helper rewrites its three platform branches to call `egress.systemTemplate` instead of POSTing directly:

```js
import * as egress from './egress.js';

async function send(message, opts = {}) {
  const { channelIdOverride, templateId = 'agent-egress.send' } = opts;
  if (!message || typeof message !== 'string') return false;

  // Routing precedence preserved: Discord channel > Telegram operator DM > WhatsApp.
  const discordTarget = channelIdOverride || discordChannel;
  if (discordTarget && discordBotUrl) {
    const r = await egress.systemTemplate({
      templateId, platform: 'discord', channelId: discordTarget, content: message,
    });
    return r.delivered;
  }

  const ownerTelegramId = process.env.OWNER_TELEGRAM_ID;
  if (telegramBotUrl && ownerTelegramId) {
    const r = await egress.systemTemplate({
      templateId, platform: 'telegram', channelId: ownerTelegramId, content: message,
    });
    return r.delivered;
  }

  if (whatsappBotUrl) {
    const r = await egress.systemTemplate({
      templateId, platform: 'whatsapp', channelId: '', content: message,
    });
    return r.delivered;
  }

  return false;
}
```

**Phase 0 origin-side audit emissions removed.** The `recordEgress` dep injection introduced in Phase 0 is removed too (chokepoint covers everything now). `notifyArtifactsCreated` and `notifyRecoveryComplete` signatures unchanged externally — they continue passing `templateId`.

The `recordEgress` factory dep + the `emitAudit` helper inside `agent-egress.js` are deleted (~30 LOC removed).

### `packages/server/lib/recovery.js` (modified — ~50 LOC change)

`notifyContinuation` rewrites in the same shape. Five `templateId`s:

```js
const TEMPLATE_BY_TYPE = {
  timeout: 'recovery-timeout',
  rate_limit: 'recovery-rate-limit',
  max_turns: 'recovery-max-turns',
  resuming: 'recovery-resuming',
  failed: 'recovery-failed',
};

async function notifyContinuation({ type, attempt, maxAttempts, waitMs, resumeAfter, message, deliveryContext }) {
  // ...existing message composition + cooldown logic...

  // Replace the three direct-fetch branches with egress.systemTemplate:
  const templateId = TEMPLATE_BY_TYPE[type] || 'recovery-other';
  const channelId = deliveryContext?.channelId || discordChannel;
  if (channelId && discordBotUrl) {
    await egress.systemTemplate({ templateId, platform: 'discord', channelId, content: message });
  } else if (telegramBotUrl && process.env.OWNER_TELEGRAM_ID) {
    await egress.systemTemplate({ templateId, platform: 'telegram', channelId: process.env.OWNER_TELEGRAM_ID, content: message });
  } else if (whatsappBotUrl) {
    await egress.systemTemplate({ templateId, platform: 'whatsapp', channelId: '', content: message });
  }
}
```

The cooldown logic ([recovery.js:446-458](../packages/server/lib/recovery.js#L446)) stays unchanged — it operates above `egress.systemTemplate`. Two layers of duplicate suppression: cooldown (per-type, per-channel, 5-min) and envelope dedup (per-content-hash, per-channel, 30s). Different windows, different keys, no interference.

## 4. Audit emission topology

Phase 0 has 14 emission sites. Phase 1 reorganizes:

| Site | Phase 0 | Phase 1 | Notes |
|---|---|---|---|
| `send-handler` (deny / success / fail) | ✓ | ✓ — now reads `x-egress-provenance` header for classification | Canonical record |
| `chat.fallback.*` (3) | ✓ | ✓ | Phase 3 deletes |
| `agent-egress.send.*` (3) | ✓ | **removed** | Now covered by `send-handler` via loopback |
| `bots.<platform>-send-{file,voice}` (4) | ✓ | ✓ | Phase 5 |
| `gmail.send`, `ops-tools.sendReply` | ✓ | ✓ | Phase 6 |
| `proactiveSendFallback.*` (2) | ✓ | ✓ | Phase 3 deletes |
| `recovery.notifyContinuation` | not wired | **covered** by `send-handler` via loopback | New visibility |

**Migration window double-count.** Step 1 (chokepoint changes) and Step 3 (agent-egress migration) ship in separate commits. Between them, a system-template send goes through:
- Old: agent-egress.js Phase 0 emission → POST to bot URL → no chokepoint emission (bypasses Layer A).
- New (after step 3): no agent-egress emission → POST to loopback chokepoint → chokepoint emission.

In the window between step 1 and step 3, the OLD path is still active. No double-counting issue (the old path doesn't go through the chokepoint). Once step 3 lands, both paths converge; the audit log immediately shows the cutover (origin records stop, chokepoint records appear with `provenanceKind: 'system-template'`).

The cleaner concern: between step 3 and step 4 (recovery.notifyContinuation migration), recovery still uses the old path. Audit data shows partial migration. Operator can see this and confirm correctness before step 4.

## 5. Test strategy

### New tests

**`packages/server/test/lib/egress.test.js`** (new, ~150 LOC):
```
describe('configureEgress')
  - throws without config
  - throws on missing fetch / agentServerPort / agentId / logPrefix

describe('systemTemplate')
  - rejects unknown platform → { delivered: false, errorCode: 'invalid-platform' }
  - rejects empty channelId → { delivered: false, errorCode: 'missing-required' }
  - rejects empty content → { delivered: false, errorCode: 'missing-required' }
  - posts to http://127.0.0.1:<port>/<platform>/send
  - includes x-egress-provenance: system-template header
  - includes x-egress-template-id: <id> header
  - telegram body uses chatId/text shape
  - discord body uses channelId/content shape
  - whatsapp body uses text shape (channelId not in body)
  - returns { delivered: true, httpStatus: 200 } on 200
  - returns { delivered: false, httpStatus: 500 } on 500
  - returns { delivered: false, errorCode: 'fetch-failed' } on network error
  - never throws (fire-and-forget contract)
```

**`packages/server/test/lib/send-handler.test.js`** (extended):
```
describe('createSendHandler — system-template provenance')
  - x-egress-provenance: system-template + loopback + no XFF
    → channel-authority gate bypassed (auth = synthesized from providedId)
    → trackExplicitSend NOT called
    → persistOutboundIfPossible called with origin: 'system-template'
    → emitOutbound payload has provenanceKind: 'system-template' + templateId
    → audit row classified as 'system-template' with template_id
  - x-egress-provenance: system-template + loopback + WITH XFF
    → header IGNORED, treated as agent-explicit (channel-authority applies, counter increments)
  - x-egress-provenance: system-template + non-loopback + worker-secret
    → header IGNORED (only loopback + no-XFF honors header)
  - x-egress-provenance unset
    → existing behavior preserved (no regression)
```

### Updated tests

**`packages/server/test/lib/agent-egress.test.js`** (rewrite of fetch-mock URL assertions):
- URL pattern changes from `http://discord-bot.test/discord/send` → `http://127.0.0.1:<port>/discord/send`
- Body assertions check absence of `trusted: true` (header carries the provenance now)
- Header assertions check `x-egress-provenance` and `x-egress-template-id`
- Routing precedence tests still apply (Discord-first, Telegram, WhatsApp)
- Test for `templateId` propagation from notifyArtifactsCreated/notifyRecoveryComplete

**`packages/server/test/lib/recovery.test.js`** (similar pattern):
- `notifyContinuation` URL pattern changes
- Header assertions for `x-egress-provenance` + `x-egress-template-id` per type

### Integration test

**One new end-to-end smoke**: a fake agent calls `egress.systemTemplate` from the same Node process as the chokepoint, asserts the chokepoint accepts the header (loopback socket), the chokepoint's audit row classifies it correctly, the bot subprocess receives the forwarded message. (Mock the bot subprocess; we're testing Layer A behavior.)

## 6. Implementation order

Each step independently shippable. Stop after any step if needed.

**Step 1** — `send-handler.js` accepts `x-egress-provenance` header *(no behavior change for any caller; purely additive)*
- Add header detection + strict-loopback gate.
- When header present: branch gates as in §3.
- When absent: existing behavior preserved.
- Update `persistOutboundIfPossible` to accept `origin` override.
- Update emitOutbound payload to include `provenanceKind` + `templateId`.
- Update audit `recordEgress` call to read provenance from header when present.
- Tests: extended send-handler.test.js cases.
- Smoke: send a manual `curl -H 'x-egress-provenance: system-template' …` from admin's loopback, observe audit row classification.

**Step 2** — Introduce `egress.js` *(in-process module, no callers yet)*
- Configure at boot from agent-server.js.
- `systemTemplate({...})` POSTs to loopback with the new headers.
- Tests: new egress.test.js.

**Step 3** — Migrate `agent-egress.send` to `egress.systemTemplate`
- Replace the three platform branches.
- Remove Phase 0 origin-side audit emissions + `recordEgress` factory dep.
- Tests: agent-egress.test.js URL/header pattern updates.

**Step 4** — Migrate `recovery.notifyContinuation` to `egress.systemTemplate`
- Replace the three platform branches.
- Tests: recovery.test.js URL/header pattern updates.

**Step 5** — Deploy + observe
- Same sequence as Phase 0 (no migration, code-only).
- Audit log shows: system-template events flowing through `send-handler`, no origin-side double-counts, `template_id` populated.
- Confirm chat fallback still fires when expected (counter behavior preserved).
- Confirm system-template messages persist with `origin: 'system-template'` (D1 query: `SELECT json_extract(metadata, '$.origin'), COUNT(*) FROM messages WHERE created_at > datetime('now', '-1 day') GROUP BY 1`).

## 7. Decision criteria for proceeding to Phase 2

1. **Audit log shows clean classification.** All artifact-summary + recovery-* events tagged `provenance_kind: 'system-template'`, `template_id` populated. Zero events with `agent-explicit-via-curl` from agent-egress code paths.
2. **Channel-authority bypass logged but not abused.** Operator inspects audit for `system-template-bypass` reasons; targets are only operator's Discord channel + OWNER_TELEGRAM_ID.
3. **Counter behavior preserved.** Chat fallback fire rate unchanged from Phase 0 baseline (system-template sends not incrementing the counter).
4. **No delivery regression.** notifyArtifactsCreated + notifyRecoveryComplete + notifyContinuation continue working; no operator-observed missed notifications.
5. **`message.outbound` extensions still receive events** (no payload-shape regression — only additions).
6. **All tests green.**

## 8. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Loopback chokepoint unavailable when `egress.systemTemplate` fires | Low | Notification dropped | `egress.systemTemplate` returns `{ delivered: false }`, never throws — same contract as today's `send()` |
| MCP extension forges `x-egress-provenance` | Medium | Bypass channel-authority for sends to unauthorized channels | Audit log captures source_module; operator-visible. ACE on host = game over already |
| Existing `trusted: true` HTTP callers break | Low | Loss of system-template behavior for legacy paths | Step 1 keeps `trusted` behavior intact. Phase 4 retires it |
| Test flakiness from URL pattern changes | Low | CI noise | Tests stub `fetch` directly; URL is a constant string we control |
| `notifyContinuation` cooldown interferes with envelope dedup | Low | Either over- or under-suppression | Different keys (cooldown by type+channel, dedup by content+channel); no overlap |
| `persistOutboundIfPossible` `origin` override breaks consumers | Low | Chat history search shows messages with unknown origin field | `origin` is opaque metadata; consumers default to `explicit-send`. No breaking change |
| Hook bus subscribers break on payload extension | Negligible | Extension errors | Adding fields is backward-compatible by JS object semantics |
| Migration window leaves partial audit data | Low | Audit log shows recovery still using old path between steps 3 and 4 | Operator-visible; expected; resolved by step 4 |

## 9. Open questions resolved during sweep

1. **`provenanceKind` body field vs header.** → Decided: header (`x-egress-provenance`). Cleaner separation, matches auth-layer concerns.
2. **`agentExplicit` placeholder.** → Decided: drop. Phase 2 adds it.
3. **`operator` entry point.** → Decided: drop for Phase 1. agent-egress.js is the operator-routing abstraction; no need to duplicate.
4. **`templateId` enumeration.** → Decided: free-form string in Phase 1 (audit captures whatever's claimed). Phase 1.5 may add an enum if useful.
5. **Notification cooldown vs envelope dedup overlap.** → Decided: keep both (different windows, different keys). No interference.
6. **Operator-channel registry hydration.** → Out of scope for Phase 1. Phase 7 may add `bindOperatorDiscordChannel` if we want to remove the bypass.

## 10. Open questions deferred to Phase 1.5+

1. **Template parameter schema enforcement.** A future `egress-templates.js` registry could validate params and compose content centrally. Phase 1 doesn't need it; agent-egress.js still composes locally. Add when a 5th+ system-template caller appears.
2. **Channel-kind detection by id format.** agent-egress.js picks platform by which env is set, NOT by the channelId format. Pre-existing issue (e.g., if both Discord and Telegram are configured, it always tries Discord with whatever ID was provided). Not introduced by Phase 1; Phase 7 should address as part of default-to-inbound enforcement.
3. **Hook-bus payload schema versioning.** Adding fields is fine. If we ever need to break compat, version the events (`message.outbound.v2`).

## 11. After Phase 1

The system has:
- Two of three system-authored egress paths going through the chokepoint (agent-egress, notifyContinuation). Chat fallback + proactiveSendFallback remain on Layer B until Phase 3.
- An honest provenance signal at the transport layer (header), with strict-loopback gating.
- Audit log distinguishing system-template from agent-explicit, classified at the chokepoint with no origin-side double-counts.
- Hook bus subscribers can react to provenance.
- Chat history search can filter system-authored messages by metadata.
- Foundation for Phase 2 (`reply` MCP tool + inbound-context primitive).

What we *learn* from Phase 1's audit:
- Frequency of each templateId.
- Whether the chokepoint ever rejects system-template (should be never; if so, gate logic needs review).
- Confirmation that envelope dedup catches duplicate templates (a hint that retries silently double-sent today).
- Whether the channel-authority bypass is being used outside the expected operator channels (security audit).

Phase 1 ships ~250 LOC added, ~80 LOC removed (origin-side audit emissions). Reversible by reverting the two migration commits + the chokepoint header-detection commit.
