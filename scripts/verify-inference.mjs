// Verify the Component 6 inference router end-to-end (Tier-1, no real models).
//
// Pure logic: a MOCK fetch stands in for Ollama (:11434), Anthropic, and OpenAI,
// so we prove routing + provider wiring + fallback + leak-safety WITHOUT any
// model or network. Asserts:
//   R1  simple tasks go LOCAL even when a cloud key is configured
//   R2  complex tasks go CLOUD (Anthropic) when a key is configured
//   R3  complex with NO cloud key → local fallback
//   R4  localInfer builds the correct Ollama body (model/prompt/stream/num_predict)
//   R5  Anthropic path sends x-api-key + anthropic-version, parses content[].text
//   R6  OpenAI path sends Authorization: Bearer, parses choices[0].message.content
//   R7  cloud failure → falls back to local (resilience)
//   R8  fail-closed: a non-OK local response throws InferenceError
//   R9  leak-safety: the prompt never appears in a thrown error message
//   R10 validation: empty prompt + unknown task rejected
//   R11 keys are never exposed on router.config
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>; process.exit reflects pass/fail.

import { createInferenceRouter, LOCAL_TASKS, CLOUD_TASKS } from "../src/inference/router.js";
import { localInfer } from "../src/inference/local.js";
import { InferenceError } from "../src/inference/errors.js";

const ledger = [];
const rec = (name, pass, detail = "") => {
  ledger.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

// A mock fetch: dispatch by URL substring, record the last call per host.
function makeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    for (const r of routes) {
      if (url.includes(r.match)) return r.respond(url, opts);
    }
    throw new Error(`mock fetch: unexpected url ${url}`);
  };
  fn.calls = calls;
  return fn;
}
const jsonRes = (status, obj) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) });
const ollamaOk = (text) => ({ match: "11434", respond: async () => jsonRes(200, { response: text }) });
const anthropicOk = (text) => ({ match: "api.anthropic.com", respond: async () => jsonRes(200, { content: [{ type: "text", text }] }) });
const openaiOk = (text) => ({ match: "api.openai.com", respond: async () => jsonRes(200, { choices: [{ message: { content: text } }] }) });

async function main() {
  // R1 — simple task stays local despite a cloud key being present.
  {
    const fetch = makeFetch([ollamaOk("LOCAL_OUT"), anthropicOk("CLOUD_OUT")]);
    const r = createInferenceRouter({ fetch, anthropicApiKey: "sk-test", env: {} });
    const out = await r.infer({ prompt: "hello", task: "summarize" });
    const hitLocal = fetch.calls.every((c) => c.url.includes("11434"));
    rec("R1. simple task (summarize) → local even with a cloud key set",
      out === "LOCAL_OUT" && hitLocal, `out=${out} urls=${fetch.calls.map((c) => c.url).join(",")}`);
    rec("R1b. LOCAL_TASKS/CLOUD_TASKS partition is as specified",
      LOCAL_TASKS.join() === "summarize,classify,extract" && CLOUD_TASKS.join() === "narrate,complex");
  }

  // R2 — complex task routes to cloud (Anthropic) when key configured.
  {
    const fetch = makeFetch([ollamaOk("LOCAL_OUT"), anthropicOk("CLOUD_OUT")]);
    const r = createInferenceRouter({ fetch, anthropicApiKey: "sk-test", env: {} });
    const out = await r.infer({ prompt: "tell a story", task: "complex" });
    const hitCloud = fetch.calls.some((c) => c.url.includes("api.anthropic.com"));
    rec("R2. complex task → cloud (Anthropic) when key configured",
      out === "CLOUD_OUT" && hitCloud, `out=${out}`);
  }

  // R3 — complex task with NO cloud key falls through to local.
  {
    const fetch = makeFetch([ollamaOk("LOCAL_OUT")]);
    const r = createInferenceRouter({ fetch, env: {} }); // no keys
    const out = await r.infer({ prompt: "tell a story", task: "narrate" });
    rec("R3. complex task + no cloud key → local fallback",
      out === "LOCAL_OUT" && r.hasCloud() === false, `out=${out} hasCloud=${r.hasCloud()}`);
  }

  // R4 — localInfer Ollama request body shape.
  {
    const fetch = makeFetch([ollamaOk("X")]);
    await localInfer({ prompt: "p", maxTokens: 256, model: "mymodel", fetch });
    const body = JSON.parse(fetch.calls[0].opts.body);
    rec("R4. localInfer body: {model, prompt, stream:false, options.num_predict}",
      body.model === "mymodel" && body.prompt === "p" && body.stream === false && body.options.num_predict === 256,
      `body=${JSON.stringify(body)}`);
    rec("R4b. localInfer hits /api/generate on the Ollama base",
      fetch.calls[0].url.endsWith("/api/generate"), fetch.calls[0].url);
  }

  // R5 — Anthropic headers + response parsing.
  {
    const fetch = makeFetch([anthropicOk("ANT_OUT")]);
    const r = createInferenceRouter({ fetch, anthropicApiKey: "sk-ant", cloudModel: "m", env: {} });
    const out = await r.infer({ prompt: "x", task: "complex" });
    const call = fetch.calls[0];
    rec("R5. Anthropic: x-api-key + anthropic-version headers, content[].text parsed",
      out === "ANT_OUT"
        && call.opts.headers["x-api-key"] === "sk-ant"
        && call.opts.headers["anthropic-version"] === "2023-06-01"
        && JSON.parse(call.opts.body).model === "m",
      `headers=${JSON.stringify(call.opts.headers)}`);
  }

  // R6 — OpenAI path (only OpenAI key configured).
  {
    const fetch = makeFetch([openaiOk("OAI_OUT")]);
    const r = createInferenceRouter({ fetch, openaiApiKey: "sk-oai", env: {} });
    const out = await r.infer({ prompt: "x", task: "complex" });
    const call = fetch.calls[0];
    rec("R6. OpenAI: Authorization: Bearer, choices[0].message.content parsed",
      out === "OAI_OUT" && call.opts.headers.Authorization === "Bearer sk-oai" && call.url.includes("api.openai.com"),
      `auth=${call.opts.headers.Authorization}`);
  }

  // R7 — cloud failure falls back to local.
  {
    const fetch = makeFetch([
      { match: "api.anthropic.com", respond: async () => jsonRes(500, { error: { type: "overloaded_error" } }) },
      ollamaOk("LOCAL_FALLBACK"),
    ]);
    const r = createInferenceRouter({ fetch, anthropicApiKey: "sk-ant", env: {} });
    const out = await r.infer({ prompt: "x", task: "complex" });
    const triedCloudThenLocal = fetch.calls.some((c) => c.url.includes("anthropic")) && fetch.calls.some((c) => c.url.includes("11434"));
    rec("R7. cloud 500 → local fallback returns the local result",
      out === "LOCAL_FALLBACK" && triedCloudThenLocal, `out=${out}`);
  }

  // R8 — fail-closed: non-OK local response throws InferenceError.
  {
    const fetch = makeFetch([{ match: "11434", respond: async () => jsonRes(500, { error: "boom" }) }]);
    let threw = null;
    try { await localInfer({ prompt: "p", fetch }); } catch (e) { threw = e; }
    rec("R8. local non-OK (500) throws InferenceError with status + backend",
      threw instanceof InferenceError && threw.status === 500 && threw.backend === "local",
      `err=${threw && threw.message}`);
  }

  // R9 — leak-safety: prompt must never appear in a thrown error.
  {
    const SECRET = "SUPER_SECRET_PROMPT_TOKEN_42";
    const fetch = makeFetch([{ match: "11434", respond: async () => jsonRes(500, { error: SECRET }) }]);
    let threw = null;
    try { await localInfer({ prompt: SECRET, fetch }); } catch (e) { threw = e; }
    const leaked = threw && (String(threw.message).includes(SECRET) || String(threw.stack || "").includes(SECRET));
    rec("R9. leak-safety: the prompt never appears in the thrown error message/stack",
      threw instanceof InferenceError && !leaked, `leaked=${leaked}`);
  }

  // R10 — input validation.
  {
    const r = createInferenceRouter({ fetch: makeFetch([ollamaOk("X")]), env: {} });
    let e1 = null, e2 = null;
    try { await r.infer({ prompt: "   ", task: "summarize" }); } catch (e) { e1 = e; }
    try { await r.infer({ prompt: "ok", task: "frobnicate" }); } catch (e) { e2 = e; }
    rec("R10. empty prompt + unknown task both rejected (InferenceError)",
      e1 instanceof InferenceError && e2 instanceof InferenceError, `e1=${e1?.name} e2=${e2?.name}`);
  }

  // R11 — keys never exposed on the router surface.
  {
    const r = createInferenceRouter({ fetch: makeFetch([]), anthropicApiKey: "sk-secret", openaiApiKey: "sk-secret2", env: {} });
    const blob = JSON.stringify(r.config);
    rec("R11. router.config redacts keys (only *Configured booleans exposed)",
      !blob.includes("sk-secret") && r.config.anthropicConfigured === true && r.config.openaiConfigured === true,
      `config=${blob}`);
  }

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? "GO — Component 6 inference router: task-routed local/cloud, BYOK via REST (no SDK dep), local-first + cloud-fallback, fail-closed and prompt-leak-safe" : "NO-GO — see FAIL rows"}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error("verify-inference threw:", e); process.exit(1); });
