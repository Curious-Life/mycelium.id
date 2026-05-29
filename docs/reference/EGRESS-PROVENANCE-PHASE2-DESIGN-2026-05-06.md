# Egress Provenance — Phase 2 Detailed Design (2026-05-06)

Companion to:
- [EGRESS-PROVENANCE-PLAN-2026-05-06.md](EGRESS-PROVENANCE-PLAN-2026-05-06.md) — high-level 7-phase plan
- [EGRESS-PROVENANCE-PHASE1-DESIGN-2026-05-06.md](EGRESS-PROVENANCE-PHASE1-DESIGN-2026-05-06.md) — Phase 1 design
- [EGRESS-PROVENANCE-HANDOFF-2026-05-06.md](EGRESS-PROVENANCE-HANDOFF-2026-05-06.md) — session handoff

Phase 0 (observability) shipped at `b5ac696`. Phase 1 (system-template through chokepoint) shipped at `def925b`. Both deployed to admin + customer fleet. This doc is the implementation design for Phase 2: **`reply` MCP tool + active-turn registry** — the agent's idiomatic, structurally-cleaner explicit-send path that replaces today's curl-from-prompt pattern and unblocks Phase 3's chat-fallback deletion.

> **Revision history.** v1 (handoff sketch) used `/run/mycelium/inbound/<taskId>.json` — file-on-disk keyed by taskId. **Sweep #2 of this design** found the file approach is structurally broken: MCP tool handlers receive only `args` from `CallToolRequest` ([packages/tools/agent-tools.js:152-163](../packages/tools/agent-tools.js#L152)); the long-lived MCP server has no per-call `taskId` to compute the file path; agent-supplied taskId would be hallucinable. v2 (this doc) replaces it with an in-memory active-turn registry on the agent-server + a loopback HTTP-callback (`GET /internal/inbound-context/current`) — same pattern Phase 0's `egress-audit-client.js` already uses. No filesystem write, no AppArmor change, no per-task cleanup race window, no taskId propagation.

## Scope

**In:**
- A new `inbound-context.js` in-process module — active-turn registry. `setActiveTurn(ctx)`, `getActiveTurn()`, `clearActiveTurn()`. Single global state per agent-server process (lane serialization guarantees one /chat turn at a time per agent).
- `egress.js` extended with one entry point: `agentExplicit({ text, target, options })`.
- `send-handler.js` learns a third provenance class: `agent-explicit-via-tool`, signaled by `x-egress-provenance: agent-explicit` header (strict-loopback gated, identical threat model to Phase 1's system-template).
- `chat.js` writes the registry on lane entry, clears in finally.
- `recovery.js` `resumeSession` writes the registry from `checkpoint.deliveryContext` before `runClaudeCode`, clears in finally.
- A new loopback-only endpoint `GET /internal/inbound-context/current` — returns active turn or 404. Mirrors `/internal/audit/egress` auth shape ([admin-fleet.js:486-500](../packages/server/routes/admin-fleet.js#L486)).
- A new `reply` MCP tool registered as a domain factory in `agent-tools.js` (alongside `documentsDomain`, `messagesDomain`, etc).
- Prompt rewrite in `prompt-sections.js` + `prompt-builders.js`: `reply({ text })` becomes the documented idiomatic path; curl remains as an explicit cross-channel fallback.

**Out (later phases):**
- Chat fallback deletion + `proactiveSendFallback` removal — Phase 3.
- Retiring `trusted: true` HTTP support — Phase 4.
- File/voice/email migration through `egress.agentExplicit` — Phases 5-6.
- Default-to-inbound enforcement at the chokepoint (cross-channel `reason` requirement) — Phase 7.

## 1. Sweep findings (consolidated)

### 1a. Lane serialization holds for `/chat`, NOT for siblings

[chat.js:730](../packages/server/routes/chat.js#L730) — `const laneId = 'agent:${AGENT_ID}'`. Inside [lanes.js:36-87](../packages/core/lanes.js#L36): `enqueue` sets `lane.processing = true` before `await entry.taskFn()` and clears in finally. **Per-laneId guarantee: exactly one task runs at a time.** Each agent-server process has exactly one AGENT_ID → exactly one active /chat turn per process at any moment.

**Lane coverage:**
| Endpoint | In lane? | Phase 2 registry? | Reply tool fires? |
|---|---|---|---|
| `/chat` | ✅ yes (line 740 enqueue) | ✅ set-on-entry | ✅ yes |
| `/chat/triage` | ❌ no — explicit comment at [chat.js:1328-1332](../packages/server/routes/chat.js#L1328) "Triage runs OUTSIDE the lane queue" | ❌ never | ❌ refused (no active turn) |
| `/chat/stream`, `/portal/chat/stream` | ❌ no enqueue | ❌ never | ❌ refused |
| `/think` | ❌ no enqueue | ❌ never | ❌ refused |
| `/spawn-task-async` (sub-agent) | parent's lane held until parent's run completes; sub-agent runs in fresh runtime ([spawner.js:102-108](../packages/core/spawner.js#L102)) | ❌ sub-agent doesn't write | ⚠️ edge case — see §4 |
| recovery `resumeSession` | ❌ no enqueue (background continuation) | ✅ set-on-entry | ✅ yes |

**Critical: triage, portal-stream, think, and scheduler runs all return `noReply: true` to their HTTP caller** (CLAUDE.md §11), so they have nothing to deliver via `reply` anyway. Refusing the tool from these contexts is correct — it's not a gap, it's the contract.

### 1b. MCP tool boundary receives only `args`

[agent-tools.js:152-163](../packages/tools/agent-tools.js#L152):
```js
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  ...
});
```

The MCP `CallToolRequest` carries no per-call request metadata. Tool handlers see only what the agent supplied. Combined with the fact that MCP servers are spawned ONCE per agent at Claude Code startup ([setup.js:46-146](../packages/tools/setup.js#L46)) — env vars frozen at spawn time — there is **no in-band signal** by which a tool could derive the current task without trusting the agent.

**Implication:** the `reply` tool must fetch context from the agent-server, not from an env var or args.

### 1c. Loopback HTTP-callback is the cleaner storage mechanism

agent-tools.js already does this for search ([agent-tools.js:170-180](../packages/tools/agent-tools.js#L170) — `searchClient` routes recall through `/internal/v1/search/mindscape`). The pattern is proven. `egress-audit-client.js:43-47`:
```js
function resolveAgentServerUrl() {
  const port = process.env.AGENT_PORT || process.env.PORT;
  if (!port) return null;
  return `http://127.0.0.1:${port}`;
}
```

Reasons file-on-disk loses:
1. No taskId exists at MCP-call time — would have to be agent-supplied (fragile, hallucinable, agent could spoof to read someone else's context).
2. AppArmor profile change required (currently `/run/mycelium/ r,` only — [security/apparmor/mycelium-agent](../security/apparmor/mycelium-agent)).
3. Per-task cleanup race window between turn-end and unlink.
4. Atomic-write requirement (tmp+rename).

Reasons HTTP-callback wins:
1. Lane serialization → "current turn" is a well-defined, atomic concept. Set-on-entry + clear-on-exit is race-free.
2. Auth is loopback-only, same as 7 existing internal endpoints — zero new surface.
3. Test seam is identical to Phase 1's `egress.systemTemplate.fetch` injection.
4. No filesystem state, no cleanup, no AppArmor delta.

### 1d. The inbound shape at chat.js:527-539 + chatDeliveryContext

Field shape from `req.body` ([chat.js:527-539](../packages/server/routes/chat.js#L527)):
```js
const {
  channel, username, userId, history, channelId, messageId,
  taskType: requestedTaskType, sourceAgent,
  priority: taskPriority, context: taskContext, dedupeNonce,
  inboundChatId,        // real telegram/whatsapp chatId (synthetic channelId is `telegram_<id>`)
  inboundMessageId,     // for telegram-group reply-to (preferred over messageId)
  voiceMode,            // true if the inbound was voice
  attachmentId,
} = req.body;
```
Plus `req.body.source` ([chat.js:577](../packages/server/routes/chat.js#L577)) — `'discord'` / `'telegram'` / `'telegram-group'` / `'whatsapp'` / `'autonomous'` / etc. This is the value the registry's `source` field comes from.

The `chatDeliveryContext` constructed at [chat.js:783](../packages/server/routes/chat.js#L783) is `{ channel: 'discord', channelId, messageId, username }` — **the literal string `'discord'` is hardcoded**. Pre-existing quirk; not a Phase 2 concern. The active-turn registry has the full set of fields directly from `req.body` — no need to rely on the partial deliveryContext shape for the chat path. Recovery is the only place that reads `deliveryContext` (see §4d), and Phase 2 reconstructs the registry entry from `deliveryContext.channelId` via channel-registry lookup.

### 1e. canSendTo reply-path is permissive without registry presence

[channels.js:493-506](../packages/server/lib/channels.js#L493):
```js
// 1. Reply path: target == source → allow.
if (
  sourceKind && sourceId
  && sourceKind === targetKind
  && String(sourceId) === String(targetId)
) {
  ...
  return { allowed: true, code: 'reply', record: rec ? { ...rec } : null, audit: false };
}
```

When `reply({ target: 'inbound' })` resolves to `target == source`, `canSendTo` allows without registry presence. This means **fresh inbound channels work immediately** — no pre-registration step needed for new users / new groups / new DMs. This was a load-bearing constraint for the design choice (see also Phase 1 design §1d's note that the operator's Discord channel + OWNER_TELEGRAM_ID DM aren't auto-registered today).

### 1f. send-handler.js Phase 1 implementation: where Phase 2 plugs in

[send-handler.js:144-159](../packages/server/lib/send-handler.js#L144):
```js
const socketIp = req.socket?.remoteAddress || '';
const headers = req.headers || {};
const isStrictLoopback =
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socketIp)
  && !headers['x-forwarded-for'];
const isSystemTemplate =
  headers['x-egress-provenance'] === 'system-template'
  && isStrictLoopback;
const templateId = isSystemTemplate
  ? (headers['x-egress-template-id'] || null)
  : null;
const provenanceKind = (isSystemTemplate || trusted)
  ? 'system-template'
  : 'agent-explicit-via-curl';
```

Phase 2 adds a third boolean and a third audit class:
```js
const isAgentExplicit =
  headers['x-egress-provenance'] === 'agent-explicit'
  && isStrictLoopback;
const provenanceKind = (isSystemTemplate || trusted)
  ? 'system-template'
  : isAgentExplicit
    ? 'agent-explicit-via-tool'
    : 'agent-explicit-via-curl';
```

**No gate behavior changes for `agent-explicit`.** Channel-authority, dedup, persist, hook bus, audit, `trackExplicitSend` — all apply identically to today's `agent-explicit-via-curl` path. The only difference is the audit row's `provenance_kind` value, which lets us distinguish reply-tool sends from raw-curl sends in audit data (key for Phase 3's pre-flight check).

### 1g. Existing `/internal/*` endpoints set the auth pattern

[admin-fleet.js:486-500](../packages/server/routes/admin-fleet.js#L486) (POST `/internal/audit/egress`):
```js
router.post('/internal/audit/egress', async (req, res) => {
  const socketIp = req.socket?.remoteAddress || '';
  const isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socketIp)
    && !req.headers['x-forwarded-for'];
  if (!isLocal) return res.status(404).end();
  ...
});
```

7 sibling endpoints follow this pattern (`/internal/guardians/metrics`, `/internal/crypto-test`, `/internal/kms-status`, `/internal/secrets-status`, `/internal/audit-status`, `/internal/egress-audit/status`, `/internal/audit/egress`). Phase 2 adds an 8th: `GET /internal/inbound-context/current`. Same auth, returns the active turn or 404.

## 2. Threat model

The `x-egress-provenance: agent-explicit` header is honored only under strict-loopback, identical to Phase 1's system-template gate. The new attack surface is the in-memory registry + the new endpoint.

**Threat A: Stale registry — reply tool fires from a stale turn.**
- Root cause: registry not cleared between turns, OR cleared but a sub-agent fires reply during parent's still-active turn.
- Mitigation: lane's finally always clears (idempotent overwrite at lane entry catches missed clears). For sub-agent edge case see §4b.

**Threat B: External caller forges `x-egress-provenance: agent-explicit`.**
- Excluded by strict-loopback gate (loopback IP AND no X-Forwarded-For). Caddy-proxied requests fail the gate.
- Same defense Phase 1 already established.

**Threat C: Local process (MCP extension) forges `agent-explicit` to bypass channel-authority.**
- Channel-authority is **not** bypassed for `agent-explicit` (unlike system-template). Forging the header buys nothing.
- Audit log captures `source_module: 'send-handler'` + `provenance_kind: 'agent-explicit-via-tool'` regardless. Operator visibility unchanged.

**Threat D: Local process queries `/internal/inbound-context/current` to harvest user inbound IDs / message IDs.**
- ACE on host already pwns the agent. Endpoint is loopback-only.
- The endpoint exposes `{ source, channelId, channelKind, messageId, username, voiceMode }` — same fields the agent sees in its prompt today. Not a new exposure surface.

**Threat E: Reply-tool returns `delivered: false` with channel info, agent loops on it.**
- Tool returns errorCode strings ("no-active-turn", "channel-authority-denied", "rate-limited"). Agent's prompt instructs: error → escalate to operator-diagnostic, do not retry the same target.
- Audit log captures any retry pattern; operator-visible.

**Threat acceptance:** sub-agent edge case (§4b) and channel-authority bypass for system-template (Phase 1) remain. Phase 2 adds no new accepted threat.

## 3. Module shape

### 3a. `packages/server/lib/inbound-context.js` — new (~50 LOC)

```js
/**
 * Active-turn registry — single source of truth for "what is this agent
 * currently replying to."
 *
 * The agent-server is a single Node process per agent. Per-agent lane
 * serialization in chat.js (laneId = `agent:${AGENT_ID}`) guarantees at
 * most one /chat turn is active at any moment. Therefore a single global
 * `activeTurn` reference is sufficient — no Map keyed by anything.
 *
 * Lifecycle:
 *   - chat.js sets the registry on lane entry, clears in finally.
 *   - recovery.js sets the registry before runClaudeCode (resume),
 *     clears in finally.
 *   - All other entry points (think, triage, portal-stream, scheduler)
 *     never write the registry. Reply tool refuses cleanly when registry
 *     is empty.
 *
 * The reply MCP tool reads via GET /internal/inbound-context/current.
 * In-process callers (send-handler audit emitter) can read directly.
 */

let _activeTurn = null;

/**
 * @typedef {object} ActiveTurnContext
 * @property {string}  source        e.g. 'discord' | 'telegram' | 'telegram-group' | 'whatsapp' | 'portal'
 * @property {string}  channelKind   registry kind: 'discord-channel' | 'telegram-dm' | 'telegram-group' | 'whatsapp-jid' | etc.
 * @property {string}  channelId     send-route target id (real chatId/channelId — NOT synthetic `telegram_<id>`)
 * @property {string=} channel       human channel name (privacy-redacted in logs)
 * @property {string=} username
 * @property {string=} userId
 * @property {string=} inboundMessageId   for reply-to in groups
 * @property {boolean=} voiceMode         inbound was voice → reply tool can hint voice:true
 * @property {string=} taskId             stable identifier for audit correlation
 * @property {number}  setAt          timestamp ms (debug + stale-detection)
 */

export function setActiveTurn(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    throw new TypeError('setActiveTurn: context object required');
  }
  if (!ctx.channelId) {
    throw new TypeError('setActiveTurn: channelId required');
  }
  _activeTurn = { ...ctx, setAt: Date.now() };
}

export function getActiveTurn() {
  return _activeTurn;
}

export function clearActiveTurn() {
  _activeTurn = null;
}

/** Test seam. */
export function _resetForTests() {
  _activeTurn = null;
}
```

**Why a single global, not a Map:** the agent-server process serves a single AGENT_ID. Lane-id is keyed by that agent. There is no scenario in which two `/chat` turns for different agents would be active in the same process. Future extensibility (multi-tenant agent-server) is YAGNI.

**Stale-detection helper:** `getActiveTurn()` could check `setAt` against a max-turn-duration (e.g., 5 min) and return null if stale. Recommendation: don't add this in Phase 2 — let bugs surface as audit anomalies. Cleanup discipline in §3f covers the happy path.

### 3b. `packages/server/lib/egress.js` — extended (~70 LOC added)

Add a sibling to `systemTemplate`:

```js
/**
 * @typedef {object} AgentExplicitArgs
 * @property {'telegram'|'discord'|'whatsapp'} platform
 * @property {string} channelId        target id (telegram chatId, discord channelId, whatsapp jid)
 * @property {string} content          message body
 * @property {object} [options]
 * @property {boolean} [options.voice]
 * @property {string|number} [options.replyToMessageId]
 * @property {string} [options.sourceKind]    inbound kind for audit + canSendTo
 * @property {string} [options.sourceId]      inbound id for audit + canSendTo
 *
 * @returns {Promise<{ delivered: boolean, httpStatus?: number, errorCode?: string }>}
 */
export async function agentExplicit(args) {
  if (!_config) throw new Error('egress.agentExplicit: not configured (call configureEgress at boot)');
  if (!args || typeof args !== 'object') return { delivered: false, errorCode: 'invalid-args' };

  const { platform, channelId, content, options = {} } = args;
  if (!VALID_PLATFORMS.has(platform)) return { delivered: false, errorCode: 'invalid-platform' };
  if (typeof content !== 'string' || !content) return { delivered: false, errorCode: 'missing-required' };
  if (platform !== 'whatsapp' && (channelId == null || String(channelId).trim() === '')) {
    return { delivered: false, errorCode: 'missing-required' };
  }

  // Body shape mirrors systemTemplate; sourceKind/sourceId/replyToMessageId/voice
  // pass through to send-handler as today's curl path expects them.
  const body = platform === 'telegram'
    ? { chatId: String(channelId), text: content,
        ...(options.voice ? { voice: true } : {}),
        ...(options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {}),
        ...(options.sourceKind ? { sourceKind: options.sourceKind } : {}),
        ...(options.sourceId ? { sourceId: options.sourceId } : {}) }
    : platform === 'discord'
      ? { channelId: String(channelId), content,
          ...(options.sourceKind ? { sourceKind: options.sourceKind } : {}),
          ...(options.sourceId ? { sourceId: options.sourceId } : {}) }
      : { text: content,
          ...(options.sourceKind ? { sourceKind: options.sourceKind } : {}),
          ...(options.sourceId ? { sourceId: options.sourceId } : {}) };

  const url = `http://127.0.0.1:${_config.agentServerPort}/${platform}/send`;
  try {
    const res = await _config.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-egress-provenance': 'agent-explicit',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Try to surface chokepoint's error code (channel-authority denied, etc.)
      let errorCode = `http-${res.status}`;
      try {
        const j = await res.json();
        if (j?.error) errorCode = String(j.error).slice(0, 60);
      } catch { /* keep http-status code */ }
      return { delivered: false, httpStatus: res.status, errorCode };
    }
    return { delivered: true, httpStatus: res.status };
  } catch (e) {
    console.warn(`[${_config.logPrefix}] egress.agentExplicit (${platform}) failed: ${e.message}`);
    return { delivered: false, errorCode: 'fetch-failed' };
  }
}
```

**Why pass `sourceKind`/`sourceId` from the caller, not derive them at the chokepoint from a registry lookup:** the chokepoint's `enforceChannelAuthority` already accepts `sourceKind`+`sourceId` in `req.body` (used by today's curl pattern). Threading them through `agentExplicit` keeps the function signature self-contained and lets `reply` tool's HTTP layer (§3e) make the call without depending on the chokepoint reading the registry. (The chokepoint *could* read the registry for `agent-explicit` requests, but that creates a hidden coupling — Phase 2 keeps the chokepoint's interface simple and consumer-driven.)

### 3c. `packages/server/lib/send-handler.js` — extended (~10 LOC change)

Modification to lines 144-159 only:
```js
const isAgentExplicit =
  headers['x-egress-provenance'] === 'agent-explicit'
  && isStrictLoopback;
// ... isSystemTemplate / templateId unchanged ...
const provenanceKind = (isSystemTemplate || trusted)
  ? 'system-template'
  : isAgentExplicit
    ? 'agent-explicit-via-tool'
    : 'agent-explicit-via-curl';
```

**No other changes.** All gates apply uniformly. `trackExplicitSend` fires (incrementing the per-channel counter), which means when a `/chat` turn calls `reply({ text })` and that text reaches the inbound channel, the existing chat-fallback's "if zero explicit sends" check sees count > 0 and skips. **This is how Phase 2 closes most of the leak class without deleting the fallback** — the fallback simply stops firing because the agent is now using a path that increments the counter.

The fallback stays alive as a safety net through Phase 2 → Phase 3. Phase 3 deletes it once audit data confirms `agent-explicit-via-tool` count grew to ~match historical `agent-explicit-via-fallback` count.

### 3d. `packages/server/routes/admin-fleet.js` — new endpoint (~25 LOC)

Adjacent to existing internal endpoints (after line 508):
```js
// Phase 2 of EGRESS-PROVENANCE: returns the active /chat turn's inbound
// context for the reply MCP tool. Loopback-only — same auth as the other
// /internal/* endpoints.
//
// Returns 404 with a structured body when no turn is active, so the reply
// tool can surface a clean errorCode to the agent ("no-active-turn") and
// the agent's prompt can route the message via curl as a fallback (Phase 2
// keeps curl as a documented escape hatch; Phase 3 won't).
router.get('/internal/inbound-context/current', async (req, res) => {
  const socketIp = req.socket?.remoteAddress || '';
  const isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socketIp)
    && !req.headers['x-forwarded-for'];
  if (!isLocal) return res.status(404).end();

  const { getActiveTurn } = await import('@mycelium/server/lib/inbound-context.js');
  const turn = getActiveTurn();
  if (!turn) {
    return res.status(404).json({ error: 'no-active-turn' });
  }
  // Return the registry entry as-is. No PII redaction at this boundary —
  // the consumer is the in-process MCP child, which already has the same
  // privilege as the parent agent (same UID, same AppArmor profile).
  return res.json(turn);
});
```

### 3e. `packages/tools/agent-tools/reply-domain.js` — new (~110 LOC)

Domain-factory pattern matching existing tools (createDocumentsDomain, etc.):
```js
/**
 * Reply MCP tool — agent-explicit egress with default-to-inbound resolution.
 *
 * The tool resolves the target by HTTP-callback to the agent-server's
 * /internal/inbound-context/current endpoint. The active-turn registry
 * means there's exactly one possible target per agent at any moment.
 *
 * Phase 2 of EGRESS-PROVENANCE — see docs/EGRESS-PROVENANCE-PHASE2-DESIGN.md
 */

const REPLY_TOOL_SCHEMA = {
  name: 'reply',
  description:
    `Reply to the inbound message that started this turn. Default target is the
inbound channel (Telegram chat / Discord channel / WhatsApp DM that delivered
the user's message). Calling reply() without a target sends to inbound.

Use reply() instead of curl whenever possible — it auto-fills the target
from the active turn, eliminates chatId/channelId hallucination, and surfaces
audit/provenance correctly. Fall back to curl ONLY for cross-channel sends
that need an explicit target.

Returns { delivered, errorCode? }. delivered=false errors:
  - 'no-active-turn'         — tool called outside /chat (autonomous, triage, think, sub-agent)
  - 'channel-authority-denied' — registry rejected the target (rare for inbound)
  - 'rate-limited'           — Discord per-hour budget hit
  - 'fetch-failed'           — agent-server unreachable

Do NOT loop on errors. If reply fails, escalate via operator-diagnostic
patterns (NO_REPLY ending; describe the failure in scratchpad).`,
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'message body — required' },
      voice: { type: 'boolean', description: 'telegram only — also synthesize voice (TTS)' },
    },
    required: ['text'],
  },
};

export function createReplyDomain({ agentServerPort, fetch = globalThis.fetch }) {
  if (!agentServerPort) throw new TypeError('createReplyDomain: agentServerPort required');

  async function fetchActiveTurn() {
    try {
      const res = await fetch(`http://127.0.0.1:${agentServerPort}/internal/inbound-context/current`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 404) return null;
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function callAgentExplicit({ platform, channelId, text, options }) {
    const url = `http://127.0.0.1:${agentServerPort}/${platform}/send`;
    const body = platform === 'telegram'
      ? { chatId: String(channelId), text,
          ...(options.voice ? { voice: true } : {}),
          ...(options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {}),
          sourceKind: options.sourceKind, sourceId: options.sourceId }
      : platform === 'discord'
        ? { channelId: String(channelId), content: text,
            sourceKind: options.sourceKind, sourceId: options.sourceId }
        : { text,
            sourceKind: options.sourceKind, sourceId: options.sourceId };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-egress-provenance': 'agent-explicit',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { delivered: true };
      let errorCode = `http-${res.status}`;
      try {
        const j = await res.json();
        if (j?.error) errorCode = String(j.error).slice(0, 60);
      } catch {}
      return { delivered: false, errorCode };
    } catch (e) {
      return { delivered: false, errorCode: 'fetch-failed' };
    }
  }

  function platformFromSource(source) {
    if (!source) return null;
    if (source === 'discord') return 'discord';
    if (source === 'telegram' || source === 'telegram-group') return 'telegram';
    if (source === 'whatsapp') return 'whatsapp';
    return null;
  }

  async function handleReply(args) {
    const text = String(args?.text || '').trim();
    if (!text) return JSON.stringify({ delivered: false, errorCode: 'missing-text' });

    const turn = await fetchActiveTurn();
    if (!turn) return JSON.stringify({ delivered: false, errorCode: 'no-active-turn' });

    const platform = platformFromSource(turn.source);
    if (!platform) return JSON.stringify({ delivered: false, errorCode: 'invalid-source' });

    const result = await callAgentExplicit({
      platform,
      channelId: turn.channelId,
      text,
      options: {
        voice: !!args?.voice && platform === 'telegram',
        replyToMessageId: turn.inboundMessageId,
        sourceKind: turn.channelKind,
        sourceId: turn.channelId,
      },
    });
    return JSON.stringify(result);
  }

  return {
    tools: [REPLY_TOOL_SCHEMA],
    handlers: { reply: handleReply },
  };
}
```

**Wired into `agent-tools.js`:** add a domain factory call alongside the existing ones (around [agent-tools.js:281](../packages/tools/agent-tools.js#L281)):
```js
const replyDomain = createReplyDomain({
  agentServerPort: process.env.AGENT_PORT || process.env.PORT,
});
TOOLS = [
  ...replyDomain.tools,
  ...documentsDomain.tools,
  ...messagesDomain.tools,
  // ... existing
];
```

And the handler dispatch (`domainHandlers`):
```js
const domainHandlers = {
  ...replyDomain.handlers,
  ...documentsDomain.handlers,
  // ...
};
```

The handler is registered automatically — no setup.js change needed (reply lives inside the existing `agent-tools` MCP server).

**Permission rule:** [setup.js:68](../packages/tools/setup.js#L68) already has `mcp__agent-tools__*` in the allow list. The `reply` tool inherits this; no permission change required.

### 3f. `packages/server/routes/chat.js` — set/clear registry around lane (~10 LOC)

Inside the existing enqueue callback ([chat.js:740-785](../packages/server/routes/chat.js#L740)):
```js
const result = await enqueue(laneId, async () => {
  incrementActiveTask();

  // Phase 2 of EGRESS-PROVENANCE: register the active turn so the
  // reply MCP tool can default-target replies to the inbound channel.
  // Lane serialization guarantees at most one active turn per agent;
  // overwriting on every entry is safe (idempotent — last write wins,
  // which catches any missed cleanup from a prior turn that crashed).
  const turnSource = req.body.source || (channel ? 'discord' : 'unknown');
  setActiveTurn({
    source: turnSource,
    channelKind: deriveChannelKind(turnSource, channelId, inboundChatId),  // helper, see below
    channelId: inboundChatId || channelId,  // real platform id, not synthetic
    channel,
    username,
    userId,
    inboundMessageId,
    voiceMode: !!voiceMode,
    taskId: `chat-turn:${channelId || 'unknown'}:${requestTime.getTime()}`,
  });

  try {
    // ... existing run-with-continuation block ...
  } finally {
    clearActiveTurn();
  }
});
```

`deriveChannelKind` (small helper, near the top of chat.js or in inbound-context.js):
```js
function deriveChannelKind(source, channelId, inboundChatId) {
  if (source === 'discord') return 'discord-channel';
  if (source === 'telegram-group') return 'telegram-group';
  if (source === 'telegram') {
    return String(inboundChatId || channelId || '').startsWith('-') ? 'telegram-group' : 'telegram-dm';
  }
  if (source === 'whatsapp') return 'whatsapp-jid';
  if (source === 'portal') return 'portal-session';
  return source || 'unknown';
}
```

**The `try/finally` is INSIDE the enqueue callback** — by the time the lane releases, `clearActiveTurn()` has fired. Even on error/timeout the registry is cleared. The outer try/finally at [chat.js:1196-1198](../packages/server/routes/chat.js#L1196) doesn't need to know about the registry.

### 3g. `packages/server/lib/recovery.js` — register on resume (~10 LOC)

In `resumeSession` ([recovery.js:284-294](../packages/server/lib/recovery.js#L284)):
```js
const dctx = checkpoint.deliveryContext || {};
if (dctx.channelId) {
  // Reconstruct the registry entry from the preserved deliveryContext.
  // We don't have voiceMode/inboundMessageId here (recovery doesn't replay
  // voice; the agent's reply during resumption is a continuation, not a
  // direct reply-to-message). source/kind are inferred from the channelId
  // shape via the channel registry.
  const reg = channelRegistry?.findByCanonicalId?.(dctx.channelId);
  setActiveTurn({
    source: reg?.kind ? mapKindToSource(reg.kind) : 'unknown',
    channelKind: reg?.kind || 'unknown',
    channelId: dctx.channelId,
    channel: dctx.channel,
    username: dctx.username,
    taskId: `recovery-resume:${checkpoint.sessionId}`,
  });
}

try {
  const { result: output } = await runClaudeCode(fullPrompt, { ... });
  ...
} finally {
  clearActiveTurn();
}
```

**Migration concern: existing in-flight checkpoints lack the registry context.** Recovery's behavior degrades gracefully — `findByCanonicalId` returns null → `source: 'unknown'`, `channelKind: 'unknown'` → reply tool's `platformFromSource('unknown')` returns null → reply tool refuses with `invalid-source` errorCode. Recovered runs fall back to today's curl pattern. Acceptable; recovery resumes are infrequent and Phase 2's value lands on /chat first.

### 3h. Prompt rewrite — `packages/server/chat/prompt-sections.js` + `prompt-builders.js`

Two surfaces change:
1. **`responseNotesSection`** (around [prompt-sections.js:414-484](../packages/server/chat/prompt-sections.js#L414)) — the inline curl example for replying to inbound. Replace with `reply({ text })` reference. Curl pattern moves to a separate "cross-channel send" subsection as the documented escape hatch.
2. **`autonomousMessagingSection`** (around [prompt-sections.js:272-304](../packages/server/chat/prompt-sections.js#L272)) — examples of sending in autonomous (no-inbound) contexts. These remain curl, since there's no active turn to reply to. Document this distinction explicitly.

**Replacement text (responseNotesSection):**
```
## To reply to this turn

Call the `reply` MCP tool with the message text:

  reply({ text: "your reply here" })

The tool auto-targets the inbound channel — no chatId/channelId required.
For voice replies (Telegram only): reply({ text: "...", voice: true })

Anti-leak invariant unchanged: your text output is your scratchpad and is
NOT delivered. Only what you pass to reply() (or the cross-channel curl
below) reaches the user.

## To send to a different channel (cross-channel)

If you need to send to a channel OTHER than the inbound (e.g., post a
research note to #agent-collab while replying to a Telegram DM), use
curl with an explicit targetName from the channel-authority list:

  curl -X POST http://localhost:${port}/discord/send \
    -H "Content-Type: application/json" \
    -d '{"targetName":"<#agent-collab>","content":"..."}'

Cross-channel sends are audit-classed; only do this when the user
explicitly asked for it.
```

**Anti-leak warnings preserved verbatim** ([prompt-sections.js:297-300](../packages/server/chat/prompt-sections.js#L297), [436](../packages/server/chat/prompt-sections.js#L436), [542-544](../packages/server/chat/prompt-sections.js#L542)). The `triageSection` ([491-504](../packages/server/chat/prompt-sections.js#L491)) is unaffected (triage runs outside lane, doesn't see `reply`).

**Per-agent variance preserved.** The current rendering already conditional-branches by `prefersTelegram` / `servesPortal` — Phase 2's prompt change is a string substitution at the same conditional point. No new branches.

**Auto-discovery for the reply tool:** Claude Code lists MCP tools in its prompt automatically from the `inputSchema`. The hand-rolled instruction text above is in addition to that auto-listing — it tells the agent *when* and *why* to prefer reply over curl.

## 4. Edge cases — explicit decisions

### 4a. /chat/triage, /think, /chat/stream, /portal/chat/stream, scheduler runs

**Don't write the registry.** Reply tool sees `getActiveTurn() === null` → returns `errorCode: 'no-active-turn'`. Agent's prompt for these contexts (triage's `triageSection`, think's autonomous prompt) doesn't reference reply tool. If agent calls reply anyway (LLM creativity), tool refuses cleanly; agent has the curl pattern as documented fallback.

**Why this is correct:** these endpoints structurally don't deliver agent text (`noReply: true` semantics in CLAUDE.md §11). Reply tool refusing them mirrors the architectural intent.

### 4b. Sub-agent `/spawn-task-async` — accepted edge case

When parent's `/chat` is still in flight and a sub-agent (spawned via `/spawn-task-async`) calls `reply`, the registry shows the parent's turn → sub-agent's reply would route to parent's inbound channel. **Wrong semantically.**

Options considered:
1. **Accept + document** ← chosen for Phase 2.
2. Per-turn token in registry, threaded to sub-agent's MCP env (frozen at spawn — won't work for sub-agent's MCP which is freshly spawned by sub-agent's runClaudeCode).
3. Caller PID via SO_PEERCRED (Linux UNIX-socket only; doesn't apply to TCP loopback).

**Why option 1:** sub-agents are autonomous (no user-facing turn). They send via the system-template path (Phase 1 — `notifyArtifactsCreated`, etc.) or remain silent. Reply-from-sub-agent during parent's still-running turn is a niche case; if it ever fires in practice, audit data will show it (`agent-explicit-via-tool` rows with sub-agent's traceId vs parent's), and Phase 2.5 can revisit with token plumbing.

**Documented in agent prompts** for spawned tasks: "you are running as a sub-agent of <parent>; your output is captured in the spawn result, not delivered to a chat channel. If you need to notify the operator, use the system-template helpers." (Existing wording in spawn-task contexts already implies this; reinforce in prompt-builders.js.)

### 4c. Reply tool called twice with same text

Phase 1's envelope-dedup catches identical-content within 30s ([send-handler.js:282-285](../packages/server/lib/send-handler.js#L282)). Both calls go through chokepoint; first delivers, second is dedup-suppressed (returns `ok: true, deduped: true`). Reply tool surfaces `delivered: false, errorCode: 'deduped'` to the agent on the second call. No user-visible double-send.

### 4d. Reply tool with different content called twice in one turn

Both deliver. Two messages land on the channel. Multi-message replies are valid (agent decides to send a long answer in chunks). **Not a bug.**

### 4e. Recovery resume calls `reply` from a checkpoint missing deliveryContext

`findByCanonicalId` returns null → `source: 'unknown'` → reply tool refuses with `invalid-source`. Recovered run falls back to curl. Acceptable degradation.

### 4f. Reply tool from inside `runClaudeCode` continuation (rate-limit retry)

Continuations run inside the same lane (`runWithContinuation` — [chat.js:787](../packages/server/routes/chat.js#L787)). Registry remains set throughout. Reply tool works exactly the same as the first attempt. ✅

### 4g. Portal-stream agent calling reply

`/portal/chat/stream` doesn't write the registry. Agent's reply tool call returns `no-active-turn`. Portal delivers via SSE not chokepoint anyway, so this is correct: the agent's text streams to the portal user via the SSE protocol, not via the bot chokepoint. Reply tool refusing prevents accidental cross-routing of portal content to bot channels.

## 5. Audit emission topology

| Provenance kind | Source | Phase 0 | Phase 1 | Phase 2 |
|---|---|---|---|---|
| `system-template` | system-authored sends (artifact-summary, recovery-*, etc.) | origin-side emissions | chokepoint emissions, header-driven | unchanged |
| `agent-explicit-via-curl` | agent-authored curl from prompt | chokepoint emissions | chokepoint emissions | unchanged (still allowed for cross-channel + file/voice until Phases 5-6) |
| `agent-explicit-via-tool` | reply MCP tool | n/a | n/a | **NEW** — chokepoint emissions when `x-egress-provenance: agent-explicit` |
| `agent-explicit-via-fallback` | chat.js `deliverNaturalReplyFallback` | origin-side emissions | unchanged | unchanged (Phase 3 deletes) |
| `agent-explicit-via-recovery` | `proactiveSendFallback` | origin-side emissions | unchanged | unchanged (Phase 3 deletes) |
| `agent-explicit-via-tool` (email) | gmail tool, ops-tools sendReply | origin-side emissions, channel kind 'email' | unchanged | unchanged (Phase 6 routes through chokepoint) |

**Phase 2's audit value:** `agent-explicit-via-tool` (chokepoint) and `agent-explicit-via-fallback` (origin-side) become directly comparable. Pre-flight check for Phase 3 (delete fallback) is `count(agent-explicit-via-tool) ≈ historical count(agent-explicit-via-fallback)` — apples to apples.

## 6. Test strategy

### New unit tests

**`packages/server/test/lib/inbound-context.test.js`** (~80 LOC):
- `setActiveTurn` throws on missing channelId
- `setActiveTurn` accepts full context + adds setAt
- `getActiveTurn` returns null when not set
- `getActiveTurn` returns last set context
- `setActiveTurn` overwrites previous (idempotent — last write wins)
- `clearActiveTurn` returns null after
- `_resetForTests` between cases

**`packages/server/test/lib/egress-agent-explicit.test.js`** (~120 LOC):
Mirrors `egress.test.js` shape from Phase 1.
- `agentExplicit` validates platform / content / channelId
- `agentExplicit` POSTs to loopback `/<platform>/send`
- Sends `x-egress-provenance: agent-explicit` header
- Telegram body shape: `chatId`/`text` (+ voice, replyToMessageId, sourceKind, sourceId)
- Discord body shape: `channelId`/`content` (+ sourceKind, sourceId)
- WhatsApp body shape: `text` (+ sourceKind, sourceId)
- Returns `{ delivered: true }` on 2xx
- Returns `{ delivered: false, errorCode }` on 4xx (extracts error code from response body when JSON)
- Returns `{ delivered: false, errorCode: 'fetch-failed' }` on network error
- Never throws

**`packages/server/test/lib/send-handler.agent-explicit.test.js`** (extension to existing send-handler tests, ~80 LOC):
- `x-egress-provenance: agent-explicit` + loopback + no XFF → audit `provenance_kind: 'agent-explicit-via-tool'`
- Same gates apply: trackExplicitSend FIRES, channel-authority FIRES (registry lookup), envelope dedup FIRES
- `agent-explicit` + non-loopback → header IGNORED, classified as `agent-explicit-via-curl`
- `agent-explicit` + loopback + WITH XFF → header IGNORED
- `agent-explicit` AND `system-template` headers both present → `system-template` wins (security: if attacker forges `agent-explicit` thinking it gets a benefit, they actually lose the explicit-tool classification)

**`packages/tools/test/agent-tools-reply.test.js`** (~150 LOC):
- `reply({ text })` calls `/internal/inbound-context/current` first
- Returns `no-active-turn` errorCode on 404
- Resolves Telegram source → POSTs to `/telegram/send` with chatId from registry
- Resolves Discord source → POSTs to `/discord/send` with channelId
- Resolves Telegram-group → preserves `inboundMessageId` as `replyToMessageId`
- Resolves voice flag for Telegram only (silently dropped for Discord/WhatsApp)
- Returns chokepoint's errorCode pass-through (e.g., `unknown-channel`)
- Empty text → `missing-text` errorCode
- Sub-agent / autonomous (registry empty) → `no-active-turn`

**`packages/server/test/routes/admin-fleet-inbound-context.test.js`** (~50 LOC):
- `GET /internal/inbound-context/current` from non-loopback → 404
- From loopback with no active turn → 404 + JSON `{ error: 'no-active-turn' }`
- From loopback with active turn → 200 + full registry entry
- With X-Forwarded-For header → 404 (forged proxy)

### Integration tests

**`packages/server/test/integration/reply-tool-end-to-end.test.js`** (~120 LOC):
1. Inject mock channel-registry + mock platform send (telegram-api stub)
2. Fire `POST /chat` with telegram inbound
3. Inside the simulated agent run, call reply tool's handler directly (with the local agent-server URL)
4. Assert: chokepoint received the request, channel-authority allowed (reply path), telegram-api stub received the text, audit row classified as `agent-explicit-via-tool`, persistOutboundIfPossible got `origin: 'explicit-send'` (NOT system-template)
5. Assert: `trackExplicitSend` counter for inbound channelId is now 1
6. Assert: `deliverNaturalReplyFallback` would NOT fire (counter > 0)

**Run existing tests** to confirm no regression: `node --test packages/server/test/lib/egress*.test.js packages/server/test/lib/send-handler.test.js packages/server/test/lib/agent-egress.test.js packages/server/test/lib/recovery.test.js`. Phase 1's 140 tests must still pass.

## 7. Implementation order

Each step independently shippable. Stop after any step if needed.

**Step 1** — `inbound-context.js` + chat.js + recovery.js wiring (no tool yet, no behavior change for callers; registry exists and is populated) — **SHIPPED 9789f3c (admin only)**
- New file: `packages/server/lib/inbound-context.js`
- Modify: `packages/server/routes/chat.js` to set/clear inside enqueue
- Modify: `packages/server/lib/recovery.js` to set/clear around `runClaudeCode`
- Tests: `inbound-context.test.js` (16 cases passing)
- Smoke: log a debug line when registry is set, fire `/chat`, observe in PM2 logs

**Step 2** — `/internal/inbound-context/current` endpoint (read-only; no consumer yet) — **CODE LANDED (uncommitted at 2026-05-06 evening); tests passing; smoke deferred to deploy stage**
- Modify: `packages/server/routes/admin-fleet.js` (added after `/internal/egress-audit/status`)
- Tests: appended 4 cases to `packages/server/test/routes/admin-fleet.test.js` — empty registry → 404+errorBody, populated + loopback → 200+turn, populated + XFF → 404+empty (gate trips first), order-of-checks regression guard (gate before module import). 31/31 admin-fleet tests pass.
- Smoke: `ssh operator-host "curl -s http://127.0.0.1:3004/internal/inbound-context/current"` — idle returns `{"error":"no-active-turn"}`, during /chat returns the populated turn.

**Step 3** — `egress.agentExplicit` + `send-handler.js` `agent-explicit` header recognition (chokepoint accepts the new provenance class; no caller yet) — **CODE LANDED (uncommitted at 2026-05-06 evening); 196/196 tests pass; greenfield provenance-dispatch tests added**
- Modify: `packages/server/lib/egress.js` (added `agentExplicit` ~95 LOC; mirrors `systemTemplate` shape, narrower option allowlist, decodes chokepoint error JSON for typed errorCode)
- Modify: `packages/server/lib/send-handler.js` (added `isAgentExplicit` detection + 3rd ternary branch in dispatch; lines 144-167)
- Tests: `egress.test.js` extended with 20 new `agentExplicit` cases (44/44 pass); `send-handler.test.js` extended with 9 new provenance-dispatch cases (30/30 pass) — first tests in the repo locking the header→provenanceKind contract
- Smoke: deferred to deploy stage. Manual `curl -H 'x-egress-provenance: agent-explicit' http://127.0.0.1:3004/telegram/send ...` against admin should emit an audit row with `provenance_kind = 'agent-explicit-via-tool'`

**Step 4** — `reply` MCP tool + agent-tools.js registration + prompt rewrite (agents can use reply; chat fallback still alive as safety net) — **CODE LANDED (uncommitted at 2026-05-06 night); 428/428 regression tests pass**
- New file: `packages/tools/agent-tools/domains/reply.js` (~150 LOC) — domain factory mirroring `createDelegationDomain` shape; takes `{ agentUrl, fetch }`; soft-fails with readable errorCode when agentUrl missing; POSTs `/internal/inbound-context/current` then chokepoint `/<platform>/send` with `x-egress-provenance: agent-explicit` header
- Modify: `packages/tools/agent-tools.js` — import + instantiate `replyDomain`; reply tools/handlers prepended to TOOLS / domainHandlers (highest visibility position)
- Modify: `packages/server/chat/prompt-sections.js` — `responseNotesSection` now LEADS with `reply({ text })` example and KEEPS `selectPlatformCurlHint` curl as platform-specific fallback / cross-channel path. `voice: true` flag is conditional on `voiceMode + telegram` source. errorCode names (`no-active-turn`, `invalid-source`) documented in the prompt so the agent knows when to fall back vs stop
- Tests: `packages/tools/test/agent-tools/domains/reply.test.js` (32 cases) + `packages/server/test/chat/prompt-sections.test.js` (+7 cases for reply-tool contract; total 79/79). Reply test surface covers construction, argument validation, agentUrl-unset, active-turn fetch (5 paths), chokepoint POST shape (8 platform/voice/header asserts), delivery result (6 cases including 60-char errorCode truncation + handler-never-throws invariant)
- `prompt-builders.js` UNTOUCHED — file/voice/cross-channel curl helpers stay as-is (Phase 5/6 territory). `autonomousMessagingSection` UNTOUCHED — autonomous wake has no active turn; reply tool would refuse with `no-active-turn` cleanly there
- Smoke: deferred to deploy stage. Manual test recipe: send real Telegram DM, observe PM2 logs for `reply` tool fire + audit row `provenance_kind = 'agent-explicit-via-tool'`, confirm `trackExplicitSend` counter > 0 → chat fallback at chat.js:254 skips

**Steps 1-3 are zero-risk** (no behavior change; tool doesn't exist for agent yet). Step 4 has measurable risk (prompt rewrite affects all agents); ship to admin first, observe 24h, then customer fleet.

## 8. Decision criteria for proceeding to Phase 3 (delete chat fallback)

After Step 4 lands and ≥7 days of audit data:

1. **Reply tool adoption is real.** `count(agent-explicit-via-tool) > 0`, scaling with agent activity. If agents ignore reply and keep using curl, prompt rewrite needs another iteration before deleting fallback.
2. **Fallback fire rate dropped proportionally.** `count(agent-explicit-via-fallback) post-Phase-2` < `count post-Phase-1` (per-day baseline). Ideal: drops to ~0 (agent always reaches the inbound channel via reply).
3. **Inbound delivery rate unchanged.** Per-channel reply rate (any provenance) holds steady. If users see fewer replies after Phase 2, prompt rewrite suppressed legitimate sends.
4. **No `no-active-turn` from /chat contexts.** Audit-log this from the reply tool side (forward to `/internal/audit/egress` like Phase 0 does for tool calls). If reply tool refuses inside /chat turns, registry write/read is broken.
5. **No regressions in Phase 1's metrics.** Artifact-summary + recovery-* still flowing; channel-authority bypass for system-template still scoped.

If 1-5 hold, Phase 3 deletes `deliverNaturalReplyFallback` + `proactiveSendFallback`. If any fails, hold and diagnose.

## 9. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Stale registry on agent crash | Low | next /chat fires with stale ctx | overwrite-on-entry catches missed cleanup; lane finally cleanup is the primary path |
| Reply tool called from sub-agent during parent's active turn | Low | sub-agent reply routes to parent's channel | accepted edge case (§4b); audit shows it; revisit if it fires |
| Agent ignores prompt and keeps using curl | Medium | Phase 3 stays gated until adoption is real | prompt iteration; failure mode is observable, not silent |
| `agent-explicit` header forged externally | Negligible | external bypass attempt | strict-loopback gate identical to Phase 1 |
| `/internal/inbound-context/current` exposes inbound IDs | Low | local process can read same data agent's prompt sees | loopback-only; not a new exposure |
| Registry write fails (throws) inside enqueue → lane never releases | Low | future /chat blocks behind broken lane | wrap in try/catch in chat.js step 1; throw → log + skip registry write, lane proceeds |
| MCP child fetches via `process.env.PORT` and gets wrong port (e.g., zero, missing) | Low | reply tool never works | `createReplyDomain` throws at MCP-server init time if no port; surfaces fast |
| Recovery resumption finds null channel-registry record | Medium | `invalid-source` errorCode, agent falls back to curl | acceptable degradation (§4e); recovery resumes are infrequent |
| Reply tool's response body is one giant JSON string the agent might inspect | Low | agent might leak `errorCode` strings into scratchpad — but scratchpad doesn't deliver | scratchpad-discard invariant catches it; warn in tool description |
| Phase 1 system-template wins over agent-explicit if both headers present | by design | — | tested in §6; documented in §1f |
| `inboundChatId` missing from req.body for legacy bot versions | Medium | registry's channelId falls back to synthetic `telegram_<id>` → telegram-api can't deliver | already-handled fallback chain `inboundChatId || channelId`; bot fleet has been emitting `inboundChatId` since [bots.js:430](../packages/server/routes/bots.js#L430) — verify on customer VPSes before rollout |

## 10. Open questions resolved during sweep

1. **File-on-disk vs HTTP-callback for context lookup.** → Decided: HTTP-callback (§1b, §1c).
2. **Single global registry vs Map<agentId,ctx>.** → Decided: single global. Per-process AGENT_ID is fixed.
3. **Should reply tool support `target: { kind, id, label, reason }` for cross-channel?** → Decided: NO in Phase 2. Cross-channel = curl with `targetName`. Phase 7 unifies.
4. **Multi-message replies (`reply({ texts: [...] })`)?** → Decided: one call per message. Mirrors curl. Envelope dedup catches accidental duplicates.
5. **File/voice attachments in reply tool?** → Decided: voice yes (telegram), file no (Phase 5 unifies file routes through chokepoint).
6. **`templateId` field on agent-explicit audit?** → Decided: NO. `templateId` is only meaningful for system-template (registered template list). agent-explicit audit class is enough.
7. **Permission scope for new tool.** → Decided: inherit `mcp__agent-tools__*` already in setup.js. No setup change.

## 11. Open questions deferred

1. **Operator-diagnostic content when agent fails to call reply** (deferred from Phase 1's open question #2). When `count(agent-explicit-via-tool) === 0` for an inbound /chat turn but the agent's scratchpad has content, what does the operator see? Decide in Phase 3 — Phase 2 keeps the existing fallback as the safety net, so operators see deliveries today.

2. **`reply` tool retry semantics.** When chokepoint returns `rate-limited` or `unknown-channel`, the tool surfaces the errorCode. Should the agent retry with backoff? Recommendation: **no auto-retry** — let the agent decide based on prompt instructions. Discord rate-limit windows are minutes, not seconds; auto-retry from the tool would burn budget.

3. **Telegram `replyToMessageId` for text** ([telegram-api.js:140](../packages/core/telegram-api.js#L140) — `sendReply(chatId, text, opts={})` — opts is currently unused for text). Pre-existing issue; today's curl pattern carries replyToMessageId in the request body but it's not threaded into the actual Telegram API call for text. Phase 2's reply tool mirrors this: passes the field, behavior matches today. If we want true thread-replies for text, that's a separate fix; Phase 2 doesn't introduce a regression.

4. **Phase 6 email integration.** Reply tool's auto-target won't extend to email (email "inbound" is a thread, not a channel — different semantics). Email reply via reply tool is out of scope; Phase 6 will design the email-specific equivalent.

5. **Channel registry hydration for operator's Discord channel + OWNER_TELEGRAM_ID DM.** Phase 1 sidesteps via system-template bypass; agent-explicit doesn't bypass. Reply tool to operator-DM would require those channels to be registered. Today's curl pattern works because canSendTo's reply-path allows target==source without registry presence. Phase 2 inherits this — reply tool's `target: 'inbound'` always satisfies reply-path. Direct cross-channel via curl to operator DM still requires registration (or the existing system-template path).

## 12. After Phase 2

The system has:
- A typed `agent-explicit` egress provenance class, audit-distinguished from curl.
- An active-turn registry feeding the reply tool's auto-targeting — agents stop hallucinating chatIds.
- The chat fallback still alive as a safety net, but firing less as agents adopt reply.
- Audit data that lets Phase 3 confirm the fallback can be deleted.
- Foundation for Phase 5 (file/voice through chokepoint with the same mechanism) and Phase 6 (email folded into chokepoint with email-specific channel kind).

What we *learn* from Phase 2's audit:
- Reply tool adoption rate per agent (which prompts work, which don't).
- Whether `no-active-turn` ever fires in /chat (would signal a registry bug).
- Whether `unknown-channel` surfaces from reply tool (would mean inbound channel isn't being canonicalized correctly).
- Frequency of reply-from-sub-agent-during-parent-turn (the §4b accepted edge case).

Phase 2 ships ~330 LOC added (50 inbound-context + 70 egress.agentExplicit + 25 internal endpoint + 110 reply-domain + 10 chat.js + 10 recovery.js + ~55 send-handler + tests are additional), 0 LOC removed (deletions land in Phase 3+). Reversible by reverting the four step commits.

## 13. How to deploy

(Same as Phase 1 deploy runbook — see [EGRESS-PROVENANCE-HANDOFF-2026-05-06.md §13](EGRESS-PROVENANCE-HANDOFF-2026-05-06.md).)

Smoke-test commands specific to Phase 2:
```bash
# After Step 1: registry write — observe in PM2 logs while sending a Telegram DM
ssh operator-host "pm2 logs personal-agent --lines 100 --nostream | grep 'inbound-context'"

# After Step 2: read-back the registry during an active /chat (run while agent is replying)
ssh operator-host "curl -s http://127.0.0.1:3004/internal/inbound-context/current"

# After Step 3: manual chokepoint test with new header
ssh operator-host "curl -X POST http://127.0.0.1:3004/telegram/send \
  -H 'x-egress-provenance: agent-explicit' \
  -H 'Content-Type: application/json' \
  -d '{\"chatId\":\"<your-chat-id>\",\"text\":\"phase2-step3-smoke\",\"sourceKind\":\"telegram-dm\",\"sourceId\":\"<your-chat-id>\"}'"
# Then check audit:
ssh operator-host "curl -s http://127.0.0.1:3004/admin/egress-audit/recent?limit=5 | jq '.[] | select(.template_id == null) | {provenance_kind, channel_id, decision}'"

# After Step 4: send a real inbound, observe reply tool firing in PM2 logs + audit row
ssh operator-host "pm2 logs personal-agent --lines 200 --nostream | grep -E 'reply|inbound-context|agent-explicit-via-tool'"
```

## 14. Step 3 pre-implementation verification (2026-05-06 evening)

Re-swept before writing the Step 3 code. Three parallel Explore agents + manual code reads at every cited line. Findings consolidated against `b26da4f` (Step 2 shipped admin).

| Load-bearing assumption | Verified at | Notes |
|---|---|---|
| `egress.js` exports `configureEgress` + `systemTemplate` only; `agentExplicit` is the 3rd helper to add | [packages/server/lib/egress.js:37-55, 81-129](../packages/server/lib/egress.js#L37) | header comment lines 6-9 explicitly anticipate Phase 2's `agentExplicit` |
| `_config = { agentServerPort, agentId, logPrefix, fetch }` is the singleton shape | [packages/server/lib/egress.js:49-54](../packages/server/lib/egress.js#L49) | `_config.fetch` defaults to `globalThis.fetch` |
| `VALID_PLATFORMS = Set(['telegram','discord','whatsapp'])` is the platform allowlist | [packages/server/lib/egress.js:73](../packages/server/lib/egress.js#L73) | reuse for `agentExplicit` |
| `systemTemplate` body shape per platform: telegram `{chatId,text,...options}`, discord `{channelId,content,...options}`, whatsapp `{text,...options}` | [packages/server/lib/egress.js:104-108](../packages/server/lib/egress.js#L104) | systemTemplate uses `...options` (trusted internal callers); `agentExplicit` will use explicit allowlist (voice/replyToMessageId/sourceKind/sourceId) since options come from a tool surface |
| systemTemplate sets `x-egress-provenance: system-template` + optional `x-egress-template-id` | [packages/server/lib/egress.js:114-118](../packages/server/lib/egress.js#L114) | mirror with `x-egress-provenance: agent-explicit` (no template-id) |
| `whatsapp` allows empty `channelId` (jid resolved bot-side); telegram + discord reject empty | [packages/server/lib/egress.js:97-99](../packages/server/lib/egress.js#L97) | preserve in `agentExplicit` |
| send-handler dispatch lines 144-159 — `isStrictLoopback` AND `x-egress-provenance: system-template` → `isSystemTemplate`; ternary picks `system-template` else `agent-explicit-via-curl` | [packages/server/lib/send-handler.js:144-159](../packages/server/lib/send-handler.js#L144) | exact text matches design §3c. Only this block changes for Step 3. |
| `provenanceKind` flows downstream to 4 sites: 176 (suppressed audit), 206 (outbound emit), 364 (success audit), 418 (error audit) | [packages/server/lib/send-handler.js:176, 206, 364, 418](../packages/server/lib/send-handler.js#L176) | adding new value → all 4 sites carry it automatically |
| `trackExplicitSend` gate is `!isSystemTemplate` — agent-explicit (any sub-class) fires the counter | [packages/server/lib/send-handler.js:295-297](../packages/server/lib/send-handler.js#L295) | confirms design's claim that Phase 2 closes most of the leak class without deleting fallback (counter increments for `agent-explicit-via-tool` → fallback's "if zero explicit sends" check fails → fallback skips) |
| Routes mounting `createSendHandler`: telegram, discord, whatsapp text routes only (NOT file/voice routes which inline the auth + audit) | [packages/server/routes/bots.js:886, 890, 1692](../packages/server/routes/bots.js#L886) | three routes pick up the new dispatch |
| No allowlist on header value — string compare permits any value through; gate is the loopback check | [packages/server/lib/send-handler.js:149-151](../packages/server/lib/send-handler.js#L149) | adding `'agent-explicit'` recognition is purely additive |
| `enforceChannelAuthority` accepts `sourceKind`/`sourceId` from `req.body` | [packages/server/lib/send-handler.js:247-253](../packages/server/lib/send-handler.js#L247) | `agentExplicit` body passes them through (matches today's curl pattern) |
| `egress_audit.provenance_kind` is `TEXT NOT NULL` with no CHECK constraint; vocabulary documented in migration comment | [migrations/151_egress_audit.sql:32, 50-59](../migrations/151_egress_audit.sql#L32) | `'agent-explicit-via-tool'` already enumerated in vocabulary |
| `'agent-explicit-via-tool'` is **already emitted** by gmail tool + ops-tools.sendReply (direct `recordEgress` calls, bypassing send-handler) | [packages/tools/ops-tools.js:251](../packages/tools/ops-tools.js#L251), [packages/core/services/gmail-plugin.js:326, 345](../packages/core/services/gmail-plugin.js#L326) | Step 3 makes send-handler the THIRD emitter of this kind (when new header present); the audit-side test at [packages/server/test/lib/egress-audit.test.js:114](../packages/server/test/lib/egress-audit.test.js#L114) already locks the kind through the audit pipeline |
| Test pattern: mock fetch helper at egress.test.js:27-34, configure → call → assert headers/body shape | [packages/server/test/lib/egress.test.js:27-34, 119-124](../packages/server/test/lib/egress.test.js#L27) | mirror for `agentExplicit` |
| Test pattern: send-handler tests use a `buildTestApp` shared helper (loopback by default; `.set('X-Forwarded-For', ...)` simulates Caddy-proxied) | [packages/server/test/helpers/buildApp.js:21-29](../packages/server/test/helpers/buildApp.js#L21), [packages/server/test/routes/auth.test.js:118-120](../packages/server/test/routes/auth.test.js#L118) | greenfield: no existing send-handler test asserts header dispatch — Step 3 adds the first such test |
| `_resetForTests()` exists for the singleton seam | [packages/server/lib/egress.js:134-136](../packages/server/lib/egress.js#L134) | tests already use it; no new seam needed for `agentExplicit` since `_config` is shared |

**Pivots from design v1 → v2:** None for Step 3 specifically — the design's §3b spec held against the live code. One nuance worth recording: I'll use an explicit option allowlist in `agentExplicit`'s body construction rather than `...options` spread (which `systemTemplate` uses) because `agentExplicit` options eventually originate from a tool surface — explicit allowlist is the safer invariant for a path the agent can drive. This is a defensive narrowing, not a contract change.

**Surprises caught:** (1) send-handler currently has zero tests asserting provenance-header dispatch — Step 3 is also the first time we lock this contract in tests. (2) `agent-explicit-via-tool` is already a live audit kind from gmail/ops-tools; Step 3 doesn't introduce a new value, it expands the emission surface to include send-handler when the new header is present.

## 15. Step 4 pre-implementation verification (2026-05-06 night)

Re-swept before writing the Step 4 code. Three parallel Explore agents (agent-tools domain pattern · prompt-sections + builders · sub-agent boot + recovery + channel-registry) + manual reads at every cited line. Findings consolidated against `38db388` (Step 3 shipped).

| Load-bearing assumption | Verified at | Notes |
|---|---|---|
| Domain factory shape: `(deps) => { tools, handlers }` | [packages/tools/agent-tools/domains/documents.js:56](../packages/tools/agent-tools/domains/documents.js#L56), [delegation.js:25-30](../packages/tools/agent-tools/domains/delegation.js#L25) | 12 existing factories, identical shape; reply will be the 13th |
| MCP `CallToolRequest` handler receives only `{ name, arguments }` | [packages/tools/agent-tools.js:152-163](../packages/tools/agent-tools.js#L152) | confirms design's "no per-call signal" claim — reply tool MUST fetch context via HTTP |
| Domain registration sites: `TOOLS = [...]` array + `Object.assign(domainHandlers, ...)` | [packages/tools/agent-tools.js:281-308](../packages/tools/agent-tools.js#L281) | 12 spreads today; reply adds a 13th (cleanest position: first, since it's the most-frequently-used) |
| Fetch injection precedent: `createDelegationDomain({ ..., fetch: fetchImpl = globalThis.fetch })` | [packages/tools/agent-tools/domains/delegation.js:29](../packages/tools/agent-tools/domains/delegation.js#L29) | reply mirrors this exactly |
| **PIVOT FROM v2 DESIGN**: takes `agentUrl` (full URL string), NOT `agentServerPort` | [packages/tools/agent-tools/domains/delegation.js:69-75](../packages/tools/agent-tools/domains/delegation.js#L69), [packages/tools/agent-tools.js:93-96](../packages/tools/agent-tools.js#L93) | `agent-server.js:933` sets `AGENT_URL: 'http://localhost:${PORT}'` in MCP child env — the codebase convention is "pass the URL, don't reconstruct from a port" |
| Soft-fail on missing agentUrl (return readable error string), NOT throw at init | [packages/tools/agent-tools/domains/delegation.js:69-71](../packages/tools/agent-tools/domains/delegation.js#L69) | `delegate_to_agent` returns `'Delegation unavailable: AGENT_URL not configured'` — reply mirrors with `errorCode: 'agent-url-not-configured'` |
| MCP child env: `AGENT_URL` + `AGENT_INTERNAL_SECRET` only — NO `AGENT_PORT` | [packages/server/agent-server.js:932-940](../packages/server/agent-server.js#L932) | reply tool reads `process.env.AGENT_URL` directly (with `'http://localhost:3004'` fallback matching searchClient) |
| Permission auto-inheritance via `mcp__agent-tools__*` wildcard | [packages/tools/setup.js:68](../packages/tools/setup.js#L68) | adding `reply` to `agent-tools` server inherits the existing rule — no setup.js change needed |
| Test pattern: `makeDeps()` factory + `fetch` mock injection in deps + assert URL/body capture | [packages/tools/test/agent-tools/domains/delegation.test.js:5-17, 46-59](../packages/tools/test/agent-tools/domains/delegation.test.js#L5) | reply test mirrors this exactly; greenfield file `reply.test.js` |
| `inbound-context.js` already exports `setActiveTurn`, `getActiveTurn`, `clearActiveTurn`, `_resetForTests` (Step 1 shipped) | [packages/server/lib/inbound-context.js:53, 66, 73, 80](../packages/server/lib/inbound-context.js#L53) | reply tool's `fetchActiveTurn` consumes the registry via the Step 2 endpoint |
| `/internal/inbound-context/current` returns the full registry entry on 200 OR `{error:'no-active-turn'}` on 404 (Step 2 shipped) | [packages/server/routes/admin-fleet.js:539-559](../packages/server/routes/admin-fleet.js#L539) | reply tool's response codes: 200 → use turn; 404 → `errorCode: 'no-active-turn'`; 500 → `errorCode: 'context-fetch-failed'` |
| `egress.agentExplicit` exists, sends `x-egress-provenance: agent-explicit` header (Step 3 shipped) | [packages/server/lib/egress.js:160-260 (approx)](../packages/server/lib/egress.js) | reply could call this directly. **However**: reply runs in the MCP child process; `egress.agentExplicit` is wired into the agent-server process's egress config. Reply tool POSTs the chokepoint URL with the header itself (mirrors what `agentExplicit` does) — keeps the MCP child stateless |
| `send-handler.js` recognizes `x-egress-provenance: agent-explicit` and emits `provenanceKind: 'agent-explicit-via-tool'` (Step 3 shipped) | [packages/server/lib/send-handler.js:144-167](../packages/server/lib/send-handler.js#L144) | reply tool's POST + header → audit row classified correctly |
| `responseNotesSection` is the reply-guidance section called from `/chat` only (variant=`'chat'`) — `/chat/stream` uses variant=`'chat-stream'` (no curl) | [packages/server/chat/prompt-sections.js:414-484, 424-426](../packages/server/chat/prompt-sections.js#L414), [packages/server/routes/chat.js:731-741, 1687](../packages/server/routes/chat.js#L731) | Step 4 prompt rewrite scope: `responseNotesSection` chat-variant only |
| `selectPlatformCurlHint` registry is the per-platform curl renderer | [packages/server/chat/prompt-sections.js:351-412](../packages/server/chat/prompt-sections.js#L351) | DECISION: keep registry intact (still useful for cross-channel + as fallback when reply tool unavailable); add reply tool guidance as the LEAD section in `responseNotesSection`, with curl examples retained as the platform-specific footer |
| Existing `prompt-sections.test.js` locks the curl-output contract verbatim with line-level asserts | [packages/server/test/chat/prompt-sections.test.js:330-421, 425-500](../packages/server/test/chat/prompt-sections.test.js#L330) | tests must be UPDATED in the same commit: assert reply() instruction appears + existing curl assertions still hold |
| `autonomousMessagingSection` is the autonomous-wake reply guide (NO active turn) | [packages/server/chat/prompt-sections.js:257-304](../packages/server/chat/prompt-sections.js#L257) | OUT OF SCOPE: there is no active turn during /think/autonomous, so reply tool would refuse with `no-active-turn`. Curl stays here. |
| File/voice/cross-channel curl examples in `prompt-builders.js` (file send, react, voice, collab) — DIFFERENT CURL ROUTES | [packages/server/chat/prompt-builders.js:125-259](../packages/server/chat/prompt-builders.js#L125) | OUT OF SCOPE for Step 4: these target `/telegram/send-file`, `/discord/react`, `/discord/send-voice`, `/collab/send` — Phase 5 (file/voice routes through chokepoint) and Phase 7 (cross-channel `target` requirement) are the right phases |
| QA agent prompt has its own curl examples | [packages/core/qa-pipeline.js:164, 211](../packages/core/qa-pipeline.js#L164) | OUT OF SCOPE for Step 4: QA runs as `/chat/triage`-class (no active turn). Document as deferred. |
| Recovery `resumeSession` already calls `setActiveTurn` with degraded `'unknown'` fallback (Step 1 shipped) | [packages/server/lib/recovery.js:268-288, 353-357](../packages/server/lib/recovery.js#L268) | **PIVOT FROM DESIGN §3g**: design referenced non-existent `channelRegistry.findByCanonicalId` + `mapKindToSource` helpers. Step 1 already worked around this with `dctx.source \|\| 'unknown'` and `dctx.channelKind \|\| 'unknown'`. Reply tool refuses with `invalid-source` for resumed runs → falls back to curl. Acceptable degradation, matches §4e. **No new helpers needed.** |
| Sub-agent `runClaudeCode(...{cwd: parentRuntime.paths.repo})` reuses parent's `.claude/settings.json` | [packages/core/spawner.js:121-132](../packages/core/spawner.js#L121) | confirms §4b: sub-agent's MCP child WILL fetch parent's active turn from the same `/internal/inbound-context/current`. Accepted edge case stands. |
| `chatDeliveryContext` hardcodes `channel: 'discord'` (pre-existing quirk) | [packages/server/routes/chat.js:822 (approx)](../packages/server/routes/chat.js) | NOT A STEP 4 CONCERN — reply tool reads `source`/`channelKind` from active-turn registry (set with correct values at chat.js:775-785), not from deliveryContext |
| `req.body.source` values flowing into the registry: `'telegram'`, `'telegram-group'`, `'discord'`, `'whatsapp'`, plus `'unknown'`, `'autonomous'`, etc. | [packages/server/routes/chat.js:598, 632, 646-647, 690, 774](../packages/server/routes/chat.js#L598) | reply tool's `platformFromSource` maps `'telegram'`/`'telegram-group'` → `'telegram'`, `'discord'` → `'discord'`, `'whatsapp'` → `'whatsapp'`, everything else → null (refuse with `invalid-source`) |
| No existing `reply` tool / `createReplyDomain` / `handleReply` / `mcp__.*reply` namespace | (sweep 1 + sweep 2 grep — zero hits) | clean namespace |

**Pivots from design v2 → v3:**

1. **`createReplyDomain({ agentUrl, fetch })` not `({ agentServerPort })`.** The codebase convention (set by `delegationDomain` and `searchClient`) is to pass a full URL string and validate non-empty. Calling code reads `AGENT_URL` from env (with `'http://localhost:3004'` fallback). This eliminates port-vs-URL impedance mismatch and matches every other domain factory's shape.

2. **Soft-fail (return readable error string), not throw at init.** Mirrors `delegate_to_agent`'s "Delegation unavailable: AGENT_URL not configured" pattern. Reply tool returns `{ delivered: false, errorCode: 'agent-url-not-configured' }` if `agentUrl` is missing — surfaces fast at first call, doesn't kill the MCP server boot.

3. **Reply tool POSTs the chokepoint URL directly with `x-egress-provenance: agent-explicit` header instead of calling `egress.agentExplicit`.** `egress.agentExplicit` lives in the agent-server process and is configured via `configureEgress` at boot. The MCP child runs in a separate process and has no access to `_config`. The right pattern: reply tool builds the same POST `egress.agentExplicit` would build. Step 3's `egress.agentExplicit` remains useful for in-process callers (future Phase 5/6 file/voice routes); reply tool's HTTP-self-call is structurally cleaner for cross-process.

4. **Channel-registry helper plan dropped.** Design §3g referenced `channelRegistry.findByCanonicalId(channelId)` + `mapKindToSource(kind)` — neither exists. Step 1's recovery wiring already handles missing registry context with `'unknown'` fallback → reply tool refuses with `invalid-source` → recovered runs fall back to curl. Phase 2 doesn't need to invent these helpers.

5. **Prompt structure: reply tool LEADS, curl examples FOLLOW (as fallback/cross-channel).** Design §3h proposed two separate top-level sections ("To reply" + "Different channel"). Sweep 2 found `selectPlatformCurlHint` is a tested registry that other consumers depend on; ripping it out would break the cross-channel guidance. Better: keep registry, restructure `responseNotesSection` so reply tool is the lead, platform curl is the visible fallback. Tests get UPDATED (locking new contract) not REPLACED.

**Surprises caught:**
- Sweep 1: `createDelegationDomain` is the only existing factory with `fetch` injection — sets the precedent reply will follow exactly.
- Sweep 2: `selectPlatformCurlHint` is its own exported function with its own test surface (lines 425-500). Step 4 keeps it intact; the test file gets minimal additions, not rewrites.
- Sweep 3: `chatDeliveryContext` hardcoded `channel: 'discord'` is a pre-existing quirk, but doesn't affect Step 4 because the active-turn registry is set DIRECTLY from `req.body` at chat.js:775-785, not via deliveryContext.
- Sweep 3 + Read: Recovery's setActiveTurn fallback (`source: 'unknown'`) was already in place (Step 1) — design §3g's plan to add new channel-registry helpers was obsoleted before Step 4 even began.

## Closing note

The handoff doc warned: "Phase 2 has more design surface than Phase 1 (MCP tool + cross-process state + prompt change all in one phase). Three sweep cycles, minimum." This design ran five sweep cycles (4 parallel + 1 lane-pressure-test) before locking the structural choice. The biggest find — file-on-disk doesn't work because MCP tools have no taskId — would have surfaced as a runtime bug in step 1 of implementation if the design hadn't pressure-tested. Worth the time.

Step 4's pre-implementation sweep (this §15) found four pivots before any code was written: `agentUrl` not `agentServerPort`, soft-fail not throw, reply tool POSTs directly not via `egress.agentExplicit`, channel-registry helper plan dropped. Worth the time again.

Phase 3 (delete fallback) is the meaningful leak-class fix. Phase 2 is the prerequisite that makes Phase 3 safe — a structural replacement before a deletion.
