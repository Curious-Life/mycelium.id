// Mycelium memory layer — opencode plugin entry (thin host wrapper).
//
// Install: in opencode config (opencode.json) add
//   { "plugin": [["@mycelium/opencode-memory", { "baseUrl": "...", "bearer": "..." }]] }
// or drop this folder in `.opencode/plugin/`. opencode loads the `server` export
// (PluginModule.server) and registers the returned Hooks. Config also via env
// MYCELIUM_BASE_URL / MYCELIUM_MCP_BEARER. All logic lives in mycelium-bridge.mjs
// (framework-agnostic, covered by `npm run verify:memory-adapters`).
import type { Plugin } from "@opencode-ai/plugin";
// @ts-ignore — sibling ESM JS module (no types needed)
import { createOpencodeMemory } from "./mycelium-bridge.mjs";

function resolveConfig(options?: Record<string, unknown>) {
  const o = options || {};
  const env = (k: string) => (typeof process !== "undefined" ? process.env?.[k] : undefined);
  return {
    baseUrl: String(o.baseUrl || env("MYCELIUM_BASE_URL") || "http://127.0.0.1:4711"),
    bearer: String(o.bearer || env("MYCELIUM_MCP_BEARER") || ""),
    timeoutMs: Number(o.timeoutMs || env("MYCELIUM_BRIDGE_TIMEOUT_MS") || 4000),
  };
}

export const server: Plugin = async (_input, options) => {
  return createOpencodeMemory(resolveConfig(options as Record<string, unknown>));
};

export default { server };
