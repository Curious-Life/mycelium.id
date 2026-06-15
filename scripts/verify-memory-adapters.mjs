// verify:memory-adapters — the native harness adapters (opencode, openclaw, hermes).
//
// Each adapter's framework-agnostic core is exercised against a STUB bridge server
// (records every /context pull + /ingest/message capture, enforces the Bearer).
// We feed each adapter the EXACT host event shapes verified against the real repos
// (anomalyco/opencode @opencode-ai/plugin, openclaw plugin-SDK hook-types, hermes
// turn hooks) and assert: context injected, and BOTH the user turn and the final
// assistant reply captured. Adapters are fail-open by contract.
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BEARER = "verify-adapters-" + "z".repeat(24);
const CTX = "VAULT_CONTEXT recent facts + people";
const ledger = [];
const rec = (n, p, d = "") => { ledger.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

// ── stub bridge server ────────────────────────────────────────────────────────
const captures = [];
let contextHits = 0;
let badAuth = 0;
const server = http.createServer((req, res) => {
  if ((req.headers.authorization || "") !== `Bearer ${BEARER}`) { badAuth++; res.statusCode = 401; return res.end("{}"); }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let json = {}; try { json = JSON.parse(body || "{}"); } catch { /* ignore */ }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/context") { contextHits++; return res.end(JSON.stringify({ ok: true, text: CTX })); }
    if (req.url === "/ingest/message") { captures.push(json); return res.end(JSON.stringify({ ok: true, result: `Captured ${json.id}` })); }
    res.statusCode = 404; res.end("{}");
  });
});
const base = await new Promise((r) => { server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)); });
const cfg = { baseUrl: base, bearer: BEARER, timeoutMs: 4000 };
const settle = () => new Promise((r) => setTimeout(r, 20));
const userCaps = () => captures.filter((c) => c.role === "user");
const asstCaps = () => captures.filter((c) => c.role === "assistant");
const reset = () => { captures.length = 0; contextHits = 0; };

// ── opencode ──────────────────────────────────────────────────────────────────
{
  reset();
  const { createOpencodeMemory } = await import("../tools/memory-bridge/opencode/mycelium-bridge.mjs");
  const h = createOpencodeMemory(cfg);
  // user turn
  await h["chat.message"]({ sessionID: "s1" }, { message: { id: "m1" }, parts: [{ type: "text", text: "hello opencode" }] });
  // context injection
  const out = { system: ["base system"] };
  await h["experimental.chat.system.transform"]({ model: {} }, out);
  // assistant: two streamed text parts, then completion
  await h.event({ event: { type: "message.part.updated", properties: { part: { type: "text", id: "p1", messageID: "am1", text: "part one " } } } });
  await h.event({ event: { type: "message.part.updated", properties: { part: { type: "text", id: "p2", messageID: "am1", text: "part two" } } } });
  await h.event({ event: { type: "message.updated", properties: { info: { id: "am1", role: "assistant", sessionID: "s1", time: { created: 1, completed: 2 } } } } });
  await settle();
  rec("O1. opencode chat.message → user turn captured", userCaps().some((c) => c.content === "hello opencode" && c.conversationId === "s1"), JSON.stringify(userCaps()[0]));
  rec("O2. opencode system.transform → context injected into output.system[]", out.system.some((s) => s.includes(CTX)) && contextHits === 1, `system=${out.system.length} hits=${contextHits}`);
  rec("O3. opencode event → final assistant reply captured (parts joined)", asstCaps().some((c) => c.content === "part one part two" && c.conversationId === "s1"), JSON.stringify(asstCaps()[0]));
  rec("O4. opencode bearer plumbed (no 401s)", badAuth === 0, `badAuth=${badAuth}`);
}

// ── openclaw ──────────────────────────────────────────────────────────────────
{
  reset();
  const { createOpenclawMemory } = await import("../tools/memory-bridge/openclaw/mycelium-bridge.mjs");
  const m = createOpenclawMemory(cfg);
  const injected = await m.onBeforePromptBuild({ prompt: "hi openclaw", messages: [] }, { sessionId: "s2" });
  await m.onLlmOutput({ runId: "r1", sessionId: "s2", prompt: "hi openclaw", assistantTexts: ["assist ", "reply"] }, {});
  await settle();
  rec("W1. openclaw before_prompt_build → returns { prependContext } with vault context", !!injected && typeof injected.prependContext === "string" && injected.prependContext.includes(CTX), JSON.stringify(injected)?.slice(0, 80));
  rec("W2. openclaw llm_output → user turn captured", userCaps().some((c) => c.content === "hi openclaw" && c.conversationId === "s2"), JSON.stringify(userCaps()[0]));
  rec("W3. openclaw llm_output → assistant reply captured (assistantTexts joined)", asstCaps().some((c) => c.content === "assist \nreply" && c.conversationId === "s2"), JSON.stringify(asstCaps()[0]));
}

// ── hermes (python driver) ────────────────────────────────────────────────────
{
  reset();
  const py = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (py.error) {
    rec("H0. python3 available", false, "python3 not found — hermes adapter UNVERIFIED (install python3 to gate it)");
  } else {
    const dir = mkdtempSync(join(tmpdir(), "myc-hermes-"));
    const driver = join(dir, "driver.py");
    writeFileSync(driver, [
      "import importlib.util, os",
      `spec = importlib.util.spec_from_file_location("mm", ${JSON.stringify(join(process.cwd(), "tools/memory-bridge/hermes/mycelium-memory/__init__.py"))})`,
      "mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)",
      'r = mod.on_pre_llm_call(user_message="hi hermes", session_id="s3", turn_id="t1")',
      'print("PRE_CONTEXT_OK" if (r and isinstance(r, dict) and r.get("context") and "VAULT_CONTEXT" in r["context"]) else "PRE_NONE")',
      'mod.on_post_llm_call(user_message="hi hermes", assistant_response="hermes reply", session_id="s3", turn_id="t1")',
    ].join("\n"));
    // Async spawn (NOT spawnSync): spawnSync blocks the event loop, starving the
    // in-process stub server so the driver's HTTP calls time out. spawn keeps the
    // loop free to serve /context + /ingest while python runs.
    const run = await new Promise((resolve) => {
      const cp = spawn("python3", [driver], { env: { ...process.env, MYCELIUM_BASE_URL: base, MYCELIUM_MCP_BEARER: BEARER } });
      let stdout = "", stderr = "";
      cp.stdout.on("data", (d) => (stdout += d));
      cp.stderr.on("data", (d) => (stderr += d));
      cp.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    await settle();
    rmSync(dir, { recursive: true, force: true });
    const ok = run.status === 0;
    rec("H1. hermes pre_llm_call → pulls context, returns {'context': …}", ok && /PRE_CONTEXT_OK/.test(run.stdout || ""), (run.stdout || run.stderr || "").trim().slice(0, 120));
    rec("H2. hermes post_llm_call → user turn captured", userCaps().some((c) => c.content === "hi hermes" && c.conversationId === "s3"), JSON.stringify(userCaps()[0]));
    rec("H3. hermes post_llm_call → assistant reply captured", asstCaps().some((c) => c.content === "hermes reply" && c.conversationId === "s3"), JSON.stringify(asstCaps()[0]));
  }
}

server.close();
const allPass = ledger.every(Boolean);
console.log("\n" + "=".repeat(72));
console.log(`VERDICT: ${allPass ? "GO — native adapters: opencode (chat.message + system.transform + event) · openclaw (before_prompt_build + llm_output) · hermes (pre/post_llm_call) all inject + capture both sides" : "NO-GO — see FAIL rows"}  EXIT=${allPass ? 0 : 1}`);
console.log("=".repeat(72));
process.exit(allPass ? 0 : 1);
