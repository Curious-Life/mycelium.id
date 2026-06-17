# Model gateway & embeddings

The gateway turns Mycelium into a **sovereign inference endpoint**: point any
OpenAI-compatible tool at it and your thinking is routed through *your* provider keys,
to providers *you* approve, with every outbound call audited — and a local model always
available as the fallback.

It speaks the OpenAI `/v1` dialect and runs on `:4711` alongside the [MCP
endpoint](connect.md) (HTTP mode only — never on the no-auth portal).

```
base URL : http://127.0.0.1:4711/v1
API key  : <your MYCELIUM_MCP_BEARER>
model    : mycelium-auto      ← routes to whichever provider is active in Settings
```

---

## `POST /v1/chat/completions`

OpenAI-compatible chat completions. Bearer-authenticated.

- **Streaming** — `stream: true` yields real token streaming.
- **Tool calling** — `tools` round-trips to an OpenAI-compatible provider.
- **Routing** — `model: "mycelium-auto"` selects the active provider + jurisdiction set
  in Settings → Intelligence. The cascade falls back to your on-box local model.

### Headers

| Header | Effect |
|---|---|
| `X-Mycelium-Sensitive: true` | Hard-block this request from US providers; force it to the on-box local model. Marks the result sensitive (never published). |
| `X-Mycelium-Capture: <id>` | Inject the user's context preamble + capture both sides of the turn. See [Memory bridge](memory-bridge.md). |
| `X-Mycelium-Conversation: <id>` | Set the conversation id for capture. |

```bash
curl http://127.0.0.1:4711/v1/chat/completions \
  -H "Authorization: Bearer $MYCELIUM_MCP_BEARER" \
  -H 'content-type: application/json' \
  -d '{
        "model": "mycelium-auto",
        "stream": true,
        "messages": [{"role":"user","content":"summarize my week"}]
      }'
```

## `GET /v1/models`

Lists the available models, including `mycelium-auto`.

## `POST /v1/embeddings`

OpenAI-compatible embeddings — but **local-only**. It runs the on-box Nomic v1.5 model
and **never** sends text to a cloud embeddings provider, because embedding vectors are
semantic fingerprints of your plaintext.

```
POST http://127.0.0.1:4711/v1/embeddings
{ "model": "nomic-embed-text-v1.5", "input": "…" | ["…"] }
```

- `input` accepts a string or an array.
- `encoding_format` may be `float` (default) or `base64`.
- `X-Mycelium-Embed-Task: query` requests query-time embeddings (default is `document`)
  — Nomic uses task prefixes, and matching them at query vs index time improves recall.

---

## Sovereignty controls

The gateway is where "own the intelligence" becomes concrete:

- **Jurisdiction gating.** Choose which provider — and which country — your requests may
  go to. A request marked sensitive is hard-blocked from US providers and the cascade
  drops them entirely.
- **Bring your own keys.** Inference runs on *your* provider accounts. Mycelium is the
  router and the audit log, not the biller.
- **Local-first fallback.** Your on-box model is always the floor — the gateway can run
  entirely offline if you want it to.
- **Hash-only egress audit.** Every cloud call — including tool calls — is recorded as a
  sha256 hash + length. The **content is never logged.** You get a tamper-evident trail
  of *that* you called out, never *what* you sent.

---

## Where it runs (and where it doesn't)

- ✅ `npm run start:http` → gateway live on `:4711`, behind bearer/OAuth, loopback by
  default.
- ❌ Never on `:8787` (the no-auth portal). The gateway requires auth, always.
- 🌐 Remotely via `https://<handle>.mycelium.id/v1` once the relay is live — TLS
  terminates on your machine; the relay never sees plaintext. See [remote
  access](connect.md#5-reach-your-box-from-the-internet-remote).

---

→ Auto-capture every turn through the gateway: **[Memory bridge](memory-bridge.md)** ·
Full posture: **[Security model](security-model.md)**.
