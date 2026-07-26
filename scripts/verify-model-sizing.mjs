// verify:model-sizing — the model-aware sizing layer (model-registry + model-profile
// + token-budget). Exercises registry lookup, profile resolution (probe → registry →
// default, fail-soft + cache), and planGeneration's output/numCtx/input budgeting —
// all offline with an injected fetch. No vault, no network. See
// the text-generation abstraction design.
//
// ── MUTATION RECORD (2026-07-26, the 1M/128k limits refresh) ─────────────────────────
// Each line below was RUN against src/inference/model-registry.js, observed to RED on the
// named check, and restored; the suite returns GREEN on the restored tree. The check this
// file used to carry asserted `claude-opus-4-8 → 200k/64k` — it was green for a full
// release while every current Opus/Sonnet row understated the window 5×, because
// under-sizing fails safe and nothing errors. That is the bug these mutations target.
//
// MUTATION-TESTED: `claude-opus-4-8` reverted to the pre-refresh `contextWindow: 200_000,
//   maxOutput: 64_000` → M1 REDs ("expected 1000000/128000, got 200000/64000"), M1b REDs
//   the same row, and P1 + P1b RED because the resolved cloud profile (API-key AND
//   subscription paths) inherits the understated window.
// MUTATION-TESTED: `claude-haiku-4-5` maxOutput set back to 32_000 (half its real cap) →
//   M1 REDs on that row. M1c deliberately stays GREEN — 32_000 is still ≤ the window and
//   still a plausible shape — which is why M1 carries per-model figures and M1c only
//   carries invariants. Neither check subsumes the other.
// MUTATION-TESTED: `claude-sonnet-5` given `maxOutput: 2_000_000` (output > window — the
//   shape a mis-pasted figure produces) → M1c REDs on `maxOutput ≤ contextWindow`, M1 REDs
//   on the figure. This is the one M1 alone would miss if both copies were edited in step.
// MUTATION-TESTED: the `claude-sonnet-4-5` row deleted → M1 REDs ("claude-sonnet-4-5: no
//   row"). M1d stays GREEN, and that is not a gap: a deleted key is no longer iterated, so
//   only M1's declared list can catch a dropped row. M1 is the sole guard against deletion.
// MUTATION-TESTED: `claude-fable-5` deleted — the realistic merge accident, since these
//   three ids arrive from the D-074 branch → M1 + M1b RED, and P1c REDs showing the model
//   silently resolving to the 32768/4096 cloud class default (a 30× under-size, no error).
// MUTATION-TESTED: model-registry's matcher flipped from longest- to shortest-prefix-wins
//   (`key.length > bestLen` → `bestLen === -1 || key.length < bestLen`) → M1d REDs on 8
//   suffixed ids (`qwen3.5:4b → qwen3`, `gpt-4o-mini-2024-07-18 → gpt-4o`) and M4b REDs.
//   M3 stays GREEN under this mutation — it only probes a bare `gpt-4o-mini`, which
//   exact-matches before the prefix walk runs. M3 has no teeth here; M1d is the check
//   that does, and it is why M1d probes SUFFIXED ids rather than declared ones.
// MUTATION-TESTED: a CLOUD_LIMITS figure edited without re-pinning LIMITS_FINGERPRINT
//   (observed live while authoring: the fingerprint sat at 'PLACEHOLDER' against the real
//   table) → M5 REDs with "figures changed but the pin did not: expected …, got …". This is
//   the check that actually has teeth on drift; see the note at M5 for why the DATE half
//   does not, and why an earlier draft of this record was wrong about it.
//
// ── Ran and did NOT red (recorded so nobody re-derives them) ─────────────────────────
// • Adding a shadowing `claude-opus` row ahead of the 5-gen rows leaves every check GREEN.
//   Correct — longest-prefix-wins means a shorter sibling cannot capture a longer id.
// • Setting REGISTRY_META.updated to '2026-06' does red M5's date half, but that state
//   never existed on main: D-074 had already set it to '2026-07' while the numbers were
//   still wrong. So the date floor cannot catch the bug this refresh fixed, and an earlier
//   version of this record claimed otherwise. The fingerprint above is the real guard.
// • M1b and T4b/T4c cannot red independently of M1 — see the notes at each. They are
//   labels and characterisations, not coverage.
import { createHash } from 'node:crypto';
import { lookupModel, REGISTRY_META, MODEL_REGISTRY } from '../src/inference/model-registry.js';
import { resolveModelProfile, _resetModelProfileCache } from '../src/inference/model-profile.js';
import { estimateTokens, planGeneration, TASK_OUTPUT_DEFAULTS } from '../src/inference/token-budget.js';
import { approxTokens } from '../src/claims/support-path.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// ── Registry ──────────────────────────────────────────────────────────────────
// M1 — the CLOUD limits table, pinned per model against provider docs (2026-07:
// Anthropic models overview + OpenAI per-model pages). This is the check a mis-typed
// limit REDs on. It is a deliberate second copy of the numbers: editing the registry
// alone is not enough, so a reviewer is forced to see the figure change twice.
//
// It exists because the whole current Opus/Sonnet generation sat at 200_000/64_000 here
// for a full release — carried over from the 200k era. Under-sizing fails SAFE (no error,
// just a fifth of the paid window used and compaction ~5× early), so nothing ever went
// red and the staleness survived every review. Only a pinned table catches that.
const CLOUD_LIMITS = Object.freeze({
  // Anthropic — 1M/128k is the current Opus+Sonnet generation; 200k is Haiku 4.5 and
  // the pre-4.6 Sonnet line. Haiku 4.5's output cap is 64k, not 32k.
  'claude-opus-5':     [1_000_000, 128_000],
  'claude-sonnet-5':   [1_000_000, 128_000],
  'claude-fable-5':    [1_000_000, 128_000],
  'claude-opus-4-8':   [1_000_000, 128_000],
  'claude-opus-4-7':   [1_000_000, 128_000],
  'claude-opus-4-6':   [1_000_000, 128_000],
  'claude-sonnet-4-6': [1_000_000, 128_000],
  'claude-sonnet-4-5': [200_000, 64_000],
  'claude-haiku-4-5':  [200_000, 64_000],
  // OpenAI — gpt-4.1's window is the exact 1_047_576, not a rounded 1M.
  'gpt-4o':            [128_000, 16_384],
  'gpt-4o-mini':       [128_000, 16_384],
  'gpt-4.1':           [1_047_576, 32_768],
  'o3':                [200_000, 100_000],
});
{
  const bad = [];
  for (const [id, [ctx, out]] of Object.entries(CLOUD_LIMITS)) {
    const r = lookupModel(id);
    if (!r) { bad.push(`${id}: no row`); continue; }
    if (r.contextWindow !== ctx || r.maxOutput !== out) bad.push(`${id}: expected ${ctx}/${out}, got ${r.contextWindow}/${r.maxOutput}`);
  }
  rec(`M1. cloud limits match provider docs (${Object.keys(CLOUD_LIMITS).length} models @ ${REGISTRY_META.updated})`, bad.length === 0, bad.join('; ') || 'all rows exact');
}
// M1b — a DIAGNOSTIC LABEL, not an independent check. Its id set is a subset of M1's and
// its predicate (`< 1e6 || < 128_000`) is strictly weaker than M1's (`!== 1e6 || !== 128_000`),
// so every M1b failure implies an M1 failure and NO mutation can red M1b alone. It earns its
// place only by making the common regression read as "the 2026-07 refresh was reverted"
// instead of "a number is off". Do not count it as coverage.
{
  const stale = ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6']
    .filter((id) => { const r = lookupModel(id); return !r || r.contextWindow < 1_000_000 || r.maxOutput < 128_000; });
  rec('M1b. no 1M-generation Claude row left at the stale 200k/64k', stale.length === 0, stale.length ? `still understated: ${stale.join(', ')}` : '7 rows at 1M/128k');
}
// M1c — shape invariants over EVERY row, independent of the pinned figures above. A
// typo that edits both copies in step still REDs here if it produces an impossible row
// (output larger than the window) or an undocumented window size.
{
  // 131_072 is here even though NO row currently uses it: it is the REAL window of the
  // llama3/gemma3 family, and this gate's own probe fixture (P2) drives /api/show with
  // exactly that value. Omitting it would mean a follow-up PR correcting `gemma3` from the
  // rounded 128_000 to the true 131_072 REDs M1c and has to edit this gate to land — a
  // whitelist that enshrines the current table's rounding instead of catching bad shapes.
  const SHAPES = new Set([8_192, 16_384, 32_768, 40_960, 128_000, 131_072, 200_000, 1_000_000, 1_047_576]);
  const bad = [];
  for (const [id, r] of Object.entries(MODEL_REGISTRY)) {
    if (!Number.isInteger(r.contextWindow) || r.contextWindow <= 0) bad.push(`${id}: bad window ${r.contextWindow}`);
    else if (!SHAPES.has(r.contextWindow)) bad.push(`${id}: window ${r.contextWindow} is not a known size`);
    if (!Number.isInteger(r.maxOutput) || r.maxOutput <= 0) bad.push(`${id}: bad maxOutput ${r.maxOutput}`);
    else if (r.maxOutput > r.contextWindow) bad.push(`${id}: maxOutput ${r.maxOutput} > window ${r.contextWindow}`);
  }
  rec('M1c. every row: 0 < maxOutput ≤ contextWindow, window is a known size', bad.length === 0, bad.join('; ') || `${Object.keys(MODEL_REGISTRY).length} rows well-shaped`);
}
// M1d — the qwen3.5-class bug (M4b) as a GENERAL invariant: a SUFFIXED id must resolve to
// its own row, not to a shorter sibling. Bare declared ids are useless for this — lookupModel
// exact-matches them before the prefix walk ever runs, so `lookupModel(k) === REGISTRY[k]` is
// a tautology that no mutation can red. Suffixing is what forces the prefix path, which is the
// only place shadowing can happen: `qwen3.5:4b` → `qwen3` (5× window overstatement),
// `gpt-4o-mini-2024-07-18` → `gpt-4o`, or a future dated Claude id → a shorter sibling.
{
  const SUFFIXES = [':4b', '-2024-07-18', '-20260601', '-preview'];
  const shadowed = [];
  for (const id of Object.keys(MODEL_REGISTRY)) {
    for (const sfx of SUFFIXES) {
      const got = lookupModel(id + sfx);
      if (got !== MODEL_REGISTRY[id]) shadowed.push(`${id}${sfx} → ${Object.keys(MODEL_REGISTRY).find((k) => MODEL_REGISTRY[k] === got) ?? 'null'}`);
    }
  }
  rec('M1d. suffixed ids resolve to their OWN row, not a shorter sibling', shadowed.length === 0, shadowed.length ? `shadowed: ${shadowed.join('; ')}` : `${Object.keys(MODEL_REGISTRY).length} ids × ${SUFFIXES.length} suffixes clean`);
}
rec('M2. family-prefix: gemma3:27b-it-q4_K_M → gemma3 row', lookupModel('gemma3:27b-it-q4_K_M')?.family === 'gemma');
rec('M3. longest-prefix wins: gpt-4o-mini ≠ gpt-4.1', (() => { const r = lookupModel('gpt-4o-mini'); return r?.contextWindow === 128_000 && r?.maxOutput === 16_384; })());
rec('M4. unknown model → null (degrades to class default)', lookupModel('totally-made-up-model-x') === null);
// M4b — N3: qwen3.5 has its OWN row and does NOT prefix-fall-through to qwen3. Without it,
// `qwen3.5:4b` starts with `qwen3` (40960) → a 5× overstatement of the catalog's real 8192 window.
// longest-prefix-wins must pick qwen3.5 (8192), while a genuine qwen3 tag still resolves to 40960.
{
  const q35 = lookupModel('qwen3.5:4b');
  const q3 = lookupModel('qwen3:8b');
  const ok = q35?.contextWindow === 8_192 && q35?.family === 'qwen' && q3?.contextWindow === 40_960;
  rec('M4b. qwen3.5:4b → 8192 (not qwen3 40960); qwen3:8b still 40960', ok, `q3.5=${q35?.contextWindow} q3=${q3?.contextWindow}`);
}
// M5 — bind the DATE to the NUMBERS, so the table cannot drift while still looking dated.
//
// A date floor alone has no teeth here, and an earlier draft of this check claimed it did.
// `REGISTRY_META.updated` already read '2026-07' on main BEFORE these figures were verified
// (D-074 set it, honestly labelling it "last touched, not re-checked"), so `updated >=
// '2026-07'` passes on the exact broken state this refresh fixed — wrong numbers, right date.
// It can only red on a date REGRESSION, which nobody would author.
//
// So the load-bearing half is the FINGERPRINT: any edit to a CLOUD_LIMITS figure changes the
// digest and REDs until the author re-pins it, and re-pinning is where the comment tells them
// to re-date. The date floor is retained only as a cheap monotonicity guard, not as evidence.
const LIMITS_VERIFIED_AT = '2026-07'; // when the CLOUD_LIMITS figures were checked against provider docs
// ⚠️ Re-pin BOTH of these together whenever a CLOUD_LIMITS figure changes, and move
// REGISTRY_META.updated in src/inference/model-registry.js to match. Recompute with:
//   node -e "import('node:crypto').then(c=>console.log(c.createHash('sha256').update(JSON.stringify(<the table>)).digest('hex').slice(0,16)))"
const LIMITS_FINGERPRINT = '671b7b7953627ef8';
{
  const digest = createHash('sha256').update(JSON.stringify(Object.entries(CLOUD_LIMITS).sort())).digest('hex').slice(0, 16);
  const dateOk = typeof REGISTRY_META.updated === 'string' && REGISTRY_META.updated >= LIMITS_VERIFIED_AT && REGISTRY_META.count > 0;
  rec('M5. CLOUD_LIMITS fingerprint matches its pinned verification date',
    digest === LIMITS_FINGERPRINT && dateOk,
    digest !== LIMITS_FINGERPRINT
      ? `figures changed but the pin did not: expected ${LIMITS_FINGERPRINT}, got ${digest} — re-verify against provider docs, then update LIMITS_FINGERPRINT, LIMITS_VERIFIED_AT and REGISTRY_META.updated together`
      : `${REGISTRY_META.count} models @ ${REGISTRY_META.updated}, limits pinned ${digest} @ ${LIMITS_VERIFIED_AT}`);
}

// ── token-budget ────────────────────────────────────────────────────────────
rec('T1. estimateTokens == legacy approxTokens on non-empty (dedupe value-preserving)', (() => {
  for (const s of ['a', 'hello world', 'x'.repeat(401), 'a'.repeat(4)]) if (estimateTokens(s) !== approxTokens(s)) return false; return true;
})());
rec('T2. estimateTokens floors at 1 on empty (deliberate safety vs legacy 0)', estimateTokens('') === 1 && estimateTokens(null) === 1 && approxTokens('') === 0);

// cloud profile shape → planGeneration clamps to maxOutput, numCtx undefined
const cloudProfile = { model: 'claude-opus-4-8', isLocal: false, family: 'claude', contextWindow: 1_000_000, maxOutputTokens: 128_000, capabilities: {}, source: 'registry' };
let p = planGeneration(cloudProfile, { inputTokens: 5000, task: 'chat' });
rec('T3. cloud: maxTokens=task default (chat 4096), numCtx undefined, not overBudget', p.maxTokens === TASK_OUTPUT_DEFAULTS.chat && p.numCtx === undefined && p.overBudget === false, JSON.stringify(p));
p = planGeneration(cloudProfile, { task: 'chat', requestedMaxTokens: 999_999 });
rec('T4. requestedMaxTokens clamped to model maxOutput', p.maxTokens === 128_000, JSON.stringify(p));
// T4b — the 1M refresh must NOT inflate a routine turn's output. planGeneration clamps to
// the TASK default first (chat=4096) and only then to the model cap, so raising maxOutput
// 64k→128k changes nothing a caller asked for. run-turn.js/portal-chat.js both pass
// task:'chat' with no requestedMaxTokens, so this is the live path.
rec('T4b. bigger model cap does NOT inflate the task default (chat stays 4096)',
  planGeneration(cloudProfile, { task: 'chat' }).maxTokens === 4096
  && planGeneration({ ...cloudProfile, maxOutputTokens: 64_000 }, { task: 'chat' }).maxTokens === 4096);
// T4c — what the refresh DOES move: the input budget, and with it compaction's trigger
// point (src/agent/compaction.js sizes off contextWindow). ~5× more room on the same model.
// NOTE T4b and T4c both drive the LOCAL `cloudProfile` literal above, not the registry —
// they characterise planGeneration's arithmetic, and neither would red if a registry row
// regressed. M1/M1b are the registry's guard; do not read these two as covering it.
{
  const wide = planGeneration(cloudProfile, { task: 'chat' });
  const narrow = planGeneration({ ...cloudProfile, contextWindow: 200_000, maxOutputTokens: 64_000 }, { task: 'chat' });
  rec('T4c. 1M window ≈5× the input budget of the stale 200k row (the actual fix)',
    wide.inputBudget > narrow.inputBudget * 4.9 && wide.inputBudget < 1_000_000,
    `1M→${wide.inputBudget} vs 200k→${narrow.inputBudget}`);
}

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
rec('P1. cloud anthropic → registry limits (1M/128k), isLocal false, no probe', prof.source === 'registry' && prof.isLocal === false && prof.contextWindow === 1_000_000 && prof.maxOutputTokens === 128_000, JSON.stringify(prof));

// P1b — a Claude SUBSCRIPTION (claudeOAuthToken, anthropicApiKey==='') must be treated as
// anthropic CLOUD, exactly like the API-key case: isLocal false, tools TRUE, no Ollama probe,
// full window. The regression: it fell through to the local floor → tools stripped from
// channel turns → the agent couldn't call `reply` → Telegram/Discord silent.
_resetModelProfileCache();
prof = await resolveModelProfile({ claudeOAuthToken: 'sk-ant-oat-X', anthropicApiKey: '', openaiApiKey: '', cloudModel: 'claude-opus-4-8', jurisdiction: 'us-standard', providerName: 'claude_subscription' }, { fetch: async () => { throw new Error('subscription must not probe Ollama'); } });
rec('P1b. Claude subscription (oauth) → cloud: isLocal false, tools TRUE, 1M, no probe', prof.isLocal === false && prof.capabilities.tools === true && prof.contextWindow === 1_000_000 && prof.source === 'registry', JSON.stringify(prof));
// P1c — the ids D-074 added must resolve through the SAME cloud path, not fall to the
// 32768/4096 cloud class default. Before the 2026-07 refresh they resolved to a real row
// but with sibling-conservative numbers; a missing row here is a silent 30× under-size.
for (const m of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5']) {
  _resetModelProfileCache();
  const pr = await resolveModelProfile({ anthropicApiKey: 'sk', cloudModel: m, jurisdiction: 'us-standard' }, { fetch: async () => { throw new Error('cloud must not probe'); } });
  rec(`P1c. ${m} → registry 1M/128k (not the 32768/4096 cloud default)`, pr.source === 'registry' && pr.contextWindow === 1_000_000 && pr.maxOutputTokens === 128_000, `${pr.source} ${pr.contextWindow}/${pr.maxOutputTokens}`);
}

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

  // NO profile → no profile-driven sizing, but the input-protection FLOOR still
  // applies: runLocal always sizes num_ctx via autoNumCtx so a long prompt is never
  // silently truncated at Ollama's ~4096 default (fix #209). For a short prompt the
  // floor is exactly 4096 (a 2048-multiple, ≥4096); num_predict still comes from
  // localInfer's own default (maxTokens=1024) since the caller set none. This is
  // NOT the profile path.
  sawNumCtx = null; sawNumPredict = null;
  await router.infer({ prompt: 'hi', task: 'summarize' });
  rec('R-AS3. no profile → input-protection floor num_ctx=4096 (never Ollama\'s silent ~4096 default), num_predict=localInfer default', sawNumCtx === 4096 && sawNumCtx % 2048 === 0 && sawNumPredict === 1024, `num_ctx=${sawNumCtx} num_predict=${sawNumPredict}`);
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — model registry + profile (probe→registry→default, fail-soft) + token budgeting size output/num_ctx to each model' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
