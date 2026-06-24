# Mycelium memory layer — opencode plugin

Makes opencode use your Mycelium vault as memory: injects vault context into the
system prompt each turn and captures both the user message and the final assistant
reply.

Code-verified against `anomalyco/opencode` `@opencode-ai/plugin` v1.17.7:
`experimental.chat.system.transform` (inject → `output.system[]`), `chat.message`
(user capture), `event` (assistant capture: accumulate `message.part.updated` text,
flush on `message.updated` assistant `time.completed`). Gated by
`npm run verify:memory-adapters` (rows O1–O4). Logic lives in `mycelium-bridge.mjs`.

## Install
In opencode config (`opencode.json`):
```json
{
  "plugin": [["@mycelium/opencode-memory", { "baseUrl": "http://127.0.0.1:4711", "bearer": "<MYCELIUM_MCP_BEARER>" }]]
}
```
…pointing at this folder, or drop the folder in `.opencode/plugin/`. Config can
also come from env (`MYCELIUM_BASE_URL`, `MYCELIUM_MCP_BEARER`). Bun runtime;
fail-open. Requires Mycelium's HTTP server (`npm run start:http`) running.
