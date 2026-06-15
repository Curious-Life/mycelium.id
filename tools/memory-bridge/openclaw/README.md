# Mycelium memory layer — openclaw plugin

Makes openclaw use your Mycelium vault as memory: injects vault context before each
turn and captures both the user message and the assistant reply.

Code-verified against the openclaw plugin-SDK (`/Users/altus/Developer/openclaw`):
`definePluginEntry` + `api.on("before_prompt_build")` (inject → return
`{ prependContext }`) + `api.on("llm_output")` (capture both — `event.prompt` and
`event.assistantTexts[]`). Gated by `npm run verify:memory-adapters` (rows W1–W3).
Logic lives in `mycelium-bridge.mjs`; `index.ts` is the thin SDK wrapper.

## Install
1. Copy this folder somewhere stable.
2. In `~/.openclaw` config:
   ```json
   {
     "plugins": {
       "load": { "paths": ["/path/to/openclaw-plugin"] },
       "entries": {
         "mycelium-memory": {
           "enabled": true,
           "hooks": { "allowPromptInjection": true },
           "config": { "baseUrl": "http://127.0.0.1:4711", "bearer": "<MYCELIUM_MCP_BEARER>" }
         }
       }
     }
   }
   ```
Config can also come from env. Node runtime; fail-open. Requires Mycelium's HTTP
server (`npm run start:http`) running.
