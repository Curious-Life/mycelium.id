# Mycelium memory bridge

Make **any** AI agent use your Mycelium vault as a universal memory layer: on every
turn the agent **pulls** context from the vault and **pushes** both your message and
the assistant's reply back in — reliably, not at the model's discretion.

Design: [`docs/UNIVERSAL-MEMORY-LAYER-DESIGN-2026-06-11.md`](../../docs/UNIVERSAL-MEMORY-LAYER-DESIGN-2026-06-11.md).
Gate: `npm run verify:memory-bridge`.

## The whole contract (two HTTP calls)

Everything an adapter needs, Bearer-guarded on `:4711` (the same token as `/mcp` and `/v1`):

| | call | body | returns |
|---|---|---|---|
| **pull** | `POST /context` | `{ query?, maxChars? }` | `{ ok, text }` — getContext (+ optional search slice) |
| **push** | `POST /ingest/message` | `{ content, role, conversationId, id?, source?, metadata? }` | `{ ok, result }` — idempotent on `id` |

> "Connectable to any agent system" = *can it POST to these two URLs?* If yes, it can
> use Mycelium as memory. `bridge.mjs` is a ready-made client for both.

**Capture exactly the new turn, with a stable `id`.** Dedup is id-keyed
([`src/ingest/capture.js`](../../src/ingest/capture.js)) — re-sending the same `id`
is a no-op, but a *different* `id` with the same text inserts a new row. Never push a
whole history; push the latest user message + the reply, each with a deterministic id
(`bridge.captureId(...)`) or the harness's own stable message id.

## Prerequisites (both halves)

1. **Run the HTTP server** with a static bearer, pointed at your real vault:
   ```bash
   export MYCELIUM_MCP_BEARER="$(openssl rand -hex 32)"   # ≥24 chars
   export MYCELIUM_DATA_DIR="$HOME/Library/Application Support/id.mycelium.app"  # your vault
   MYCELIUM_KEY_SOURCE=keychain npm run start:http        # serves :4711
   ```
2. **Tell the bridge** how to reach it (any adapter process):
   ```bash
   export MYCELIUM_BASE_URL="http://127.0.0.1:4711"       # default; override for remote
   export MYCELIUM_MCP_BEARER="<same token as above>"
   # optional: MYCELIUM_BRIDGE_REDACT=1  (scrub obvious secrets before capture)
   ```

If the server is down or the token is unset, the bridge **fails open**: no context is
injected and nothing is captured, but the agent's turn is never blocked.

## Adapters

### Claude Code (built — `claude-code/`)
- `on-prompt.mjs` — `UserPromptSubmit` hook: injects vault context for the turn.
- `on-stop.mjs` — `Stop` hook: **syncs the whole transcript** — captures every human
  message + assistant text (conversation only; skips tool calls/results & meta
  entries), each keyed by its transcript `uuid` (idempotent), with full metadata
  (session, cwd, gitBranch, model, parentUuid, isSidechain) and real timestamps. A
  per-session high-water mark (`~/.mycelium-bridge/cc-<session>.hwm`) avoids
  re-scanning. `transcript.mjs` is the shared parser.
- **Backfill existing history:** `node scripts/backfill-claude-code.mjs [filter]`
  imports your existing `~/.claude/projects/**/*.jsonl` transcripts (idempotent,
  consent-gated). Needs `MYCELIUM_BASE_URL` + `MYCELIUM_MCP_BEARER`.

> Capture is **consent-gated** (off by default) — enable via Settings → Memory
> capture or `PUT /portal/agent-capture {"enabled":true}`; until then it no-ops.

Wire them in `.claude/settings.local.json` (personal, gitignored):
```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /ABS/PATH/tools/memory-bridge/claude-code/on-prompt.mjs", "timeout": 15 }] }],
    "Stop":            [{ "hooks": [{ "type": "command", "command": "node /ABS/PATH/tools/memory-bridge/claude-code/on-stop.mjs",   "timeout": 15 }] }]
  }
}
```
Hooks load at Claude Code startup — restart the session to activate.

### opencode / hermes-agent / openclaw (use the gateway tier today)
The fastest universal path needs **no adapter code**: point the harness's model
base-URL at Mycelium's gateway and add one header.
```
base_url:  http://127.0.0.1:4711/v1
api key:   <MYCELIUM_MCP_BEARER>
model:     mycelium-auto
header:    X-Mycelium-Capture: <a stable conversation id>
```
With that header the gateway injects context and captures both sides automatically
(`src/gateway/openai-compat.js`). Native hook adapters for these harnesses
(hermes `pre/post_llm_call`, openclaw `llm_input/llm_output`, opencode `message.*`)
are the next step — each is a thin wrapper over `bridge.mjs`.

### Any other harness
Wire its "before turn" hook to `bridge.context()` and its "after turn" hook to
`bridge.capture()`, or just use the gateway tier above.
