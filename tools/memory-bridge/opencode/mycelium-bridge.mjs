// Mycelium memory layer for opencode — framework-agnostic core (testable).
//
// Returns the `@opencode-ai/plugin` Hooks object. Self-contained (inline bridge,
// no import of mycelium internals) so it ships standalone inside a user's opencode.
// Verified against anomalyco/opencode @opencode-ai/plugin v1.17.7:
//   • chat.message                         → capture the user turn
//   • experimental.chat.system.transform   → inject vault context (output.system[])
//   • event (message.part.updated/updated) → capture the final assistant reply
// Every hook is fail-open: a memory error never breaks the turn.
import { createHash } from "node:crypto";

function createBridge(cfg = {}) {
  const base = String(cfg.baseUrl || "http://127.0.0.1:4711").replace(/\/$/, "");
  const bearer = String(cfg.bearer || "");
  const timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 4000;
  const source = cfg.source || "opencode";
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

const textOfParts = (parts) =>
  (Array.isArray(parts) ? parts : []).filter((p) => p && p.type === "text").map((p) => p.text || "").join("");

export function createOpencodeMemory(cfg = {}) {
  const bridge = createBridge({ ...cfg, source: cfg.source || "opencode" });
  // messageID -> Map(partID -> latest text). message.part.updated carries the
  // full current text of the part, so we keep the latest per part and join on done.
  const acc = new Map();

  return {
    // A new user message arrived → capture it.
    "chat.message": async (input, output) => {
      try {
        const conv = input?.sessionID;
        const text = textOfParts(output?.parts) || (typeof output?.message?.content === "string" ? output.message.content : "");
        const id = output?.message?.id ? `oc:${output.message.id}` : undefined;
        await bridge.capture(text, "user", conv, id);
      } catch { /* fail-open */ }
    },

    // About to build the system prompt → inject vault context as a system block.
    "experimental.chat.system.transform": async (_input, output) => {
      try {
        const text = await bridge.context("");
        if (text && text.trim() && output && Array.isArray(output.system)) {
          output.system.push(`# Mycelium memory (the user's vault)\n\n${text}`);
        }
      } catch { /* fail-open: no context */ }
    },

    // Stream of bus events → assemble + capture the final assistant reply.
    event: async (input) => {
      try {
        const e = input?.event;
        if (!e) return;
        if (e.type === "message.part.updated") {
          const part = e.properties?.part;
          if (part && part.type === "text" && part.messageID) {
            let m = acc.get(part.messageID);
            if (!m) { m = new Map(); acc.set(part.messageID, m); }
            m.set(part.id, part.text || "");
          }
        } else if (e.type === "message.updated") {
          const info = e.properties?.info;
          if (info && info.role === "assistant" && info.time && info.time.completed) {
            const m = acc.get(info.id);
            const text = m ? [...m.values()].join("") : "";
            acc.delete(info.id);
            if (text.trim()) await bridge.capture(text, "assistant", info.sessionID, `oc:${info.id}`);
          }
        }
      } catch { /* fail-open */ }
    },
  };
}

export default createOpencodeMemory;
