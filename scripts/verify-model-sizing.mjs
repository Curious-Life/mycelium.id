// verify:model-sizing — the model-aware sizing layer (model-registry + model-profile
// + token-budget). Exercises registry lookup, profile resolution (probe → registry →
// default, fail-soft + cache), and planGeneration's output/numCtx/input budgeting —
// all offline with an injected fetch. No vault, no network. See
// docs/TEXT-GENERATION-ABSTRACTION-DESIGN-2026-06-15.md.
import { lookupModel, REGISTRY_META } from '../src/inference/model-registry.js';
import { resolveModelProfile, _resetModelProfileCache } from '../src/inference/model-profile.js';
import { estimateTokens, planGeneration, TASK_OUTPUT_DEFAULTS } from '../src/inference/token-budget.js';
import { approxTokens } from '../src/claims/support-path.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// ── Registry ──────────────────────────────────────────────────────────────────
rec('M1. exact cloud lookup: claude-opus-4-8 → 200k/64k', (() => { const r = lookupModel('claude-opus-4-8'); return r?.contextWindow === 200_000 && r?.maxOutput === 64_000; })());
rec('M2. family-prefix: gemma3:27b-it-q4_K_M → gemma3 row', lookupModel('gemma3:27b-it-q4_K_M')?.family === 'gemma');
rec('M3. longest-prefix wins: gpt-4o-mini ≠ gpt-4.1', (() => { const r = lookupModel('gpt-4o-mini'); return r?.contextWindow === 128_000 && r?.maxOutput === 16_384; })());
rec('M4. unknown model → null (degrades to class default)', lookupModel('totally-made-up-model-x') === null);
rec('M5. registry dated', typeof REGISTRY_META.updated === 'string' && REGISTRY_META.count > 0, `${REGISTRY_META.count} models @ ${REGISTRY_META.updated}`);

// ── token-budget ────────────────────────────────────────────────────────────
rec('T1. estimateTokens == legacy approxTokens on non-empty (dedupe value-preserving)', (() => {
  for (const s of ['a', 'hello world', 'x'.repeat(401), 'a'.repeat(4)]) if (estimateTokens(s) !== approxTokens(s)) return false; return true;
})());
rec('T2. estimateTokens floors at 1 on empty (deliberate safety vs legacy 0)', estimateTokens('') === 1 && estimateTokens(null) === 1 && approxTokens('') === 0);

// cloud profile shape → planGeneration clamps to maxOutput, numCtx undefined
const cloudProfile = { model: 'claude-opus-4-8', isLocal: false, family: 'claude', contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: {}, source: 'registry' };
let p = planGeneration(cloudProfile, { inputTokens: 5000, task: 'chat' });
rec('T3. cloud: maxTokens=task default (chat 4096), numCtx undefined, not overBudget', p.maxTokens === TASK_OUTPUT_DEFAULTS.chat && p.numCtx === undefined && p.overBudget === false, JSON.stringify(p));
p = planGeneration(cloudProfile, { task: 'chat', requestedMaxTokens: 999_999 });
rec('T4. requestedMaxTokens clamped to model maxOutput', p.maxTokens === 64_000, JSON.stringify(p));

// local profile → numCtx sized + rounded up to 1024, capped to window
const localSmall = { model: 'gemma3', isLocal: true, family: 'gemma', contextWindow: 8192, maxOutputTokens: 2048, capabilities: {}, source: 'probe' };
p = planGeneration(localSmall, { inputTokens: 3000, task: 'narrate' });
rec('T5. local: numCtx is a multiple of 1024, ≥ need, ≤ window', p.numCtx % 1024 === 0 && p.numCtx >= 3000 + p.maxTokens && p.numCtx <= 8192, JSON.stringify(p));
rec('T6. local: maxTokens=narrate default clamped to model', p.maxTokens === Math.min(TASK_OUTPUT_DEFAULTS.narrate, 2048), JSON.stringify(p));

// overflow: input larger than the budget flags overBudget but never NaNs
p = planGeneration(localSmall, { inputTokens: 100_000, task: 'chat' });
rec('T7. input overflow flags overBudget, numCtx capped at window', p.overBudget === true && p.numCtx === 8192, JSON.stringify(p));

// reproduce the legacy claims/discovery.js:180 formula EXACTLY (regression lock):
//   numCtx = min(CTX_MAX, max(4096, ceil((approxTokens(prompt)+OUT+512)/1024)*1024))
{
  const CTX_MAX = 16384, OUT = 1500, promptTok = 4000;
  const legacy = Math.min(CTX_MAX, Math.max(4096, Math.ceil((promptTok + OUT + 512) / 1024) * 1024));
  const claimsProfile = { model: 'qwen3', isLocal: true, family: 'qwen', contextWindow: CTX_MAX, maxOutputTokens: OUT, capabilities: {}, source: 'registry' };
  const np = planGeneration(claimsProfile, { inputTokens: promptTok, task: 'claims', requestedMaxTokens: OUT });
  rec('T8. planGeneration reproduces legacy discovery.js numCtx', np.numCtx === legacy, `new=${np.numCtx} legacy=${legacy}`);
}

// malformed profile → safe defaults, no throw
p = planGeneration({}, { inputTokens: 10, task: 'chat' });
rec('T9. malformed profile → safe (no NaN), maxTokens>0', Number.isFinite(p.maxTokens) && p.maxTokens > 0 && Number.isFinite(p.inputBudget), JSON.stringify(p));

// ── model-profile (injected fetch — no real Ollama) ─────────────────────────
// cloud anthropic → registry source, no probe
_resetModelProfileCache();
let prof = await resolveModelProfile({ anthropicApiKey: 'sk', cloudModel: 'claude-opus-4-8', jurisdiction: 'us-standard' }, { fetch: async () => { throw new Error('cloud must not probe'); } });
rec('P1. cloud anthropic → registry limits, isLocal false, no probe', prof.source === 'registry' && prof.isLocal === false && prof.contextWindow === 200_000 && prof.maxOutputTokens === 64_000, JSON.stringify(prof));

// local probe success: /api/show returns real context_length + capabilities
_resetModelProfileCache();
const showFetch = async (url) => {
  if (!/\/api\/show$/.test(url)) return { ok: false };
  return { ok: true, async json() { return { capabilities: ['completion', 'tools', 'vision'], model_info: { 'gemma3.context_length': 131072, 'gemma3.embedding_length': 3584 } }; } };
};
prof = await resolveModelProfile({ baseUrl: 'http://127.0.0.1:11434/v1', cloudModel: 'gemma3:12b', jurisdiction: 'local' }, { fetch: showFetch });
rec('P2. local probe → real context_length (131072) + caps from /api/show', prof.source === 'probe' && prof.isLocal === true && prof.contextWindow === 131072 && prof.capabilities.tools === true && prof.capabilities.vision === true, JSON.stringify(prof));
rec('P3. local probe: maxOutput ≤ half the window', prof.maxOutputTokens <= Math.floor(131072 / 2), `out=${prof.maxOutputTokens}`);

// local probe FAILS (Ollama down) → registry fallback, NOT cached
_resetModelProfileCache();
let calls = 0;
const downFetch = async () => { calls++; return { ok: false, status: 500 }; };
prof = await resolveModelProfile({ baseUrl: 'http://127.0.0.1:11434/v1', cloudModel: 'gemma3', jurisdiction: 'local' }, { fetch: downFetch });
rec('P4. probe down → registry fallback (gemma3 128k), source registry', prof.source === 'registry' && prof.contextWindow === 128_000, JSON.stringify(prof));
await resolveModelProfile({ baseUrl: 'http://127.0.0.1:11434/v1', cloudModel: 'gemma3', jurisdiction: 'local' }, { fetch: downFetch });
rec('P5. a fallback profile is NOT cached (re-probes next call)', calls === 2, `probe calls=${calls}`);

// totally unknown local model, probe down → class default
_resetModelProfileCache();
prof = await resolveModelProfile({ baseUrl: 'http://127.0.0.1:11434/v1', cloudModel: 'nonexistent:99b', jurisdiction: 'local' }, { fetch: downFetch });
rec('P6. unknown local + probe down → class default 8192/1024', prof.source === 'default' && prof.contextWindow === 8192 && prof.maxOutputTokens === 1024, JSON.stringify(prof));

// no provider at all → local floor
_resetModelProfileCache();
prof = await resolveModelProfile({}, { probe: false });
rec('P7. empty cfg → local floor profile (no throw)', prof.isLocal === true && Number.isFinite(prof.contextWindow), JSON.stringify(prof));

// profile carries NO secrets
rec('P8. profile carries no key material', !JSON.stringify(prof).toLowerCase().includes('sk') && !('apiKey' in prof) && !('credentials' in prof), Object.keys(prof).join(','));

// ── router auto-sizing (opt-in profile path) ────────────────────────────────
{
  const { createInferenceRouter } = await import('../src/inference/router.js');
  // local Ollama via injected fetch — capture the options Ollama receives.
  let sawNumCtx = null, sawNumPredict = null;
  const ollamaFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    sawNumCtx = body.options?.num_ctx ?? null;
    sawNumPredict = body.options?.num_predict ?? null;
    return { ok: true, status: 200, async text() { return JSON.stringify({ response: 'ok' }); } };
  };
  const router = createInferenceRouter({ fetch: ollamaFetch, ollamaUrl: 'http://127.0.0.1:11434' });
  const localProfile = { model: 'gemma3', isLocal: true, family: 'gemma', contextWindow: 8192, maxOutputTokens: 2048, capabilities: {}, source: 'probe' };
  await router.infer({ prompt: 'x'.repeat(4000), task: 'narrate', profile: localProfile });
  rec('R-AS1. router with profile auto-sizes num_ctx (1024-mult, ≤window) + num_predict', sawNumCtx !== null && sawNumCtx % 1024 === 0 && sawNumCtx <= 8192 && sawNumPredict === Math.min(1024, 2048), `num_ctx=${sawNumCtx} num_predict=${sawNumPredict}`);

  // explicit maxTokens/numCtx still win over the profile (back-compat override)
  sawNumCtx = null; sawNumPredict = null;
  await router.infer({ prompt: 'hi', task: 'narrate', profile: localProfile, maxTokens: 333, numCtx: 2048 });
  rec('R-AS2. explicit maxTokens/numCtx override the profile', sawNumPredict === 333 && sawNumCtx === 2048, `num_ctx=${sawNumCtx} num_predict=${sawNumPredict}`);

  // NO profile → unchanged legacy behaviour (no num_ctx sent, num_predict defaults inside localInfer)
  sawNumCtx = null; sawNumPredict = null;
  await router.infer({ prompt: 'hi', task: 'summarize' });
  rec('R-AS3. no profile → legacy behaviour (no auto num_ctx)', sawNumCtx === null, `num_ctx=${sawNumCtx}`);
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — model registry + profile (probe→registry→default, fail-soft) + token budgeting size output/num_ctx to each model' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
