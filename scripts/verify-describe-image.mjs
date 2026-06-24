// scripts/verify-describe-image.mjs
// Verifies the LOCAL image-captioning path is correct AND fail-soft — no Ollama,
// no network. Stubs fetch to assert: localInfer forwards images[] to a vision
// model only when given; the vision-model probe degrades to null when Ollama is
// down / has no vision model; and describeImage NEVER throws (it returns null so
// the upload path falls back to the filename).
import { localInfer } from '../src/inference/local.js';
import { describeImage, pickVisionModel } from '../src/enrich/describe-image.js';

const ledger = [];
const rec = (n, pass, d = '') => { ledger.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// Stub fetch: records request bodies; answers /api/tags + /api/generate.
function stub({ tags = [], generate = { response: '' }, tagsStatus = 200, genStatus = 200, throwOn = null } = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
    if (throwOn && url.includes(throwOn)) throw new Error('ECONNREFUSED');
    if (url.includes('/api/tags')) return { ok: tagsStatus < 400, status: tagsStatus, json: async () => ({ models: tags }) };
    if (url.includes('/api/generate')) return { ok: genStatus < 400, status: genStatus, text: async () => JSON.stringify(generate) };
    return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

delete process.env.MYCELIUM_VISION_MODEL;

// L1 — a text call must NOT send images[]
{
  const f = stub({ generate: { response: 'hi' } });
  await localInfer({ prompt: 'hi', fetch: f, timeoutMs: 1000 });
  const body = f.calls.find((c) => c.url.includes('/api/generate')).body;
  rec('L1. text localInfer omits images', !('images' in body), `body keys: ${Object.keys(body).join(',')}`);
}

// L2 — a vision call forwards images[] and returns the response
{
  const f = stub({ generate: { response: 'a caption' } });
  const out = await localInfer({ prompt: 'describe', images: ['BASE64DATA'], model: 'llava', fetch: f, timeoutMs: 1000 });
  const body = f.calls.find((c) => c.url.includes('/api/generate')).body;
  rec('L2. vision localInfer sends images[]', Array.isArray(body.images) && body.images[0] === 'BASE64DATA' && out === 'a caption');
}

// D1 — Ollama unreachable → null (no throw)
{
  const f = stub({ throwOn: '/api/tags' });
  const m = await pickVisionModel({ fetch: f, timeoutMs: 500 });
  rec('D1. pickVisionModel null when Ollama down', m === null);
}

// D2 — only text models → null
{
  const f = stub({ tags: [{ name: 'llama3.1:latest' }, { name: 'mistral' }] });
  rec('D2. pickVisionModel null with text-only models', (await pickVisionModel({ fetch: f, timeoutMs: 500 })) === null);
}

// D3 — a vision model present → returns it
{
  const f = stub({ tags: [{ name: 'llama3.1:latest' }, { name: 'llava:latest' }] });
  const m = await pickVisionModel({ fetch: f, timeoutMs: 500 });
  rec('D3. pickVisionModel finds llava', m === 'llava:latest', `got ${m}`);
}

// D4 — env override wins without a probe
{
  process.env.MYCELIUM_VISION_MODEL = 'my-custom-vlm';
  rec('D4. MYCELIUM_VISION_MODEL override honored', (await pickVisionModel({ fetch: stub({}) })) === 'my-custom-vlm');
  delete process.env.MYCELIUM_VISION_MODEL;
}

// D5 — no vision model → describeImage returns null (fall back to filename)
{
  const cap = await describeImage({ base64: 'AAAA', fetch: stub({ tags: [] }), timeoutMs: 500 });
  rec('D5. describeImage null when no vision model', cap === null);
}

// D6 — with a vision model, returns a trimmed caption
{
  const f = stub({ tags: [{ name: 'llava:latest' }], generate: { response: '  A red bicycle leaning on a wall.  ' } });
  const cap = await describeImage({ base64: 'AAAA', fetch: f, timeoutMs: 1000 });
  rec('D6. describeImage returns caption', cap === 'A red bicycle leaning on a wall.', `got: ${JSON.stringify(cap)}`);
}

// D7 — inference error → null, never throws
{
  const f = stub({ tags: [{ name: 'llava:latest' }], genStatus: 500 });
  let threw = false, cap = 'x';
  try { cap = await describeImage({ base64: 'AAAA', fetch: f, timeoutMs: 1000 }); } catch { threw = true; }
  rec('D7. describeImage fail-soft on inference error', !threw && cap === null);
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(60));
console.log(`VERDICT: ${allPass ? 'GO — local image captioning is correct + fail-soft' : 'NO-GO — see FAILs above'}`);
process.exit(allPass ? 0 : 1);
