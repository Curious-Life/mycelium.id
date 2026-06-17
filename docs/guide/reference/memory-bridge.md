# Memory bridge — auto-capture every turn

MCP tools let an agent read and write the vault *when it chooses to*. The **memory
bridge** makes **every** turn flow into memory automatically — both the user's message
and the assistant's reply — with the user's context pulled back in as a preamble.

Three ways to wire it, from zero-config to native.

> **Consent required — auto-capture is OFF by default.** See [the consent
> gate](#consent) at the bottom. Until the user opts in, the bridge runs but capture is
> a silent no-op.

---

## Option A — gateway header (zero-config)

If your harness already talks to the [model gateway](gateway-and-embeddings.md), add
one header to your `/v1/chat/completions` calls:

```
X-Mycelium-Capture: <conversation-id>
```

With the header set, the gateway:

1. **Injects** the user's vault context as a system preamble (the same briefing
   [`getContext`](getcontext.md) returns).
2. **Captures** both sides of the turn (the latest user message + the assistant
   reply), idempotently.

Without the header, the gateway is an unchanged pass-through proxy. Pair with
`X-Mycelium-Conversation` to set the conversation id explicitly.

```bash
curl http://127.0.0.1:4711/v1/chat/completions \
  -H "Authorization: Bearer $MYCELIUM_MCP_BEARER" \
  -H "X-Mycelium-Capture: my-session-42" \
  -H 'content-type: application/json' \
  -d '{"model":"mycelium-auto","messages":[{"role":"user","content":"hi"}]}'
```

---

## Option B — the `/context` bridge (any harness, keep your own model)

If your harness keeps its own model and you just want memory, call the two bridge
endpoints from its lifecycle hooks:

| Step | Call | Purpose |
|---|---|---|
| **Pull** (turn start) | `POST /context` → `{ query?, maxChars? }` → `{ ok, text }` | Get the context preamble as plain JSON to prepend. |
| **Push** (turn end) | `POST /ingest/message` → `captureMessage` args | Save each side of the turn. |

Both require `npm run start:http` with a bearer (or OAuth). The caller decides egress —
`/context` returns plaintext, so treat it accordingly.

---

## Option C — native adapters (drop-in)

Pre-built adapters wire a specific harness's own hooks to the pull/push endpoints
above. They live in [`tools/memory-bridge/`](../../../tools/memory-bridge/) — one folder
per harness, each with its own README:

- **Claude Code** — hooks into the session lifecycle (full transcript sync, real
  timestamps, high-water-mark dedup).
- **hermes-agent**
- **opencode**
- **openclaw**

Install per the folder's README. Gated by `npm run verify:memory-bridge` +
`npm run verify:memory-adapters`.

---

## Fail-open

The bridge **never blocks a turn.** If Mycelium is down or slow, the pull returns
nothing and the turn proceeds; the push is best-effort. Memory degrades gracefully — it
never gets in the way of the conversation.

---

## Consent

Captured conversations can contain secrets (keys, file contents, command output), so
Mycelium stores **agent-source** messages (`claude-code`, `gateway:*`, `opencode`,
`openclaw`, `hermes`) **only after the user opts in**:

```bash
curl -X PUT http://127.0.0.1:4711/portal/agent-capture \
  -H "Authorization: Bearer $MYCELIUM_MCP_BEARER" -H 'content-type: application/json' \
  -d '{"enabled":true,"redactSecrets":false}'   # redactSecrets scrubs obvious creds
```

Or toggle it in **Settings → Memory capture**. Until enabled, the hooks and gateway run
but capture is a silent no-op. Non-agent ingest (the user's own notes, connector
messages) is **never** gated. Gate: `verify:agent-capture`.

---

→ The endpoints in detail: **[REST & ingest](rest-and-ingest.md)** ·
**[Model gateway](gateway-and-embeddings.md)**.
