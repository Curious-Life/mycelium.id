// verify:gateway-stream — true token streaming at the inference seam (Slice B).
//   SB1 localStream parses Ollama NDJSON → ordered deltas, stops on done
//   SB2 cloudStream parses OpenAI SSE → ordered deltas
//   SB3 cloudStream parses Anthropic content_block_delta
//   SB4 router.inferStream cloud → deltas + exactly ONE 'allowed' egress (hash-only)
//   SB5 sensitive + us → LOCAL stream + a 'denied' egress, NO cloud egress
//   SB6 pre-token cloud failure → local fallback (the 'allowed' attempt is audited)
//   SB7 streamed assembled text === buffered infer() text (consistency)
// Pure; no network (mock fetch); CWD-independent. Never logs a secret.
import { createInferenceRouter } from '../src/inference/router.js';
import { cloudStream } from '../src/inference/cloud.js';
import { localStream } from '../src/inference/local.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const CT = 'STREAMED-CLOUD-HELLO';
const LT = 'STREAMED-LOCAL-HELLO';
const AT = 'STREAMED-ANTHRO-HELLO';
const enc = new TextEncoder();
const sse = (chunks) => ({ ok: true, status: 200, body: new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); } }) });
const jsonRes = (obj) => ({ ok: true, status: 200, async text() { return JSON.stringify(obj); }, async json() { return obj; } });

let cloudFail = false;
let cloudStreamCalls = 0;
let lastGenBody = null;   // last /api/generate request body (to assert options.num_ctx)
const mockFetch = async (url, opts) => {
  const u = String(url);
  const body = opts?.body ? JSON.parse(opts.body) : {};
  if (u.includes('/v1/messages')) { // Anthropic streaming
    return sse([
      `data: ${JSON.stringify({ type: 'message_start' })}\n\n`,
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: AT.slice(0, 9) } })}\n\n`,
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: AT.slice(9) } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
      'data: [DONE]\n\n',
    ]);
  }
  if (u.includes('/chat/completions')) {
    if (!body.stream) return jsonRes({ choices: [{ message: { content: CT } }] }); // buffered infer()
    cloudStreamCalls++;
    if (cloudFail) return { ok: false, status: 500, async text() { return JSON.stringify({ error: { type: 'server_error' } }); } };
    return sse([
      `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: CT.slice(0, 8) } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: CT.slice(8) } }] })}\n\n`,
      'data: [DONE]\n\n',
    ]);
  }
  if (u.includes('/api/generate')) {
    lastGenBody = body;
    if (!body.stream) return jsonRes({ response: LT });
    return sse([
      JSON.stringify({ response: LT.slice(0, 9), done: false }) + '\n',
      JSON.stringify({ response: LT.slice(9), done: false }) + '\n',
      JSON.stringify({ response: '', done: true }) + '\n',
    ]);
  }
  throw new Error(`unexpected url ${u}`);
};

const drain = async (gen) => { let out = ''; for await (const d of gen) out += d; return out; };
const usProvider = { baseUrl: 'https://api.us-test.example/v1', openaiApiKey: 'k', jurisdiction: 'us-standard' };

// SB1 — localStream NDJSON
{
  const out = await drain(localStream({ prompt: 'hi', baseUrl: 'http://127.0.0.1:11434', fetch: mockFetch }));
  rec('SB1. localStream NDJSON → ordered deltas', out === LT, out);
}
// SB1b — localStream honors numCtx (was previously dropped → silent ~4096 input truncation)
{
  lastGenBody = null;
  await drain(localStream({ prompt: 'hi', baseUrl: 'http://127.0.0.1:11434', fetch: mockFetch, numCtx: 16384 }));
  rec('SB1b. localStream sets options.num_ctx (no silent input truncation)',
    lastGenBody?.options?.num_ctx === 16384, JSON.stringify(lastGenBody?.options));
}
// SB1c — router.inferStream local AUTO-sizes num_ctx (no profile) so a long prompt
// is not silently truncated at Ollama's ~4096 default on the gateway-streaming path.
{
  lastGenBody = null;
  const router = createInferenceRouter({ ollamaUrl: 'http://127.0.0.1:11434', fetch: mockFetch });
  const longPrompt = 'word '.repeat(8000); // ~10k tokens → window must exceed 4096
  await drain(router.inferStream({ prompt: longPrompt, task: 'summarize' }));
  const ctx = lastGenBody?.options?.num_ctx;
  rec('SB1c. inferStream local auto-sizes num_ctx > 4096 for a long prompt',
    Number.isFinite(ctx) && ctx > 4096, `num_ctx=${ctx}`);
}
// SB2 — cloudStream OpenAI SSE
{
  const out = await drain(cloudStream({ prompt: 'hi', baseUrl: usProvider.baseUrl, fetch: mockFetch }));
  rec('SB2. cloudStream OpenAI SSE → ordered deltas', out === CT, out);
}
// SB3 — cloudStream Anthropic
{
  const out = await drain(cloudStream({ prompt: 'hi', anthropicApiKey: 'sk-ant', fetch: mockFetch }));
  rec('SB3. cloudStream Anthropic content_block_delta', out === AT, out);
}
// SB4 — router.inferStream cloud → one allowed egress, hash-only
{
  const egress = [];
  const router = createInferenceRouter({ ...usProvider, onEgress: (e) => egress.push(e), fetch: mockFetch });
  const out = await drain(router.inferStream({ prompt: 'x', task: 'complex' }));
  const allowed = egress.filter((e) => e.decision === 'allowed');
  rec('SB4. inferStream cloud → deltas + ONE allowed egress (hash-only)',
    out === CT && allowed.length === 1 && /^[0-9a-f]{64}$/.test(allowed[0].contentHash) && allowed[0].contentLength > 0 && !egress.some((e) => e.decision === 'denied'),
    `text=${out} egress=${JSON.stringify(egress.map((e) => e.decision))}`);
}
// SB5 — sensitive + us → local stream + denied, no cloud
{
  const egress = [];
  const router = createInferenceRouter({ ...usProvider, onEgress: (e) => egress.push(e), fetch: mockFetch });
  const before = cloudStreamCalls;
  const out = await drain(router.inferStream({ prompt: 'secret', task: 'complex', sensitive: true }));
  const denied = egress.find((e) => e.decision === 'denied');
  rec('SB5. sensitive+us → local stream + denied (no cloud egress)',
    out === LT && denied?.reason === 'sensitive_us_block' && !egress.some((e) => e.decision === 'allowed') && cloudStreamCalls === before,
    `text=${out} denied=${denied?.reason} cloudCalls+${cloudStreamCalls - before}`);
}
// SB6 — pre-token cloud failure → local fallback (allowed audited)
{
  cloudFail = true;
  const egress = [];
  const router = createInferenceRouter({ ...usProvider, onEgress: (e) => egress.push(e), fetch: mockFetch });
  const out = await drain(router.inferStream({ prompt: 'y', task: 'complex' }));
  cloudFail = false;
  rec('SB6. pre-token cloud error → local fallback (allowed audited)',
    out === LT && egress.some((e) => e.decision === 'allowed'), `text=${out}`);
}
// SB7 — streamed === buffered infer()
{
  const router = createInferenceRouter({ ...usProvider, fetch: mockFetch });
  const streamed = await drain(router.inferStream({ prompt: 'z', task: 'complex' }));
  const buffered = await router.infer({ prompt: 'z', task: 'complex' });
  rec('SB7. streamed assembled === buffered infer text', streamed === buffered && streamed === CT, `stream=${streamed} buffer=${buffered}`);
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — token streaming: local NDJSON · cloud SSE (OpenAI+Anthropic) · audited · sensitive-safe · consistent' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
