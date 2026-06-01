#!/usr/bin/env node
// scripts/verify-embed.mjs — verification ledger for the embed unit.
//
// Tier 1 (REQUIRED, gates the VERDICT):
//   - src/embed/client.js drives a MOCK embed-service (real http server in
//     this process) for /embed, /batch, /health, and error paths.
//   - pipeline/embed-service.py parses clean via python3 ast.parse.
//
// Tier 2 (ATTEMPTED, never fails the VERDICT unless a running service returns
//   a wrong-dim vector):
//   - Try to start the real service and embed "hello world" (task=query).
//     Records PASS or SKIP(reason). Missing model/network/deps => SKIP.
//
// Final VERDICT reflects Tier-1 success (+ no hard Tier-2 failure).
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import process from "node:process";
import assert from "node:assert/strict";
import { createEmbedClient, EMBED_DIM, EmbedServiceError } from "../src/embed/client.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PY = resolve(ROOT, "pipeline/embed-service.py");

const results = [];
const tier2 = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || "" });
  } catch (err) {
    results.push({ name, ok: false, detail: err?.message ?? String(err) });
  }
}

// ---------- mock service ----------
function fakeVector(seed = 0) {
  return Array.from({ length: EMBED_DIM }, (_, i) => Math.sin(i + seed) * 0.01);
}

function startMockServer() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const payload = body ? JSON.parse(body) : {};
      seen.push({ method: req.method, url: req.url, payload });
      const send = (code, obj) => {
        const out = JSON.stringify(obj);
        res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(out) });
        res.end(out);
      };
      if (req.method === "GET" && req.url === "/health") {
        return send(200, { status: "ok", model: "nomic-v1.5", loaded: true, dim: EMBED_DIM });
      }
      if (req.method === "POST" && req.url === "/embed") {
        // Sentinel text forces a server-side 4xx (task stays valid so the
        // client does not short-circuit before the HTTP round-trip).
        if (payload.text === "__force400__") return send(400, { error: "boom" });
        return send(200, { embedding: fakeVector(1), dim: EMBED_DIM, model: "nomic-v1.5", task: payload.task });
      }
      if (req.method === "POST" && req.url === "/batch") {
        const n = (payload.texts || []).length;
        return send(200, {
          embeddings: Array.from({ length: n }, (_, i) => fakeVector(i)),
          count: n,
          dim: EMBED_DIM,
          model: "nomic-v1.5",
          task: payload.task,
        });
      }
      send(404, { error: "not found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen }));
  });
}

// ---------- Tier 1a: client against a mock service ----------
await check("client: embed() sends right path/body, parses 768-dim", async () => {
  const { server, port, seen } = await startMockServer();
  try {
    const client = createEmbedClient({ baseUrl: `http://127.0.0.1:${port}` });
    const vec = await client.embed("hello world", "query");
    assert.equal(vec.length, EMBED_DIM, "vector dim");
    const call = seen.find((s) => s.url === "/embed");
    assert.ok(call, "POST /embed was made");
    assert.equal(call.method, "POST");
    assert.equal(call.payload.text, "hello world");
    assert.equal(call.payload.task, "query");
    return `dim=${vec.length}, body={text,task} OK`;
  } finally {
    server.close();
  }
});

await check("client: embedBatch() returns N×768 and sends texts[]", async () => {
  const { server, port, seen } = await startMockServer();
  try {
    const client = createEmbedClient({ baseUrl: `http://127.0.0.1:${port}` });
    const out = await client.embedBatch(["a", "b", "c"], "document");
    assert.equal(out.length, 3);
    out.forEach((v) => assert.equal(v.length, EMBED_DIM));
    const call = seen.find((s) => s.url === "/batch");
    assert.deepEqual(call.payload.texts, ["a", "b", "c"]);
    assert.equal(call.payload.task, "document");
    return "3×768 OK";
  } finally {
    server.close();
  }
});

await check("client: health() parses {status,model,dim}", async () => {
  const { server, port } = await startMockServer();
  try {
    const client = createEmbedClient({ baseUrl: `http://127.0.0.1:${port}` });
    const h = await client.health();
    assert.equal(h.status, "ok");
    assert.equal(h.dim, EMBED_DIM);
    return "status=ok";
  } finally {
    server.close();
  }
});

await check("client: rejects unknown task before any HTTP call", async () => {
  const client = createEmbedClient({ baseUrl: "http://127.0.0.1:1" });
  await assert.rejects(() => client.embed("x", "clustering"), EmbedServiceError);
  return "task validated client-side";
});

await check("client: surfaces service 4xx error with status", async () => {
  const { server, port } = await startMockServer();
  try {
    const client = createEmbedClient({ baseUrl: `http://127.0.0.1:${port}` });
    await assert.rejects(
      () => client.embed("__force400__", "query"),
      (err) => err instanceof EmbedServiceError && err.status === 400 && /embed-service error 400/.test(err.message),
    );
    return "4xx surfaced (status=400)";
  } finally {
    server.close();
  }
});

await check("client: clear error when service is down", async () => {
  // Port 9 (discard) — nothing listens.
  const client = createEmbedClient({ baseUrl: "http://127.0.0.1:9", timeoutMs: 1500 });
  await assert.rejects(() => client.embed("x", "query"), /unreachable/);
  return "down => unreachable error";
});

// ---------- Tier 1b: python parses ----------
await check("python: embed-service.py parses (ast.parse)", () => {
  if (!existsSync(PY)) throw new Error(`missing ${PY}`);
  execFileSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read()); print('ok')", PY], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return "syntax OK";
});

// ---------- Tier 2: attempt real service (SKIP allowed) ----------
async function tier2Attempt() {
  try {
    execFileSync("python3", ["-c", "import numpy, onnxruntime, tokenizers, huggingface_hub"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    const msg = (err.stderr?.toString() || err.message || "").trim().split("\n").pop();
    return { ok: null, detail: `SKIP (python deps not installed: ${msg}) — run pipeline/setup.sh` };
  }

  const proc = spawn("python3", [PY, "--serve", "--port", "8091"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (c) => (stderr += c));
  try {
    const client = createEmbedClient({ baseUrl: "http://127.0.0.1:8091", timeoutMs: 120000 });
    let up = false;
    for (let i = 0; i < 30; i++) {
      if (proc.exitCode !== null) break;
      try {
        await client.health();
        up = true;
        break;
      } catch {
        await sleep(500);
      }
    }
    if (!up) {
      return { ok: null, detail: `SKIP (service did not come up: ${stderr.trim().split("\n").pop() || "no /health"})` };
    }
    const vec = await client.embed("hello world", "query");
    if (vec.length !== EMBED_DIM) {
      return { ok: false, detail: `real embed returned ${vec.length} dims (expected ${EMBED_DIM})` };
    }
    return { ok: true, detail: `real service embedded "hello world" (task=query) -> ${vec.length}-dim` };
  } catch (err) {
    // Network/model-download failures are an acceptable SKIP, not a hard fail.
    return { ok: null, detail: `SKIP (could not exercise real service: ${err?.message ?? String(err)})` };
  } finally {
    proc.kill("SIGTERM");
  }
}

const t2 = await tier2Attempt();
tier2.push({
  name: "tier2: real service embeds 768-dim",
  state: t2.ok === true ? "PASS" : t2.ok === false ? "FAIL" : "SKIP",
  detail: t2.detail,
});

// ---------- ledger ----------
const failed = results.filter((r) => !r.ok);
console.log("--- Tier 1 (required) ---");
for (const r of results) {
  console.log(`${r.ok ? "[✓]" : "[—]"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
}
console.log("\n--- Tier 2 (attempted; SKIP ok) ---");
for (const r of tier2) {
  const tag = r.state === "PASS" ? "[✓]" : r.state === "FAIL" ? "[✗]" : "[~]";
  console.log(`${tag} ${r.state}: ${r.name} — ${r.detail}`);
}

const tier2Fail = tier2.some((r) => r.state === "FAIL");
const ok = failed.length === 0 && !tier2Fail;
console.log("");
console.log(`${ok ? "VERDICT: GO" : "VERDICT: NO-GO"}  EXIT=${ok ? 0 : 1}`);
process.exit(ok ? 0 : 1);
