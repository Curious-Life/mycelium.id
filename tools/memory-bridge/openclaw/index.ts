// Mycelium memory layer — openclaw plugin entry (thin host wrapper).
//
// Install: copy this folder somewhere, then in ~/.openclaw config:
//   plugins.load.paths += this dir;  plugins.entries["mycelium-memory"] =
//     { enabled: true, hooks: { allowPromptInjection: true },
//       config: { baseUrl: "...", bearer: "..." } }
// Uses the plugin-SDK (definePluginEntry / OpenClawPluginApi). All logic lives in
// mycelium-bridge.mjs (framework-agnostic, covered by verify:memory-adapters).
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
// @ts-ignore — sibling ESM JS module (no types needed)
import { createOpenclawMemory } from "./mycelium-bridge.mjs";

export default definePluginEntry({
  id: "mycelium-memory",
  name: "Mycelium Memory Layer",
  description: "Inject Mycelium vault context per turn and capture both sides.",
  register(api: OpenClawPluginApi) {
    const o = (api.pluginConfig || {}) as Record<string, unknown>;
    const env = (k: string) => (typeof process !== "undefined" ? process.env?.[k] : undefined);
    const mem = createOpenclawMemory({
      baseUrl: String(o.baseUrl || env("MYCELIUM_BASE_URL") || "http://127.0.0.1:4711"),
      bearer: String(o.bearer || env("MYCELIUM_MCP_BEARER") || ""),
      timeoutMs: Number(o.timeoutMs || env("MYCELIUM_BRIDGE_TIMEOUT_MS") || 4000),
    });
    // Pull + inject context before the model runs.
    api.on("before_prompt_build", (event: any, ctx: any) => mem.onBeforePromptBuild(event, ctx), { timeoutMs: 8000 });
    // Capture both sides once the model output is in (event carries prompt + assistantTexts).
    api.on("llm_output", (event: any, ctx: any) => mem.onLlmOutput(event, ctx));
  },
});
