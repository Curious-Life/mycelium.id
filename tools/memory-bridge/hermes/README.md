# Mycelium memory layer — hermes-agent plugin

Makes hermes use your Mycelium vault as memory: injects vault context before each
turn and captures both your message and the assistant's reply after.

Code-verified against `NousResearch/hermes-agent` (`pre_llm_call` → returns
`{"context": …}` appended to the user message; `post_llm_call` → `assistant_response`).
Gated by `npm run verify:memory-adapters` (rows H1–H3).

## Install
1. Copy `mycelium-memory/` into your hermes plugins dir:
   ```bash
   cp -r mycelium-memory ~/.hermes/plugins/mycelium-memory
   ```
2. Enable it in your hermes config (`plugins.enabled`) per hermes' plugin docs.
3. Run Mycelium's HTTP server and point the plugin at it (env):
   ```bash
   export MYCELIUM_BASE_URL="http://127.0.0.1:4711"
   export MYCELIUM_MCP_BEARER="<the token the server was started with>"
   ```

Standard-library only (urllib) — no pip installs. Fail-open: if the server is
down, the turn proceeds with no context and nothing captured.
