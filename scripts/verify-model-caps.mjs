// verify:model-caps — capability-based local model selection (DI, no network).
// Proves the /api/show capabilities probe: qualifying-model pick, active-model
// preference, fail-soft on old/down Ollama, boot cache, and the describe-image
// integration that motivated it (gemma4-class vision models the legacy name
// list can never match — 2026-06-10 finding).
import { pickModelWithCapability, _resetModelCapsCache } from '../src/enrich/model-caps.js';
import { pickVisionModel } from '../src/enrich/describe-image.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

/** fake Ollama: models = { name: capabilities[]|undefined } */
function fakeOllama(models, { tagsFail = false } = {}) {
  const calls = { tags: 0, show: [] };
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/api/tags')) {
      calls.tags++;
      if (tagsFail) throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => ({ models: Object.keys(models).map((name) => ({ name })) }) };
    }
    if (String(url).includes('/api/show')) {
      const { model } = JSON.parse(init.body);
      calls.show.push(model);
      const caps = models[model];
      return { ok: true, json: async () => (caps ? { capabilities: caps } : { details: {} }) };
    }
    return { ok: false, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

// C1: picks the first installed model that declares the capability
{
  _resetModelCapsCache();
  const { fetchImpl } = fakeOllama({ 'qwen3:4b': ['completion'], 'gemma4:12b': ['completion', 'vision', 'audio'] });
  const m = await pickModelWithCapability('vision', { fetch: fetchImpl });
  rec('C1. picks the model whose /api/show declares the capability', m === 'gemma4:12b', `picked=${m}`);
}

// C2: the preferred (active) model wins when it qualifies
{
  _resetModelCapsCache();
  const { fetchImpl, calls } = fakeOllama({ 'llava:7b': ['completion', 'vision'], 'gemma4:12b': ['completion', 'vision', 'audio'] });
  const m = await pickModelWithCapability('vision', { prefer: 'gemma4:12b', fetch: fetchImpl });
  rec('C2. prefer (active model) wins when it qualifies', m === 'gemma4:12b' && calls.show[0] === 'gemma4:12b', `picked=${m} probedFirst=${calls.show[0]}`);
}

// C3: a non-qualifying prefer is skipped for the first qualifier
{
  _resetModelCapsCache();
  const { fetchImpl } = fakeOllama({ 'qwen3:4b': ['completion'], 'llava:7b': ['completion', 'vision'] });
  const m = await pickModelWithCapability('vision', { prefer: 'qwen3:4b', fetch: fetchImpl });
  rec('C3. non-qualifying prefer skipped → first qualifying model', m === 'llava:7b', `picked=${m}`);
}

// C4: no qualifying model → null (audio asked, only vision installed)
{
  _resetModelCapsCache();
  const { fetchImpl } = fakeOllama({ 'llava:7b': ['completion', 'vision'] });
  rec('C4. no model with the capability → null', (await pickModelWithCapability('audio', { fetch: fetchImpl })) === null);
}

// C5: old Ollama (no capabilities field in /api/show) → null, fail-soft
{
  _resetModelCapsCache();
  const { fetchImpl } = fakeOllama({ 'llava:7b': undefined, 'gemma4:12b': undefined });
  rec('C5. old Ollama without capabilities → null (caller falls back)', (await pickModelWithCapability('vision', { fetch: fetchImpl })) === null);
}

// C6: Ollama unreachable → null, no throw
{
  _resetModelCapsCache();
  const { fetchImpl } = fakeOllama({}, { tagsFail: true });
  rec('C6. Ollama down → null (never throws)', (await pickModelWithCapability('vision', { fetch: fetchImpl })) === null);
}

// C7: boot cache — the second identical call makes zero HTTP requests
{
  _resetModelCapsCache();
  const { fetchImpl, calls } = fakeOllama({ 'gemma4:12b': ['completion', 'vision'] });
  await pickModelWithCapability('vision', { fetch: fetchImpl });
  const tagsAfterFirst = calls.tags;
  const m = await pickModelWithCapability('vision', { fetch: fetchImpl });
  rec('C7. result cached (no re-probe on second call)', m === 'gemma4:12b' && calls.tags === tagsAfterFirst, `tagsCalls=${calls.tags}`);
}

// C8: INTEGRATION — pickVisionModel finds a gemma4-class model via capabilities
// even though the legacy name list cannot match it (the motivating bug).
{
  _resetModelCapsCache();
  delete process.env.MYCELIUM_VISION_MODEL;
  const { fetchImpl } = fakeOllama({ 'qwen3:4b': ['completion'], 'gemma4:12b': ['completion', 'vision', 'audio'] });
  const m = await pickVisionModel({ fetch: fetchImpl, timeoutMs: 500 });
  rec('C8. pickVisionModel resolves gemma4-class vision via capabilities probe', m === 'gemma4:12b', `picked=${m}`);
}

// C9: pickVisionModel name-list fallback still works on old Ollama (no caps)
{
  _resetModelCapsCache();
  delete process.env.MYCELIUM_VISION_MODEL;
  const { fetchImpl } = fakeOllama({ 'llava:7b': undefined, 'qwen3:4b': undefined });
  const m = await pickVisionModel({ fetch: fetchImpl, timeoutMs: 500 });
  rec('C9. legacy name-list fallback intact for capability-less Ollama', m === 'llava:7b', `picked=${m}`);
}

const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
console.log(`VERDICT: ${passed === ledger.length ? 'GO' : 'NO-GO'}`);
process.exit(passed === ledger.length ? 0 : 1);
