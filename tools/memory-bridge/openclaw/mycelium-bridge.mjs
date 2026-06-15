// Mycelium memory layer for openclaw — framework-agnostic core (testable).
//
// Self-contained (inline bridge) so it ships standalone inside a user's openclaw.
// Verified against the openclaw plugin-SDK (src/plugins/hook-types.ts):
//   • before_prompt_build → inject vault context (return { prependContext })
//   • llm_output          → capture BOTH sides (event.prompt + event.assistantTexts)
// The host entry (index.ts) wires these via `api.on(...)`. Both fail-open.
import { createHash } from "node:crypto";

function createBridge(cfg = {}) {
  const base = String(cfg.baseUrl || "http://127.0.0.1:4711").replace(/\/$/, "");
  const bearer = String(cfg.bearer || "");
  const timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 4000;
  const source = cfg.source || "openclaw";
  const capId = (conv, role, content) =>
    "cap-" + createHash("sha256").update(`${source}|${conv || ""}|${role}|${content}`).digest("hex").slice(0, 40);
  async function post(path, body) {
    if (!bearer) return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      return await r.json().catch(() => null);
    } catch { return null; } finally { clearTimeout(t); }
  }
  return {
    async context(query) {
      const r = await post("/context", { query, maxChars: 4000 });
      return r && typeof r.text === "string" ? r.text : "";
    },
    async capture(content, role, conv, id) {
      const text = String(content || "").trim();
      if (!text) return;
      await post("/ingest/message", { content: text, role, source, conversationId: conv, id: id || capId(conv, role, text) });
    },
  };
}

export function createOpenclawMemory(cfg = {}) {
  const bridge = createBridge({ ...cfg, source: cfg.source || "openclaw" });
  return {
    // before_prompt_build(event:{prompt,messages}, ctx) → { prependContext }.
    async onBeforePromptBuild(event, _ctx) {
      try {
        const text = await bridge.context(typeof event?.prompt === "string" ? event.prompt : "");
        if (text && text.trim()) return { prependContext: `# Mycelium memory (the user's vault)\n\n${text}` };
      } catch { /* fail-open */ }
      return undefined;
    },
    // llm_output(event:{runId,sessionId,prompt,assistantTexts[]}, ctx) → capture both.
    async onLlmOutput(event, ctx) {
      try {
        const conv = event?.sessionId ?? ctx?.sessionId;
        const run = event?.runId || "";
        if (typeof event?.prompt === "string") {
          await bridge.capture(event.prompt, "user", conv, run ? `ow:${run}:user` : undefined);
        }
        const asst = Array.isArray(event?.assistantTexts) ? event.assistantTexts.join("\n") : "";
        if (asst) await bridge.capture(asst, "assistant", conv, run ? `ow:${run}:assistant` : undefined);
      } catch { /* fail-open */ }
    },
  };
}

export default createOpenclawMemory;
