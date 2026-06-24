// verify:embeddings-gateway — the OpenAI-compatible /v1/embeddings adapter.
//   E1 input string → {object:list, data:[{embedding:768}], model} envelope
//   E2 input array → N embeddings, correct indices
//   E3 encoding_format:'base64' → raw little-endian float32, round-trips
//   E4 empty / non-string input → 400 invalid_request_error
//   E5 embed-service down → 503 generic envelope (NO input/stack leak)
//   E6 X-Mycelium-Embed-Task header → passed to the embed client (default 'document')
// Pure; no network (stub embed client); CWD-independent. Never logs a secret.
import { createEmbeddingsHandler, EMBED_MODEL_ID } from '../src/gateway/embeddings.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

function mockRes() {
  return {
    statusCode: 200, headersSent: false, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    set() { return this; },
    end() { this.headersSent = true; return this; },
  };
}
const mockReq = (body, headers = {}) => ({ body, headers });

// Stub embed client — deterministic 768-dim vectors; records the task it was asked for.
let lastTask = null;
const stubClient = {
  async embedBatch(texts, task) {
    lastTask = task;
    return texts.map((_, i) => Array.from({ length: 768 }, (_, j) => (i * 1000 + j) / 100000));
  },
};
const handler = createEmbeddingsHandler({ embedClient: stubClient }).embeddings;

// ── E1 — single string ───────────────────────────────────────────────────────
{
  const res = mockRes();
  await handler(mockReq({ input: 'hello world' }), res);
  const d = res.body?.data;
  rec('E1. string input → 768-dim embedding envelope',
    res.statusCode === 200 && res.body.object === 'list' && d.length === 1 &&
    d[0].object === 'embedding' && d[0].index === 0 && Array.isArray(d[0].embedding) &&
    d[0].embedding.length === 768 && res.body.model === EMBED_MODEL_ID && typeof res.body.usage?.total_tokens === 'number',
    `model=${res.body.model} dim=${d?.[0]?.embedding?.length}`);
}

// ── E2 — array input ─────────────────────────────────────────────────────────
{
  const res = mockRes();
  await handler(mockReq({ input: ['a', 'b', 'c'] }), res);
  const d = res.body?.data;
  rec('E2. array input → N embeddings, ordered indices',
    res.statusCode === 200 && d.length === 3 && d[0].index === 0 && d[1].index === 1 && d[2].index === 2 && d.every((x) => x.embedding.length === 768),
    `n=${d?.length}`);
}

// ── E3 — base64 encoding round-trips ─────────────────────────────────────────
{
  const res = mockRes();
  await handler(mockReq({ input: 'roundtrip', encoding_format: 'base64' }), res);
  const enc = res.body?.data?.[0]?.embedding;
  let decoded = null;
  if (typeof enc === 'string') {
    const buf = Buffer.from(enc, 'base64');
    decoded = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }
  // expected = float32 of the stub's first vector (i=0): value at j is j/100000
  const okLen = decoded && decoded.length === 768;
  const okVals = okLen && Math.abs(decoded[5] - 5 / 100000) < 1e-6 && Math.abs(decoded[700] - 700 / 100000) < 1e-6;
  rec('E3. encoding_format base64 → float32 round-trip', typeof enc === 'string' && okLen && okVals, `isString=${typeof enc === 'string'} len=${decoded?.length}`);
}

// ── E4 — invalid input → 400 ─────────────────────────────────────────────────
{
  const r1 = mockRes(); await handler(mockReq({ input: '' }), r1);
  const r2 = mockRes(); await handler(mockReq({ input: [] }), r2);
  const r3 = mockRes(); await handler(mockReq({ input: [123] }), r3);
  const r4 = mockRes(); await handler(mockReq({}), r4);
  rec('E4. empty / non-string input → 400',
    r1.statusCode === 400 && r2.statusCode === 400 && r3.statusCode === 400 && r4.statusCode === 400 && r1.body.error.type === 'invalid_request_error',
    `empty=${r1.statusCode} []=${r2.statusCode} [123]=${r3.statusCode} none=${r4.statusCode}`);
}

// ── E5 — embed-service down → 503 generic (no leak) ──────────────────────────
{
  const SECRET = 'PRIVATE-JOURNAL-ENTRY-xyz';
  const downClient = { async embedBatch() { throw new Error(`connect ECONNREFUSED while embedding "${SECRET}"`); } };
  const h = createEmbeddingsHandler({ embedClient: downClient }).embeddings;
  const res = mockRes();
  await h(mockReq({ input: SECRET }), res);
  const msg = JSON.stringify(res.body);
  rec('E5. embed-service down → 503, no input/stack leak',
    res.statusCode === 503 && res.body.error.type === 'embeddings_unavailable' && !msg.includes(SECRET) && !msg.includes('ECONNREFUSED'),
    `status=${res.statusCode} type=${res.body?.error?.type}`);
}

// ── E6 — task header ─────────────────────────────────────────────────────────
{
  lastTask = null;
  const res1 = mockRes();
  await handler(mockReq({ input: 'q' }, { 'x-mycelium-embed-task': 'query' }), res1);
  const queryTask = lastTask;
  lastTask = null;
  const res2 = mockRes();
  await handler(mockReq({ input: 'd' }), res2); // no header → default
  rec('E6. X-Mycelium-Embed-Task honored (default document)', queryTask === 'query' && lastTask === 'document', `header=${queryTask} default=${lastTask}`);
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — /v1/embeddings: local-only, OpenAI-shaped, fail-closed, no leak' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
