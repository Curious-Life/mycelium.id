// tests/embed-client.test.js — unit tests for the embed-service JS client.
// Uses a real loopback http mock server; no python/model needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createEmbedClient, EMBED_DIM, EmbedServiceError } from "../src/embed/client.js";

function fakeVector(seed = 0) {
  return Array.from({ length: EMBED_DIM }, (_, i) => Math.sin(i + seed) * 0.01);
}

function startMock() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const payload = body ? JSON.parse(body) : {};
      seen.push({ method: req.method, url: req.url, payload });
      const send = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "GET" && req.url === "/health")
        return send(200, { status: "ok", model: "nomic-v1.5", loaded: true, dim: EMBED_DIM });
      if (req.method === "POST" && req.url === "/embed") {
        if (payload.text === "boom") return send(400, { error: "bad" });
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

test("embed() posts {text,task} and returns a 768-dim vector", async () => {
  const { server, port, seen } = await startMock();
  try {
    const client = createEmbedClient({ baseUrl: `http://127.0.0.1:${port}` });
    const vec = await client.embed("hello", "query");
    assert.equal(vec.length, EMBED_DIM);
    const call = seen.find((s) => s.url === "/embed");
    assert.equal(call.payload.text, "hello");
    assert.equal(call.payload.task, "query");
  } finally {
    server.close();
  }
});

test("embedBatch() posts texts[] and returns N vectors", async () => {
  const { server, port, seen } = await startMock();
  try {
    const client = createEmbedClient({ baseUrl: `http://127.0.0.1:${port}` });
    const out = await client.embedBatch(["a", "b"], "document");
    assert.equal(out.length, 2);
    out.forEach((v) => assert.equal(v.length, EMBED_DIM));
    assert.deepEqual(seen.find((s) => s.url === "/batch").payload.texts, ["a", "b"]);
    assert.equal(seen.find((s) => s.url === "/batch").payload.task, "document");
  } finally {
    server.close();
  }
});

test("embedBatch([]) short-circuits with no HTTP call", async () => {
  const { server, port, seen } = await startMock();
  try {
    const client = createEmbedClient({ baseUrl: `http://127.0.0.1:${port}` });
    assert.deepEqual(await client.embedBatch([], "document"), []);
    assert.equal(seen.length, 0);
  } finally {
    server.close();
  }
});

test("unknown task is rejected client-side", async () => {
  const client = createEmbedClient({ baseUrl: "http://127.0.0.1:1" });
  await assert.rejects(() => client.embed("x", "clustering"), EmbedServiceError);
  await assert.rejects(() => client.embedBatch(["x"], "nope"), EmbedServiceError);
});

test("empty / non-string input is rejected", async () => {
  const client = createEmbedClient({ baseUrl: "http://127.0.0.1:1" });
  await assert.rejects(() => client.embed("", "query"), EmbedServiceError);
  await assert.rejects(() => client.embed(123, "query"), EmbedServiceError);
  await assert.rejects(() => client.embedBatch([1, 2], "document"), EmbedServiceError);
});

test("service 4xx is surfaced as EmbedServiceError with status", async () => {
  const { server, port } = await startMock();
  try {
    const client = createEmbedClient({ baseUrl: `http://127.0.0.1:${port}` });
    await assert.rejects(
      () => client.embed("boom", "query"),
      (err) => err instanceof EmbedServiceError && err.status === 400,
    );
  } finally {
    server.close();
  }
});

test("service down yields a clear 'unreachable' error", async () => {
  const client = createEmbedClient({ baseUrl: "http://127.0.0.1:9", timeoutMs: 1000 });
  await assert.rejects(() => client.embed("x", "query"), /unreachable/);
});

test("health() returns {status,model,dim}", async () => {
  const { server, port } = await startMock();
  try {
    const client = createEmbedClient({ baseUrl: `http://127.0.0.1:${port}` });
    const h = await client.health();
    assert.equal(h.status, "ok");
    assert.equal(h.dim, EMBED_DIM);
  } finally {
    server.close();
  }
});
